'use strict';

/**
 * Состояние стола (комнаты). Живёт в main-процессе Electron, является
 * авторитетным источником истины: клиенты только предлагают изменения,
 * сервер их проверяет и рассылает результат всем.
 *
 * Здесь же — разделяемые константы, правила D&D 5e (2014) для нормализации
 * листа персонажа и лимиты безопасности.
 */

const crypto = require('crypto');

const CAMPAIGN_FORMAT_VERSION = 2;

const LIMITS = {
  maxNameLength: 40,
  maxChatLength: 1000,
  maxSheetTextLength: 4000,
  maxImageBytes: 10 * 1024 * 1024, // 10 МБ
  maxDiceHistory: 200,
  maxChatHistory: 300,
  maxTokens: 200,
  maxLevel: 20,
  minAbility: 1,
  maxAbility: 30,
  /** Сколько карт можно держать в одной вкладке (общая / локация / рисунок). */
  maxMapsPerType: 20,
  /** Импортированное приключение: сколько записей каждого вида. */
  maxAdventureNotes: 300,
  maxAdventureItems: 500,
  maxAdventureTables: 200,
  maxAdventureActors: 200,
  maxAdventureTitle: 120,
  maxAdventureText: 20000,
  // Ссылка на картинку: /files/<имя> или путь из архива импорта.
  maxAdventureImageRef: 2048
};

const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

const ABILITY_LABELS = {
  str: 'Сила',
  dex: 'Ловкость',
  con: 'Телосложение',
  int: 'Интеллект',
  wis: 'Мудрость',
  cha: 'Харизма'
};

/** 18 навыков D&D 5e 2014 и их базовая характеристика. */
const SKILLS = [
  { key: 'acrobatics', label: 'Акробатика', ability: 'dex' },
  { key: 'animalHandling', label: 'Уход за животными', ability: 'wis' },
  { key: 'arcana', label: 'Магия', ability: 'int' },
  { key: 'athletics', label: 'Атлетика', ability: 'str' },
  { key: 'deception', label: 'Обман', ability: 'cha' },
  { key: 'history', label: 'История', ability: 'int' },
  { key: 'insight', label: 'Проницательность', ability: 'wis' },
  { key: 'intimidation', label: 'Запугивание', ability: 'cha' },
  { key: 'investigation', label: 'Анализ', ability: 'int' },
  { key: 'medicine', label: 'Медицина', ability: 'wis' },
  { key: 'nature', label: 'Природа', ability: 'int' },
  { key: 'perception', label: 'Внимательность', ability: 'wis' },
  { key: 'performance', label: 'Выступление', ability: 'cha' },
  { key: 'persuasion', label: 'Убеждение', ability: 'cha' },
  { key: 'religion', label: 'Религия', ability: 'int' },
  { key: 'sleightOfHand', label: 'Ловкость рук', ability: 'dex' },
  { key: 'stealth', label: 'Скрытность', ability: 'dex' },
  { key: 'survival', label: 'Выживание', ability: 'wis' }
];

const MAP_TYPES = ['world', 'battle', 'sketch'];
/**
 * Карты хранятся по вкладкам: в каждой вкладке свой список картинок и id той,
 * что показывается сейчас. Так во вкладке «Карта локации» может лежать сколько
 * угодно локаций, и ДМ переключается между ними, ничего не теряя.
 */
const MAP_NAME_MAX = 120;

function emptyMaps() {
  const maps = {};
  for (const type of MAP_TYPES) maps[type] = { items: [], activeId: null };
  return maps;
}
/**
 * Сетка на карте. Ячейка ровно по размеру фишки, поэтому размер задаётся в
 * пикселях и хранится вместе с состоянием стола: у всех участников сетка и
 * фишки одного размера.
 */
const GRID = {
  minCell: 8,
  // Потолок поднят: клетка теперь может считаться от размера карты, и у большой
  // карты на двадцать клеток она выходит больше прежних 120 пикселей.
  maxCell: 512,
  defaultCell: 46,
  minColumns: 2,
  maxColumns: 200
};
const ROLE_DM = 'dm';
const ROLE_PLAYER = 'player';
const DM_PLAYER_ID = 'dm';

