'use strict';

/**
 * Маппинг выбранных сущностей в модель D&D Стола.
 *
 * Здесь принимаются решения, которые невозможно вывести из формата источника:
 * в модели кампании ровно три вкладки карт, а сцен может быть сколько угодно,
 * и NPC в игре не имеют листа. Решения зафиксированы в docs/ИМПОРТ-ПРИКЛЮЧЕНИЙ.md.
 *
 * Результат — патч: что нужно положить в кампанию. Ничего не пишется на диск —
 * это делает вызывающий код.
 */

const { MAP_TYPES } = require('../../state');

const MAP_LABELS = { world: 'Общая', battle: 'Локация', sketch: 'Рисунок' };

/**
 * План для одной сущности: что с ней будет сделано при импорте.
 * @param {import('./normalize').ExternalEntity} entity
 * @param {string[]} freeSlots
 * @returns {object}
 */
function planFor(entity, freeSlots) {
  if (entity.kind === 'scene') {
    const slot = freeSlots[0] || null;
    // Сцена без годной картинки не даст карты: импортировать её — значит
    // показать пользователю пустую вкладку. Лучше честно сказать заранее.
    const hasImage = Boolean(entity.image);
    const selectable = Boolean(slot) && hasImage;
    let note;
    if (!slot) {
      note = 'В игре заняты все три вкладки карт — освободите одну, чтобы импортировать сцену';
    } else if (!hasImage) {
      note = entity.imageError && /файлах Foundry/i.test((entity.imageError.reason || ''))
        ? 'Картинка лежит в файлах Foundry, а в выгрузке её нет — выгрузите приключение из Foundry'
        : 'У сцены нет подходящей картинки, а без неё карта будет пустой';
    } else {
      note = 'Картинка станет картой, токены — фишками';
    }
    return {
      kind: entity.kind,
      sourceId: entity.sourceId,
      name: entity.name,
      selectable,
      // Пользователь жмёт «Выбрать всё»: отмечиваем только то, что правда перенесётся.
      selected: selectable,
      target: slot,
      targetLabel: slot ? `вкладка «${MAP_LABELS[slot]}»` : 'свободных вкладок нет',
      note
    };
  }

  if (entity.kind === 'macro') {
    return {
      kind: entity.kind,
      sourceId: entity.sourceId,
      name: entity.name,
      selectable: false,
      selected: false,
      target: null,
      targetLabel: '',
      note: 'Макросы не переносятся и никогда не выполняются'
    };
  }

  const targets = {
    actor: ['персонаж в справочнике приключения', 'лист не заполняется'],
    journal: ['заметка в журнале приключения'],
    item: ['предмет в справочнике приключения'],
    rolltable: ['таблица в справочнике приключения']
  };
  const [target, extra] = targets[entity.kind] || ['неизвестно'];

  return {
    kind: entity.kind,
    sourceId: entity.sourceId,
    name: entity.name,
    selectable: true,
    selected: true,
    target: null,
    targetLabel: target,
    note: extra || ''
  };
}

/**
 * @param {import('./normalize').ExternalEntity[]} entities
 * @param {{maps: Record<string, {items: object[]}}} campaignMaps
 * @returns {{plans: object[], freeSlots: string[]}}
 */
function buildPlans(entities, campaignMaps) {
  const freeSlots = MAP_TYPES.filter((type) => {
    const slot = campaignMaps && campaignMaps[type];
    return slot && Array.isArray(slot.items) && slot.items.length === 0;
  });
  return { plans: entities.map((entity) => planFor(entity, freeSlots)), freeSlots };
}

/**
 * Переводит координату из пикселей Foundry в долю от 0 до 1.
 *
 * В Foundry x и y — левый верхний угол токена в пикселях, а центр лежит на
 * половине его ширины и высоты. В D&D Стол точка — центр фишки.
 * @param {number} value
 * @param {number} size
 * @param {number} extent
 * @returns {number}
 */
function toFraction(value, size, extent) {
  if (!Number.isFinite(extent) || extent <= 0) return 0.5;
  const center = (Number(value) || 0) + (Number(size) || 0) / 2;
  return Math.min(1, Math.max(0, center / extent));
}

/**
 * Идентификаторы для импортируемых сущностей.
 * Счётчик нужен, чтобы в пределах одной импортации не совпали два «note-1».
 */
let counter = 0;
function nextId(prefix) {
  counter += 1;
  return `${prefix}-${counter.toString(36)}-${Date.now().toString(36)}`;
}

/**
 * Собирает патч кампании из выбранных планов.
 *
 * @param {{plans: object[], freeSlots: string[]}} built
 * @param {object} context
 * @param {{maps: Record<string, object>}} context.campaignMaps
 * @param {import('./normalize').ExternalEntity[]} context.entities
 * @param {string} context.sourceTitle
 * @param {string} context.sourceId
 * @returns {{maps: object, tokens: object[], adventure: object, applied: object[], skipped: object[]}}
 */
