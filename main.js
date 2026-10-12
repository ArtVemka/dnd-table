'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, shell } = require('electron');

const { CampaignStore } = require('./server/campaign');
const { createTableServer } = require('./server/socket');
const { RoomState } = require('./server/state');
const irohManager = require('./server/iroh-manager');
const { copyVendor } = require('./scripts/copy-vendor');
const packageJson = require('./package.json');

/** Ленивая загрузка iroh — загружается только по запросу из IPC handler,
 *  чтобы не ломать require('electron') при старте в Electron < 20. */
let irohMgr = null;
function getIrohManager() {
  if (!irohMgr) {
    try {
      irohMgr = require('./server/iroh-manager');
    } catch (error) {
      console.warn('[iroh] не удалось загрузить:', error.message);
      // Stub methods for graceful degradation when iroh is unavailable
      irohMgr = {
        start: async () => ({ ok: false, error: 'P2P недоступен' }),
        stop: async () => ({ ok: true }),
        createTicket: () => ({ ok: false, error: 'P2P недоступен' }),
        connect: async (ticketStr) => {
          if (!irohMgr.tunnel) throw new Error('Tunnel not established');
          await irohMgr.tunnel.connect(ticketStr);
        },
        listPeers: () => ({ ok: false, peers: [] }),
        getStatus: () => ({ ok: false, error: 'P2P недоступен' }),
        getId: () => null,
        getAddr: () => null,
        isRunning: () => false,
        startTunnelServer: async (port) => ({ ok: false, error: 'P2P недоступен' }),
        startTunnelClient: async (ticketStr) => {
          if (!irohMgr.tunnel) throw new Error('Tunnel not established');
          await irohMgr.tunnel.connect(ticketStr);
        },
        stopTunnelClient: async () => ({ ok: true })
      };
    }
  }
  return irohMgr;
}

const AUTOSAVE_INTERVAL_MS = 60 * 1000;
/**
 * Версия приложения. Читаем её из своего package.json, а не через
 * app.getVersion(): при запуске вида «electron test/smoke-main.js» Electron
 * считает приложением переданный файл и отдаёт версию самого Electron.
 */
const APP_VERSION = String(packageJson.version || '0.0.0');
/** Ярлык для интерфейса: «0.9.0-b» показываем как «0.9b». */
const APP_VERSION_LABEL = APP_VERSION.replace(/^(\d+\.\d+)\.0-/, '$1');

/** @type {BrowserWindow|null} */
let mainWindow = null;
/**
 * Отдельные окна с листами персонажей: id -> { window, context }.
 * Игрок может вынести свой лист, ДМ — открыть лист игрока.
 * @type {Map<string, {window: BrowserWindow, context: object}>}
 */
const sheetWindows = new Map();
/** @type {CampaignStore|null} */
let store = null;
/** Текущая кампания (созданная или загруженная, ещё не обязательно запущенная). */
let currentCampaign = null;
/** Запущенный стол: { server, room, hostKey, port, addresses, localUrl }. */
let host = null;
let autosaveTimer = null;
let dirty = false;
let saving = false;
let quitting = false;

/* -------------------------------------------------------------------------- *
 * Папка данных
 * -------------------------------------------------------------------------- */

/**
 * Портативный режим — три случая:
 *
 *  1. Однофайловая portable-сборка (`npm run dist`, цель portable): Electron
 *     распаковывает приложение во временную папку, а папку, откуда запущен exe,
 *     сообщает в переменной PORTABLE_EXECUTABLE_DIR. Данные кладём рядом с exe.
 *  2. Портативная папка с файлом-маркером portable.txt (цель dir) — данные в ./data.
 *  3. Обычная установка — стандартная папка данных приложения
 *     (app.getPath('userData')).
 */
function resolveDataDir() {
  const portableHome = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableHome) {
    return { dir: path.join(portableHome, 'data'), portable: true };
  }

  const candidates = [path.dirname(process.execPath), __dirname];
  for (const base of candidates) {
    if (fs.existsSync(path.join(base, 'portable.txt'))) {
      return { dir: path.join(base, 'data'), portable: true };
    }
  }
  return { dir: app.getPath('userData'), portable: false };
}

/* -------------------------------------------------------------------------- *
 * Окно
 * -------------------------------------------------------------------------- */