/**
 * Модификатор характеристики по правилам D&D 5e 2014:
 * modifier = floor((score - 10) / 2)
 * @param {number} score
 * @returns {number}
 */
function abilityModifier(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return 0;
  return Math.floor((value - 10) / 2);
}

/**
 * Бонус мастерства по уровню персонажа (D&D 5e 2014):
 * ур. 1-4 -> +2, 5-8 -> +3, 9-12 -> +4, 13-16 -> +5, 17-20 -> +6
 * @param {number} level
 * @returns {number}
 */
function proficiencyBonus(level) {
  const lvl = clampInt(level, 1, LIMITS.maxLevel, 1);
  return 2 + Math.floor((lvl - 1) / 4);
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

function emptyProficiencyMap(keys) {
  const map = {};
  for (const key of keys) map[key] = false;
  return map;
}

/**
 * Пустой лист персонажа по D&D 5e 2014.
 * @param {string} [playerName]
 * @returns {object}
 */
function createEmptySheet(playerName = '') {
  return {
    playerName,
    characterName: '',
    charClass: '',
    race: '',
    background: '',
    alignment: '',
    level: 1,
    experience: 0,
    /** null — считать бонус мастерства автоматически от уровня */
    proficiencyBonusManual: null,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    saveProficiencies: emptyProficiencyMap(ABILITY_KEYS),
    skillProficiencies: emptyProficiencyMap(SKILLS.map((s) => s.key)),
    skillExpertise: emptyProficiencyMap(SKILLS.map((s) => s.key)),
    hp: 10,
    maxHp: 10,
    tempHp: 0,
    hitDice: '1d8',
    armorClass: 10,
    /** Прочие бонусы к инициативе поверх модификатора Ловкости */
    initiativeMisc: 0,
    speed: 30,
    attacks: '',
    equipment: '',
    features: '',
    notes: ''
  };
}

function sanitizeText(value, maxLength) {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\u0000/g, '');
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/**
 * Приводит импортированное приключение к виду, который безопасно отдать
 * интерфейсу. Всё прогоняется через те же ограничения, что и остальной
 * текст: неизвестные поля не сохраняются, длинные строки обрезаются.
 *
 * Старые кампании формата 1 секции adventure не содержат — для них возвращается
 * null, миграция данных при этом не нужна.
 * @param {unknown} input
 * @returns {object|null}
 */
function normalizeAdventure(input) {
  if (!input || typeof input !== 'object') return null;
  const raw = /** @type {Record<string, any>} */ (input);
  const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);

  return {
    id: String(raw.id || ''),
    name: sanitizeText(raw.name, LIMITS.maxAdventureTitle) || 'Приключение',
    source: sanitizeText(raw.source, 40) || 'неизвестно',
    importedAt: raw.importedAt || new Date().toISOString(),
    notes: list(raw.notes, LIMITS.maxAdventureNotes).map((item, index) => ({
      id: String((item && item.id) || `note-${index}`),
      title: sanitizeText(item && item.title, LIMITS.maxAdventureTitle) || 'Заметка',
      text: sanitizeText(item && item.text, LIMITS.maxAdventureText),
      sourceId: String((item && item.sourceId) || '')
    })),
    items: list(raw.items, LIMITS.maxAdventureItems).map((item, index) => ({
      id: String((item && item.id) || `item-${index}`),
      name: sanitizeText(item && item.name, LIMITS.maxAdventureTitle) || 'Предмет',
      type: sanitizeText(item && item.type, 60),
      sourceId: String((item && item.sourceId) || '')
    })),
    tables: list(raw.tables, LIMITS.maxAdventureTables).map((item, index) => ({
      id: String((item && item.id) || `table-${index}`),
      name: sanitizeText(item && item.name, LIMITS.maxAdventureTitle) || 'Таблица',
      formula: sanitizeText(item && item.formula, 200),
      description: sanitizeText(item && item.description, LIMITS.maxAdventureText),
      sourceId: String((item && item.sourceId) || '')
    })),
    actors: list(raw.actors, LIMITS.maxAdventureActors).map((item, index) => ({
      id: String((item && item.id) || `actor-${index}`),
      name: sanitizeText(item && item.name, LIMITS.maxAdventureTitle) || 'Персонаж',
      // Картинки импорта — это ссылки вида /files/<имя>. Не строка сюда не попадает:
      // приводить 42 к «42» зачем, а вот тихо испорченная ссылка мешает потом.
      image: typeof item?.image === 'string' ? sanitizeText(item.image, LIMITS.maxAdventureImageRef) : '',
      sourceId: String((item && item.sourceId) || '')
    }))
  };
}

