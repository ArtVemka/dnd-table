'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');

const { CampaignStore } = require('./server/campaign');
const { createTableServer } = require('./server/socket');
const { RoomState, LIMITS, normalizeAdventure } = require('./server/state');
const { decodeImage } = require('./server/image');
const importer = require('./server/importer');
const open5e = require('./server/open5e');
const { copyVendor } = require('./scripts/copy-vendor');
const { versionLabel } = require('./scripts/version-label');
const packageJson = require('./package.json');

/** Иконка окна: build/icon.png попадает и в asar, и в портативную сборку. */
const APP_ICON = path.join(__dirname, 'build', 'icon.png');

/* Атмосфера на главном экране должна звучать с момента запуска приложения.
 * В Chromium аудио до жеста блокируется; в Electron мы сами себе браузер,
 * и ждать первого клика было незачем: звук раньше появлялся только после
 * открытия настроек. */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

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
        setDataDir: () => {},
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
  // Ключ личности живёт в папке данных: тогда после перезапуска мастера
  // endpoint и билет остаются прежними.
  if (typeof irohMgr.setDataDir === 'function') {
    try {
      irohMgr.setDataDir(resolveDataDir().dir);
    } catch (error) {
      console.warn('[iroh] не удалось выбрать папку для ключа:', error.message);
    }
  }
  return irohMgr;
}

/** Автосохранение кампании по умолчанию: раз в минуту. */
const DEFAULT_AUTOSAVE_INTERVAL_MS = 60 * 1000;
/** Границы выбора из настроек: чаще пяти секунд писать файл незачем. */
const AUTOSAVE_MIN_MS = 5 * 1000;
const AUTOSAVE_MAX_MS = 60 * 60 * 1000;
/**
 * Автокопия кампании при старте стола: не чаще раза в сутки. Копия всей
 * папки это страховка от порчи JSON и потерянных картинок, и делать её на
 * каждый запуск незачем.
 */
const BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * Версия приложения. Читаем её из своего package.json, а не через
 * app.getVersion(): при запуске вида «electron test/smoke-main.js» Electron
 * считает приложением переданный файл и отдаёт версию самого Electron.
 */
const APP_VERSION = String(packageJson.version || '0.0.0');
/**
 * Ярлык для интерфейса: «0.9.0-b» показываем как «0.9b», а обычную версию
 * как есть. Правило лежит в scripts, потому что его читает и проверка собранной
 * программы, и своя копия здесь разъехалась бы с ней при первом же выпуске.
 */
const APP_VERSION_LABEL = versionLabel(APP_VERSION);

/** @type {BrowserWindow|null} */
let mainWindow = null;
/**
 * Отдельные окна с листами персонажей: id -> { window, context }.
 * Игрок может вынести свой лист, ДМ — открыть лист игрока.
 * @type {Map<string, {window: BrowserWindow, context: object}>}
 */
const sheetWindows = new Map();
/**
 * Отдельные окна журнала: id -> { window, context }. Журнал ведёт только
 * мастер, поэтому окно подключается к запущенному столу с его hostKey.
 * @type {Map<string, {window: BrowserWindow, context: object}>}
 */
const journalWindows = new Map();
/** @type {CampaignStore|null} */
let store = null;
/** Текущая кампания (созданная или загруженная, ещё не обязательно запущенная). */
let currentCampaign = null;
/** Запущенный стол: { server, room, hostKey, port, localUrl }. */
let host = null;
let autosaveTimer = null;
/** Текущий интервал автосохранения: его выбирают в настройках. */
let autosaveIntervalMs = DEFAULT_AUTOSAVE_INTERVAL_MS;
let dirty = false;
/**
 * Номер изменения состояния. По нему видно, трогали ли стол во время записи:
 * если за время save() счётчик вырос, снимать «грязный» флаг нельзя.
 */
