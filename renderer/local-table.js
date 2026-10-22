'use strict';

/**
 * Тренировочный стол: то же, что server/socket.js, но внутри окна.
 *
 * Нужен, чтобы открыть стол без сети и без сервера — например, заранее
 * заполнить лист персонажа или проверить интерфейс. События и правила повторяют
 * настоящий сервер, поэтому renderer работает с этим столом точно так же, как с
 * сетевым: видно только разницу в подписях («без сети», «тренировка»).
 *
 * Здесь же живёт черновик листа персонажа: он лежит в localStorage и остаётся
 * после закрытия приложения — заготовку можно заполнить заранее и отправить на
 * настоящий стол при подключении.
 */

(function (global) {
  const DnD = global.DnD5e;

  const DRAFT_PREFIX = 'dnd-table.draftSheet.';
  /**
   * Палитра фишек та же, что в server/state.js: цвет — часть вида фишки, и
   * отличаться от настоящего стола он не должен.
   */
  const TOKEN_COLORS = ['#c96f4a', '#4a8fc9', '#6fb45f', '#b45fa0', '#c9a34a', '#5f7fb4', '#a05f5f', '#4ab4a0'];
  const MAX_CHAT_HISTORY = 300;
  const MAX_DICE_HISTORY = 200;
  const MAX_TOKENS = 200;
  const MAP_NAME_MAX = 120;
  const MAX_MAPS_PER_TYPE = 20;
  const IMAGE_PATTERN = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/i;

  function sanitizeText(value, maxLength) {
    if (value === null || value === undefined) return '';
    const text = String(value).replace(/\u0000/g, '');
    return text.length > maxLength ? text.slice(0, maxLength) : text;
  }

  function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.round(num)));
  }

  function clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  }

  /** Случайное целое в диапазоне включительно — вместо crypto.randomInt сервера. */
  function randomInt(min, max) {
    const range = max - min + 1;
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return min + (buffer[0] % range);
  }

  function newId(prefix) {
    return `${prefix}-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;
  }

  function emptyMaps() {
    const maps = {};
    for (const type of DnD.MAP_TYPES) maps[type] = { items: [], activeId: null };
    return maps;
  }

  function cloneSheet(sheet) {
    return JSON.parse(JSON.stringify(sheet));
  }

  /* ------------------------------------------------------------------ *
   * Черновик листа персонажа
   * ------------------------------------------------------------------ */

  /** @param {string} playerId */
  function draftKey(playerId) {
    return `${DRAFT_PREFIX}${playerId}`;
  }

  /** @param {string} playerId @returns {object|null} */
  function readDraft(playerId) {
    if (!playerId) return null;
    try {
      const raw = localStorage.getItem(draftKey(playerId));
      if (!raw) return null;
      const sheet = JSON.parse(raw);
      return sheet && typeof sheet === 'object' ? sheet : null;
    } catch {
      // Испорченный черновик не должен мешать играть: считаем, что его нет.
      return null;
    }
  }

  /** @param {string} playerId @param {object} sheet */
  function saveDraft(playerId, sheet) {
    if (!playerId) return false;
    try {
      localStorage.setItem(draftKey(playerId), JSON.stringify(sheet));
      return true;
    } catch {
      return false;
    }
  }

  /* --------------------------------------------------------------- библиотека */

  /**
   * Библиотека листов: сколько угодно персонажей на этом компьютере.
   *
   * Черновик выше — это один слот на игрока, и он нужен для отправки на стол.
   * Библиотека нужна для другого: игрок готовит персонажа заранее, без стола,
   * и потом выбирает, кого взять. Без неё на главном экране нечего было бы
   * выбирать, кроме единственного черновика.
   *
   * Листы лежат в localStorage рядом с черновиком: сервера у них нет, кампания
   * их не знает, и переносить их между компьютерами нечем. Это черновики, а не
   * архив персонажей.
   */
  const LIBRARY_KEY = 'dnd-table.sheetLibrary';
  const LIBRARY_VERSION = 1;
  /** Больше не держим: localStorage не резиновый, а двадцать героев — не сценарий. */
  const LIBRARY_MAX = 20;

  function readLibrary() {
    const empty = { version: LIBRARY_VERSION, sheets: [] };
    try {
      const raw = localStorage.getItem(LIBRARY_KEY);
      if (!raw) return empty;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sheets)) return empty;
      const sheets = parsed.sheets
        .filter((entry) => entry && typeof entry === 'object' && entry.sheet && typeof entry.sheet === 'object')
        .map((entry) => ({
          id: sanitizeText(entry.id, 40) || newLocalSheetId(),
          updatedAt: Number(entry.updatedAt) || 0,
          sheet: entry.sheet
        }));
      return { version: LIBRARY_VERSION, sheets };
    } catch {
      // Испорченная библиотека не должна мешать играть: считаем, что её нет.
      return empty;
    }
  }

  function writeLibrary(library) {
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
      return true;
    } catch {
      return false;
    }
  }

  function newLocalSheetId() {
    return `s-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
  }

  /**
   * Ключ, по которому лист опознаётся при автосохранении.
   *
   * Имя персонажа и класс: автосохранение приходит из редактора без указания,
   * какой именно лист правится, и по id там нечего взять. Два героя с именем
   * «Гость» и классом «Воин» сольются — но имена за этим и нужны, чтобы
   * различать героев в списке.
   * @param {object} sheet
   * @returns {string}
   */
  function sheetMatchKey(sheet) {
    const name = sanitizeText(sheet.characterName, 100).trim().toLowerCase();
    const klass = sanitizeText(sheet.charClass, 100).trim().toLowerCase();
    return `${name}::${klass}`;
  }

  /**
   * Краткий список листов для выбора на экране подключения.
   * @returns {{id: string, updatedAt: number, characterName: string,
   *   playerName: string, charClass: string, race: string, level: number}[]}
   */
  function listLocalSheets() {
    return readLibrary().sheets
      .map((entry) => ({
        id: entry.id,
        updatedAt: entry.updatedAt,
        characterName: sanitizeText(entry.sheet.characterName, 100).trim() || 'Без имени',
        playerName: sanitizeText(entry.sheet.playerName, 100).trim(),
        charClass: sanitizeText(entry.sheet.charClass, 100).trim(),
        race: sanitizeText(entry.sheet.race, 100).trim(),
        level: clampInt(entry.sheet.level, 1, 20, 1)
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** @param {string} id */
  function getLocalSheet(id) {
    const wanted = String(id || '');
    return readLibrary().sheets.find((entry) => entry.id === wanted) || null;
  }

  /**
   * Кладёт лист в библиотеку и возвращает его id.
   *
   * С id запись обновляется на месте, без id ищется по имени с классом.
   * Лишние записи вытесняются самыми старыми: сортировка по времени есть, но
   * обрезать всё равно надо, иначе localStorage переполнится и перестанет
   * хранить вообще всё, включая черновик.
   * @param {object} sheet
   * @param {string} [id]
   * @returns {string} id сохранённого листа.
   */
  function upsertLocalSheet(sheet, id) {
    const library = readLibrary();
    const now = Date.now();
    const entryId = id ? String(id) : newLocalSheetId();
    const key = sheetMatchKey(sheet);
    const index = id
      ? library.sheets.findIndex((entry) => entry.id === entryId)
      : library.sheets.findIndex((entry) => sheetMatchKey(entry.sheet) === key);
    const record = { id: entryId, updatedAt: now, sheet };
    if (index >= 0) library.sheets[index] = { ...library.sheets[index], ...record, id: entryId };
    else library.sheets.push(record);
    if (library.sheets.length > LIBRARY_MAX) {
      library.sheets.sort((a, b) => b.updatedAt - a.updatedAt);
      library.sheets = library.sheets.slice(0, LIBRARY_MAX);
    }
    writeLibrary(library);
    return entryId;
  }

  /** @param {string} id @returns {boolean} Был ли такой лист. */
  function deleteLocalSheet(id) {
    const wanted = String(id || '');
    const library = readLibrary();
    const before = library.sheets.length;
    library.sheets = library.sheets.filter((entry) => entry.id !== wanted);
    if (library.sheets.length === before) return false;
    writeLibrary(library);
    return true;
  }

  /**
   * Есть ли в листе хоть что-то, что человек вписал руками. Лист, который
   * заводит игроку сервер, отличается от пустого только именем игрока.
   * @param {object} sheet
   */
  function sheetHasContent(sheet) {
    if (!sheet || typeof sheet !== 'object') return false;
    const raw = /** @type {Record<string, any>} */ (sheet);

    for (const key of ['characterName', 'charClass', 'race', 'background', 'alignment']) {
      if (sanitizeText(raw[key], 100).trim()) return true;
    }
    for (const key of ['attacks', 'equipment', 'features', 'notes']) {
      if (sanitizeText(raw[key], 4000).trim()) return true;
    }
    if (clampInt(raw.level, 1, 20, 1) !== 1) return true;
    if (clampInt(raw.experience, 0, 9999999, 0) !== 0) return true;
    if (raw.proficiencyBonusManual !== null && raw.proficiencyBonusManual !== undefined) return true;
    if (clampInt(raw.hp, -999, 9999, 10) !== 10) return true;
    if (clampInt(raw.maxHp, 0, 9999, 10) !== 10) return true;
    if (clampInt(raw.tempHp, 0, 9999, 0) !== 0) return true;
    if (clampInt(raw.armorClass, 0, 99, 10) !== 10) return true;
    if (clampInt(raw.initiativeMisc, -20, 20, 0) !== 0) return true;
    if (clampInt(raw.speed, 0, 999, 30) !== 30) return true;
    if (sanitizeText(raw.hitDice, 20) && sanitizeText(raw.hitDice, 20) !== '1d8') return true;

    const abilities = raw.abilities && typeof raw.abilities === 'object' ? raw.abilities : {};
    for (const key of DnD.ABILITY_KEYS) {
      if (clampInt(abilities[key], 1, 30, 10) !== 10) return true;
    }
    for (const marks of [raw.saveProficiencies, raw.skillProficiencies, raw.skillExpertise]) {
      if (marks && typeof marks === 'object' && Object.values(marks).some(Boolean)) return true;
    }
    return false;
  }

  /**
   * Стоит ли предлагать отправить заготовку на стол: черновик заполнен, а на
   * столе у этого игрока лист ещё пуст. Так ничего не перезапишется молча.
   * @param {{draft: object|null, serverSheet: object|null}} input
   */
  function shouldOfferDraft(input) {
    const draft = input ? input.draft : null;
    const serverSheet = input ? input.serverSheet : null;
    if (!sheetHasContent(draft)) return false;
    return !sheetHasContent(serverSheet);
  }

  /**
   * Приводит лист к ожидаемому виду. Полная проверка остаётся за сервером,
   * здесь важно только одно: чтобы черновик в localStorage не превратился в
   * мусор и чтобы значения совпадали с тем, что записал бы сервер.
   * @param {unknown} input
   * @param {string} [fallbackPlayerName]
   */
  function normalizeSheet(input, fallbackPlayerName = '') {
    const sheet = DnD.createEmptySheet(fallbackPlayerName);
    if (!input || typeof input !== 'object') return sheet;
    const raw = /** @type {Record<string, any>} */ (input);

    sheet.playerName = sanitizeText(raw.playerName, DnD.LIMITS.maxNameLength) || fallbackPlayerName;
    sheet.characterName = sanitizeText(raw.characterName, DnD.LIMITS.maxNameLength);
    sheet.charClass = sanitizeText(raw.charClass, 60);
    sheet.race = sanitizeText(raw.race, 60);
    sheet.background = sanitizeText(raw.background, 60);
    sheet.alignment = sanitizeText(raw.alignment, 60);
    sheet.level = clampInt(raw.level, 1, 20, 1);
    sheet.experience = clampInt(raw.experience, 0, 9999999, 0);
    sheet.proficiencyBonusManual = raw.proficiencyBonusManual === null || raw.proficiencyBonusManual === undefined
      ? null
      : clampInt(raw.proficiencyBonusManual, 0, 12, 2);

    const abilities = raw.abilities && typeof raw.abilities === 'object' ? raw.abilities : {};
    for (const key of DnD.ABILITY_KEYS) {
      sheet.abilities[key] = clampInt(abilities[key], 1, 30, 10);
    }
    for (const key of DnD.ABILITY_KEYS) {
      sheet.saveProficiencies[key] = Boolean(raw.saveProficiencies && raw.saveProficiencies[key]);
    }
    for (const skill of DnD.SKILLS) {
      sheet.skillProficiencies[skill.key] = Boolean(raw.skillProficiencies && raw.skillProficiencies[skill.key]);
      // Компетентность имеет смысл только вместе с владением — как на сервере.
      sheet.skillExpertise[skill.key] = sheet.skillProficiencies[skill.key]
        && Boolean(raw.skillExpertise && raw.skillExpertise[skill.key]);
    }

    sheet.hp = clampInt(raw.hp, -999, 9999, 10);
    sheet.maxHp = clampInt(raw.maxHp, 0, 9999, 10);
    sheet.tempHp = clampInt(raw.tempHp, 0, 9999, 0);
    sheet.hitDice = sanitizeText(raw.hitDice, 20);
    sheet.hitDiceSpent = clampInt(raw.hitDiceSpent, 0, 20, 0);
    sheet.armorClass = clampInt(raw.armorClass, 0, 99, 10);
    sheet.initiativeMisc = clampInt(raw.initiativeMisc, -20, 20, 0);
    sheet.speed = clampInt(raw.speed, 0, 999, 30);
    for (const key of ['attacks', 'equipment', 'features', 'notes']) {
      sheet[key] = sanitizeText(raw[key], 4000);
    }
    return sheet;
  }

  /* ------------------------------------------------------------------ *
   * Стол
   * ------------------------------------------------------------------ */

  /**
   * Локальный стол с тем же набором событий, что у Socket.IO: `on`, `emit`,
   * `removeAllListeners`, `disconnect`. Регистрируется как обычный сокет,
   * поэтому контроллер интерфейса о подмене не знает.
   *
   * @param {{playerId?: string, name?: string}} options
   */
  function createLocalTable(options = {}) {
    const playerId = String(options.playerId || 'p-local');
    let playerName = sanitizeText(options.name, DnD.LIMITS.maxNameLength).trim() || 'Игрок';

    /** @type {Map<string, Set<Function>>} */
    const listeners = new Map();
    let closed = false;

    const state = {
      sheets: {},
      maps: emptyMaps(),
      activeMap: null,
      grid: {
        enabled: false,
        cell: DnD.GRID.defaultCell,
        columns: 0,
        feetPerCell: DnD.GRID.defaultFeetPerCell,
        offsetX: 0,
        offsetY: 0
      },
      tokens: [],
      /** Порядок боя. Тренировочный стол — тоже стол: порядок нужен и здесь. */
      initiative: { entries: [], turnId: null, round: 1 },
      diceHistory: [],
      chatHistory: [],
      /** Аватар игрока как data URL: сервера нет, файлы никто не сохраняет. */
      avatar: null,
      /** Заметки мастера об игроках. */
      dmNotes: {}
    };
    // Недоигранный черновик становится листом персонажа тренировочного стола.
    const draft = readDraft(playerId);
    if (draft) state.sheets[playerId] = normalizeSheet(draft, playerName);

    const playerList = () => [{
      playerId,
      name: playerName,
      role: 'player',
      // Портрета здесь нет и быть не может: сохранять файлы некуда, поэтому
      // тренировочный аватар живёт как data URL прямо в состоянии.
      avatar: state.avatar || null,
      online: true,
      // Заметка мастера: в тренировочном столе игрок один, но поле нужно,
      // чтобы список участников совпадал с настоящим столом.
      dmNote: state.dmNotes[playerId] || '',
      hasSheet: Boolean(state.sheets[playerId]),
      tokenId: (state.tokens.find((token) => token.assignedPlayerId === playerId) || {}).id || null
    }];

    /** Снимок состояния: копии, чтобы клиент не менял стол по ссылке. */
    const snapshot = () => ({
      campaign: { id: null, name: 'Проверка без сети', createdAt: null, updatedAt: null, version: null },
      players: playerList(),
      sheets: Object.fromEntries(Object.entries(state.sheets).map(([id, sheet]) => [id, cloneSheet(sheet)])),
      maps: state.maps,
      activeMap: state.activeMap,
      grid: state.grid,
      tokens: state.tokens.map((token) => ({ ...token })),
      initiative: {
        entries: state.initiative.entries.map((entry) => ({ ...entry })),
        turnId: state.initiative.turnId,
        round: state.initiative.round
      },
      diceHistory: state.diceHistory.slice(),
      chatHistory: state.chatHistory.slice()
    });

    const emitTo = (event, payload) => {
      const handlers = listeners.get(event);
      if (!handlers) return;
      for (const handler of [...handlers]) {
        try {
          handler(payload);
        } catch (error) {
          console.error(`local-table: обработчик «${event}» упал`, error);
        }
      }
    };

    const pushChat = (message) => {
      state.chatHistory.push(message);
      if (state.chatHistory.length > MAX_CHAT_HISTORY) {
        state.chatHistory = state.chatHistory.slice(-MAX_CHAT_HISTORY);
      }
      emitTo('chatMessage', message);
    };

    const findToken = (tokenId) => state.tokens.find((token) => token.id === String(tokenId || ''));

    /** Карта вкладки по id, иначе та, что сейчас открыта. */
    const findMap = (slot, mapId) => {
      if (!slot || !Array.isArray(slot.items) || !slot.items.length) return null;
      const wanted = String(mapId || '');
      return wanted
        ? slot.items.find((entry) => entry.id === wanted)
        : (slot.items.find((entry) => entry.id === slot.activeId) || slot.items[0]);
    };

    /**
     * Рассылает вкладку карт целиком.
     *
     * Отдельная функция, потому что смена карты, туман и освещение правятся
     * одинаково: правится карта, а уходит снимок вкладки. Семь копий одного
     * и того же блока разошлись бы при первом же новом поле карты.
     * @param {string} type
     */
    const pushMap = (type) => {
      const slot = state.maps[type];
      emitTo('mapUpdated', {
        type,
        items: (slot.items || []).map((entry) => ({ ...entry })),
        activeId: slot.activeId,
        activeMap: state.activeMap
      });
    };

    const cloneInitiative = () => ({
      entries: state.initiative.entries.map((entry) => ({ ...entry })),
      turnId: state.initiative.turnId,
      round: state.initiative.round
    });

    /** Уменьшает длительности состояний в начале хода, как настоящий стол. */
    const tickConditionsForTurn = () => {
      const entry = state.initiative.entries.find((item) => item.id === state.initiative.turnId);
      if (!entry) return;
      const tokenIds = new Set();
      if (entry.kind === 'token') tokenIds.add(entry.refId);
      else if (entry.kind === 'player') {
        for (const token of state.tokens) {
          if (token.assignedPlayerId === entry.refId) tokenIds.add(token.id);
        }
      }
      for (const token of state.tokens) {
        if (!tokenIds.has(token.id)) continue;
        const durations = token.conditionDurations && typeof token.conditionDurations === 'object'
          ? { ...token.conditionDurations }
          : {};
        let touched = false;
        for (const [id, rounds] of Object.entries(durations)) {
          const next = clampInt(rounds, 0, 99, 0) - 1;
          if (next <= 0) delete durations[id];
          else durations[id] = next;
          touched = true;
        }
        if (!touched) continue;
        token.conditions = (token.conditions || []).filter((condition) => durations[condition] > 0);
        token.conditionDurations = durations;
        emitTo('tokenUpdated', { ...token });
      }
    };

    const mapUpdated = (type) => {
      const slot = state.maps[type];
      emitTo('mapUpdated', {
        type,
        items: slot.items,
        activeId: slot.activeId,
        activeMap: state.activeMap
      });
    };

    const handlers = {
      joinRoom(payload, ack) {
        const you = { playerId, name: playerName, role: 'player' };
        // Как и настоящий стол, новому игроку заводим пустой лист персонажа.
        if (!state.sheets[playerId]) state.sheets[playerId] = normalizeSheet(null, playerName);
        emitTo('joined', { you, state: snapshot() });
        emitTo('playersUpdate', playerList());
        if (typeof ack === 'function') ack({ ok: true, you });
      },

      saveCharacterSheet(payload) {
        const sheet = normalizeSheet(payload.sheet, playerName);
        state.sheets[playerId] = sheet;
        // Черновик сохраняется сразу: лист, заполненный без стола, должен
        // дождаться подключения к настоящему столу.
        saveDraft(playerId, sheet);
        emitTo('characterSheetData', { playerId, sheet: cloneSheet(sheet) });
        emitTo('playersUpdate', playerList());
      },

      requestCharacterSheet(payload) {
        if (String(payload.playerId || '') !== playerId) {
          emitTo('errorMessage', { message: 'Можно смотреть только свой лист персонажа' });
          return;
        }
        const sheet = state.sheets[playerId];
        if (!sheet) {
          emitTo('errorMessage', { message: 'Лист персонажа не найден' });
          return;
        }
        emitTo('characterSheetData', { playerId, sheet: cloneSheet(sheet) });
      },

      uploadMap(payload) {
        const type = payload.type;
        if (!DnD.MAP_TYPES.includes(type)) {
          emitTo('errorMessage', { message: 'Неизвестный тип карты' });
          return;
        }
        const slot = state.maps[type];
        if (slot.items.length >= MAX_MAPS_PER_TYPE) {
          emitTo('errorMessage', { message: `В этой вкладке уже ${MAX_MAPS_PER_TYPE} карт — удалите лишние` });
          return;
        }
        if (typeof payload.image !== 'string' || !IMAGE_PATTERN.test(payload.image.trim())) {
          emitTo('errorMessage', { message: 'Поддерживаются только изображения PNG, JPG и WEBP' });
          return;
        }
        // Изображение остаётся прямо в состоянии (data URL): на диск в
        // тренировочном столе ничего не пишется, файлов кампании тут нет.
        const map = {
          id: newId('m'),
          url: payload.image.trim(),
          name: sanitizeText(payload.name, MAP_NAME_MAX).trim() || 'Карта',
          // Поверхность пустая, но поле есть: мазок рисуется сразу же.
          surface: { cells: {} },
          uploadedAt: new Date().toISOString()
        };
        slot.items.push(map);
        slot.activeId = map.id;
        state.activeMap = type;
        mapUpdated(type);
      },

      selectMap(payload) {
        const type = payload.type;
        if (!DnD.MAP_TYPES.includes(type)) {
          emitTo('errorMessage', { message: 'Неизвестный тип карты' });
          return;
        }
        const slot = state.maps[type];
        const mapId = String(payload.mapId || '');
        if (!slot.items.some((item) => item.id === mapId)) {
          emitTo('errorMessage', { message: 'Карта не найдена' });
          return;
        }
        slot.activeId = mapId;
        state.activeMap = type;
        mapUpdated(type);
      },

      deleteMap(payload) {
        const type = payload.type;
        if (!DnD.MAP_TYPES.includes(type)) {
          emitTo('errorMessage', { message: 'Неизвестный тип карты' });
          return;
        }
        const slot = state.maps[type];
        const requested = payload.mapId ? String(payload.mapId) : slot.activeId;
        const index = slot.items.findIndex((item) => item.id === requested);
        if (index < 0) {
          emitTo('errorMessage', { message: 'Карта не найдена' });
          return;
        }
        slot.items.splice(index, 1);
        if (slot.activeId === requested) {
          const neighbour = slot.items[index] || slot.items[index - 1] || null;
          slot.activeId = neighbour ? neighbour.id : null;
        }
        if (!slot.items.length && state.activeMap === type) {
          state.activeMap = DnD.MAP_TYPES.find((other) => other !== type && state.maps[other].items.length) || null;
        }
        mapUpdated(type);
      },

      /**
       * Туман войны в тренировочном столе.
       *
       * Здесь карту грузит и водит по ней игрок, поэтому роль считается его:
       * на настоящем столе туман открывает мастер, а тут один человек и он
       * же хозяин стола.
       */
      openMapFog(payload) {
        const slot = state.maps[payload && payload.type];
        const item = findMap(slot, payload && payload.mapId);
        if (!item) return;
        item.fogMask = DnD.openFogAt(item.fogMask, Number(payload.x), Number(payload.y), Number(payload.radius));
        emitTo('mapUpdated', {
          type: payload.type,
          items: slot.items.map((entry) => ({ ...entry })),
          activeId: slot.activeId,
          activeMap: state.activeMap
        });
      },

      /**
       * Смена своего имени: здесь игрок один, но список участников должен
       * вести себя так же, как за настоящим столом.
       */
      setPlayerName(payload) {
        const wanted = sanitizeText(payload && payload.name, DnD.LIMITS.maxNameLength).replace(/\s+/g, ' ').trim();
        if (!wanted) return;
        playerName = wanted;
        const sheet = state.sheets[playerId];
        if (sheet && sheet.playerName !== wanted) sheet.playerName = wanted;
        emitTo('playersUpdate', playerList());
      },

      setMapFog(payload) {
        const slot = state.maps[payload && payload.type];
        const item = findMap(slot, payload && payload.mapId);
        if (!item) return;
        item.fogMask = DnD.setFogWhole(item.fogMask, Boolean(payload.open));
        emitTo('mapUpdated', {
          type: payload.type,
          items: slot.items.map((entry) => ({ ...entry })),
          activeId: slot.activeId,
          activeMap: state.activeMap
        });
      },

      /**
       * Освещение на тренировочном столе.
       *
       * Смысл настоящий, а не заглушка: тренировочный стол нужен, чтобы
       * проверить, что стены держат свет, не поднимая стола. Работает всё,
       * кроме раздачи источников другим участникам, — их тут нет.
       */
      setMapDarkness(payload) {
        const item = findMap(state.maps[payload && payload.type], payload && payload.mapId);
        if (!item) return;
        const value = Number(payload.darkness);
        if (!Number.isFinite(value)) return;
        item.darkness = Math.max(0, Math.min(1, value));
        pushMap(payload.type);
      },

      addMapWall(payload) {
        const item = findMap(state.maps[payload && payload.type], payload && payload.mapId);
        if (!item) return;
        const wall = DnD.normalizeWall({
          id: payload.wallId || `local-${Date.now()}`,
          x1: payload.x1,
          y1: payload.y1,
          x2: payload.x2,
          y2: payload.y2
        });
        if (!wall) return;
        item.walls = DnD.normalizeWalls([...(item.walls || []), wall]);
        pushMap(payload.type);
      },

      deleteMapWall(payload) {
        const item = findMap(state.maps[payload && payload.type], payload && payload.mapId);
        if (!item) return;
        item.walls = DnD.normalizeWalls(item.walls).filter((wall) => wall.id !== payload.wallId);
        pushMap(payload.type);
      },

      clearMapWalls(payload) {
        const item = findMap(state.maps[payload && payload.type], payload && payload.mapId);
        if (!item) return;
        item.walls = [];
        pushMap(payload.type);
      },

      addMapLight(payload) {
        const item = findMap(state.maps[payload && payload.type], payload && payload.mapId);
        if (!item) return;
        const light = DnD.normalizeLight({
          id: payload.lightId || `local-${Date.now()}`,
          x: payload.x,
          y: payload.y,
          radius: payload.radius,
          color: payload.color
        });
        if (!light) return;
        item.lights = DnD.normalizeLights([...(item.lights || []), light]);
        pushMap(payload.type);
      },

      setMapLight(payload) {
        const item = findMap(state.maps[payload && payload.type], payload && payload.mapId);
        if (!item) return;
        item.lights = DnD.normalizeLights(item.lights).map((light) => (
          light.id === payload.lightId
            ? DnD.normalizeLight({
              id: light.id,
              x: payload.x !== undefined ? payload.x : light.x,
              y: payload.y !== undefined ? payload.y : light.y,
              radius: payload.radius !== undefined ? payload.radius : light.radius,
              color: payload.color !== undefined ? payload.color : light.color,
              dim: payload.dim !== undefined ? payload.dim : light.dim,
              hidden: payload.hidden !== undefined ? payload.hidden : light.hidden
            })
            : light
        ));
        pushMap(payload.type);
      },

      deleteMapLight(payload) {
        const item = findMap(state.maps[payload && payload.type], payload && payload.mapId);
        if (!item) return;
        item.lights = DnD.normalizeLights(item.lights).filter((light) => light.id !== payload.lightId);
        pushMap(payload.type);
      },

      setTokenLight(payload) {
        const token = findToken(payload && payload.tokenId);
        if (!token) return;
        const radius = Number(payload.radius);
        if (!Number.isFinite(radius) || radius < 0) return;
        const preset = DnD.LIGHT_PRESETS.find((item) => item.radius === Math.round(radius));
        token.light = {
          radius: Math.round(radius),
          color: typeof payload.color === 'string' ? payload.color : (preset ? preset.color : '#ffb347')
        };
        emitTo('tokenUpdated', { ...token });
      },

      /** Поверхность карты: мазок кладётся прямо в карту, как у настоящего стола. */
      paintMapSurface(payload) {
        const item = findMap(state.maps[payload && payload.type], payload && payload.mapId);
        if (!item || !Array.isArray(payload.cells)) return;
        item.surface = DnD.normalizeSurface(item.surface);
        item.surface.cells = { ...item.surface.cells };
        for (const entry of payload.cells.slice(0, 400)) {
          if (!Array.isArray(entry) || entry.length !== 3) continue;
          const col = Number(entry[0]);
          const row = Number(entry[1]);
          if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0) continue;
          const key = `${col},${row}`;
          const kind = entry[2] === null ? '' : String(entry[2]);
          if (kind && !DnD.SURFACE_IDS.has(kind)) continue;
          if (kind) item.surface.cells[key] = kind;
          else delete item.surface.cells[key];
        }
        pushMap(payload.type);
      },

      clearMapSurface(payload) {
        const item = findMap(state.maps[payload && payload.type], payload && payload.mapId);
        if (!item) return;
        item.surface = { cells: {} };
        pushMap(payload.type);
      },

      /** Режим боя в тренировочном столе: ход по клеткам включается на месте. */
      setCombatMode(payload) {
        state.combat = { enabled: Boolean(payload && payload.enabled) };
        emitTo('combatMode', { ...state.combat });
      },

      setActiveMap(payload) {
        const type = payload.type;
        if (!DnD.MAP_TYPES.includes(type)) {
          emitTo('errorMessage', { message: 'Неизвестный тип карты' });
          return;
        }
        if (!state.maps[type].items.length) {
          emitTo('errorMessage', { message: 'В этой вкладке ещё нет карт' });
          return;
        }
        state.activeMap = type;
        mapUpdated(type);
      },

      setGrid(payload) {
        // Те же пределы и те же поля, что у настоящего стола: тренировочный
        // стол не должен терять сдвиг и футы в клетке.
        const next = DnD.normalizeGrid(payload);
        const same = ['enabled', 'cell', 'columns', 'feetPerCell', 'offsetX', 'offsetY']
          .every((key) => state.grid[key] === next[key]);
        if (same) return;
        state.grid = next;
        emitTo('gridUpdated', state.grid);
      },

      createToken(payload) {
        if (state.tokens.length >= MAX_TOKENS) {
          emitTo('errorMessage', { message: 'Слишком много фишек на столе' });
          return;
        }
        const requested = payload.mapType;
        const mapType = DnD.MAP_TYPES.includes(requested)
          ? requested
          : (state.activeMap || DnD.MAP_TYPES[1]);
        const token = {
          id: newId('t'),
          name: sanitizeText(payload.name, DnD.LIMITS.maxNameLength).trim() || `Фишка ${state.tokens.length + 1}`,
          mapType,
          x: 0.5,
          y: 0.5,
          imageUrl: null,
          // В тренировочном столе ДМ нет: фишка сразу достаётся тому, кто её
          // создал, иначе проверить её было бы некому.
          assignedPlayerId: playerId,
          avatarFromSheet: false,
          // Скрывать некому: в тренировочном столе игрок один и он же мастер
          // за неимением лучшего. Поле держим, чтобы модель совпадала.
          hidden: false,
          color: TOKEN_COLORS[state.tokens.length % TOKEN_COLORS.length],
          size: DnD.clampNumber(payload.size, 1, 4, 1),
          // Прочность необязательна: пустое поле у формы — метка без здоровья.
          maxHp: Number(payload.maxHp) > 0 ? Math.min(9999, Math.round(Number(payload.maxHp))) : null,
          conditions: [],
          hideLabels: false
        };
        token.hp = token.maxHp;
        state.tokens.push(token);
        emitTo('tokenCreated', { ...token });
        emitTo('playersUpdate', playerList());
      },

      /**
       * Заметка мастера об игроке. В тренировочном столе игрок один и он же
       * мастер, так что заметка уходит ему же, как и на настоящем столе.
       */
      setDmNote(payload) {
        const player = playerList().find((item) => item.playerId === String(payload.playerId || ''));
        if (!player) return;
        state.dmNotes[player.playerId] = sanitizeText(payload.note, DnD.LIMITS.maxDmNote);
        emitTo('dmNoteUpdated', { playerId: player.playerId, note: state.dmNotes[player.playerId] });
        emitTo('playersUpdate', playerList());
      },

      setTokenConditions(payload) {
        const token = findToken(payload.tokenId);
        if (!token) {
          emitTo('errorMessage', { message: 'Фишка не найдена' });
          return;
        }
        // Тот же список правил, что и на настоящем столе: неизвестные
        // состояния отбрасываются, а не рисуются как призраки.
        const known = new Set(DnD.CONDITIONS.map((item) => item.id));
        const list = Array.isArray(payload.conditions) ? payload.conditions : [];
        token.conditions = [...new Set(list.filter((id) => known.has(id)))];
        token.conditionDurations = {};
        const rawDurations = payload.conditionDurations && typeof payload.conditionDurations === 'object'
          ? payload.conditionDurations
          : {};
        for (const id of token.conditions) {
          const rounds = clampInt(rawDurations[id], 0, 99, 0);
          if (rounds > 0) token.conditionDurations[id] = rounds;
        }
        emitTo('tokenUpdated', { ...token });
      },

      setTokenHp(payload) {
        const token = findToken(payload.tokenId);
        if (!token) {
          emitTo('errorMessage', { message: 'Фишка не найдена' });
          return;
        }
        if (token.maxHp === null || token.maxHp === undefined) {
          emitTo('errorMessage', { message: `У фишки «${token.name}» нет прочности` });
          return;
        }
        const value = Math.round(Number(payload.hp));
        if (!Number.isFinite(value)) {
          emitTo('errorMessage', { message: 'Прочность должна быть числом' });
          return;
        }
        token.hp = Math.max(0, Math.min(token.maxHp, value));
        emitTo('tokenUpdated', { ...token });
      },

      setTokenSize(payload) {
        const token = findToken(payload.tokenId);
        if (!token) {
          emitTo('errorMessage', { message: 'Фишка не найдена' });
          return;
        }
        token.size = DnD.clampNumber(payload.size, 1, 4, 1);
        emitTo('tokenUpdated', { ...token });
      },

      renameToken(payload) {
        const token = findToken(payload.tokenId);
        if (!token) {
          emitTo('errorMessage', { message: 'Фишка не найдена' });
          return;
        }
        const name = sanitizeText(payload.name, DnD.LIMITS.maxNameLength).trim();
        if (!name) {
          emitTo('errorMessage', { message: 'Имя фишки не может быть пустым' });
          return;
        }
        token.name = name;
        emitTo('tokenUpdated', { ...token });
      },

      assignTokenToPlayer() {
        emitTo('errorMessage', { message: 'В тренировочном столе некого назначать — игрок только вы' });
      },

      setTokenImage(payload) {
        const token = findToken(payload.tokenId);
        if (!token) {
          emitTo('errorMessage', { message: 'Фишка не найдена' });
          return;
        }
        if (token.assignedPlayerId !== playerId) {
          emitTo('errorMessage', { message: 'Можно менять изображение только своей фишки' });
          return;
        }
        if (typeof payload.image !== 'string' || !IMAGE_PATTERN.test(payload.image.trim())) {
          emitTo('errorMessage', { message: 'Поддерживаются только изображения PNG, JPG и WEBP' });
          return;
        }
        token.imageUrl = payload.image.trim();
        emitTo('tokenUpdated', { ...token });
      },

      /**
       * Скрытие в тренировочном столе не имеет смысла: скрывать не от кого,
       * мастера за столом нет, а интерфейс и не показывает эти кнопки игроку.
       * Событие нужно, чтобы набор интерфейса совпадал с настоящим столом.
       */
      setTokenHidden() {
        emitTo('errorMessage', { message: 'В тренировочном столе скрывать нечего — вы и есть мастер' });
      },

      setAllTokensHidden() {
        emitTo('errorMessage', { message: 'В тренировочном столе скрывать нечего — вы и есть мастер' });
      },

      /** Скрытие имени: здесь скрывать не от кого, поэтому только понятный отказ. */
      setTokenNameHidden() {
        emitTo('errorMessage', { message: 'В тренировочном столе скрывать нечего — вы и есть мастер' });
      },

      /**
       * Подписи в тренировочном столе убрать можно: мастер один, и если подписи
       * мешают на тестовой карте, он вправе их убрать.
       */
      setTokenLabelsHidden(payload) {
        const token = findToken(payload.tokenId);
        if (!token) {
          emitTo('errorMessage', { message: 'Фишка не найдена' });
          return;
        }
        token.hideLabels = !(payload.hidden === false);
        emitTo('tokenUpdated', token);
      },

      moveToken(payload) {
        const token = findToken(payload.tokenId);
        if (!token) {
          emitTo('errorMessage', { message: 'Фишка не найдена' });
          return;
        }        if (token.assignedPlayerId !== playerId) {
          emitTo('errorMessage', { message: 'Можно двигать только свою фишку' });
          return;
        }
        const x = clampNumber(payload.x, 0, 1, token.x);
        const y = clampNumber(payload.y, 0, 1, token.y);
        if (x === token.x && y === token.y) return;
        token.x = x;
        token.y = y;
        emitTo('tokenMoved', { tokenId: token.id, x, y });
      },

      deleteToken(payload) {
        const token = findToken(payload.tokenId);
        if (!token) {
          emitTo('errorMessage', { message: 'Фишка не найдена' });
          return;
        }
        if (token.assignedPlayerId !== playerId) {
          emitTo('errorMessage', { message: 'Можно удалить только свою фишку' });
          return;
        }
        state.tokens = state.tokens.filter((item) => item.id !== token.id);
        emitTo('tokenDeleted', { tokenId: token.id });
        emitTo('playersUpdate', playerList());
      },

      /* ------------------------------------------------------ порядок боя */

      initiativeAdd(payload) {
        const raw = payload || {};
        const kind = ['player', 'token', 'other'].includes(raw.kind) ? raw.kind : 'other';
        const refId = kind === 'other' ? '' : String(raw.refId || '');
        if ((kind === 'player' || kind === 'token') && !refId) return;
        if (state.initiative.entries.some((entry) => entry.refId && entry.refId === refId)) return;
        const modifier = Math.round(Number(raw.modifier));
        state.initiative.entries.push({
          id: `i-local-${state.initiative.entries.length + 1}-${Date.now()}`,
          kind,
          refId,
          name: sanitizeText(raw.name, DnD.LIMITS.maxNameLength) || 'Участник',
          modifier: Number.isFinite(modifier) ? Math.max(-20, Math.min(20, modifier)) : 0,
          total: null
        });
        emitTo('initiativeUpdated', cloneInitiative());
      },

      initiativeRemove(payload) {
        const id = String((payload && payload.id) || '');
        const index = state.initiative.entries.findIndex((entry) => entry.id === id);
        if (index < 0) return;
        state.initiative.entries.splice(index, 1);
        if (state.initiative.turnId === id) {
          const next = state.initiative.entries[index] || state.initiative.entries[index - 1];
          state.initiative.turnId = next ? next.id : null;
        }
        emitTo('initiativeUpdated', cloneInitiative());
      },

      initiativeRoll(payload) {
        if (!state.initiative.entries.length) return;
        const onlyId = payload && payload.id ? String(payload.id) : null;
        for (const entry of state.initiative.entries) {
          if (onlyId && entry.id !== onlyId) continue;
          entry.roll = randomInt(1, 20);
          entry.total = entry.roll + entry.modifier;
        }
        const order = new Map(state.initiative.entries.map((entry, index) => [entry.id, index]));
        state.initiative.entries.sort((a, b) => {
          if ((b.total ?? -Infinity) !== (a.total ?? -Infinity)) return (b.total ?? -Infinity) - (a.total ?? -Infinity);
          if (b.modifier !== a.modifier) return b.modifier - a.modifier;
          return order.get(a.id) - order.get(b.id);
        });
        if (!onlyId) {
          state.initiative.round = 1;
          state.initiative.turnId = state.initiative.entries[0].id;
        }
        emitTo('initiativeUpdated', cloneInitiative());
      },

      initiativeTurn(payload) {
        const id = String((payload && payload.id) || '');
        if (!state.initiative.entries.some((entry) => entry.id === id)) return;
        if (state.initiative.turnId === id) return;
        state.initiative.turnId = id;
        tickConditionsForTurn();
        emitTo('initiativeUpdated', cloneInitiative());
      },

      initiativeStep(payload) {
        const entries = state.initiative.entries;
        if (!entries.length) return;
        const dir = Number(payload && payload.dir) >= 0 ? 1 : -1;
        const current = entries.findIndex((entry) => entry.id === state.initiative.turnId);
        if (current < 0) state.initiative.turnId = entries[0].id;
        else if (dir > 0) {
          const next = current + 1;
          if (next >= entries.length) {
            state.initiative.turnId = entries[0].id;
            state.initiative.round += 1;
          } else state.initiative.turnId = entries[next].id;
        } else {
          state.initiative.turnId = entries[current - 1] || entries[0].id;
        }
        tickConditionsForTurn();
        emitTo('initiativeUpdated', cloneInitiative());
      },

      initiativeReset() {
        state.initiative = { entries: [], turnId: null, round: 1 };
        emitTo('initiativeUpdated', cloneInitiative());
      },

      /**
       * Спасбросок смерти по правилам 5e: десятка и выше — успех, единица —
       * две неудачи, двадцатка поднимает с одного хита. Бросает «сервер», то
       * есть здесь сам стол, иначе игрок подкрутил бы и число, и счётчик.
       */
      rollDeathSave() {
        const sheet = state.sheets[playerId];
        if (!sheet) {
          emitTo('errorMessage', { message: 'Лист персонажа ещё не готов' });
          return;
        }
        if (sheet.hp > 0) {
          emitTo('errorMessage', { message: 'Спасброски смерти идут при нулевом здоровье' });
          return;
        }
        const die = randomInt(1, 20);
        let outcome;
        if (die === 20) {
          sheet.hp = 1;
          sheet.deathSavesSuccesses = 0;
          sheet.deathSavesFailures = 0;
          outcome = 'персонаж приходит в себя';
        } else if (die === 1) {
          sheet.deathSavesFailures = Math.min(DnD.LIMITS.maxDeathSaves, sheet.deathSavesFailures + 2);
          outcome = 'две неудачи разом';
        } else if (die >= 10) {
          sheet.deathSavesSuccesses = Math.min(DnD.LIMITS.maxDeathSaves, sheet.deathSavesSuccesses + 1);
          outcome = 'успех';
        } else {
          sheet.deathSavesFailures = Math.min(DnD.LIMITS.maxDeathSaves, sheet.deathSavesFailures + 1);
          outcome = 'неудача';
        }
        emitTo('characterSheetData', { playerId, sheet: cloneSheet(sheet) });
        const time = new Date().toISOString();
        const roll = {
          playerId,
          playerName,
          role: 'player',
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
          time
        };
        state.diceHistory.push(roll);
        emitTo('diceRollResult', roll);
        pushChat({
          from: playerName,
          playerId,
          role: 'player',
          avatar: state.avatar || null,
          text: `спасбросок смерти: d20 ${die} — ${outcome}`,
          isRoll: true,
          time
        });
      },

      resetDeathSaves() {
        const sheet = state.sheets[playerId];
        if (!sheet) {
          emitTo('errorMessage', { message: 'Лист персонажа ещё не готов' });
          return;
        }
        sheet.deathSavesSuccesses = 0;
        sheet.deathSavesFailures = 0;
        emitTo('characterSheetData', { playerId, sheet: cloneSheet(sheet) });
      },

      rollDice(payload) {
        // Формулу разбирает тот же модуль, что и сервер, иначе тренировочный
        // стол считал бы «4d6dl1» не так, как настоящий.
        const requested = typeof payload.formula === 'string' && payload.formula.trim()
          ? payload.formula
          : Number.isFinite(Number(payload.sides))
            ? `d${Math.round(Number(payload.sides))}`
            : '';
        const parsed = DnDDice.parseFormula(requested);
        if (!parsed.ok) {
          emitTo('errorMessage', { message: parsed.error });
          return;
        }
        // Кубик, как и на настоящем столе, бросает «сервер», а не клиент.
        const rolled = DnDDice.rollFormula(parsed, randomInt);
        const time = new Date().toISOString();
        const roll = { playerId, playerName, ...rolled, hidden: false, time };
        state.diceHistory.push(roll);
        if (state.diceHistory.length > MAX_DICE_HISTORY) {
          state.diceHistory = state.diceHistory.slice(-MAX_DICE_HISTORY);
        }
        emitTo('diceRollResult', roll);
        pushChat({
          from: playerName,
          playerId,
          role: 'player',
          avatar: state.avatar || null,
          text: DnDDice.describeRoll(roll),
          isRoll: true,
          time
        });
      },

      setAvatar(payload) {
        // Файлы сохранять некуда, поэтому портрет остаётся прямо в состоянии
        // как data URL. Настоящий стол кладёт его в папку кампании.
        const image = payload && payload.image;
        state.avatar = image || null;
        // Фишка из листа носит портрет игрока, как и на настоящем столе.
        for (const token of state.tokens) {
          if (!token.avatarFromSheet) continue;
          token.imageUrl = state.avatar;
          emitTo('tokenUpdated', { ...token });
        }
        emitTo('playersUpdate', playerList());
      },

      createTokenFromSheet() {
        emitTo('errorMessage', {
          message: 'В тренировочном столе ДМ нет — фишка из листа выводит только мастер'
        });
      },

      chatMessage(payload) {
        const message = sanitizeText(payload.text, DnD.LIMITS.maxChatLength).trim();
        if (!message) return;
        pushChat({
          from: playerName,
          playerId,
          role: 'player',
          text: message,
          time: new Date().toISOString()
        });
      }
    };

    const api = {
      /** @param {string} event @param {Function} handler */
      on(event, handler) {
        if (typeof handler !== 'function') return api;
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(handler);
        return api;
      },
      /**
       * @param {string} event
       * @param {...any} args полезная нагрузка и, как в Socket.IO, необязательный
       *   ответ-подтверждение последним аргументом
       */
      emit(event, ...args) {
        if (closed) return;
        const handler = handlers[event];
        if (!handler) {
          emitTo('errorMessage', { message: 'В тренировочном столе это действие недоступно' });
          return;
        }
        const ack = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
        const payload = args.find((arg) => arg && typeof arg === 'object') || {};
        handler(payload, ack);
      },
      removeAllListeners() {
        listeners.clear();
      },
      disconnect() {
        closed = true;
        listeners.clear();
        global.removeEventListener('storage', onStorage);
      }
    };

    // Тренировочный лист можно открыть в двух окнах (кнопка «Отдельным окном»).
    // Сервера, который свёл бы их, нет — общий у них только черновик в
    // хранилище, поэтому правки из другого окна приходят событием storage.
    // Окно, которое писало само, события не получает: цикла не будет.
    const onStorage = (event) => {
      if (event.key !== draftKey(playerId) || typeof event.newValue !== 'string') return;
      try {
        const sheet = normalizeSheet(JSON.parse(event.newValue), playerName);
        state.sheets[playerId] = sheet;
        emitTo('characterSheetData', { playerId, sheet: cloneSheet(sheet) });
      } catch {
        // Испорченное значение в хранилище не должно ронять стол.
      }
    };
    global.addEventListener('storage', onStorage);

    // Подключение приходит следующим шагом цикла событий: к этому моменту
    // контроллер уже подписался на все события (как это было бы с сетью).
    setTimeout(() => {
      if (!closed) emitTo('connect');
    }, 0);

    return api;
  }

  global.LocalTable = {
    createLocalTable,
    deleteLocalSheet,
    draftKey,
    getLocalSheet,
    listLocalSheets,
    normalizeSheet,
    readDraft,
    saveDraft,
    sheetHasContent,
    shouldOfferDraft,
    upsertLocalSheet
  };
})(window);