/**
 * Приводит произвольный объект листа к валидной структуре D&D 5e 2014.
 * Всё, что не проходит проверку, заменяется значением по умолчанию.
 * @param {unknown} input
 * @param {string} [fallbackPlayerName]
 * @returns {object}
 */
function normalizeSheet(input, fallbackPlayerName = '') {
  const sheet = createEmptySheet(fallbackPlayerName);
  if (!input || typeof input !== 'object') return sheet;
  const raw = /** @type {Record<string, any>} */ (input);

  sheet.playerName = sanitizeText(raw.playerName, LIMITS.maxNameLength) || fallbackPlayerName;
  sheet.characterName = sanitizeText(raw.characterName, LIMITS.maxNameLength);
  sheet.charClass = sanitizeText(raw.charClass, 60);
  sheet.race = sanitizeText(raw.race, 60);
  sheet.background = sanitizeText(raw.background, 60);
  sheet.alignment = sanitizeText(raw.alignment, 60);
  sheet.level = clampInt(raw.level, 1, LIMITS.maxLevel, 1);
  sheet.experience = clampInt(raw.experience, 0, 9999999, 0);
  sheet.proficiencyBonusManual = raw.proficiencyBonusManual === null || raw.proficiencyBonusManual === undefined
    ? null
    : clampInt(raw.proficiencyBonusManual, 0, 12, 2);

  if (raw.abilities && typeof raw.abilities === 'object') {
    for (const key of ABILITY_KEYS) {
      sheet.abilities[key] = clampInt(raw.abilities[key], LIMITS.minAbility, LIMITS.maxAbility, 10);
    }
  }

  for (const key of ABILITY_KEYS) {
    if (raw.saveProficiencies) sheet.saveProficiencies[key] = Boolean(raw.saveProficiencies[key]);
  }
  for (const skill of SKILLS) {
    if (raw.skillProficiencies) sheet.skillProficiencies[skill.key] = Boolean(raw.skillProficiencies[skill.key]);
    if (raw.skillExpertise) sheet.skillExpertise[skill.key] = Boolean(raw.skillExpertise[skill.key]);
    // Компетентность (expertise) имеет смысл только вместе с владением.
    if (!sheet.skillProficiencies[skill.key]) sheet.skillExpertise[skill.key] = false;
  }

  sheet.hp = clampInt(raw.hp, -999, 9999, 10);
  sheet.maxHp = clampInt(raw.maxHp, 0, 9999, 10);
  sheet.tempHp = clampInt(raw.tempHp, 0, 9999, 0);
  sheet.hitDice = sanitizeText(raw.hitDice, 20);
  sheet.armorClass = clampInt(raw.armorClass, 0, 99, 10);
  sheet.initiativeMisc = clampInt(raw.initiativeMisc, -20, 20, 0);
  sheet.speed = clampInt(raw.speed, 0, 999, 30);

  sheet.attacks = sanitizeText(raw.attacks, LIMITS.maxSheetTextLength);
  sheet.equipment = sanitizeText(raw.equipment, LIMITS.maxSheetTextLength);
  sheet.features = sanitizeText(raw.features, LIMITS.maxSheetTextLength);
  sheet.notes = sanitizeText(raw.notes, LIMITS.maxSheetTextLength);

  return sheet;
}

const TOKEN_PALETTE = [
  '#c96f4a', '#4a8fc9', '#6fb45f', '#b45fa0', '#c9a34a', '#5f7fb4', '#a05f5f', '#4ab4a0'
];

/**
 * Состояние стола. Одна кампания = одно состояние.
 */
