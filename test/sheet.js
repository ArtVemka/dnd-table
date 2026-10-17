'use strict';
/**
 * Проверки листа персонажа, которые ловят расхождение между формой и
 * хранилищем: клиент и сервер обязаны резать числа по одним и тем же
 * пределам, иначе игрок видит одно значение, а в кампании лежит другое.
 *
 * Модель берём из dnd5e.js с подменённым window: файл рассчитан на браузер.
 */
const fs = require('fs');
const path = require('path');

global.window = {};
require('../renderer/dnd5e.js');
const DnD = global.window.DnD5e;

const LIMITS_SERVER = { minAbility: 1, maxAbility: 30, minLevel: 1, maxLevel: 20 };
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('пределы листа объявлены в одном месте', () => {
  for (const key of Object.keys(LIMITS_SERVER)) {
    assert(typeof DnD.LIMITS[key] === 'number', `нет предела ${key}`);
  }
  for (const key of Object.keys(LIMITS_SERVER)) {
    assert(DnD.LIMITS[key] === LIMITS_SERVER[key],
      `предел ${key}: в модели ${DnD.LIMITS[key]}, на сервере ${LIMITS_SERVER[key]}`);
  }
});

check('форма и сервер дают одинаковое число на нормальных значениях', () => {
  for (const value of [1, 10, 17, 30]) {
    assert.strictEqual(DnD.clampNumber(value, DnD.LIMITS.minAbility, DnD.LIMITS.maxAbility, 10), value);
  }
  for (const level of [1, 5, 20]) {
    assert.strictEqual(DnD.clampNumber(level, DnD.LIMITS.minLevel, DnD.LIMITS.maxLevel, 1), level);
  }
});

check('форма режет значения раньше сервера и показывает то, что сохранится', () => {
  // Раньше тут был корень расхождения: в поле стояло 99, на экране был
  // модификатор +44, а на сервере оставалось 30, и игрок этого не видел.
  const strength = DnD.clampNumber(99, DnD.LIMITS.minAbility, DnD.LIMITS.maxAbility, 10);
  assert.strictEqual(strength, 30, 'сила должна резаться до 30');
  assert.strictEqual(DnD.abilityModifier(strength), 10, 'модификатор должен считаться от сохранённого значения');

  const level = DnD.clampNumber(500, DnD.LIMITS.minLevel, DnD.LIMITS.maxLevel, 1);
  assert.strictEqual(level, 20, 'уровень должен резаться до 20');
});

check('пустое числовое поле не отправляет ноль в поле, где ноль недопустим', () => {
  // Раньше пустой уровень уходил как 0, сервер подставлял 1, и после
  // перезагрузки в поле появлялась единица, которой игрок не вводил.
  assert.strictEqual(DnD.clampNumber('', DnD.LIMITS.minLevel, DnD.LIMITS.maxLevel, 1), 1);
  assert.strictEqual(DnD.clampNumber('', DnD.LIMITS.minAbility, DnD.LIMITS.maxAbility, 10), 10);
});

check('дробные числа округляются, а не копятся', () => {
  // Сервер округляет целые; форма обязана делать то же самое, иначе в поле
  // остаётся 10.7, пока в кампании лежит 11.
  assert.strictEqual(DnD.clampNumber(10.7, 0, 9999, 0), 11);
  assert.strictEqual(DnD.clampNumber(10.2, 0, 9999, 0), 10);
});

check('стиль печати убирает интерфейс и оставляет белый лист', () => {
  // Стили подключены ссылкой, и прочесть их из renderer нельзя: чтение файла
  // запрещено политикой безопасности. Поэтому проверка живёт здесь, где файл
  // открывается обычным fs.
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const index = css.indexOf('@media print');
  assert(index >= 0, 'в стилях нет блока для печати');
  const block = css.slice(index);
  assert(/visibility:\s*hidden/.test(block), 'печать не прячет интерфейс стола');
  assert(/background:\s*#fff/.test(block), 'на печати не белый фон: лист уйдёт тёмным');
  assert(/\.sheet,\s*\n\s*\.sheet \*\s*\{\s*\n\s*visibility:\s*visible/.test(block),
    'сам лист на печати не виден');
  // Без этого заголовок листа и подписи полей уедут вниз на белом фоне.
  assert(/color:\s*#101010/.test(block), 'текст на печати остался тёмным на светлом');
});

check('счётчики спасбросков смерти живут только на нулевых хитах', () => {
  const sheet = DnD.createEmptySheet();
  assert.strictEqual(sheet.deathSavesSuccesses, 0, 'в пустом листе счётчики не обнулены');
  assert.strictEqual(DnD.LIMITS.maxDeathSaves, 3, 'предел счётчика не три');
  // Живой персонаж: счётчики не значат ничего и не показываются.
  assert.strictEqual(DnD.computeVitalState({ ...sheet, hp: 1 }).down, false);
  assert.strictEqual(DnD.computeVitalState({ ...sheet, hp: 1, deathSavesFailures: 3 }).label, '');
  assert.strictEqual(DnD.computeVitalState({ ...sheet, hp: 0 }).label, 'При смерти');
  assert.strictEqual(DnD.computeVitalState({ ...sheet, hp: 0, deathSavesFailures: 3 }).label, 'Мёртв');
  assert.strictEqual(DnD.computeVitalState({ ...sheet, hp: 0, deathSavesSuccesses: 3 }).label, 'Стабилизирован');
  // Мусор в кампании не должен ломать состояние.
  const wild = DnD.computeVitalState({ hp: 0, deathSavesSuccesses: 99, deathSavesFailures: -4 });
  assert.strictEqual(wild.success, 3, `успехов: ${wild.success}`);
  assert.strictEqual(wild.failure, 0, `неудач: ${wild.failure}`);
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert.strictEqual = (actual, expected, message) => {
  if (actual !== expected) {
    throw new Error(`${message || 'значения не совпали'}: получено ${actual}, ждали ${expected}`);
  }
};

(async () => {
  let failed = 0;
  for (const item of checks) {
    try {
      item.fn();
      console.log(`  ok   ${item.name}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL ${item.name}`);
      console.log(`       ${error.message}`);
    }
  }
  console.log('==============================================================');
  console.log(failed
    ? `Лист: проверок ${checks.length}, провалено ${failed}.`
    : `Лист: проверок ${checks.length}, провалено 0.`);
  process.exit(failed ? 1 : 0);
})();
