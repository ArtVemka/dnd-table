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
  LIMITS,
  MAP_TYPES,
  ROLE_DM,
  ROLE_PLAYER,
  TOKEN_PALETTE,
  clampInt,
  clampNumber,
  newMapId,
  newTokenId,
  normalizeSheet,
  sanitizeText
} = require('./state');
const { findFreePort } = require('./net');
const { decodeImage, sniffImageFormat } = require('./image');

const PLAYER_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
/** Длина имени карты — та же, что при загрузке в состоянии стола. */
const MAP_NAME_MAX = 120;

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

  const broadcastPlayers = () => {
    io.emit('playersUpdate', room.playerList());
  };

  const broadcastMapUpdate = (type) => {
    const slot = room.maps[type];
    io.emit('mapUpdated', {
      type,
      items: slot ? slot.items : [],
      activeId: slot ? slot.activeId : null,
      activeMap: room.activeMap
    });
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
      io.emit('tokenUpdated', token);
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
        playerId = PLAYER_ID_PATTERN.test(requested) ? requested : `p-${crypto.randomUUID()}`;
        const player = room.addPlayer(playerId, name);
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
        you: { playerId, name, role },
        state: room.snapshotFor({ playerId, role })
      });
      respond({ ok: true, you: { playerId, name, role } });
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
        emitError(socket, 'Не получилось сохранить аватар');
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
        color: TOKEN_PALETTE[room.tokens.length % TOKEN_PALETTE.length]
      };
      room.tokens.push(token);
      markDirty();
      io.emit('tokenCreated', token);
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
          uploadedAt: new Date().toISOString()
        };
        slot.items.push(map);
        slot.activeId = map.id;
        room.activeMap = type;
        markDirty();
        broadcastMapUpdate(type);
        onLog(`ДМ загрузил карту (${type}), всего в вкладке: ${slot.items.length}`);
      } catch (error) {
        emitError(socket, 'Не удалось сохранить изображение карты');
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
      slot.activeId = mapId;
      // Переключили карту во вкладке — её и показываем игрокам.
      room.activeMap = type;
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

      slot.items.splice(index, 1);
      if (slot.activeId === requested) {
        // Показываем соседнюю карту вкладки, а если их больше нет — вкладка пуста.
        const neighbour = slot.items[index] || slot.items[index - 1] || null;
        slot.activeId = neighbour ? neighbour.id : null;
      }
      if (!slot.items.length && room.activeMap === type) {
        room.activeMap = MAP_TYPES.find((other) => other !== type && room.maps[other].items.length) || null;
      }
      markDirty();
      broadcastMapUpdate(type);
      onLog(`ДМ удалил карту (${type}), осталось: ${slot.items.length}`);
    });

    socket.on('setGrid', (payload) => {
      if (!requireDm(socket)) return;
      const data = payload && typeof payload === 'object' ? payload : {};
      const enabled = Boolean(data.enabled);
      const cell = clampInt(data.cell, GRID.minCell, GRID.maxCell, room.grid.cell);
      // columns — сколько клеток по ширине карты. По нему все участники стола
      // одинаково считают размер клетки, поэтому разошться не могут.
      const columns = clampInt(data.columns, 0, GRID.maxColumns, room.grid.columns || 0);
      if (room.grid.enabled === enabled && room.grid.cell === cell && room.grid.columns === columns) return;
      room.grid = { enabled, cell, columns };
      markDirty();
      // Сетка — дело мастера: её видят и двигают только он.
      io.emit('gridUpdated', room.grid);
    });

    socket.on('setActiveMap', (payload) => {
      if (!requireDm(socket)) return;
      const type = payload && payload.type;
      if (!MAP_TYPES.includes(type)) return emitError(socket, 'Неизвестный тип карты');
      if (!room.maps[type].items.length) return emitError(socket, 'В этой вкладке ещё нет карт');
      room.activeMap = type;
      markDirty();
      broadcastMapUpdate(type);
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
        color: TOKEN_PALETTE[room.tokens.length % TOKEN_PALETTE.length]
      };
      room.tokens.push(token);
      markDirty();
      io.emit('tokenCreated', token);
    });

    socket.on('renameToken', (payload) => {
      if (!requireDm(socket)) return;
      const token = findToken(payload && payload.tokenId);
      if (!token) return emitError(socket, 'Фишка не найдена');
      const name = sanitizeName(payload && payload.name);
      if (!name) return emitError(socket, 'Имя фишки не может быть пустым');
      token.name = name;
      markDirty();
      io.emit('tokenUpdated', token);
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
      io.emit('tokenUpdated', token);
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
        io.emit('tokenUpdated', token);
      } catch (error) {
        emitError(socket, 'Не удалось сохранить изображение фишки');
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
        // На двухстах фишках одна заливка картинки превращалась в двести
        // полных перерисовок вместо одной.
        io.emit('tokensUpdated', { tokens: group });
        onLog(`Картинка «${wanted}» назначена фишкам: ${group.length} шт.`);
      } catch (error) {
        emitError(socket, 'Не получилось сохранить картинку');
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
        io.emit('adventureUpdated', room.adventure);
        onLog(`Картинка «${wanted}» назначена в справочнике: ${group.length} шт.`);
      } catch (error) {
        emitError(socket, 'Не получилось сохранить картинку');
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
      const x = clampNumber(payload && payload.x, 0, 1, token.x);
      const y = clampNumber(payload && payload.y, 0, 1, token.y);
      if (x === token.x && y === token.y) return;
      token.x = x;
      token.y = y;
      markDirty();
      // Позиция меняется часто: рассылаем без истории и обновляем только это поле.
      io.emit('tokenMoved', { tokenId: token.id, x, y });
    });

    socket.on('deleteToken', (payload) => {
      if (!requireDm(socket)) return;
      const token = findToken(payload && payload.tokenId);
      if (!token) return emitError(socket, 'Фишка не найдена');
      room.tokens = room.tokens.filter((item) => item.id !== token.id);
      markDirty();
      io.emit('tokenDeleted', { tokenId: token.id });
      broadcastPlayers();
    });

    /* ------------------------------------------------------------------ *
     * Кубики
     * ------------------------------------------------------------------ */

    socket.on('rollDice', (payload) => {
      if (!requireJoined(socket)) return;
      const sides = Math.round(Number(payload && payload.sides));
      if (!Number.isFinite(sides) || sides < 1 || sides > 20) {
        return emitError(socket, 'Доступны кости от d1 до d20');
      }
      // Кубик бросает сервер, а не клиент.
      const result = sides === 1 ? 1 : crypto.randomInt(1, sides + 1);
      const roll = {
        playerId: socket.data.playerId,
        playerName: socket.data.name,
        sides,
        result,
        time: new Date().toISOString()
      };
      room.diceHistory.push(roll);
      if (room.diceHistory.length > LIMITS.maxDiceHistory) {
        room.diceHistory = room.diceHistory.slice(-LIMITS.maxDiceHistory);
      }

      // Бросок попадает и в общий чат: так его видят все, включая тех,
      // кто подключится позже и получит историю чата со стола.
      const announcement = {
        from: socket.data.name,
        playerId: socket.data.playerId,
        role: socket.data.role,
        // Аватар пишем в само сообщение, а не подтягиваем на отрисовке:
        // портрет мог смениться уже после броска, и в истории он должен
        // остаться тем, каким был в момент броска.
        avatar: room.players.get(socket.data.playerId)?.avatar
          || (socket.data.role === ROLE_DM ? DEFAULT_DM_AVATAR : null),
        text: `бросил d${sides}: ${result}`,
        isRoll: true,
        time: roll.time
      };
      room.chatHistory.push(announcement);
      if (room.chatHistory.length > LIMITS.maxChatHistory) {
        room.chatHistory = room.chatHistory.slice(-LIMITS.maxChatHistory);
      }

      markDirty();
      io.emit('diceRollResult', roll);
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
