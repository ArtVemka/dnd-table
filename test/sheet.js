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
const { normalizeSheet } = require('../server/state');

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

check('состояния покрывают PHB, а не только старый набор', () => {
  const ids = DnD.CONDITIONS.map((item) => item.id);
  for (const id of ['charmed', 'exhaustion', 'unconscious']) {
    assert(ids.includes(id), `нет состояния ${id}`);
  }
  assert.strictEqual(new Set(ids).size, ids.length, 'состояния повторяются');
  assert.strictEqual(DnD.LIMITS.maxTokenConditions, DnD.CONDITIONS.length,
    'лимит состояний на фишке разошёлся со списком');
});

check('состояния дают помеху там, где её видно без контекста боя', () => {
  assert.strictEqual(DnD.conditionRollDisadvantage([], 'check'), false);
  assert.strictEqual(DnD.conditionRollDisadvantage(['poisoned'], 'check'), true);
  assert.strictEqual(DnD.conditionRollDisadvantage(['poisoned'], 'attack'), true);
  assert.strictEqual(DnD.conditionRollDisadvantage(['poisoned'], 'save'), false);
  assert.strictEqual(DnD.conditionRollDisadvantage(['blinded'], 'attack'), true);
  assert.strictEqual(DnD.conditionRollDisadvantage(['blinded'], 'check'), false);
  assert.strictEqual(DnD.conditionRollDisadvantage(['restrained'], 'attack'), true);
  assert.strictEqual(DnD.conditionRollDisadvantage(['restrained'], 'save', 'dex'), true);
  assert.strictEqual(DnD.conditionRollDisadvantage(['restrained'], 'save', 'str'), false);
});

check('лист хранит вдохновение, истощение, концентрацию и монеты', () => {
  const sheet = DnD.createEmptySheet();
  assert.strictEqual(sheet.inspiration, false);
  assert.strictEqual(sheet.exhaustion, 0);
  assert.strictEqual(sheet.concentration, '');
  assert.deepStrictEqual(sheet.coins, { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 });
  assert.strictEqual(DnD.LIMITS.maxExhaustion, 6);
});

check('истощение даёт последствия по PHB 2014', () => {
  const none = DnD.exhaustionEffects(0);
  assert.strictEqual(none.checkDisadvantage, false);
  assert.strictEqual(none.speedMultiplier, 1);
  assert.strictEqual(none.maxHpMultiplier, 1);

  const first = DnD.exhaustionEffects(1);
  assert.strictEqual(first.checkDisadvantage, true);
  assert.strictEqual(first.attackDisadvantage, false);
  assert.strictEqual(first.saveDisadvantage, false);

  // Уровни складываются: второй режет скорость, третий добавляет помеху
  // атакам и спасброскам, четвёртый — максимум хитов.
  const second = DnD.exhaustionEffects(2);
  assert.strictEqual(second.checkDisadvantage, true);
  assert.strictEqual(DnD.effectiveSpeed({ speed: 30, exhaustion: 2 }), 15);
  const third = DnD.exhaustionEffects(3);
  assert.strictEqual(third.attackDisadvantage, true);
  assert.strictEqual(third.saveDisadvantage, true);
  assert.strictEqual(DnD.effectiveMaxHp({ maxHp: 30, exhaustion: 3 }), 30);
  const fourth = DnD.exhaustionEffects(4);
  assert.strictEqual(fourth.maxHpMultiplier, 0.5);
  assert.strictEqual(DnD.effectiveMaxHp({ maxHp: 25, exhaustion: 4 }), 12);

  assert.strictEqual(DnD.exhaustionEffects(5).speedMultiplier, 0);
  assert.strictEqual(DnD.effectiveSpeed({ speed: 30, exhaustion: 5 }), 0);
  assert.strictEqual(DnD.exhaustionEffects(6).dead, true);

  // Мусор из кампании режется до шести уровней, а не превращается в NaN.
  assert.strictEqual(DnD.exhaustionEffects(99).level, 6);
  assert.strictEqual(DnD.exhaustionEffects(-3).level, 0);
  assert.strictEqual(DnD.exhaustionEffects('нет').level, 0);

  // Помеха пассивной проверке — это -5, а не бросок.
  const sheet = DnD.createEmptySheet();
  assert.strictEqual(DnD.computeDerived(sheet).passivePerception, 10);
  assert.strictEqual(DnD.computeDerived({ ...sheet, exhaustion: 1 }).passivePerception, 5);
});

