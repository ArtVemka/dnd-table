'use strict';

/**
 * Адаптер Foundry VTT.
 *
 * ВАЖНО: документация форматов Foundry недоступна при разработке, поэтому
 * имена полей ниже — проверяемые предположения, а не гарантия. Всё, что не
 * распознано, попадает в отчёт как «пропущено», а не приводится к виду наугад.
 * Перед этапом 2 нужно снять дамп настоящего файла (docs/ИМПОРТ-ПРИКЛЮЧЕНИЙ.md,
 * раздел 16) и поправить это место.
 *
 * Код из модулей не выполняется: читаются только JSON и картинки.
 */

const { readZipJsonAndAssets, normalizeAssetPath } = require('./zip');
const { importError } = require('../errors');

/**
 * Типы документов, которые мы умеем различать.
 *
 * Ключи — разные написания одного и того же типа: в самом Foundry документ
 * называется `JournalEntry`, а в выгрузке Adventure ссылка лежит под ключом
 * `journal`. Без алиасов заметки молча превращались бы в предметы.
 */
const DOC_TYPES = {
  adventure: 'adventure',
  scene: 'scene',
  actor: 'actor',
  item: 'item',
  journal: 'journal',
  journalentry: 'journal',
  rolltable: 'rolltable',
  macro: 'macro'
};

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** @param {Buffer} buffer */
function looksLikeZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.subarray(0, 4).equals(ZIP_MAGIC);
}

/** @param {Buffer} buffer */
function looksLikeJson(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  for (const byte of buffer.subarray(0, Math.min(buffer.length, 512))) {
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0xef && byte !== 0xbb && byte !== 0xbf) {
      return byte === 0x7b || byte === 0x5b; // { или [
    }
  }
  return false;
}

