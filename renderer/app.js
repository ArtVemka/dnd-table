'use strict';

/**
 * Контроллер интерфейса.
 *
 * Здесь нет правил D&D — только экраны, связь с main-процессом (кампании и
 * запуск стола) и обмен событиями Socket.IO с сервером стола.
 *
 * Роли:
 *   ДМ     — запускает сервер в main-процессе и подключается к нему же
 *            по 127.0.0.1, предъявляя hostKey (его знает только своё окно);
 *   игрок  — подключается по адресу, который дал ДМ.
 */

(function () {
  const DnD = window.DnD5e;
  const { MapView, PlayersList, ChatPanel, DicePanel, TokenPanel } = window.TableUI;
  const LocalTable = window.LocalTable;

  const PLAYER_ID_KEY = 'dnd-table.playerId';
  const PLAYER_NAME_KEY = 'dnd-table.playerName';
  const LAST_ADDRESS_KEY = 'dnd-table.lastAddress';
  const ADDRESSES_COLLAPSED_KEY = 'dnd-table.addressesCollapsed';
  const LEFT_COLLAPSED_KEY = 'dnd-table.leftPanelCollapsed';
  const RIGHT_COLLAPSED_KEY = 'dnd-table.rightPanelCollapsed';
  const PORTHOLE_URL = 'https://store.steampowered.com/app/4963920/Porthole__Local_Port_Sharing/';
  /** Размеры клетки сетки, которые предлагаются в настройках (в пикселях). */
  const CELL_CHOICES = [32, 46, 56, 72, 96];

  const desktop = window.desktop;

  const app = {
    config: null,
    campaign: null,
    host: null,
    socket: null,
    role: null,
    playerId: null,
    /** Справочник импортированного приключения; приходит только мастеру. */
    adventure: null,
    room: {
      players: [],
      sheets: {},
      maps: normalizeMapSlots(null),
      activeMap: null,
      grid: { enabled: false, cell: 46 },
      tokens: [],
      diceHistory: [],
      chatHistory: []
    },
    viewedSheetPlayerId: null,
    sheetShownFor: null,
    sheetSaveTimer: null,
    sheetStatusTimer: null,
    connected: false,
    /** Тренировочный стол: он же игра, но без сети и без сервера. */
    training: false,
    /** Адрес стола, к которому подключено окно: нужен для картинок с сервера. */
    serverUrl: '',
    pendingLoadId: null,
    /** Состояние P2P-соединения (iroh). */
    p2p: {
      running: false,
      peerConnected: false,
      peerAddr: null,
      ticket: null
    }
  };

  const $ = (selector) => document.querySelector(selector);
  /** Игроки, чьи листы ДМ уже запросил (чтобы не спамить сервер). */
  const requestedSheets = new Set();
  let sheetView = null;
  let mapView = null;
  let playersList = null;
  let chatPanel = null;
  let dicePanel = null;
  let tokenPanel = null;

  /* ------------------------------------------------------------------ *
   * Утилиты
   * ------------------------------------------------------------------ */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function toast(message, kind = 'info', timeout = 4200) {
    const root = $('#toasts');
    if (!root) return;
    const node = el('div', `toast toast--${kind}`, message);
    root.appendChild(node);
    setTimeout(() => {
      node.classList.add('is-out');
      setTimeout(() => node.remove(), 300);
    }, timeout);
  }

  /**
   * Немодальный (но блокирующий ввод) диалог вместо window.confirm/prompt:
   * нативные модалки Electron замораживают окно и мешают автотестам.
   * @returns {Promise<true|string|null>} null — отмена
   */
  function modal(options = {}) {
    return new Promise((resolve) => {
      const overlay = el('div', 'modal-overlay');
      const box = el('div', 'modal');
      box.appendChild(el('div', 'modal__title', options.title || 'Подтвердите действие'));
      if (options.message) box.appendChild(el('div', 'modal__text', options.message));

      let field = null;
      if (options.input) {
        field = el('input', 'input');
        field.type = 'text';
        field.value = options.input.value || '';
        field.maxLength = options.input.maxLength || 60;
        field.placeholder = options.input.placeholder || '';
        box.appendChild(field);
      }

      const actions = el('div', 'modal__actions');
      const cancel = el('button', 'btn btn--ghost', options.cancelLabel || 'Отмена');
      cancel.type = 'button';
      const confirm = el('button', `btn ${options.danger ? 'btn--danger' : 'btn--accent'}`, options.confirmLabel || 'ОК');
      confirm.type = 'button';

      const close = (value) => {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(value);
      };
      const onKey = (event) => {
        if (event.key === 'Escape') close(null);
      };
      cancel.addEventListener('click', () => close(null));
      confirm.addEventListener('click', () => close(field ? (field.value.trim() || null) : true));
      if (field) {
        field.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') confirm.click();
        });
      }
      overlay.addEventListener('pointerdown', (event) => {
        if (event.target === overlay) close(null);
      });
      document.addEventListener('keydown', onKey);

      actions.appendChild(cancel);
      actions.appendChild(confirm);
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      if (field) field.focus();
    });
  }

  function setStatus(selector, text, kind) {
    const node = $(selector);
    if (!node) return;
    node.textContent = text || '';
    node.className = `status${kind ? ` status--${kind}` : ''}`;
  }

  function showScreen(id) {
    for (const screen of document.querySelectorAll('.screen')) {
      screen.classList.toggle('is-active', screen.id === id);
    }
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  /** Локальный идентификатор игрока: нужен, чтобы после переподключения вернуть лист персонажа. */
  function localPlayerId() {
    let id = localStorage.getItem(PLAYER_ID_KEY);
    if (!id || !/^[A-Za-z0-9_-]{4,64}$/.test(id)) {
      id = `p-${(crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`)}`;
      localStorage.setItem(PLAYER_ID_KEY, id);
    }
    return id;
  }

  function storedName() {
    return (localStorage.getItem(PLAYER_NAME_KEY) || '').trim();
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* ниже запасной вариант */ }
    try {
      const area = el('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }

  /**
   * Читает выбранный файл изображения в base64 data URL.
   * Именно этот способ используется для загрузки карт и изображений фишек:
   * renderer -> base64 -> Socket.IO -> main-процесс сохраняет файл в папку кампании.
   * Все проверки дублируются на сервере, здесь — быстрый отказ с понятным текстом.
   * @param {File} file
   */
  function readImageFile(file) {
    return new Promise((resolve) => {
      if (!file) return resolve({ canceled: true });

      const megabytes = (file.size / 1024 / 1024).toFixed(1);
      if (!file.size) {
        return resolve({ error: `Файл «${file.name}» пустой.` });
      }
      if (file.size > DnD.LIMITS.maxImageBytes) {
        return resolve({
          error: `Файл «${file.name}» весит ${megabytes} МБ, а можно не больше `
            + `${Math.round(DnD.LIMITS.maxImageBytes / 1024 / 1024)} МБ. Уменьшите изображение.`
        });
      }
      const allowedType = /^image\/(png|jpeg|jpg|webp)$/i.test(file.type);
      const allowedExt = /\.(png|jpe?g|webp)$/i.test(file.name);
      if (!allowedType && !allowedExt) {
        const kind = file.type ? `тип ${file.type}` : (/\.[a-z0-9]+$/i.exec(file.name) || ['без расширения'])[0];
        return resolve({
          error: `Файл «${file.name}» (${kind}) не поддерживается. Нужны PNG, JPG или WEBP.`
        });
      }

      const reader = new FileReader();
      reader.onload = () => resolve({ dataUrl: String(reader.result), name: file.name });
      reader.onerror = () => resolve({ error: `Не удалось прочитать файл «${file.name}».` });
      reader.readAsDataURL(file);
    });
  }

  function emit(event, payload) {
    if (!app.socket || !app.connected) {
      toast('Нет соединения со столом', 'error');
      return false;
    }
    app.socket.emit(event, payload);
    return true;
  }

  /** Каждая вкладка карт хранит свой список картинок: {items, activeId}. */
  function normalizeMapSlots(source) {
    const slots = {};
    for (const type of DnD.MAP_TYPES) {
      const slot = source ? source[type] : null;
      slots[type] = slot && typeof slot === 'object' && Array.isArray(slot.items)
        ? { items: slot.items, activeId: slot.activeId || null }
        : { items: [], activeId: null };
    }
    return slots;
  }

  /**
   * Сервер отдаёт картинки относительным путём (/files/<имя>) — так он хранится
   * и в кампании. Окно открыто по file://, поэтому для показа путь нужно
   * дополнить адресом стола, иначе браузер станет искать /files в корне диска.
   * @param {string} path
   */
  function assetUrl(path) {
    if (!path) return '';
    if (/^(https?:|data:|blob:)/i.test(path)) return path;
    return `${app.serverUrl}${path}`;
  }

  /* ------------------------------------------------------------------ *
   * Экраны: главная, создание, загрузка, подключение
   * ------------------------------------------------------------------ */

  async function initHome() {
    app.config = await desktop.getConfig();
    const dirNode = $('#home-datadir');
    dirNode.textContent = `Данные: ${app.config.dataDir}${app.config.portable ? ' (портативный режим)' : ''}`;
    dirNode.title = app.config.campaignsDir;

    const status = await desktop.hostStatus();
    if (status && status.running) {
      // Приложение перезапускалось с работающим столом — вернуть ДМ за стол.
      app.host = status;
      app.campaign = status.campaign;
      await enterTableAsDm();
    }
  }

  async function createAndStart() {
    const name = $('#create-name').value.trim();
    if (!name) {
      setStatus('#create-status', 'Введите название кампании', 'error');
      return;
    }
    setStatus('#create-status', 'Создаём кампанию…');
    const created = await desktop.createCampaign(name);
    if (!created.ok) {
      setStatus('#create-status', created.error, 'error');
      return;
    }
    app.campaign = created.campaign;
    await startTable();
  }

  async function openLoadScreen() {
    showScreen('screen-load');
    app.pendingLoadId = null;
    $('#load-selected').hidden = true;
    setStatus('#load-status', '');
    await refreshCampaignList();
  }

  async function refreshCampaignList() {
    const root = $('#campaign-list');
    root.innerHTML = '';
    const { campaigns } = await desktop.listCampaigns();
    if (!campaigns.length) {
      root.appendChild(el('div', 'muted', 'Сохранённых кампаний пока нет.'));
      return;
    }
    for (const campaign of campaigns) {
      const row = el('div', 'campaign');
      row.classList.toggle('is-selected', campaign.id === app.pendingLoadId);

      const main = el('div', 'campaign__main');
      main.appendChild(el('div', 'campaign__name', campaign.name));
      const meta = el('div', 'campaign__meta muted');
      meta.appendChild(el('span', null, `Последнее сохранение: ${formatDateTime(campaign.updatedAt)}`));
      meta.appendChild(el('span', null, `Создана: ${formatDateTime(campaign.createdAt)}`));
      meta.appendChild(el('span', null, `Игроков: ${campaign.players} · фишек: ${campaign.tokens}`));
      const maps = el('div', 'campaign__maps');
      maps.appendChild(el('span', `badge${campaign.maps.world ? ' badge--on' : ''}`, 'Общая карта'));
      maps.appendChild(el('span', `badge${campaign.maps.battle ? ' badge--on' : ''}`, 'Карта битвы'));
      meta.appendChild(maps);
      main.appendChild(meta);
      row.appendChild(main);

      const actions = el('div', 'campaign__actions');
      const load = el('button', 'btn btn--accent', 'Загрузить');
      load.type = 'button';
      load.addEventListener('click', () => selectCampaign(campaign));
      actions.appendChild(load);

      const remove = el('button', 'btn btn--ghost btn--danger', 'Удалить');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        const answer = await modal({
          title: 'Удалить кампанию?',
          message: `Кампания «${campaign.name}» и все её изображения будут удалены с диска безвозвратно.`,
          confirmLabel: 'Удалить',
          danger: true
        });
        if (!answer) return;
        await desktop.deleteCampaign(campaign.id);
        if (app.pendingLoadId === campaign.id) {
          app.pendingLoadId = null;
          $('#load-selected').hidden = true;
        }
        toast(`Кампания «${campaign.name}» удалена`, 'ok');
        await refreshCampaignList();
      });
      actions.appendChild(remove);
      row.appendChild(actions);
      root.appendChild(row);
    }
  }

  async function selectCampaign(campaign) {
    setStatus('#load-status', 'Загружаем кампанию…');
    const result = await desktop.loadCampaign(campaign.id);
    if (!result.ok) {
      setStatus('#load-status', result.error, 'error');
      return;
    }
    app.campaign = result.campaign;
    app.pendingLoadId = campaign.id;
    $('#load-selected').hidden = false;
    $('#load-selected-name').textContent = campaign.name;
    $('#load-selected-meta').textContent =
      `Последнее сохранение: ${formatDateTime(campaign.updatedAt)} · игроков: ${campaign.players} · фишек: ${campaign.tokens}`;
    setStatus('#load-status', 'Кампания загружена. Нажмите «Запустить стол».', 'ok');
    await refreshCampaignList();
  }

  async function startTable() {
    setStatus('#load-status', 'Поднимаем сервер стола…');
    setStatus('#create-status', 'Поднимаем сервер стола…');
    const started = await desktop.startHost();
    if (!started.ok) {
      setStatus('#load-status', started.error, 'error');
      setStatus('#create-status', started.error, 'error');
      return;
    }
    app.host = started;
    app.campaign = started.campaign;
    setStatus('#load-status', '');
    setStatus('#create-status', '');
    await enterTableAsDm();
  }

  async function enterTableAsDm() {
    const name = storedName() || 'Мастер';
    showScreen('screen-table');
    prepareTableUi();
    renderAddresses();
    updateTableHeader();
    connect({
      url: app.host.localUrl,
      name,
      playerId: 'dm',
      hostKey: app.host.hostKey,
      expectRole: 'dm',
      // P2P-эндпоинт и туннель ДМ поднял startHost() — не рвём их тут.
      keepP2p: true
    });
  }

  /**
   * Открывает стол без сети: сервера нет, всё состояние живёт в этом окне.
   * Нужен, чтобы заранее заполнить лист персонажа и проверить интерфейс глазами
   * игрока, не собирая ради этого настоящий стол.
   */
  function startTraining() {
    app.training = true;
    app.role = 'player';
    app.playerId = localPlayerId();
    prepareTableUi();
    updateRoleUi();
    showScreen('screen-table');
    connect({
      url: '',
      name: storedName() || 'Игрок',
      playerId: app.playerId,
      expectRole: 'player',
      local: true
    });
  }

  /**
   * Подключает окно к столу. Обычно это сеть (`io`), но в тренировочном столе
   * вместо сервера работает локальная заглушка с теми же событиями — остальной
   * код о подмене не знает.
   * @param {{url: string, name: string, playerId: string, hostKey?: string, expectRole?: string, local?: boolean}} options
   */
  function connect({ url, name, playerId, hostKey, expectRole, local = false, p2p = false, keepP2p = false }) {
    disconnect({ keepP2p });
    app.serverUrl = local ? '' : String(url).replace(/\/+$/, '');
    if (!local) setStatus('#join-status', 'Подключаемся…');

    let socket;
    if (local) {
      socket = LocalTable.createLocalTable({ playerId, name });
    } else {
      try {
        socket = io(url, {
          // По P2P-туннелю надёжнее чистый WebSocket: polling открывает много
          // TCP-соединений, каждое из которых стало бы отдельным QUIC-стримом.
          transports: p2p ? ['websocket'] : ['websocket', 'polling'],
          reconnection: true,
          reconnectionAttempts: 8,
          reconnectionDelay: 800,
          timeout: 8000
        });
      } catch (error) {
        setStatus('#join-status', `Не удалось создать соединение: ${error.message}`, 'error');
        return;
      }
    }

    app.socket = socket;
    app.expectRole = expectRole;

    socket.on('connect', () => {
      app.connected = true;
      socket.emit('joinRoom', { name, playerId, hostKey }, (response) => {
        if (!response || !response.ok) {
          const message = (response && response.error) || 'Сервер отклонил подключение';
          setStatus('#join-status', message, 'error');
          toast(message, 'error');
          socket.disconnect();
        }
      });
    });

    socket.on('connect_error', (error) => {
      app.connected = false;
      const message = `Не удалось подключиться к ${url}: ${error.message}`;
      setStatus('#join-status', message, 'error');
      updateConnBadge(false);
      if (expectRole === 'dm') toast(message, 'error');
    });

    socket.on('disconnect', (reason) => {
      app.connected = false;
      updateConnBadge(false);
      if (reason !== 'io client disconnect') setStatus('#join-status', 'Соединение потеряно, переподключаемся…', 'error');
    });

    socket.on('joined', ({ you, state }) => {
      app.role = you.role;
      app.playerId = you.playerId;
      requestedSheets.clear();
      app.room = {
        players: state.players || [],
        sheets: state.sheets || {},
        maps: normalizeMapSlots(state.maps),
        activeMap: state.activeMap || null,
        grid: state.grid || { enabled: false, cell: 46 },
        tokens: state.tokens || [],
        diceHistory: state.diceHistory || [],
        chatHistory: state.chatHistory || []
      };
      app.campaign = state.campaign || app.campaign;
      // Приключение приходит только мастеру; игроку сервер шлёт null.
      app.adventure = state.adventure || null;
      // Тренировочный стол — не настоящая игра: адрес и имя в нём запоминать
      // нечего, иначе они подменят данные игрока за настоящим столом.
      if (app.role === 'player' && !app.training) {
        localStorage.setItem(PLAYER_ID_KEY, app.playerId);
        localStorage.setItem(PLAYER_NAME_KEY, you.name);
        localStorage.setItem(LAST_ADDRESS_KEY, url);
      }
      setStatus('#join-status', '');
      showScreen('screen-table');
      prepareTableUi();
      renderAll();
      updateConnBadge(true);
      toast(app.training
        ? 'Тренировочный стол: сети нет, всё происходит в этом окне'
        : (app.role === 'dm'
          ? 'Стол поднят — игроки могут подключаться'
          : 'Вы подключились к столу'), 'ok');
      // Пытаемся запустить P2P-подключение через iroh для прямого обмена данными между участниками.
      if (!app.training) {
        startIrohForTable();
        subscribeToIrohEvents();
      }
      // Заготовку листа, заполненную без стола, можно перенести на стол.
      if (app.role === 'player') offerDraftSheet();
    });

    /* --- события стола --- */
    socket.on('playersUpdate', (players) => {
      app.room.players = players || [];
      playersList.render(app.room.players, viewer());
      tokenPanel.render(app.room.tokens, app.room.players, viewer());
      mapView.render(app.room, viewer());
      updateTableHeader();
      // У ДМ список игроков в панели листа тоже должен обновляться.
      refreshSheetView();
    });

    socket.on('characterSheetData', ({ playerId, sheet }) => {
      app.room.sheets[playerId] = sheet;
      requestedSheets.delete(playerId);
      if (app.role === 'player' && playerId === app.playerId) {
        markSheetSaved();
      }
      refreshSheetView(app.role === 'dm' && app.viewedSheetPlayerId === playerId);
    });

    socket.on('characterSheetUpdated', ({ playerId, sheet }) => {
      app.room.sheets[playerId] = sheet;
      // Если ДМ сейчас смотрит этот лист — обновляем его на лету.
      if (app.role === 'dm' && app.viewedSheetPlayerId === playerId) refreshSheetView(true);
    });

    socket.on('mapUpdated', ({ type, items, activeId, activeMap }) => {
      // Карты вкладки приходят списком: ДМ может держать во вкладке несколько
      // локаций и переключаться между ними, ничего не теряя.
      app.room.maps[type] = {
        items: Array.isArray(items) ? items : [],
        activeId: activeId || null
      };
      app.room.activeMap = activeMap;
      mapView.render(app.room, viewer());
    });

    socket.on('gridUpdated', (grid) => {
      app.room.grid = grid;
      mapView.render(app.room, viewer());
      syncSettingsGrid();
    });

    socket.on('tokenCreated', (token) => {
      app.room.tokens.push(token);
      mapView.render(app.room, viewer());
      tokenPanel.render(app.room.tokens, app.room.players, viewer());
    });

    socket.on('tokenUpdated', (token) => {
      const index = app.room.tokens.findIndex((item) => item.id === token.id);
      if (index >= 0) app.room.tokens[index] = token;
      else app.room.tokens.push(token);
      mapView.render(app.room, viewer());
      tokenPanel.render(app.room.tokens, app.room.players, viewer());
    });

    socket.on('tokenMoved', ({ tokenId, x, y }) => {
      mapView.applyTokenMove(tokenId, x, y);
    });

    socket.on('tokenDeleted', ({ tokenId }) => {
      app.room.tokens = app.room.tokens.filter((token) => token.id !== tokenId);
      mapView.render(app.room, viewer());
      tokenPanel.render(app.room.tokens, app.room.players, viewer());
    });

    socket.on('diceRollResult', (roll) => {
      app.room.diceHistory.push(roll);
      dicePanel.append(roll);
      // Строку о броске в чат добавляет сервер (событие chatMessage),
      // поэтому у всех клиентов история чата совпадает.
    });

    socket.on('chatMessage', (message) => {
      app.room.chatHistory.push(message);
      chatPanel.append(message);
    });

    socket.on('errorMessage', ({ message }) => {
      toast(message, 'error');
    });

    socket.on('reconnect_failed', () => {
      toast('Стол недоступен: не удалось восстановить соединение', 'error');
      if (app.role === 'player') {
        disconnect();
        showScreen('screen-home');
      }
    });
  }

  function disconnect(options = {}) {
    if (app.socket) {
      app.socket.removeAllListeners();
      app.socket.disconnect();
    }
    app.socket = null;
    app.connected = false;
    app.role = null;
    app.playerId = null;
    // Останавливаем P2P при отключении — но только если его не нужно дальше.
    // Иначе connect() первым же disconnect() рвёт туннель, который doJoinP2p
    // или startHost только что подняли: локальный порт закрывается раньше,
    // чем socket.io к нему подключится, и игрок получает ERR_CONNECTION_REFUSED.
    if (!options.keepP2p) stopIrohForTable();
    unsubscribeFromIrohEvents();
  }

  /* ------------------------------------------------------------------ *
   * iroh — P2P-подключения между участниками стола
   * ------------------------------------------------------------------ */

  /** Запуск iroh Endpoint и генерация билета для подключения игроков. */
  async function startIrohForTable() {
    const desktop = window.desktop;
    if (!desktop || !desktop.irohStart) return;
    if (app.p2p.running) return;

    try {
      const result = await desktop.irohStart();
      if (result.ok && result.id) {
        app.p2p.running = true;
        toast(`P2P запущен: ${result.id.slice(0, 8)}…`, 'ok');
        updateP2pBadge();
        // Генерируем билет и показываем его (для ДМ) или подсказываем (для игрока).
        generateP2pTicket();
      } else {
        console.warn('[iroh] failed to start:', result.error);
      }
    } catch (error) {
      console.warn('[iroh] start error:', error.message);
    }
  }

  /** Генерация и отображение iroh-билета. */
  async function generateP2pTicket() {
    const desktop = window.desktop;
    if (!desktop || !desktop.irohCreateTicket) return;

    try {
      const result = await desktop.irohCreateTicket();
      if (result.ok && result.ticket) {
        app.p2p.ticket = result.ticket;
        // Показываем кнопку копирования только ДМ — они делятся с игроками.
        showP2pTicketCopy(result.ticket);
      }
    } catch (error) {
      console.warn('[iroh] ticket creation error:', error.message);
    }
  }

  /** Показать кнопку копирования iroh-билета в панели участников. */
  function showP2pTicketCopy(ticket) {
    const container = document.querySelector('#addresses-root');
    if (!container) return;

    // Проверяем, нет ли уже кнопки
    if (document.getElementById('btn-copy-p2p')) return;

    const row = document.createElement('div');
    row.style.marginTop = '8px';
    row.style.paddingTop = '8px';
    row.style.borderTop = '1px solid var(--border)';

    const label = document.createElement('div');
    label.className = 'muted';
    label.style.fontSize = '11px';
    label.textContent = 'P2P-адрес (кроме сети):';
    row.appendChild(label);

    const addr = document.createElement('div');
    addr.style.fontSize = '10px';
    addr.style.wordBreak = 'break-all';
    addr.style.color = 'var(--text-dim)';
    addr.textContent = ticket.slice(0, 60) + '…';
    row.appendChild(addr);

    const copyBtn = document.createElement('button');
    copyBtn.id = 'btn-copy-p2p';
    copyBtn.className = 'btn btn--tiny';
    copyBtn.type = 'button';
    copyBtn.textContent = 'Копировать адрес';
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(ticket);
      toast(ok ? 'P2P-адрес скопирован' : 'Не удалось скопировать', ok ? 'ok' : 'error');
    });
    row.appendChild(copyBtn);

    container.appendChild(row);
  }

  /** Подключение к DM по iroh-билету. */
  async function connectToPeer(ticket) {
    const desktop = window.desktop;
    if (!desktop || !desktop.irohConnect) return;

    try {
      const result = await desktop.irohConnect(ticket);
      if (result.ok) {
        app.p2p.peerConnected = true;
        updateP2pBadge();
        toast('P2P-соединение установлено', 'ok');
      } else {
        toast(`P2P подключение не удалось: ${result.error}`, 'error');
      }
    } catch (error) {
      console.warn('[iroh] connect error:', error.message);
      toast('Ошибка P2P-подключения', 'error');
    }
  }

  /** Обновить badge статуса P2P в шапке. */
  function updateP2pBadge() {
    let badge = $('#p2p-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'p2p-badge';
      badge.className = 'badge';
      // Вставляем после conn-badge
      const existing = $('#conn-badge');
      if (existing) existing.parentNode.insertBefore(badge, existing.nextSibling);
      else return;
    }
    const isRunning = app.p2p.running;
    const isConnected = app.p2p.peerConnected;
    if (!isRunning) {
      badge.className = 'badge badge--muted';
      badge.textContent = 'P2P';
    } else if (isConnected) {
      badge.className = 'badge badge--on';
      badge.textContent = 'P2P ●';
    } else {
      badge.className = 'badge badge--off';
      badge.textContent = 'P2P ·';
    }
  }

  /** Остановить iroh при отключении. */
  function stopIrohForTable() {
    app.p2p.running = false;
    app.p2p.peerConnected = false;
    app.p2p.ticket = null;
    const desktop = window.desktop;
    if (desktop && desktop.irohStop) {
      desktop.irohStop().catch(() => {});
    }
    if (desktop && desktop.irohTunnelStop) {
      desktop.irohTunnelStop().catch(() => {});
    }
    updateP2pBadge();
    removeP2pTicketCopyButton();
  }

  /** Убрать кнопку копирования билета. */
  function removeP2pTicketCopyButton() {
    const btn = document.getElementById('btn-copy-p2p');
    if (btn) btn.remove();
  }

  /** Подписаться на события iroh от main-процесса. */
  let irohSubscribers = [];
  function subscribeToIrohEvents() {
    const desktop = window.desktop;
    if (!desktop) return;
    // Подписка на обновления списка пиров
    if (desktop.onIrohPeersUpdate) {
      irohSubscribers.push(desktop.onIrohPeersUpdate((data) => {
        if (data && data.peers && data.peers.length > 0) {
          app.p2p.peerConnected = true;
          app.p2p.peerAddr = data.peers[0].addr;
          updateP2pBadge();
        }
      }));
    }
  }

  /** Отписаться от событий iroh. */
  function unsubscribeFromIrohEvents() {
    for (const unsub of irohSubscribers) {
      try { unsub(); } catch (_) {}
    }
    irohSubscribers = [];
  }

  /* ------------------------------------------------------------------ *
   * Интерфейс стола
   * ------------------------------------------------------------------ */

  function viewer() {
    return { role: app.role, playerId: app.playerId, training: app.training };
  }

  function prepareTableUi() {
    if (!mapView) {
      mapView = new MapView($('#map-root'), {
        // Пути к картинкам приходят от сервера как /files/<имя>; окно открыто
        // по file://, поэтому подставляем адрес стола, иначе браузер искал бы
        // файл в корне диска.
        resolveUrl: (url) => assetUrl(url),
        onSetActive: (type) => emit('setActiveMap', { type }),
        onDelete: async (type, mapId) => {
          const slot = app.room.maps[type] || { items: [] };
          const map = (slot.items || []).find((item) => item.id === mapId);
          const answer = await modal({
            title: 'Удалить карту?',
            message: `Карта «${(map && map.name) || DnD.MAP_LABELS[type]}» будет убрана со стола`
              + (slot.items.length > 1 ? '. Остальные карты вкладки останутся.' : ' — вкладка станет пустой.'),
            confirmLabel: 'Удалить',
            danger: true
          });
          if (answer) emit('deleteMap', { type, mapId });
        },
        onUpload: async (type, file) => {
          const result = await readImageFile(file);
          if (result.canceled) return;
          if (result.error) return toast(result.error, 'error');
          toast('Загружаем карту…');
          emit('uploadMap', { type, image: result.dataUrl, name: result.name });
        },
        onSelectMap: (type, mapId) => emit('selectMap', { type, mapId }),
        onMoveToken: (tokenId, x, y) => emit('moveToken', { tokenId, x, y }),
        onNotice: (message) => toast(message),
        onToggleGrid: (enabled) => emit('setGrid', { enabled, cell: app.room.grid.cell }),
        onRenameToken: async (token) => {
          const name = await modal({
            title: 'Имя фишки',
            input: { value: token.name, maxLength: DnD.LIMITS.maxNameLength },
            confirmLabel: 'Сохранить'
          });
          if (name) emit('renameToken', { tokenId: token.id, name });
        },
        onAssignToken: (tokenId, playerId) => emit('assignTokenToPlayer', { tokenId, playerId }),
        onDeleteToken: (tokenId) => emit('deleteToken', { tokenId }),
        onSetTokenImage: async (tokenId, file) => {
          const result = await readImageFile(file);
          if (result.canceled) return;
          if (result.error) return toast(result.error, 'error');
          toast('Загружаем изображение фишки…');
          emit('setTokenImage', { tokenId, image: result.dataUrl });
        }
      });
    }

    if (!playersList) {
      playersList = new PlayersList($('#players-root'), {
        // ДМ открывает лист игрока прямо из списка участников.
        onOpenSheet: (playerId) => openPlayerSheet(playerId)
      });
    }
    if (!chatPanel) {
      chatPanel = new ChatPanel($('#tab-chat'), {
        onSend: (text) => emit('chatMessage', { text })
      });
    }
    if (!dicePanel) {
      dicePanel = new DicePanel($('#tab-dice'), {
        onRoll: (sides) => emit('rollDice', { sides })
      });
    }
    /**
   * Идентификатор карты, открытой в своей вкладке: фишка создаётся именно на
   * ней, иначе на вкладке с несколькими картами она показывалась бы везде.
   * @returns {string}
   */
  function activeMapId() {
    const type = app.room.activeMap || 'world';
    const slot = (app.room.maps || {})[type] || { items: [] };
    const active = (slot.items || []).find((item) => item.id === slot.activeId) || slot.items[0];
    return (active && active.id) || '';
  }

  if (!tokenPanel) {
      tokenPanel = new TokenPanel($('#tab-tokens'), {
        onCreate: (name) => emit('createToken', {
        name,
        mapType: app.room.activeMap || 'battle',
        // Привязываем к открытой карте: вкладка умеет держать несколько карт,
        // и фишка должна жить на той, где её создали.
        mapId: activeMapId()
      }),
        onDeleteToken: (tokenId) => emit('deleteToken', { tokenId }),
        onSetTokenImage: async (tokenId, file) => {
          const result = await readImageFile(file);
          if (result.canceled) return;
          if (result.error) return toast(result.error, 'error');
          toast('Загружаем изображение фишки…');
          emit('setTokenImage', { tokenId, image: result.dataUrl });
        }
      });
    }
    if (!sheetView) {
      sheetView = new window.SheetView($('#tab-sheet'), {
        onChange: onSheetChange,
        onPlayerChange: (playerId) => openPlayerSheet(playerId),
        onBack: () => closePlayerSheet(),
        onDetach: () => detachSheet()
      });
    }
  }

  function renderAll() {
    const ctx = viewer();
    playersList.render(app.room.players, ctx);
    mapView.render(app.room, ctx);
    chatPanel.renderAll(app.room.chatHistory);
    dicePanel.renderAll(app.room.diceHistory);
    tokenPanel.render(app.room.tokens, app.room.players, ctx);
    renderAdventurePanel();
    updateTableHeader();
    updateRoleUi();
    refreshSheetView(true);
  }

  /* ------------------------------------------------------------------ *
   * Справочник приключения
   *
   * Импорт кладёт сюда заметки, персонажей, предметы и таблицы из файла
   * Foundry. Это справка для мастера, а не игровые объекты: её нельзя
   * раздать игрокам, поэтому вкладка живёт только у ДМ.
   * ------------------------------------------------------------------ */

  /** Что показывать в справочнике и под каким заголовком. */
  const ADVENTURE_SECTIONS = [
    { key: 'notes', label: 'Заметки', icon: '📜', one: 'заметка', few: 'заметки', many: 'заметок' },
    { key: 'actors', label: 'Персонажи', icon: '🧝', one: 'персонаж', few: 'персонажа', many: 'персонажей' },
    { key: 'items', label: 'Предметы', icon: '🎒', one: 'предмет', few: 'предмета', many: 'предметов' },
    { key: 'tables', label: 'Таблицы', icon: '🎲', one: 'таблица', few: 'таблицы', many: 'таблиц' }
  ];

  /**
   * Склоняет слово по числу: 1 заметка, 2 заметки, 5 заметок.
   * @param {number} count
   * @param {string} one
   * @param {string} few
   * @param {string} many
   * @returns {string}
   */
  function plural(count, one, few, many) {
    const mod100 = Math.abs(count) % 100;
    const mod10 = mod100 % 10;
    if (mod100 >= 11 && mod100 <= 14) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
  }

  function renderAdventurePanel() {
    const button = document.querySelector('.tabs__btn[data-tab="adventure"]');
    const panel = $('#tab-adventure');
    if (!button || !panel) return;

    const adventure = app.role === 'dm' ? app.adventure : null;
    const total = adventure
      ? ADVENTURE_SECTIONS.reduce((sum, section) => sum + (adventure[section.key] || []).length, 0)
      : 0;
    // Пустой справочник занимал бы вкладку впустую: прячем её, пока есть что читать.
    button.hidden = total === 0;
    if (!button.hidden) {
      button.querySelector('.tabs__label').textContent = total ? `Приключение · ${total}` : 'Приключение';
    }
    if (!adventure) {
      panel.innerHTML = '';
      return;
    }

    panel.innerHTML = '';

    const header = el('div', 'adv-head');
    header.appendChild(el('div', 'adv-head__name', adventure.name || 'Приключение'));
    const summary = ADVENTURE_SECTIONS
      .filter((section) => (adventure[section.key] || []).length)
      .map((section) => {
        const total = adventure[section.key].length;
        return `${total} ${plural(total, section.one, section.few, section.many)}`;
      })
      .join(' · ');
    header.appendChild(el('div', 'adv-head__meta', summary));
    panel.appendChild(header);

    const query = el('input', 'adv-search');
    query.type = 'search';
    query.placeholder = 'Поиск по приключению';
    query.addEventListener('input', () => fillAdventureSections(panel, adventure, query.value.trim()));
    panel.appendChild(query);

    fillAdventureSections(panel, adventure, '');
  }

  /**
   * Перерисовывает разделы справочника, оставляя поиск и заголовок на месте.
   * @param {HTMLElement} panel
   * @param {object} adventure
   * @param {string} query
   */
  function fillAdventureSections(panel, adventure, query) {
    for (const old of panel.querySelectorAll('.adv-section')) old.remove();
    const needle = query.toLowerCase();
    let found = 0;

    for (const section of ADVENTURE_SECTIONS) {
      const items = adventure[section.key] || [];
      const visible = needle
        ? items.filter((item) => `${item.title || ''} ${item.name || ''} ${item.text || ''} ${item.description || ''}`
          .toLowerCase()
          .includes(needle))
        : items;
      if (!visible.length) continue;
      found += visible.length;

      const block = el('section', 'adv-section');
      block.appendChild(el('h3', 'adv-section__title', `${section.icon} ${section.label} · ${visible.length}`));
      for (const item of visible) block.appendChild(renderAdventureItem(section.key, item));
      panel.appendChild(block);
    }

    if (!found) {
      panel.appendChild(el('p', 'muted adv-empty', 'Ничего не найдено.'));
    }
  }

  /**
   * @param {string} kind
   * @param {object} item
   * @returns {HTMLElement}
   */
  function renderAdventureItem(kind, item) {
    const card = el('article', 'adv-item');
    const title = item.title || item.name || 'Без названия';
    card.appendChild(el('div', 'adv-item__title', title));

    if (kind === 'notes') {
      const text = item.text || 'Пустая заметка';
      card.appendChild(el('div', 'adv-item__text', text.length > 220 ? `${text.slice(0, 220)}…` : text));
      // Длинную заметку разворачиваем по клику, иначе она не помещается в панель.
      if (text.length > 220) {
        const more = el('button', 'adv-item__more', 'Читать целиком');
        const body = card.querySelector('.adv-item__text');
        more.addEventListener('click', () => {
          const open = body.classList.toggle('is-open');
          body.textContent = open ? text : `${text.slice(0, 220)}…`;
          more.textContent = open ? 'Свернуть' : 'Читать целиком';
        });
        card.appendChild(more);
      }
    } else if (kind === 'actors') {
      const row = el('div', 'adv-item__row');
      if (item.image) {
        const pic = document.createElement('img');
        pic.className = 'adv-item__img';
        pic.src = item.image;
        pic.alt = '';
        row.appendChild(pic);
      }
      row.appendChild(el('span', 'muted', 'Лист персонажа не заполняется — заведите его вручную.'));
      card.appendChild(row);
    } else if (kind === 'tables') {
      if (item.description) card.appendChild(el('div', 'adv-item__text', item.description));
      if (!item.formula && !item.description) {
        card.appendChild(el('div', 'muted adv-item__text', 'В файле не оказалось результатов.'));
      }
    } else if (item.type) {
      card.appendChild(el('div', 'adv-item__type', item.type));
    }
    return card;
  }

  function updateRoleUi() {
    const isDm = app.role === 'dm';
    $('#btn-save-campaign').hidden = !isDm;
    $('#btn-stop-host').hidden = !isDm;
    $('#addresses-panel').hidden = !isDm;
    $('#role-badge').textContent = isDm ? 'ДМ' : 'Игрок';
    $('#role-badge').className = `badge ${isDm ? 'badge--dm' : 'badge--player'}`;
    if (isDm) renderAddresses();
    applyAddressesCollapsed();
  }

  function updateTableHeader() {
    const campaign = app.campaign || {};
    $('#table-campaign').textContent = campaign.name || 'Кампания';
    const online = app.room.players.filter((player) => player.online).length;
    const parts = [];
    if (app.role === 'dm' && app.host) parts.push(`порт ${app.host.port}`);
    else if (app.training) parts.push('проверка без сети');
    else parts.push('подключён');
    parts.push(`участников: ${app.room.players.length} (в сети ${online})`);
    parts.push(`фишек: ${app.room.tokens.length}`);
    if (campaign.updatedAt) parts.push(`сохранено: ${formatDateTime(campaign.updatedAt)}`);
    $('#table-sub').textContent = parts.join(' · ');
  }

  function updateConnBadge(online) {
    const badge = $('#conn-badge');
    if (!badge) return;
    // В тренировочном столе связи нет по определению — так и подписываем.
    const training = Boolean(app.training) && online;
    badge.textContent = training ? 'без сети' : (online ? 'на связи' : 'нет связи');
    badge.className = `badge ${training ? 'badge--train' : (online ? 'badge--on' : 'badge--off')}`;
  }

  function renderAddresses() {
    const root = $('#addresses-root');
    if (!root || !app.host) return;
    root.innerHTML = '';

    const groups = new Map();
    const list = [{ kind: 'local', label: 'На этом компьютере', hint: 'Для проверки', address: '127.0.0.1', url: app.host.localUrl }]
      .concat(app.host.addresses || []);

    for (const entry of list) {
      const key = entry.kind === 'lan' ? 'lan' : (entry.kind === 'virtual' ? 'virtual' : 'other');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }

    const titles = {
      lan: 'Локальная сеть',
      virtual: 'Виртуальная сеть (Hamachi / Radmin VPN / ZeroTier / Porthole)',
      other: 'Прочие адреса'
    };

    for (const key of ['lan', 'virtual', 'other']) {
      const entries = groups.get(key);
      if (!entries || !entries.length) continue;
      const block = el('div', 'addr-group');
      block.appendChild(el('div', 'addr-group__title', titles[key]));
      for (const entry of entries) {
        const row = el('div', 'addr');
        const info = el('div', 'addr__info');
        info.appendChild(el('div', 'addr__url', entry.url));
        // У локального адреса поля iface нет. Раньше оно подставлялось
        // безусловно, и в подписи появлялось «На этом компьютере · undefined».
        const meta = entry.iface && entry.kind !== 'lan' && entry.kind !== 'virtual'
          ? (entry.label ? `${entry.label} · ${entry.iface}` : entry.iface)
          : (entry.iface || entry.label || '');
        info.appendChild(el('div', 'addr__meta muted', meta));
        row.appendChild(info);

        const copy = el('button', 'btn btn--tiny', 'Скопировать адрес');
        copy.type = 'button';
        copy.title = entry.url.replace('http://', '');
        copy.addEventListener('click', async () => {
          const ok = await copyText(entry.url);
          toast(ok ? `Скопировано: ${entry.url}` : 'Не удалось скопировать', ok ? 'ok' : 'error');
        });
        row.appendChild(copy);
        block.appendChild(row);
      }
      root.appendChild(block);
    }

    root.appendChild(buildPortholeBlock());
    root.appendChild(el('div', 'addr-note muted',
      'Игрокам нужно ввести адрес целиком, включая порт. Все участники должны быть в одной сети.'));
    applyAddressesCollapsed();
  }

  /**
   * Porthole (Local Port Sharing) не создаёт виртуальную сеть: он прокидывает
   * выбранный порт через Steam, и на компьютере игрока этот порт открывается
   * локально. Поэтому игрок вводит 127.0.0.1 с тем же портом, что у ДМ.
   */
  function buildPortholeBlock() {
    const block = el('div', 'addr-group addr-group--porthole');
    block.appendChild(el('div', 'addr-group__title', 'Porthole (Local Port Sharing)'));

    const url = `http://127.0.0.1:${app.host.port}`;
    const row = el('div', 'addr');
    const info = el('div', 'addr__info');
    info.appendChild(el('div', 'addr__url', url));
    info.appendChild(el('div', 'addr__meta muted', `для игрока: тот же порт ${app.host.port}, только на его компьютере`));
    row.appendChild(info);

    const copy = el('button', 'btn btn--tiny', 'Скопировать адрес');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      const ok = await copyText(url);
      toast(ok ? `Скопировано: ${url}` : 'Не удалось скопировать', ok ? 'ok' : 'error');
    });
    row.appendChild(copy);
    block.appendChild(row);

    const note = el('div', 'addr-note muted',
      `Порядок: в Porthole поделитесь портом ${app.host.port} с друзьями, они принимают его у себя, `
      + 'и в приложении вводят этот адрес. Свой порт можно посмотреть в шапке стола.');
    block.appendChild(note);

    const open = el('button', 'btn btn--tiny', 'Открыть Porthole в Steam');
    open.type = 'button';
    open.addEventListener('click', () => {
      if (desktop.openExternal) desktop.openExternal(PORTHOLE_URL);
      else window.open(PORTHOLE_URL, '_blank');
    });
    block.appendChild(open);
    return block;
  }

  /* ------------------------------------------------------------------ *
   * Настройки и панель адресов
   * ------------------------------------------------------------------ */

  let settingsGridInput = null;
  let settingsCellSelect = null;

  /**
   * Окно настроек — одно и то же на главном экране и за столом.
   * Здесь же будет выбор языка, когда в приложении появится второй.
   */
  function openSettings() {
    const overlay = el('div', 'modal-overlay');
    const box = el('div', 'modal modal--settings');
    box.appendChild(el('div', 'modal__title', 'Настройки'));

    const config = app.config || {};
    const appBox = el('div', 'box');
    appBox.appendChild(el('div', 'box__title', 'Приложение'));
    const row = (label, value) => {
      const node = el('div', 'settings__row');
      node.appendChild(el('span', 'settings__label', label));
      node.appendChild(el('span', 'settings__value', value));
      return node;
    };
    appBox.appendChild(row('Версия', config.versionLabel || config.version || '—'));
    appBox.appendChild(row('Режим', config.portable
      ? 'портативный: данные рядом с игрой'
      : 'обычный: данные в профиле Windows'));
    const dirRow = el('div', 'settings__row');
    dirRow.appendChild(el('span', 'settings__label', 'Папка данных'));
    dirRow.appendChild(el('span', 'settings__value settings__value--path', config.dataDir || '—'));
    appBox.appendChild(dirRow);
    const dirButton = el('button', 'btn btn--tiny', 'Открыть папку данных');
    dirButton.type = 'button';
    dirButton.addEventListener('click', () => desktop.openDataDir());
    appBox.appendChild(dirButton);
    box.appendChild(appBox);

    const langBox = el('div', 'box');
    langBox.appendChild(el('div', 'box__title', 'Язык интерфейса'));
    const langSelect = el('select', 'select settings__select');
    langSelect.dataset.setting = 'language';
    const ruOption = el('option', null, 'Русский');
    ruOption.value = 'ru';
    langSelect.appendChild(ruOption);
    langSelect.disabled = true;
    const langRow = el('div', 'settings__row');
    langRow.appendChild(langSelect);
    langBox.appendChild(langRow);
    langBox.appendChild(el('div', 'box__note',
      'Сейчас приложение только на русском. Переключатель заработает здесь, когда добавим второй язык.'));
    box.appendChild(langBox);

    const tableBox = el('div', 'box');
    tableBox.appendChild(el('div', 'box__title', 'Стол'));
    const isDm = app.role === 'dm' && app.connected;
    // В тренировочном столе ДМа нет, но сетку и размер клетки там проверяют
    // так же, поэтому настройки доступны и в нём.
    const canManageGrid = isDm || app.training;

    const gridRow = el('div', 'settings__row');
    const gridLabel = el('label', 'settings__check');
    const gridInput = el('input');
    gridInput.type = 'checkbox';
    gridInput.dataset.setting = 'grid';
    gridInput.checked = Boolean(app.room.grid.enabled);
    gridInput.disabled = !canManageGrid;
    gridLabel.appendChild(gridInput);
    gridLabel.appendChild(el('span', null, 'Сетка на карте'));
    gridRow.appendChild(gridLabel);

    const cellSelect = el('select', 'select settings__select');
    cellSelect.dataset.setting = 'cell';
    const choices = CELL_CHOICES.includes(app.room.grid.cell)
      ? CELL_CHOICES
      : CELL_CHOICES.concat([app.room.grid.cell]).sort((a, b) => a - b);
    for (const cell of choices) {
      const option = el('option', null, `клетка ${cell} px`);
      option.value = String(cell);
      if (cell === app.room.grid.cell) option.selected = true;
      cellSelect.appendChild(option);
    }
    cellSelect.disabled = !canManageGrid;
    gridRow.appendChild(cellSelect);
    tableBox.appendChild(gridRow);
    tableBox.appendChild(el('div', 'box__note', app.training
      ? 'Проверка без сети: сетка и размер клетки — только у вас, других участников здесь нет.'
      : (isDm
        ? 'Клетка ровно по размеру фишки. Сетку и размер видят все участники стола.'
        : 'Сетку на карте и размер клетки задаёт ДМ за столом.')));

    const applyGrid = () => {
      emit('setGrid', { enabled: gridInput.checked, cell: Number(cellSelect.value) });
    };
    gridInput.addEventListener('change', applyGrid);
    cellSelect.addEventListener('change', applyGrid);
    settingsGridInput = gridInput;
    settingsCellSelect = cellSelect;

    box.appendChild(tableBox);

    // Стол без сервера: за ним можно заранее заполнить лист персонажа и
    // посмотреть на игру глазами игрока, никого не собирая.
    if (!app.connected) {
      const trainBox = el('div', 'box');
      trainBox.appendChild(el('div', 'box__title', 'Проверка без сети'));
      const trainButton = el('button', 'btn btn--ghost', '▷ Запустить стол без сервера (как игрок)');
      trainButton.type = 'button';
      trainButton.dataset.setting = 'training';
      trainButton.addEventListener('click', () => {
        dismiss();
        startTraining();
      });
      trainBox.appendChild(trainButton);
      trainBox.appendChild(el('div', 'box__note',
        'Открывает стол от лица игрока, но без сервера и без сети: лист персонажа '
        + 'сохраняется на этом компьютере, и его можно будет отправить на настоящий стол '
        + 'при подключении. Карты, фишки и чат здесь — только для проверки и до закрытия окна.'));
      box.appendChild(trainBox);
    }

    const actions = el('div', 'modal__actions');
    const close = el('button', 'btn btn--accent', 'Закрыть');
    close.type = 'button';
    const dismiss = () => {
      settingsGridInput = null;
      settingsCellSelect = null;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') dismiss();
    };
    close.addEventListener('click', dismiss);
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) dismiss();
    });
    document.addEventListener('keydown', onKey);
    actions.appendChild(close);
    box.appendChild(actions);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  /** Обновляет настройки сетки в открытом окне настроек (после ответа сервера). */
  function syncSettingsGrid() {
    if (!settingsGridInput || !settingsCellSelect) return;
    settingsGridInput.checked = Boolean(app.room.grid.enabled);
    settingsCellSelect.value = String(app.room.grid.cell);
  }

  function applyAddressesCollapsed() {
    const panel = $('#addresses-panel');
    if (!panel) return;
    const collapsed = localStorage.getItem(ADDRESSES_COLLAPSED_KEY) === '1';
    panel.classList.toggle('is-collapsed', collapsed);
    const toggle = $('#addresses-toggle');
    if (toggle) {
      toggle.textContent = collapsed ? 'Показать ▸' : 'Скрыть ▾';
      toggle.setAttribute('aria-expanded', String(!collapsed));
    }
    const summary = $('#addresses-summary');
    if (summary) {
      summary.hidden = !collapsed;
      if (collapsed) {
        const list = (app.host && app.host.addresses) || [];
        const primary = list.find((entry) => entry.kind === 'lan') || list[0];
        summary.textContent = primary ? `Игрокам: ${primary.url}` : 'Стол ещё не поднят';
      }
    }
  }

  function toggleAddresses() {
    const collapsed = localStorage.getItem(ADDRESSES_COLLAPSED_KEY) === '1';
    localStorage.setItem(ADDRESSES_COLLAPSED_KEY, collapsed ? '0' : '1');
    applyAddressesCollapsed();
  }

  /* ------------------------------------------------------------------ *
   * Боковые панели стола
   * ------------------------------------------------------------------ */

  function panelCollapsed(key) {
    return localStorage.getItem(key) === '1';
  }

  /**
   * Сворачивает боковые панели: слева — совсем, справа — до иконок вкладок.
   * Так стол занимает почти всё окно, а иконки остаются под рукой.
   * @param {'left'|'right'} side
   * @param {boolean} collapsed
   */
  function setPanelCollapsed(side, collapsed) {
    localStorage.setItem(side === 'left' ? LEFT_COLLAPSED_KEY : RIGHT_COLLAPSED_KEY, collapsed ? '1' : '0');
    applyPanels();
  }

  function applyPanels() {
    const layout = $('.layout');
    if (!layout) return;
    const leftCollapsed = panelCollapsed(LEFT_COLLAPSED_KEY);
    const rightCollapsed = panelCollapsed(RIGHT_COLLAPSED_KEY);
    layout.classList.toggle('is-left-collapsed', leftCollapsed);
    layout.classList.toggle('is-right-collapsed', rightCollapsed);

    const left = $('#btn-panel-left');
    if (left) {
      left.textContent = leftCollapsed ? '▶ Участники' : '◀ Участники';
      left.title = leftCollapsed
        ? 'Показать панель участников и адресов'
        : 'Свернуть панель участников и адресов';
      left.classList.toggle('is-on', !leftCollapsed);
    }
    const right = $('#btn-panel-right');
    if (right) {
      right.textContent = rightCollapsed ? '◂ Панель' : 'Панель ▸';
      right.title = rightCollapsed
        ? 'Развернуть панель чата, кубиков, листа и фишек'
        : 'Свернуть панель до иконок';
      right.classList.toggle('is-on', !rightCollapsed);
    }
  }

  /**
   * Открывает лист персонажа в отдельном окне. Игрок — свой, ДМ — того, чей
   * лист открыт сейчас. В тренировочном столе окно подключается не к серверу, а
   * к тому же черновику листа: сервера там нет, а общее хранилище окон есть.
   * Панель стола после этого убирается до иконок.
   */
  async function detachSheet() {
    const isDm = app.role === 'dm';
    const viewPlayerId = isDm ? app.viewedSheetPlayerId : app.playerId;
    if (!viewPlayerId) return toast('Сначала выберите игрока в списке', 'error');

    const owner = isDm ? app.room.players.find((player) => player.playerId === viewPlayerId) : null;
    const result = await desktop.openSheetWindow({
      role: app.role,
      playerId: app.playerId,
      name: storedName() || (isDm ? 'Мастер' : 'Игрок'),
      viewPlayerId,
      readOnly: isDm,
      training: app.training,
      title: isDm ? `Лист игрока: ${owner ? owner.name : ''}`.trim() : 'Лист персонажа'
    });
    if (!result || !result.ok) {
      return toast((result && result.error) || 'Не удалось открыть окно листа', 'error');
    }
    setPanelCollapsed('right', true);
    toast('Лист открыт в отдельном окне', 'ok');
  }

  /* ------------------------------------------------------------------ *
   * Лист персонажа
   * ------------------------------------------------------------------ */

  function onSheetChange(sheet) {
    if (app.role !== 'player') return;
    sheetView.setStatus('Сохранение…');
    clearTimeout(app.sheetSaveTimer);
    app.sheetSaveTimer = setTimeout(() => {
      emit('saveCharacterSheet', { sheet });
    }, 400);
  }

  function markSheetSaved() {
    if (app.role !== 'player') return;
    clearTimeout(app.sheetStatusTimer);
    const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    sheetView.setStatus(app.training
      ? `Сохранено на этом компьютере в ${time}`
      : `Сохранено на сервере в ${time}`);
  }

  /**
   * Предлагает перенести на настоящий стол лист, заполненный заранее без стола.
   * Спрашиваем только тогда, когда на столе у этого игрока лист ещё пуст:
   * заготовка не должна затирать уже начатую игру.
   */
  function offerDraftSheet() {
    if (app.training) return;
    const draft = LocalTable.readDraft(app.playerId);
    if (!LocalTable.shouldOfferDraft({ draft, serverSheet: app.room.sheets[app.playerId] })) return;

    modal({
      title: 'Отправить лист на стол?',
      message: 'Вы заполняли лист персонажа без стола, а на столе для вас он пока пуст. '
        + 'Отправить заготовку?',
      confirmLabel: 'Отправить',
      cancelLabel: 'Не отправлять'
    }).then((answer) => {
      if (!answer) return;
      emit('saveCharacterSheet', { sheet: draft });
      toast('Лист персонажа отправлен на стол', 'ok');
    });
  }

  /**
   * Перерисовывает панель листа. Не трогаем поля, если пользователь прямо сейчас
   * в них печатает, иначе слетит курсор.
   */
  function refreshSheetView(force = false) {
    if (!sheetView) return;

    if (app.role === 'dm') {
      const targets = app.room.players.filter((player) => player.role !== 'dm');
      // Игрок отключился и пропал из списка — возвращаемся к списку игроков.
      if (app.viewedSheetPlayerId && !targets.some((player) => player.playerId === app.viewedSheetPlayerId)) {
        app.viewedSheetPlayerId = null;
        app.sheetShownFor = null;
      }
      sheetView.setReadOnly(true);
      sheetView.setPlayerList(targets, app.viewedSheetPlayerId);

      // ДМ сам решает, чей лист открыть: сначала он видит список игроков.
      if (!app.viewedSheetPlayerId) {
        sheetView.setMode('list');
        sheetView.setStatus(targets.length ? `Игроков за столом: ${targets.length}` : '');
        return;
      }

      const owner = app.room.players.find((player) => player.playerId === app.viewedSheetPlayerId);
      const sheet = app.room.sheets[app.viewedSheetPlayerId];
      sheetView.setMode('sheet', { canGoBack: true });
      if (!sheet) {
        // Лист ещё не дошёл: показываем пустую форму и запрашиваем данные один раз.
        sheetView.setSheet(DnD.createEmptySheet());
        sheetView.setStatus(`Лист игрока ${owner ? owner.name : ''} загружается…`);
        app.sheetShownFor = null;
        requestSheetOnce(app.viewedSheetPlayerId);
        return;
      }
      if (!force && app.sheetShownFor === app.viewedSheetPlayerId) return;
      app.sheetShownFor = app.viewedSheetPlayerId;
      sheetView.setSheet(sheet);
      sheetView.setStatus(`Просмотр · ${owner ? owner.name : ''}`);
      return;
    }

    // Игрок видит и редактирует только свой лист.
    sheetView.setMode('sheet');
    sheetView.setReadOnly(false);
    const sheet = app.room.sheets[app.playerId];
    if (!sheet) {
      sheetView.setSheet(DnD.createEmptySheet());
      return;
    }
    const focused = document.activeElement && sheetView.root.contains(document.activeElement);
    if (!force && focused) return;
    if (!force && app.sheetShownFor === app.playerId) return;
    app.sheetShownFor = app.playerId;
    sheetView.setStatus(app.training
      ? 'Лист тренировочного стола: сохраняется на этом компьютере'
      : `Имя игрока: ${storedName() || '—'}`);
    sheetView.setSheet(sheet);
  }

  /** ДМ запрашивает лист игрока только один раз, чтобы не спамить сервер. */
  function requestSheetOnce(playerId) {
    if (requestedSheets.has(playerId)) return;
    requestedSheets.add(playerId);
    emit('requestCharacterSheet', { playerId });
  }

  function openPlayerSheet(playerId) {
    if (app.role !== 'dm' || !playerId) return;
    app.viewedSheetPlayerId = playerId;
    app.sheetShownFor = null;
    activateTab('sheet');
    refreshSheetView(true);
  }

  /** Возврат от листа игрока к списку игроков (кнопка в панели листа). */
  function closePlayerSheet() {
    app.viewedSheetPlayerId = null;
    app.sheetShownFor = null;
    refreshSheetView(true);
  }

  function activateTab(name) {
    for (const button of document.querySelectorAll('.tabs__btn')) {
      button.classList.toggle('is-active', button.dataset.tab === name);
    }
    for (const panel of document.querySelectorAll('.panel--tab')) {
      panel.classList.toggle('is-active', panel.id === `tab-${name}`);
    }
  }

  /* ------------------------------------------------------------------ *
   * Действия на экране стола
   * ------------------------------------------------------------------ */

  async function leaveTable() {
    if (app.role === 'dm' && app.host) {
      const answer = await modal({
        title: 'Выйти из-за стола?',
        message: 'Стол будет остановлен, игроки отключатся. Кампания сохранится на диск.',
        confirmLabel: 'Выйти',
        danger: true
      });
      if (!answer) return;
      disconnect();
      await desktop.stopHost();
      app.host = null;
    } else {
      disconnect();
    }
    app.room = {
      players: [], sheets: {}, maps: normalizeMapSlots(null),
      activeMap: null, grid: { enabled: false, cell: 46 },
      tokens: [], diceHistory: [], chatHistory: []
    };
    app.sheetShownFor = null;
    app.viewedSheetPlayerId = null;
    app.training = false;
    showScreen('screen-home');
    await initHomeData();
  }

  async function initHomeData() {
    const status = await desktop.hostStatus();
    if (!status.running) app.host = null;
  }

  async function saveCampaign() {
    toast('Сохраняем кампанию…');
    const result = await desktop.saveCampaign();
    if (!result.ok) return toast(result.error, 'error');
    app.campaign = result.campaign;
    updateTableHeader();
    toast(`Кампания «${result.campaign.name}» сохранена`, 'ok');
  }

  async function stopHost() {
    const answer = await modal({
      title: 'Остановить стол?',
      message: 'Кампания будет сохранена, все игроки отключатся от стола.',
      confirmLabel: 'Остановить',
      danger: true
    });
    if (!answer) return;
    disconnect();
    await desktop.stopHost();
    app.host = null;
    toast('Стол остановлен, кампания сохранена', 'ok');
    showScreen('screen-home');
    await initHomeData();
  }

  /* ------------------------------------------------------------------ *
   * Обработчики экранов
   * ------------------------------------------------------------------ */

  function bindUi() {
    $('#btn-go-create').addEventListener('click', () => {
      showScreen('screen-create');
      $('#create-name').focus();
    });
    $('#btn-go-load').addEventListener('click', openLoadScreen);
    $('#btn-go-join').addEventListener('click', openJoinScreen);
    for (const back of document.querySelectorAll('[data-back]')) {
      back.addEventListener('click', () => showScreen('screen-home'));
    }

    $('#btn-create-start').addEventListener('click', createAndStart);
    $('#create-name').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') createAndStart();
    });

    $('#btn-start-loaded').addEventListener('click', startTable);

    $('#btn-join').addEventListener('click', doJoin);
    $('#join-address').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') doJoin();
    });
    $('#join-name').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') doJoin();
    });
    // P2P-подключение живёт на экране подключения: билет всегда приходит от ДМ,
    // поэтому отдельная кнопка на главном экране была лишней.
    $('#btn-join-p2p').addEventListener('click', doJoinP2p);
    $('#join-p2p-ticket').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') doJoinP2p();
    });

    $('#btn-save-campaign').addEventListener('click', saveCampaign);
    $('#btn-stop-host').addEventListener('click', stopHost);
    $('#btn-leave').addEventListener('click', leaveTable);

    $('#btn-open-datadir').addEventListener('click', () => desktop.openDataDir());
    $('#btn-settings-home').addEventListener('click', openSettings);
    $('#btn-settings-table').addEventListener('click', openSettings);
    $('#addresses-toggle').addEventListener('click', toggleAddresses);
    $('#btn-panel-left').addEventListener('click', () => setPanelCollapsed('left', !panelCollapsed(LEFT_COLLAPSED_KEY)));
    $('#btn-panel-right').addEventListener('click', () => setPanelCollapsed('right', !panelCollapsed(RIGHT_COLLAPSED_KEY)));

    for (const button of document.querySelectorAll('.tabs__btn')) {
      button.addEventListener('click', () => {
        // Клик по иконке свёрнутой панели и разворачивает её, и открывает вкладку.
        if (panelCollapsed(RIGHT_COLLAPSED_KEY)) setPanelCollapsed('right', false);
        activateTab(button.dataset.tab);
      });
    }
    applyPanels();

    desktop.onCampaignSaved(({ meta, reason }) => {
      app.campaign = meta;
      updateTableHeader();
      if (reason === 'auto') toast(`Автосохранение: ${formatDateTime(meta.updatedAt)}`, 'info', 2500);
    });
    desktop.onCampaignError(({ message }) => toast(message, 'error'));
  }

  function doJoin() {
    const raw = $('#join-address').value.trim();
    const name = $('#join-name').value.trim();
    if (!raw) return setStatus('#join-status', 'Введите адрес сервера', 'error');
    if (!name) return setStatus('#join-status', 'Введите имя', 'error');

    let url = raw;
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    url = url.replace(/\/+$/, '');
    if (!/:\d+$/.test(url)) url = `${url}:32100`;

    localStorage.setItem(PLAYER_NAME_KEY, name.slice(0, DnD.LIMITS.maxNameLength));
    prepareTableUi();
    showScreen('screen-table');
    app.role = 'player';
    updateRoleUi();
    connect({ url, name: name.slice(0, DnD.LIMITS.maxNameLength), playerId: localPlayerId() });
  }

  /**
   * Экран подключения: здесь и обычный адрес ДМ, и его P2P-билет.
   */
  function openJoinScreen() {
    $('#join-name').value = storedName();
    $('#join-address').value = localStorage.getItem(LAST_ADDRESS_KEY) || '';
    showScreen('screen-join');
    $('#join-address').focus();
  }

  /**
   * Подключение к столу ДМ по P2P-билету (iroh). Билет ДМ копирует из своей
   * панели адресов («P2P-адрес (кроме сети)»). Здесь мы поднимаем локальный
   * TCP-туннель и направляем socket.io на 127.0.0.1:<локальный порт>.
   */
  async function doJoinP2p() {
    const ticket = $('#join-p2p-ticket').value.trim();
    const name = $('#join-name').value.trim();
    if (!ticket) return setStatus('#join-status', 'Вставьте P2P-билет, который дал ДМ', 'error');
    if (!name) return setStatus('#join-status', 'Введите имя', 'error');
    if (!desktop || !desktop.irohTunnelClient) {
      return setStatus('#join-status', 'P2P недоступен в этом приложении', 'error');
    }

    setStatus('#join-status', 'Соединяемся по P2P…');
    const result = await desktop.irohTunnelClient(ticket);
    if (!result.ok) {
      return setStatus('#join-status', `P2P не удалось: ${result.error}`, 'error');
    }

    const url = `http://127.0.0.1:${result.localPort}`;
    localStorage.setItem(PLAYER_NAME_KEY, name.slice(0, DnD.LIMITS.maxNameLength));
    prepareTableUi();
    showScreen('screen-table');
    app.role = 'player';
    app.p2p.ticket = ticket;
    updateRoleUi();
    connect({ url, name: name.slice(0, DnD.LIMITS.maxNameLength), playerId: localPlayerId(), p2p: true, keepP2p: true });
  }

  /* ------------------------------------------------------------------ *
   * Импорт внешнего приключения
   * ------------------------------------------------------------------ */

  /** Кэш предпросмотра: между показом и применением файл перечитывать незачем. */
  let adventurePreview = null;
  let adventureFilePath = '';

  function closeImportDialog() {
    adventurePreview = null;
    $('#import-overlay').hidden = true;
  }

  function renderImportPreview(preview) {
    const summary = $('#import-summary');
    const counts = preview.counts.map((item) => `${item.label.toLowerCase()} — ${item.count}`).join(', ');
    summary.textContent = preview.selectable
      ? `«${preview.sourceTitle}»: найдено ${preview.total}, выбрать можно ${preview.selectable}. ${counts}.`
      : `«${preview.sourceTitle}»: подходящих документов нет.`;

    const warnings = $('#import-warnings');
    warnings.innerHTML = '';
    for (const text of preview.warnings) {
      warnings.appendChild(el('li', 'import-row__note', text));
    }
    for (const item of preview.skipped) {
      warnings.appendChild(el('li', '', `${item.name || 'без названия'} — ${item.reason}`));
    }
    warnings.hidden = !warnings.childElementCount;

    const list = $('#import-list');
    list.innerHTML = '';
    for (const plan of preview.plans) {
      const row = el('label', `import-row${plan.selectable ? '' : ' is-disabled'}`);
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = Boolean(plan.selected);
      check.disabled = !plan.selectable;
      check.dataset.sourceId = plan.sourceId;

      const text = el('div', 'import-row__text');
      text.appendChild(el('div', 'import-row__name', plan.name || 'Без названия'));
      if (plan.targetLabel) text.appendChild(el('div', 'import-row__meta', plan.targetLabel));
      if (plan.note) text.appendChild(el('div', 'import-row__note', plan.note));

      row.appendChild(check);
      row.appendChild(text);
      list.appendChild(row);
    }

    $('#import-all').checked = true;
    $('#import-all').disabled = preview.selectable === 0;
    $('#import-apply').disabled = preview.selectable === 0;
  }

  async function openImportDialog() {
    toast('Выберите файл приключения…', 'info', 2000);
    const picked = await desktop.pickAdventureFile();
    if (picked.canceled) return;
    if (!picked.ok) return toast(picked.error || 'Не удалось открыть файл', 'error');

    const result = await desktop.inspectAdventure(picked.filePath);
    if (!result.ok) return toast(result.error || 'Не удалось прочитать файл', 'error');
    adventurePreview = result.preview;
    adventureFilePath = picked.filePath;
    renderImportPreview(adventurePreview);
    $('#import-overlay').hidden = false;
  }

  async function applyImport() {
    if (!adventurePreview) return;
    const include = [...document.querySelectorAll('#import-list input[type=checkbox]')]
      .filter((input) => !input.disabled && input.checked)
      .map((input) => input.dataset.sourceId);
    if (!include.length) return toast('Не выбрано ни одной сущности', 'error');

    const apply = $('#import-apply');
    apply.disabled = true;
    apply.textContent = 'Импортируем…';
    const result = await desktop.importAdventure(adventureFilePath, include);
    apply.textContent = 'Импортировать';
    apply.disabled = false;

    if (!result.ok) {
      if (!result.canceled) toast(result.error || 'Не удалось импортировать', 'error');
      return;
    }
    closeImportDialog();
    toast(result.report.summary, 'ok');
    // Справочник приключения наполняется сразу: отдельного события со снимком
    // стола нет, поэтому обновляем его из ответа импорта.
    if (result.adventure) {
      app.adventure = result.adventure;
      renderAdventurePanel();
    }
    for (const item of result.report.skipped.slice(0, 3)) {
      toast(`Пропущено: ${item.name || 'без названия'} — ${item.reason}`, 'info', 6000);
    }
  }

  function bindImportUi() {
    $('#btn-import-adventure').addEventListener('click', openImportDialog);
    $('#import-cancel').addEventListener('click', closeImportDialog);
    $('#import-apply').addEventListener('click', applyImport);
    $('#import-all').addEventListener('change', (event) => {
      for (const input of document.querySelectorAll('#import-list input[type=checkbox]')) {
        if (!input.disabled) input.checked = event.target.checked;
      }
    });
    $('#import-overlay').addEventListener('click', (event) => {
      if (event.target === $('#import-overlay')) closeImportDialog();
    });
  }

  /* ------------------------------------------------------------------ *
   * Старт
   * ------------------------------------------------------------------ */

  if (!desktop) {
    document.body.innerHTML = '<p style="padding:24px">Это приложение нужно запускать через Electron (npm start).</p>';
    return;
  }

  bindUi();
  bindImportUi();
  updateConnBadge(false);
  initHome().catch((error) => toast(`Ошибка запуска: ${error.message}`, 'error'));

})();
