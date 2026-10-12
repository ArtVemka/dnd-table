'use strict';

/**
 * Конвейер импорта.
 *
 * Модуль ничего не знает ни про Electron, ни про файловую систему: всё чтение
 * делает адаптер, а конвейер только связывает шаги. Это позволяет проверять
 * импорт обычными тестами node, без запуска приложения.
 *
 * Ядро не мутирует кампанию: на выходе лежит патч, который вызывающий код
 * решает применить или отбросить целиком.
 */

const { normalize } = require('./normalize');
const { validate } = require('./validate');
const { buildPlans, mapToCampaign } = require('./map');
const { buildPreview, buildReport } = require('./report');
const { importError } = require('../errors');

/** @type {object[]} */
const adapters = [];

/**
 * Регистрирует адаптер источника.
 * @param {{id: string, canHandle: Function, extract: Function}} adapter
 */
function register(adapter) {
  if (!adapter || !adapter.id || typeof adapter.canHandle !== 'function' || typeof adapter.extract !== 'function') {
    throw new Error('Адаптер должен иметь id, canHandle и extract');
  }
  const existing = adapters.findIndex((item) => item.id === adapter.id);
  if (existing === -1) adapters.push(adapter);
  else adapters[existing] = adapter;
}

/** @param {object} input */
function findAdapter(input) {
  const found = adapters.find((adapter) => {
    try {
      return adapter.canHandle(input);
    } catch {
      return false;
    }
  });
  if (!found) {
    throw importError('no-adapter', 'Не удалось понять, что это за файл. Поддерживаются выгрузки Foundry VTT.');
  }
  return found;
}

/**
 * Шаги 1–4: источник → адаптер → нормализация → валидация → планы.
 * Результат уходит в интерфейс: список сущностей с тем, что будет с каждой.
 *
 * @param {object} input
 * @param {{campaignMaps: object}} context
 */
async function inspect(input, context = {}) {
  const adapter = findAdapter(input);
  const raw = await adapter.extract(input);
  const { entities, skipped } = normalize(raw.entities);
  if (!entities.length) {
    // Файл разобрали, но переносить из него нечего. Молчаливый пустой
    // предпросмотр выглядел бы как «сломалось что-то в программе».
    throw importError('empty', 'В файле нет документов, которые можно импортировать.');
  }
  const { warnings } = validate(entities);
  const built = buildPlans(entities, context.campaignMaps);
  return buildPreview({
    sourceId: raw.sourceId,
    sourceTitle: raw.sourceTitle,
    entities,
    skipped,
    warnings,
    plans: built.plans,
    freeSlots: built.freeSlots
  });
}

/**
 * Шаги 5–8: выбор пользователя → маппинг → патч → отчёт.
 *
 * Если что-то выбранное не удалось применить, импорт отменяется целиком:
 * полуприменённая кампания хуже, чем никакая.
 *
 * @param {object} input
 * @param {{include: string[]}} options
 * @param {{campaignMaps: object}} context
 */
async function runImport(input, options = {}, context = {}) {
  const adapter = findAdapter(input);
  const raw = await adapter.extract(input);
  const { entities, skipped } = normalize(raw.entities);
  const { warnings } = validate(entities);
  const built = buildPlans(entities, context.campaignMaps);

  const include = Array.isArray(options.include) ? options.include : [];
  const chosen = built.plans
    .filter((plan) => plan.selectable && include.includes(plan.sourceId))
    .map((plan) => ({ ...plan, selected: true }));

  if (!chosen.length) {
    throw importError('nothing-selected', 'Не выбрано ни одной сущности для импорта.');
  }

  const mapped = mapToCampaign(
    { plans: chosen, freeSlots: built.freeSlots },
    {
      campaignMaps: context.campaignMaps,
      entities,
      sourceTitle: raw.sourceTitle,
      sourceId: raw.sourceId
    }
  );

  const report = buildReport({
    sourceTitle: raw.sourceTitle,
    applied: mapped.applied,
    skipped: skipped.concat(mapped.skipped),
    warnings
  });

  return {
    patch: { maps: mapped.maps, tokens: mapped.tokens, adventure: mapped.adventure },
    report
  };
}

module.exports = { register, findAdapter, inspect, runImport, adapters };