function createWindow() {
  // Автоматические проверки (npm run smoke / dist:verify) запускают настоящее
  // приложение, но окно им не нужно — с этим флагом оно создаётся невидимым,
  // чтобы не мелькать на экране. Вся логика при этом работает как обычно.
  const hidden = process.env.DND_HIDE_WINDOW === '1' || process.argv.includes('--hidden');

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 700,
    show: !hidden,
    backgroundColor: '#15110d',
    title: 'D&D Стол',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/* -------------------------------------------------------------------------- *
 * Отдельное окно с листом персонажа
 * -------------------------------------------------------------------------- */

/**
 * Открывает лист в своём окне. Так удобнее за столом: окно можно отодвинуть
 * на второй монитор и не занимать им панель стола.
 *
 * В тренировочном столе (`training`) сервера нет, поэтому окно подключается не к
 * столу, а к тому же черновику листа в хранилище окон: общее хранилище — это и
 * есть канал связи между окнами.
 *
 * @param {{name?: string, role?: string, playerId?: string, viewPlayerId?: string, readOnly?: boolean, title?: string, training?: boolean}} request
 * @returns {{ok: boolean, error?: string, id?: string}}
 */
function openSheetWindow(request = {}) {
  const training = Boolean(request.training);
  if (!host && !training) return { ok: false, error: 'Стол не запущен — открывать лист не из чего' };
  const viewPlayerId = String(request.viewPlayerId || '');
  if (!viewPlayerId) return { ok: false, error: 'Не указано, чей лист открывать' };

  const id = crypto.randomUUID();
  const readOnly = Boolean(request.readOnly);
  const title = String(request.title || 'Лист персонажа').slice(0, 120);
  // Роль решает main-процесс, а не окно: секрет стола наружу не отдаём.
  const isDm = request.role === 'dm';

  const context = {
    url: host ? host.localUrl : '',
    // hostKey наружу не уходит: окно забирает контекст по случайному id.
    hostKey: isDm && host ? host.hostKey : '',
    playerId: isDm ? 'dm' : String(request.playerId || ''),
    name: String(request.name || 'Игрок').slice(0, 40),
    viewPlayerId,
    readOnly,
    title,
    training
  };

  const window = new BrowserWindow({
    width: 900,
    height: 760,
    minWidth: 520,
    minHeight: 420,
    title,
    backgroundColor: '#15110d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-sheet.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      additionalArguments: [`--sheet-context-id=${id}`]
    }
  });

  sheetWindows.set(id, { window, context });
  window.loadFile(path.join(__dirname, 'renderer', 'sheet-window.html'));
  window.on('closed', () => sheetWindows.delete(id));
  return { ok: true, id };
}

/** Закрывает все окна листов: например, когда ДМ останавливает стол. */
function closeSheetWindows() {
  for (const { window } of sheetWindows.values()) {
    if (!window.isDestroyed()) window.close();
  }
  sheetWindows.clear();
}

/* -------------------------------------------------------------------------- *
 * Автосохранение
 * -------------------------------------------------------------------------- */

function campaignMeta(campaign) {
  if (!campaign) return null;
  return {
    id: campaign.id,
    name: campaign.name,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    version: campaign.version
  };
}

/**
 * Переносит текущее состояние стола в кампанию и пишет её на диск.
 * @returns {Promise<object|null>}
 */
async function persistCampaign({ notify = false } = {}) {
  if (!currentCampaign) return null;
  if (saving) return campaignMeta(currentCampaign);
  saving = true;
  try {
    if (host && host.room) {
      currentCampaign.state = host.room.serialize();
    }
    await store.save(currentCampaign);
    dirty = false;
    const meta = campaignMeta(currentCampaign);
    if (notify) sendToRenderer('campaign:saved', { meta, reason: 'auto' });
    return meta;
  } catch (error) {
    sendToRenderer('campaign:error', { message: `Не удалось сохранить кампанию: ${error.message}` });
    return null;
  } finally {
    saving = false;
  }
}

function startAutosave() {
  stopAutosave();
  autosaveTimer = setInterval(() => {
    if (dirty && host) persistCampaign({ notify: true });
  }, AUTOSAVE_INTERVAL_MS);
}

function stopAutosave() {
  if (autosaveTimer) clearInterval(autosaveTimer);
  autosaveTimer = null;
}

