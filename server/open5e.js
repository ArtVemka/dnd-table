'use strict';

/**
 * Импорт монстров из Open5e.
 *
 * Модуль ничего не знает про окно и кампанию: он умеет только искать,
 * скачивать карточку и переводить её. Файловые операции и добавление в
 * справочник делает main-процесс.
 *
 * Open5e отдаёт только английские названия, поэтому запрос на русском сначала
 * переводится. Для частых монстров есть словарь: он отвечает мгновенно и не
 * зависит от переводчика. Остальное переводит публичный сервис Google, а если
 * он недоступен — MyMemory. Когда не вышло ни то, ни другое, карточка
 * сохраняется на английском: импорт важнее идеального перевода.
 */

const { LIMITS } = require('./state');
const { decodeImage } = require('./image');

const API = 'https://api.open5e.com/v2/creatures/';
const REQUEST_TIMEOUT = 12_000;
const IMAGE_TIMEOUT = 15_000;
const MAX_RESULTS = 12;
const MAX_TRANSLATE_CHUNK = 1400;

/** Частые монстры: русское название → английское. */
const RU_TO_EN = {
  гоблин: 'Goblin',
  гоблина: 'Goblin',
  гоблины: 'Goblin',
  'гоблин-вожак': 'Goblin Boss',
  орк: 'Orc',
  орка: 'Orc',
  орки: 'Orc',
  хобгоблин: 'Hobgoblin',
  кобольд: 'Kobold',
  гнолл: 'Gnoll',
  багбир: 'Bugbear',
  огр: 'Ogre',
  тролль: 'Troll',
  циклоп: 'Cyclops',
  скелет: 'Skeleton',
  зомби: 'Zombie',
  упырь: 'Ghoul',
  гуль: 'Ghoul',
  вампир: 'Vampire',
  лич: 'Lich',
  мумия: 'Mummy',
  призрак: 'Ghost',
  спектр: 'Specter',
  тень: 'Shadow',
  волк: 'Wolf',
  'дикий волк': 'Dire Wolf',
  медведь: 'Bear',
  'бурый медведь': 'Brown Bear',
  'пещерный медведь': 'Cave Bear',
  тигр: 'Tiger',
  лев: 'Lion',
  пантера: 'Panther',
  крыса: 'Giant Rat',
  'гигантская крыса': 'Giant Rat',
  паук: 'Giant Spider',
  'гигантский паук': 'Giant Spider',
  змея: 'Snake',
  'ядовитая змея': 'Poisonous Snake',
  крокодил: 'Crocodile',
  акула: 'Shark',
  осьминог: 'Octopus',
  краб: 'Crab',
  орёл: 'Eagle',
  ястреб: 'Hawk',
  сова: 'Owl',
  ворон: 'Raven',
  'летучая мышь': 'Bat',
  коза: 'Goat',
  лошадь: 'Horse',
  мул: 'Mule',
  слон: 'Elephant',
  мамонт: 'Mammoth',
  дракон: 'Dragon',
  'красный дракон': 'Red Dragon',
  'синий дракон': 'Blue Dragon',
  'зелёный дракон': 'Green Dragon',
  'черный дракон': 'Black Dragon',
  'чёрный дракон': 'Black Dragon',
  'белый дракон': 'White Dragon',
  'бронзовый дракон': 'Bronze Dragon',
  'серебряный дракон': 'Silver Dragon',
  'золотой дракон': 'Gold Dragon',
  'медный дракон': 'Copper Dragon',
  'латунный дракон': 'Brass Dragon',
  'молодой красный дракон': 'Young Red Dragon',
  'взрослый красный дракон': 'Adult Red Dragon',
  'древний красный дракон': 'Ancient Red Dragon',
  демон: 'Demon',
  дьявол: 'Devil',
  бес: 'Imp',
  суккуб: 'Succubus',
  инкуб: 'Incubus',
  дроу: 'Drow',
  эльф: 'Elf',
  дварф: 'Dwarf',
  полурослик: 'Halfling',
  гном: 'Gnome',
  человек: 'Human',
  полуорк: 'Half-Orc',
  полуэльф: 'Half-Elf',
  тифлинг: 'Tiefling',
  аасимар: 'Aasimar',
  ангел: 'Angel',
  небожитель: 'Celestial',
  элементаль: 'Elemental',
  голем: 'Golem',
  конструкт: 'Construct',
  слизь: 'Ooze',
  растение: 'Plant',
  нежить: 'Undead',
  чудовище: 'Monstrosity',
  зверь: 'Beast',
  аберрация: 'Aberration',
  фея: 'Fey',
  исчадие: 'Fiend',
  великан: 'Giant',
  гуманоид: 'Humanoid',
  бандит: 'Bandit',
  разбойник: 'Bandit',
  культист: 'Cultist',
  стражник: 'Guard',
  солдат: 'Soldier',
  рыцарь: 'Knight',
  маг: 'Mage',
  жрец: 'Priest',
  друид: 'Druid',
  варвар: 'Berserker',
  ассасин: 'Assassin',
  пират: 'Pirate',
  наёмник: 'Mercenary',
  крестьянин: 'Commoner',
  дворянин: 'Noble',
  торговец: 'Merchant'
};

