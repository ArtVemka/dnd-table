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
  // запрещено политикой безопасности. Поэтому проверка живёт здесь, где файлы
  // открываются обычным fs.
  //
  // Оформление разбито на восемь частей, и блок печати живёт в тематическом
  // слое. Читаем все части и склеиваем: проверка должна видеть оформление целиком,
  // а не ту часть, где сегодня случайно оказался нужный блок.
  const dir = path.join(__dirname, '..', 'renderer', 'styles');
  const parts = fs.readdirSync(dir).filter((name) => name.endsWith('.css')).sort();
  assert(parts.length > 0, 'в renderer/styles нет ни одной части оформления');
  const css = parts.map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n');
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

check('ячейки заклинаний считаются только у полных заклинателей', () => {
  assert.strictEqual(DnD.SPELL_SLOT_LEVELS.length, 9, 'ступеней должно быть девять');
  // Жрец пятого уровня: четыре ячейки первой ступени и три третьей, а пятой у
  // него ещё нет.
  assert.strictEqual(DnD.spellSlotMax('жрец', 5, 1), 4);
  assert.strictEqual(DnD.spellSlotMax('жрец', 5, 3), 3);
  assert.strictEqual(DnD.spellSlotMax('жрец', 5, 9), 0);
  assert.strictEqual(DnD.spellSlotMax('Волшебник', 20, 9), 1);
  assert.strictEqual(DnD.spellSlotMax('bard', 1, 1), 2);
  // У полузаклинателя своя арифметика, и выдумывать её нельзя.
  assert.strictEqual(DnD.spellSlotMax('паладин', 5, 1), null);
  assert.strictEqual(DnD.spellSlotMax('варлок', 9, 1), null);
  assert.strictEqual(DnD.spellSlotMax('воин', 20, 1), null);
  assert.strictEqual(DnD.spellSlotMax('', 5, 1), null);
  // Таблица не может быть короче двадцати уровней или ступеней.
  assert.strictEqual(DnD.FULL_CASTER_SLOTS.length, 20, 'уровней в таблице должно быть двадцать');
  assert(DnD.FULL_CASTER_SLOTS.every((row) => row.length === 9), 'в каждой строке должно быть девять ступеней');

  const cleric = DnD.createEmptySheet();
  cleric.charClass = 'жрец';
  cleric.level = 5;
  cleric.spellSlotsUsed[0] = 2;
  const slots = DnD.computeSpellSlots(cleric);
  assert.strictEqual(slots.rows[0].max, 4, 'итог не подставился по классу');
  assert.strictEqual(slots.rows[0].used, 2);
  assert.strictEqual(slots.levels, 9);

  const fighter = DnD.createEmptySheet();
  fighter.charClass = 'воин';
  fighter.level = 12;
  assert.strictEqual(DnD.computeSpellSlots(fighter).levels, 0, 'у воина показаны ячейки');
  // Свое число человек вписать может, и тогда блок появляется.
  fighter.spellSlotsUsed[0] = 1;
  const manual = DnD.computeSpellSlots(fighter);
  assert.strictEqual(manual.rows[0].max, null, 'придумано ячеек у воина');
  assert.strictEqual(manual.levels, 9, 'ручной счётчик не показан');

  // Мультикласс: уровни полных заклинателей складываются, воин не мешает.
  const multiclass = DnD.createEmptySheet();
  multiclass.classes = [{ name: 'Воин', level: 3 }, { name: 'Волшебник', level: 2 }];
  const multiSlots = DnD.computeSpellSlots(multiclass);
  assert.strictEqual(multiSlots.rows[0].max, 3, 'волшебник 2 уровня даёт три ячейки');
  assert.strictEqual(DnD.totalCharacterLevel(multiclass), 5, 'общий уровень мультикласса');
  const pool = DnD.hitDicePool(multiclass);
  assert.strictEqual(pool.length, 2, 'у мультикласса две разные кости');
  assert.strictEqual(pool.map((item) => `${item.die}×${item.count}`).join(','), 'd10×3,d6×2');
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