function mapToCampaign(built, context) {
  const { campaignMaps, entities, sourceTitle, sourceId } = context;
  const byId = new Map(entities.map((entity) => [entity.sourceId, entity]));

  const maps = { ...campaignMaps };
  for (const type of Object.keys(maps)) {
    maps[type] = { items: [...maps[type].items], activeId: maps[type].activeId };
  }
  const tokens = [];
  const applied = [];
  const skipped = [];

  const adventure = {
    id: nextId('adv'),
    name: sourceTitle,
    source: sourceId,
    importedAt: new Date().toISOString(),
    notes: [],
    items: [],
    tables: [],
    actors: []
  };

  // Сцены занимают вкладки по порядку; первая свободная уходит первой.
  const usedSlots = [];
  for (const plan of built.plans) {
    if (!plan.selected) {
      if (!plan.selectable) skipped.push({ kind: plan.kind, name: plan.name, reason: plan.note });
      continue;
    }
    const entity = byId.get(plan.sourceId);
    if (!entity) continue;

    if (plan.kind === 'scene') {
      const slot = usedSlots.length ? usedSlots[usedSlots.length - 1] : plan.target;
      if (!slot) {
        skipped.push({ kind: 'scene', name: plan.name, reason: 'свободных вкладок нет' });
        continue;
      }
      const sceneWidth = Number(entity.raw && entity.raw.sceneWidth) || 0;
      const sceneHeight = Number(entity.raw && entity.raw.sceneHeight) || 0;
      let sceneMapId = '';

      if (entity.image) {
        const mapItem = {
          id: nextId('map'),
          url: entity.image.data,
          name: entity.name || 'Карта',
          importedAt: new Date().toISOString()
        };
        maps[slot].items.push(mapItem);
        // Фишки сцены принадлежат именно этой карте: вкладка умеет держать
        // несколько карт, и без привязки фишки обеих сцен наезжали друг на
        // друга при переключении.
        sceneMapId = mapItem.id;
      } else {
        // Страховка на случай, если импорт вызвали в обход предпросмотра:
        // лучше пропустить сцену, чем отчитаться об успехе, которого не было.
        skipped.push({ kind: 'scene', name: plan.name, reason: 'у сцены нет подходящей картинки' });
        continue;
      }
      if (entity.children.length && entity.image) {
        for (const child of entity.children) {
          const raw = child.raw || {};
          tokens.push({
            id: nextId('token'),
            name: child.name || 'Фишка',
            mapType: slot,
            mapId: sceneMapId,
            x: toFraction(raw.x, raw.width, sceneWidth),
            y: toFraction(raw.y, raw.height, sceneHeight),
            imageUrl: child.image ? child.image.data : null,
            // Foundry хранит размер токена в клетках: 2 у большого, 3 у
            // огромного. Берём большую сторону, потому что фишка круглая.
            size: Math.max(1, Math.min(4, Math.round(Math.max(
              Number(raw.width) || 1, Number(raw.height) || 1
            )))),
            assignedPlayerId: null,
            color: '#c87550'
          });
        }
      }
      usedSlots.push(slot);
      applied.push({ kind: 'scene', name: plan.name, where: `вкладка «${MAP_LABELS[slot]}»` });
      continue;
    }

    if (plan.kind === 'macro') {
      skipped.push({ kind: 'macro', name: plan.name, reason: 'макросы не переносятся' });
      continue;
    }

    if (plan.kind === 'journal') {
      adventure.notes.push({
        id: nextId('note'),
        title: entity.name || 'Заметка',
        text: String((entity.raw && entity.raw.text) || ''),
        sourceId: entity.sourceId
      });
      applied.push({ kind: 'journal', name: plan.name, where: 'журнал приключения' });
      continue;
    }

    if (plan.kind === 'item') {
      adventure.items.push({
        id: nextId('item'),
        name: entity.name || 'Предмет',
        type: String((entity.raw && entity.raw.type) || ''),
        sourceId: entity.sourceId
      });
      applied.push({ kind: 'item', name: plan.name, where: 'справочник предметов' });
      continue;
    }

    if (plan.kind === 'rolltable') {
      adventure.tables.push({
        id: nextId('table'),
        name: entity.name || 'Таблица',
        formula: String((entity.raw && entity.raw.formula) || ''),
        description: String((entity.raw && entity.raw.description) || ''),
        sourceId: entity.sourceId
      });
      applied.push({ kind: 'rolltable', name: plan.name, where: 'справочник таблиц' });
      continue;
    }

    if (plan.kind === 'actor') {
      adventure.actors.push({
        id: nextId('actor'),
        name: entity.name || 'Персонаж',
        type: String((entity.raw && entity.raw.type) || 'npc'),
        image: entity.image ? entity.image.data : '',
        statblock: (entity.raw && entity.raw.statblock) || null,
        sourceId: entity.sourceId
      });
      applied.push({ kind: 'actor', name: plan.name, where: 'справочник персонажей' });
    }
  }

  return { maps, tokens, adventure, applied, skipped };
}

module.exports = { buildPlans, mapToCampaign, toFraction, MAP_LABELS };