const TYPE_RU = {
  aberration: 'Аберрация',
  beast: 'Зверь',
  celestial: 'Небожитель',
  construct: 'Конструкт',
  dragon: 'Дракон',
  elemental: 'Элементаль',
  fey: 'Фея',
  fiend: 'Исчадие',
  giant: 'Великан',
  humanoid: 'Гуманоид',
  monstrosity: 'Чудовище',
  ooze: 'Слизь',
  plant: 'Растение',
  undead: 'Нежить'
};

const SIZE_RU = {
  tiny: 'Крошечный',
  small: 'Маленький',
  medium: 'Средний',
  large: 'Большой',
  huge: 'Огромный',
  gargantuan: 'Громадный'
};

const SIZE_CELLS = {
  tiny: 1,
  small: 1,
  medium: 1,
  large: 2,
  huge: 3,
  gargantuan: 4
};

const ACTION_SECTIONS = [
  ['ACTION', 'Действия'],
  ['BONUS_ACTION', 'Бонусные действия'],
  ['REACTION', 'Реакции'],
  ['LEGENDARY_ACTION', 'Легендарные действия'],
  ['MYTHIC_ACTION', 'Мифические действия']
];

/** Поправки после машинного перевода: термины, которые он путает. */
const TERM_FIXES = [
  [/класс[а-я]* доспеха/gi, 'КД'],
  [/очк[а-я]* здоровья/gi, 'хиты'],
  [/цимитар[а-я]*/gi, 'ятаган'],
  [/шипаст[а-я]* щит[а-я]*/gi, 'шипастый щит'],
  [/режущ([а-я]*)/gi, 'рубящ$1'],
  [/достижение (\d+) фут/gi, 'дистанция $1 фут'],
  [/\bScimitar\b/gi, 'Ятаган'],
  [/\bShortbow\b/gi, 'Короткий лук'],
  [/\bLongbow\b/gi, 'Длинный лук'],
  [/\bShortsword\b/gi, 'Короткий меч'],
  [/\bLongsword\b/gi, 'Длинный меч'],
  [/\bGreatsword\b/gi, 'Двуручный меч'],
  [/\bDagger\b/gi, 'Кинжал'],
  [/\bMace\b/gi, 'Булава'],
  [/\bSpear\b/gi, 'Копьё'],
  [/\bBite\b/gi, 'Укус'],
  [/\bClaw\b/gi, 'Коготь'],
  [/\bSlam\b/gi, 'Удар'],
  [/\bMultiattack\b/gi, 'Мультиатака']
];

/** Названия языков, которые переводчик склеивает в одно слово. */
const LANGUAGE_RU = {
  common: 'Обычный',
  goblin: 'Гоблин',
  elvish: 'Эльфийский',
  dwarvish: 'Дварфийский',
  draconic: 'Драконий',
  infernal: 'Инфернальный',
  celestial: 'Небесный',
  abyssal: 'Бездный',
  orc: 'Орочий',
  giant: 'Великаний',
  sylvan: 'Сильван',
  undercommon: 'Подземный',
  'deep speech': 'Глубинная речь',
  gnomish: 'Гномий',
  halfling: 'Полуросличий',
  primordial: 'Первичный',
  aquan: 'Акван',
  auran: 'Ауран',
  ignan: 'Игнан',
  terran: 'Терран'
};