check('сервер режет здоровье по истощению 4 уровня', () => {
  const weakened = normalizeSheet({ maxHp: 40, hp: 40, exhaustion: 4 });
  assert.strictEqual(weakened.maxHp, 40, 'исходный максимум хитов должен остаться в листе');
  assert.strictEqual(weakened.hp, 20, 'текущее здоровье должно упереться в половину максимума');

  const aboveCap = normalizeSheet({ maxHp: 41, hp: 40, exhaustion: 4 });
  assert.strictEqual(aboveCap.hp, 20, 'половина от нечётного максимума округляется вниз');

  // До четвёртого уровня потолок не меняется, а снятое истощение не лечит.
  const third = normalizeSheet({ maxHp: 40, hp: 30, exhaustion: 3 });
  assert.strictEqual(third.hp, 30);
  const recovered = normalizeSheet({ maxHp: 40, hp: 20, exhaustion: 0 });
  assert.strictEqual(recovered.hp, 20);
});

check('опыт встречи считается по DMG с множителем за число монстров', () => {
  // Четыре гоблина (CR 1/4): 50 × 4 = 200, множитель за четырёх — 2.
  const goblins = DnD.encounterXp([{ cr: '1/4', count: 4 }]);
  assert.strictEqual(goblins.baseXp, 200);
  assert.strictEqual(goblins.multiplier, 2);
  assert.strictEqual(goblins.adjustedXp, 400);
  // Один дракон CR 5: 1800 без множителя.
  const dragon = DnD.encounterXp([{ cr: 5, count: 1 }]);
  assert.strictEqual(dragon.adjustedXp, 1800);
  assert.strictEqual(DnD.encounterMultiplier(2), 1.5);
  assert.strictEqual(DnD.encounterMultiplier(7), 2.5);
  assert.strictEqual(DnD.encounterMultiplier(16), 4);
  // CR без таблицы не выдумывает опыт.
  assert.strictEqual(DnD.encounterXp([{ cr: 'нет', count: 3 }]).ignored, 3);
});

check('пороги партии складываются по уровням, сложность не врёт', () => {
  // Четыре персонажа 3 уровня: 75/150/225/400 на каждого.
  const thresholds = DnD.partyThresholds([3, 3, 3, 3]);
  assert.strictEqual(thresholds.easy, 300);
  assert.strictEqual(thresholds.medium, 600);
  assert.strictEqual(thresholds.hard, 900);
  assert.strictEqual(thresholds.deadly, 1600);
  assert.strictEqual(DnD.encounterDifficulty(400, thresholds), 'easy');
  assert.strictEqual(DnD.encounterDifficulty(600, thresholds), 'medium');
  assert.strictEqual(DnD.encounterDifficulty(900, thresholds), 'hard');
  assert.strictEqual(DnD.encounterDifficulty(1600, thresholds), 'deadly');
  assert.strictEqual(DnD.encounterDifficulty(100, thresholds), 'trivial');
  assert.strictEqual(DnD.partyThresholds([]), null);
  assert.strictEqual(DnD.encounterDifficulty(100, null), null);
});

check('календарь переводит номер дня в месяц и год', () => {
  assert.deepStrictEqual(DnD.calendarFromDay(1), { year: 1, month: 1, day: 1 });
  assert.deepStrictEqual(DnD.calendarFromDay(31), { year: 1, month: 2, day: 1 });
  assert.deepStrictEqual(DnD.calendarFromDay(361), { year: 2, month: 1, day: 1 });
  const day = DnD.dayFromCalendar(1492, 3, 5);
  assert.deepStrictEqual(DnD.calendarFromDay(day), { year: 1492, month: 3, day: 5 });
  // Старый номер дня за пределами месяца не теряется при выводе.
  assert.strictEqual(DnD.formatGameTime({ day: 31, hour: 8 }), '1 февраля 1 г., 08:00');
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert.strictEqual = (actual, expected, message) => {
  if (actual !== expected) {
    throw new Error(`${message || 'значения не совпали'}: получено ${actual}, ждали ${expected}`);
  }
};

assert.deepStrictEqual = (actual, expected, message) => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(`${message || 'значения не совпали'}: получено ${left}, ждали ${right}`);
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