class RoomState {
  /**
   * @param {object} campaign запись кампании (см. server/campaign.js)
   */
  constructor(campaign) {
    this.campaign = campaign;
    /** @type {Map<string, object>} playerId -> запись игрока */
    this.players = new Map();
    /** @type {Map<string, object>} playerId -> лист персонажа */
    this.sheets = new Map();
    /** @type {Record<string, {items: object[], activeId: string|null}>} карты по вкладкам */
    this.maps = emptyMaps();
    /** @type {'world'|'battle'|'sketch'|null} */
    this.activeMap = null;
    /** @type {{enabled: boolean, cell: number}} */
    this.grid = { enabled: false, cell: GRID.defaultCell, columns: 0 };
    /** @type {object[]} */
    this.tokens = [];
    /** @type {object[]} */
    this.diceHistory = [];
    /** @type {object[]} */
    this.chatHistory = [];
    /**
     * Импортированное внешнее приключение: журнал, предметы, таблицы, NPC.
     * null, пока приключение не импортировано (в том числе у кампаний
     * старого формата, где такой секции просто не было).
     * @type {object|null}
     */
    this.adventure = null;
    this.dirty = false;
    if (campaign && campaign.state) this.hydrate(campaign.state);
  }

  /** @param {object} data */
  hydrate(data) {
    if (!data || typeof data !== 'object') return;

    for (const player of Array.isArray(data.players) ? data.players : []) {
      if (!player || !player.playerId) continue;
      const playerId = String(player.playerId);
      const isDm = playerId === DM_PLAYER_ID;
      this.players.set(playerId, {
        playerId,
        name: sanitizeText(player.name, LIMITS.maxNameLength) || (isDm ? 'ДМ' : 'Игрок'),
        role: isDm ? ROLE_DM : ROLE_PLAYER,
        online: false,
        sockets: new Set(),
        joinedAt: player.joinedAt || new Date().toISOString()
      });
    }

    for (const [playerId, sheet] of Object.entries(data.sheets || {})) {
      const name = this.players.get(playerId)?.name || '';
      this.sheets.set(String(playerId), normalizeSheet(sheet, name));
    }

    for (const type of MAP_TYPES) {
      this.maps[type] = this.normalizeMapSlot(data.maps && data.maps[type]);
    }

    this.activeMap = MAP_TYPES.includes(data.activeMap)
      ? data.activeMap
      : (MAP_TYPES.find((type) => this.maps[type].items.length) || null);

    const grid = data.grid && typeof data.grid === 'object' ? data.grid : {};
    this.grid = {
      enabled: Boolean(grid.enabled),
      cell: clampInt(grid.cell, GRID.minCell, GRID.maxCell, GRID.defaultCell),
      // columns — сколько клеток укладывается по ширине карты. Ноль означает
      // «размер клетки задаёт мастер», иначе клетка считается от ширины карты
      // и сетка одинаково ложится на любую подложку.
      columns: clampInt(grid.columns, 0, GRID.maxColumns, 0)
    };

    const tokens = Array.isArray(data.tokens) ? data.tokens.slice(0, LIMITS.maxTokens) : [];
    this.tokens = tokens
      .filter((token) => token && token.id)
      .map((token) => this.normalizeToken(token));

    this.diceHistory = Array.isArray(data.diceHistory)
      ? data.diceHistory.slice(-LIMITS.maxDiceHistory)
      : [];
    this.chatHistory = Array.isArray(data.chatHistory)
      ? data.chatHistory.slice(-LIMITS.maxChatHistory)
      : [];
    this.adventure = normalizeAdventure(data.adventure);
  }

