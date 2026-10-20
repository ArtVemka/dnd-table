'use strict';

/**
 * Встроенный сервер стола: Express (раздача файлов) + Socket.IO (реальное время).
 *
 * Сервер запускается ТОЛЬКО в main-процессе Electron и только когда ДМ создаёт
 * или запускает стол. Сервер — авторитетный источник состояния: клиент ничего
 * не меняет у себя до подтверждения сервера.
 *
 * Загрузка изображений: renderer читает файл через FileReader -> base64 data URL
 * -> событие Socket.IO ("uploadMap" / "setTokenImage"). Сервер проверяет MIME по
 * сигнатуре файла и размер (<= 10 МБ), сохраняет файл в папку кампании и
 * раздаёт его по HTTP: GET /files/<имя>. В событиях клиентам уходит только URL.
 */

const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const {
  DEFAULT_DM_AVATAR,
  DM_PLAYER_ID,
  GRID,
  INITIATIVE,
  LIMITS,
  MAP_TYPES,
  ROLE_DM,
  ROLE_PLAYER,
  TEMPLATE_KINDS,
  TEMPLATE_LIMITS,
  TOKEN_PALETTE,
  clampInt,
  clampNumber,
  newMapId,
  newTokenId,
  normalizeSheet,
  normalizeTemplate,
  normalizeTokenLight,
  sanitizeText
} = require('./state');
const { findFreePort } = require('./net');
const { decodeImage, sniffImageFormat } = require('./image');
// Разбор формул броска. Модуль лежит в renderer/, потому что тем же файлом
// считает бросок тренировочный стол: своя копия разбора разъехалась бы с ним.
const dice = require('../renderer/dice.js');
// Пустая маска тумана для новой карты: берём ту же модель, что и разбор
// кисти, иначе у свежей карты окажется поле, которого нет у загруженной.
const fogModel = require('../renderer/dnd5e.js');
// Свет приводится к виду той же моделью, что и на клиенте: иначе мастер увидел
// бы один круг света, а игроки другой, и разошлись бы они при первом же
// движении фишки.
const normalizeWall = fogModel.normalizeWall;
const normalizeLight = fogModel.normalizeLight;
const LIGHT_LIMITS = fogModel.LIGHT_LIMITS;
// Сетка — тоже из общей модели: клетку и сдвиг рисует клиент по тем же
// правилам, и любое расхождение сдвинуло бы сетку относительно фишек.
const normalizeGrid = fogModel.normalizeGrid;
const SURFACE_IDS = fogModel.SURFACE_IDS;
const normalizeSurface = fogModel.normalizeSurface;

const PLAYER_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
/** Длина имени карты — та же, что при загрузке в состояние стола. */
const MAP_NAME_MAX = 120;

/**
 * Менялась ли сетка по-настоящему.
 *
 * Без сравнения каждое движение ползунка пересылало бы всю сетку заново и
 * перерисовывало карту у всех, даже когда мастер ничего не поменял.
 * @param {object} before
 * @param {object} after
 * @returns {boolean}
 */
function sameGrid(before, after) {
  if (!before || !after) return false;
  return ['enabled', 'cell', 'columns', 'feetPerCell', 'offsetX', 'offsetY']
    .every((key) => before[key] === after[key]);
}

/** @param {string} address */
function isLoopbackAddress(address) {
  const value = String(address || '');
  return (
    value === '127.0.0.1' ||
    value === '::1' ||
    value === '::ffff:127.0.0.1' ||
    value.startsWith('127.') ||
    value.startsWith('::ffff:127.')
  );
}

/** @param {string} a @param {string} b */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}


/** @param {unknown} raw */
function sanitizeName(raw) {
  return sanitizeText(raw, LIMITS.maxNameLength).replace(/\s+/g, ' ').trim();
}

/**
 * Поднимает сервер стола.
 * @param {{
 *   room: import('./state').RoomState,
 *   store: import('./campaign').CampaignStore,
 *   hostKey: string,
 *   preferredPort?: number,
 *   onDirty?: () => void,
 *   onLog?: (message: string) => void
 * }} options
 */