let dirtyVersion = 0;
let saving = false;
/** Во время записи пришёл ещё один запрос на сохранение. */
let saveRequested = false;
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
    icon: APP_ICON,
    title: 'D&D Стол',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // Атмосфера должна звучать сразу: не ждём первого клика по настройкам.
      autoplayPolicy: 'no-user-gesture-required'
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
    // Адрес стола берём из запроса, а не только у себя. Главный процесс игрока
    // сервер не запускал, у него нет `host`, и раньше игрок не мог вынести свой
    // лист в отдельное окно: кнопка отвечала «стол не запущен».
    const requestedUrl = String(request.url || '').replace(/\/+$/, '');
    const serverUrl = host ? host.localUrl : requestedUrl;
    if (!training && !serverUrl) return { ok: false, error: 'Стол не запущен — открывать лист не из чего' };
  const viewPlayerId = String(request.viewPlayerId || '');
  if (!viewPlayerId) return { ok: false, error: 'Не указано, чей лист открывать' };

  const id = crypto.randomUUID();
  const readOnly = Boolean(request.readOnly);
  const title = String(request.title || 'Лист персонажа').slice(0, 120);
  // Роль решает main-процесс, а не окно: секрет стола наружу не отдаём.
  const isDm = request.role === 'dm';

  const context = {
      url: serverUrl,
    // hostKey наружу не уходит: окно забирает контекст по случайному id.
    hostKey: isDm && host ? host.hostKey : '',
    playerId: isDm ? 'dm' : String(request.playerId || ''),
    // Секрет личности игрока: окно листа входит тем же кодом, что и стол,
    // и без секрета стол не пустил бы его к своему листу.
    playerKey: isDm ? '' : String(request.playerKey || '').slice(0, 128),
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
    icon: APP_ICON,
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
 * Отдельное окно журнала кампании
 * -------------------------------------------------------------------------- */

/**
 * Открывает журнал в своём окне: мастер держит его рядом со столом и не
 * занимает им левую колонку.
 *
 * @param {{title?: string}} request
 * @returns {{ok: boolean, error?: string, id?: string}}
 */
function openJournalWindow(request = {}) {
  // Стол запускает только мастер, и hostKey берём у него же: окно журнала
  // должно войти в комнату мастеров, а не пересказывать секрет из renderer.
  if (!host) return { ok: false, error: 'Стол не запущен: журнал открывать не из чего' };

  const id = crypto.randomUUID();
  const title = String(request.title || 'Журнал кампании').slice(0, 120);
  const context = {
    url: host.localUrl,
    hostKey: host.hostKey,
    title
  };

  const window = new BrowserWindow({
    width: 760,
    height: 720,
    minWidth: 420,
    minHeight: 360,
    title,
    backgroundColor: '#15110d',
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-journal.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      additionalArguments: [`--journal-context-id=${id}`]
    }
  });

  journalWindows.set(id, { window, context });
  window.loadFile(path.join(__dirname, 'renderer', 'journal-window.html'));
  window.on('closed', () => journalWindows.delete(id));
  return { ok: true, id };
}

/** Закрывает окна журнала: стол погас, подключаться им больше не к чему. */
function closeJournalWindows() {
  for (const { window } of journalWindows.values()) {
    if (!window.isDestroyed()) window.close();
  }
  journalWindows.clear();
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
  if (saving) {
    // Запись уже идёт. Просим повторить её после и отвечаем текущими
    // метаданными: раньше такой вызов молча терял изменения, сделанные
    // во время записи.
    saveRequested = true;
    return campaignMeta(currentCampaign);
  }
  saving = true;
  try {
    let meta = campaignMeta(currentCampaign);
    do {
      saveRequested = false;
      const version = dirtyVersion;
      if (host && host.room) {
        currentCampaign.state = host.room.serialize();
      }
      await store.save(currentCampaign);
      // Подчищаем файлы, на которые уже никто не ссылается: заменённая карта,
      // портрет или картинка фишки иначе остаются на диске навсегда.
      if (host && host.room && currentCampaign.state) {
        store.sweepFiles(currentCampaign.id, currentCampaign.state)
          .catch(() => { /* свалка не должна мешать сохранению */ });
      }
      // За время записи ничего не изменилось — стол чист. Иначе флаг остаётся,
      // и следующий автосейв допишет то, что успело появиться.
      if (dirtyVersion === version) dirty = false;
      meta = campaignMeta(currentCampaign);
    } while (saveRequested);
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
  }, autosaveIntervalMs);
}

