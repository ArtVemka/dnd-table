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
const diceModule = require('../renderer/dice.js');
// Список состояний один на клиента и сервер: сервер отбрасывает всё, чего в
// нём нет. Своя копия здесь разъехалась бы на первом же новом состоянии.
const CONDITIONS = require('../renderer/dnd5e.js').CONDITIONS || [];
const CONDITION_IDS = new Set(CONDITIONS.map((item) => item.id));
// Правило «состояние отнимает скорость» тоже оттуда: клиент и сервер обязаны
// отвечать одинаково, иначе игрок увидит «можно двигать», а сервер откажет.
const conditionBlocksMove = require('../renderer/dnd5e.js').conditionBlocksMove;
// Ступени ячеек заклинаний: их девять, и это знает сервер.
const SPELL_SLOT_LEVELS = require('../renderer/dnd5e.js').SPELL_SLOT_LEVELS || [1, 2, 3, 4, 5, 6, 7, 8, 9];
// Разбор маски тумана тоже оттуда: своя копия в сервере разъехалась бы с
// интерфейсом при первом же изменении разрешения сетки.
const fogModel = require('../renderer/dnd5e.js');
// Сетка тоже приводится к виду там же: пределы, округление до половины клетки
// и сдвиг должны совпадать у клиента и сервера до последнего пикселя.
const normalizeGrid = fogModel.normalizeGrid;
// Поверхности приводятся к виду там же: список типов один на клиента и сервер,
// и сервер не примет то, чего нет в правилах.
const normalizeSurface = fogModel.normalizeSurface;
// Стены и источники света приводятся к виду там же: свет — это чистый расчёт,
// и вторая копия правил разошлась бы с первой при первом же изменении.
const normalizeWalls = fogModel.normalizeWalls;
const normalizeLights = fogModel.normalizeLights;
const LIGHT_LIMITS = fogModel.LIGHT_LIMITS || { maxRadius: 200 };
/** Цвет света по умолчанию: тёплый, как факел. */
const DEFAULT_LIGHT_COLOR = '#ffb347';

const CAMPAIGN_FORMAT_VERSION = 2;

const LIMITS = {
  maxNameLength: 40,
  maxChatLength: 1000,
  maxSheetTextLength: 4000,
  maxImageBytes: 10 * 1024 * 1024, // 10 МБ
  // Аватар показывается в кружке 30px и ездит вместе с игроком, поэтому он
  // заметно меньше карты. 2 МБ хватает даже для фото с телефона.
  maxAvatarBytes: 2 * 1024 * 1024, // 2 МБ
  maxDiceHistory: 200,
  /** Порядок боя длиннее сорока человек не бывает. */
  maxInitiativeEntries: 40,
  maxChatHistory: 300,
  maxTokens: 200,
  /** Прочность фишки: в кампании панцирь дракона из «Стимпанка» не поместится. */
  maxTokenHp: 9999,
  /** Счётчик спасбросков смерти: дальше трёх он не идёт по правилам. */
  maxDeathSaves: 3,
  /** Состояний на одной фишке: столько их есть в правилах 5e. */
  maxTokenConditions: 13,
  /** Ячейки заклинаний на одной ступени: в правилах больше не бывает. */
  maxSpellSlotsPerLevel: 9,
  /** Заметка мастера: столько же, сколько заметки в листе. */
  maxDmNote: 4000,
  /** Журнал кампании: длиннее одной сессии, но не бесконечный. */
  maxJournal: 20000,
  maxJournalEntries: 300,
  maxJournalTitle: 120,
  maxJournalText: 8000,
  maxJournalTags: 8,
  maxJournalTag: 32,
  maxInventoryItems: 500,
  maxInventoryName: 120,
  maxInventoryNotes: 1000,
  maxRollRequests: 20,
  /** Строк атак в листе: больше двадцати за бой всё равно не пригодится. */
  maxSheetAttacks: 20,
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
  maxAdventureImageRef: 2048,
  // Ссылка на аватар игрока: /files/<имя> либо путь к файлу из поставки.
  maxAvatarRef: 2048
};

/**
 * Портрет мастера из поставки. Подставляется, пока у игрока с ролью ДМ нет
 * своей картинки, чтобы у стола всегда был распознаваемый ведущий.
 * Это путь внутри renderer/, а не /files/...: файл лежит рядом с интерфейсом.
 */
const DEFAULT_DM_AVATAR = 'avatar-dm.png';

/**
 * Настоящие кости D&D: шесть основных плюс сотня для процентных бросков.
 *
 * Раньше сервер принимал любое число от 1 до 20, и можно было бросить
 * d3 или d17 — таких костей в игре нет. Теперь список ровно тот же, что и
 * в панели кубиков, и он продублирован в renderer/dnd5e.js: renderer не может
 * потребовать серверный файл, а списки сверяются проверкой в
 * test/integration.js.
 */
const DICE_SIDES = [4, 6, 8, 10, 12, 20, 100];

const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

/**
 * Порядок боя.
 *
 * `INITIATIVE_KINDS` — откуда взялся участник: игрок, фишка или названная
 * вручную строка вроде «Солдат-нежить». Предел модификатора совпадает с
 * пределом прочего бонуса к инициативе в листе (LIMITS.minInitiativeMisc),
 * чтобы одно и то же число нельзя было протащить двумя путями.
 */
const INITIATIVE_KINDS = ['player', 'token', 'other'];
const INITIATIVE = { minModifier: -20, maxModifier: 20 };

/** @returns {{entries: object[], turnId: string|null, round: number}} */
function emptyInitiative() {
  return { entries: [], turnId: null, round: 1 };
}

