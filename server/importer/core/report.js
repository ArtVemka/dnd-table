'use strict';

/**
 * Отчёт и сводка для предпросмотра.
 *
 * Пользователь должен до импорта видеть, что именно он запускает, и после
 * импорта — что получилось. Это два разных формата одного и того же счёта.
 */

const { KIND_LABELS } = require('./normalize');

/**
 * Сводка для предпросмотра.
 * @param {{sourceId: string, sourceTitle: string, entities: import('./normalize').ExternalEntity[],
 *   skipped: object[], warnings: string[], plans: object[], freeSlots: string[]}} data
 */
function buildPreview(data) {
  const counts = {};
  for (const entity of data.entities) counts[entity.kind] = (counts[entity.kind] || 0) + 1;

  const selectable = data.plans.filter((plan) => plan.selectable).length;

  return {
    sourceId: data.sourceId,
    sourceTitle: data.sourceTitle,
    counts: Object.entries(counts).map(([kind, count]) => ({
      kind,
      label: KIND_LABELS[kind] || kind,
      count
    })),
    total: data.entities.length,
    selectable,
    warnings: data.warnings,
    skipped: data.skipped,
    plans: data.plans
  };
}

/**
 * Итоговый отчёт после импорта.
 * @param {object} input
 */
function buildReport(input) {
  return {
    sourceTitle: input.sourceTitle,
    applied: input.applied,
    skipped: input.skipped,
    warnings: input.warnings,
    summary: summarise(input.applied)
  };
}

/** @param {object[]} applied */
/**
 * Склоняет существительное по числу: 1 карта, 2 карты, 5 карт.
 * Без этого итог импорта читается как «1 карт», и это сразу бросается в глаза.
 * @param {number} count
 * @param {string} one
 * @param {string} few
 * @param {string} many
 * @returns {string}
 */
function plural(count, one, few, many) {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function summarise(applied) {
  const parts = [];
  const nouns = [
    ['scene', 'карта', 'карты', 'карт'],
    ['journal', 'заметка', 'заметки', 'заметок'],
    ['item', 'предмет', 'предмета', 'предметов'],
    ['rolltable', 'таблица', 'таблицы', 'таблиц'],
    ['actor', 'персонаж', 'персонажа', 'персонажей']
  ];
  for (const [kind, one, few, many] of nouns) {
    const total = applied.filter((item) => item.kind === kind).length;
    if (total) parts.push(`${total} ${plural(total, one, few, many)}`);
  }
  return parts.length ? `Импортировано: ${parts.join(', ')}.` : 'Импортировать было нечего.';
}

module.exports = { buildPreview, buildReport };