function stopAutosave() {
  if (autosaveTimer) clearInterval(autosaveTimer);
  autosaveTimer = null;
}

function markDirty() {
  dirty = true;
  dirtyVersion += 1;
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
  closeJournalWindows();
  await server.close();
  host = null;
  stopAutosave();
  return true;
}

/**
 * Автокопия кампании при старте стола.
 *
 * Копия всей папки это страховка от испорченного JSON и потерянных картинок.
 * Раз в сутки достаточно: делать её на каждый запуск значит гонять десятки
 * мегабайт и вытеснять вчерашнюю копию сегодняшней. Если копия свежая,
 * ничего не делаем.
 * @returns {Promise<string|null>} путь к новой копии
 */
async function backupIfStale() {
  if (!currentCampaign) return null;
  try {
    const last = await store.lastBackupTime(currentCampaign.id, currentCampaign.name);
    if (last && Date.now() - last < BACKUP_MAX_AGE_MS) return null;
    // Сначала дописываем состояние на диск: копировать полупустую папку
    // кампании, которую ещё ни разу не сохраняли, незачем.
    const meta = await persistCampaign();
    if (!meta) return null;
    return await store.backup(currentCampaign.id, currentCampaign.name);
  } catch (error) {
    // Копия не должна мешать открыть стол: игра важнее страховки.
    console.warn('[backup] автокопия не удалась:', error.message);
    return null;
  }
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
  closeJournalWindows();
  const autoBackup = await backupIfStale();

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
    localUrl: server.localUrl
  };
  dirty = false;
  startAutosave();

  // Запускаем P2P-эндпоинт iroh для прямого подключения игроков друг к другу.
  startIrohForTable();

  return {
    port: server.port,
    localUrl: server.localUrl,
    hostKey,
    autoBackup,
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

  // Время автосохранения выбирается в настройках и живёт в renderer
  // (localStorage): main только принимает секунды на запуске.
  ipcMain.handle('app:autosaveInterval', (event, seconds) => {
    const ms = Math.round(Number(seconds) * 1000);
    if (!Number.isFinite(ms) || ms < AUTOSAVE_MIN_MS || ms > AUTOSAVE_MAX_MS) {
      return { ok: false, error: 'Недопустимый интервал автосохранения' };
    }
    autosaveIntervalMs = ms;
    // Стол уже работает — новые секунды должны действовать сразу, а не со
    // следующего запуска. Без стола таймера нет, и значение подхватит startHost.
    if (autosaveTimer) startAutosave();
    return { ok: true, intervalMs: ms };
  });

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

  ipcMain.handle('campaign:backup', async () => {
    if (!currentCampaign) return { ok: false, error: 'Сначала откройте кампанию' };
    try {
      // Сначала дописываем текущее состояние, иначе копия отстанет на минуту.
      await persistCampaign();
      const dir = await store.backup(currentCampaign.id, currentCampaign.name);
      return { ok: true, dir };
    } catch (error) {
      return { ok: false, error: `Не удалось сделать копию: ${error.message}` };
    }
  });

  /** Сколько копий уже лежит и когда сделана последняя: строка в настройках. */
  ipcMain.handle('campaign:backupInfo', async () => {
    if (!currentCampaign) return { ok: false, error: 'Сначала откройте кампанию' };
    try {
      const copies = await store.listBackups(currentCampaign.id, currentCampaign.name);
      return {
        ok: true,
        count: copies.length,
        lastAt: copies.length ? new Date(copies[0].mtimeMs).toISOString() : null,
        // Список для восстановления: интерфейсу нужны имена папок и даты.
        items: copies.map((copy) => ({
          name: copy.name,
          at: new Date(copy.mtimeMs).toISOString()
        }))
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  /**
   * Возврат кампании из копии.
   *
   * Стол останавливаем до подмены папки: сервер держит состояние в памяти и
   * после восстановления писал бы поверх него старые данные. После успеха
   * окно перезагружается и открывает кампанию заново.
   */
  ipcMain.handle('campaign:restoreBackup', async (event, id, backupName) => {
    try {
      if (!currentCampaign || currentCampaign.id !== id) {
        return { ok: false, error: 'Сначала откройте кампанию' };
      }
      const wasHosting = Boolean(host);
      if (wasHosting) await stopHost();
      await store.restoreBackup(id, backupName);
      currentCampaign = await store.load(id);
      return { ok: true, wasHosting };
    } catch (error) {
      return { ok: false, error: `Не удалось восстановить копию: ${error.message}` };
    }
  });

  ipcMain.handle('shell:openBackups', async () => {    const dir = store.backupsDir();
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await shell.openPath(dir);
      return { ok: true, dir };
    } catch (error) {
      return { ok: false, error: error.message };
    }
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

  // QR-код для мастера: билет длинный, и на телефон его проще навести
  // камерой, чем пересылать текстом. Картинку рисует main-процесс.
  ipcMain.handle('iroh:ticket-qr', async (event, ticketStr) => {
    const ticket = typeof ticketStr === 'string' ? ticketStr.trim() : '';
    if (!ticket) return { ok: false, error: 'Нет билета' };
    if (ticket.length > 2000) return { ok: false, error: 'Билет слишком длинный для QR-кода' };
    try {
      const dataUrl = await require('qrcode').toDataURL(ticket, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 240,
        color: { dark: '#101418', light: '#ffffff' }
      });
      return { ok: true, dataUrl };
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

  // Журнал кампании в отдельном окне.
  ipcMain.handle('journal:openWindow', async (event, request) => openJournalWindow(request || {}));

  ipcMain.handle('journal:context', async (event, id) => {
    const entry = journalWindows.get(String(id || ''));
    return entry ? entry.context : null;
  });

  // --------------------------------------------------------------------------
  // Импорт внешнего приключения
  // --------------------------------------------------------------------------

  /** Разрешённые расширения файлов импорта. */
  const ADVENTURE_EXTENSIONS = ['.json', '.zip'];

  /** Максимальный размер файла импорта. */
  const ADVENTURE_MAX_BYTES = 400 * 1024 * 1024;

  /** Файлы, выбранные пользователем в диалоге. Импорт берёт только их. */
  const adventurePicked = [];

  /**
   * Готовые карточки Open5e ждут подтверждения. В renderer уходит только
   * идентификатор черновика: иначе окно могло бы подсунуть в кампанию любую
   * картинку и статблок в обход проверок.
   */
  const bestiaryDrafts = new Map();
  const BESTIARY_DRAFT_TTL = 10 * 60_000;
  const BESTIARY_DRAFT_LIMIT = 12;

  function pruneBestiaryDrafts() {
    const now = Date.now();
    for (const [id, draft] of bestiaryDrafts) {
      if (now - draft.at > BESTIARY_DRAFT_TTL) bestiaryDrafts.delete(id);
    }
    while (bestiaryDrafts.size >= BESTIARY_DRAFT_LIMIT) {
      bestiaryDrafts.delete(bestiaryDrafts.keys().next().value);
    }
  }

  function bestiaryError(error) {
    if (error && error.code === 'BAD_KEY') return 'Некорректная карточка монстра';
    if (error && error.status === 404) return 'В Open5e нет такой карточки';
    if (error && error.status === 429) return 'Open5e просит подождать: слишком много запросов.';
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return 'Open5e не ответил вовремя. Попробуйте ещё раз.';
    }
    return 'Не удалось связаться с Open5e. Проверьте интернет и повторите.';
  }

  /**
   * Приводит путь к сравнимому виду: и диалог, и renderer должны дать одно и
   * то же. Симлинки раскрываем, если файл ещё на месте.
   * @param {unknown} filePath
   * @returns {string}
   */
  function adventurePathKey(filePath) {
    const value = String(filePath || '');
    if (!value) return '';
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  }

  /** Запоминает путь, выбранный в диалоге: без него импорт не примет файл. */
  function rememberAdventurePath(filePath) {
    const key = adventurePathKey(filePath);
    if (!key) return '';
    const index = adventurePicked.indexOf(key);
    if (index !== -1) adventurePicked.splice(index, 1);
    adventurePicked.push(key);
    if (adventurePicked.length > 8) adventurePicked.shift();
    return key;
  }

  /** @param {unknown} filePath @returns {boolean} */
  function isPickedAdventurePath(filePath) {
    const key = adventurePathKey(filePath);
    return Boolean(key) && adventurePicked.includes(key);
  }

  /**
   * Проверяет путь, присланный renderer'ом.
   *
   * Renderer — наш собственный код, но проверять всё равно нужно: иначе
   * расширение файла и его размер остаются на слове.
   * @param {unknown} filePath
   * @returns {{ok: true, data: Buffer}|{ok: false, error: string}}
   */
  function readAdventureFile(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return { ok: false, error: 'Файл не выбран.' };
    }
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return { ok: false, error: 'Файл не найден или недоступен.' };
    }
    if (!stat.isFile()) return { ok: false, error: 'Это не файл.' };
    const extension = path.extname(filePath).toLowerCase();
    if (!ADVENTURE_EXTENSIONS.includes(extension)) {
      return { ok: false, error: `Поддерживаются только файлы ${ADVENTURE_EXTENSIONS.join(' и ')}.` };
    }
    if (stat.size > ADVENTURE_MAX_BYTES) {
      return { ok: false, error: 'Файл слишком большой: больше 400 МБ.' };
    }
    return { ok: true, data: fs.readFileSync(filePath) };
  }

  /**
 * Меняет data-URL картинок на ссылки на файлы кампании.
 *
 * Ядро импорта ничего не знает про файловую систему и отдаёт картинки как
 * data URL. Если сохранить их как есть, в campaign.json попадёт base64 —
 * файл станет нечитаемым и раздуется. Поэтому файловые операции делает
 * main-процесс, как и при обычной загрузке карты.
 *
 * @param {object} patch
 * @param {string} campaignId
 * @returns {Promise<object>} Тот же patch, но с путими вида /files/<имя>.
 */
  async function materializeImages(patch, campaignId) {
    /** @type {Map<string, string>} */
    const cache = new Map();
    const convert = async (dataUrl) => {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return dataUrl;
      if (cache.has(dataUrl)) return cache.get(dataUrl);
      const decoded = decodeImage(dataUrl);
      // decodeImage возвращает { error }, а не null: раньше битая картинка
      // проходила проверку и падала уже на записи файла.
      if (!decoded || decoded.error) return null;
      const fileName = await store.saveImage(campaignId, decoded.buffer, decoded.ext);
      const url = `/files/${fileName}`;
      cache.set(dataUrl, url);
      return url;
    };

    for (const slot of Object.values(patch.maps || {})) {
      for (const item of slot.items || []) {
        item.url = await convert(item.url);
      }
    }
    for (const token of patch.tokens || []) {
      token.imageUrl = await convert(token.imageUrl);
    }
    for (const actor of (patch.adventure && patch.adventure.actors) || []) {
      actor.image = await convert(actor.image);
    }
    for (const item of (patch.adventure && patch.adventure.items) || []) {
      item.image = await convert(item.image);
    }
    return patch;
  }

  /**
   * Диалог выбора файла. Отдельным шагом, чтобы чтение и импорт можно было
   * проверять тестами, не открывая системное окно.
   */
  ipcMain.handle('adventure:pickFile', async () => {
    if (!host || !host.room) return { ok: false, error: 'Сначала запустите стол.' };
    const picked = await dialog.showOpenDialog({
      title: 'Выберите файл приключения',
      properties: ['openFile'],
      filters: [{ name: 'Приключения Foundry', extensions: ['json', 'zip'] }]
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    rememberAdventurePath(picked.filePaths[0]);
    return { ok: true, filePath: picked.filePaths[0] };
  });

  ipcMain.handle('adventure:inspect', async (event, filePath) => {
    if (!host || !host.room) return { ok: false, error: 'Сначала запустите стол.' };
    if (!isPickedAdventurePath(filePath)) {
      return { ok: false, error: 'Файл нужно выбрать в окне выбора приключения.' };
    }
    const read = readAdventureFile(filePath);
    if (!read.ok) return read;
    try {
      const preview = await importer.inspect({ data: read.data, path: filePath }, { campaignMaps: host.room.maps });
      return { ok: true, preview };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  /**
   * Применяет импорт к текущему столу.
   *
   * Частичного импорта быть не может: сначала строится патч целиком, и только
   * потом разом раскладывается по столу. Если что-то пошло не так, стол остаётся
   * как был.
   * @param {string[]} include
   */
  ipcMain.handle('adventure:import', async (event, filePath, include) => {
    if (!host || !host.room) return { ok: false, error: 'Сначала запустите стол.' };
    const selected = Array.isArray(include) ? include.map(String) : [];
    if (!selected.length) return { ok: false, error: 'Не выбрано ни одной сущности.' };
    if (!isPickedAdventurePath(filePath)) {
      return { ok: false, error: 'Файл нужно выбрать в окне выбора приключения.' };
    }
    const read = readAdventureFile(filePath);
    if (!read.ok) return read;

    try {
      const { patch, report } = await importer.runImport(
        { data: read.data, path: filePath },
        { include: selected },
        { campaignMaps: host.room.maps }
      );
      await materializeImages(patch, host.room.campaign.id);

      // Импорт собирает карты вручную, без стен, света, тумана и поверхности.
      // normalizeMapSlot дописывает их и заодно режет вкладку по пределу: без
      // этого первый же нарисованный на импортированной карте отрезок стены
      // падал бы на item.walls.length.
      for (const type of Object.keys(patch.maps)) {
        patch.maps[type] = host.room.normalizeMapSlot(patch.maps[type]);
      }
      // Фишки — тем же путём через normalizeToken и с тем же пределом, что у
      // стола: импорт не должен переполнять стол или приносить кривые поля.
      const freeTokenSlots = Math.max(0, LIMITS.maxTokens - host.room.tokens.length);
      const addedTokens = [];
      for (const token of patch.tokens) {
        if (addedTokens.length >= freeTokenSlots) break;
        addedTokens.push(host.room.normalizeToken(token));
      }

      // Приключение — часть кампании, поэтому её формат тоже меняется.
      host.room.campaign.version = 2;
      // Единственное место, где патч трогает стол. До этого момента ничего
      // измениться не могло.
      host.room.maps = patch.maps;
      // Тот же предел строк и полей, что и при загрузке кампании: импорт не
      // должен быть вторым, более слабым путём внутрь приложения.
      host.room.adventure = normalizeAdventure(patch.adventure);
      for (const token of addedTokens) host.room.tokens.push(token);
      markDirty();

      // Рассылаем ровно то же событие, что и сервер при загрузке карты вручную,
      // иначе клиенты продолжат видеть старые вкладки.
      for (const type of Object.keys(patch.maps)) {
        const slot = patch.maps[type];
        host.server.io.emit('mapUpdated', {
          type,
          items: slot.items,
          activeId: slot.activeId,
          activeMap: host.room.activeMap
        });
      }
      // Новые фишки рассылаем по одному событию на каждую — так же, как при
      // создании фишки руками, поэтому клиенту не нужен отдельный обработчик
      // массового обновления.
      for (const token of addedTokens) host.server.io.emit('tokenCreated', token);
      await persistCampaign({ notify: true });
      // Приключение отдаём сразу: отдельного события со снимком стола нет,
      // а мастеру нужно увидеть, что именно перенеслось.
      return { ok: true, report, adventure: host.room.adventure };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('shell:openDataDir', async () => {
    const { dir } = resolveDataDir();
    await shell.openPath(dir);
    return { ok: true };
  });

  /* --------------------------------------------------------------- Open5e */

  ipcMain.handle('bestiary:search', async (event, query) => {
    if (!host || !host.room) return { ok: false, error: 'Сначала запустите стол.' };
    const text = String(query || '').trim().slice(0, 120);
    if (!text) return { ok: false, error: 'Введите название монстра.' };
    try {
      const result = await open5e.searchCreatures(text);
      return { ok: true, ...result };
    } catch (error) {
      console.warn('[open5e] поиск:', error.message);
      return { ok: false, error: bestiaryError(error) };
    }
  });

  ipcMain.handle('bestiary:preview', async (event, key) => {
    if (!host || !host.room) return { ok: false, error: 'Сначала запустите стол.' };
    try {
      const result = await open5e.previewCreature(key);
      pruneBestiaryDrafts();
      const id = crypto.randomUUID();
      bestiaryDrafts.set(id, { at: Date.now(), ...result });
      return { ok: true, id, ...result };
    } catch (error) {
      console.warn('[open5e] карточка:', error.message);
      return { ok: false, error: bestiaryError(error) };
    }
  });

  /**
   * Скачивает картинку в черновик по явной просьбе. Обычный импорт хранит
   * только URL: диск пользователя не должен заполняться чужими портретами
   * без его согласия.
   */
  ipcMain.handle('bestiary:cacheImage', async (event, draftId) => {
    if (!host || !host.room) return { ok: false, error: 'Сначала запустите стол.' };
    pruneBestiaryDrafts();
    const draft = bestiaryDrafts.get(String(draftId || ''));
    if (!draft) return { ok: false, error: 'Карточка устарела. Найдите монстра заново.' };
    if (typeof draft.actor.image !== 'string' || !draft.actor.image) {
      return { ok: false, error: 'У этой карточки нет картинки.' };
    }
    if (draft.actor.image.startsWith('data:image/')) {
      return { ok: true, image: draft.actor.image };
    }
    const image = await open5e.downloadImage(draft.actor.image);
    if (!image) return { ok: false, error: 'Не удалось скачать картинку: источник не отдал файл.' };
    draft.actor.image = image;
    draft.images = [
      { url: image, thumb: image, source: 'Локальный файл', credit: '' },
      ...(draft.images || [])
    ];
    draft.meta = { ...(draft.meta || {}), hasImage: true, imageSource: 'Локальный файл', imageCredit: '' };
    return { ok: true, image, images: draft.images };
  });

  /** Другой поиск картинки для уже открытой карточки. */
  ipcMain.handle('bestiary:image', async (event, draftId, query) => {
    if (!host || !host.room) return { ok: false, error: 'Сначала запустите стол.' };
    pruneBestiaryDrafts();
    const draft = bestiaryDrafts.get(String(draftId || ''));
    if (!draft) return { ok: false, error: 'Карточка устарела. Найдите монстра заново.' };
    const text = String(query || '').trim().slice(0, 120);
    if (!text) return { ok: false, error: 'Введите запрос для поиска картинки.' };
    try {
      const images = await open5e.findArtworkCandidatesByQuery(text);
      if (!images.length) return { ok: false, error: 'По этому запросу картинка не нашлась.' };
      const found = images[0];
      draft.images = images;
      draft.actor.image = found.url;
      draft.meta = {
        ...(draft.meta || {}),
        hasImage: true,
        imageSource: found.source,
        imageCredit: found.credit
      };
      return { ok: true, images, image: found.url, source: found.source, credit: found.credit };
    } catch (error) {
      console.warn('[open5e] картинка:', error.message);
      return { ok: false, error: 'Поиск картинки не удался. Проверьте интернет.' };
    }
  });

  /** Выбор одного из найденных вариантов: в карточку идёт только он. */
  ipcMain.handle('bestiary:pickImage', async (event, draftId, url) => {
    if (!host || !host.room) return { ok: false, error: 'Сначала запустите стол.' };
    pruneBestiaryDrafts();
    const draft = bestiaryDrafts.get(String(draftId || ''));
    if (!draft) return { ok: false, error: 'Карточка устарела. Найдите монстра заново.' };
    const wanted = String(url || '');
    const candidate = (draft.images || []).find((item) => item.url === wanted);
    if (!candidate) return { ok: false, error: 'Этого варианта больше нет.' };
    draft.actor.image = candidate.url;
    draft.meta = {
      ...(draft.meta || {}),
      hasImage: true,
      imageSource: candidate.source,
      imageCredit: candidate.credit
    };
    return { ok: true, image: candidate.url, source: candidate.source, credit: candidate.credit };
  });

  /** Своя картинка из файла: в кампанию попадёт только при сохранении карточки. */
  ipcMain.handle('bestiary:uploadImage', async (event, draftId, dataUrl) => {
    if (!host || !host.room) return { ok: false, error: 'Сначала запустите стол.' };
    pruneBestiaryDrafts();
    const draft = bestiaryDrafts.get(String(draftId || ''));
    if (!draft) return { ok: false, error: 'Карточка устарела. Найдите монстра заново.' };
    const decoded = decodeImage(dataUrl);
    if (!decoded || decoded.error) return { ok: false, error: decoded ? decoded.error : 'Картинка не прочиталась.' };
    draft.actor.image = dataUrl;
    draft.images = [
      { url: dataUrl, thumb: dataUrl, source: 'Своя картинка', credit: '' },
      ...(draft.images || [])
    ];
    draft.meta = { ...(draft.meta || {}), hasImage: true, imageSource: 'Своя картинка', imageCredit: '' };
    return { ok: true, image: dataUrl, images: draft.images };
  });

  ipcMain.handle('bestiary:import', async (event, draftId, crop) => {
    if (!host || !host.room) return { ok: false, error: 'Сначала запустите стол.' };
    pruneBestiaryDrafts();
    const draft = bestiaryDrafts.get(String(draftId || ''));
    if (!draft) return { ok: false, error: 'Карточка устарела. Найдите монстра заново.' };

    try {
      const actor = {
        ...draft.actor,
        id: `actor-${crypto.randomBytes(4).toString('hex')}`,
        image: /^https?:\/\//i.test(draft.actor.image || '') ? open5e.normalizeImageUrl(draft.actor.image) : ''
      };
      // Кадр из предпросмотра: зум и сдвиг в процентах. Проверяем ещё раз,
      // потому что renderer присылает обычные числа и мог прислать что угодно.
      const zoom = Math.min(4, Math.max(1, Number(crop && crop.zoom) || 1));
      const limit = (zoom - 1) * 50;
      const shift = (value) => Math.min(limit, Math.max(-limit, Number(value) || 0));
      actor.imageZoom = zoom;
      actor.imageX = shift(crop && crop.x);
      actor.imageY = shift(crop && crop.y);
      if (typeof draft.actor.image === 'string' && draft.actor.image.startsWith('data:image/')) {
        const decoded = decodeImage(draft.actor.image);
        if (decoded && !decoded.error) {
          const fileName = await store.saveImage(host.room.campaign.id, decoded.buffer, decoded.ext);
          actor.image = `/files/${fileName}`;
        }
      }

      if (!host.room.adventure) {
        host.room.adventure = normalizeAdventure({ name: 'Бестиарий', source: 'Open5e', actors: [] });
      }
      if (host.room.adventure.actors.length >= LIMITS.maxAdventureActors) {
        return { ok: false, error: 'В справочнике уже слишком много персонажей.' };
      }
      const clean = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (host.room.adventure.actors.some((entry) => clean(entry.name) === clean(actor.name))) {
        return { ok: false, error: `«${actor.name}» уже есть в справочнике.` };
      }

      host.room.adventure.actors.push(actor);
      host.room.adventure = normalizeAdventure(host.room.adventure);
      markDirty();
      host.server.io.to('dm-sockets').emit('adventureUpdated', host.room.adventure);
      await persistCampaign({ notify: true });
      bestiaryDrafts.delete(String(draftId));
      return { ok: true, adventure: host.room.adventure };
    } catch (error) {
      console.warn('[open5e] сохранение:', error.message);
      return { ok: false, error: 'Не удалось сохранить карточку в кампанию.' };
    }
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
});app.on('before-quit', (event) => {
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
