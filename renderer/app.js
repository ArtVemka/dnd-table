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
  const ADDRESSES_COLLAPSED_KEY = 'dnd-table.addressesCollapsed';
  const LEFT_COLLAPSED_KEY = 'dnd-table.leftPanelCollapsed';
  const RIGHT_COLLAPSED_KEY = 'dnd-table.rightPanelCollapsed';
  /** Размеры клетки сетки, которые предлагаются в настройках (в пикселях). */
  const CELL_CHOICES = [32, 46, 56, 72, 96];

/**
 * Пределы истории на клиенте. Те же числа, что у сервера: так память у всех
 * участников растёт одинаково и не зависит от длины партии.
 */
const HISTORY_LIMITS = { dice: 200, chat: 300 };

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
      /** Локальный порт туннеля игрока; 0, пока туннель не поднят. */
      tunnelPort: 0,
      /** Попытка поднять endpoint провалилась: билета не будет. */
      failed: false,
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
   * @param {number} [maxBytes] свой предел размера: у аватара он меньше карты
   */
  function readImageFile(file, maxBytes = DnD.LIMITS.maxImageBytes) {
    return new Promise((resolve) => {
      if (!file) return resolve({ canceled: true });

      const megabytes = (file.size / 1024 / 1024).toFixed(1);
      if (!file.size) {
        return resolve({ error: `Файл «${file.name}» пустой.` });
      }
      if (file.size > maxBytes) {
        return resolve({
          error: `Файл «${file.name}» весит ${megabytes} МБ, а можно не больше `
            + `${Math.round(maxBytes / 1024 / 1024)} МБ. Уменьшите изображение.`
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
        grid: state.grid || { enabled: false, cell: DnD.GRID.defaultCell, columns: 0 },
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
      if (!app.training) startIrohForTable();
      // Игрок пришёл по туннелю: сам факт соединения доказывает, что туннель
      // жив. Раньше этот флаг ставил мёртвый обработчик iroh:peer, и badge
      // «P2P ●» не загорался никогда.
      if (app.p2p.tunnelPort) {
        app.p2p.peerConnected = true;
        updateP2pBadge();
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
      // Мастер видит, что кто-то дошёл до стола, по списку участников.
      if (app.role === 'dm' && app.p2p.running) {
        const peers = app.room.players.filter((player) => player.role !== 'dm').length;
        if (app.p2p.peerConnected !== (peers > 0)) {
          app.p2p.peerConnected = peers > 0;
          updateP2pBadge();
        }
      }
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
      renderAdventurePanel();
    });

    // Массовая картинка приходит пачкой: перерисовываем всё один раз, а не
    // по разу на каждую фишку.
    socket.on('tokensUpdated', ({ tokens } = {}) => {
      if (!Array.isArray(tokens) || !tokens.length) return;
      const byId = new Map(app.room.tokens.map((token) => [token.id, token]));
      for (const token of tokens) byId.set(token.id, token);
      app.room.tokens = [...byId.values()];
      mapView.render(app.room, viewer());
      tokenPanel.render(app.room.tokens, app.room.players, viewer());
      renderAdventurePanel();
    });

    // Массовая картинка в справочнике: сервер присылает обновлённое приключение,
    // потому что пришёл копией, а не дельтой по одному объекту.
    socket.on('adventureUpdated', (adventure) => {
      app.adventure = adventure || null;
      renderAdventurePanel();
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
      // Сервер свои пределы держит, а клиент копил историю, пока не кончится
      // память: DOM обрезается до двухсот строк, а массив рос без границы.
      // За длинную партию это десятки тысяч записей в памяти браузера.
      if (app.room.diceHistory.length > HISTORY_LIMITS.dice) {
        app.room.diceHistory.splice(0, app.room.diceHistory.length - HISTORY_LIMITS.dice);
      }
      dicePanel.append(roll);
      // Строку о броске в чат добавляет сервер (событие chatMessage),
      // поэтому у всех клиентов история чата совпадает.
    });

    socket.on('chatMessage', (message) => {
      app.room.chatHistory.push(message);
      if (app.room.chatHistory.length > HISTORY_LIMITS.chat) {
        app.room.chatHistory.splice(0, app.room.chatHistory.length - HISTORY_LIMITS.chat);
      }
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
        app.p2p.failed = true;
        console.warn('[iroh] failed to start:', result.error);
        if (app.role === 'dm') renderAddresses();
      }
    } catch (error) {
      app.p2p.failed = true;
      console.warn('[iroh] start error:', error.message);
      if (app.role === 'dm') renderAddresses();
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
        // Билет показываем только мастеру: он его и раздаёт игрокам.
        if (app.role === 'dm') renderAddresses();
      } else {
        // Endpoint поднялся, а адрес получить не удалось — показывать
        // «готовится» дальше бессмысленно, игроки всё равно не войдут.
        app.p2p.failed = true;
        console.warn('[iroh] ticket failed:', result && result.error);
        if (app.role === 'dm') renderAddresses();
      }
    } catch (error) {
      app.p2p.failed = true;
      console.warn('[iroh] ticket creation error:', error.message);
      if (app.role === 'dm') renderAddresses();
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
    app.p2p.tunnelPort = 0;
    app.p2p.failed = false;
    app.p2p.ticket = null;
    const desktop = window.desktop;
    if (desktop && desktop.irohStop) {
      desktop.irohStop().catch(() => {});
    }
    if (desktop && desktop.irohTunnelStop) {
      desktop.irohTunnelStop().catch(() => {});
    }
    updateP2pBadge();
    if (app.role === 'dm') renderAddresses();
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
        onToggleGrid: (enabled) => emit('setGrid', {
          enabled,
          cell: app.room.grid.cell,
          columns: app.room.grid.columns || 0
        }),
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
        onOpenSheet: (playerId) => openPlayerSheet(playerId),
        // И выводит его фишку на поле одним нажатием, прямо из листа.
        onSpawnToken: (playerId) => emit('createTokenFromSheet', {
          playerId,
          mapType: app.room.activeMap || 'battle',
          mapId: activeMapId()
        }),
        resolveUrl: assetUrl
      });
    }
    if (!chatPanel) {
      chatPanel = new ChatPanel($('#tab-chat'), {
        onSend: (text) => emit('chatMessage', { text }),
        resolveUrl: assetUrl
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
        onDetach: () => detachSheet(),
        onAvatarPick: uploadAvatar,
        onAvatarClear: () => emit('setAvatar', { image: null }),
        resolveUrl: assetUrl
      });
    }
  }

  /**
   * Загрузка аватара. Файл проверяется тем же кодом, что и картинки фишек, а
   * сервер кладёт его в файлы кампании и сам решает, что за это считать.
   * @param {File} file
   */
  async function uploadAvatar(file) {
    const read = await readImageFile(file, DnD.LIMITS.maxAvatarBytes);
    if (read.canceled) return;
    if (read.error) return toast(read.error, 'error');
    emit('setAvatar', { image: read.dataUrl });
  }

  /** Аватар текущего игрока: из списка участников, он у всех один и тот же. */
  function ownAvatar() {
    const me = app.room.players.find((player) => player.playerId === app.playerId);
    return me ? me.avatar || '' : '';
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
   * Ключ группы: название без регистра и лишних пробелов.
   *
   * При импорте из Foundry один и тот же «Кобольд» приходит десятками копий,
   * иногда с разным регистром и отступами. Сравнивать «как есть» нельзя:
   * одна группа распалась бы на несколько, и картинка легла бы не на всё.
   * @param {string} name
   * @returns {string}
   */
  function groupKey(name) {
    return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /**
   * Указатель предметов dnd.su: название → ссылка на статью.
   *
   * Собран скриптом scripts/build-dnd-index.js из каталога dnd.su и лежит
   * рядом с игрой, поэтому клик работает мгновенно и без сети. Предмета в
   * указателе нет — ссылки не будет, и это лучше битой.
   * @type {Record<string, string>|null}
   */
  let dndItems = null;
  let dndItemsLoaded = false;

  /**
   * @param {string} name
   * @returns {Promise<string>} ссылка или пустая строка
   */
  async function loadDndItemUrl(name) {
    if (!dndItemsLoaded) {
      dndItemsLoaded = true;
      try {
        const response = await fetch('dnd-items.json');
        dndItems = response.ok ? await response.json() : {};
      } catch {
        dndItems = {};
      }
    }
    if (!dndItems || !name) return '';
    // Пробуем точное название, а если не вышло — то же без хвостов в скобках:
    // в базе «Алхимический сосуд (оранжевый)» это отдельная статья, но искать
    // игроку разумнее по общему названию.
    const direct = dndItems[groupKey(name)];
    if (direct) return direct;
    const trimmed = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
    return trimmed && trimmed !== name ? dndItems[groupKey(trimmed)] || '' : '';
  }

  /**
   * Складывает объекты в группы по названию.
   * @param {object[]} items
   * @returns {{name: string, members: object[]}[]}
   */
  function groupByName(items) {
    const groups = new Map();
    for (const item of items) {
      const key = groupKey(item.name || item.title);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return [...groups].map(([key, members]) => ({ name: members[0].name || members[0].title || '—', members }));
  }

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

  /**
   * Перестраивает справочник приключения.
   *
   * Работает не на каждый вызов, а когда есть смысл: панель умеет держать
   * до тысячи двух объектов, и её построение на каждое движение фишки было
   * самой дорогой операцией в интерфейсе. Пока вкладка справочника закрыта,
   * достаточно обновить видимость кнопки и запомнить, что данные изменились:
   * построим один раз, когда мастер откроет вкладку.
   * @param {{force?: boolean}} [options]
   */
  function renderAdventurePanel(options) {
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
      adventurePanelStale = false;
      return;
    }

    // Панель скрыта: не строим её заново, но помечаем содержимое устаревшим.
    if (!options || !options.force) {
      if (!panel.classList.contains('is-active')) {
        adventurePanelStale = true;
        return;
      }
    }
    adventurePanelStale = false;

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
    // С задержкой: перестроение разделов на каждый введённый символ заметно
    // тормозило на длинном справочнике, а человек печатает быстрее, чем
    // список успевает перестроиться.
    query.addEventListener('input', () => {
      if (adventureSearchTimer) clearTimeout(adventureSearchTimer);
      adventureSearchTimer = setTimeout(() => {
        adventureSearchTimer = null;
        fillAdventureSections(panel, adventure, query.value.trim());
      }, 120);
    });
    panel.appendChild(query);

    fillAdventureSections(panel, adventure, '');
  }

  /**
   * Перерисовывает разделы справочника, оставляя поиск и заголовок на месте.
   * @param {HTMLElement} panel
   * @param {object} adventure
   * @param {string} query
   */
  /**
   * Поисковая строка объекта в нижнем регистре, с кэшем.
   *
   * Раньше на каждый введённый символ для каждого объекта склеивалось
   * «название + текст + описание» и приводилось к нижнему регистру. У заметки
   * текст достигает двадцати тысяч символов, так что на длинном справочнике
   * один введённый символ означал мегабайты строк. Строка не меняется, пока
   * не изменился сам объект, поэтому считаем её один раз.
   * @param {object} item
   * @returns {string}
   */
  function searchText(item) {
    const cached = searchTextCache.get(item);
    if (cached !== undefined) return cached;
    const text = `${item.title || ''} ${item.name || ''} ${item.text || ''} ${item.description || ''}`
      .toLowerCase();
    searchTextCache.set(item, text);
    return text;
  }

  const searchTextCache = new WeakMap();

  function fillAdventureSections(panel, adventure, query) {
    for (const old of panel.querySelectorAll('.adv-section')) old.remove();
    const needle = query.toLowerCase();
    let groups = 0;

    for (const section of ADVENTURE_SECTIONS) {
      const items = adventure[section.key] || [];
      const visible = needle
        ? items.filter((item) => searchText(item).includes(needle))
        : items;
      if (!visible.length) continue;
      // Одинаковые названия схлопываются в одну группу: вместо двадцати
      // одинаковых карточек «Кобольд» мастер видит одну с пометкой «×20».
      const grouped = groupByName(visible);
      groups += grouped.length;

      const block = el('section', 'adv-section');
      const total = visible.length;
      const title = grouped.length === total
        ? `${section.icon} ${section.label} · ${total}`
        : `${section.icon} ${section.label} · ${grouped.length} ${plural(grouped.length, section.one, section.few, section.many)} из ${total}`;
      block.appendChild(el('h3', 'adv-section__title', title));
      for (const group of grouped) block.appendChild(renderAdventureGroup(section, group));
      panel.appendChild(block);
    }

    // Фишки живут на столе, а не в приключении, но группируются по тому же
    // правилу: мастеру удобно назначать картинку всем «Кобольдам» сразу.
    const tokens = app.room.tokens || [];
    if (tokens.length) {
      const visible = needle
        ? tokens.filter((token) => token.name.toLowerCase().includes(needle))
        : tokens;
      const grouped = groupByName(visible);
      if (grouped.length) {
        groups += grouped.length;
        const block = el('section', 'adv-section');
        block.appendChild(el('h3', 'adv-section__title', `⬤ Фишки · ${grouped.length} из ${visible.length}`));
        for (const group of grouped) block.appendChild(renderTokenGroup(group));
        panel.appendChild(block);
      }
    }

    if (!groups) {
      panel.appendChild(el('p', 'muted adv-empty', 'Ничего не найдено.'));
    }
  }

  /**
   * Группа объектов приключения с массовой картинкой.
   * @param {object} section
   * @param {{name: string, members: object[]}} group
   * @returns {HTMLElement}
   */
  function renderAdventureGroup(section, group) {
    const card = el('article', `adv-item adv-item--group${group.members.length > 1 ? ' is-group' : ''}`);
    const head = el('div', 'adv-group__head');
    head.appendChild(renderItemTitle(group.name, section.key));
    if (group.members.length > 1) {
      head.appendChild(el('span', 'adv-group__count', `× ${group.members.length}`));
    }
    card.appendChild(head);

    // Картинку массово ставят только тем, у кого это осмысленно: предметам
    // и персонажам. Заметку и таблицу одной картинкой не заменить.
    if (section.key === 'items' || section.key === 'actors') {
      card.appendChild(makeGroupImageButton(group.name, group.members.length, (name, image) => {
        emit('setAdventureGroupImage', { section: section.key, name, image });
      }));
    }

    // Подробности показываем, когда в группе что-то есть сказать либо когда
    // группа не одна: одиночную карточку незачем прятать под «раскрыть».
    const sample = group.members[0];
    const text = kindText(section.key, sample);
    const showDetails = group.members.length > 1 || (text && text.length > 60);
    if (!showDetails) {
      if (text) card.appendChild(el('div', 'adv-item__text', text.length > 220 ? `${text.slice(0, 220)}…` : text));
      return card;
    }

    const body = el('div', 'adv-group__body');
    if (text) {
      const clipped = el('div', 'adv-item__text', text.length > 220 ? `${text.slice(0, 220)}…` : text);
      body.appendChild(clipped);
      if (text.length > 220) body.appendChild(makeMoreButton(clipped, text));
    }
    if (group.members.length > 1) {
      const list = el('div', 'adv-group__list');
      for (const member of group.members) {
        const memberText = kindText(section.key, member);
        if (memberText && memberText !== text) {
          list.appendChild(el('div', 'adv-group__member', `— ${memberText.slice(0, 120)}`));
        }
      }
      if (list.childElementCount) body.appendChild(list);
    }
    const toggle = el('button', 'adv-item__more', 'Показать');
    toggle.addEventListener('click', () => {
      const open = body.hidden;
      body.hidden = !open;
      toggle.textContent = open ? 'Свернуть' : 'Показать';
    });
    body.hidden = true;
    card.appendChild(toggle);
    card.appendChild(body);
    return card;
  }

  /** Текст объекта приключения для карточки. */
  function kindText(key, item) {
    if (key === 'notes') return String(item.text || '');
    if (key === 'tables') return String(item.description || '');
    if (key === 'items' || key === 'actors') return String(item.type || '');
    return '';
  }

  /**
   * Название объекта. У предметов оно кликабельно: открывает статью на
   * dnd.su в браузере. Если статьи нет, остаётся обычным текстом — клик по
   * никуда не ведущему виду только сбивает с толку.
   * @param {string} name
   * @param {string} section
   * @returns {HTMLElement}
   */
  function renderItemTitle(name, section) {
    const plain = el('div', 'adv-item__title', name);
    if (section !== 'items' && section !== 'actors') return plain;
    const link = el('button', 'adv-item__title adv-item__title--link', name);
    link.type = 'button';
    link.title = 'Открыть описание на dnd.su';
    loadDndItemUrl(name).then((url) => {
      if (!url) {
        // Статьи нет: убираем вид ссылки, чтобы не обещать переход зря.
        link.replaceWith(plain);
        return;
      }
      link.addEventListener('click', () => desktop.openExternal(url));
    });
    return link;
  }

  function makeMoreButton(target, text) {
    const more = el('button', 'adv-item__more', 'Читать целиком');
    more.addEventListener('click', () => {
      const open = target.classList.toggle('is-open');
      target.textContent = open ? text : `${text.slice(0, 220)}…`;
      more.textContent = open ? 'Свернуть' : 'Читать целиком';
    });
    return more;
  }

  /**
   * Кнопка «картинка всем сразу»: одна загрузка, а картинка встаёт на всю группу.
   *
   * Отправку вызывающий код передаёт сам: у фишек это `setTokenGroupImage`,
   * у объектов приключения — `setAdventureGroupImage` с полем `section`. Раньше
   * событие подставлялось здесь же, и для приключения уходило имя секции
   * вместо имени события — сервер такое событие просто не слушает.
   *
   * @param {string} name
   * @param {number} count сколько объектов в группе
   * @param {(name: string, dataUrl: string) => void} send
   * @returns {HTMLElement}
   */
  function makeGroupImageButton(name, count, send) {
    const row = el('label', 'adv-item__row');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.className = 'adv-item__file';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const read = await readImageFile(file);
      if (read.canceled) return;
      if (read.error) return toast(read.error, 'error');
      send(name, read.dataUrl);
      toast(`Картинка «${name}» назначена: ${count} шт.`, 'ok');
    });
    row.appendChild(input);
    row.appendChild(el('span', 'adv-item__filelabel', count > 1
      ? `Картинка всем (${count})`
      : 'Картинка'));
    return row;
  }

  /** Группа фишек: та же группировка и та же массовая картинка. */
  function renderTokenGroup(group) {
    const card = el('article', `adv-item adv-item--group${group.members.length > 1 ? ' is-group' : ''}`);
    const head = el('div', 'adv-group__head');
    head.appendChild(el('div', 'adv-item__title', group.name));
    if (group.members.length > 1) head.appendChild(el('span', 'adv-group__count', `× ${group.members.length}`));
    card.appendChild(head);
    card.appendChild(makeGroupImageButton(group.name, group.members.length, (name, image) => {
      emit('setTokenGroupImage', { name, image });
    }));
    const withImage = group.members.filter((token) => token.imageUrl).length;
    if (group.members.length > 1) {
      card.appendChild(el('div', 'muted adv-item__text',
        `На картах: ${plural(group.members.length, 'фишка', 'фишки', 'фишек')}, с картинкой ${withImage}`));
    }
    return card;
  }

  /**
   * @param {string} kind
   * @param {object} item
   * @returns {HTMLElement}
   */

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

  /**
   * Панель «Приглашение игроков». Единственный способ попасть на стол — P2P-билет
   * iroh, поэтому здесь и только он.
   */
  function renderAddresses() {
    const root = $('#addresses-root');
    if (!root) return;
    root.innerHTML = '';
    const ticket = app.p2p.ticket;

    if (!ticket) {
      // Пока endpoint поднимается, билет просто ещё не готов. Сказать
      // «недоступен» раньше времени значило бы соврать: мастер увидит отказ,
      // которого не было, и решит звать игроков по старой схеме.
      const waiting = app.p2p.failed
        ? 'P2P недоступен: endpoint не поднялся, игроки не смогут войти'
        : 'Билет готовится…';
      root.appendChild(el('div', 'addr-note muted', waiting));
      applyAddressesCollapsed();
      return;
    }

    const block = el('div', 'addr-group');
    block.appendChild(el('div', 'addr-group__title', 'P2P-билет для игроков'));

    const row = el('div', 'addr');
    const info = el('div', 'addr__info');
    // Билет длинный, показываем целиком и разрешаем выделение: игроки вставляют
    // его кнопкой «вставить из буфера», а не переписывают с экрана.
    const code = el('div', 'addr__url addr__url--ticket');
    code.textContent = ticket;
    code.title = 'Нажмите, чтобы скопировать';
    code.addEventListener('click', async () => {
      const ok = await copyText(ticket);
      toast(ok ? 'Билет скопирован' : 'Не удалось скопировать', ok ? 'ok' : 'error');
    });
    info.appendChild(code);
    info.appendChild(el('div', 'addr__meta muted',
      'Скопируйте и отправьте игрокам: они вставляют его в приложении и подключаются напрямую.'));
    row.appendChild(info);
    block.appendChild(row);
    root.appendChild(block);
    applyAddressesCollapsed();
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

    const themeBox = el('div', 'box');
    themeBox.appendChild(el('div', 'box__title', 'Оформление'));
    const themeRow = el('div', 'settings__row');
    const themeSelect = el('select', 'select settings__select');
    themeSelect.dataset.setting = 'theme';
    for (const theme of window.DnDTheme.THEMES) {
      const option = el('option', null, theme.label);
      option.value = theme.id;
      if (theme.id === window.DnDTheme.current()) option.selected = true;
      themeSelect.appendChild(option);
    }
    // Переключаем сразу, без кнопки: палитра видна прямо в окне настроек.
    themeSelect.addEventListener('change', () => window.DnDTheme.apply(themeSelect.value));
    themeRow.appendChild(themeSelect);
    themeBox.appendChild(themeRow);
    themeBox.appendChild(el('div', 'box__note',
      'Тема меняется у вас на этом компьютере. Выбор сохраняется и в окно листа персонажа.'));
    box.appendChild(themeBox);

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

    // Подгонка сетки под карту: мастер говорит, сколько клеток укладывается
    // по ширине, а размер клетки считается от настоящей ширины подложки.
    // Так сетка ровная на любой карте, и фишка всегда занимает ровно клетку.
    const fitRow = el('div', 'settings__row');
    const fitLabel = el('label', 'settings__check');
    const fitInput = el('input', 'input settings__input settings__input--narrow');
    fitInput.type = 'number';
    fitInput.min = '0';
    fitInput.max = String(DnD.GRID.maxColumns);
    fitInput.step = '1';
    fitInput.dataset.setting = 'columns';
    fitInput.value = String(app.room.grid.columns || 0);
    fitInput.disabled = !canManageGrid;
    fitInput.title = '0 — размер клетки задаётся вручную. Например, 20 — двадцать клеток по ширине карты.';
    fitLabel.appendChild(fitInput);
    fitLabel.appendChild(el('span', null, 'клеток по ширине карты (0 — вручную)'));
    fitRow.appendChild(fitLabel);
    tableBox.appendChild(fitRow);

    tableBox.appendChild(el('div', 'box__note', app.training
      ? 'Проверка без сети: сетка и размер клетки — только у вас, других участников здесь нет.'
      : (isDm
        ? 'Клетка ровно по размеру фишки. Сетку и размер видят все участники стола.'
        : 'Сетку на карте и размер клетки задаёт ДМ за столом.')));

    const applyGrid = () => {
      const columns = Math.max(0, Math.min(DnD.GRID.maxColumns, Number(fitInput.value) || 0));
      emit('setGrid', { enabled: gridInput.checked, cell: Number(cellSelect.value), columns });
    };
    gridInput.addEventListener('change', applyGrid);
    cellSelect.addEventListener('change', applyGrid);
    fitInput.addEventListener('change', applyGrid);
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
        const ticket = app.p2p.ticket;
        summary.textContent = ticket
          ? `Игрокам: P2P-билет${app.p2p.peerConnected ? ' · подключено' : ''}`
          : (app.p2p.failed ? 'P2P недоступен' : 'Билет готовится…');
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
      // Адрес стола обязателен для игрока: его главный процесс сервер не
      // запускал, и без адреса окно листа не знает, к чему подключаться.
      url: app.serverUrl || '',
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
      // Портрет в листе мастера показываем, но править не даём: аватар
      // меняет сам игрок, а не мастер.
      sheetView.setAvatarEditable(false);
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
        sheetView.setAvatar(assetUrl(ownAvatarOf(app.viewedSheetPlayerId)), sheetNameOf(app.viewedSheetPlayerId));
        sheetView.setStatus(`Лист игрока ${owner ? owner.name : ''} загружается…`);
        app.sheetShownFor = null;
        requestSheetOnce(app.viewedSheetPlayerId);
        return;
      }
      if (!force && app.sheetShownFor === app.viewedSheetPlayerId) return;
      app.sheetShownFor = app.viewedSheetPlayerId;
      sheetView.setSheet(sheet);
      sheetView.setAvatar(assetUrl(ownAvatarOf(app.viewedSheetPlayerId)), sheetNameOf(app.viewedSheetPlayerId));
      sheetView.setStatus(`Просмотр · ${owner ? owner.name : ''}`);
      return;
    }

    // Игрок видит и редактирует только свой лист.
    sheetView.setMode('sheet');
    sheetView.setReadOnly(false);
    // Свой аватар игрок всегда может поменять: и в настоящем столе, и в
    // тренировочном, где портрет живёт в этом же окне.
    sheetView.setAvatarEditable(true);
    const sheet = app.room.sheets[app.playerId];
    // Аватар обновляем всегда, даже когда лист не перерисовывается: игрок
    // только что сменил портрет, а refreshSheetView зовут без force.
    sheetView.setAvatar(assetUrl(ownAvatar()), (sheet && sheet.characterName) || storedName());
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

  /** Аватар произвольного игрока: он у всех в списке один и тот же. */
  function ownAvatarOf(playerId) {
    const player = app.room.players.find((entry) => entry.playerId === playerId);
    return player ? player.avatar || '' : '';
  }

  /** Имя персонажа игрока — для буквы-заглушки, пока портрета нет. */
  function sheetNameOf(playerId) {
    const player = app.room.players.find((entry) => entry.playerId === playerId);
    return (app.room.sheets[playerId] && app.room.sheets[playerId].characterName)
      || (player ? player.name : '');
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
    // Пока справочник был закрыт, его данные могли устареть. Догоняем один
    // раз — при открытии вкладки, а не на каждое событие фишки.
    if (name === 'adventure' && adventurePanelStale) renderAdventurePanel({ force: true });
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

    $('#join-name').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') doJoinP2p();
    });
    // P2P-подключение живёт на экране подключения: билет всегда приходит от
    // мастера, поэтому отдельная кнопка на главном экране была лишней.
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

  /**
   * Экран подключения: игрок вставляет P2P-билет мастера.
   */
  function openJoinScreen() {
    $('#join-name').value = storedName();
    $('#join-p2p-ticket').value = '';
    setStatus('#join-status', '');
    showScreen('screen-join');
    $('#join-p2p-ticket').focus();
  }

  /**
   * Подключение к столу мастера по P2P-билету (iroh). Билет мастер копирует из
   * панели «Приглашение игроков». Здесь мы поднимаем локальный TCP-туннель и
   * направляем socket.io на 127.0.0.1:<локальный порт>.
   */
  async function doJoinP2p() {
    const ticket = $('#join-p2p-ticket').value.trim();
    const name = $('#join-name').value.trim();
    if (!ticket) return setStatus('#join-status', 'Вставьте P2P-билет, который дал мастер', 'error');
    if (!name) return setStatus('#join-status', 'Введите имя', 'error');
    if (!desktop || !desktop.irohTunnelClient) {
      return setStatus('#join-status', 'P2P недоступен в этом приложении', 'error');
    }

    setStatus('#join-status', 'Соединяемся по P2P…');
    let result;
    try {
      result = await desktop.irohTunnelClient(ticket);
    } catch (error) {
      return setStatus('#join-status', `P2P не удалось: ${error.message}`, 'error');
    }
    if (!result || !result.ok) {
      return setStatus('#join-status', `P2P не удалось: ${(result && result.error) || 'неизвестная ошибка'}`, 'error');
    }

    const url = `http://127.0.0.1:${result.localPort}`;
    localStorage.setItem(PLAYER_NAME_KEY, name.slice(0, DnD.LIMITS.maxNameLength));
    prepareTableUi();
    showScreen('screen-table');
    app.role = 'player';
    app.p2p.ticket = ticket;
    app.p2p.tunnelPort = result.localPort;
    updateRoleUi();
    connect({ url, name: name.slice(0, DnD.LIMITS.maxNameLength), playerId: localPlayerId(), p2p: true, keepP2p: true });
  }

  /* ------------------------------------------------------------------ *
   * Импорт внешнего приключения
   * ------------------------------------------------------------------ */

  /** Кэш предпросмотра: между показом и применением файл перечитывать незачем. */
  let adventurePreview = null;
  let adventureFilePath = '';
  /** Содержимое справочника устарело, пока вкладка была закрыта. */
  let adventurePanelStale = false;
  /** Отложенный пересбор разделов при поиске. */
  let adventureSearchTimer = null;

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