function markDirty() {
  dirty = true;
}

/* -------------------------------------------------------------------------- *
 * Запуск и остановка стола
 * -------------------------------------------------------------------------- */

async function stopHost() {
  if (!host) return null;
  const { server } = host;
  // Сохраняем состояние до остановки сервера.
  await persistCampaign({ notify: true });
  // Стол гаснет — P2P-эндпоинт больше не нужен.
  stopIrohForTable();
  // Стол гаснет — отдельные окна листов подключать больше не к чему.
  closeSheetWindows();
  await server.close();
  host = null;
  stopAutosave();
  return true;
}

/**
 * @returns {Promise<object>}
 */
async function startHost() {
  if (!currentCampaign) {
    throw new Error('Сначала создайте или загрузите кампанию');
  }
  await stopHost();
  // Окна листов, открытые в тренировочном столе, к новому серверу отношения не
  // имеют: они подключались не к столу, а к своему черновику. Закрываем их,
  // чтобы человек не правил сразу два разных листа.
  closeSheetWindows();

  const room = new RoomState(currentCampaign);
  const hostKey = crypto.randomBytes(24).toString('hex');
  const preferredPort = await pickPreferredPort();

  const server = await createTableServer({
    room,
    store,
    hostKey,
    preferredPort,
    onDirty: markDirty,
    onLog: (message) => sendToRenderer('host:log', { message, time: new Date().toISOString() })
  });

  host = {
    server,
    room,
    hostKey,
    port: server.port,
    addresses: server.addresses,
    localUrl: server.localUrl
  };
  dirty = false;
  startAutosave();

  // Запускаем P2P-эндпоинт iroh для прямого подключения игроков друг к другу.
  startIrohForTable();

  return {
    port: server.port,
    localUrl: server.localUrl,
    addresses: server.addresses,
    hostKey,
    campaign: campaignMeta(currentCampaign)
  };
}

async function pickPreferredPort() {
  const { findFreePort } = require('./server/net');
  return findFreePort({ preferred: 32100, count: 128 });
}

function hostStatus() {
  if (!host) return { running: false };
  return {
    running: true,
    port: host.port,
    localUrl: host.localUrl,
    addresses: host.addresses,
    hostKey: host.hostKey,
    campaign: campaignMeta(currentCampaign)
  };
}

/* -------------------------------------------------------------------------- *
 * iroh — P2P-интеграция со столом
 * -------------------------------------------------------------------------- */

/** Запустить iroh Endpoint и P2P-туннель вместе с запуском стола. */
async function startIrohForTable() {
  try {
    const result = await getIrohManager().start();
    if (!result.ok) {
      console.warn('[iroh] endpoint не запущен:', result.error);
      return;
    }
    console.log(`[iroh] endpoint started: id=${result.id}`);
    // ДМ принимает подключения игроков и прокладывает их к socket.io-серверу.
    if (host && host.port) {
      const tunnel = await getIrohManager().startTunnelServer(host.port);
      if (tunnel.ok) console.log('[iroh] P2P-туннель ДМ запущен, билет готов');
      else console.warn('[iroh] tunnel server:', tunnel.error);
    }
  } catch (error) {
    console.error('[iroh] failed to start:', error.message);
  }
}

/** Остановить iroh Endpoint при остановке стола. */
function stopIrohForTable() {
  getIrohManager().stop().catch((err) => console.error('[iroh] failed to stop:', err.message));
}

/* -------------------------------------------------------------------------- *
 * IPC
 * -------------------------------------------------------------------------- */

