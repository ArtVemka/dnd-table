'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');

const { CampaignStore } = require('./server/campaign');
const { createTableServer } = require('./server/socket');
const { RoomState, LIMITS, normalizeAdventure } = require('./server/state');
const { decodeImage } = require('./server/image');
const irohManager = require('./server/iroh-manager');
const importer = require('./server/importer');
const { copyVendor } = require('./scripts/copy-vendor');
const { versionLabel } = require('./scripts/version-label');
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
/** @type {CampaignStore|null} */
let store = null;
/** Текущая кампания (созданная или загруженная, ещё не обязательно запущенная). */
let currentCampaign = null;
/** Запущенный стол: { server, room, hostKey, port, localUrl }. */
let host = null;
let autosaveTimer = null;
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
  }, AUTOSAVE_INTERVAL_MS);
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
      host.room.markDirty();

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
