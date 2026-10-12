'use strict';

/**
 * iroh — P2P-транспорт для стола.
 *
 * Настоящее P2P-подключение работает так: игра общается по socket.io (HTTP +
 * WebSocket), а мы туннелируем эти TCP-байты поверх iroh QUIC-стримов. Тогда
 * игрок может дотянуться до стола ДМ без общей сети и без VPN — iroh сам
 * пробивает NAT (напрямую, а при неудаче через публичный relay).
 *
 * Роли:
 *   ДМ     — startTunnelServer(port): слушаем iroh, каждый входящий bi-stream
 *            соединяем с локальным socket.io-сервером на 127.0.0.1:port.
 *   Игрок  — startTunnelClient(ticket): подключаемся к ДМ по iroh, поднимаем
 *            локальный TCP-слушатель и прокладываем его в iroh-стримы.
 *            Renderer подключается к socket.io на 127.0.0.1:<localPort>.
 */

const net = require('net');
const path = require('path');

/**
 * Опубликованный @number0/iroh 1.1.0 содержит неверное поле `main`
 * (`iroh-js/index.js`) — такого файла в пакете нет, поэтому обычный
 * require('@number0/iroh') всегда падает с MODULE_NOT_FOUND и P2P молча
 * выключается. Настоящая точка входа лежит в корне пакета, ищем её сами
 * (обходом через package.json, чтобы не ловить предупреждение Node о
 * неверном `main`). Если someday поле починят — останется запасной путь.
 */
function loadIroh() {
  try {
    const pkgDir = path.dirname(require.resolve('@number0/iroh/package.json'));
    return require(path.join(pkgDir, 'index.js'));
  } catch (error) {
    try {
      return require('@number0/iroh');
    } catch (fallbackError) {
      console.warn('[iroh] не удалось загрузить нативный бандл:', fallbackError.message);
      console.warn('[iroh] P2P будет недоступен (нужен нативный iroh для win32-x64).');
      return null;
    }
  }
}

const iroh = loadIroh();

const ALPN = Array.from(Buffer.from('dnd-table-p2p/1', 'utf8'));

let endpoint = null;
let stopped = true;
/**
 * Бинд в процессе. Стол ДМ поднимает endpoint сам, а renderer тут же дёргает
 * iroh:start за билетом — без этой переменной оба вызова видели endpoint = null
 * и поднимали по своему: accept-цикл уходил в один адрес, а билет выдавался
 * от второго, и подключение игрока всегда упиралось в таймаут.
 */
let binding = null;

// --- туннель ДМ (сервер) ---
let serverTargetPort = null;
const serverConns = new Set(); // iroh Connection

// --- туннель игрока (клиент) ---
let clientConn = null;
let clientTcpServer = null;
const clientSockets = new Set(); // net.Socket

/* ------------------------------------------------------------------ */
/* Вспомогательные                                                     */
/* ------------------------------------------------------------------ */

function available() {
  return !!(iroh && iroh.Endpoint);
}

function isRunning() {
  return !!(endpoint && !endpoint.isClosed());
}