function newInitiativeId() {
  return `i-${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Приводит сохранённый порядок боя к виду, которым дальше пользуется сервер.
 * Файл кампании может достаться от другой версии игры или быть правлен руками,
 * поэтому доверять ему нельзя.
 * @param {unknown} raw
 * @returns {{entries: object[], turnId: string|null, round: number}}
 */
/**
 * Оставляет только известные состояния, без повторов.
 *
 * Список может прийти из файла кампании, из сообщения или из старой версии
 * игры, поэтому проверяем каждое значение по списку правил, а не по
 * количеству. Состояния-призраки на карте выглядели бы как ошибка.
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeConditions(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  for (const item of raw) {
    const id = String(item || '');
    if (CONDITION_IDS.has(id)) seen.add(id);
    if (seen.size >= LIMITS.maxTokenConditions) break;
  }
  return [...seen];
}

/**
 * Длительности состояний в раундах.
 *
 * Хранятся отдельным объектом, а не внутри состояния: старые кампании и
 * сообщения знают только список id, и менять их формат ради счётчика было бы
 * дороже, чем добавить рядом ещё одно поле. Ноль и неизвестные состояния
 * отбрасываются: «Опутан, 0 раундов» выглядел бы как ошибка.
 * @param {unknown} raw
 * @param {string[]} conditions
 * @returns {Record<string, number>}
 */
function normalizeConditionDurations(raw, conditions) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const durations = {};
  for (const id of conditions) {
    const rounds = clampInt(raw[id], 0, 99, 0);
    if (rounds > 0) durations[id] = rounds;
  }
  return durations;
}

/**
 * Приводит ряд ячеек заклинаний к виду из девяти чисел в пределах.
 *
 * Значения приходят из файла кампании и из сообщений, поэтому длину и разброс
 * режем здесь: ступеней в правилах девять, а ячейек на ступени больше девяти
 * не бывает.
 * @param {unknown} raw
 * @returns {number[]}
 */
/**
 * Приводит маску тумана к нужному размеру.
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeFog(raw) {
  return fogModel.normalizeFogMask(raw);
}

/**
 * Насколько карта тёмная: доля от 0 до 1.
 *
 * Значение из кампании, с сервера или из файла может оказаться чем угодно,
 * поэтому приводится здесь же. Карта без освещения — это 0, а не полная темнота:
 * иначе кампании, созданные до появления света, открылись бы чёрными.
 * @param {unknown} raw
 * @returns {number}
 */
function normalizeDarkness(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Свет фишки: дальность в футах и цвет, либо ничего.
 *
 * Фишка без света хранит ноль, а не отсутствие поля: иначе у каждой фишки в
 * кампании лишний ключ, а проверка «светит ли кто-нибудь» писалась бы в трёх
 * местах по-разному.
 * @param {unknown} raw
 * @returns {{radius: number, color: string}}
 */
function normalizeTokenLight(raw) {
  if (!raw || typeof raw !== 'object') return { radius: 0, color: DEFAULT_LIGHT_COLOR };
  const radius = Number(raw.radius);
  const color = typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color)
    ? raw.color
    : DEFAULT_LIGHT_COLOR;
  if (!Number.isFinite(radius) || radius <= 0) return { radius: 0, color };
  return { radius: Math.min(LIGHT_LIMITS.maxRadius, Math.round(radius)), color };
}

function clampSlotArray(raw) {
  const rows = Array.isArray(raw) ? raw.slice(0, 9) : [];
  return SPELL_SLOT_LEVELS.map((level, index) => clampInt(rows[index], 0, LIMITS.maxSpellSlotsPerLevel, 0));
}

/** Виды шаблонов заклинаний и их пределы. */
const TEMPLATE_KINDS = ['sphere', 'cone', 'line', 'square'];
const TEMPLATE_LIMITS = { maxPerMap: 20, minSize: 5, maxSize: 120 };

/**
 * Приводит шаблон к безопасному виду: вид, центр, размер в футах, поворот
 * и цвет. Пустой цвет означает цвет по виду из оформления.
 * @param {unknown} raw
 * @returns {{id: string, kind: string, x: number, y: number, size: number, rotation: number, color: string}|null}
 */
function normalizeTemplate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const value = /** @type {any} */ (raw);
  return {
    id: String(value.id || newTokenId()),
    kind: TEMPLATE_KINDS.includes(value.kind) ? value.kind : 'sphere',
    x: clampNumber(value.x, 0, 1, 0.5),
    y: clampNumber(value.y, 0, 1, 0.5),
    size: clampInt(value.size, TEMPLATE_LIMITS.minSize, TEMPLATE_LIMITS.maxSize, 20),
    rotation: clampInt(value.rotation, 0, 359, 0),
    color: typeof value.color === 'string' && /^#[0-9a-f]{6}$/i.test(value.color)
      ? value.color
      : ''
  };
}

/** @param {unknown} raw @returns {object[]} */
function normalizeTemplates(raw) {
  const list = Array.isArray(raw) ? raw.slice(0, TEMPLATE_LIMITS.maxPerMap) : [];
  return list.map(normalizeTemplate).filter(Boolean);
}

function normalizeInitiative(raw) {
  const state = emptyInitiative();
  if (!raw || typeof raw !== 'object') return state;
  const source = /** @type {any} */ (raw);
  const entries = Array.isArray(source.entries) ? source.entries.slice(0, LIMITS.maxInitiativeEntries) : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !entry.id) continue;
    const total = Number(entry.total);
    state.entries.push({
      id: String(entry.id),
      kind: INITIATIVE_KINDS.includes(entry.kind) ? entry.kind : 'other',
      refId: sanitizeText(entry.refId, 64),
      name: sanitizeText(entry.name, LIMITS.maxNameLength) || 'Участник',
      modifier: clampInt(entry.modifier, INITIATIVE.minModifier, INITIATIVE.maxModifier, 0),
      total: Number.isFinite(total) ? clampInt(total, -99, 199, 0) : null
    });
  }
  // turnId === null означает «бой ещё не начат», и это состояние важно
  // сохранить: подставлять первого участника значило бы показывать игрокам
  // ход, которого мастер ещё не объявил.
  const turnId = typeof source.turnId === 'string' && state.entries.some((entry) => entry.id === source.turnId)
    ? source.turnId
    : null;
  return {
    entries: state.entries,
    turnId,
    round: clampInt(source.round, 1, 999, 1)
  };
}

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
  maxColumns: 200,
  // Футов в клетке. Дублируется из renderer/dnd5e.js: сервер не может
  // потребовать файл интерфейса ради двух чисел, а разойтись им нельзя —
  // иначе игрок посчитал бы свет иначе, чем мастер.
  minFeetPerCell: 1,
  maxFeetPerCell: 50,
  defaultFeetPerCell: 5
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
    subclass: '',
    /** Мультикласс: [{name, level}]. Пусто — класс берётся из charClass/level. */
    classes: [],
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
    // Потраченные кости хитов: короткий отдых увеличивает, долгий уменьшает.
    hitDiceSpent: 0,
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
 * Статблок монстра или NPC: только поля, которые нужны за столом.
 * @param {unknown} input
 * @returns {object|null}
 */
function normalizeStatblock(input) {
  if (!input || typeof input !== 'object') return null;
  const raw = /** @type {Record<string, any>} */ (input);
  const abilitiesRaw = raw.abilities && typeof raw.abilities === 'object' ? raw.abilities : {};
  const abilities = {};
  for (const key of ABILITY_KEYS) {
    abilities[key] = clampInt(abilitiesRaw[key], LIMITS.minAbility, LIMITS.maxAbility, 10);
  }
  return {
    ac: clampInt(raw.ac, 0, 99, 0),
    hp: clampInt(raw.hp, 0, LIMITS.maxTokenHp, 0),
    speed: sanitizeText(raw.speed, 60),
    size: clampInt(raw.size, 1, 4, 1),
    cr: sanitizeText(raw.cr, 20),
    abilities,
    attacks: sanitizeText(raw.attacks, LIMITS.maxSheetTextLength),
    notes: sanitizeText(raw.notes, LIMITS.maxSheetTextLength)
  };
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
      // npc или character: только для подписи в карточке, на механику не влияет.
      type: sanitizeText(item && item.type, 20) || 'npc',
      // Картинки импорта — это ссылки вида /files/<имя>. Не строка сюда не попадает:
      // приводить 42 к «42» зачем, а вот тихо испорченная ссылка мешает потом.
      image: typeof item?.image === 'string' ? sanitizeText(item.image, LIMITS.maxAdventureImageRef) : '',
      statblock: normalizeStatblock(item && item.statblock),
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
/**
 * Приводит список классов листа к чистому виду: имя и уровень, не больше
 * шести записей, суммарно не больше 20 уровней.
 * @param {unknown} value
 * @returns {{name: string, level: number}[]}
 */
function normalizeSheetClasses(value) {
  const list = Array.isArray(value) ? value : [];
  const result = [];
  let sum = 0;
  for (const entry of list) {
    if (result.length >= 6) break;
    const name = sanitizeText(entry && entry.name, 60);
    if (!name) continue;
    const room = LIMITS.maxLevel - sum;
    if (room <= 0) break;
    const level = Math.min(clampInt(entry && entry.level, 1, LIMITS.maxLevel, 1), room);
    result.push({ name, level });
    sum += level;
  }
  return result;
}

/**
 * Строки атак листа: имя, бонус к попаданию и формула урона. Пустые строки
 * выбрасываются, чтобы «+ Атака» без текста не сохранялась в кампанию.
 * @param {unknown} value
 * @returns {{name: string, bonus: number, damage: string}[]}
 */
function normalizeAttackList(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const entry of value.slice(0, LIMITS.maxSheetAttacks)) {
    if (!entry || typeof entry !== 'object') continue;
    const name = sanitizeText(entry.name, 60);
    const damage = sanitizeText(entry.damage, 80);
    const bonus = clampInt(entry.bonus, -20, 30, 0);
    if (!name && !damage && bonus === 0) continue;
    result.push({ name, bonus, damage });
  }
  return result;
}

function normalizeSheet(input, fallbackPlayerName = '') {
  const sheet = createEmptySheet(fallbackPlayerName);
  if (!input || typeof input !== 'object') return sheet;
  const raw = /** @type {Record<string, any>} */ (input);

  sheet.playerName = sanitizeText(raw.playerName, LIMITS.maxNameLength) || fallbackPlayerName;
  sheet.characterName = sanitizeText(raw.characterName, LIMITS.maxNameLength);
  sheet.charClass = sanitizeText(raw.charClass, 60);
  sheet.subclass = sanitizeText(raw.subclass, 60);
  sheet.classes = normalizeSheetClasses(raw.classes);
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
    // Спасброски смерти. Значение в кампании может достаться от другой версии
    // или быть правлено руками, поэтому числа режутся здесь же.
    sheet.deathSavesSuccesses = clampInt(raw.deathSavesSuccesses, 0, LIMITS.maxDeathSaves, 0);
    sheet.deathSavesFailures = clampInt(raw.deathSavesFailures, 0, LIMITS.maxDeathSaves, 0);
    // Ячейки заклинаний приходят двумя массивами по девять чисел. Значения могут
    // достаться из файла кампании или из сообщения, поэтому режем здесь же:
    // девять ступеней в правилах и не больше.
    sheet.spellSlotsUsed = clampSlotArray(raw.spellSlotsUsed);
    sheet.spellSlotsMax = clampSlotArray(raw.spellSlotsMax);
  sheet.hitDice = sanitizeText(raw.hitDice, 20);
  sheet.hitDiceSpent = clampInt(raw.hitDiceSpent, 0, LIMITS.maxLevel, 0);
  sheet.armorClass = clampInt(raw.armorClass, 0, 99, 10);
  sheet.initiativeMisc = clampInt(raw.initiativeMisc, -20, 20, 0);
  sheet.speed = clampInt(raw.speed, 0, 999, 30);

  sheet.attackList = normalizeAttackList(raw.attackList);
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
    /** @type {string|null} карта, которую сейчас видят игроки */
    this.activeMapId = null;
    /** @type {{enabled: boolean, cell: number}} */
    this.grid = { enabled: false, cell: GRID.defaultCell, columns: 0 };
    /** @type {object[]} */
    this.tokens = [];
    /**
     * Порядок боя: кто за кем ходит.
     *
     * Считает его мастер, видят все. Инициатива игроков берётся из листа
     * (Dex + прочий бонус), но модификатор присылает мастер вместе с записью:
     * производные значения листа считает клиент, и вторая копия расчёта на
     * сервере разошлась бы с первой.
     * @type {{entries: object[], turnId: string|null, round: number}}
     */
    this.initiative = emptyInitiative();
    /**
     * Режим боя: фишка ходит по клеткам, а не свободно.
     *
     * Отдельный переключатель, а не следствие наличия порядка боя: бой можно
     * вести и без клеток, а клетки — и без боя. Включается мастером вручную и
     * сам собой при общем броске инициативы.
     * @type {{enabled: boolean}}
     */
    this.combat = { enabled: false };
    /** @type {object[]} */
    this.diceHistory = [];
    /** @type {object[]} */
    this.chatHistory = [];
    /** Заметки мастера по кампании, не путать с импортированным журналом. */
    this.journal = '';
    /** @type {object[]} структурированный журнал: NPC, места, квесты, фракции, предметы. */
    this.journalEntries = [];
    /** @type {object[]} общий склад партии. */
    this.inventory = [];
    /** @type {object[]} просьбы мастера бросить проверку. */
    this.rollRequests = [];
    /** @type {string[]} снимки карты, фишек и боя для отмены действий мастера. */
    this.undoStack = [];
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
      // Секрет личности: по нему стол узнаёт вернувшегося игрока. В кампании
      // он лежит, иначе после перезапуска игрок потерял бы свой лист.
      const playerKey = typeof player.playerKey === 'string'
        ? player.playerKey.replace(/[^a-f0-9]/gi, '').slice(0, 128)
        : '';
      this.players.set(playerId, {
        playerId,
        name: sanitizeText(player.name, LIMITS.maxNameLength) || (isDm ? 'ДМ' : 'Игрок'),
        role: isDm ? ROLE_DM : ROLE_PLAYER,
        playerKey,
        // Аватар хранится у игрока, а не в листе: лист мастер не редактирует,
        // а портрет нужен и ему, и всем остальным в списке и чате.
        avatar: typeof player.avatar === 'string' && player.avatar
          ? sanitizeText(player.avatar, LIMITS.maxAvatarRef)
          : null,
        // Заметка мастера лежит у игрока, а не в листе: лист игрок видит
        // целиком, и заметка уехала бы вместе с ним.
        dmNote: sanitizeText(player.dmNote, LIMITS.maxDmNote),
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

    // Карта, которую видят игроки. В кампаниях до появления заготовок её не
    // было: там открытая карта вкладки и была показанной, поэтому берём activeId.
    // ActiveId при этом остаётся выбором мастера: он может листать заготовки,
    // не показывая их игрокам.
    const activeSlot = this.activeMap ? this.maps[this.activeMap] : null;
    const storedActiveId = activeSlot && data.activeMapId ? String(data.activeMapId) : '';
    this.activeMapId = activeSlot && activeSlot.items.some((item) => item.id === storedActiveId)
      ? storedActiveId
      : (activeSlot && activeSlot.items.length ? activeSlot.activeId : null);
    if (this.activeMapId && activeSlot) {
      const shown = activeSlot.items.find((item) => item.id === this.activeMapId);
      // Старая кампания не знала флага «показана»: открытая карта считается
      // показанной, иначе после обновления стол остался бы пустым.
      if (shown) shown.published = true;
    }

    const grid = data.grid && typeof data.grid === 'object' ? data.grid : {};
    // Правила сетки — из того же файла, что читает интерфейс: иначе снимок
    // состояния и сообщение о смене сетки разошлись бы с тем, что рисует карта.
    this.grid = normalizeGrid(grid);

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
    this.journal = sanitizeText(data.journal, LIMITS.maxJournal);
    this.initiative = normalizeInitiative(data.initiative);
    this.combat = { enabled: Boolean(data.combat && data.combat.enabled) };
    this.adventure = normalizeAdventure(data.adventure);
    this.journalEntries = normalizeJournalEntries(data.journalEntries);
    this.inventory = normalizeInventory(data.inventory);
    this.rollRequests = normalizeRollRequests(data.rollRequests);
  }

  /* ----------------------------------------------------------- инициатива */

  /**
   * Добавляет участника боя.
   *
   * Модификатор приходит от мастера: инициатива игрока считается из его листа
   * в интерфейсе, а у фишки модификатора нет вовсе, и мастер вписывает его руками.
   * @param {{kind: string, refId?: string, name?: string, modifier?: number}} input
   * @returns {object|null} Новая запись или null, если добавлять нельзя.
   */
  addInitiativeEntry(input) {
    const raw = input && typeof input === 'object' ? input : {};
    const kind = INITIATIVE_KINDS.includes(raw.kind) ? raw.kind : 'other';
    const refId = kind === 'other' ? '' : sanitizeText(raw.refId, 64);
    if ((kind === 'player' || kind === 'token') && !refId) return null;
    if (this.initiative.entries.length >= LIMITS.maxInitiativeEntries) return null;
    // Один участник не должен попасть в список дважды: иначе «следующий»
    // дважды задержится на нём, а удаление уберёт только одну запись.
    if (refId && this.initiative.entries.some((entry) => entry.refId === refId)) return null;
    const fallbackName = kind === 'token' ? 'Существо' : 'Участник';
    const entry = {
      id: newInitiativeId(),
      kind,
      refId,
      name: sanitizeText(raw.name, LIMITS.maxNameLength) || fallbackName,
      modifier: clampInt(raw.modifier, INITIATIVE.minModifier, INITIATIVE.maxModifier, 0),
      total: null
    };
    this.initiative.entries.push(entry);
    return entry;
  }

  /** @param {string} entryId */
  removeInitiativeEntry(entryId) {
    const id = String(entryId || '');
    const index = this.initiative.entries.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.initiative.entries.splice(index, 1);
    if (this.initiative.turnId === id) {
      // Кто ходил, того больше нет: действует следующий по списку.
      const next = this.initiative.entries[index] || this.initiative.entries[index - 1] || null;
      this.initiative.turnId = next ? next.id : null;
    }
    return true;
  }

  /**
   * Бросает инициативу и пересобирает порядок.
   *
   * Бросок один на всех: d20 плюс модификатор записи. Порядок считает сервер,
   * иначе у игроков разный порядок из-за разной сортировки одинаковых чисел.
   * @param {crypto.RandomInt} randomInt
   * @param {string|null} [onlyId] Перебросить одного участника, а не всех.
   */
  rollInitiative(randomInt, onlyId) {
    const id = onlyId ? String(onlyId) : null;
    const entries = this.initiative.entries;
    for (const entry of entries) {
      if (id && entry.id !== id) continue;
      entry.roll = randomInt(1, 20);
      entry.total = entry.roll + entry.modifier;
    }
    if (!entries.some((entry) => entry.total !== null)) return;
    // Порядок боя: больше итог — раньше. При равенстве больше модификатор, а
    // потом порядок добавления: иначе одинаковые броски прыгали бы у игроков.
    const order = new Map(entries.map((entry, index) => [entry.id, index]));
    entries.sort((a, b) => {
      if ((b.total ?? -Infinity) !== (a.total ?? -Infinity)) return (b.total ?? -Infinity) - (a.total ?? -Infinity);
      if (b.modifier !== a.modifier) return b.modifier - a.modifier;
      return order.get(a.id) - order.get(b.id);
    });
    if (!id) {
      this.initiative.round = 1;
      this.initiative.turnId = entries.length ? entries[0].id : null;
    }
  }

  /** Делает активной запись, по которой кликнули. @param {string} entryId */
  setInitiativeTurn(entryId) {
    const id = String(entryId || '');
    if (!this.initiative.entries.some((entry) => entry.id === id)) return false;
    this.initiative.turnId = id;
    return true;
  }

  /**
   * Переход к следующему или предыдущему участнику.
   *
   * Переход с последнего на первого считается новым раундом: за столом
   * считают раунды, и молчаливый возврат к началу путает.
   * @param {number} dir 1 или -1
   * @returns {boolean} Сдвинулся ли список.
   */
  stepInitiativeTurn(dir) {
    const entries = this.initiative.entries;
    if (!entries.length) return false;
    const step = dir >= 0 ? 1 : -1;
    const current = entries.findIndex((entry) => entry.id === this.initiative.turnId);
    if (current < 0) {
      this.initiative.turnId = entries[0].id;
      return true;
    }
    const next = current + step;
    if (next >= entries.length) {
      this.initiative.turnId = entries[0].id;
      this.initiative.round += 1;
      return true;
    }
    if (next < 0) {
      // Назад из первого: не крутим раунд, а просто остаёмся в текущем раунде.
      this.initiative.turnId = entries[0].id;
      return true;
    }
    this.initiative.turnId = entries[next].id;
    return true;
  }

  /**
   * Уменьшает длительности состояний в начале хода.
   *
   * Счётчик принадлежит фишке, но тикает по её ходу: в начале каждого её хода
   * число уменьшается, а на нуле состояние снимается. Если фишки нет в порядке
   * боя, тикать нечему, и мастер снимает состояние вручную.
   * @returns {object[]} Фишки, у которых что-то изменилось.
   */
  tickConditionsForCurrentTurn() {
    const entry = this.initiative.entries.find((item) => item.id === this.initiative.turnId);
    if (!entry) return [];
    const tokenIds = new Set();
    if (entry.kind === 'token') {
      tokenIds.add(entry.refId);
    } else if (entry.kind === 'player') {
      for (const token of this.tokens) {
        if (token.assignedPlayerId === entry.refId) tokenIds.add(token.id);
      }
    }
    if (!tokenIds.size) return [];
    const changed = [];
    for (const token of this.tokens) {
      if (!tokenIds.has(token.id)) continue;
      const conditions = normalizeConditions(token.conditions);
      const durations = normalizeConditionDurations(token.conditionDurations, conditions);
      let touched = false;
      for (const [id, rounds] of Object.entries(durations)) {
        const next = rounds - 1;
        if (next <= 0) delete durations[id];
        else durations[id] = next;
        touched = true;
      }
      if (!touched) continue;
      // Снимаем все истёкшие разом: если удалять по одному из старого списка,
      // второе состояние вернуло бы первое обратно.
      token.conditions = conditions.filter((condition) => durations[condition] > 0);
      token.conditionDurations = durations;
      changed.push(token);
    }
    return changed;
  }

  /** Полный сброс боя: список пуст, первый ход никому не принадлежит. */
  resetInitiative() {
    this.initiative = emptyInitiative();
  }

/**
   * Открывает участок карты туманом войны.
   *
   * Открытое хранится у карты, а не у фишки или фигуры: правило «кто что видит»
   * в игре держится на столе, но открытые участки накоплены разными фишками и
   * переживают её уход со стола.
   * @param {object} mapItem
   * @param {number} x Центр кисти по ширине, от 0 до 1.
   * @param {number} y Центр кисти по высоте, от 0 до 1.
   * @param {number} radius Радиус кисти по ширине карты.
   * @returns {object} Обновлённая карта.
   */
  openMapFog(mapItem, x, y, radius) {
    mapItem.fogMask = fogModel.openFogAt(normalizeFog(mapItem.fogMask), x, y, radius);
    return mapItem;
  }

  /**
   * Открывает карту целиком или снова закрывает.
   * @param {object} mapItem
   * @param {boolean} open
   * @returns {object}
   */
  setWholeMapFog(mapItem, open) {
    mapItem.fogMask = fogModel.setFogWhole(normalizeFog(mapItem.fogMask), open);
    return mapItem;
  }

  /**
   * Убирает участника боя вслед за исчезновением того, на кого он ссылается:
   * удалённая фишка не должна оставаться в порядке боя.
   * @param {string} refId
   * @returns {number} Сколько записей убрано: вызывающий знает, что пора слать
   *   рассылку. Раньше возврата не было, и удаление фишки молча не доходило до
   *   игроков: в их порядке боя оставался призрак.
   */
  dropInitiativeByRef(refId) {
    const id = String(refId || '');
    if (!id) return 0;
    let removed = 0;
    for (const entry of [...this.initiative.entries]) {
if (entry.refId === id && this.removeInitiativeEntry(entry.id)) removed += 1;
    }
    return removed;
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
        // Кампании до заготовок показывали открытую карту сразу.
        published: true,
        // Туман живёт у карты, а не у стола: у каждой карты он свой, и при
        // переключении вкладки мастер не должен открывать заново.
fogMask: normalizeFog(source.fogMask),
          // Поверхность по клеткам: кислота, огонь, вода. Видна всем, рисует
          // мастер, и переживает кампанию вместе с картой.
          surface: normalizeSurface(source.surface),
          walls: normalizeWalls(source.walls),
          lights: normalizeLights(source.lights),
          templates: normalizeTemplates(source.templates),
          darkness: normalizeDarkness(source.darkness),
          uploadedAt: source.uploadedAt || new Date().toISOString()
        });
    } else if (Array.isArray(source.items)) {
      for (const item of source.items.slice(0, LIMITS.maxMapsPerType)) {
        if (!item || typeof item.url !== 'string') continue;
        items.push({
          id: String(item.id || newMapId()),
          url: item.url,
          name: sanitizeText(item.name, MAP_NAME_MAX) || 'Карта',
          // Флаг появился вместе с заготовками. Карта без флага — из старой
          // кампании, и она уже была видна игрокам.
          published: item.published !== false,
          // Маска из кампании может достаться от другой версии игры или быть
          // правлена руками, поэтому чинится здесь же.
          fogMask: normalizeFog(item.fogMask),
          surface: normalizeSurface(item.surface),
          walls: normalizeWalls(item.walls),
          lights: normalizeLights(item.lights),
          templates: normalizeTemplates(item.templates),
          darkness: normalizeDarkness(item.darkness),
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
   * Показана ли карта игрокам.
   * Пустой mapId — «есть ли во вкладке хоть одна показанная карта»: так
   * проверяются фишки старого формата, не привязанные к конкретной карте.
   * @param {string} type
   * @param {string|null|undefined} mapId
   * @returns {boolean}
   */
  isMapPublished(type, mapId) {
    const slot = this.maps[type];
    if (!slot) return false;
    if (!mapId) return slot.items.some((item) => item.published !== false);
    const item = slot.items.find((entry) => entry.id === String(mapId));
    return Boolean(item && item.published !== false);
  }

  /**
   * Может ли игрок увидеть фишку: она не скрыта и стоит на показанной карте.
   * @param {object} token
   * @returns {boolean}
   */
  isTokenVisibleToPlayers(token) {
    if (!token || token.hidden) return false;
    if (token.mapId) return this.isMapPublished(token.mapType, token.mapId);
    return this.isMapPublished(token.mapType, null);
  }

  /**
   * Вкладка карт глазами конкретного зрителя.
   *
   * Мастер получает всё, включая заготовки. Игроку уходят только показанные
   * карты: иначе он открыл бы вкладку и увидел будущую локацию раньше стола.
   * @param {string} type
   * @param {boolean} isDm
   * @returns {{items: object[], activeId: string|null}}
   */
  mapSlotForViewer(type, isDm) {
    const slot = this.maps[type] || { items: [], activeId: null };
    if (isDm) return slot;
    const items = slot.items.filter((item) => item.published !== false);
    let activeId = this.activeMap === type ? this.activeMapId : null;
    if (!items.some((item) => item.id === activeId)) activeId = items.length ? items[0].id : null;
    return { items, activeId };
  }

  /**
   * Все вкладки карт глазами зрителя.
   * @param {boolean} isDm
   * @returns {Record<string, {items: object[], activeId: string|null}>}
   */
  mapsForViewer(isDm) {
    if (isDm) return this.maps;
    const maps = {};
    for (const type of MAP_TYPES) maps[type] = this.mapSlotForViewer(type, false);
    return maps;
  }

  /**
   * @param {object} token
   * @returns {object}
   */
  normalizeToken(token) {
    const conditions = normalizeConditions(token.conditions);
    const result = {
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
      // Фишка, выведенная из листа, носит аватар игрока и продолжает следить за
      // ним. Картинку, поставленную руками, помечаем как «свою»: дальше
      // аватар в неё не лезет.
      avatarFromSheet: Boolean(token.avatarFromSheet),
      // Скрытая фишка — заготовка мастера: он её расставляет и проверяет, а
      // игроки её не видят вовсе. Сервер такие фишки игрокам не отдаёт, поле
      // нужно самому мастеру, чтобы отличить заготовку от готовой.
      hidden: Boolean(token.hidden),
      // Свет, который фишка испускает сама: факел в руке, костёр под ногами.
      // Ноль — не светит. Мастер гасит свет фишки тем же переключателем, что и
      // видимость самой фишки.
      light: normalizeTokenLight(token.light),
      // Фишка, чьё имя игрокам не показывают: загадочный NPC, босс с именем,
      // которое игроки узнать не должны. Само поле уходит всем, но имя мастеру
      // и игрокам разное — см. tokenForViewer.
      hideName: Boolean(token.hideName),
      // Подписи под фишкой скрыты всем сразу: мастеру тоже. Это не тайна от
      // игроков, а его способ убрать подписи с нагруженной карты, поэтому поле
      // одинаково у всех и тайны здесь нет.
      hideLabels: Boolean(token.hideLabels),
      color: typeof token.color === 'string' ? token.color : TOKEN_PALETTE[0],
      // Размер в клетках: 1 — средний, 2 — большой, 3 — огромный, 4 — исполин.
      // Якорь остаётся центром фишки, поэтому большая фишка растёт от центра.
      size: clampInt(token.size, 1, 4, 1),
      // Прочность. maxHp === null — фишка без здоровья: монетка, метка или
      // просто шарик. У монстра и персонажа она есть.
      maxHp: null,
      hp: null,
      /** Состояния фишки. Видны всем: «сбит с ног» и «парализован» знают все. */
      conditions: conditions,
      // Счётчик раундов для тех состояний, у которых он задан. Он виден всем:
      // игроки по нему понимают, когда опутывание спадёт.
      conditionDurations: normalizeConditionDurations(token.conditionDurations, conditions)
    };
    if (Number.isFinite(Number(token.maxHp)) && Number(token.maxHp) > 0) {
      result.maxHp = clampInt(token.maxHp, 1, LIMITS.maxTokenHp, 1);
      const currentHp = Number(token.hp);
      // Текущее здоровье не равно максимуму при загрузке, и оно не может быть
      // вне 0..maxHp: урон ниже нуля и лечение выше максимума не приводят.
      result.hp = Number.isFinite(currentHp) ? clampInt(currentHp, 0, result.maxHp, 0) : result.maxHp;
    }
    return result;
  }

  /**
   * Задаёт состояния фишки.
   *
   * В отличие от прочности, состояния видны и игрокам: по «сбит с ног» и
   * «парализован» всё видно и сразу, скрывать тут нечего.
   * @param {object} token
   * @param {unknown} list
   * @returns {object} Обновлённая фишка.
   */
  setTokenConditions(token, list, durations) {
    token.conditions = normalizeConditions(list);
    token.conditionDurations = normalizeConditionDurations(durations, token.conditions);
    return token;
  }

  /**
   * Состояние, из-за которого фишкой нельзя пошевелить, или null.
   *
   * Проверка живёт здесь, а не в интерфейсе: игрок может прислать движение
   * напрямую, минуя карту, и сервер обязан отказать. Возвращаем само состояние,
   * чтобы отказ был понятен игроку, а не выглядел ошибкой.
   * @param {object} token
   * @returns {object|null}
   */
  moveBlocker(token) {
    return conditionBlocksMove(token && token.conditions);
  }

  /**
   * Меняет прочность фишки.
   *
   * Ноль означает павшего: такую фишку видно, но водить её незачем. Прочность
   * ведёт мастер, а игрок правит своё здоровье в листе персонажа: две правки
   * одного и того же числа разошлись бы, и в бою никто не понял бы, где
   * правда.
   * @param {object} token
   * @param {number} value Новое здоровье.
   * @returns {object} Обновлённая фишка.
   */
  setTokenHp(token, value) {
    if (token.maxHp === null || token.maxHp === undefined) return token;
    const next = Math.round(Number(value));
    if (!Number.isFinite(next)) return token;
    token.hp = clampInt(next, 0, token.maxHp, 0);
    return token;
  }

  /** @returns {object} сериализуемое состояние для сохранения в кампанию */
  serialize() {
    const players = [];
    for (const player of this.players.values()) {
      players.push({
        playerId: player.playerId,
        name: player.name,
        role: player.role,
        playerKey: player.playerKey || '',
        avatar: player.avatar || null,
        // Заметка мастера едет в кампании вместе с игроком. Без неё мастер
        // терял все свои заготовки при первом же сохранении.
        dmNote: player.dmNote || '',
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
      activeMapId: this.activeMapId,
      grid: this.grid,
      tokens: this.tokens,
      // Порядок боя видят все: он и есть объявление для игроков.
      initiative: this.initiative,
      // Режим боя видят все: по нему и ходят по клеткам.
      combat: this.combat,
      diceHistory: this.diceHistory.slice(-LIMITS.maxDiceHistory),
      chatHistory: this.chatHistory.slice(-LIMITS.maxChatHistory),
      journal: this.journal,
      journalEntries: this.journalEntries,
      inventory: this.inventory,
      rollRequests: this.rollRequests,
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
   * @param {string} [playerKey] секрет личности, выданный сервером при входе
   * @returns {object}
   */
  addPlayer(playerId, name, playerKey = '') {
    let player = this.players.get(playerId);
    if (!player) {
      player = {
        playerId,
        name,
        role: ROLE_PLAYER,
        playerKey: playerKey || '',
        avatar: null,
        online: false,
        sockets: new Set(),
        joinedAt: new Date().toISOString()
      };
      this.players.set(playerId, player);
      this.sheets.set(playerId, createEmptySheet(name));
      this.markDirty();
    } else {
      player.name = name;
      // Стол старого формата: ключа ещё не было, закрепляем его за игроком
      // при первом входе, дальше личность защищена.
      if (playerKey && !player.playerKey) player.playerKey = playerKey;
      this.markDirty();
    }
    return player;
  }

  /**
   * Фишка в том виде, в каком её видит конкретный зритель.
   *
   * Прочность монстров игрокам не показывается: её ведёт мастер у себя, и
   * игрокам достаточно видеть, что монстр на поле есть и где он стоит. Фишки
   * игроков показываем всем, включая их прочность: урон наносится открыто, и по
   * полоске видно, кто ещё держится на ногах.
   *
   * Имя скрытой фишки игрокам тоже не достаётся. Замена на пустую строку, а не
   * флаг «не показывать», сделана умышленно: флаг прячет подпись в интерфейсе,
   * а само имя остаётся в снимке состояния и в каждом событии фишки, то есть
   * мастер спрятал бы его от себя же.
   *
   * Прячем на сервере, а не в интерфейсе: иначе число утекло бы в снимок
   * состояния, который игрок получает целиком, и в историю событий фишки.
   * @param {object} token
   * @param {boolean} isDm
   * @returns {object}
   */
  tokenForViewer(token, isDm) {
    if (isDm || !token) return token;
    const patch = {};
    // Прочность прячем только у монстров: у фишки игрока она и так у всех.
    if (token.maxHp && !token.assignedPlayerId) {
      patch.maxHp = null;
      patch.hp = null;
    }
    if (token.hideName) {
      // Подпись и буква в кружке рисуются по имени, поэтому игрок получает
      // пустую строку и флаг: по флагу интерфейс ставит «?» вместо буквы и
      // не рисует подпись вовсе.
      patch.name = '';
      patch.nameHidden = true;
    }
    return Object.keys(patch).length ? { ...token, ...patch } : token;
  }

   /**
   * Меняет имя участника стола.
   *
   * Переименовать можно только себя: игроку не нужно править имя соседа, а
   * мастеру тем более. Лист персонажа правится тоже, но лишь тогда, когда в
   * нём было именно прежнее имя: вписанное руками имя персонажа важнее, и
   * затирать его сменой имени участника нельзя.
   * @param {string} playerId
   * @param {string} name
   * @returns {object|null} Обновлённая запись или null, если участника нет.
   */
  renamePlayer(playerId, name) {
    const player = this.players.get(String(playerId || ''));
    if (!player) return null;
    const previous = player.name;
    player.name = name;
    const sheet = this.sheets.get(player.playerId);
    if (sheet && sheet.playerName === previous) sheet.playerName = name;
    this.markDirty();
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
        playerKey: '',
        avatar: null,
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
  /**
   * Список участников для рассылки и для снимка состояния.
   *
   * Параметры собраны в объект, потому что их три и все они про_bool: на
   * позиционных флагах легко перепутать местами и молча отдать игрокам то,
   * что задумано мастеру.
   * @param {{includeTokens?: boolean, includeDmNotes?: boolean, includeHidden?: boolean}} [options]
   * @returns {object[]}
   */
  playerList(options = {}) {
    const {
      includeTokens = true,
      includeDmNotes = false,
      // Скрытые фишки игрокам не показываются, а мастеру показываются: иначе
      // у него в списке участников горела бы вечная отметка «вывести фишку»
      // для игрока, которому фишка уже выведена, но ещё скрыта.
      includeHidden = false
    } = typeof options === 'boolean' ? { includeTokens: options } : options || {};
    const list = [];
    // Кто на какой фишке: раньше внутри цикла по игрокам искали фишку поиском,
    // то есть на каждой рассылке списка выполнялось «игроки × фишки». Словарь
    // строится один раз, а список игроков перебирается один раз.
    const tokenIdByPlayer = new Map();
    if (includeTokens) {
      for (const token of this.tokens) {
        // Мастеру показываем заготовки на скрытых картах, игроку — только
        // фишки, которые он действительно может увидеть за столом.
        if (!includeHidden && !this.isTokenVisibleToPlayers(token)) continue;
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
        // Аватар видит весь стол, и это нормально: картинка не раскрывает
        // ничего из листа персонажа. Ссылка /files/... или путь из поставки.
        avatar: player.avatar || (player.role === ROLE_DM ? DEFAULT_DM_AVATAR : null),
        online: player.online,
        hasSheet: this.sheets.has(player.playerId),
        // Заметка мастера игрокам не отдаётся: в этом весь её смысл. Поле у всех,
        // но игрокам пустое, чтобы форма записи не прыгала, когда мастер
        // переключает окно между листом и списком.
        dmNote: includeDmNotes ? (player.dmNote || '') : '',
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
      players: this.playerList({ includeTokens: true, includeDmNotes: isDm, includeHidden: isDm }),
      sheets,
      maps: this.mapsForViewer(isDm),
      // Показывать игрокам нечего, пока мастер не открыл карту: activeMap
      // без activeMapId означал бы «вкладка выбрана, но карты на ней нет».
      activeMap: isDm ? this.activeMap : (this.activeMapId ? this.activeMap : null),
      activeMapId: this.activeMapId,
      grid: this.grid,
      // Скрытые фишки — заготовки мастера, и игрокам их видеть нельзя.
      // Фильтруем здесь, а не в интерфейсе: иначе фишка утекает в снимок
      // состояния, который игрок получает целиком.
      tokens: isDm
        ? this.tokens
        : this.tokens
          // Заготовка карты и фишки на ней игроку не достаются: иначе сама
          // карта была бы скрыта, а монстр на ней выдал бы будущую сцену.
          .filter((token) => this.isTokenVisibleToPlayers(token))
          .map((token) => this.tokenForViewer(token, isDm)),
      // Порядок боя общий: мастер его объявляет, и игроки видят, кто ходит.
      initiative: this.initiative,
      // Режим боя тоже общий: иначе один участник ходил бы по клеткам, а
      // второй перетаскивал бы фишку свободно.
      combat: this.combat,
      // Тайный бросок мастера хранится целиком: файл кампании и снимок для
      // мастера должны видеть число. Игроку достаётся бросок без результата —
      // иначе «слепой» бросок утечёт в состояние, которое игрок получает целиком.
      diceHistory: this.diceHistory.slice(-LIMITS.maxDiceHistory)
        .map((roll) => (isDm ? roll : diceModule.hideRollResult(roll))),
      // Шёпот игрока мастеру отдаём только мастеру и самому игроку: остальным
      // его не видно ни в ленте, ни после переподключения.
      chatHistory: this.chatHistory.slice(-LIMITS.maxChatHistory)
        .filter((message) => isDm || !message.whisper || message.playerId === viewer.playerId),
      // Журнал кампании — заготовки мастера. Игроку он не нужен и не должен
      // утекать в снимок состояния.
      journal: isDm ? this.journal : '',
      journalEntries: isDm ? this.journalEntries : [],
      inventory: this.inventory,
      rollRequests: this.rollRequests
    };
  }

  saveJournalEntry(input) {
    const entry = normalizeJournalEntry(input);
    if (!entry) return null;
    const index = this.journalEntries.findIndex((item) => item.id === entry.id);
    if (index >= 0) {
      this.journalEntries[index] = entry;
    } else {
      this.journalEntries.push(entry);
      if (this.journalEntries.length > LIMITS.maxJournalEntries) this.journalEntries.shift();
    }
    this.markDirty();
    return entry;
  }

  deleteJournalEntry(id) {
    const next = this.journalEntries.filter((item) => item.id !== id);
    if (next.length === this.journalEntries.length) return false;
    this.journalEntries = next;
    this.markDirty();
    return true;
  }

  saveInventoryItem(input) {
    const item = normalizeInventoryItem(input);
    if (!item) return null;
    const index = this.inventory.findIndex((entry) => entry.id === item.id);
    if (index >= 0) {
      this.inventory[index] = item;
    } else {
      this.inventory.push(item);
      if (this.inventory.length > LIMITS.maxInventoryItems) this.inventory.shift();
    }
    this.markDirty();
    return item;
  }

  deleteInventoryItem(id) {
    const next = this.inventory.filter((item) => item.id !== id);
    if (next.length === this.inventory.length) return false;
    this.inventory = next;
    this.markDirty();
    return true;
  }

  addRollRequest(input) {
    const request = normalizeRollRequest(input);
    if (!request) return null;
    this.rollRequests.push(request);
    if (this.rollRequests.length > LIMITS.maxRollRequests) this.rollRequests.shift();
    this.markDirty();
    return request;
  }

  clearRollRequest(id) {
    const next = this.rollRequests.filter((item) => item.id !== id);
    if (next.length === this.rollRequests.length) return false;
    this.rollRequests = next;
    this.markDirty();
    return true;
  }

  pushUndo() {
    this.undoStack.push(JSON.stringify({
      maps: this.maps,
      tokens: this.tokens,
      initiative: this.initiative,
      // Какая карта показана, живёт отдельно от вкладок: без этих двух полей
      // отмена показа карты вернула бы заготовку, но оставила её на столе.
      activeMap: this.activeMap,
      activeMapId: this.activeMapId
    }));
    if (this.undoStack.length > 20) this.undoStack.shift();
  }

  undoLast() {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return false;
    const data = JSON.parse(snapshot);
    this.maps = data.maps;
    this.tokens = data.tokens;
    this.initiative = data.initiative;
    if ('activeMap' in data) this.activeMap = data.activeMap;
    if ('activeMapId' in data) this.activeMapId = data.activeMapId;
    this.markDirty();
    return true;
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

const JOURNAL_KINDS = ['npc', 'location', 'quest', 'faction', 'item'];

function newJournalId() {
  return `j-${crypto.randomBytes(6).toString('hex')}`;
}

function newInventoryId() {
  return `i-${crypto.randomBytes(6).toString('hex')}`;
}

function newRollRequestId() {
  return `r-${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeJournalTags(value) {
  const tags = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const tag = sanitizeText(raw, LIMITS.maxJournalTag).trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= LIMITS.maxJournalTags) break;
  }
  return tags;
}

function normalizeJournalEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const title = sanitizeText(entry.title, LIMITS.maxJournalTitle).trim();
  if (!title) return null;
  const id = typeof entry.id === 'string' && /^j-[0-9a-f]{12}$/.test(entry.id)
    ? entry.id
    : newJournalId();
  return {
    id,
    kind: JOURNAL_KINDS.includes(entry.kind) ? entry.kind : 'npc',
    title,
    text: sanitizeText(entry.text, LIMITS.maxJournalText),
    tags: normalizeJournalTags(entry.tags),
    updatedAt: new Date().toISOString()
  };
}

function normalizeJournalEntries(list) {
  const entries = [];
  for (const item of Array.isArray(list) ? list : []) {
    const entry = normalizeJournalEntry(item);
    if (entry) entries.push(entry);
    if (entries.length >= LIMITS.maxJournalEntries) break;
  }
  return entries;
}

function normalizeInventoryItem(item) {
  if (!item || typeof item !== 'object') return null;
  const name = sanitizeText(item.name, LIMITS.maxInventoryName).trim();
  if (!name) return null;
  const id = typeof item.id === 'string' && /^i-[0-9a-f]{12}$/.test(item.id)
    ? item.id
    : newInventoryId();
  const qty = Number.isFinite(Number(item.qty)) ? Math.round(Number(item.qty)) : 1;
  const weight = Number.isFinite(Number(item.weight)) ? Number(item.weight) : 0;
  return {
    id,
    name,
    qty: Math.max(0, Math.min(9999, qty)),
    weight: Math.round(Math.max(0, Math.min(99999, weight)) * 100) / 100,
    ownerId: typeof item.ownerId === 'string' ? item.ownerId.slice(0, 64) : '',
    attunement: Boolean(item.attunement),
    notes: sanitizeText(item.notes, LIMITS.maxInventoryNotes)
  };
}

