'use strict';

/**
 * Ошибки конвейера импорта.
 *
 * Каждая ошибка несёт код: интерфейс показывает текст, но по коду понимает,
 * что именно произошло, и решает, можно ли предложить повторить.
 */

/** @param {string} code @param {string} message @param {object} [details] */
function importError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details, isImportError: true });
}

module.exports = {
  importError,
  E_NO_ADAPTER: 'no-adapter',
  E_UNREADABLE: 'unreadable',
  E_EMPTY: 'empty',
  E_TOO_LARGE: 'too-large'
};