async function bindEndpoint() {
  if (!available()) throw new Error('P2P недоступен: нативный бандл iroh не загружен');
  if (endpoint && !endpoint.isClosed()) return endpoint;
  if (binding) return binding;
  binding = (async () => {
    const builder = iroh.Endpoint.builder();
    builder.applyN0(); // relay + discovery: прямой коннект, при неудаче — через relay
    builder.alpns([ALPN]);
    endpoint = await builder.bind();
    stopped = false;
    return endpoint;
  })();
  try {
    return await binding;
  } finally {
    binding = null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** TCP-сокет -> iroh SendStream. */
function pipeSocketToBi(socket, bi) {
  socket.on('data', (chunk) => {
    bi.send.writeAll(Array.from(chunk)).catch(() => {});
  });
  const finish = () => { bi.send.finish().catch(() => {}); };
  socket.on('end', finish);
  socket.on('close', finish);
  socket.on('error', () => { bi.send.reset(0n).catch(() => {}); });
}

/** iroh RecvStream -> TCP-сокет. Читаем до конца потока, затем закрываем TCP. */
async function pipeBiToSocket(bi, socket) {
  try {
    for (;;) {
      const chunk = await bi.recv.read(64 * 1024);
      if (!chunk || chunk.length === 0) break; // EOF
      if (socket.destroyed) break;
      socket.write(Buffer.from(chunk));
    }
  } catch (_) {
    // стрим сброшен или закрыт
  }
  if (!socket.destroyed) socket.end();
}

/* ------------------------------------------------------------------ */
/* Общий API (endpoint)                                                */
/* ------------------------------------------------------------------ */

async function start() {
  try {
    await bindEndpoint();
    return { ok: true, id: endpoint.id().toString(), addr: endpoint.addr().toString() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function stop() {
  stopped = true;
  await stopTunnelClient();
  await stopTunnelServer();
  if (endpoint) {
    try { await endpoint.close(); } catch (_) {}
    endpoint = null;
  }
  return { ok: true };
}

function createTicket() {
  if (!isRunning()) return { ok: false, error: 'Endpoint not started' };
  try {
    const ticket = iroh.EndpointTicket.fromAddr(endpoint.addr()).toString();
    return { ok: true, ticket };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function getStatus() {
  if (!available()) return { ok: false, error: 'P2P недоступен' };
  if (!isRunning()) return { ok: false, error: 'Endpoint not started' };
  return { ok: true, id: endpoint.id().toString(), addr: endpoint.addr().toString() };
}

function getId() { return isRunning() ? endpoint.id().toString() : null; }
function getAddr() { return isRunning() ? endpoint.addr().toString() : null; }

function listPeers() {
  // Активные участники видны через сервер стола; здесь отдаём пустой список
  // для совместимости со старым интерфейсом.
  return { ok: true, peers: [] };
}

/* ------------------------------------------------------------------ */
/* Туннель ДМ (сервер)                                                 */
/* ------------------------------------------------------------------ */

async function startTunnelServer(targetPort) {
  try {
    await bindEndpoint();
    if (serverTargetPort === targetPort && !stopped) {
      return createTicket();
    }
    serverTargetPort = targetPort;
    stopped = false;
    acceptLoop();
    return createTicket();
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function acceptLoop() {
  while (!stopped && endpoint && !endpoint.isClosed()) {
    try {
      const incoming = await endpoint.acceptNext();
      if (!incoming) continue;
      const accepting = await incoming.accept();
      const conn = await accepting.connect();
      serverConns.add(conn);
      conn.closed().then(() => serverConns.delete(conn)).catch(() => {});
      // Обслуживаем bi-stream'ы этого соединения в фоне.
      handleServerConn(conn, serverTargetPort).catch((e) => {
        if (!stopped) console.warn('[iroh] server conn error:', e.message);
      });
    } catch (e) {
      if (!stopped) await sleep(200);
    }
  }
}

async function handleServerConn(conn, targetPort) {
  try {
    for (;;) {
      const bi = await conn.acceptBi();
      const socket = net.connect(targetPort, '127.0.0.1');
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      serverConns.add(socket);
      socket.on('close', () => serverConns.delete(socket));
      socket.on('error', () => {});
      pipeSocketToBi(socket, bi);
      pipeBiToSocket(bi, socket); // fire-and-forget
    }
  } catch (_) {
    // соединение закрылось — acceptBi() отвалился
  }
}

async function stopTunnelServer() {
  serverTargetPort = null;
  for (const item of serverConns) {
    try {
      if (typeof item.destroy === 'function') item.destroy();
      else if (typeof item.close === 'function') item.close(0n, Array.from(Buffer.from('bye')));
    } catch (_) {}
  }
  serverConns.clear();
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Туннель игрока (клиент)                                             */
/* ------------------------------------------------------------------ */

async function startTunnelClient(ticketStr) {
  try {
    await bindEndpoint();
    await stopTunnelClientInternal();

    const addr = iroh.EndpointTicket.fromString(ticketStr).endpointAddr();
    clientConn = await endpoint.connect(addr, ALPN);

    clientTcpServer = net.createServer((socket) => {
      clientSockets.add(socket);
      socket.on('close', () => clientSockets.delete(socket));
      socket.on('error', () => {});
      (async () => {
        try {
          const bi = await clientConn.openBi();
          pipeSocketToBi(socket, bi);
          pipeBiToSocket(bi, socket);
        } catch (e) {
          socket.destroy();
        }
      })();
    });

    const port = await new Promise((resolve, reject) => {
      clientTcpServer.once('error', reject);
      clientTcpServer.listen(0, '127.0.0.1', () => {
        resolve(clientTcpServer.address().port);
      });
    });

    return { ok: true, localPort: port };
  } catch (error) {
    await stopTunnelClientInternal();
    return { ok: false, error: error.message };
  }
}

async function stopTunnelClientInternal() {
  for (const socket of clientSockets) {
    try { socket.destroy(); } catch (_) {}
  }
  clientSockets.clear();
  if (clientTcpServer) {
    try { await new Promise((r) => clientTcpServer.close(() => r())); } catch (_) {}
    clientTcpServer = null;
  }
  if (clientConn) {
    try { clientConn.close(0n, Array.from(Buffer.from('bye'))); } catch (_) {}
    clientConn = null;
  }
}

async function stopTunnelClient() {
  await stopTunnelClientInternal();
  return { ok: true };
}

/** Совместимость со старым вызовом: подключение без туннеля (для статуса). */
async function connect(ticketStr) {
  try {
    await bindEndpoint();
    const addr = iroh.EndpointTicket.fromString(ticketStr).endpointAddr();
    const conn = await endpoint.connect(addr, ALPN);
    conn.close(0n, Array.from(Buffer.from('bye')));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = {
  available,
  start,
  stop,
  createTicket,
  connect,
  listPeers,
  getStatus,
  getId,
  getAddr,
  isRunning,
  startTunnelServer,
  startTunnelClient,
  stopTunnelClient
};
