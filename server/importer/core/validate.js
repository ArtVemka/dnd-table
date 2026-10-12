'use strict';

/**
 * Валидация: проверки уровня кампании, а не источника.
 *
 * Смысл в том, чтобы до записи в кампанию было видно, что именно не влезет и
 * сколько это займёт места. Ничего не отбрасывает молча — только помечает.
 */

const { LIMITS } = require('../../state');

/** Сколько суммарно байт картинок считаем приемлемым. */
const MAX_TOTAL_IMAGE_BYTES = 200 * 1024 * 1024;

/**
 * @param {import('./normalize').ExternalEntity[]} entities
 * @returns {{warnings: string[], imageBytes: number, counts: Record<string, number>}}
 */
function validate(entities) {
  const warnings = [];
  const counts = {};
  let imageBytes = 0;

  for (const entity of entities) {
    counts[entity.kind] = (counts[entity.kind] || 0) + 1;
    if (entity.image) imageBytes += entity.image.bytes;
    if (!entity.image && (entity.kind === 'scene')) {
      warnings.push(`У сцены «${entity.name || entity.sourceId}» нет подходящей картинки — она попадёт в игру пустой.`);
    }
  }

  if (imageBytes > MAX_TOTAL_IMAGE_BYTES) {
    warnings.push(
      `Картинок на ${Math.round(imageBytes / 1024 / 1024)} МБ — это много. ` +
      'Лишнее лучше не импортировать, иначе папка кампании разрастётся.'
    );
  }

  const caps = [
    ['journal', LIMITS.maxAdventureNotes, 'заметок'],
    ['item', LIMITS.maxAdventureItems, 'предметов'],
    ['rolltable', LIMITS.maxAdventureTables, 'таблиц'],
    ['actor', LIMITS.maxAdventureActors, 'персонажей']
  ];
  for (const [kind, cap, noun] of caps) {
    if (counts[kind] > cap) {
      warnings.push(`${noun} больше, чем помещается в кампанию (${counts[kind]} из ${cap}) — лишние не сохранятся.`);
    }
  }

  return { warnings, imageBytes, counts };
}

module.exports = { validate, MAX_TOTAL_IMAGE_BYTES };