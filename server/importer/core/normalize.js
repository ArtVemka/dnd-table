'use strict';

/**
 * Нормализация: содержимое источника → единый список сущностей.
 *
 * Здесь же проверяются картинки. Проверка та же, что и при загрузке карт в
 * игре (server/image.js): по сигнатуре файла, а не по расширению. Импорт не
 * должен стать вторым, более слабым путём внутрь приложения.
 */

const { decodeImage } = require('../../image');

/** Какие виды сущностей вообще имеет смысл переносить. */
const KINDS = ['scene', 'actor', 'item', 'journal', 'rolltable', 'macro'];

/** Человеческие названия видов — для интерфейса. */
const KIND_LABELS = {
  scene: 'Сцена',
  actor: 'Персонаж',
  item: 'Предмет',
  journal: 'Заметка',
  rolltable: 'Таблица',
  macro: 'Макрос'
};

/**
 * @typedef {object} ExternalEntity
 * @property {string} kind
 * @property {string} sourceId
 * @property {string} name
 * @property {string[]} tags
 * @property {{data: string, mime: string, bytes: number}|null} image
 * @property {ExternalEntity[]} children
 * @property {object|null} raw
 */

/**
 * Принимает изображение в любом виде, который встречается у источников:
 * data URL, «data:img» из Foundry или голые base64.
 * @param {unknown} value
 * @returns {{data: string, mime: string, bytes: number}|{error: string}}
 */
function normalizeImage(value) {
  if (typeof value !== 'string' || !value.trim()) return { error: 'пусто' };
  const text = value.trim();

  // Foundry внутри слоёв и токенов пишет «data:img» без указания типа.
  let candidate = text;
  if (/^data:img;/i.test(candidate)) {
    candidate = `data:image/png;base64,${candidate.replace(/^data:img;/i, '').replace(/^base64,/i, '')}`;
  }
  if (/^data:image\/[a-z+]+;/i.test(candidate) && !/^data:image\/(png|jpeg|jpg|webp);/i.test(candidate)) {
    return { error: 'тип изображения не поддерживается' };
  }
  if (!/^data:/i.test(candidate)) {
    // Настоящая выгрузка Foundry хранит не картинку, а путь к ней в своих
    // файлах: `modules/…/Amber_Temple.webp`. Если выгрузка пришла архивом,
    // адаптер уже достал эту картинку и подставил data-URL; значит, путь до
    // нас дошёл из json, который лежит рядом с файлами Foundry, а не в выгрузке.
    return { error: 'картинка лежит в файлах Foundry, а в выгрузке её нет', path: candidate };
  }

  const result = decodeImage(candidate);
  if (result.error) return { error: result.error };
  return { data: candidate, mime: `image/${result.ext}`, bytes: result.buffer.length };
}

/**
 * @param {object} raw
 * @returns {ExternalEntity}
 */
function toEntity(raw) {
  const kind = KINDS.includes(raw.kind) ? raw.kind : 'item';
  const image = raw.image ? normalizeImage(raw.image) : null;
  return {
    kind,
    sourceId: String(raw.sourceId || ''),
    name: String(raw.name || '').slice(0, 200),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String).slice(0, 32) : [],
    image: image && !image.error ? { data: image.data, mime: image.mime, bytes: image.bytes } : null,
    // Причину, по которой картинка не досталась, сохраняем: без неё
    // предупреждение в предпросмотре получалось безликим «нет картинки».
    imageError: image && image.error ? { reason: image.error, path: image.path || '' } : null,
    children: Array.isArray(raw.children) ? raw.children.map(toEntity) : [],
    raw: raw.raw && typeof raw.raw === 'object' ? raw.raw : null
  };
}

/**
 * Прогоняет список сущностей источника через нормализацию.
 *
 * Сущности без идентификатора и без имени выбрасываются: иначе в предпросмотре
 * невозможно их различать и выбирать. Причина каждой потери попадает в отчёт.
 *
 * @param {object[]} rawEntities
 * @returns {{entities: ExternalEntity[], skipped: {sourceId: string, name: string, reason: string}[]}}
 */
function normalize(rawEntities) {
  const list = Array.isArray(rawEntities) ? rawEntities : [];
  const entities = [];
  const skipped = [];

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const sourceId = String(raw.sourceId || '');
    const name = String(raw.name || '').trim();
    if (!sourceId && !name) {
      skipped.push({ sourceId: '', name: '', reason: 'нет ни идентификатора, ни названия' });
      continue;
    }
    if (!KINDS.includes(raw.kind)) {
      skipped.push({ sourceId, name, reason: `неизвестный вид «${raw.kind}»` });
      continue;
    }
    entities.push(toEntity({ ...raw, sourceId: sourceId || name, name }));
  }

  return { entities, skipped };
}

module.exports = { KINDS, KIND_LABELS, normalize, normalizeImage, toEntity };