const searchCache = new Map();
const translationCache = new Map();
const nameCache = new Map();

function normalizeRu(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasCyrillic(value) {
  return /[а-яё]/i.test(String(value || ''));
}

function formatCr(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value || '');
  if (number === 0.125) return '1/8';
  if (number === 0.25) return '1/4';
  if (number === 0.5) return '1/2';
  return String(number);
}

function sizeToCells(sizeKey) {
  return SIZE_CELLS[String(sizeKey || '').toLowerCase()] || 1;
}

function formatSpeed(speed) {
  if (!speed) return '';
  if (typeof speed === 'string') return speed;
  const labels = { walk: '', fly: 'полёт', swim: 'плавание', climb: 'лазание', burrow: 'копание' };
  const parts = [];
  for (const key of ['walk', 'fly', 'swim', 'climb', 'burrow']) {
    const value = Number(speed[key]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const label = labels[key];
    parts.push(`${label ? `${label} ` : ''}${value} фт`);
  }
  return parts.join(', ');
}

function sectionTitle(type) {
  const found = ACTION_SECTIONS.find(([key]) => key === type);
  return found ? found[1] : 'Действия';
}

/**
 * Переводит запрос на английский. Словарь отвечает без сети, остальное —
 * через переводчик. Если перевод не удался, возвращается исходная строка.
 * @param {string} query
 * @returns {Promise<{english: string, translated: boolean, via: string}>}
 */
async function resolveEnglish(query) {
  const text = String(query || '').trim();
  if (!text) return { english: '', translated: false, via: 'empty' };
  if (!hasCyrillic(text)) return { english: text, translated: false, via: 'latin' };

  const key = normalizeRu(text);
  if (RU_TO_EN[key]) return { english: RU_TO_EN[key], translated: true, via: 'dictionary' };

  const translated = await translate(text, 'ru', 'en');
  if (translated) return { english: translated, translated: true, via: 'api' };
  return { english: text, translated: false, via: 'failed' };
}

function searchUrl(english) {
  return `${API}?name__icontains=${encodeURIComponent(english)}&limit=40`;
}

/** Поисковый запрос для арта: ровно то, что просил пользователь. */
function artQuery(name) {
  return `${String(name || '').trim()} D&D art`.trim();
}

/** Прямая ссылка на картинку или пустая строка. Локальные пути Open5e тоже понимаем. */
function normalizeImageUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let text = value.trim();
  if (text.startsWith('/')) text = `https://api.open5e.com${text}`;
  try {
    const url = new URL(text);
    if (!/^https?:$/.test(url.protocol) || isPrivateHost(url.hostname)) return '';
    return url.toString().slice(0, 2048);
  } catch {
    return '';
  }
}

function pickOpenverseImage(data) {
  return collectOpenverseImages(data)[0] || null;
}

function collectOpenverseImages(data) {
  const results = data && Array.isArray(data.results) ? data.results : [];
  return results.map((item) => {
    const url = normalizeImageUrl(item && item.url);
    if (!url) return null;
    const license = String(item.license || '').toUpperCase();
    return {
      url,
      thumb: normalizeImageUrl(item.thumbnail) || url,
      source: 'Openverse',
      credit: [item.title, item.creator, license ? `CC ${license}` : '']
        .filter(Boolean).join(' · ') || 'Openverse'
    };
  }).filter(Boolean);
}

function pickFandomImage(data) {
  return collectFandomImages(data)[0] || null;
}

function collectFandomImages(data) {
  const pages = data && data.query && data.query.pages
    ? Object.values(data.query.pages).sort((left, right) => (left.index || 0) - (right.index || 0))
    : [];
  return pages.map((page) => {
    const media = page.thumbnail || page.original;
    const url = normalizeImageUrl(media && media.source);
    if (!url) return null;
    if (Number(media.width) > 0 && Number(media.width) < 200) return null;
    return {
      url,
      thumb: normalizeImageUrl(page.thumbnail && page.thumbnail.source) || url,
      source: 'Forgotten Realms Wiki',
      credit: String(page.title || 'Forgotten Realms Wiki')
    };
  }).filter(Boolean);
}