  /**
   * Приводит вкладку карт к виду `{items, activeId}`.
   * Понимает и старый формат кампаний, где на вкладке была одна карта
   * (`{url, name}`) — такие кампании заказчика должны открываться.
   * @param {unknown} raw
   */
  normalizeMapSlot(raw) {
    const slot = { items: [], activeId: null };
    if (!raw || typeof raw !== 'object') return slot;
    const source = /** @type {any} */ (raw);

    const items = [];
    if (typeof source.url === 'string') {
      items.push({
        id: newMapId(),
        url: source.url,
        name: sanitizeText(source.name, MAP_NAME_MAX) || 'Карта',
        uploadedAt: source.uploadedAt || new Date().toISOString()
      });
    } else if (Array.isArray(source.items)) {
      for (const item of source.items.slice(0, LIMITS.maxMapsPerType)) {
        if (!item || typeof item.url !== 'string') continue;
        items.push({
          id: String(item.id || newMapId()),
          url: item.url,
          name: sanitizeText(item.name, MAP_NAME_MAX) || 'Карта',
          uploadedAt: item.uploadedAt || new Date().toISOString()
        });
      }
    }

    slot.items = items;
    slot.activeId = items.some((item) => item.id === source.activeId)
      ? String(source.activeId)
      : (items.length ? items[0].id : null);
    return slot;
  }

  /** @param {string} type */
  currentMap(type) {
    const slot = this.maps[type];
    if (!slot || !slot.items.length) return null;
    return slot.items.find((item) => item.id === slot.activeId) || slot.items[0];
  }

  /**
   * @param {object} token
   * @returns {object}
   */
  normalizeToken(token) {
    return {
      id: String(token.id),
      name: sanitizeText(token.name, LIMITS.maxNameLength) || 'Фишка',
      mapType: MAP_TYPES.includes(token.mapType) ? token.mapType : 'battle',
      // Фишка принадлежит конкретной карте, а не вкладке: вкладка умеет держать
      // несколько карт, и без этого фишки одной карты наезжали на другую.
      // Пустая строка — фишка из кампании, созданной до этого поля: такие
      // показываются на любой карте своей вкладки, как и раньше.
      mapId: sanitizeText(token.mapId, 80),
      x: clampNumber(token.x, 0, 1, 0.5),
      y: clampNumber(token.y, 0, 1, 0.5),
      imageUrl: typeof token.imageUrl === 'string' ? token.imageUrl : null,
      assignedPlayerId: token.assignedPlayerId ? String(token.assignedPlayerId) : null,
      color: typeof token.color === 'string' ? token.color : TOKEN_PALETTE[0]
    };
  }

  /** @returns {object} сериализуемое состояние для сохранения в кампанию */
  serialize() {
    const players = [];
    for (const player of this.players.values()) {
      players.push({
        playerId: player.playerId,
        name: player.name,
        role: player.role,
        joinedAt: player.joinedAt
      });
    }
    const sheets = {};
    for (const [playerId, sheet] of this.sheets.entries()) sheets[playerId] = sheet;

    return {
      players,
      sheets,
      maps: this.maps,
      activeMap: this.activeMap,
      grid: this.grid,
      tokens: this.tokens,
      diceHistory: this.diceHistory.slice(-LIMITS.maxDiceHistory),
      chatHistory: this.chatHistory.slice(-LIMITS.maxChatHistory),
      adventure: this.adventure,
      savedAt: new Date().toISOString()
    };
  }

  /**
   * Регистрирует подключение игрока и возвращает его запись.
   * Если игрок уже известен (переподключение с тем же локальным playerId),
   * его лист персонажа и данные сохраняются.
   * @param {string} playerId
   * @param {string} name
   * @returns {object}
   */
  addPlayer(playerId, name) {
    let player = this.players.get(playerId);
    if (!player) {
      player = {
        playerId,
        name,
        role: ROLE_PLAYER,
        online: false,
        sockets: new Set(),
        joinedAt: new Date().toISOString()
      };
      this.players.set(playerId, player);
      this.sheets.set(playerId, createEmptySheet(name));
      this.markDirty();
    } else {
      player.name = name;
      this.markDirty();
    }
    return player;
  }

  /**
   * Регистрирует подключение ДМ (одна запись на весь стол).
   * @param {string} name
   * @returns {object}
   */
  addDm(name) {
    let dm = this.players.get(DM_PLAYER_ID);
    if (!dm) {
      dm = {
        playerId: DM_PLAYER_ID,
        name,
        role: ROLE_DM,
        online: false,
        sockets: new Set(),
        joinedAt: new Date().toISOString()
      };
      this.players.set(DM_PLAYER_ID, dm);
    } else {
      dm.name = name;
    }
    return dm;
  }

