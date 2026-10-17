/*
 * Разбор и бросок формул: «2d6+3», «4d6dl1», «2d20kh1+7», «d100».
 *
 * Файл общий у сервера и интерфейса, поэтому у него два выхода: в браузере он
 * вешает `window.DnDDice`, а в Node отдаёт себя через module.exports. Тренировочный
 * стол считает бросок сам, и раньше ему пришлось бы завести свою копию разбора.
 * Две копии разбора разъедутся: одна посчитает «4d6dl1» как обычные 4d6, другая —
 * правильно, и игрок увидит разные числа за один и тот же бросок.
 *
 * Числа считает сервер: модуль только разбирает формулу и раскладывает броски.
 * Генератор случайных чисел передаётся снаружи, потому что у сервера это
 * crypto.randomInt, а у тренировочного стола — Math.random.
 */

(function (root) {
  'use strict';

  /**
   * Настоящие кости D&D. Список повторяет DnD5e.DICE_SIDES и DICE_SIDES
   * в server/state.js: костей на три, пять или семь граней в игре нет.
   * Сверяется проверкой в test/integration.js.
   */
  const DICE_SIDES = [4, 6, 8, 10, 12, 20, 100];

  const LIMITS = {
    /** Сколько костей допустимо в одной формуле: «50d6» — это уже не бросок. */
    maxCount: 50,
    /** Модуль к броску. Размеры листа требуют прав на ставить что угодно. */
    maxModifier: 999,
    /** Итог хранится в истории бросков и кампании, поэтому он ограничен. */
    maxResult: 9999
  };

  /**
   * Границы формулы. Модуль разрешает лишние пробелы, поэтому «2 d6 + 3»
   * разбирается так же, как «2d6+3»: разбирать пробелы по месту куда дороже.
   *   1. сколько костей, пусто значит одна: «d20»
   *   2. грани, только из списка настоящих
   *   3. что оставить или отбросить: kh/kl — оставить, dh/dl — отбросить
   *   4. модуль со знаком: «+3», «-1»
   */
  const FORMULA = /^(\d*)d(\d+)(?:(kh|kl|dh|dl)(\d+))?([+-]\d+)?$/;

  /**
   * Разбирает формулу броска.
   *
   * @param {string} text Что ввёл игрок, например «2d6+3».
   * @returns {{ok: true, source: string, count: number, sides: number,
   *   keep: {mode: string, value: number}|null, modifier: number}
   *   |{ok: false, error: string}}
   */
  function parseFormula(text) {
    const source = String(text == null ? '' : text).trim();
    const compact = source.replace(/\s+/g, '').toLowerCase();
    if (!compact) {
      return { ok: false, error: 'Введите формулу броска, например 2d6+3' };
    }
    const match = FORMULA.exec(compact);
    if (!match) {
      return {
        ok: false,
        error: `Не понял формулу «${source}». Примеры: 2d6+3, 4d6dl1, d20, 2d20kh1`
      };
    }
    const count = match[1] === '' ? 1 : Number(match[1]);
    const sides = Number(match[2]);
    const keepMode = match[3] || null;
    const keepValue = match[4] === undefined ? null : Number(match[4]);
    const modifier = match[5] === undefined ? 0 : Number(match[5]);

    if (!Number.isInteger(count) || count < 1 || count > LIMITS.maxCount) {
      return { ok: false, error: `Костей в броске должно быть от 1 до ${LIMITS.maxCount}` };
    }
    if (!DICE_SIDES.includes(sides)) {
      return {
        ok: false,
        error: `Костей d${sides} не бывает. Доступны ${DICE_SIDES.map((n) => `d${n}`).join(', ')}`
      };
    }
    if (keepMode && (!Number.isInteger(keepValue) || keepValue < 1 || keepValue > count)) {
      return {
        ok: false,
        error: `«${keepMode}${keepValue}» не имеет смысла при ${count} костях в броске`
      };
    }
    if (!Number.isInteger(modifier) || Math.abs(modifier) > LIMITS.maxModifier) {
      return {
        ok: false,
        error: `Модуль должен быть от ${-LIMITS.maxModifier} до ${LIMITS.maxModifier}`
      };
    }
    return {
      ok: true,
      source,
      normalized: compact,
      count,
      sides,
      keep: keepMode ? { mode: keepMode, value: keepValue } : null,
      modifier
    };
  }

  /**
   * Раскладывает разобранную формулу: бросает кости, отбрасывает лишние и
   * складывает итог с модулем.
   *
   * @param {object} parsed Результат parseFormula с ok: true.
   * @param {(min: number, max: number) => number} randomInt Случайное целое от min до max включительно.
   * @returns {{formula: string, count: number, sides: number, values: number[],
   *   keptValues: number[], droppedValues: number[], modifier: number, result: number}}
   */
  function rollFormula(parsed, randomInt) {
    const values = [];
    for (let i = 0; i < parsed.count; i += 1) {
      values.push(randomInt(1, parsed.sides));
    }

    // Что уходит в итог. Сортируем копию: порядок бросков в истории должен
    // остаться настоящим, а не переставленным.
    let keptValues = values.slice();
    let droppedValues = [];
    if (parsed.keep) {
      // По убыванию: сначала идут крупные.
      const byValue = values.slice().sort((a, b) => b - a);
      const mode = parsed.keep.mode;
      const size = parsed.keep.value;
      const dropHigh = mode === 'dh';
      const dropLow = mode === 'dl';
      if (mode === 'kh') keptValues = byValue.slice(0, size);
      else if (mode === 'kl') keptValues = byValue.slice(-size);
      else if (dropHigh) {
        keptValues = byValue.slice(size);
        droppedValues = byValue.slice(0, size);
      } else if (dropLow) {
        droppedValues = byValue.slice(-size);
        keptValues = byValue.slice(0, byValue.length - size);
      }
      droppedValues.sort((a, b) => a - b);
    }

    const sum = keptValues.reduce((acc, value) => acc + value, 0);
    const result = Math.max(-LIMITS.maxResult, Math.min(LIMITS.maxResult, sum + parsed.modifier));
    return {
      formula: parsed.normalized,
      count: parsed.count,
      sides: parsed.sides,
      values,
      keptValues,
      droppedValues,
      modifier: parsed.modifier,
      result
    };
  }

  /**
   * Строка броска для чата и истории.
   *
   * Имя сюда не входит: в чате автор и так стоит рядом с текстом, и «Артём:
   * Артём бросил d20» выглядит ошибкой.
   *
   * Тайный бросок мастера показывается как «бросил 2d6+3 тайно»: игроки видят,
   * что мастер что-то бросил, но не видят числа. Отброшенные кости пишем
   * явно — иначе «4d6dl1: 14» выглядит как ошибка сложения.
   *
   * @param {object} roll Результат rollFormula с полем hidden.
   * @returns {string}
   */
  function describeRoll(roll) {
    const head = `бросил ${roll.formula}`;
    if (roll.hidden) return `${head} тайно`;
    let text = `${head}: ${roll.result}`;
    if (roll.droppedValues && roll.droppedValues.length) {
      text += ` (отброшено ${roll.droppedValues.join(' + ')})`;
    }
    return text;
  }

  /**
   * Бросок без результата: так его видят игроки, когда мастер бросил тайно.
   * Число убирается на сервере, а не в интерфейсе, иначе оно утечёт
   * в снимок состояния, который игрок получает целиком.
   * @param {object} roll
   * @returns {object}
   */
  function hideRollResult(roll) {
    if (!roll || !roll.hidden) return roll;
    const { result, values, keptValues, droppedValues, ...rest } = roll;
    return { ...rest, result: null };
  }

  const api = { DICE_SIDES, LIMITS, FORMULA, parseFormula, rollFormula, describeRoll, hideRollResult };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DnDDice = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);