function registerIpc() {
  const { dir, portable } = resolveDataDir();
  const campaignsDir = path.join(dir, 'campaigns');
  store = new CampaignStore(campaignsDir);

  ipcMain.handle('app:config', () => ({
    version: APP_VERSION,
    versionLabel: APP_VERSION_LABEL,
    dataDir: dir,
    campaignsDir,
    portable,
    platform: process.platform,
    isElectron: true
  }));

  ipcMain.handle('campaign:list', async () => ({ campaigns: await store.list() }));

  ipcMain.handle('campaign:create', async (event, name) => {
    try {
      await stopHost();
      currentCampaign = await store.create(name);
      return { ok: true, campaign: campaignMeta(currentCampaign) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('campaign:load', async (event, id) => {
    try {
      await stopHost();
      currentCampaign = await store.load(id);
      return { ok: true, campaign: campaignMeta(currentCampaign) };
    } catch (error) {
      return { ok: false, error: `Не удалось загрузить кампанию: ${error.message}` };
    }
  });

  ipcMain.handle('campaign:current', async () => campaignMeta(currentCampaign));

  ipcMain.handle('campaign:save', async () => {
    if (!currentCampaign) return { ok: false, error: 'Кампания не выбрана' };
    const meta = await persistCampaign({ notify: true });
    if (!meta) return { ok: false, error: 'Не удалось сохранить кампанию' };
    return { ok: true, campaign: meta };
  });

  ipcMain.handle('campaign:delete', async (event, id) => {
    try {
      if (currentCampaign && currentCampaign.id === id) {
        await stopHost();
        currentCampaign = null;
      }
      await store.remove(id);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('host:start', async () => {
    try {
      const info = await startHost();
      return { ok: true, ...info };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('host:stop', async () => {
    try {
      await stopHost();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('host:status', async () => hostStatus());

  // --------------------------------------------------------------------------
  // iroh — P2P-подключения между участниками стола
  // --------------------------------------------------------------------------

  ipcMain.handle('iroh:start', async () => {
    try {
      await startIrohForTable();
      const status = getIrohManager().getStatus();
      return { ok: status.ok, id: status.id || undefined };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('iroh:stop', async () => {
    stopIrohForTable();
    return { ok: true };
  });

  ipcMain.handle('iroh:create-ticket', async () => {
    try {
      const result = getIrohManager().createTicket();
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, ticket: result.ticket };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('iroh:connect', async (event, ticketStr) => {
    try {
      if (!ticketStr || typeof ticketStr !== 'string') {
        return { ok: false, error: 'Отсутствует билет' };
      }
      const result = await getIrohManager().connect(ticketStr);
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('iroh:list-peers', async () => {
    return getIrohManager().listPeers();
  });

  ipcMain.handle('iroh:get-status', async () => {
    return getIrohManager().getStatus();
  });

  ipcMain.handle('iroh:id', async () => {
    return { id: getIrohManager().getId() };
  });

  // P2P-туннель: игрок подключается по билету, получает локальный порт,
  // на который renderer натравливает socket.io-клиент.
  ipcMain.handle('iroh:tunnel-client', async (event, ticketStr) => {
    try {
      if (!ticketStr || typeof ticketStr !== 'string') {
        return { ok: false, error: 'Отсутствует P2P-билет' };
      }
      const result = await getIrohManager().startTunnelClient(ticketStr);
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, localPort: result.localPort };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('iroh:tunnel-stop', async () => {
    await getIrohManager().stopTunnelClient();
    return { ok: true };
  });

  // Лист персонажа в отдельном окне.
  ipcMain.handle('sheet:openWindow', async (event, request) => openSheetWindow(request || {}));

  ipcMain.handle('sheet:context', async (event, id) => {
    const entry = sheetWindows.get(String(id || ''));
    return entry ? entry.context : null;
  });

  ipcMain.handle('shell:openDataDir', async () => {
    const { dir } = resolveDataDir();
    await shell.openPath(dir);
    return { ok: true };
  });

  // Ссылки открываем только http(s): renderer не должен уметь запускать что угодно.
  ipcMain.handle('shell:openExternal', async (event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'Ссылка должна начинаться с http:// или https://' };
    }
    await shell.openExternal(url);
    return { ok: true };
  });
}

/* -------------------------------------------------------------------------- *
 * Жизненный цикл
 * -------------------------------------------------------------------------- */

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (quitting || !host) return;
  // Даём серверу корректно остановиться и сохраняем кампанию.
  event.preventDefault();
  quitting = true;
  stopHost()
    .catch((error) => console.error('Ошибка остановки стола:', error))
    .finally(() => app.quit());
});

app.whenReady().then(() => {
  // В собранном приложении socket.io-client уже лежит внутри пакета, а писать
  // в app.asar нельзя — обновляем файл только при запуске из исходников.
  if (!app.isPackaged) {
    try {
      copyVendor();
    } catch (error) {
      console.warn('[vendor] не удалось обновить socket.io-client:', error.message);
    }
  }
  registerIpc();
  createWindow();
});
