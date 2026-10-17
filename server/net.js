'use strict';

/**
 * Выбор свободного TCP-порта для стола.
 *
 * Сеть создаёт только iroh: игроки приходят по P2P-билету, а сервер стола
 * слушает исключительно 127.0.0.1 и наружу не выставлен. Поэтому здесь не
 * нужно ни перечисления локальных адресов, ни их классификации — единственный
 * сетевой вопрос это «какой порт занять».
 */

const net = require('net');

/**
 * Проверяет, свободен ли порт: пробуем реально занять его на loopback.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    // Слушаем так же, как сам стол. Проверка на 0.0.0.0 занижала наличие
    // порта: процесс, занявший его только на loopback, считался бы свободным,
    // и listen() затем падал бы с EADDRINUSE.
    probe.listen(port, '127.0.0.1');
  });
}

/**
 * Выбор свободного порта: перебираем диапазон, начиная от preferred,
 * а если ни один не подошёл — отдаём 0 (порт назначит ОС).
 * @param {{preferred?: number, count?: number}} [options]
 * @returns {Promise<number>}
 */
async function findFreePort(options = {}) {
  const preferred = options.preferred || 32100;
  const count = options.count || 64;
  for (let i = 0; i < count; i += 1) {
    const candidate = preferred + i;
    if (candidate > 65535) break;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(candidate)) return candidate;
  }
  return 0;
}

module.exports = { findFreePort, isPortFree };