async function createTableServer(options) {
  const { room, store, hostKey, preferredPort = 32100, onDirty = () => {}, onLog = () => {} } = options;

  const app = express();
  const httpServer = http.createServer(app);

  app.disable('x-powered-by');

  app.get('/', (req, res) => {
    res.type('text/plain; charset=utf-8').send(
      `Стол D&D «${room.campaign?.name || 'Кампания'}» работает.\nПодключайтесь через приложение.\n`
    );
  });

  app.get('/api/info', (req, res) => {
    res.json({
      ok: true,
      campaign: { id: room.campaign?.id || null, name: room.campaign?.name || null },
      players: room.playerList().length
    });
  });

  // Раздача изображений (карты и фишки) из папки текущей кампании.
  app.get('/files/:name', (req, res) => {
    const campaign = room.campaign;
    if (!campaign) return res.status(404).end();
    let filePath;
    try {
      filePath = store.filePath(campaign.id, req.params.name);
    } catch {
      return res.status(400).end();
    }
    // store.filePath уже отбрасывает выход за пределы папки: берётся только
    // базовое имя, поэтому "../../campaign.json" превратится в "campaign.json"
    // внутри files/, где такого файла нет.
    // Access-Control-Allow-Origin нужен, чтобы renderer мог рисовать
    // загруженную карту на холсте: без него холст считается «загрязнённым» и
    // сохранить нарисованное в файл нельзя.
    res.set('Access-Control-Allow-Origin', '*');
    res.sendFile(filePath, (error) => {
      if (!error || res.headersSent) return;
      res.status(error.status || error.statusCode || 404).end();
    });
  });

  const io = new Server(httpServer, {
    cors: { origin: '*' },
    maxHttpBufferSize: 20 * 1024 * 1024
  });

  const markDirty = () => {
    room.markDirty();
    onDirty();
  };

  const emitError = (socket, message) => {
    socket.emit('errorMessage', { message });
  };

  /**
   * Список участников рассылается двумя списками, а не одним.
   *
   * В списке есть заметки мастера, и отдать их игрокам нельзя: список уходит
   * на каждое изменение, и одна рассылка на всех утекла бы заметку сразу.
   *
   * Скрытые фишки знает только мастер: игрок увидел бы отметку «фишка на поле»
   * и догадался бы о заготовке. А мастер наоборот обязан видеть, что фишка
   * уже выведена, иначе кнопка «Вывести» горела бы у него вечно.
   * @param {boolean} [onlyOnline] Только те, кто сейчас за столом.
   */
  const broadcastPlayers = (onlyOnline = false) => {
    io.to('table').except('dm-sockets').emit('playersUpdate', room.playerList({
      includeTokens: !onlyOnline,
      includeDmNotes: false
    }));
    io.to('dm-sockets').emit('playersUpdate', room.playerList({
      includeTokens: !onlyOnline,
      includeDmNotes: true,
      includeHidden: true
    }));
  };

  const broadcastMapUpdate = (type) => {
    const slot = room.maps[type];
    // Мастеру уходит вкладка целиком: он готовит карты впрок и должен их видеть.
    io.to('dm-sockets').emit('mapUpdated', {
      type,
      items: slot ? slot.items : [],
      activeId: slot ? slot.activeId : null,
      activeMap: room.activeMap,
      activeMapId: room.activeMapId
    });
    // Игроку — только показанные карты. Скрытая заготовка не должна утекать
    // даже ссылкой на картинку: по ней он открыл бы будущую локацию.
    const visible = room.mapSlotForViewer(type, false);
    io.to('table').except('dm-sockets').emit('mapUpdated', {
      type,
      items: visible.items,
      activeId: visible.activeId,
      activeMap: room.activeMapId ? room.activeMap : null,
      activeMapId: room.activeMapId
    });
  };

  /**
   * Находит карту среди вкладок стола.
   *
   * Ищется именно карта, а не только вкладка: вкладка «Локация / битва» может
   * держать несколько карт, и открывать надо ту, которую все видят.
   * @param {{type?: string, mapId?: string}} payload
   * @returns {{type: string, item: object|null}}
   */
  const findMapItem = (payload) => {
    const slot = room.maps[payload && payload.type];
    if (!slot || !Array.isArray(slot.items) || !slot.items.length) return { type: 'world', item: null };
    const wanted = payload && payload.mapId ? String(payload.mapId) : '';
    const item = wanted
      ? slot.items.find((entry) => entry.id === wanted)
      : (slot.items.find((entry) => entry.id === slot.activeId) || slot.items[0]);
    return { type: payload && payload.type, item: item || null };
  };

  const requireJoined = (socket) => {
    if (!socket.data.role) {
      emitError(socket, 'Сначала подключитесь к столу');
      return false;
    }
    return true;
  };

  const requireDm = (socket) => {
    if (!requireJoined(socket)) return false;
    if (socket.data.role !== ROLE_DM) {
      emitError(socket, 'Это действие доступно только ДМ');
      return false;
    }
    return true;
  };

  const findToken = (tokenId) => room.tokens.find((token) => token.id === String(tokenId || ''));

  /**
   * Куда слать событие фишки.
   *
   * Скрытая фишка — заготовка мастера, и её положение, картинка и назначение
   * игрокам не показываются. Значит, и создание, и перемещение, и правка
   * уходят только мастеру. Проверять это на клиенте поздно: событие уже пришло.
   *
   * Видимую фишку видят все, но прочность монстров игрокам не уходит: мастер
   * ведёт её у себя. Разсылка поэтому раздельная — одним io.emit это не
   * выразить.
   * @param {string} event
   * @param {object} token
   * @param {object} [payload]
   */
  const emitToken = (event, token, payload) => {
    const data = payload || token;
    // Скрытая фишка и фишка на непоказанной карте — заготовки мастера. Их
    // положение, картинка и назначение игрокам не уходят: иначе карту они не
    // увидят, а стоящего на ней монстра увидят.
    if (token && !room.isTokenVisibleToPlayers(token)) {
      io.to('dm-sockets').emit(event, data);
      return;
    }
    io.to('dm-sockets').emit(event, data);
    // Прочность монстров игрокам не уходит. Если передали отдельную полезную
    // нагрузку (позиция, флаг скрытости, удаление), она очистке не подлежит, и
    // игроку уходит ровно то, что придумал отправитель.
    const forPlayers = payload || room.tokenForViewer(token, false);
    io.to('table').except('dm-sockets').emit(event, forPlayers);
  };

  /**
   * Показ или скрытие фишки.
   *
   * Скрытие рассылается всем: игрок должен убрать фишку, которую видел.
   * Показ, наоборот, идёт только мастеру, а игрокам уходит как новая фишка:
   * скрытой они её не видели, значит, у них её просто нет.
   * @param {object} token
   * @param {boolean} hidden
   */
  const emitTokenVisibility = (token, hidden) => {
    const wasHidden = Boolean(token.hidden);
    token.hidden = Boolean(hidden);
    markDirty();
    if (token.hidden) {
      io.emit('tokenHidden', { tokenId: token.id, hidden: true });
    } else {
      io.to('dm-sockets').emit('tokenHidden', { tokenId: token.id, hidden: false });
      // emitToken, а не io.emit: игрокам фишка уходит через tokenForViewer,
      // иначе вместе с показом утекали бы хиты и скрытое имя монстра.
      if (wasHidden) emitToken('tokenCreated', token);
    }
    broadcastPlayers();
  };

  /**
   * Ставит игроку аватар и переносит его на выведенную из листа фишку.
   *
   * Фишка с флагом avatarFromSheet живёт аватаром игрока: поменял портрет —
   * фишка обновилась сама. Фишки с картинкой, поставленной руками, не трогаем.
   * @param {string} playerId
   * @param {string|null} url ссылка вида /files/<имя> либо null
   */
  const applyAvatar = (playerId, url) => {
    const player = room.players.get(playerId);
    if (!player) return;
    player.avatar = url || null;
    for (const token of room.tokens) {
      if (!token.avatarFromSheet || token.assignedPlayerId !== playerId) continue;
      token.imageUrl = player.avatar;
      emitToken('tokenUpdated', token);
    }
    markDirty();
    broadcastPlayers();
  };

  /**
   * Ключ группы: название без регистра и лишних пробелов.
   *
   * При импорте из Foundry названия приходят с разными отступами и иногда с
   * разным регистром. Если сравнивать «как есть», одна группа распадётся
   * на несколько, и картинка ляжет не на всё.
   * @param {string} name
   * @returns {string}
   */
  const groupKey = (name) => String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();

  io.on('connection', (socket) => {
    socket.data.role = null;
    socket.data.playerId = null;
    socket.data.name = '';

    socket.on('joinRoom', (payload, ack) => {
      const data = payload && typeof payload === 'object' ? payload : {};
      const name = sanitizeName(data.name);
      const respond = typeof ack === 'function' ? ack : () => {};

      if (!name) {
        respond({ ok: false, error: 'Имя не может быть пустым' });
        return emitError(socket, 'Имя не может быть пустым');
      }

      // ДМ определяется по секретному ключу, который main-процесс передал
      // своему же окну, и по локальному адресу подключения. Сервер слушает
      // лишь 127.0.0.1, так что подключиться извне к нему нельзя вовсе, а
      // ключ остаётся второй линией защиты.
      const isHost =
        isLoopbackAddress(socket.handshake.address) && safeEqual(data.hostKey, hostKey);

      let role;
      let playerId;
      // Секрет личности. Без него клиент мог бы назваться чужим кодом и
      // забрать чужой лист, фишку и имя в чате: роль берётся сокетом из этого
      // значения, а не из сообщений.
      let playerKey = '';
      if (isHost) {
        role = ROLE_DM;
        playerId = DM_PLAYER_ID;
        room.addDm(name);
        room.players.get(DM_PLAYER_ID).sockets.add(socket.id);
        room.players.get(DM_PLAYER_ID).online = true;
        socket.join(DM_PLAYER_ID);
      } else {
        role = ROLE_PLAYER;
        const requested = String(data.playerId || '');
        const providedKey = typeof data.playerKey === 'string' ? data.playerKey.slice(0, 128) : '';
        // Код 'dm' зарезервирован за мастером: роль ДМ даёт только hostKey, но
        // и саму запись мастера игрок занять не должен.
        if (requested === DM_PLAYER_ID) {
          respond({
            ok: false,
            code: 'identity-denied',
            error: 'Это код мастера. Войдём заново под своим кодом.'
          });
          return;
        }
        const wanted = PLAYER_ID_PATTERN.test(requested) ? requested : '';
        const existing = wanted ? room.players.get(wanted) : null;
        if (existing && existing.playerKey) {
          if (!safeEqual(providedKey, existing.playerKey)) {
            respond({
              ok: false,
              code: 'identity-denied',
              error: 'Игрок с таким кодом уже за столом. Войдём заново под новым кодом.'
            });
            return;
          }
          playerId = wanted;
          playerKey = existing.playerKey;
        } else if (existing && existing.online) {
          // Стол старого формата, ключа ещё нет, но игрок сейчас за столом:
          // чужой вход под его кодом не пускаем.
          respond({
            ok: false,
            code: 'identity-denied',
            error: 'Игрок с таким кодом уже за столом. Войдём заново под новым кодом.'
          });
          return;
        } else {
          playerId = wanted || `p-${crypto.randomUUID()}`;
          playerKey = crypto.randomBytes(24).toString('hex');
        }
        const player = room.addPlayer(playerId, name, playerKey);
        player.sockets.add(socket.id);
        player.online = true;
        // Комната с именем игрока: так все его окна получают синхронизацию.
        socket.join(playerId);
      }

      socket.data.role = role;
      socket.data.playerId = playerId;
      socket.data.name = name;
      socket.join('table'); // общая комната для широковещательных рассылок
      if (role === ROLE_DM) socket.join('dm-sockets');

      socket.emit('joined', {
        you: { playerId, name, role, playerKey },
        state: room.snapshotFor({ playerId, role })
      });
      respond({ ok: true, you: { playerId, name, role, playerKey } });
      markDirty();
      broadcastPlayers();
      onLog(`Подключился ${role === ROLE_DM ? 'ДМ' : 'игрок'} ${name} (${socket.handshake.address})`);
    });

    /* ------------------------------------------------------------------ *
     * Лист персонажа
     * ------------------------------------------------------------------ */

    socket.on('saveCharacterSheet', (payload) => {
      if (!requireJoined(socket)) return;
      if (socket.data.role !== ROLE_PLAYER) {
        return emitError(socket, 'ДМ не редактирует листы персонажей');
      }
      const playerId = socket.data.playerId;
      const player = room.players.get(playerId);
      const sheet = normalizeSheet(payload && payload.sheet, player ? player.name : '');
      room.sheets.set(playerId, sheet);
      markDirty();
      io.to(playerId).emit('characterSheetData', { playerId, sheet });
      io.to('dm-sockets').emit('characterSheetUpdated', { playerId, sheet });
      broadcastPlayers();
    });

    /**
     * Спасбросок смерти.
     *
     * Бросает сервер, а не клиент, иначе игрок мог бы подкрутить и число, и
     * счётчик. Правила 5e: десятка и выше — успех, единица — сразу две неудачи,
     *natural20 поднимает персонажа с одного здоровья.
     *
     * Бросает только сам игрок за свой лист: мастер в чужом листе работает
     * только на чтение, иначе он вносил бы боевые броски от лица игрока.
     */
    socket.on('rollDeathSave', () => {
      if (!requireJoined(socket)) return;
      if (socket.data.role !== ROLE_PLAYER) {
        return emitError(socket, 'Спасбросок смерти бросает сам игрок');
      }
      const playerId = socket.data.playerId;
      const player = room.players.get(playerId);
      const sheet = room.sheets.get(playerId);
      if (!sheet) return emitError(socket, 'Лист персонажа ещё не готов');
      if (sheet.hp > 0) return emitError(socket, 'Спасброски смерти идут при нулевом здоровье');

      const die = crypto.randomInt(1, 21);
      let outcome;
      if (die === 20) {
        sheet.hp = 1;
        sheet.deathSavesSuccesses = 0;
        sheet.deathSavesFailures = 0;
        outcome = 'персонаж приходит в себя';
      } else if (die === 1) {
        sheet.deathSavesFailures = Math.min(LIMITS.maxDeathSaves, sheet.deathSavesFailures + 2);
        outcome = 'две неудачи разом';
      } else if (die >= 10) {
        sheet.deathSavesSuccesses = Math.min(LIMITS.maxDeathSaves, sheet.deathSavesSuccesses + 1);
        outcome = 'успех';
      } else {
        sheet.deathSavesFailures = Math.min(LIMITS.maxDeathSaves, sheet.deathSavesFailures + 1);
        outcome = 'неудача';
      }

      markDirty();
      // Лист шлём владельцу и мастеру: счётчик должен уйти обоим, иначе мастер
      // увидит устаревшее состояние.
      io.to(playerId).emit('characterSheetData', { playerId, sheet });
      io.to('dm-sockets').emit('characterSheetUpdated', { playerId, sheet });

      const roll = {
        playerId,
        playerName: sheet.characterName || player?.name || 'Игрок',
        role: socket.data.role,
        // Бросок смерти идёт в общую ленту бросков: его видят все и обсуждают.
        formula: 'd20',
        count: 1,
        sides: 20,
        values: [die],
        keptValues: [die],
        droppedValues: [],
        modifier: 0,
        result: die,
        isDeathSave: true,
        hidden: false,
        time: new Date().toISOString()
      };
      room.diceHistory.push(roll);
      if (room.diceHistory.length > LIMITS.maxDiceHistory) {
        room.diceHistory = room.diceHistory.slice(-LIMITS.maxDiceHistory);
      }
      io.emit('diceRollResult', roll);

      const note = sheet.hp > 0 && die === 20
        ? ` (${outcome})`
        : ` — ${outcome}`;
      const announcement = {
        from: sheet.playerName || player?.name || 'Игрок',
        playerId,
        role: socket.data.role,
        avatar: player?.avatar || null,
        text: `спасбросок смерти: d20 ${die}${note}`,
        isRoll: true,
        time: roll.time
      };
      room.chatHistory.push(announcement);
      if (room.chatHistory.length > LIMITS.maxChatHistory) {
        room.chatHistory = room.chatHistory.slice(-LIMITS.maxChatHistory);
      }
      io.emit('chatMessage', announcement);
    });

    /** Сбрасывает счётчики спасбросков вручную: лечение уже подняло героя. */
    socket.on('resetDeathSaves', () => {
      if (!requireJoined(socket)) return;
      if (socket.data.role !== ROLE_PLAYER) {
        return emitError(socket, 'Счётчики спасбросков сбрасывает игрок');
      }
      const playerId = socket.data.playerId;
      const sheet = room.sheets.get(playerId);
      if (!sheet) return emitError(socket, 'Лист персонажа ещё не готов');
      sheet.deathSavesSuccesses = 0;
      sheet.deathSavesFailures = 0;
      markDirty();
      io.to(playerId).emit('characterSheetData', { playerId, sheet });
      io.to('dm-sockets').emit('characterSheetUpdated', { playerId, sheet });
    });

    socket.on('requestCharacterSheet', (payload) => {
      if (!requireJoined(socket)) return;
      const targetId = String((payload && payload.playerId) || '');
      const isDm = socket.data.role === ROLE_DM;
      if (!isDm && targetId !== socket.data.playerId) {
        return emitError(socket, 'Можно смотреть только свой лист персонажа');
      }
      const sheet = room.sheets.get(targetId);
      if (!sheet) return emitError(socket, 'Лист персонажа не найден');
      socket.emit('characterSheetData', { playerId: targetId, sheet });
    });

    /* ------------------------------------------------------------------ *
     * Аватар игрока
     * ------------------------------------------------------------------ */

    /**
     * Аватар меняет только сам игрок. Мастеру тоже можно: портрет ведущего
     * он тоже ставит себе, а чужой аватар трогать нельзя — это личный кадр
     * человека, а не элемент партии.
     */
    /**
     * Смена своего имени.
     *
     * Имя приходит от каждого окна при подключении, поэтому переименование
     * должно пережить переподключение: клиент сохраняет новое имя у себя и
     * пришлёт его снова. Лист правится только если в нём было прежнее имя —
     * вписанное руками имя персонажа стирать нельзя.
     *
     * Чужое имя не правится никогда: у сокета есть только своё.
     */
    socket.on('setPlayerName', (payload) => {
      if (!requireJoined(socket)) return;
      const name = sanitizeName(payload && payload.name);
      if (!name) return emitError(socket, 'Имя не может быть пустым');
      const previous = socket.data.name;
      if (previous === name) return;
      const player = room.renamePlayer(socket.data.playerId, name);
      if (!player) return emitError(socket, 'Участник не найден');
      socket.data.name = name;
      markDirty();
      broadcastPlayers();
      onLog(`${socket.data.role === ROLE_DM ? 'ДМ' : 'Игрок'} ${previous} теперь ${name}`);
    });

    socket.on('setAvatar', async (payload) => {
      if (!requireJoined(socket)) return;
      const playerId = socket.data.playerId;
      const player = room.players.get(playerId);
      if (!player) return;

      const raw = payload && payload.image;
      // null — намеренно убрать картинку и вернуться к инициалам.
      if (raw === null || raw === undefined || raw === '') {
        applyAvatar(playerId, null);
        onLog('Аватар убран');
        return;
      }
      const decoded = decodeImage(raw, LIMITS.maxAvatarBytes);
      if (decoded.error) return emitError(socket, decoded.error);
      try {
        const fileName = await store.saveImage(room.campaign.id, decoded.buffer, decoded.ext);
        applyAvatar(playerId, `/files/${fileName}`);
        onLog(`Аватар игрока ${player.name} обновлён`);
      } catch (error) {
        emitError(socket, error && error.quota ? error.message : 'Не получилось сохранить аватар');
        onLog(`Ошибка сохранения аватара: ${error.message}`);
      }
    });

    /**
     * Фишка игрока прямо из его листа: имя берётся у персонажа, картинка — у
     * аватара. Заодно проверяем, что фишка уже не стоит: две фишки на одного
     * человека — это всегда ошибка, а не «ну ладно».
     */
    socket.on('createTokenFromSheet', (payload) => {
      if (!requireDm(socket)) return;
      const playerId = String((payload && payload.playerId) || '');
      const player = room.players.get(playerId);
      if (!player) return emitError(socket, 'Игрок не найден');
      if (player.role === ROLE_DM) return emitError(socket, 'У мастера нет фишки на поле');
      const existing = room.tokens.find((token) => token.assignedPlayerId === playerId);
      if (existing) {
        return emitError(socket, `У игрока уже есть фишка «${existing.name}»`);
      }
      if (room.tokens.length >= LIMITS.maxTokens) return emitError(socket, 'Слишком много фишек на столе');

      const sheet = room.sheets.get(playerId);
      const requestedMap = payload && payload.mapType;
      const mapType = MAP_TYPES.includes(requestedMap) ? requestedMap : (room.activeMap || 'battle');
      const token = {
        id: newTokenId(),
        name: sanitizeName(sheet && sheet.characterName) || sanitizeName(player.name) || 'Фишка',
        mapType,
        mapId: sanitizeText(payload && payload.mapId, 80),
        x: 0.5,
        y: 0.5,
        // Аватар мастера — это его портрет в списке, а не картинка фишки:
        // выводить фишку из листа мастера мы не даём, а пустой аватар у фишки
        // останется цветным кружком.
        imageUrl: player.avatar || null,
        assignedPlayerId: playerId,
        avatarFromSheet: true,
        // Как и любая новая фишка, сначала скрыта: мастер выводит партию и
        // проверяет расстановку, потом открывает.
        hidden: true,
        color: TOKEN_PALETTE[room.tokens.length % TOKEN_PALETTE.length]
      };
      room.tokens.push(token);
      markDirty();
      emitToken('tokenCreated', token);
      broadcastPlayers();
      onLog(`Фишка «${token.name}» выведена из листа игрока ${player.name}`);
    });

    /* ------------------------------------------------------------------ *
     * Карты
     * ------------------------------------------------------------------ */

    socket.on('uploadMap', async (payload) => {
      if (!requireDm(socket)) return;
      const type = payload && payload.type;
      if (!MAP_TYPES.includes(type)) return emitError(socket, 'Неизвестный тип карты');
      const slot = room.maps[type];
      if (slot.items.length >= LIMITS.maxMapsPerType) {
        return emitError(socket, `В этой вкладке уже ${LIMITS.maxMapsPerType} карт — удалите лишние`);
      }
      const decoded = decodeImage(payload && payload.image);
      if (decoded.error) return emitError(socket, decoded.error);
      try {
        const fileName = await store.saveImage(room.campaign.id, decoded.buffer, decoded.ext);
        // Новая карта добавляется к уже загруженным, а не заменяет их: в одной
        // вкладке можно держать хоть десяток локаций и переключаться между ними.
        const map = {
          id: newMapId(),
          url: `/files/${fileName}`,
          name: sanitizeText(payload && payload.name, MAP_NAME_MAX) || 'Карта',
          // Новая карта — заготовка: мастер сначала готовит её, смотрит туман,
          // расставляет фишки, и только кнопка «Показать игрокам» открывает её
          // столу. Иначе загрузка следующей локации выдала бы сюрприз.
          published: false,
          // Туман есть у каждой карты с момента появления: иначе свежая карта
          // отличалась бы от загруженной из кампании, а мастер нарисовал бы
          // туман поверх поля, которого в её форме нет. Так же и освещение:
          // карта без темноты, стен и источников — это ровно дневная карта.
          fogMask: fogModel.newFogMask(),
          // Поверхность у новой карты пустая, но поле есть: иначе мастер
          // рисовал бы в undefined и первая же мазок падала бы.
          surface: { cells: {} },
          walls: [],
          lights: [],
          darkness: 0,
          uploadedAt: new Date().toISOString()
        };
        slot.items.push(map);
        // Мастер сразу видит новую карту, игроки — нет, пока он не покажет её.
        slot.activeId = map.id;
        markDirty();
        broadcastMapUpdate(type);
        onLog(`ДМ загрузил карту (${type}), всего в вкладке: ${slot.items.length}`);
      } catch (error) {
        emitError(socket, error && error.quota ? error.message : 'Не удалось сохранить изображение карты');
        onLog(`Ошибка сохранения карты: ${error.message}`);
      }
    });

    socket.on('selectMap', (payload) => {
      if (!requireDm(socket)) return;
      const type = payload && payload.type;
      if (!MAP_TYPES.includes(type)) return emitError(socket, 'Неизвестный тип карты');
      const slot = room.maps[type];
      const mapId = String((payload && payload.mapId) || '');
      if (!slot.items.some((item) => item.id === mapId)) return emitError(socket, 'Карта не найдена');
      // Это выбор мастера, а не показ: игроки остаются на прежней карте, пока
      // он не нажмёт «Показать игрокам».
      slot.activeId = mapId;
      markDirty();
      broadcastMapUpdate(type);
      onLog(`ДМ переключил карту (${type})`);
    });

    socket.on('deleteMap', (payload) => {
      if (!requireDm(socket)) return;
      const type = payload && payload.type;
      if (!MAP_TYPES.includes(type)) return emitError(socket, 'Неизвестный тип карты');
      const slot = room.maps[type];
      const requested = payload && payload.mapId ? String(payload.mapId) : slot.activeId;
      const index = slot.items.findIndex((item) => item.id === requested);
      if (index < 0) return emitError(socket, 'Карта не найдена');
      const wasPresented = room.activeMap === type && room.activeMapId === requested;

      slot.items.splice(index, 1);
      if (slot.activeId === requested) {
        // Соседняя карта становится выбором мастера. Показывать её игрокам
        // сразу не нужно: если это была открытая карта, будет отдельная ветка.
        const neighbour = slot.items[index] || slot.items[index - 1] || null;
        slot.activeId = neighbour ? neighbour.id : null;
      }

      let otherType = null;
      if (wasPresented) {
        // Показываем только уже открытую карту: соседняя заготовка не должна
        // попасть на стол из-за удаления, иначе подготовка снова утечёт.
        const next = slot.items.find((item) => item.published !== false) || null;
        if (next) {
          slot.activeId = next.id;
          room.activeMap = type;
          room.activeMapId = next.id;
        } else {
          const fallbackType = MAP_TYPES.find((candidate) => candidate !== type
            && room.maps[candidate].items.some((item) => item.published !== false));
          if (fallbackType) {
            const fallbackSlot = room.maps[fallbackType];
            const fallback = fallbackSlot.items.find((item) => item.published !== false);
            fallbackSlot.activeId = fallback.id;
            room.activeMap = fallbackType;
            room.activeMapId = fallback.id;
            otherType = fallbackType;
          } else {
            room.activeMap = null;
            room.activeMapId = null;
          }
        }
      }

      markDirty();
      broadcastMapUpdate(type);
      if (otherType) broadcastMapUpdate(otherType);
      onLog(`ДМ удалил карту (${type}), осталось: ${slot.items.length}`);
    });

    /**
     * Пинг по карте: «смотрите сюда».
     *
     * Это не объект кампании, а короткий жест. Сохранять его незачем: через
     * пару секунд он исчезает у всех. Пинг разрешён только на карте, которую
     * видят игроки, иначе он указывал бы в пустоту или выдавал заготовку.
     */
    socket.on('mapPing', (payload) => {
      if (!requireJoined(socket)) return;
      if (!payload || typeof payload !== 'object') return;
      const type = String(payload.mapType || '');
      const mapId = String(payload.mapId || '');
      const x = Number(payload.x);
      const y = Number(payload.y);
      if (!MAP_TYPES.includes(type) || !mapId || !Number.isFinite(x) || !Number.isFinite(y)) return;
      if (room.activeMap !== type || room.activeMapId !== mapId) return;
      // Мышь может дрожать, а палец на тачпаде — тем более. Частые пинги
      // превращаются в мигание, поэтому один и тот же сокет не чаще 4 раз в секунду.
      const now = Date.now();
      if (now - (socket.data.lastPingAt || 0) < 250) return;
      socket.data.lastPingAt = now;
      io.to('table').emit('mapPing', {
        mapType: type,
        mapId,
        x: clampNumber(x, 0, 1, 0.5),
        y: clampNumber(y, 0, 1, 0.5),
        playerId: socket.data.playerId,
        name: socket.data.name,
        role: socket.data.role
      });
    });

socket.on('setGrid', (payload) => {
      if (!requireDm(socket)) return;
      const data = payload && typeof payload === 'object' ? payload : {};
      // Правила сетки — из файла правил вместе с интерфейсом: клиент рисует
      // клетку по этим же числам, иначе сетка у разных участников разъехалась бы.
      const next = normalizeGrid({
        ...room.grid,
        ...data,
        enabled: Boolean(data.enabled)
      });
      if (sameGrid(room.grid, next)) return;
      room.grid = next;
      markDirty();
      // Сетка — дело мастера: её видят и двигают только он.
      io.emit('gridUpdated', room.grid);
    });

    socket.on('setActiveMap', (payload) => {
      if (!requireDm(socket)) return;
      const type = payload && payload.type;
      if (!MAP_TYPES.includes(type)) return emitError(socket, 'Неизвестный тип карты');
      const slot = room.maps[type];
      const mapId = String((payload && payload.mapId) || slot.activeId || '');
      const item = slot.items.find((entry) => entry.id === mapId);
      if (!item) return emitError(socket, 'Карта не найдена');
      const wasPublished = item.published !== false;
      // Показ — единственное действие, которое открывает карту игрокам.
      item.published = true;
      slot.activeId = mapId;
      room.activeMap = type;
      room.activeMapId = mapId;
      markDirty();
      broadcastMapUpdate(type);
      if (!wasPublished) {
        // На подготовленной карте могли стоять фишки. Игроки их не получали,
        // значит, теперь нужно прислать: карта и фишки открываются вместе.
        for (const token of room.tokens) {
          if (token.mapType === type && token.mapId === mapId) emitToken('tokenCreated', token);
        }
      }
      onLog(`ДМ показал игрокам карту (${type})`);
    });

    /* ------------------------------------------------------------------ *
     * Фишки
     * ------------------------------------------------------------------ */

    socket.on('createToken', (payload) => {
      if (!requireDm(socket)) return;
      if (room.tokens.length >= LIMITS.maxTokens) return emitError(socket, 'Слишком много фишек на столе');
      const requestedMap = payload && payload.mapType;
      const mapType = MAP_TYPES.includes(requestedMap) ? requestedMap : (room.activeMap || 'battle');
      const token = {
        id: newTokenId(),
        name: sanitizeName(payload && payload.name) || `Фишка ${room.tokens.length + 1}`,
        mapType,
        // Фишка привязывается к той карте, на которой её создали, иначе на
        // вкладке с несколькими картами она появлялась бы на всех сразу.
        mapId: sanitizeText(payload && payload.mapId, 80),
        x: 0.5,
        y: 0.5,
        imageUrl: null,
        assignedPlayerId: null,
        // Новая фишка появляется скрытой: мастер сначала расставляет и
        // проверяет, и только потом открывает её игрокам. Без этого инициатива
        // начиналась бы с того, что все монстры уже на виду.
        hidden: true,
        color: TOKEN_PALETTE[room.tokens.length % TOKEN_PALETTE.length],
        // Прочность задаётся сразу при создании: монстра заводят на стол с его
        // хитами, и дописывать их потом отдельной правкой неудобно.
        maxHp: Number.isFinite(Number(payload && payload.maxHp)) && Number(payload.maxHp) > 0
          ? clampInt(payload.maxHp, 1, LIMITS.maxTokenHp, 1)
          : null,
        // Поле состояний нужно уже у новой фишки: иначе её форма в интерфейсе
        // отличается от фишки, загруженной из кампании.
        conditions: [],
        // Свет у новой фишки тоже должен быть: иначе гасить его было бы нечем,
        // а проверка «светит ли кто-нибудь» ломалась бы на самой первой фишке.
        light: normalizeTokenLight(null)
      };
      token.hp = token.maxHp;
      room.tokens.push(token);
      markDirty();
      emitToken('tokenCreated', token);
      onLog(`Фишка «${token.name}» создана скрытой от игроков`);
    });

    /**
     * Прочность фишки меняет только мастер.
     *
     * Игрок правит своё здоровье в листе персонажа. Две правки одного числа
     * разошлись бы: в листе было бы 12, а на фишке 9, и за столом никто не
     * понял бы, где правда. Фишка без прочности (maxHp === null) — метка,
     * здоровья у неё нет, и сервер молча игнорирует правку.
     */
    /**
     * Туман войны.
     *
     * Открывает мастер, видят все. Игрок не может ничего открыть: если бы мог,
     * он просто открыл бы всю карту себе.
     *
     * Маска уходит игрокам в любом случае: им нужен тот же самый туман, что и
     * мастеру, иначе карты у игроков разъедутся.
     */
    socket.on('openMapFog', (payload) => {
      if (!requireDm(socket)) return;
      const { type, item } = findMapItem(payload);
      if (!item) return emitError(socket, 'Карта не найдена');
      room.openMapFog(item, Number(payload && payload.x), Number(payload && payload.y), Number(payload && payload.radius));
      markDirty();
      broadcastMapUpdate(type);
    });

    /** Открывает карту целиком или снова закрывает. */
    socket.on('setMapFog', (payload) => {
      if (!requireDm(socket)) return;
      const { type, item } = findMapItem(payload);
      if (!item) return emitError(socket, 'Карта не найдена');
      room.setWholeMapFog(item, Boolean(payload && payload.open));
      markDirty();
      broadcastMapUpdate(type);
    });

    /**
     * Поверхность по клеткам: кислота, огонь, вода и прочее.
     *
     * Мастер рисует кистью и отпускает мышь: уходит пачка клеток одним
     * сообщением, иначе стол получал бы сотни сообщений за один мазок. Типы
     * сверяются со списком правил, а клетки — с пределами, иначе в кампанию
     * попало бы что угодно.
     */
    socket.on('paintMapSurface', (payload) => {
      if (!requireDm(socket)) return;
      const { type, item } = findMapItem(payload);
      if (!item) return emitError(socket, 'Карта не найдена');
      const cells = payload && payload.cells;
      if (!Array.isArray(cells) || !cells.length) return;
      const surface = { cells: { ...(item.surface && item.surface.cells) } };
      let changed = 0;
      for (const entry of cells.slice(0, 400)) {
        if (!Array.isArray(entry) || entry.length !== 3) continue;
        const col = Number(entry[0]);
        const row = Number(entry[1]);
        if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0) continue;
        const key = `${col},${row}`;
        const kind = entry[2] === null ? '' : String(entry[2]);
        if (kind && !SURFACE_IDS.has(kind)) continue;
        if ((surface.cells[key] || '') === kind) continue;
        changed += 1;
        if (kind) surface.cells[key] = kind;
        else delete surface.cells[key];
      }
      if (!changed) return;
      const limited = normalizeSurface(surface);
      if (!Object.keys(limited.cells).length && !Object.keys(item.surface.cells).length) return;
      item.surface = limited;
      markDirty();
      broadcastMapUpdate(type);
    });

    /** Стирает поверхность с карты целиком. */
    socket.on('clearMapSurface', (payload) => {
      if (!requireDm(socket)) return;
      const { type, item } = findMapItem(payload);
      if (!item) return emitError(socket, 'Карта не найдена');
      if (!item.surface || !Object.keys(item.surface.cells).length) return;
      item.surface = { cells: {} };
      markDirty();
      broadcastMapUpdate(type);
    });

    /* ------------------------------------------------------------------ *
     * Освещение: темнота карты, стены и источники света
     * ------------------------------------------------------------------ */

    /**
     * Общая темнота карты.
     *
     * Правка только мастерская по той же причине, что и у тумана: темнота
     * решает, что игрок видит. Ноль означает дневной свет и выключает слой
     * вовсе, чтобы карта без освещения не выглядела пожелтевшей.
     */
    socket.on('setMapDarkness', (payload) => {
      if (!requireDm(socket)) return;
      const { type, item } = findMapItem(payload);
      if (!item) return emitError(socket, 'Карта не найдена');
      const darkness = Number(payload && payload.darkness);
      if (!Number.isFinite(darkness)) return;
      const value = Math.max(0, Math.min(1, darkness));
      if (item.darkness === value) return;
      item.darkness = value;
      markDirty();
      broadcastMapUpdate(type);
    });

    /**
     * Стена: отрезок, который держит свет.
     *
     * Шлётся по окончанию протяжки, а не на каждом пикселе: мастер рисует
     * стену движением мыши, и рассылка на каждое движение утащила бы всех
     * участников стола. Правка только мастерская.
     */
    socket.on('addMapWall', (payload) => {
      if (!requireDm(socket)) return;
      const { type, item } = findMapItem(payload);
      if (!item) return emitError(socket, 'Карта не найдена');
      const wall = normalizeWall({
        // Идентификатор даёт клиент: мастер рисует стену и сразу видит её на
        // месте, а если сервер выдаст свой, через полсекунды на карте окажется
        // вторая копия с другим id — и следующий правый клик удалил бы не ту.
        id: (payload && payload.wallId) || newTokenId(),
        x1: payload && payload.x1,
        y1: payload && payload.y1,
        x2: payload && payload.x2,
        y2: payload && payload.y2
      });
      // Точка или полностью вырожденный отрезок стеной не считаются.
      if (!wall || !wall.id) return;
      if (item.walls.length >= LIGHT_LIMITS.maxWalls) {
        return emitError(socket, `Стен больше ${LIGHT_LIMITS.maxWalls} быть не может`);
      }
      item.walls.push(wall);
      markDirty();
      broadcastMapUpdate(type);
    });

    socket.on('deleteMapWall', (payload) => {
      if (!requireDm(socket)) return;
      const { type, item } = findMapItem(payload);
      if (!item) return emitError(socket, 'Карта не найдена');
      const wallId = String((payload && payload.wallId) || '');
      const before = item.walls.length;
      item.walls = item.walls.filter((wall) => wall.id !== wallId);
      if (item.walls.length === before) return;
      markDirty();
      broadcastMapUpdate(type);
    });

    /** Убрать все стены карты разом: перед боем это делают часто. */
    socket.on('clearMapWalls', (payload) => {
      if (!requireDm(socket)) return;
      const { type, item } = findMapItem(payload);
      if (!item) return emitError(socket, 'Карта не найдена');
      if (!item.walls.length) return;
      item.walls = [];
      markDirty();
      broadcastMapUpdate(type);
    });

    /**
     * Шаблон заклинания (сфера, конус, линия). Как и стена, ставится по
     * окончанию протяжки: мастер тянет от вершины, задавая направление.
     * Видят все: это эффект на карте, а не заметка мастера.
     */
    socket.on('addMapTemplate', (payload) => {
      if (!requireDm(socket)) return;
      const { type, item } = findMapItem(payload);
      if (!item) return emitError(socket, 'Карта не найдена');
      if (!Array.isArray(item.templates)) item.templates = [];
      if (item.templates.length >= TEMPLATE_LIMITS.maxPerMap) {
        return emitError(socket, `Шаблонов больше ${TEMPLATE_LIMITS.maxPerMap} быть не может`);
      }
      const template = normalizeTemplate({
        id: (payload && payload.templateId) || newTokenId(),
        kind: payload && payload.kind,
        x: payload && payload.x,
        y: payload && payload.y,
        size: payload && payload.size,
        rotation: payload && payload.rotation
      });
      if (!template) return;
      item.templates.push(template);
      markDirty();
      broadcastMapUpdate(type);
    });

    socket.on('deleteMapTemplate', (payload) => {
      if (!requireDm(socket)) return;
      const { type, item } = findMapItem(payload);
      if (!item) return emitError(socket, 'Карта не найдена');
      const templateId = String((payload && payload.templateId) || '');
      const list = Array.isArray(item.templates) ? item.templates : [];
      const before = list.length;
      item.templates = list.filter((template) => template.id !== templateId);
      if (item.templates.length === before) return;
      markDirty();
      broadcastMapUpdate(type);
    });

    socket.on('clearMapTemplates', (payload) => {
      if (!requireDm(socket)) return;
      const { type, item } = findMapItem(payload);
      if (!item) return emitError(socket, 'Карта не найдена');
      if (!Array.isArray(item.templates) || !item.templates.length) return;
      item.templates = [];
      markDirty();
      broadcastMapUpdate(type);
    });

    socket.on('addMapLight', (payload) => {
      if (!requireDm(socket)) return;
      const { type, item } = findMapItem(payload);
      if (!item) return emitError(socket, 'Карта не найдена');
      const light = normalizeLight({
        // Как и у стены, идентификатор даёт клиент: огонь должен появиться на
        // карте сразу, без ожидания ответа, а второй экземпляр с другим id
        // остался бы гореть навсегда.
        id: (payload && payload.lightId) || newTokenId(),
        x: payload && payload.x,
        y: payload && payload.y,
        radius: payload && payload.radius,
        color: payload && payload.color,
        dim: payload && payload.dim
      });
      if (!light || !light.id) return;
      if (item.lights.length >= LIGHT_LIMITS.maxLights) {
        return emitError(socket, `Источников света больше ${LIGHT_LIMITS.maxLights} быть не может`);
      }
      item.lights.push(light);
      markDirty();
      broadcastMapUpdate(type);
    });

    /** Правка источника: дальность, цвет или «погасить». */
    socket.on('setMapLight', (payload) => {
      if (!requireDm(socket)) return;
      const { type, item } = findMapItem(payload);
      if (!item) return emitError(socket, 'Карта не найдена');
      const light = item.lights.find((entry) => entry.id === String(payload && payload.lightId));
      if (!light) return emitError(socket, 'Источник света не найден');
      const next = normalizeLight({
        id: light.id,
        x: payload && payload.x !== undefined ? payload.x : light.x,
        y: payload && payload.y !== undefined ? payload.y : light.y,
        radius: payload && payload.radius !== undefined ? payload.radius : light.radius,
        color: payload && payload.color !== undefined ? payload.color : light.color,
        // Тусклый свет по правилам светит вдвое меньше: это отдельный признак,
        // а не яркость, иначе мастер не смог бы отличить слабый огонь от
        // яркого того же радиуса.
        dim: payload && payload.dim !== undefined ? payload.dim : light.dim,
        hidden: payload && payload.hidden !== undefined ? payload.hidden : light.hidden
      });
      if (!next) return emitError(socket, 'Источник света задан неверно');
      Object.assign(light, next);
      markDirty();
      broadcastMapUpdate(type);
    });

    socket.on('deleteMapLight', (payload) => {
      if (!requireDm(socket)) return;
      const { type, item } = findMapItem(payload);
      if (!item) return emitError(socket, 'Карта не найдена');
      const lightId = String((payload && payload.lightId) || '');
      const before = item.lights.length;
      item.lights = item.lights.filter((light) => light.id !== lightId);
      if (item.lights.length === before) return;
      markDirty();
      broadcastMapUpdate(type);
    });

    /**
     * Свет фишки: факел в руке персонажа или костёр под монстром.
     *
     * Дальность в футах, а не в клетках, потому что так написано в правилах и
     * мастер не должен пересчитывать футы в клетки за столом. Правка и
     * перемещение — только мастерские: иначе игрок мог бы осветить себе поле.
     */
    socket.on('setTokenLight', (payload) => {
      if (!requireDm(socket)) return;
      const token = findToken(payload && payload.tokenId);
      if (!token) return emitError(socket, 'Фишка не найдена');
      const radius = Number(payload && payload.radius);
      if (!Number.isFinite(radius) || radius < 0) return emitError(socket, 'Дальность света задана неверно');
      const color = payload && payload.color;
      // Свет есть не у всякой фишки: кампания может прийти из версии без него,
      // и без подстановки здесь сервер упал бы на первой же такой фишке.
      token.light = normalizeTokenLight({
        radius,
        color: typeof color === 'string' ? color : (token.light && token.light.color)
      });
      markDirty();
      emitToken('tokenUpdated', token);
    });

    /**
     * Состояния фишки: слепой, парализован, сбит с ног и прочие.
     *
     * В отличие от прочности, состояния видны и игрокам: по «сбит с ног» и
     * «парализован» всё видно и сразу, скрывать тут нечего. Правит мастер.
     */
    /**
     * Заметка мастера об игроке.
     *
     * Только мастер и только себе: игроки заметку не получают даже при
     * просмотре состояния. Хранится у записи игрока, а не в листе, потому что
     * лист игрок видит целиком и заметка уехала бы вместе с ним.
     */
    socket.on('setDmNote', (payload) => {
      if (!requireDm(socket)) return;
      const playerId = String((payload && payload.playerId) || '');
      const player = room.players.get(playerId);
      if (!player) return emitError(socket, 'Игрок не найден');
      player.dmNote = sanitizeText(payload && payload.note, LIMITS.maxDmNote);
      markDirty();
      // Заметку получает только мастер, даже сам игрок.
      io.to('dm-sockets').emit('dmNoteUpdated', { playerId, note: player.dmNote });
    });

    socket.on('setTokenConditions', (payload) => {
      if (!requireDm(socket)) return;
      const token = findToken(payload && payload.tokenId);
      if (!token) return emitError(socket, 'Фишка не найдена');
      room.setTokenConditions(token, payload && payload.conditions, payload && payload.conditionDurations);
      markDirty();
      emitToken('tokenUpdated', token);
    });

    socket.on('setTokenHp', (payload) => {
      if (!requireDm(socket)) return;
      const token = findToken(payload && payload.tokenId);
      if (!token) return emitError(socket, 'Фишка не найдена');
      if (token.maxHp === null || token.maxHp === undefined) {
        return emitError(socket, `У фишки «${token.name}» нет прочности`);
      }
      room.setTokenHp(token, payload && payload.hp);
      markDirty();
      emitToken('tokenUpdated', token);
    });

    /**
     * Скрытие одной фишки. Правка только мастерская: скрытость решает, что
     * видно игроку, а значит, решать её должен тот, кто за столом видит всё.
     */
    socket.on('setTokenHidden', (payload) => {
      if (!requireDm(socket)) return;
      const token = findToken(payload && payload.tokenId);
      if (!token) return emitError(socket, 'Фишка не найдена');
      emitTokenVisibility(token, !(payload && payload.hidden === false));
      onLog(`Фишка «${token.name}» ${token.hidden ? 'скрыта от игроков' : 'показана игрокам'}`);
    });

    /** Показать или скрыть разом все фишки: конец подготовки или откат. */
    socket.on('setAllTokensHidden', (payload) => {
      if (!requireDm(socket)) return;
      const hidden = !(payload && payload.hidden === false);
      // Считаем реальное изменение, иначе playersUpdate и лог врут.
      let changed = 0;
      for (const token of room.tokens) {
        if (Boolean(token.hidden) === hidden) continue;
        changed += 1;
        emitTokenVisibility(token, hidden);
      }
      if (!changed) return;
      onLog(`Фишки на столе ${hidden ? 'скрыты от игроков' : 'показаны игрокам'} (${changed})`);
    });

    /**
     * Скрыть имя фишки от игроков.
     *
     * Фишка при этом остаётся видимой: скрывают не фишку, а подпись под ней.
     * Так выводиют загадочного NPC, чьё имя игроки узнавать не должны.
     * Правка только мастерская — по той же причине, что и скрытость самой
     * фишки: решает тот, кто видит всё.
     */
    socket.on('setTokenNameHidden', (payload) => {
      if (!requireDm(socket)) return;
      const token = findToken(payload && payload.tokenId);
      if (!token) return emitError(socket, 'Фишка не найдена');
      const hidden = !(payload && payload.hidden === false);
      if (Boolean(token.hideName) === hidden) return;
      token.hideName = hidden;
      markDirty();
      emitToken('tokenUpdated', token);
      onLog(`Имя фишки «${token.name}» ${hidden ? 'скрыто от игроков' : 'показано игрокам'}`);
    });

    /**
     * Скрыть подписи под фишкой у всех сразу: имя, хозяина и состояния.
     *
     * В отличие от скрытого имени это не тайна: подписи убираются с нагруженной
     * карты, где их слишком много, и убираются у всех, включая мастера.
     * Фишка остаётся на месте и двигается как обычно.
     */
    socket.on('setTokenLabelsHidden', (payload) => {
      if (!requireDm(socket)) return;
      const token = findToken(payload && payload.tokenId);
      if (!token) return emitError(socket, 'Фишка не найдена');
      const hidden = !(payload && payload.hidden === false);
      if (Boolean(token.hideLabels) === hidden) return;
      token.hideLabels = hidden;
      markDirty();
      emitToken('tokenUpdated', token);
      onLog(`Подписи фишки «${token.name}» ${hidden ? 'скрыты у всех' : 'показаны всем'}`);
    });

    socket.on('renameToken', (payload) => {
      if (!requireDm(socket)) return;
      const token = findToken(payload && payload.tokenId);
      if (!token) return emitError(socket, 'Фишка не найдена');
      const name = sanitizeName(payload && payload.name);
      if (!name) return emitError(socket, 'Имя фишки не может быть пустым');
      token.name = name;
      markDirty();
      emitToken('tokenUpdated', token);
    });

    socket.on('assignTokenToPlayer', (payload) => {
      if (!requireDm(socket)) return;
      const token = findToken(payload && payload.tokenId);
      if (!token) return emitError(socket, 'Фишка не найдена');
      const raw = payload && payload.playerId;
      if (raw === null || raw === undefined || raw === '') {
        token.assignedPlayerId = null;
      } else {
        const playerId = String(raw);
        if (!room.players.has(playerId)) return emitError(socket, 'Игрок не найден');
        token.assignedPlayerId = playerId;
      }
      markDirty();
      emitToken('tokenUpdated', token);
      broadcastPlayers();
    });

    socket.on('setTokenImage', async (payload) => {
      if (!requireJoined(socket)) return;
      const token = findToken(payload && payload.tokenId);
      if (!token) return emitError(socket, 'Фишка не найдена');
      const isDm = socket.data.role === ROLE_DM;
      if (!isDm && token.assignedPlayerId !== socket.data.playerId) {
        return emitError(socket, 'Можно менять изображение только своей фишки');
      }
      const decoded = decodeImage(payload && payload.image);
      if (decoded.error) return emitError(socket, decoded.error);
      try {
        const fileName = await store.saveImage(room.campaign.id, decoded.buffer, decoded.ext);
        token.imageUrl = `/files/${fileName}`;
        // Картинку поставили руками — она перестаёт быть аватаром игрока.
        // Иначе следующая смена портрета тихо затёрла бы то, что нарисовали
        // для этой фишки специально.
        token.avatarFromSheet = false;
        markDirty();
        emitToken('tokenUpdated', token);
      } catch (error) {
        emitError(socket, error && error.quota ? error.message : 'Не удалось сохранить изображение фишки');
        onLog(`Ошибка сохранения фишки: ${error.message}`);
      }
    });

    /**
     * Картинка сразу для всех фишек с одинаковым названием.
     *
     * При импорте из Foundry одно и то же существо встречается десятками
     * копий: «Кобольд», «Кобольд», «Кобольд». Ставить картинку по одной
     * бессмысленно, поэтому мастер назначает её сразу всем.
     */
    socket.on('setTokenGroupImage', async (payload) => {
      if (!requireDm(socket)) return;
      const wanted = sanitizeText(payload && payload.name, LIMITS.maxNameLength);
      if (!wanted) return emitError(socket, 'Не указано название группы');
      const decoded = decodeImage(payload && payload.image);
      if (decoded.error) return emitError(socket, decoded.error);
      // Сравниваем без регистра и лишних пробелов: «Кобольд » и «кобольд» —
      // это одна и та же группа, иначе половина копий осталась бы без картинки.
      const key = groupKey(wanted);
      const group = room.tokens.filter((token) => groupKey(token.name) === key);
      if (!group.length) return emitError(socket, 'Фишек с таким названием нет');
      try {
        const fileName = await store.saveImage(room.campaign.id, decoded.buffer, decoded.ext);
        const url = `/files/${fileName}`;
        for (const token of group) token.imageUrl = url;
        markDirty();
        // Одним событием, а не по одному на фишку: клиент на каждое событие
        // перерисовывает и карту, и список фишек, и весь справочник приключения.
        // На двухстах фишках одна заливка картинки превращалась бы в двести
        // полных перерисовок вместо одной.
        //
        // Мастеру уходит вся группа, игрокам — только видимая часть: заготовки
        // мастера они не знают и знать не должны.
        io.to('dm-sockets').emit('tokensUpdated', { tokens: group });
        const visible = group
          .filter((token) => room.isTokenVisibleToPlayers(token))
          .map((token) => room.tokenForViewer(token, false));
        if (visible.length) io.except('dm-sockets').emit('tokensUpdated', { tokens: visible });
        onLog(`Картинка «${wanted}» назначена фишкам: ${group.length} шт.`);
      } catch (error) {
        emitError(socket, error && error.quota ? error.message : 'Не получилось сохранить картинку');
        onLog(`Ошибка сохранения картинки: ${error.message}`);
      }
    });

    /**
     * Картинка сразу всем объектам приключения с одинаковым названием:
     * предметам и персонажам справочника. Правка только у мастера, потому что
     * справочник он и читает.
     */
    socket.on('setAdventureGroupImage', async (payload) => {
      if (!requireDm(socket)) return;
      if (!room.adventure) return emitError(socket, 'В кампании нет приключения');
      const section = payload && payload.section;
      if (section !== 'items' && section !== 'actors') {
        return emitError(socket, 'Картинку массово можно назначить только предметам и персонажам');
      }
      const wanted = sanitizeText(payload && payload.name, LIMITS.maxNameLength);
      if (!wanted) return emitError(socket, 'Не указано название группы');
      const decoded = decodeImage(payload && payload.image);
      if (decoded.error) return emitError(socket, decoded.error);
      const key = groupKey(wanted);
      const group = room.adventure[section].filter((entry) => groupKey(entry.name) === key);
      if (!group.length) return emitError(socket, 'В приключении нет объектов с таким названием');
      try {
        const fileName = await store.saveImage(room.campaign.id, decoded.buffer, decoded.ext);
        const url = `/files/${fileName}`;
        for (const entry of group) entry.image = url;
        markDirty();
        // Справочник приключения сервер отдаёт только мастеру: в журнале лежат
        // его заметки и заготовки, игрокам они не нужны.
        io.to('dm-sockets').emit('adventureUpdated', room.adventure);
        onLog(`Картинка «${wanted}» назначена в справочнике: ${group.length} шт.`);
      } catch (error) {
        emitError(socket, error && error.quota ? error.message : 'Не получилось сохранить картинку');
        onLog(`Ошибка сохранения картинки: ${error.message}`);
      }
    });

    socket.on('moveToken', (payload) => {
      if (!requireJoined(socket)) return;
      const token = findToken(payload && payload.tokenId);
      if (!token) return emitError(socket, 'Фишка не найдена');
      const isDm = socket.data.role === ROLE_DM;
      if (!isDm && token.assignedPlayerId !== socket.data.playerId) {
        return emitError(socket, 'Можно двигать только свою фишку');
      }
      // Состояние, отнимающее скорость, запрещает движение самому игроку, но
      // мастеру оставляет его: перетащить соперника, оглушить или поднять можно
      // и нужно, иначе состояние превратилось бы в запрет на игру.
      if (!isDm) {
        const blocker = room.moveBlocker(token);
        if (blocker) {
          return emitError(socket, `Фишка «${blocker.label.toLowerCase()}»: двигать её нельзя, пока состояние не снято`);
        }
      }
      const x = clampNumber(payload && payload.x, 0, 1, token.x);
      const y = clampNumber(payload && payload.y, 0, 1, token.y);
      if (x === token.x && y === token.y) return;
      token.x = x;
      token.y = y;
      markDirty();
      // Позиция меняется часто: рассылаем без истории и обновляем только это поле.
      // Заготовка мастера двигается молча: игрокам её координаты не нужны.
      emitToken('tokenMoved', token, { tokenId: token.id, x, y });
    });

    /**
     * Перенос фишки на карту, которую видят игроки.
     *
     * Мастер готовит карту и фишки на ней впрок, а в нужный момент переносит
     * участников на показанную карту. Фишка встаёт в центр: старые координаты
     * относятся к другой картинке и на новой ничего не значат.
     */
    socket.on('moveTokenToActiveMap', (payload) => {
      if (!requireDm(socket)) return;
      const token = findToken(payload && payload.tokenId);
      if (!token) return emitError(socket, 'Фишка не найдена');
      if (!room.activeMap || !room.activeMapId) {
        return emitError(socket, 'Сначала покажите карту игрокам');
      }
      if (!room.isMapPublished(room.activeMap, room.activeMapId)) {
        return emitError(socket, 'Эта карта ещё не показана игрокам');
      }
      if (token.mapType === room.activeMap
        && (!token.mapId || token.mapId === room.activeMapId)) {
        return emitError(socket, 'Фишка уже на этой карте');
      }
      token.mapType = room.activeMap;
      token.mapId = room.activeMapId;
      token.x = 0.5;
      token.y = 0.5;
      markDirty();
      // tokenCreated, а не tokenMoved: у игрока фишка появляется на другой
      // карте, и одного изменения координат ему мало. Обработчик заменяет
      // запись по id, поэтому дубля не будет.
      emitToken('tokenCreated', token);
      onLog(`ДМ перенёс фишку «${token.name}» на показанную карту`);
    });

    socket.on('deleteToken', (payload) => {
      if (!requireDm(socket)) return;
      const token = findToken(payload && payload.tokenId);
      if (!token) return emitError(socket, 'Фишка не найдена');
      room.tokens = room.tokens.filter((item) => item.id !== token.id);
      // Фишка исчезла с поля, значит её нет и в порядке боя: иначе в инициативе
      // остался бы призрак, которого никто не видит.
      if (room.dropInitiativeByRef(token.id)) {
        markDirty();
        emitInitiative();
      }
      markDirty();
      emitToken('tokenDeleted', token, { tokenId: token.id });
      broadcastPlayers();
    });

    /* ------------------------------------------------------------------ *
     * Порядок боя
     * ------------------------------------------------------------------ */

    /**
     * Порядок боя объявляет мастер, видят все. Поэтому рассылка идёт всем, и
     * игрок получает ровно то же, что мастер.
     */
    const emitInitiative = () => {
      io.emit('initiativeUpdated', room.initiative);
    };

    socket.on('initiativeAdd', (payload) => {
      if (!requireDm(socket)) return;
      const entry = room.addInitiativeEntry(payload);
      if (!entry) return emitError(socket, 'Такой участник боя уже есть в списке');
      markDirty();
      emitInitiative();
    });

    socket.on('initiativeRemove', (payload) => {
      if (!requireDm(socket)) return;
      if (!room.removeInitiativeEntry(payload && payload.id)) {
        return emitError(socket, 'Участник боя не найден');
      }
      markDirty();
      emitInitiative();
    });

    socket.on('initiativeRoll', (payload) => {
      if (!requireDm(socket)) return;
      if (!room.initiative.entries.length) return emitError(socket, 'Список боя пуст');
      // Модификатор инициативы игрока присылает мастер из его листа: сервер
      // производные значения листа не считает, а вторая копия расчёта
      // разошлась бы с клиентской.
      if (payload && payload.id) {
        const entry = room.initiative.entries.find((item) => item.id === String(payload.id));
        if (!entry) return emitError(socket, 'Участник боя не найден');
        if (Number.isFinite(Number(payload.modifier))) {
          entry.modifier = Math.max(
            INITIATIVE.minModifier,
            Math.min(INITIATIVE.maxModifier, Math.round(Number(payload.modifier)))
          );
        }
        room.rollInitiative((min, max) => crypto.randomInt(min, max + 1), entry.id);
      } else {
        room.rollInitiative((min, max) => crypto.randomInt(min, max + 1));
        // Бой начался: включаем режим боя, чтобы фишки пошли по клеткам. Именно
        // тут, а не по кнопке: порядок боя и есть объявление начала боя.
        if (room.combat && !room.combat.enabled) {
          room.combat.enabled = true;
          io.emit('combatMode', room.combat);
        }
      }
      markDirty();
      emitInitiative();
    });

    socket.on('initiativeSetTotal', (payload) => {
      if (!requireDm(socket)) return;
      const entry = room.initiative.entries.find((item) => item.id === String(payload && payload.id));
      if (!entry) return emitError(socket, 'Участник боя не найден');
      const total = Math.round(Number(payload && payload.total));
      if (!Number.isFinite(total)) return emitError(socket, 'Итог должен быть числом');
      entry.total = total;
      markDirty();
      emitInitiative();
    });

    socket.on('initiativeTurn', (payload) => {
      if (!requireDm(socket)) return;
      const before = room.initiative.turnId;
      if (!room.setInitiativeTurn(payload && payload.id)) {
        return emitError(socket, 'Участник боя не найден');
      }
      if (before !== room.initiative.turnId) {
        for (const token of room.tickConditionsForCurrentTurn()) emitToken('tokenUpdated', token);
      }
      markDirty();
      emitInitiative();
    });

    socket.on('initiativeStep', (payload) => {
      if (!requireDm(socket)) return;
      if (!room.stepInitiativeTurn(Number(payload && payload.dir))) {
        return emitError(socket, 'Список боя пуст');
      }
      for (const token of room.tickConditionsForCurrentTurn()) emitToken('tokenUpdated', token);
      markDirty();
      emitInitiative();
    });

    socket.on('initiativeReset', () => {
      if (!requireDm(socket)) return;
      room.resetInitiative();
      // Бой кончился или откатился: режим боя выключается вместе с порядком,
      // иначе фишки продолжали бы ходить по клеткам после конца боя. Об этом
      // пишем в журнал: иначе переключатель «Бой» выглядел бы сломанным — он
      // сам по себе не трогается, а режим уходит молча.
      if (room.combat && room.combat.enabled) {
        room.combat.enabled = false;
        io.emit('combatMode', room.combat);
        onLog('Порядок боя сброшен — режим боя выключен');
      }
      markDirty();
      emitInitiative();
    });

    /**
     * Режим боя: фишки ходят по клеткам, а не свободно.
     *
     * Переключает мастер, но сервер проверяет: порядок боя и режим боя должны
     * совпадать у всех, иначе один участник увидит ход по клеткам, а другой
     * перетаскивание.
     */
    socket.on('setCombatMode', (payload) => {
      if (!requireDm(socket)) return;
      const enabled = Boolean(payload && payload.enabled);
      if (room.combat.enabled === enabled) {
        // Значение уже такое: окно могло отстать (переподключилось и не знало,
        // что бой идёт). Отвечаем текущим состоянием, чтобы переключатель
        // встал на место, а не выглядел мёртвым.
        socket.emit('combatMode', room.combat);
        return;
      }
      room.combat.enabled = enabled;
      markDirty();
      io.emit('combatMode', room.combat);
      onLog(enabled ? 'Режим боя включён: ход по клеткам' : 'Режим боя выключен');
      // Объявление в чат: режим боя сам по себе меняет только надпись на
      // переключателе, и без объявления нажатие выглядит так, будто ничего не
      // произошло. Заодно по нему видно, дошло ли нажатие до сервера.
      const notice = {
        from: socket.data.name,
        playerId: socket.data.playerId,
        role: socket.data.role,
        text: enabled
          ? 'Режим боя включён: нажмите на фишку, потом на клетку — фишка пройдёт по клеткам'
          : 'Режим боя выключен: фишки снова можно перетаскивать',
        system: true,
        time: new Date().toISOString()
      };
      room.chatHistory.push(notice);
      if (room.chatHistory.length > LIMITS.maxChatHistory) {
        room.chatHistory = room.chatHistory.slice(-LIMITS.maxChatHistory);
      }
      io.emit('chatMessage', notice);
    });

    /* ------------------------------------------------------------------ *
     * Кубики
     * ------------------------------------------------------------------ */

socket.on('rollDice', (payload) => {
      if (!requireJoined(socket)) return;
      // Формулу разбирает общий модуль renderer/dice.js: им же считает бросок
      // тренировочный стол. Своей копии разбора здесь намеренно нет.
      const requested = payload && typeof payload.formula === 'string' && payload.formula.trim()
        ? payload.formula
        // Число граней принимаем для старых клиентов: так броски приходят из
        // сохранённой сессии и из тестов.
        : payload && Number.isFinite(Number(payload.sides))
          ? `d${Math.round(Number(payload.sides))}`
          : '';
      const parsed = dice.parseFormula(requested);
      if (!parsed.ok) return emitError(socket, parsed.error);

      // Тайный бросок умеет только мастер. Игрок может прислать что угодно в
      // поле hidden, но число увидят все: иначе «слепой» бросок игрока был бы
      // виден только ему самому.
      const hidden = socket.data.role === ROLE_DM && Boolean(payload && payload.hidden);

      // Кубик бросает сервер, а не клиент.
      const rolled = dice.rollFormula(parsed, (min, max) => crypto.randomInt(min, max + 1));
      const roll = {
        playerId: socket.data.playerId,
        playerName: socket.data.name,
        role: socket.data.role,
        ...rolled,
        hidden,
        time: new Date().toISOString()
      };
      room.diceHistory.push(roll);
      if (room.diceHistory.length > LIMITS.maxDiceHistory) {
        room.diceHistory = room.diceHistory.slice(-LIMITS.maxDiceHistory);
      }

      // Бросок попадает и в общий чат: так его видят все, включая тех,
      // кто подключится позже и получит историю чата со стола. Для тайного
      // броска строка собирается без числа, поэтому в истории чата его тоже
      // нет — утекать нечему.
      const announcement = {
        from: socket.data.name,
        playerId: socket.data.playerId,
        role: socket.data.role,
        // Аватар пишем в само сообщение, а не подтягиваем на отрисовке:
        // портрет мог смениться уже после броска, и в истории он должен
        // остаться тем, каким был в момент броска.
        avatar: room.players.get(socket.data.playerId)?.avatar
          || (socket.data.role === ROLE_DM ? DEFAULT_DM_AVATAR : null),
        text: dice.describeRoll(roll),
        isRoll: true,
        hidden,
        time: roll.time
      };
      room.chatHistory.push(announcement);
      if (room.chatHistory.length > LIMITS.maxChatHistory) {
        room.chatHistory = room.chatHistory.slice(-LIMITS.maxChatHistory);
      }

      markDirty();
      // Число тайного броска уходит только мастерам, игрокам достаётся тот же
      // бросок без результата: рассылать всем одно и то же нельзя.
      const forPlayers = dice.hideRollResult(roll);
      io.to('table').except('dm-sockets').emit('diceRollResult', forPlayers);
      io.to('dm-sockets').emit('diceRollResult', roll);
      io.emit('chatMessage', announcement);
    });

    /* ------------------------------------------------------------------ *
     * Чат
     * ------------------------------------------------------------------ */

    socket.on('chatMessage', (payload) => {
      if (!requireJoined(socket)) return;
      const text = sanitizeText(payload && payload.text, LIMITS.maxChatLength).trim();
      if (!text) return;
      const message = {
        from: socket.data.name,
        playerId: socket.data.playerId,
        role: socket.data.role,
        text,
        time: new Date().toISOString()
      };
      room.chatHistory.push(message);
      if (room.chatHistory.length > LIMITS.maxChatHistory) {
        room.chatHistory = room.chatHistory.slice(-LIMITS.maxChatHistory);
      }
      markDirty();
      io.emit('chatMessage', message);
    });

    socket.on('ping', (payload) => {
      socket.emit('pong', { time: Date.now(), echo: payload && payload.echo });
    });

    socket.on('disconnect', () => {
      const { role, playerId, name } = socket.data;
      if (!role || !playerId) return;
      const player = room.players.get(playerId);
      if (player) {
        room.detachSocket(playerId, socket.id);
      }
      markDirty();
      broadcastPlayers();
      onLog(`Отключился ${role === ROLE_DM ? 'ДМ' : 'игрок'} ${name}`);
    });
  });

  // Слушаем только 127.0.0.1. Игроки приходят по туннелю iroh, который
  // прокладывается прямо в этот порт, поэтому наружу сервер выставлять не
  // нужно: в локальной сети и в интернете он не виден вовсе.
  const port = await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(preferredPort, '127.0.0.1', () => {
      httpServer.removeListener('error', reject);
      resolve(httpServer.address().port);
    });
  }).catch(async () => {
    // Порт занят кем-то посторонним — просим ОС выдать любой свободный.
    const fallback = await findFreePort({ preferred: preferredPort + 1 });
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(fallback, '127.0.0.1', () => resolve(httpServer.address().port));
    });
  });

  return {
    port,
    localUrl: `http://127.0.0.1:${port}`,
    io,
    httpServer,
    /** Полная остановка сервера. Все сокеты закрываются. */
    close() {
      return new Promise((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(safety);
          resolve();
        };
        // Сначала рвём соединения принудительно. Иначе io.close() может ждать
        // вечно: если у участника пропала связь (закрыли ноутбук, убили
        // процесс), у сокета остаются неотправленные данные, события «drain»
        // не будет, и остановка стола просто зависнет.
        io.disconnectSockets(true);
        io.close(finish);
        // Страховка на случай, если что-то всё же не закрылось: лучше
        // остановиться с предупреждением, чем заморозить окно ДМа.
        const safety = setTimeout(() => {
          onLog('Сервер стола закрылся не сразу — соединения оборваны принудительно');
          try {
            httpServer.close();
          } catch { /* уже закрыт */ }
          finish();
        }, 5000);
      });
    }
  };
}

module.exports = { createTableServer, decodeImage, sniffImageFormat };
