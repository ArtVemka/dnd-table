'use strict';

/**
 * Постоянная личность iroh.
 *
 * Без сохранённого ключа каждый запуск создаёт новый endpoint, а значит и новый
 * билет: после перезапуска мастера игрокам пришлось бы заново присылать билет.
 * Ключ лежит в папке данных рядом с кампаниями, но не внутри кампании: это
 * личность приложения, а не конкретной игры.
 */

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'iroh-identity.json';

/**
 * @param {number[]} bytes
 * @returns {boolean}
 */
function isKey(bytes) {
  return Array.isArray(bytes)
    && bytes.length === 32
    && bytes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255);
}

/**
 * Читает ключ из папки данных или создаёт новый.
 *
 * @param {string} dataDir
 * @param {{ generate: () => { toBytes: () => number[] } }} SecretKey
 * @returns {number[]} 32 байта
 */
function loadOrCreateKey(dataDir, SecretKey) {
  const file = path.join(dataDir, FILE_NAME);
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isKey(stored && stored.key)) return stored.key;
  } catch (error) {
    // Файла нет или он испорчен: ниже создадим новый ключ.
  }

  const key = Array.from(SecretKey.generate().toBytes());
  if (!isKey(key)) throw new Error('iroh вернул ключ неверной длины');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ key }, null, 2), { mode: 0o600 });
  } catch (error) {
    // Не смогли сохранить: подключение сработает, но билет сменится после
    // перезапуска. Молчать нельзя, иначе это выглядит как случайный разрыв.
    console.warn('[iroh] не удалось сохранить ключ личности:', error.message);
  }
  return key;
}

module.exports = { FILE_NAME, isKey, loadOrCreateKey };