function normalizeInventory(list) {
  const items = [];
  for (const item of Array.isArray(list) ? list : []) {
    const entry = normalizeInventoryItem(item);
    if (entry) items.push(entry);
    if (items.length >= LIMITS.maxInventoryItems) break;
  }
  return items;
}

function normalizeRollRequest(item) {
  if (!item || typeof item !== 'object') return null;
  const label = sanitizeText(item.label, 120).trim();
  if (!label) return null;
  const rawDc = item.dc === null || item.dc === undefined || item.dc === '' ? null : Number(item.dc);
  const id = typeof item.id === 'string' && /^r-[0-9a-f]{12}$/.test(item.id)
    ? item.id
    : newRollRequestId();
  return {
    id,
    label,
    dc: rawDc === null || !Number.isFinite(rawDc) ? null : Math.max(1, Math.min(40, Math.round(rawDc))),
    formula: sanitizeText(item.formula, 120).trim(),
    createdAt: new Date().toISOString(),
    by: sanitizeText(item.by, 40).trim()
  };
}

function normalizeRollRequests(list) {
  const requests = [];
  for (const item of Array.isArray(list) ? list : []) {
    const request = normalizeRollRequest(item);
    if (request) requests.push(request);
    if (requests.length >= LIMITS.maxRollRequests) break;
  }
  return requests;
}

module.exports = {
  ABILITY_KEYS,
  ABILITY_LABELS,
  CAMPAIGN_FORMAT_VERSION,
  DEFAULT_DM_AVATAR,
  DICE_SIDES,
  DM_PLAYER_ID,
  INITIATIVE,
  GRID,
  LIMITS,
  MAP_TYPES,
  ROLE_DM,
  ROLE_PLAYER,
  SKILLS,
  TEMPLATE_KINDS,
  TEMPLATE_LIMITS,
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
  normalizeStatblock,
  normalizeDarkness,
  normalizeTemplate,
  normalizeTemplates,
  normalizeTokenLight,
  proficiencyBonus,
  sanitizeText
};