function pickGoogleImage(data) {
  return collectGoogleImages(data)[0] || null;
}

function collectGoogleImages(data) {
  const items = data && Array.isArray(data.items) ? data.items : [];
  return items.map((item) => {
    const url = normalizeImageUrl(item && item.link);
    if (!url) return null;
    return {
      url,
      thumb: normalizeImageUrl(item.image && item.image.thumbnailLink) || url,
      source: 'Google',
      credit: [item.title, item.displayLink].filter(Boolean).join(' · ') || 'Google'
    };
  }).filter(Boolean);
}

function pickBingImage(data) {
  return collectBingImages(data)[0] || null;
}

function collectBingImages(data) {
  const items = data && Array.isArray(data.value) ? data.value : [];
  return items.map((item) => {
    const url = normalizeImageUrl(item && item.contentUrl);
    if (!url) return null;
    let host = '';
    try {
      host = item.hostPageUrl ? new URL(item.hostPageUrl).hostname : '';
    } catch {
      host = '';
    }
    return {
      url,
      thumb: normalizeImageUrl(item.thumbnailUrl) || url,
      source: 'Bing',
      credit: [item.name, host].filter(Boolean).join(' · ') || 'Bing'
    };
  }).filter(Boolean);
}

/**
 * Собирает варианты арта. Ключи поиска необязательны: Google и Bing
 * используются, если заданы в окружении. Дальше идут вики Забытых королевств
 * и Openverse: они работают без ключей, поэтому варианты есть всегда.
 * @param {string} query
 * @param {string} [wikiQuery]
 * @returns {Promise<Array<{url: string, thumb: string, source: string, credit: string}>>}
 */
