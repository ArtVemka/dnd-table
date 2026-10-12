'use strict';

/**
 * Сетевые утилиты: перечисление локальных IPv4-адресов, их классификация
 * (локальная сеть / виртуальная сеть) и выбор свободного TCP-порта.
 *
 * Приложение НЕ создаёт сеть и НЕ поднимает VPN. Оно только показывает адреса
 * уже существующих интерфейсов, чтобы игроки могли подключиться.
 */

const net = require('net');
const os = require('os');

const LOOPBACK = /^127\./;

/**
 * Известные виртуальные сетевые адаптеры. Имя адаптера важнее диапазона:
 * Hamachi, Radmin VPN и ZeroTier часто раздают адреса из 10.* или 172.16-31.*,
 * то есть из тех же диапазонов, что и обычная домашняя сеть.
 */
const VIRTUAL_ADAPTERS = [
  { pattern: /hamachi/i, label: 'Hamachi', hint: 'Виртуальная сеть LogMeIn Hamachi' },
  { pattern: /radmin/i, label: 'Radmin VPN', hint: 'Виртуальная сеть Radmin VPN' },
  { pattern: /porthole/i, label: 'Porthole', hint: 'Porthole (Steam) — проброс порта стола' },
  { pattern: /zerotier/i, label: 'ZeroTier', hint: 'Виртуальная сеть ZeroTier' },
  { pattern: /tailscale/i, label: 'Tailscale', hint: 'Виртуальная сеть Tailscale' },
  { pattern: /(wintun|tap|tun|openvpn|wireguard|vpn)/i, label: 'Виртуальная сеть', hint: 'Виртуальный сетевой адаптер' }
];

/**
 * Определяет категорию IPv4-адреса по имени адаптера и диапазону.
 * @param {string} ip
 * @param {string} [iface] имя сетевого адаптера, если известно
 * @returns {{kind: 'lan'|'virtual'|'link-local'|'other', label: string, hint: string}}
 */
function classifyAddress(ip, iface = '') {
  if (LOOPBACK.test(ip)) {
    return { kind: 'other', label: 'Этот компьютер', hint: 'Только для проверки на машине ДМ' };
  }
  for (const adapter of VIRTUAL_ADAPTERS) {
    if (adapter.pattern.test(iface)) {
      return { kind: 'virtual', label: adapter.label, hint: adapter.hint };
    }
  }
  if (/^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
    return { kind: 'lan', label: 'Локальная сеть', hint: 'Wi-Fi или кабель в одной сети с игроками' };
  }
  if (/^25\./.test(ip)) {
    return { kind: 'virtual', label: 'Hamachi', hint: 'Виртуальная сеть LogMeIn Hamachi' };
  }
  if (/^26\./.test(ip)) {
    return { kind: 'virtual', label: 'Radmin VPN', hint: 'Виртуальная сеть Radmin VPN' };
  }
  // 100.64.0.0/10 — CGNAT, его используют ZeroTier и Tailscale.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) {
    return { kind: 'virtual', label: 'ZeroTier', hint: 'Диапазон 100.64.0.0/10 (CGNAT) — так работают ZeroTier и Tailscale' };
  }
  if (/^169\.254\./.test(ip)) {
    return { kind: 'link-local', label: 'Link-local', hint: 'Обычно не подходит для подключения' };
  }
  return { kind: 'other', label: 'Другая сеть', hint: '' };
}

const KIND_ORDER = { lan: 0, virtual: 1, other: 2, 'link-local': 3 };

/**
 * Список IPv4-адресов машины, отсортированный: локальная сеть -> виртуальная -> прочее.
 * @returns {Array<{iface:string,address:string,kind:string,label:string,hint:string}>}
 */
function getLocalAddresses() {
  const result = [];
  const interfaces = os.networkInterfaces();
  for (const [iface, list] of Object.entries(interfaces)) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      result.push({ iface, address: info.address, ...classifyAddress(info.address, iface) });
    }
  }
  result.sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || a.address.localeCompare(b.address));
  return result;
}

/**
 * Проверяет, свободен ли порт: пробуем реально занять его на 0.0.0.0.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '0.0.0.0');
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

module.exports = { classifyAddress, getLocalAddresses, findFreePort, isPortFree };