  /**
   * Отвязывает сокет. Данные игрока и его лист сохраняются (нужно для переподключения).
   * @param {string} playerId
   * @param {string} socketId
   */
  detachSocket(playerId, socketId) {
    const player = this.players.get(playerId);
    if (!player) return;
    player.sockets.delete(socketId);
    if (player.sockets.size === 0) player.online = false;
  }

  /** @param {string} playerId */
  isOnline(playerId) {
    const player = this.players.get(playerId);
    return Boolean(player && player.sockets.size > 0);
  }

  /**
   * Публичный список игроков для рассылки клиентам.
   * @param {boolean} includeTokens
   * @returns {object[]}
   */
  playerList(includeTokens = true) {
    const list = [];
    // Кто на какой фишке: раньше внутри цикла по игрокам искали фишку поиском,
    // то есть на каждой рассылке списка выполнялось «игроки × фишки». Словарь
    // строится один раз, а список игроков перебирается один раз.
    const tokenIdByPlayer = new Map();
    if (includeTokens) {
      for (const token of this.tokens) {
        if (token.assignedPlayerId && !tokenIdByPlayer.has(token.assignedPlayerId)) {
          tokenIdByPlayer.set(token.assignedPlayerId, token.id);
        }
      }
    }
    for (const player of this.players.values()) {
      list.push({
        playerId: player.playerId,
        name: player.name,
        role: player.role,
        online: player.online,
        hasSheet: this.sheets.has(player.playerId),
        tokenId: includeTokens
          ? (tokenIdByPlayer.get(player.playerId) || null)
          : null
      });
    }
    list.sort((a, b) => {
      if (a.role !== b.role) return a.role === ROLE_DM ? -1 : 1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return list;
  }

  /**
   * Снимок состояния для конкретного клиента. Игрок НИКОГДА не получает
   * чужие листы персонажей.
   * @param {{playerId: string, role: string}} viewer
   * @returns {object}
   */
  snapshotFor(viewer) {
    const isDm = viewer.role === ROLE_DM;
    const sheets = {};
    if (isDm) {
      for (const [playerId, sheet] of this.sheets.entries()) sheets[playerId] = sheet;
    } else if (this.sheets.has(viewer.playerId)) {
      sheets[viewer.playerId] = this.sheets.get(viewer.playerId);
    }

    return {
      campaign: {
        id: this.campaign?.id || null,
        name: this.campaign?.name || 'Кампания',
        createdAt: this.campaign?.createdAt || null,
        updatedAt: this.campaign?.updatedAt || null,
        version: this.campaign?.version || CAMPAIGN_FORMAT_VERSION
      },
      // Журнал и справочники приключения нужны мастеру. Игроку отдаём null:
      // отдельного экрана для них пока нет, а лишние данные на клиенте
      // только мешают.
      adventure: isDm ? this.adventure : null,
      players: this.playerList(),
      sheets,
      maps: this.maps,
      activeMap: this.activeMap,
      grid: this.grid,
      tokens: this.tokens,
      diceHistory: this.diceHistory.slice(-LIMITS.maxDiceHistory),
      chatHistory: this.chatHistory.slice(-LIMITS.maxChatHistory)
    };
  }

  markDirty() {
    this.dirty = true;
  }
}

function newTokenId() {
  return crypto.randomBytes(8).toString('hex');
}

function newMapId() {
  return `m-${crypto.randomBytes(6).toString('hex')}`;
}

module.exports = {
  ABILITY_KEYS,
  ABILITY_LABELS,
  CAMPAIGN_FORMAT_VERSION,
  DM_PLAYER_ID,
  GRID,
  LIMITS,
  MAP_TYPES,
  ROLE_DM,
  ROLE_PLAYER,
  SKILLS,
  TOKEN_PALETTE,
  RoomState,
  abilityModifier,
  clampInt,
  clampNumber,
  createEmptySheet,
  emptyMaps,
  newMapId,
  newTokenId,
  normalizeSheet,
  normalizeAdventure,
  proficiencyBonus,
  sanitizeText
};