/** @param {any} value */
function lower(value) {
  return String(value || '').toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Приводит текст поля к строке с переносами строк.
 *
 * В выгрузках встречаются оба вида: `{html}` и `{content}`. Второй — родной
 * для заметок Foundry: там лепят `pages[].text.content`, и раньше мы такой
 * текст теряли, принося в игру пустую заметку.
 */
function richText(value) {
  if (typeof value === 'string') return stripTags(value);
  if (!value || typeof value !== 'object') return '';
  for (const key of ['html', 'content', 'text']) {
    if (typeof value[key] === 'string' && value[key].trim()) return stripTags(value[key]);
  }
  return '';
}

/** Убирает теги, оставляя читаемый текст. */
function stripTags(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Текст заметки приключения.
 *
 * Раньше мы читали только `text.html`, и настоящие выгрузки Foundry
 * импортировались с пустым текстом: в них лепят `pages`, а внутри страницы —
 * `text.content`. Читаем оба варианта: `pages` важнее, одиночный `text`
 * встречается в старых выгрузках и в самодельных файлах.
 *
 * @param {any} doc
 * @returns {string}
 */
function journalText(doc) {
  const pages = Array.isArray(doc && doc.pages) ? doc.pages : [];
  if (pages.length) {
    const chunks = pages
      .map((page) => {
        const title = String(page && page.name ? page.name.trim() : '');
        const body = richText(page && page.text);
        if (!body) return '';
        return title ? `${title}\n${body}` : body;
      })
      .filter(Boolean);
    if (chunks.length) return chunks.join('\n\n');
  }
  return richText(doc && (doc.text ?? doc.description ?? doc.content));
}

/**
 * Достаёт картинку документа.
 *
 * Поле с картинкой у Foundry не одно, и это главная причина, по которой
 * настоящие выгрузки приходили с пустыми сценами:
 *   * `img` — обычные документы (актёры, предметы);
 *   * `background` — сцена; внутри это объект, где путь лежит в `src`
 *     (так делают новые версии) или в `data`/`img` (так было раньше);
 *   * `texture` — токен на сцене, устроен так же, как `background`.
 *
 * @param {any} doc
 * @param {(path: string) => string} [resolveAsset] Возвращает data-URL по пути внутри архива.
 */
function documentImage(doc, resolveAsset) {
  const containers = [doc && doc.img, doc && doc.background, doc && doc.texture, doc && doc.foreground];
  for (const container of containers) {
    if (!container) continue;
    if (typeof container === 'string' && container.trim()) return pick(container.trim(), resolveAsset);
    if (typeof container === 'object') {
      for (const key of ['src', 'data', 'img']) {
        const value = container[key];
        if (typeof value === 'string' && value.trim()) return pick(value.trim(), resolveAsset);
      }
    }
  }
  return '';
}

/**
 * Если это путь внутри выгрузки, достаём картинку из архива.
 * @param {string} value
 * @param {(path: string) => string} [resolveAsset]
 * @returns {string}
 */
function pick(value, resolveAsset) {
  if (typeof resolveAsset === 'function' && !/^data:/i.test(value)) {
    const fromArchive = resolveAsset(value);
    if (fromArchive) return fromArchive;
  }
  return value;
}

/**
 * Токены сцены: позиция в пикселях, пригодится при маппинге.
 * @param {any} doc
 */
function sceneTokens(doc, resolveAsset) {
  const list = Array.isArray(doc && doc.tokens) ? doc.tokens : [];
  return list
    .filter((token) => token && typeof token === 'object')
    .map((token) => {
      // В новых версиях Foundry сам токен часто безымянный, а данные актёра
      // лежат в `delta`. Без этого фишка приезжала бы «без названия».
      const delta = token.delta && typeof token.delta === 'object' ? token.delta : {};
      const name = String(token.name || token.displayName || delta.name || '');
      return {
        kind: 'actor',
        sourceId: String(token._id || token.id || name || ''),
        name,
        image: documentImage(token, resolveAsset),
        raw: {
          x: Number(token.x) || 0,
          y: Number(token.y) || 0,
          width: Number(token.width) || 0,
          height: Number(token.height) || 0,
          actorId: String(token.actorId || ''),
          hidden: Boolean(token.hidden)
        }
      };
    });
}

/** @param {unknown} value @returns {number} */
function statNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Статблок актёра из `system` Foundry. Поля dnd5e лежат по-разному в разных
 * версиях, поэтому читаем оба известных вида и молча пропускаем остальное:
 * лучше показать меньше, чем уронить импорт.
 * @param {any} doc
 * @returns {object|null}
 */
function actorStatblock(doc) {
  if (!doc || (!doc.system && !doc.data)) return null;
  const system = doc.system || doc.data || {};
  const attributes = system.attributes || {};
  const acRaw = attributes.ac;
  const ac = acRaw && typeof acRaw === 'object' ? (acRaw.value ?? acRaw.flat) : acRaw;
  const hpRaw = attributes.hp;
  const hp = hpRaw && typeof hpRaw === 'object' ? (hpRaw.max ?? hpRaw.value) : hpRaw;
  const movement = attributes.movement || {};
  const speedParts = [];
  for (const [key, label] of [['walk', ''], ['fly', 'полёт'], ['swim', 'плавание'],
    ['climb', 'лазание'], ['burrow', 'копание']]) {
    const value = statNumber(movement[key]);
    if (value > 0) speedParts.push(label ? `${label} ${value} фт` : `${value} фт`);
  }
  const abilities = {};
  const abilitiesRaw = system.abilities || {};
  for (const key of ['str', 'dex', 'con', 'int', 'wis', 'cha']) {
    const entry = abilitiesRaw[key];
    const value = statNumber(entry && typeof entry === 'object' ? entry.value : entry);
    abilities[key] = value > 0 ? value : 10;
  }
  return {
    ac: statNumber(ac),
    hp: statNumber(hp),
    speed: speedParts.join(', '),
    size: 1,
    cr: String((system.details && system.details.cr) || ''),
    abilities,
    attacks: '',
    notes: ''
  };
}

/**
 * Приводит один документ Foundry к плоскому описанию.
 * @param {any} doc
 * @param {string} [fallbackKind]
 */
function describeDocument(doc, fallbackKind, resolveAsset) {
  const type = lower(doc && (doc.type || doc.documentName)) || lower(fallbackKind);
  const raw = doc && typeof doc === 'object' ? doc : {};
  // Неизвестный тип не превращаем молча в предмет: такой документ попадёт
  // в отчёт как пропущенный, и ДМ увидит, что содержимое осталось за бортом.
  const kind = DOC_TYPES[type] || 'unknown';

  return {
    kind,
    sourceId: String(raw._id || raw.id || raw.name || ''),
    name: String(raw.name || ''),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    image: documentImage(raw, resolveAsset),
      children: kind === 'scene' ? sceneTokens(raw, resolveAsset) : [],
    raw: {
      text: kind === 'journal' ? journalText(raw) : richText(raw.text ?? raw.description ?? raw.content),
      type: String(raw.type || ''),
      formula: String(raw.formula || ''),
      sceneWidth: Number(raw.width) || 0,
      sceneHeight: Number(raw.height) || 0,
      statblock: kind === 'actor' ? actorStatblock(raw) : undefined
    }
  };
}

/**
 * Разворачивает содержимое Adventure: внутри лежат ссылки на сцены и акты.
 * @param {any} doc
 * @param {(path: string) => string} [resolveAsset]
 */
function describeAdventure(doc, resolveAsset) {
  const out = [];
  const push = (entry, kind, resolveAsset) => {
    if (!entry) return;
    const item = typeof entry === 'string' ? { _id: entry } : entry;
    out.push(describeDocument({ ...item, type: kind }, kind, resolveAsset));
  };

  for (const sceneId of Array.isArray(doc.scenes) ? doc.scenes : []) push(sceneId, 'scene', resolveAsset);
  for (const actorId of Array.isArray(doc.actors) ? doc.actors : []) push(actorId, 'actor', resolveAsset);
  for (const itemId of Array.isArray(doc.items) ? doc.items : []) push(itemId, 'item', resolveAsset);
  for (const journalId of Array.isArray(doc.journal) ? doc.journal : []) push(journalId, 'journal', resolveAsset);
  for (const tableId of Array.isArray(doc.rollTables) ? doc.rollTables : []) push(tableId, 'rolltable', resolveAsset);
  // Макросы показываем, чтобы ДМ видел: «есть, но не переносится». Сами макросы
  // не выполняются ни при каком сценарии — это исполняемый код из чужого файла.
  for (const macroId of Array.isArray(doc.macros) ? doc.macros : []) push(macroId, 'macro', resolveAsset);
  for (const macroId of Array.isArray(doc.macro) ? doc.macro : []) push(macroId, 'macro', resolveAsset);

  if (!out.length) {
    // Adventure может лежать одним файлом с вложенными документами.
    for (const key of ['scenes', 'actors', 'items', 'journal', 'rollTables']) {
      const list = doc && doc[key];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (entry && typeof entry === 'object' && entry.type) out.push(describeDocument(entry, undefined, resolveAsset));
      }
    }
  }

  return out;
}

/**
 * Собирает функцию, которая по пути вида `assets/карта.webp` находит картинку
 * внутри архива и отдаёт её как data-URL.
 *
 * Foundry в выгруженном приключении пишет путь относительно папки выгрузки.
 * Прямо в zip он может оказаться с любым числом ведущих папок, поэтому ищем не
 * по точному совпадению, а по тому, чем заканчивается путь: это спасает и
 * `assets/x.webp`, и `adventure/assets/x.webp`.
 *
 * @param {Map<string, Buffer>} assets
 * @returns {(path: string) => string}
 */
function makeAssetResolver(assets) {
  if (!assets || !assets.size) return () => '';
  const byName = new Map();
  for (const [name, data] of assets) byName.set(normalizeAssetPath(name), data);

  // Кэш готовых строк по пути. Без него одна и та же карта, на которую
  // ссылаются сцена и тридцать её токенов, превращалась в тридцать одну
  // копию base64: на мегабайтной карте это десятки мегабайт мусора.
  const dataUrls = new Map();
  // Поиск по «хвосту» пути нужен редко, но он линейный по всем картинкам.
  // Поэтому индекс строится один раз: полный путь → имя файла.
  const bySuffix = new Map();
  for (const name of byName.keys()) {
    const fileName = name.slice(name.lastIndexOf('/') + 1);
    if (!bySuffix.has(fileName)) bySuffix.set(fileName, name);
  }

  /**
   * @param {string} name имя файла внутри архива
   * @returns {string} data-URL
   */
  const toDataUrl = (name) => {
    const cached = dataUrls.get(name);
    if (cached !== undefined) return cached;
    const data = byName.get(name);
    if (!data) return '';
    const url = `data:image/${extensionOf(name)};base64,${data.toString('base64')}`;
    dataUrls.set(name, url);
    return url;
  };

  return (path) => {
    const wanted = normalizeAssetPath(path);
    if (!wanted) return '';
    if (byName.has(wanted)) return toDataUrl(wanted);
    const fileName = wanted.slice(wanted.lastIndexOf('/') + 1);
    const byFile = bySuffix.get(fileName);
    return byFile ? toDataUrl(byFile) : '';
  };
}

/** @param {string} path */
function extensionOf(path) {
  const match = String(path).match(/\.(png|jpe?g|webp|gif)$/i);
  const ext = (match ? match[1] : 'png').toLowerCase();
  return ext === 'jpg' ? 'jpeg' : ext;
}

/**
 * @param {Buffer} buffer
 * @returns {{sourceId: string, sourceTitle: string, entities: object[]}}
 */
function fromJsonBuffer(buffer) {
  let doc;
  try {
    doc = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw importError('unreadable', `Файл не похож на корректный JSON: ${error.message}`);
  }
  const list = Array.isArray(doc) ? doc : [doc];
  const entities = [];
  for (const entry of list) {
    if (Array.isArray(entry)) {
      for (const item of entry) entities.push(describeDocument(item));
    } else if (entry && typeof entry === 'object') {
      if (lower(entry.type) === 'adventure' || Array.isArray(entry.scenes)) {
        entities.push(...describeAdventure(entry));
      } else {
        entities.push(describeDocument(entry));
      }
    }
  }
  if (!entities.length) throw importError('empty', 'В файле не нашлось документов, которые можно импортировать.');
  return {
    sourceId: String((Array.isArray(doc) ? doc[0] : doc)?._id || 'json'),
    sourceTitle: String((Array.isArray(doc) ? doc[0] : doc)?.name || 'Файл Foundry'),
    entities
  };
}

/**
 * @param {Buffer} buffer
 * @returns {{sourceId: string, sourceTitle: string, entities: object[]}}
 */
function fromZipBuffer(buffer) {
  const { files, assets } = readZipJsonAndAssets(buffer);
  // Картинки лежат рядом с json, а не внутри него: без них сцены приедут
  // пустыми, потому что фон — это отдельный файл в выгрузке.
    const resolveAsset = makeAssetResolver(assets);
  const entities = [];
  let title = 'Модуль Foundry';

  const manifest = files.get('module.json');
  if (manifest) {
    try {
      const parsed = JSON.parse(manifest.toString('utf8'));
      title = String(parsed.title || parsed.name || title);
    } catch { /* манифест читаем не обязательно */ }
  }

  for (const [name, data] of files) {
    if (name === 'module.json') continue;
    let doc;
    try {
      doc = JSON.parse(data.toString('utf8'));
    } catch {
      continue; // битый JSON внутри архива не должен рушить весь импорт
    }
    const list = Array.isArray(doc) ? doc : [doc];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      if (lower(entry.type) === 'adventure' || Array.isArray(entry.scenes)) {
        // Если манифеста нет, показываем имя самого приключения, а не служебную заглушку.
        if (!manifest && entry.name) title = String(entry.name);
        entities.push(...describeAdventure(entry, resolveAsset));
      }
      else if (entry.type || entry.documentName) entities.push(describeDocument(entry, undefined, resolveAsset));
    }
  }

  if (!entities.length) {
    throw importError('empty', 'В архиве нет документов, которые можно импортировать.');
  }
  return { sourceId: `zip:${title}`, sourceTitle: title, entities };
}

const adapter = {
  id: 'foundry',

  canHandle(input) {
    const buffer = input && input.data;
    return looksLikeZip(buffer) || looksLikeJson(buffer);
  },

  async extract(input) {
    const buffer = input.data;
    if (!Buffer.isBuffer(buffer)) throw importError('unreadable', 'Файл не прочитан.');
    return looksLikeZip(buffer) ? fromZipBuffer(buffer) : fromJsonBuffer(buffer);
  }
};

module.exports = adapter;
module.exports.describeDocument = describeDocument;
module.exports.fromJsonBuffer = fromJsonBuffer;
module.exports.fromZipBuffer = fromZipBuffer;
module.exports.looksLikeZip = looksLikeZip;
module.exports.looksLikeJson = looksLikeJson;