async function findArtworkCandidatesByQuery(query, wikiQuery = query) {
  const text = String(query || '').trim().slice(0, 160);
  if (!text) return [];
  const wikiText = String(wikiQuery || text).trim().slice(0, 120);
  const candidates = [];
  const seen = new Set();
  const add = (list) => {
    for (const item of list || []) {
      if (!item || !item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      candidates.push(item);
    }
  };

  const googleKey = process.env.DND_GOOGLE_IMAGE_KEY;
  const googleCx = process.env.DND_GOOGLE_IMAGE_CX;
  if (googleKey && googleCx) {
    try {
      const url = 'https://www.googleapis.com/customsearch/v1'
        + `?key=${encodeURIComponent(googleKey)}&cx=${encodeURIComponent(googleCx)}`
        + `&searchType=image&num=8&safe=active&q=${encodeURIComponent(text)}`;
      add(collectGoogleImages(await getJson(url)));
    } catch {
      // Идём к следующему источнику.
    }
  }

  const bingKey = process.env.DND_BING_IMAGE_KEY;
  if (bingKey) {
    try {
      const url = 'https://api.bing.microsoft.com/v7.0/images/search'
        + `?q=${encodeURIComponent(text)}&count=8&safeSearch=Moderate`;
      add(collectBingImages(await getJson(url, REQUEST_TIMEOUT, { 'Ocp-Apim-Subscription-Key': bingKey })));
    } catch {
      // Идём к следующему источнику.
    }
  }

  if (candidates.length < 12) {
    // Два источника без ключей запускаем параллельно: иначе предпросмотр
    // ждал бы до 16 секунд, пока они ответят по очереди.
    const [fandom, openverse] = await Promise.all([
      (async () => {
        try {
          const url = 'https://forgottenrealms.fandom.com/api.php?action=query&format=json'
            + `&generator=search&gsrsearch=${encodeURIComponent(wikiText)}&gsrlimit=8`
            + '&prop=pageimages&piprop=thumbnail|original&pithumbsize=800';
          return collectFandomImages(await getJson(url, 8_000));
        } catch {
          return [];
        }
      })(),
      (async () => {
        try {
          const url = 'https://api.openverse.org/v1/images/'
            + `?q=${encodeURIComponent(text)}&page_size=8&mature=false`;
          return collectOpenverseImages(await getJson(url, 8_000));
        } catch {
          return [];
        }
      })()
    ]);
    add(fandom);
    add(openverse);
  }

  return candidates.slice(0, 12);
}

/** Первый вариант: нужен там, где интерфейс ещё не умеет список. */
async function findArtworkByQuery(query, wikiQuery = query) {
  const candidates = await findArtworkCandidatesByQuery(query, wikiQuery);
  return candidates[0] || null;
}

/** Автоматический поиск: запрос «имя D&D art», вики ищет по чистому имени. */
async function findArtwork(name) {
  const plain = String(name || '').trim();
  return findArtworkByQuery(artQuery(plain), plain);
}

async function getJson(url, timeout = REQUEST_TIMEOUT, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', ...headers }
    });
    if (!response.ok) {
      const error = new Error(`Open5e ответил ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} query
 * @returns {Promise<{english: string, translated: boolean, via: string, results: object[]}>}
 */
async function searchCreatures(query) {
  const resolved = await resolveEnglish(query);
  if (!resolved.english) return { ...resolved, results: [] };

  const cacheKey = resolved.english.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 10 * 60_000) {
    return { ...resolved, results: cached.results };
  }

  const data = await getJson(searchUrl(resolved.english));
  const wanted = resolved.english.toLowerCase();
  const results = (Array.isArray(data.results) ? data.results : [])
    .map((creature) => ({
      key: String(creature.key || ''),
      name: String(creature.name || ''),
      type: TYPE_RU[creature.type && creature.type.key] || String((creature.type && creature.type.name) || ''),
      size: SIZE_RU[creature.size && creature.size.key] || String((creature.size && creature.size.name) || ''),
      cr: formatCr(creature.challenge_rating),
      source: String((creature.document && creature.document.display_name)
        || (creature.document && creature.document.name) || 'Open5e'),
      system: String((creature.document && creature.document.gamesystem && creature.document.gamesystem.name) || ''),
      image: typeof creature.illustration === 'string' ? creature.illustration : ''
    }))
    .filter((item) => item.key && item.name)
    .sort((left, right) => {
      const score = (item) => {
        let value = 0;
        if (/5th edition|5e/i.test(item.system)) value += 100;
        if (item.name.toLowerCase() === wanted) value += 50;
        else if (item.name.toLowerCase().startsWith(wanted)) value += 25;
        if (/srd/i.test(item.source)) value += 10;
        return value;
      };
      return score(right) - score(left) || left.name.localeCompare(right.name);
    })
    .slice(0, MAX_RESULTS);

  searchCache.set(cacheKey, { at: Date.now(), results });
  while (searchCache.size > 20) searchCache.delete(searchCache.keys().next().value);
  return { ...resolved, results };
}

/* ------------------------------------------------------------------ перевод */

function splitChunks(text, max) {
  const source = String(text || '').trim();
  if (source.length <= max) return [source];
  const chunks = [];
  let rest = source;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('. ', max);
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.4) cut = max;
    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function translateChunk(text, from, to) {
  const cacheKey = `${from}|${to}|${text}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  const googleUrl = 'https://translate.googleapis.com/translate_a/single'
    + `?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
  try {
    const data = await getJson(googleUrl, REQUEST_TIMEOUT);
    if (Array.isArray(data) && Array.isArray(data[0])) {
      const result = data[0].map((part) => (part && part[0]) || '').join('').trim();
      if (result) {
        translationCache.set(cacheKey, result);
        return result;
      }
    }
  } catch {
    // Пробуем второй сервис ниже.
  }

  const memoryUrl = 'https://api.mymemory.translated.net/get';
  try {
    const parts = splitChunks(text, 450);
    const translated = [];
    for (const part of parts) {
      const data = await getJson(`${memoryUrl}?q=${encodeURIComponent(part)}&langpair=${from}|${to}`, REQUEST_TIMEOUT);
      const result = data && data.responseData && data.responseData.translatedText;
      if (typeof result !== 'string' || !result.trim() || /^MYMEMORY WARNING/i.test(result)) return '';
      translated.push(result.trim());
    }
    const result = translated.join(' ');
    translationCache.set(cacheKey, result);
    return result;
  } catch {
    // Оставляем английский: импорт важнее перевода.
  }
  return '';
}

async function translate(text, from = 'en', to = 'ru') {
  const source = String(text || '').trim();
  if (!source) return '';
  const chunks = splitChunks(source, MAX_TRANSLATE_CHUNK);
  const translated = [];
  for (const chunk of chunks) {
    const result = await translateChunk(chunk, from, to);
    translated.push(result || chunk);
  }
  let result = translated.join(' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (to === 'ru') {
    for (const [pattern, replacement] of TERM_FIXES) result = result.replace(pattern, replacement);
    // Машинный перевод иногда сохраняет markdown-курсив из статблока.
    result = result.replace(/_([^_\n]+)_/g, '$1');
  }
  if (translationCache.size > 400) {
    for (const key of translationCache.keys()) {
      translationCache.delete(key);
      if (translationCache.size <= 300) break;
    }
  }
  return result;
}

async function translateName(name) {
  const source = String(name || '').trim();
  if (!source) return '';
  if (nameCache.has(source)) return nameCache.get(source);
  const reverse = Object.entries(RU_TO_EN).find(([, english]) => english.toLowerCase() === source.toLowerCase());
  const result = reverse ? reverse[0].charAt(0).toUpperCase() + reverse[0].slice(1) : await translate(source, 'en', 'ru');
  nameCache.set(source, result || source);
  return result || source;
}

/**
 * Языки переводим по словарю, а не целиком: иначе «Common, Goblin»
 * превращается в «Обычный гоблин», то есть в один язык вместо двух.
 * @param {string} text
 * @returns {string}
 */
function translateLanguages(text) {
  const source = String(text || '').trim();
  if (!source) return '';
  return source.split(/,\s*/).map((part) => {
    const telepathy = /^telepathy\s+(\d+)\s*ft\.?$/i.exec(part.trim());
    if (telepathy) return `телепатия ${telepathy[1]} фт`;
    const key = part.trim().toLowerCase().replace(/\s+/g, ' ');
    return LANGUAGE_RU[key] || part.trim();
  }).filter(Boolean).join(', ');
}

async function translateEntry(entry) {
  const name = String((entry && entry.name) || '');
  const desc = String((entry && entry.desc) || '');
  if (!name && !desc) return { name: '', desc: '' };
  const combined = `${name}\n${desc}`;
  const result = await translate(combined, 'en', 'ru');
  const lines = result.split('\n');
  if (lines.length > 1) {
    return { ...entry, name: lines.shift().trim() || name, desc: lines.join('\n').trim() || desc };
  }
  const nameRu = name ? await translate(name, 'en', 'ru') : '';
  const descRu = desc ? await translate(desc, 'en', 'ru') : '';
  return { ...entry, name: nameRu || name, desc: descRu || desc };
}

async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const result = new Array(list.length);
  let next = 0;
  const run = async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      result[index] = await worker(list[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, run));
  return result;
}

/* --------------------------------------------------------------- карточка */

function formatActions(actions) {
  const sections = new Map();
  const list = [...(actions || [])].sort((left, right) => {
    const a = Number(left && left.order_in_statblock);
    const b = Number(right && right.order_in_statblock);
    if (!Number.isFinite(a) && !Number.isFinite(b)) return 0;
    if (!Number.isFinite(a)) return 1;
    if (!Number.isFinite(b)) return -1;
    return a - b;
  });
  for (const action of list) {
    const title = sectionTitle(action && action.action_type);
    if (!sections.has(title)) sections.set(title, []);
    sections.get(title).push(action);
  }
  const order = ACTION_SECTIONS.map(([, title]) => title);
  const parts = [];
  for (const title of order) {
    const list = sections.get(title);
    if (!list || !list.length) continue;
    const lines = list.map((entry) => {
      const name = String((entry && entry.name) || '').trim();
      const desc = String((entry && entry.desc) || '').trim();
      return name ? `${name}. ${desc}`.trim() : desc;
    }).filter(Boolean);
    if (lines.length) parts.push(`${title}:\n${lines.join('\n\n')}`);
  }
  return parts.join('\n\n');
}

function formatTraits(traits) {
  return (traits || []).map((entry) => {
    const name = String((entry && entry.name) || '').trim();
    const desc = String((entry && entry.desc) || '').trim();
    return name ? `${name}. ${desc}`.trim() : desc;
  }).filter(Boolean).join('\n\n');
}

function formatSenses(creature) {
  const parts = [];
  if (Number(creature.darkvision_range) > 0) parts.push(`тёмное зрение ${creature.darkvision_range} фт`);
  if (Number(creature.blindsight_range) > 0) parts.push(`слепое зрение ${creature.blindsight_range} фт`);
  if (Number(creature.tremorsense_range) > 0) parts.push(`чувство вибрации ${creature.tremorsense_range} фт`);
  if (Number(creature.truesight_range) > 0) parts.push(`истинное зрение ${creature.truesight_range} фт`);
  if (Number(creature.passive_perception) > 0) parts.push(`пассивная внимательность ${creature.passive_perception}`);
  return parts.join(', ');
}

/**
 * Собирает карточку из ответа Open5e. Переведённые куски передаются отдельно:
 * так функцию можно проверить без сети.
 * @param {object} creature
 * @param {{name?: string, actions?: object[], traits?: object[], languages?: string, resistances?: string, conditions?: string}} [texts]
 * @returns {{actor: object, meta: object}}
 */
function buildActor(creature, texts = {}) {
  const source = creature && typeof creature === 'object' ? creature : {};
  const actions = Array.isArray(texts.actions) ? texts.actions : (source.actions || []);
  const traits = Array.isArray(texts.traits) ? texts.traits : (source.traits || []);
  const abilitiesRaw = source.ability_scores || {};
  const abilities = {
    str: Number(abilitiesRaw.strength) || 10,
    dex: Number(abilitiesRaw.dexterity) || 10,
    con: Number(abilitiesRaw.constitution) || 10,
    int: Number(abilitiesRaw.intelligence) || 10,
    wis: Number(abilitiesRaw.wisdom) || 10,
    cha: Number(abilitiesRaw.charisma) || 10
  };

  const notes = [];
  const senses = formatSenses(source);
  if (senses) notes.push(`Чувства: ${senses}.`);
  if (texts.languages || (source.languages && source.languages.as_string)) {
    notes.push(`Языки: ${texts.languages || source.languages.as_string}.`);
  }
  const resistances = source.resistances_and_immunities || {};
  if (texts.resistances || resistances.damage_resistances_display) {
    notes.push(`Сопротивления: ${texts.resistances || resistances.damage_resistances_display}.`);
  }
  if (texts.immunities || resistances.damage_immunities_display) {
    notes.push(`Иммунитеты: ${texts.immunities || resistances.damage_immunities_display}.`);
  }
  if (texts.vulnerabilities || resistances.damage_vulnerabilities_display) {
    notes.push(`Уязвимости: ${texts.vulnerabilities || resistances.damage_vulnerabilities_display}.`);
  }
  if (texts.conditions || resistances.condition_immunities_display) {
    notes.push(`Иммунитет к состояниям: ${texts.conditions || resistances.condition_immunities_display}.`);
  }
  const traitText = formatTraits(traits);
  if (traitText) notes.push(`Особенности:\n${traitText}`);

  const statblock = {
    ac: Math.max(0, Math.min(99, Math.round(Number(source.armor_class) || 0))),
    hp: Math.max(0, Math.min(LIMITS.maxTokenHp, Math.round(Number(source.hit_points) || 0))),
    speed: formatSpeed(source.speed),
    size: sizeToCells(source.size && source.size.key),
    cr: formatCr(source.challenge_rating),
    abilities,
    attacks: formatActions(actions).slice(0, LIMITS.maxSheetTextLength),
    notes: notes.join('\n\n').slice(0, LIMITS.maxSheetTextLength)
  };

  const meta = {
    source: String((source.document && (source.document.display_name || source.document.name)) || 'Open5e'),
    system: String((source.document && source.document.gamesystem && source.document.gamesystem.name) || ''),
    type: TYPE_RU[source.type && source.type.key] || String((source.type && source.type.name) || ''),
    size: SIZE_RU[source.size && source.size.key] || String((source.size && source.size.name) || ''),
    cr: formatCr(source.challenge_rating)
  };

  return {
    actor: {
      name: String(texts.name || source.name || 'Монстр').slice(0, LIMITS.maxAdventureTitle),
      type: 'npc',
      image: '',
      statblock,
      sourceId: `open5e:${String(source.key || '')}`
    },
    meta
  };
}

/**
 * Загружает карточку и переводит её. Портрет скачивается параллельно с
 * переводом: две независимые сети не должны ждать друг друга.
 * @param {string} key
 * @returns {Promise<{actor: object, meta: object}>}
 */
async function previewCreature(key) {
  const safeKey = String(key || '').trim();
  if (!/^[a-z0-9_.-]{1,120}$/i.test(safeKey)) {
    const error = new Error('Некорректный идентификатор монстра');
    error.code = 'BAD_KEY';
    throw error;
  }
  const creature = await getJson(`${API}${encodeURIComponent(safeKey)}/`);

  const illustration = normalizeImageUrl(creature.illustration);
  const artworkPromise = illustration
    ? Promise.resolve([{ url: illustration, thumb: illustration, source: 'Open5e', credit: 'Open5e' }])
    : findArtworkCandidatesByQuery(artQuery(creature.name), creature.name);

  const [name, actions, traits, languages, resistances, immunities, vulnerabilities, conditions, images] = await Promise.all([
    translateName(creature.name),
    mapLimit(creature.actions || [], 3, translateEntry),
    mapLimit(creature.traits || [], 3, translateEntry),
    creature.languages && creature.languages.as_string
      ? Promise.resolve(translateLanguages(creature.languages.as_string))
      : Promise.resolve(''),
    creature.resistances_and_immunities && creature.resistances_and_immunities.damage_resistances_display
      ? translate(creature.resistances_and_immunities.damage_resistances_display, 'en', 'ru')
      : Promise.resolve(''),
    creature.resistances_and_immunities && creature.resistances_and_immunities.damage_immunities_display
      ? translate(creature.resistances_and_immunities.damage_immunities_display, 'en', 'ru')
      : Promise.resolve(''),
    creature.resistances_and_immunities && creature.resistances_and_immunities.damage_vulnerabilities_display
      ? translate(creature.resistances_and_immunities.damage_vulnerabilities_display, 'en', 'ru')
      : Promise.resolve(''),
    creature.resistances_and_immunities && creature.resistances_and_immunities.condition_immunities_display
      ? translate(creature.resistances_and_immunities.condition_immunities_display, 'en', 'ru')
      : Promise.resolve(''),
    artworkPromise
  ]);

  const result = buildActor(creature, { name, actions, traits, languages, resistances, immunities, vulnerabilities, conditions });
  const artwork = images[0] || null;
  result.actor.image = artwork ? artwork.url : '';
  result.images = images;
  result.meta.hasImage = Boolean(artwork && artwork.url);
  result.meta.imageSource = artwork ? artwork.source : '';
  result.meta.imageCredit = artwork ? artwork.credit : '';
  return result;
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local')) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host === '[::1]' || host === '::1') return true;
  return false;
}

async function downloadImage(url) {
  const target = normalizeImageUrl(url);
  if (!target) return '';
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return '';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT);
  try {
    const response = await fetch(parsed, { signal: controller.signal, headers: { Accept: 'image/*' } });
    if (!response.ok) return '';
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > LIMITS.maxImageBytes) return '';
    const mime = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!/^image\/(png|jpeg|jpg|webp)$/.test(mime)) return '';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > LIMITS.maxImageBytes) return '';
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpeg';
    const dataUrl = `data:image/${ext};base64,${buffer.toString('base64')}`;
    const decoded = decodeImage(dataUrl);
    return decoded && !decoded.error ? dataUrl : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  RU_TO_EN,
  TYPE_RU,
  SIZE_RU,
  resolveEnglish,
  searchUrl,
  searchCreatures,
  previewCreature,
  buildActor,
  formatCr,
  formatSpeed,
  sizeToCells,
  formatActions,
  formatTraits,
  translateLanguages,
  normalizeRu,
  artQuery,
  normalizeImageUrl,
  pickOpenverseImage,
  pickGoogleImage,
  pickBingImage,
  pickFandomImage,
  collectOpenverseImages,
  collectGoogleImages,
  collectBingImages,
  collectFandomImages,
  findArtwork,
  findArtworkByQuery,
  findArtworkCandidatesByQuery,
  downloadImage
};
