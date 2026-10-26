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
  const PLAYER_KEY_KEY = 'dnd-table.playerKey';
  const PLAYER_NAME_KEY = 'dnd-table.playerName';
  const ADDRESSES_COLLAPSED_KEY = 'dnd-table.addressesCollapsed';
  const LEFT_COLLAPSED_KEY = 'dnd-table.leftPanelCollapsed';
  const RIGHT_COLLAPSED_KEY = 'dnd-table.rightPanelCollapsed';
  /** Какая вкладка правой колонки была открыта в прошлый раз. */
  const ACTIVE_TAB_KEY = 'dnd-table.activeTab';
  /** Свёрнутые разделы левой колонки: массив ключей в localStorage. */
  const COLLAPSED_PANELS_KEY = 'dnd-table.collapsedPanels';
  /** Интервал автосохранения кампании в секундах: выбор мастера. */
  const AUTOSAVE_KEY = 'dnd-table.autosaveSeconds';
  const AUTOSAVE_DEFAULT_SECONDS = 60;
  const AUTOSAVE_CHOICES = [15, 30, 60, 300];
  /** Раздел настроек, открытый в прошлый раз. */
  const SETTINGS_SECTION_KEY = 'dnd-table.settingsSection';
  /** Ширина правой колонки в пикселях: её тянут мышью, а результат переживает
   *  перезапуск, иначе пришлось бы подстраивать её заново каждую партию. */
  const RIGHT_WIDTH_KEY = 'dnd-table.rightWidth';
  const RIGHT_WIDTH_MIN = 300;
  const RIGHT_WIDTH_MAX = 760;
  const RIGHT_HEIGHT_MIN = 150;
  const RIGHT_HEIGHT_MAX = 720;
  /** Где стоит панель вкладок: сбоку у карты или под ней. */
  const RIGHT_PANEL_POS_KEY = 'dnd-table.rightPanelPos';
  /** Высота панели, когда она стоит под картой. */
  const RIGHT_HEIGHT_KEY = 'dnd-table.rightHeight';

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
    /** Запрос поиска по чату: переживает переподключение вместе со снимком. */
    chatQuery: '',
    /** Справочник импортированного приключения; приходит только мастеру. */
    adventure: null,
    room: {
      players: [],
      sheets: {},
      maps: normalizeMapSlots(null),
      activeMap: null,
grid: { enabled: false, cell: 46, columns: 0, feetPerCell: DnD.GRID.defaultFeetPerCell, offsetX: 0, offsetY: 0 },
      tokens: [],
      initiative: { entries: [], turnId: null, round: 1 },
      combat: { enabled: false },
      diceHistory: [],
      chatHistory: [],
      journal: '',
      journalEntries: [],
      inventory: [],
      inventoryCoins: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
      rollRequests: []
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
let initiativePanel = null;
let surfacePanel = null;
/** Какая запись журнала открыта на правку: null, 'new' или id записи. */
let journalEditingId = null;
/** Поиск по журналу живёт в окне: серверу он не нужен. */
let journalQuery = '';
/** Какой предмет склада открыт на правку: null, 'new' или id предмета. */
let inventoryEditingId = null;
/**
 * Поводы для реакций: противник может атаковать по возможности. Карточки живут
 * только у мастера и только в этом окне: это подсказка, а не состояние стола.
 */
let reactionPrompts = [];
let reactionPromptSeq = 0;
/**
 * Редактор листа на экране подготовки. Лист сохраняется в библиотеку сам, при
 * правке поля, поэтому сохранять его нужно помнить только между открытиями.
 */
let sheetEditorView = null;
/** @type {string|null} Какой лист правится: null — новый лист. */
let sheetEditorId = null;
/** Куда возвращаться из редактора: на главный экран или к подключению. */
let sheetEditorReturn = 'screen-home';
/** Какой лист выбран на экране подключения: он уедет на стол один раз. */
let chosenSheetId = null;

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
    // Больше четырёх плашек одновременно закрывали бы стол; старые уходят
    // раньше своего срока, но остаются в истории чата, если это важно.
    while (root.children.length >= 4) root.firstElementChild.remove();
    const node = el('div', `toast toast--${kind}`, message);
    root.appendChild(node);
    setTimeout(() => {
      node.classList.add('is-out');
      setTimeout(() => node.remove(), 300);
    }, timeout);
  }

  /**
   * Крупный результат приватного броска мастера.
   *
   * Бросок из статблока не должен светиться в чате: игроки не видят ни
   * формулу, ни число. Мастеру же нужно увидеть итог сразу, поэтому он
   * приходит отдельной карточкой поверх стола и гаснет сам.
   * @param {object} roll
   */
  function showDmRoll(roll) {
    let box = document.getElementById('dm-roll');
    if (!box) {
      box = el('div', 'dm-roll');
      box.id = 'dm-roll';
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      box.hidden = true;
      const body = el('div', 'dm-roll__body');
      body.appendChild(el('div', 'dm-roll__label'));
      const line = el('div', 'dm-roll__line');
      line.appendChild(el('strong', 'dm-roll__result'));
      line.appendChild(el('span', 'dm-roll__formula'));
      body.appendChild(line);
      body.appendChild(el('div', 'dm-roll__verdict'));
      const close = el('button', 'dm-roll__close', '×');
      close.type = 'button';
      close.title = 'Скрыть';
      close.setAttribute('aria-label', 'Скрыть результат броска');
      close.addEventListener('click', () => { box.hidden = true; });
      box.appendChild(body);
      box.appendChild(close);
      document.body.appendChild(box);
    }
    const label = box.querySelector('.dm-roll__label');
    const result = box.querySelector('.dm-roll__result');
    const formula = box.querySelector('.dm-roll__formula');
    const verdict = box.querySelector('.dm-roll__verdict');
    label.textContent = roll.label || 'Бросок мастера';
    result.textContent = String(roll.result ?? '');
    formula.textContent = roll.formula || '';
    verdict.hidden = roll.hit !== true && roll.hit !== false;
    verdict.textContent = roll.hit === true
      ? `попадание по КД ${roll.targetAc}`
      : roll.hit === false ? `промах по КД ${roll.targetAc}` : '';
    box.classList.toggle('is-hit', roll.hit === true);
    box.classList.toggle('is-miss', roll.hit === false);
    box.hidden = false;
    clearTimeout(showDmRoll.timer);
    showDmRoll.timer = setTimeout(() => { box.hidden = true; }, 9000);
  }

  /**
   * Запирает Tab внутри окна и возвращает фокус на прежнее место.
   * Без этого Tab уходил бы в панель под модалкой, а после закрытия фокус
   * терялся бы в начале страницы.
   * @param {HTMLElement} box
   * @returns {() => void} отпустить: снять слушатель и вернуть фокус
   */
  function trapFocus(box) {
    const previous = document.activeElement;
    const focusables = () => [...box.querySelectorAll(
      'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
    )].filter((node) => !node.disabled && node.getClientRects().length > 0);
    const onKey = (event) => {
      if (event.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
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
      const titleId = `modal-title-${Date.now()}`;
      const title = el('div', 'modal__title', options.title || 'Подтвердите действие');
      title.id = titleId;
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-labelledby', titleId);
      box.appendChild(title);
      if (options.message) box.appendChild(el('div', 'modal__text', options.message));
      const release = trapFocus(box);

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
        release();
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
      else confirm.focus();
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
    // Атмосфера звучит только на главном экране. Уходя в стол или лист,
    // гасим её, чтобы звук не спорил с броском кубика и разговором.
    if (window.DnDSound) window.DnDSound.setScene(id === 'screen-home' ? 'home' : '');
    // На главном экране игра не идёт: Discord не должен показывать старую сессию.
    if (id === 'screen-home') syncPresence();
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

  /** Показывать ли игру в Discord: личная настройка, в кампанию не входит. */
  const PRESENCE_KEY = 'dnd-table.discordPresence';

  function presenceEnabled() {
    return localStorage.getItem(PRESENCE_KEY) === '1';
  }

  /**
   * Состояние для Discord. Наружу уходят только роль, кампания, имя персонажа
   * и счётчик игроков: карта, чат, журнал и билет остаются на столе.
   */
  function presenceState() {
    if (!presenceEnabled() || app.training || !app.role) return { enabled: false };
    if (app.role === 'dm') {
      const players = (app.room.players || []).filter((player) => player.role !== 'dm').length;
      return {
        enabled: true,
        mode: 'dm',
        campaignName: app.campaign ? app.campaign.name : '',
        playerCount: players
      };
    }
    const sheet = app.room.sheets ? app.room.sheets[app.playerId] : null;
    const me = (app.room.players || []).find((player) => player.playerId === app.playerId);
    return {
      enabled: true,
      mode: 'player',
      characterName: sheet && sheet.characterName,
      playerName: me && me.name
    };
  }

  /** Обновляет присутствие. Discord может быть не запущен: ошибок не показываем. */
  function syncPresence() {
    if (!desktop || typeof desktop.setPresence !== 'function') return;
    if (desktop.isAndroid) return;
    try {
      const result = desktop.setPresence(presenceState());
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      /* присутствие не должно ломать стол */
    }
  }

  /**
   * Секрет личности, выданный столом при входе. Вместе с идентификатором он
   * доказывает, что за стол вернулся тот же игрок, а не чужой клиент с его
   * кодом. Пустая строка значит «секрета ещё нет»: стол выдаст его при входе.
   */
  function storedPlayerKey() {
    try {
      return localStorage.getItem(PLAYER_KEY_KEY) || '';
    } catch (err) {
      return '';
    }
  }

  /**
   * Меняет своё имя у стола.
   *
   * Имя живёт в двух местах: оно хранится на этом компьютере (чтобы стол
   * снова поднять с тем же именем) и уходит на сервер, где видят все. Пустое
   * имя не принимаем: «Мастер» и «Игрок» спасают только молчание, а человек,
   * который стёр поле, явно хочет что-то сказать.
   * @param {string} value
   * @returns {boolean} Принято ли имя.
   */
  function applyMyName(value) {
    const name = String(value || '').replace(/\s+/g, ' ').trim().slice(0, DnD.LIMITS.maxNameLength);
    if (!name) {
      toast('Имя не может быть пустым', 'error');
      return false;
    }
    localStorage.setItem(PLAYER_NAME_KEY, name);
    if (app.socket && app.connected) emit('setPlayerName', { name });
    return true;
  }

  /**
   * Окно смены имени: тот же вопрос, что задают игроку на экране подключения,
   * только за столом.
   */
  async function askMyName() {
    const value = await modal({
      title: 'Как вас зовут у стола',
      message: 'Имя видят все за столом: оно стоит в списке участников и в чате.',
      input: {
        value: storedName(),
        maxLength: DnD.LIMITS.maxNameLength,
        placeholder: app.role === 'dm' ? 'Например, «Артём»' : 'Например, «Мира»'
      },
      confirmLabel: 'Сохранить'
    });
    if (value) applyMyName(value);
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

  /**
   * Боевые числа из листа игрока: КД и бонус первой атаки.
   *
   * У фишки игрока нет своих КД и бонуса: лист — единственный источник, иначе
   * за столом появляются два разных числа и мастер правит не то.
   * @param {string} playerId
   * @returns {{armorClass: number|null, attackBonus: number|null}}
   */
  function sheetCombatStats(playerId) {
    const sheet = playerId && app.room && app.room.sheets
      ? app.room.sheets[playerId]
      : null;
    if (!sheet) return { armorClass: null, attackBonus: null };
    const ac = Number(sheet.armorClass);
    const attack = Array.isArray(sheet.attackList) && sheet.attackList[0]
      ? Number(sheet.attackList[0].bonus)
      : NaN;
    return {
      armorClass: Number.isFinite(ac) && ac > 0 ? Math.round(ac) : null,
      attackBonus: Number.isFinite(attack) ? Math.round(attack) : null
    };
  }

  function emit(event, payload) {
    if (!app.socket || !app.connected) {
      toast('Нет соединения со столом', 'error');
      return false;
    }
    app.socket.emit(event, payload);
    return true;
  }

  /** То же, но ждёт ответ сервера: нужно там, где важен созданный объект. */
  function emitAck(event, payload) {
    return new Promise((resolve) => {
      if (!app.socket || !app.connected) {
        toast('Нет соединения со столом', 'error');
        resolve(null);
        return;
      }
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result || null);
      };
      setTimeout(() => done(null), 8000);
      app.socket.emit(event, payload, done);
    });
  }

  /**
   * Хендаут в чат: картинка сохраняется в папку кампании, в ленте остаётся URL.
   * Текст из поля ввода идёт подписью, поэтому его не нужно вводить заново.
   */
  async function uploadChatImage(file, text) {
    const read = await readImageFile(file);
    if (read.canceled) return false;
    if (read.error) {
      toast(read.error, 'error');
      return false;
    }
    return emit('chatImage', { image: read.dataUrl, text: text || '' });
  }

  /** Очистка ленты: спрашиваем подтверждение, история не восстанавливается. */
  async function confirmClearChat() {
    if (app.role !== 'dm' || app.training) return;
    const answer = await modal({
      title: 'Очистить чат?',
      message: 'Все сообщения и броски исчезнут из ленты у всех участников. Картинки из чата удалятся вместе с ними при следующем сохранении.',
      confirmLabel: 'Очистить',
      danger: true
    });
    if (answer) emit('clearChat', {});
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

  /** Снимок стола в форму, с которой работает окно. */
  function roomFromState(state) {
    return {
      players: state.players || [],
      sheets: state.sheets || {},
      maps: normalizeMapSlots(state.maps),
      activeMap: state.activeMap || null,
      activeMapId: state.activeMapId || null,
      grid: state.grid || { enabled: false, cell: DnD.GRID.defaultCell, columns: 0 },
      // Часы стола: старые кампании приходят без поля, и стол начинает с утра.
      gameTime: state.gameTime || { day: 1, hour: 8 },
      tokens: state.tokens || [],
      initiative: state.initiative || { entries: [], turnId: null, round: 1 },
      // Режим боя приходит в снимке состояния. Без него при переподключении
      // окно считало бой выключенным, хотя на столе он шёл: кнопка «Бой»
      // показывала «выкл», нажатие слало «включить», сервер видел то же
      // самое значение и молчал, и кнопка выглядела сломанной.
      combat: state.combat || { enabled: false },
      diceHistory: state.diceHistory || [],
      chatHistory: state.chatHistory || [],
      journal: state.journal || '',
      journalEntries: state.journalEntries || [],
      inventory: state.inventory || [],
      inventoryCoins: state.inventoryCoins || { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
      rollRequests: state.rollRequests || [],
      // Поводы для реакций приходят снимком: после переподключения карточка
      // должна быть на месте, а не жить только в памяти старого окна.
      reactions: state.reactions || []
    };
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
    // Интервал автосохранения хранится в localStorage, а таймер живёт в main:
    // передаём выбор при каждом запуске, иначе он вернулся бы к минуте.
    if (typeof desktop.setAutosaveInterval === 'function') {
      desktop.setAutosaveInterval(autosaveSeconds());
    }
    const dirNode = $('#home-datadir');
    // Путь к папке — техническая деталь и живёт в настройках. На главном
    // экране достаточно сказать, где лежат данные.
    dirNode.textContent = app.config.portable
      ? 'Данные: портативный режим, рядом с игрой'
      : 'Данные: профиль Windows';
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
  function connect({ url, name, playerId, playerKey, hostKey, expectRole, local = false, p2p = false, keepP2p = false }) {
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
      // Личность пробуем вернуть свою: тот же код и секрет, что стол выдал
      // в прошлый раз. Если секрет не подошёл, стол попросит войти заново, и
      // мы один раз берём новый код, чтобы человек не застрял на входе.
      let attemptId = playerId;
      let attemptKey = playerKey !== undefined ? playerKey : storedPlayerKey();
      const join = (isRetry) => {
        socket.emit('joinRoom', { name, playerId: attemptId, playerKey: attemptKey, hostKey }, (response) => {
          if (response && !response.ok && response.code === 'identity-denied' && !isRetry) {
            try {
              localStorage.removeItem(PLAYER_ID_KEY);
              localStorage.removeItem(PLAYER_KEY_KEY);
            } catch (err) { /* хранилище недоступно: просто входим новым кодом */ }
            attemptId = localPlayerId();
            attemptKey = '';
            toast('Код игрока занят: вы вошли под новым кодом, лист придётся выбрать заново.', 'error');
            join(true);
            return;
          }
          if (!response || !response.ok) {
            const message = (response && response.error) || 'Сервер отклонил подключение';
            setStatus('#join-status', message, 'error');
            toast(message, 'error');
            socket.disconnect();
          }
        });
      };
      join(false);
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
      app.room = roomFromState(state);
      app.campaign = state.campaign || app.campaign;
      // Приключение приходит только мастеру; игроку сервер шлёт null.
      app.adventure = state.adventure || null;
      // Тренировочный стол — не настоящая игра: адрес и имя в нём запоминать
      // нечего, иначе они подменят данные игрока за настоящим столом.
      if (app.role === 'player' && !app.training) {
        localStorage.setItem(PLAYER_ID_KEY, app.playerId);
        if (you.playerKey) localStorage.setItem(PLAYER_KEY_KEY, you.playerKey);
        localStorage.setItem(PLAYER_NAME_KEY, you.name);
      }
      setStatus('#join-status', '');
      showScreen('screen-table');
      prepareTableUi();
      syncReactionPrompts(state.reactions);
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
      syncPresence();
    });

    // Сервер сам присылает свежий снимок, когда состояние меняется целиком
    // (например, после импорта приключения). Собираем его тем же помощником,
    // что и при входе, иначе окно осталось бы со старыми данными.
    socket.on('stateReload', (state) => {
      app.room = roomFromState(state);
      app.adventure = state.adventure || null;
      syncReactionPrompts(state.reactions);
      renderAll();
      updateConnBadge(true);
    });

    // Записи журнала приходят только мастеру. Окно журнала в отдельной вкладке
    // шлёт сохранение и получает свежий список этим же событием.
    socket.on('journalUpdated', (entries) => {
      app.room.journalEntries = Array.isArray(entries) ? entries : [];
      renderJournalPanel();
    });

    // Склад и просьбы о бросках приходят всем: игроки их только читают.
    socket.on('inventoryUpdated', (items) => {
      app.room.inventory = Array.isArray(items) ? items : [];
      renderInventoryPanel();
    });

    socket.on('inventoryCoinsUpdated', (coins) => {
      app.room.inventoryCoins = coins || { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
      renderInventoryPanel();
    });

    socket.on('rollRequestUpdated', (requests) => {
      app.room.rollRequests = Array.isArray(requests) ? requests : [];
      renderRollRequests();
    });

    /* --- события стола --- */
    socket.on('playersUpdate', (players) => {
      app.room.players = players || [];
      playersList.render(app.room.players, viewer());
      playersList.renderSelfAvatar({ avatarUrl: ownAvatarOf('dm'), name: dmName() });
      tokenPanel.render(app.room.tokens, app.room.players, viewer());
      // Новый игрок должен сразу появиться в списке адресатов шёпота.
      if (chatPanel) chatPanel.syncWhisperTargets();
      // Список выбора в панели боя собран из игроков и фишек: новый участник
      // должен появиться в нём сразу.
      renderInitiativePanel();
      // Игроки влияют только на подписи и владельцев фишек, карта и слои не
      // меняются. Полная перерисовка карты тут пересобирала бы туман и свет
      // на каждое подключение или смену портрета.
      mapView.refreshTokens(app.room, viewer());
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
      syncPresence();
    });

    socket.on('characterSheetData', ({ playerId, sheet }) => {
      app.room.sheets[playerId] = sheet;
      requestedSheets.delete(playerId);
      if (app.role === 'player' && playerId === app.playerId) {
        markSheetSaved();
        syncPresence();
      }
      refreshSheetView(app.role === 'dm' && app.viewedSheetPlayerId === playerId);
    });

    socket.on('characterSheetUpdated', ({ playerId, sheet }) => {
      app.room.sheets[playerId] = sheet;
      // Если ДМ сейчас смотрит этот лист — обновляем его на лету.
      if (app.role === 'dm' && app.viewedSheetPlayerId === playerId) refreshSheetView(true);
    });

    socket.on('mapUpdated', ({ type, items, activeId, activeMap, activeMapId }) => {
      // Карты вкладки приходят списком: ДМ может держать во вкладке несколько
      // локаций и переключаться между ними, ничего не теряя. Игроку сервер
      // присылает только показанные карты, поэтому скрытая заготовка сюда не
      // попадает даже ссылкой на картинку.
      app.room.maps[type] = {
        items: Array.isArray(items) ? items : [],
        activeId: activeId || null
      };
      app.room.activeMap = activeMap;
      app.room.activeMapId = activeMapId || null;
      mapView.render(app.room, viewer());
      // Панель поверхности считает клетки по карте, а карта меняется и после
      // мазка, и после чужой правки: без пересчёта счётчик и кнопка очистки
      // говорили бы о пустой карте, на которой стоит лужа.
      renderSurfacePanel();
    });

    socket.on('gridUpdated', (grid) => {
      app.room.grid = grid;
      mapView.render(app.room, viewer());
      syncSettingsGrid();
    });

    socket.on('gameTimeUpdated', (time) => {
      app.room.gameTime = time || { day: 1, hour: 8 };
      renderGameTime();
    });

    socket.on('tokenCreated', (token) => {
      // Фишка могла уже быть в списке: при показе скрытой мастер получает и
      // tokenHidden, и tokenCreated — как «новую». Без проверки она попала бы
      // в список вторым экземпляром, и в панели фишек появился бы дубль.
      const index = app.room.tokens.findIndex((item) => item.id === token.id);
      if (index >= 0) app.room.tokens[index] = token;
      else app.room.tokens.push(token);
      mapView.refreshTokens(app.room, viewer());
      tokenPanel.render(app.room.tokens, app.room.players, viewer());
      // Список выбора в порядке боя наполняется фишками: без перерисовки новая
      // фишка появлялась бы там только после следующего события.
      renderInitiativePanel();
    });

    socket.on('tokenUpdated', (token) => {
      const index = app.room.tokens.findIndex((item) => item.id === token.id);
      if (index >= 0) app.room.tokens[index] = token;
      else app.room.tokens.push(token);
      mapView.refreshTokens(app.room, viewer());
      tokenPanel.render(app.room.tokens, app.room.players, viewer());
      renderInitiativePanel();
    });

    // Массовая картинка приходит пачкой: перерисовываем всё один раз, а не
    // по разу на каждую фишку.
    socket.on('tokensUpdated', ({ tokens } = {}) => {
      if (!Array.isArray(tokens) || !tokens.length) return;
      const byId = new Map(app.room.tokens.map((token) => [token.id, token]));
      for (const token of tokens) byId.set(token.id, token);
      app.room.tokens = [...byId.values()];
      mapView.refreshTokens(app.room, viewer());
      tokenPanel.render(app.room.tokens, app.room.players, viewer());
      renderInitiativePanel();
    });

    // Массовая картинка в справочнике: сервер присылает обновлённое приключение,
    // потому что пришёл копией, а не дельтой по одному объекту.
    socket.on('adventureUpdated', (adventure) => {
      app.adventure = adventure || null;
      renderAdventurePanel();
    });

    socket.on('tokenMoved', ({ tokenId, x, y, final, from }) => {
      mapView.applyTokenMove(tokenId, x, y, { final, from });
    });

    // Мастер передал игроку повод для реакции: его фишка покинула досягаемость
    // врага, и теперь бросает сам игрок, а не мастер за него.
    socket.on('reactionPrompt', (prompt = {}) => {
      addReactionPrompt(
        { name: prompt.attackerName },
        { name: prompt.targetName },
        {
          id: prompt.id,
          playerId: prompt.playerId,
          bonus: prompt.bonus,
          targetAc: prompt.targetAc
        }
      );
    });

    // Карточка снята у всех, кто её видел: игрок бросил, отказался или раунд
    // закончился. Без этого она висела бы до перезагрузки.
    socket.on('reactionResolved', ({ id } = {}) => {
      removeReactionPrompt(id);
    });

    // Пинг живёт пару секунд и никуда не сохраняется: это жест, а не объект.
    socket.on('mapPing', (ping) => {
      mapView.showPing(ping);
    });

    socket.on('tokenDeleted', ({ tokenId }) => {
      app.room.tokens = app.room.tokens.filter((token) => token.id !== tokenId);
      mapView.refreshTokens(app.room, viewer());
      tokenPanel.render(app.room.tokens, app.room.players, viewer());
      renderInitiativePanel();
      // В справочнике есть раздел «Фишки»: без перерисовки удалённая фишка
      // оставалась бы в нём до переключения вкладки.
      if (app.role === 'dm') renderAdventurePanel();
    });

    /**
     * Фишка скрыта или показана.
     *
     * Скрытие приходит игрокам: у них такая фишка была на карте, её надо убрать.
     * А показ приходит только мастеру, потому что игрокам эта фишка не знакома:
     * для них сервер следом присылает её как tokenCreated.
     */
    socket.on('tokenHidden', ({ tokenId, hidden } = {}) => {
      const token = app.room.tokens.find((item) => item.id === tokenId);
      if (!token) return;
      token.hidden = Boolean(hidden);
      mapView.refreshTokens(app.room, viewer());
      tokenPanel.render(app.room.tokens, app.room.players, viewer());
    });

    // Заметка мастера может прийти из другого окна или после переподключения:
      // список перерисовывается, и пометка «заметка есть» должна обновиться.
      socket.on('dmNoteUpdated', ({ playerId, note } = {}) => {
        const player = app.room.players.find((item) => item.playerId === playerId);
        if (!player) return;
        player.dmNote = note || '';
        playersList.render(app.room.players, viewer());
      });

    // Порядок боя приходит и снимком, и отдельным событием: мастер меняет его
    // кнопками, игроки получают рассылку. Рисуем одним и тем же.
    socket.on('initiativeUpdated', (initiative) => {
      const previousRound = app.room.initiative && app.room.initiative.round;
      app.room.initiative = initiative || { entries: [], turnId: null, round: 1 };
      // Новый раунд: поводы прошлого больше не действуют. Сервер их уже
      // вычистил, окно делает то же самое без отдельного события.
      if (previousRound && app.room.initiative.round !== previousRound) {
        syncReactionPrompts([]);
      }
      renderInitiativePanel();
    });

    // Режим боя приходит отдельным событием: мастер щёлкнул переключателем или
    // бой начался сам после броска инициативы.
    socket.on('combatMode', (combat) => {
      const wasEnabled = Boolean(app.room.combat && app.room.combat.enabled);
      app.room.combat = combat || { enabled: false };
      // Режим боя меняет только кнопку карты и поведение фишек. Полный
      // renderAll пересобирал бы чат, историю бросков и лист персонажа,
      // которые от боя не зависят.
      mapView.refreshCombat(app.room, viewer());
      // Сразу говорим, что делать дальше: без подсказки включённый режим боя
      // выглядит как пустая кнопка, потому что сам по себе он ничего не меняет.
      if (app.room.combat.enabled && !wasEnabled) {
        toast('Ход по клеткам: нажмите на фишку, потом на клетку');
      }
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

    socket.on('dmRollResult', (roll) => showDmRoll(roll));

    socket.on('chatMessage', (message) => {
      app.room.chatHistory.push(message);
      if (app.room.chatHistory.length > HISTORY_LIMITS.chat) {
        app.room.chatHistory.splice(0, app.room.chatHistory.length - HISTORY_LIMITS.chat);
      }
      chatPanel.append(message);
    });

    socket.on('chatDeleted', ({ id }) => {
      const index = app.room.chatHistory.findIndex((message) => message.id === id);
      if (index >= 0) app.room.chatHistory.splice(index, 1);
      if (chatPanel) chatPanel.removeMessage(id);
    });

    socket.on('chatCleared', () => {
      app.room.chatHistory = [];
      if (chatPanel) chatPanel.renderAll([], app.chatQuery);
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
    // Ход по клеткам и перетаскивание живут вне сокета: их таймеры иначе
    // продолжали бы дёргать emit уже без стола.
    if (mapView) mapView.cancelPending();
    // Поводы для реакций относятся к прошлому столу: в новом они только путали бы.
    reactionPrompts = [];
    renderReactionPrompts();
    app.socket = null;
    app.connected = false;
    app.role = null;
    app.playerId = null;
    syncPresence();
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
    // Успешный P2P ничего не добавляет к «на связи»: две зелёные плашки
    // подряд только шумят. Показываем P2P, лишь когда он ещё поднимается
    // или не смог подключиться.
    badge.hidden = !isRunning || isConnected;
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
        onSetActive: (type, mapId) => emit('setActiveMap', { type, mapId }),
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
        onMoveToken: (tokenId, x, y, meta) => emit('moveToken', { tokenId, x, y, ...(meta || {}) }),
        // Атака по возможности: карту ведёт мастер, поэтому и реакцию считает
        // его окно — только оно видит все фишки и размер клетки. Реакцию
        // союзной фишки отправляем её игроку, чтобы он бросил сам.
        onOpportunityAttack: ({ attacker, target, playerId }) => {
          if (!attacker || !target) return;
          const targetSheet = target.assignedPlayerId
            ? sheetCombatStats(target.assignedPlayerId)
            : null;
          const attackerSheet = attacker.assignedPlayerId
            ? sheetCombatStats(attacker.assignedPlayerId)
            : null;
          // У фишки игрока КД всегда из листа; у монстра — из самого токена.
          const tokenAc = Number(target.armorClass) > 0
            ? Math.round(Number(target.armorClass))
            : null;
          const targetAc = (targetSheet && targetSheet.armorClass) || tokenAc;
          // Бонус игрока — из первой атаки листа, у монстра — из фишки.
          const bonus = attackerSheet && attackerSheet.attackBonus !== null
            ? attackerSheet.attackBonus
            : (Number(attacker.attackBonus) || 0);
          if (playerId) {
            emit('reactionPrompt', {
              playerId,
              attackerName: attacker.name,
              targetName: target.name,
              bonus,
              targetAc
            });
            return;
          }
          addReactionPrompt(attacker, target, { bonus, targetAc });
        },
        // Пинг: короткий жест «смотрите сюда». Сервер не хранит его в кампании.
        onPing: (mapType, mapId, x, y) => emit('mapPing', { mapType, mapId, x, y }),
        // Перенос фишки на карту, которую уже видят игроки: мастер готовит
        // следующую сцену и в нужный момент переводит на неё участников.
        onMoveTokenToActive: (tokenId) => emit('moveTokenToActiveMap', { tokenId }),
        onDropActor: (name, x, y) => dropAdventureActor(name, x, y),
        onNotice: (message) => toast(message),
        onToggleGrid: (enabled) => emit('setGrid', {
          enabled,
          cell: app.room.grid.cell,
          columns: app.room.grid.columns || 0,
          feetPerCell: app.room.grid.feetPerCell || DnD.GRID.defaultFeetPerCell,
          offsetX: app.room.grid.offsetX || 0,
          offsetY: app.room.grid.offsetY || 0
        }),
        // Быстрая настройка сетки за столом шлёт те же поля, что и окно настроек.
        onSetGrid: (grid) => emit('setGrid', grid),
        // Режим боя: ход по клеткам. Включает мастер, сервер проверяет.
        onSetCombatMode: (enabled) => emit('setCombatMode', { enabled }),
        onRenameToken: renameToken,
        onAssignToken: (tokenId, playerId) => emit('assignTokenToPlayer', { tokenId, playerId }),
        onSetTokenSide: (tokenId, side) => emit('setTokenSide', { tokenId, side }),
        onSetTokenAttackBonus: (tokenId, attackBonus) => emit('setTokenAttackBonus', { tokenId, attackBonus }),
        onSetTokenArmorClass: (tokenId, armorClass) => emit('setTokenArmorClass', { tokenId, armorClass }),
        // Меню фишки показывает боевые числа игрока из его листа, а не из токена.
        onSheetStats: sheetCombatStats,
        onDeleteToken: (tokenId) => emit('deleteToken', { tokenId }),
        // Туман войны: карта уезжает на сервер целиком, маской на месте.
        onOpenMapFog: (type, mapId, x, y, radius) => emit('openMapFog', { type, mapId, x, y, radius }),
        onSetMapFog: (type, mapId, open) => emit('setMapFog', { type, mapId, open }),
        onSetMapFogFollow: (type, mapId, follow) => emit('setMapFogFollow', { type, mapId, follow }),
        // Освещение: правка только мастерская, сервер проверяет это сам.
        onSetMapDarkness: (type, mapId, darkness) => emit('setMapDarkness', { type, mapId, darkness }),
        onAddMapWall: (type, mapId, wall) => emit('addMapWall', {
          type, mapId, wallId: wall.id, x1: wall.x1, y1: wall.y1, x2: wall.x2, y2: wall.y2
        }),
        onDeleteMapWall: (type, mapId, wallId) => emit('deleteMapWall', { type, mapId, wallId }),
        onClearMapWalls: (type, mapId) => emit('clearMapWalls', { type, mapId }),
        onAddMapTemplate: (type, mapId, template) => emit('addMapTemplate', {
          type,
          mapId,
          templateId: template.id,
          kind: template.kind,
          x: template.x,
          y: template.y,
          size: template.size,
          rotation: template.rotation,
          color: template.color
        }),
        onDeleteMapTemplate: (type, mapId, templateId) => emit('deleteMapTemplate', { type, mapId, templateId }),
        onClearMapTemplates: (type, mapId) => emit('clearMapTemplates', { type, mapId }),
        onAddMapLight: (type, mapId, light) => emit('addMapLight', {
          type,
          mapId,
          lightId: light.id,
          x: light.x,
          y: light.y,
          radius: light.radius,
          color: light.color,
          // Тусклость нового источника: без неё сервер поставил бы яркий свет,
          // и только что поставленная заготовка стала бы видна всем сразу.
          dim: Boolean(light.dim)
        }),
        onSetMapLight: (type, mapId, lightId, patch) => emit('setMapLight', { type, mapId, lightId, ...patch }),
        onDeleteMapLight: (type, mapId, lightId) => emit('deleteMapLight', { type, mapId, lightId }),
        // Поверхность карты: мазок уходит по отпусканию мыши, пачкой клеток.
        onPaintSurface: (type, mapId, cells) => emit('paintMapSurface', { type, mapId, cells }),
        // Тот же спавн, что и в панели участников: одно действие на оба места.
        onSpawnFromSheet: spawnTokenFromSheet,
        // Скрытость решает только мастер, но сервер всё равно проверяет.
        onToggleTokenHidden: (tokenId, hidden) => emit('setTokenHidden', { tokenId, hidden }),
        onToggleTokenNameHidden: (tokenId, hidden) => emit('setTokenNameHidden', { tokenId, hidden }),
        onToggleTokenLabelsHidden: (tokenId, hidden) => emit('setTokenLabelsHidden', { tokenId, hidden }),
        onSetAllTokensHidden: (hidden, side) => emit('setAllTokensHidden', { hidden, side }),
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
        onSpawnToken: spawnTokenFromSheet,
        // Заметку мастера сервер отдаёт только мастеру, поэтому отправка
        // без проверки роли безопасна: игрок её просто не увидит.
        onSetDmNote: (playerId, note) => emit('setDmNote', { playerId, note }),
        // Своё имя меняется из своей же строки в списке: там, где видно,
        // что оно «Мастер», и хочется поменять.
        onRenameSelf: askMyName,
        // Портрет мастера живёт здесь же, над списком: листа персонажа у него
        // нет, а портрет нужен рядом с именем и у бросков в чате.
        onAvatarPick: uploadAvatar,
        onAvatarClear: () => emit('setAvatar', { image: null }),
        resolveUrl: assetUrl
      });
    }
    if (!chatPanel) {
      chatPanel = new ChatPanel($('#tab-chat'), {
        onSend: (text, whisper, to) => emit('chatMessage', { text, whisper, to }),
        // Шёпот есть и у игрока, и у мастера: игрок пишет ведущему, мастер
        // выбирает игрока. В тренировке ведущего нет.
        canWhisper: () => !app.training,
        // Список адресатов нужен только мастеру.
        whisperTargets: () => (app.role === 'dm'
          ? (app.room.players || []).filter((player) => player.role === 'player')
          : null),
        // Хендауты показывает мастер: у игрока нет ни кнопки, ни права.
        canAttach: () => app.role === 'dm' && !app.training,
        canManage: () => app.role === 'dm' && !app.training,
        onDeleteMessage: (id) => emit('deleteChatMessage', { id }),
        onClear: () => confirmClearChat(),
        onImage: uploadChatImage,
        // Запрос поиска живёт в контроллере, а не в панели: снимок стола
        // приходит по переподключению, и подсветка должна восстановиться.
        onQuery: (value) => { app.chatQuery = value; },
        resolveUrl: assetUrl
      });
    }
    if (!dicePanel) {
      dicePanel = new DicePanel($('#tab-dice'), {
        // Формула приходит текстом («2d6+3»), число разбирает сервер.
        onRoll: (formula, options) => emit('rollDice', { formula, ...(options || {}) }),
        // Тайный бросок у мастера: игрок его всё равно увидел бы.
        canRollHidden: () => app.role === 'dm'
      });
    }

    if (!tokenPanel) {
      tokenPanel = new TokenPanel($('#tab-tokens'), {
        // Прочность необязательна: пустое поле — фишка-метка без здоровья.
        onCreate: (name, maxHp, size, side) => {
          // Фишка создаётся на той карте, которую мастер сейчас открыл, а не
          // на показанной: иначе заготовку нельзя было бы обставить заранее.
          const mapType = (mapView && mapView.viewedMap) || app.room.activeMap || 'battle';
          const mapId = (mapView && mapView.currentMapId) || activeMapId();
          // Вкладка «Союзники» создаёт союзника, «Враги» — врага.
          emit('createToken', { name, maxHp, size, side, mapType, mapId });
        },
        onDeleteToken: (tokenId) => emit('deleteToken', { tokenId }),
        // Свет фишки: факел в руке. Дальность в футах, как в правилах.
        onSetTokenLight: (tokenId, radius, color) => emit('setTokenLight', { tokenId, radius, color }),
        onSetTokenAura: (tokenId, feet, color) => emit('setTokenAura', { tokenId, feet, color }),
        // Переименование, назначение игроку и вывод фишки из листа работают и
        // здесь, а не только на карте: правый клик по строке списка ведёт себя
        // так же, как правый клик по фишке. Без этих трёх обработчиков кнопки
        // в списке молча ничего не делали — меню на карте их закрывало.
        onRenameToken: renameToken,
        onAssignToken: (tokenId, playerId) => emit('assignTokenToPlayer', { tokenId, playerId }),
        onSpawnFromSheet: spawnTokenFromSheet,
        // Прочность ведёт мастер: игрок правит своё здоровье в листе, и две
        // правки одного числа за столом разошлись бы.
        onSetTokenHp: (tokenId, hp) => emit('setTokenHp', { tokenId, hp }),
        onSetTokenSize: (tokenId, size) => emit('setTokenSize', { tokenId, size }),
        onSetTokenSide: (tokenId, side) => emit('setTokenSide', { tokenId, side }),
        onSetTokenAttackBonus: (tokenId, attackBonus) => emit('setTokenAttackBonus', { tokenId, attackBonus }),
        onSetTokenArmorClass: (tokenId, armorClass) => emit('setTokenArmorClass', { tokenId, armorClass }),
        // Меню фишки показывает боевые числа игрока из его листа, а не из токена.
        onSheetStats: sheetCombatStats,
        // Состояния ведёт мастер, но видны они всем.
        onSetTokenConditions: (tokenId, conditions, conditionDurations, conditionDurationUnits) => emit('setTokenConditions', {
          tokenId,
          conditions,
          conditionDurations,
          conditionDurationUnits
        }),
        // Скрытость решает только мастер, но сервер всё равно проверяет.
        // Обработчики нужны и здесь, и в карте: правый клик по фишке и кнопки
        // в списке должны делать одно и то же.
        onToggleTokenHidden: (tokenId, hidden) => emit('setTokenHidden', { tokenId, hidden }),
        onToggleTokenNameHidden: (tokenId, hidden) => emit('setTokenNameHidden', { tokenId, hidden }),
        onToggleTokenLabelsHidden: (tokenId, hidden) => emit('setTokenLabelsHidden', { tokenId, hidden }),
        onSetAllTokensHidden: (hidden, side) => emit('setAllTokensHidden', { hidden, side }),
        // Перенос из списка фишек делает то же, что правый клик по фишке на
        // карте: освобождает заготовку от привязки к старой локации.
        onMoveTokenToActive: (tokenId) => emit('moveTokenToActiveMap', { tokenId }),
        activeMapInfo: () => ({ activeMap: app.room.activeMap, activeMapId: app.room.activeMapId }),
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
        // Проверка из листа уходит тем же броском, что и из панели кубиков:
        // результат видит весь стол, он попадает в историю и в чат.
        onRollCheck: (formula, label) => {
          emit('rollDice', { formula });
          toast(`${label}: ${formula}`);
        },
        // Состояния своей фишки дают помеху проверкам, атакам и спасброскам.
        // Источник — токен на карте, а не лист: состояния ставит мастер фишке.
        getConditions: () => {
          if (!app.room || !app.playerId) return [];
          const token = app.room.tokens.find((item) => item.assignedPlayerId === app.playerId);
          return token && Array.isArray(token.conditions) ? token.conditions : [];
        },
        // Спасбросок смерти считает сервер: клиент не решает, успех это или нет.
        onDeathSave: () => emit('rollDeathSave', {}),
        onResetDeathSaves: () => emit('resetDeathSaves', {}),
        onBack: () => closePlayerSheet(),
        onDetach: () => detachSheet(),
        onAvatarPick: uploadAvatar,
        onAvatarClear: () => emit('setAvatar', { image: null }),
        resolveUrl: assetUrl
      });
    }
    if (!initiativePanel) {
      initiativePanel = new window.TableUI.InitiativePanel($('#tab-initiative'), {
        onAdd: (entry) => emit('initiativeAdd', entry),
        // Модификатор игрока присылает мастер из его листа: сервер производные
        // значения листа не считает, а вторая копия расчёта разошлась бы.
        onAddPlayers: () => addPlayersToInitiative(),
        onRemove: (id) => emit('initiativeRemove', { id }),
        onRoll: () => emit('initiativeRoll', {}),
        onRollOne: (id) => emit('initiativeRoll', { id }),
        onSetTurn: (id) => emit('initiativeTurn', { id }),
        onStep: (dir) => emit('initiativeStep', { dir }),
        onReset: () => emit('initiativeReset', {})
      });
    }
    if (!surfacePanel) {
      surfacePanel = new window.TableUI.SurfacePanel($('#tab-surface'), {
        // Кисть включается на карте, а инструмент выбирается здесь: мазок идёт
        // по клеткам, а что именно мазать — дело мастера.
        onPick: (type) => {
          mapView.setSurfaceTool(type);
          renderSurfacePanel();
        },
        onBrush: (brush) => { mapView.surfaceBrush = brush; },
        onErase: () => {
          mapView.setSurfaceTool(mapView.surfaceTool === '' ? null : '');
          renderSurfacePanel();
        },
        onClear: () => {
          const type = mapView.viewedMap;
          const mapId = mapView.currentMapId;
          if (!type || !mapId) return toast('Откройте карту: поверхность живёт на ней', 'error');
          emit('clearMapSurface', { type, mapId });
        }
      });
    }
  }

  /**
   * Перерисовывает панель поверхности.
   *
   * Панель и карта знают об инструменте оба: выбрали в панели — включилась кисть
   * на карте, выключили кисть на карте — панель это видна.
   */
  function renderSurfacePanel() {
    if (!surfacePanel) return;
    // Рисует мастер: игроку вкладка не нужна, он поверхность только видит.
    const button = document.querySelector('.tabs__btn[data-tab="surface"]');
    if (button) button.hidden = app.role !== 'dm' || app.training;
    if (app.role !== 'dm' || app.training) return;
    const map = mapView.mapOf(mapView.viewedMap);
    const painted = map && map.surface && map.surface.cells ? Object.keys(map.surface.cells).length : 0;
    surfacePanel.render({
      tool: mapView.surfaceTool,
      brush: mapView.surfaceBrush,
      painted
    });
  }

  /**
   * Добавляет в бой всех игроков стола, кроме тех, кто уже в списке.
   *
   * Модификатор инициативы берётся из листа игрока: производные значения
   * считает интерфейс, и сервер получает готовое число.
   */
  function addPlayersToInitiative() {
    const taken = new Set((app.room.initiative?.entries || []).map((entry) => entry.refId));
    for (const player of app.room.players) {
      if (player.role === 'dm' || taken.has(player.playerId)) continue;
      const sheet = app.room.sheets ? app.room.sheets[player.playerId] : null;
      const initiative = sheet ? window.DnD5e.computeDerived(sheet).initiative : 0;
      emit('initiativeAdd', { kind: 'player', refId: player.playerId, name: player.name, modifier: initiative });
    }
  }

  /**
   * Перерисовывает порядок боя. Состояние приходит снимком и отдельным
   * событием, поэтому функция одна на оба случая.
   */
  function renderInitiativePanel() {
    if (!initiativePanel) return;
    initiativePanel.render(
      app.room.initiative,
      app.room.players,
      app.room.tokens,
      viewer(),
      app.room.sheets
    );
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

  /**
   * Идентификатор карты, открытой в своей вкладке: фишка создаётся именно на
   * ней, иначе на вкладке с несколькими картами она показывалась бы везде.
   *
   * Функция живёт здесь, рядом с вызывающей, а не внутри `if (!dicePanel)`.
   * Там она была вложена в блок создания панели, а такой блок выполняется
   * ровно один раз за жизнь окна: после первого рендера функции не
   * существовало, и кнопка вывода фишки падала с ReferenceError, не выдав
   * ни ошибки, ни сокета.
   * @returns {string}
   */
  function activeMapId() {
    // Сервер присылает карту, которую видят игроки. В тренировочном столе
    // такого поля нет: там показ и выбор совпадают, поэтому берём activeId.
    if (app.room.activeMapId) return app.room.activeMapId;
    const type = app.room.activeMap || 'world';
    const slot = (app.room.maps || {})[type] || { items: [] };
    const active = (slot.items || []).find((item) => item.id === slot.activeId) || slot.items[0];
    return (active && active.id) || '';
  }

  /**
   * Выводит фишку игрока на текущую карту из его листа: с именем персонажа,
   * аватаром и сразу назначением.
   *
   * Одно действие на два места: кнопка у игрока в панели участников и список
   * спавна в панели фишек. Разъехались бы они иначе: мастер в одной кнопке
   * выведет фишку, а в другой получит ошибку.
   * @param {string} playerId
   */
  function spawnTokenFromSheet(playerId) {
    // Фишка из листа — союзник, и панель фишек должна показать её сразу:
    // кнопка есть и в панели участников, где вкладка стороны не видна.
    if (tokenPanel) tokenPanel.setSide('ally');
    emit('createTokenFromSheet', {
      playerId,
      mapType: app.room.activeMap || 'battle',
      mapId: activeMapId()
    });
  }

  /**
   * Переименование фишки одним окном.
   *
   * Вызывается из трёх мест: правый клик по фишке на карте, двойной клик по ней
   * же и правая кнопка по строке в списке. Отдельная функция нужна, потому что
   * окно одно, а мест три: свой экземпляр в каждом месте разошёлся бы с
   * предыдущим при первой же правке подписи.
   * @param {object} token
   */
  async function renameToken(token) {
    if (!token) return;
    const name = await modal({
      title: 'Имя фишки',
      input: { value: token.name, maxLength: DnD.LIMITS.maxNameLength },
      confirmLabel: 'Сохранить'
    });
    if (name) emit('renameToken', { tokenId: token.id, name });
  }

  function renderAll() {
    const ctx = viewer();
    playersList.render(app.room.players, ctx);
    // Портрет мастера стоит над списком участников: лист у него чужой, а
    // портрет нужен рядом с именем и у бросков в чате.
    playersList.renderSelfAvatar({ avatarUrl: ownAvatarOf('dm'), name: dmName() });
    mapView.render(app.room, ctx);
    chatPanel.renderAll(app.room.chatHistory, app.chatQuery);
    dicePanel.renderAll(app.room.diceHistory);
    tokenPanel.render(app.room.tokens, app.room.players, ctx);
    renderInitiativePanel();
    renderAdventurePanel();
    renderSurfacePanel();
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
    // Вкладка нужна мастеру и когда справочник пуст: здесь он заводит NPC
    // вручную, без импорта чужого приключения.
    button.hidden = app.role !== 'dm';
    if (!button.hidden) {
      button.querySelector('.tabs__label').textContent = total ? `Приключение · ${total}` : 'Приключение';
    }
    if (!adventure) {
      panel.innerHTML = '';
      const empty = el('div', 'adv-empty');
      empty.appendChild(el('p', 'muted',
        'Справочник пуст. Импортируйте приключение из Foundry или создайте NPC вручную.'));
      empty.appendChild(makeAddActorButton());
      const bestiary = makeBestiaryButton();
      if (bestiary) empty.appendChild(bestiary);
      panel.appendChild(empty);
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

    const actions = el('div', 'adv-actions');
    actions.appendChild(makeAddActorButton());
    const bestiary = makeBestiaryButton();
    if (bestiary) actions.appendChild(bestiary);
    panel.appendChild(actions);
    panel.appendChild(buildEncounterBlock(adventure));

    fillAdventureSections(panel, adventure, '');
  }

  /** Кнопка «новый NPC»: работает и без импортированного приключения. */
  function makeAddActorButton() {
    const add = el('button', 'btn btn--tiny', '+ NPC');
    add.type = 'button';
    add.title = 'Создать персонажа вручную и заполнить ему статблок';
    add.addEventListener('click', async () => {
      const name = await modal({
        title: 'Новый NPC',
        message: 'Имя персонажа или монстра. Статблок заполняется в карточке.',
        input: { placeholder: 'Например, «Гоблин-вожак»', maxLength: 80 },
        confirmLabel: 'Создать'
      });
      if (!name) return;
      emit('setAdventureGroupStatblock', { name, create: true, statblock: {} });
    });
    return add;
  }

  /**
   * Кнопка импорта из Open5e. На Android моста нет, поэтому там она просто
   * не появляется: молчаливая кнопка, которая ничего не делает, хуже.
   */
  function makeBestiaryButton() {
    if (typeof desktop === 'undefined' || typeof desktop.searchOpen5e !== 'function') return null;
    const add = el('button', 'btn btn--tiny', 'Импорт из Open5e');
    add.type = 'button';
    add.title = 'Найти монстра в Open5e и перевести карточку на русский';
    add.addEventListener('click', () => openBestiaryImport());
    return add;
  }

  /**
   * Поиск по Open5e с предпросмотром переведённой карточки.
   *
   * Сеть живёт в main-процессе: окно не должно ходить на произвольные адреса.
   * Здесь только шаги, список находок и карточка, которую можно сохранить.
   */
  function openBestiaryImport() {
    if (typeof desktop === 'undefined' || typeof desktop.previewOpen5e !== 'function') return;

    const overlay = el('div', 'modal-overlay');
    const box = el('div', 'modal modal--bestiary');
    const titleId = `bestiary-title-${Date.now()}`;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', titleId);
    box.tabIndex = -1;
    const title = el('div', 'modal__title', 'Импорт из Open5e');
    title.id = titleId;
    box.appendChild(title);
    box.appendChild(el('p', 'modal__text bestiary-hint',
      'Поиск идёт по англоязычной базе. Русское название переводится автоматически, карточка тоже.'));
    const release = trapFocus(box);

    const form = el('form', 'bestiary-search');
    const input = el('input', 'input bestiary-search__input');
    input.type = 'search';
    input.placeholder = 'Введите название (на русском или английском)';
    input.maxLength = 120;
    input.setAttribute('aria-label', 'Название монстра');
    const find = el('button', 'btn btn--accent bestiary-search__go', 'Найти');
    find.type = 'submit';
    form.appendChild(input);
    form.appendChild(find);
    box.appendChild(form);

    const stepLabels = ['Перевод запроса', 'Поиск в базе', 'Перевод карточки', 'Загрузка портрета'];
    const steps = el('div', 'bestiary-steps');
    const stepNodes = stepLabels.map((label) => {
      const node = el('span', 'bestiary-step', label);
      steps.appendChild(node);
      return node;
    });
    box.appendChild(steps);

    const status = el('div', 'status bestiary-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    box.appendChild(status);

    const filters = el('div', 'bestiary-filters');
    filters.hidden = true;
    box.appendChild(filters);
    const results = el('div', 'bestiary-results');
    box.appendChild(results);
    const preview = el('div', 'bestiary-preview');
    preview.hidden = true;
    box.appendChild(preview);

    const actions = el('div', 'modal__actions');
    const close = el('button', 'btn btn--ghost', 'Закрыть');
    close.type = 'button';
    actions.appendChild(close);
    box.appendChild(actions);

    const setStep = (index) => {
      stepNodes.forEach((node, position) => {
        node.classList.toggle('is-active', position === index);
        node.classList.toggle('is-done', position < index);
      });
    };
    const markSteps = (doneCount) => {
      stepNodes.forEach((node, position) => {
        node.classList.remove('is-active');
        node.classList.toggle('is-done', position < doneCount);
      });
    };
    const showStatus = (message, kind) => {
      status.textContent = message || '';
      status.className = `status bestiary-status${kind ? ` status--${kind}` : ''}`;
    };

    const keyHandler = (event) => {
      if (event.key === 'Escape') closeModal();
    };
    const closeModal = () => {
      document.removeEventListener('keydown', keyHandler);
      release();
      overlay.remove();
    };
    close.addEventListener('click', closeModal);
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) closeModal();
    });
    document.addEventListener('keydown', keyHandler);

    setStep(0);

    const filterState = { cr: '', type: '', size: '' };
    const filterSelects = {};
    const crRank = (value) => {
      const text = String(value || '');
      if (text.includes('/')) {
        const [top, bottom] = text.split('/').map(Number);
        return bottom ? top / bottom : 0;
      }
      return Number(text) || 0;
    };
    const addFilter = (key, label) => {
      const wrap = el('label', 'bestiary-filter');
      wrap.appendChild(el('span', 'bestiary-filter__label', label));
      const select = el('select', 'select bestiary-filter__select');
      select.addEventListener('change', () => {
        filterState[key] = select.value;
        drawResults();
      });
      filterSelects[key] = select;
      wrap.appendChild(select);
      filters.appendChild(wrap);
    };
    addFilter('cr', 'CR');
    addFilter('type', 'Тип');
    addFilter('size', 'Размер');

    const fillFilter = (key, values) => {
      const select = filterSelects[key];
      select.innerHTML = '';
      const all = el('option', null, 'Все');
      all.value = '';
      select.appendChild(all);
      const list = [...new Set(values.filter(Boolean))].sort((left, right) => (
        key === 'cr' ? crRank(left) - crRank(right) : left.localeCompare(right)
      ));
      for (const value of list) {
        const option = el('option', null, key === 'cr' ? `CR ${value}` : value);
        option.value = value;
        select.appendChild(option);
      }
      const keep = filterState[key];
      select.value = list.includes(keep) ? keep : '';
      filterState[key] = select.value;
    };

    let currentPayload = null;
    const drawResults = () => {
      if (!currentPayload) return;
      results.innerHTML = '';
      const header = el('div', 'bestiary-results__head');
      if (currentPayload.via === 'api' && currentPayload.english) {
        header.appendChild(el('p', 'muted bestiary-note', `Запрос переведён: «${currentPayload.english}».`));
      }
      if (currentPayload.via === 'failed') {
        header.appendChild(el('p', 'muted bestiary-note',
          'Переводчик недоступен. Попробуйте английское название.'));
      }
      results.appendChild(header);
      const list = currentPayload.results.filter((item) => (
        (!filterState.cr || String(item.cr || '') === filterState.cr)
        && (!filterState.type || String(item.type || '') === filterState.type)
        && (!filterState.size || String(item.size || '') === filterState.size)
      ));
      if (!list.length) {
        results.appendChild(el('p', 'muted bestiary-note',
          currentPayload.results.length
            ? 'Под выбранные фильтры ничего не подходит.'
            : 'Ничего не найдено. Проверьте название или введите его по-английски.'));
        return;
      }
      for (const item of list) {
        const row = el('button', 'bestiary-result');
        row.type = 'button';
        row.appendChild(el('span', 'bestiary-result__name', item.name));
        const meta = [item.type, item.size, item.cr ? `CR ${item.cr}` : '', item.source]
          .filter(Boolean).join(' · ');
        row.appendChild(el('span', 'bestiary-result__meta', meta));
        if (item.system) row.title = `${item.source} · ${item.system}`;
        row.addEventListener('click', () => showPreview(item));
        results.appendChild(row);
      }
    };

    const renderResults = (payload) => {
      currentPayload = payload;
      results.hidden = false;
      preview.hidden = true;
      fillFilter('cr', payload.results.map((item) => item.cr));
      fillFilter('type', payload.results.map((item) => item.type));
      fillFilter('size', payload.results.map((item) => item.size));
      filters.hidden = payload.results.length < 2;
      drawResults();
    };

    const renderPreview = (payload) => {
      preview.innerHTML = '';
      preview.hidden = false;
      results.hidden = true;
      const actor = payload.actor;
      const meta = payload.meta || {};
      const block = actor.statblock || {};

      const head = el('div', 'bestiary-card__head');
      head.appendChild(el('div', 'bestiary-card__name', actor.name));
      head.appendChild(el('div', 'bestiary-card__meta',
        [meta.type, meta.size, block.cr ? `CR ${block.cr}` : '', meta.source]
          .filter(Boolean).join(' · ')));
      if (meta.system) head.appendChild(el('div', 'muted bestiary-card__system', meta.system));
      preview.appendChild(head);

      const figure = el('div', 'bestiary-figure');
      const viewport = el('div', 'bestiary-viewport');
      const media = el('div', 'bestiary-media');
      let portrait = null;
      // Кадр: зум и сдвиг в процентах от стороны квадрата. Эти же числа
      // уходят в карточку и на фишку, поэтому предпросмотр не врёт.
      const crop = {
        zoom: Math.min(4, Math.max(1, Number(actor.imageZoom) || 1)),
        x: Number(actor.imageX) || 0,
        y: Number(actor.imageY) || 0
      };
      const clampCrop = () => {
        const limit = (crop.zoom - 1) * 50;
        crop.x = Math.min(limit, Math.max(-limit, crop.x));
        crop.y = Math.min(limit, Math.max(-limit, crop.y));
      };
      if (actor.image) {
        portrait = el('img', 'bestiary-portrait');
        portrait.src = actor.image;
        portrait.alt = actor.name;
        portrait.referrerPolicy = 'no-referrer';
        portrait.addEventListener('error', () => {
          portrait.classList.add('is-broken');
          const guide = media.querySelector('.bestiary-circle-guide');
          if (guide) guide.remove();
          if (!media.querySelector('.bestiary-portrait--empty')) {
            media.appendChild(el('div', 'bestiary-portrait bestiary-portrait--empty',
              'Портрет не загрузился. Смените картинку или загрузите свою.'));
          }
        });
        media.appendChild(portrait);
        media.appendChild(el('span', 'bestiary-circle-guide', ''));
      } else {
        media.appendChild(el('div', 'bestiary-portrait bestiary-portrait--empty',
          'Портрет не найден. Его можно найти или загрузить свою.'));
      }
      viewport.appendChild(media);
      figure.appendChild(viewport);

      const creditText = [meta.imageSource, meta.imageCredit].filter(Boolean).join(' · ');
      const credit = el('div', 'bestiary-credit', creditText ? `Источник: ${creditText}` : '');
      if (!creditText) credit.hidden = true;
      figure.appendChild(credit);
      if (portrait) {
        figure.appendChild(el('div', 'bestiary-credit',
          'Квадрат 1:1, круг показывает область, которая попадёт на фишку.'));
      }
      if (/^https?:\/\//i.test(actor.image || '')) {
        figure.appendChild(el('div', 'bestiary-credit',
          'Картинка хранится ссылкой и требует интернет. Для офлайна скачайте её локально.'));
      }

      if (portrait) {
        const zoomBar = el('div', 'bestiary-zoom');
        const value = el('span', 'bestiary-zoom__value', '100%');
        const applyCrop = () => {
          clampCrop();
          // Сдвиг стоит до scale: проценты считаются от несжатого квадрата,
          // поэтому 20% на предпросмотре и 20% на фишке дают один и тот же
          // кусок картинки независимо от размера.
          const moved = crop.zoom !== 1 || crop.x !== 0 || crop.y !== 0;
          portrait.style.transform = moved
            ? `translate(${crop.x}%, ${crop.y}%) scale(${crop.zoom})`
            : '';
          media.classList.toggle('is-zoomed', crop.zoom > 1);
          media.title = crop.zoom > 1
            ? 'Перетащите картинку, чтобы выбрать область для фишки'
            : '';
          value.textContent = `${Math.round(crop.zoom * 100)}%`;
        };
        const applyZoom = (next) => {
          crop.zoom = Math.min(4, Math.max(1, next));
          applyCrop();
        };

        let pan = null;
        const endPan = (event) => {
          if (!pan || event.pointerId !== pan.id) return;
          pan = null;
          media.classList.remove('is-panning');
        };
        media.addEventListener('pointerdown', (event) => {
          if (crop.zoom <= 1 || event.button !== 0) return;
          event.preventDefault();
          const rect = media.getBoundingClientRect();
          pan = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            ox: crop.x,
            oy: crop.y,
            size: rect.width
          };
          try { media.setPointerCapture(event.pointerId); } catch { /* не критично */ }
          media.classList.add('is-panning');
        });
        media.addEventListener('pointermove', (event) => {
          if (!pan || event.pointerId !== pan.id || !pan.size) return;
          crop.x = pan.ox + ((event.clientX - pan.x) / pan.size) * 100;
          crop.y = pan.oy + ((event.clientY - pan.y) / pan.size) * 100;
          applyCrop();
        });
        media.addEventListener('pointerup', endPan);
        media.addEventListener('pointercancel', endPan);

        const minus = el('button', 'btn btn--tiny btn--ghost', '−');
        minus.type = 'button';
        minus.title = 'Уменьшить картинку';
        minus.setAttribute('aria-label', 'Уменьшить картинку');
        minus.addEventListener('click', () => applyZoom(crop.zoom - 0.5));
        const plus = el('button', 'btn btn--tiny btn--ghost', '+');
        plus.type = 'button';
        plus.title = 'Увеличить картинку';
        plus.setAttribute('aria-label', 'Увеличить картинку');
        plus.addEventListener('click', () => applyZoom(crop.zoom + 0.5));
        const reset = el('button', 'btn btn--tiny btn--ghost', 'Сброс');
        reset.type = 'button';
        reset.addEventListener('click', () => {
          crop.x = 0;
          crop.y = 0;
          applyZoom(1);
        });
        zoomBar.appendChild(minus);
        zoomBar.appendChild(value);
        zoomBar.appendChild(plus);
        zoomBar.appendChild(reset);
        figure.appendChild(zoomBar);
        applyCrop();
      }

      const images = Array.isArray(payload.images) ? payload.images : [];
      if (images.length > 1) {
        const variants = el('div', 'bestiary-variants');
        for (const candidate of images) {
          const button = el('button', 'bestiary-variant');
          button.type = 'button';
          button.title = [candidate.source, candidate.credit].filter(Boolean).join(' · ') || 'Вариант';
          button.setAttribute('aria-label', `Выбрать картинку: ${button.title}`);
          const thumb = el('img');
          thumb.src = candidate.thumb || candidate.url;
          thumb.alt = '';
          thumb.loading = 'lazy';
          thumb.referrerPolicy = 'no-referrer';
          button.appendChild(thumb);
          if (candidate.url === actor.image) button.classList.add('is-active');
          button.addEventListener('click', async () => {
            if (candidate.url === actor.image) return;
            const picked = await desktop.pickOpen5eImage(payload.id, candidate.url);
            if (!picked.ok) {
              showStatus(picked.error, 'error');
              return;
            }
            payload.actor.image = picked.image;
            payload.meta = {
              ...(payload.meta || {}),
              hasImage: true,
              imageSource: picked.source,
              imageCredit: picked.credit
            };
            renderPreview(payload);
            showStatus('Картинка выбрана.');
          });
          variants.appendChild(button);
        }
        figure.appendChild(variants);
      }

      const imageTools = el('div', 'bestiary-image-tools');
      if (typeof desktop.searchOpen5eImage === 'function') {
        const change = el('button', 'btn btn--tiny btn--ghost', 'Сменить картинку');
        change.type = 'button';
        change.title = 'Найти другую картинку по своему запросу';
        change.addEventListener('click', async () => {
          const query = await modal({
            title: 'Другая картинка',
            message: 'Введите запрос для поиска. Английское название работает точнее.',
            input: { value: `${actor.name} D&D art`, maxLength: 120 },
            confirmLabel: 'Искать'
          });
          if (!query) return;
          change.disabled = true;
          change.textContent = 'Ищу…';
          try {
            const found = await desktop.searchOpen5eImage(payload.id, query);
            if (!found.ok) {
              showStatus(found.error, 'error');
              change.disabled = false;
              change.textContent = 'Сменить картинку';
              return;
            }
            payload.actor.image = found.image;
            payload.images = found.images || payload.images;
            payload.meta = {
              ...(payload.meta || {}),
              hasImage: true,
              imageSource: found.source,
              imageCredit: found.credit
            };
            renderPreview(payload);
            showStatus('Картинка обновлена.');
          } catch (error) {
            showStatus('Поиск картинки не удался.', 'error');
            change.disabled = false;
            change.textContent = 'Сменить картинку';
          }
        });
        imageTools.appendChild(change);
      }
      if (typeof desktop.uploadOpen5eImage === 'function') {
        const upload = el('label', 'btn btn--tiny btn--ghost', 'Загрузить свою');
        upload.title = 'Поставить картинку с компьютера';
        const file = el('input');
        file.type = 'file';
        file.accept = 'image/png,image/jpeg,image/webp';
        file.hidden = true;
        file.addEventListener('change', async () => {
          const selected = file.files && file.files[0];
          if (!selected) return;
          const read = await readImageFile(selected);
          if (read.canceled) return;
          if (read.error) {
            showStatus(read.error, 'error');
            return;
          }
          try {
            const saved = await desktop.uploadOpen5eImage(payload.id, read.dataUrl);
            if (!saved.ok) {
              showStatus(saved.error, 'error');
              return;
            }
            payload.actor.image = saved.image;
            payload.images = saved.images || payload.images;
            payload.meta = {
              ...(payload.meta || {}),
              hasImage: true,
              imageSource: 'Своя картинка',
              imageCredit: ''
            };
            renderPreview(payload);
            showStatus('Своя картинка выбрана.');
          } catch (error) {
            showStatus('Не удалось загрузить картинку.', 'error');
          }
        });
        upload.appendChild(file);
        imageTools.appendChild(upload);
      }
      figure.appendChild(imageTools);
      preview.appendChild(figure);

      const stats = el('div', 'bestiary-stats');
      for (const [label, value] of [
        ['КД', block.ac || '—'],
        ['Хиты', block.hp || '—'],
        ['Скорость', block.speed || '—'],
        ['CR', block.cr || '—'],
        ['Тип', meta.type || '—'],
        ['Размер', meta.size || '—']
      ]) {
        const item = el('div', 'bestiary-stat');
        item.appendChild(el('span', 'bestiary-stat__label', label));
        item.appendChild(el('span', 'bestiary-stat__value', String(value)));
        stats.appendChild(item);
      }
      preview.appendChild(stats);

      const abilities = el('div', 'bestiary-abilities');
      for (const ability of DnD.ABILITIES) {
        const item = el('div', 'bestiary-ability');
        item.appendChild(el('span', 'bestiary-ability__label', ability.abbr));
        item.appendChild(el('span', 'bestiary-ability__value',
          String((block.abilities && block.abilities[ability.key]) || 10)));
        abilities.appendChild(item);
      }
      preview.appendChild(abilities);

      const actionText = block.attacks || 'Атак и действий нет.';
      preview.appendChild(el('div', 'bestiary-text__title', 'Атаки и действия'));
      preview.appendChild(el('div', 'bestiary-text', actionText));
      if (block.notes) {
        preview.appendChild(el('div', 'bestiary-text__title', 'Особенности'));
        preview.appendChild(el('div', 'bestiary-text', block.notes));
      }

      const buttons = el('div', 'bestiary-card__actions');
      const back = el('button', 'btn btn--ghost', 'Назад к поиску');
      back.type = 'button';
      back.addEventListener('click', () => {
        preview.hidden = true;
        results.hidden = false;
        setStep(1);
      });
      if (/^https?:\/\//i.test(actor.image || '')
        && typeof desktop.cacheOpen5eImage === 'function') {
        const local = el('button', 'btn btn--ghost', 'Скачать локально');
        local.type = 'button';
        local.title = 'Сохранить картинку в файлы кампании, чтобы она работала без интернета';
        local.addEventListener('click', async () => {
          local.disabled = true;
          local.textContent = 'Скачиваю…';
          try {
            const cached = await desktop.cacheOpen5eImage(payload.id);
            if (!cached.ok) {
              showStatus(cached.error, 'error');
              local.disabled = false;
              local.textContent = 'Скачать локально';
              return;
            }
            actor.image = cached.image;
            payload.actor.image = cached.image;
            payload.images = cached.images || payload.images;
            // Локальная копия — та же картинка: кадр не сбрасываем.
            payload.actor.imageZoom = crop.zoom;
            payload.actor.imageX = crop.x;
            payload.actor.imageY = crop.y;
            payload.meta = {
              ...(payload.meta || {}),
              hasImage: true,
              imageSource: 'Локальный файл',
              imageCredit: ''
            };
            renderPreview(payload);
            showStatus('Картинка будет сохранена вместе с карточкой.');
          } catch (error) {
            showStatus('Не удалось скачать картинку.', 'error');
            local.disabled = false;
            local.textContent = 'Скачать локально';
          }
        });
        buttons.appendChild(local);
      }
      const save = el('button', 'btn btn--accent', 'Сохранить в справочник');
      save.type = 'button';
      save.addEventListener('click', async () => {
        save.disabled = true;
        back.disabled = true;
        save.textContent = 'Сохраняю…';
        try {
          const saved = await desktop.importOpen5e(payload.id, {
            zoom: crop.zoom,
            x: crop.x,
            y: crop.y
          });
          if (!saved.ok) {
            showStatus(saved.error, 'error');
            save.disabled = false;
            back.disabled = false;
            save.textContent = 'Сохранить в справочник';
            return;
          }
          if (saved.adventure) app.adventure = saved.adventure;
          closeModal();
          renderAdventurePanel({ force: true });
          toast(`«${actor.name}» добавлен в справочник`, 'ok');
        } catch (error) {
          showStatus('Не удалось сохранить карточку.', 'error');
          save.disabled = false;
          back.disabled = false;
          save.textContent = 'Сохранить в справочник';
        }
      });
      buttons.appendChild(back);
      buttons.appendChild(save);
      preview.appendChild(buttons);
      // Фокус на кнопке сохранения прокручивал длинный предпросмотр вниз,
      // и картинка оставалась за верхней кромкой. Держим окно на начале.
      box.focus({ preventScroll: true });
      box.scrollTop = 0;
    };

    const showPreview = async (item) => {
      results.hidden = true;
      preview.hidden = false;
      preview.innerHTML = '';
      showStatus('Загружаю карточку и перевожу текст…');
      setStep(2);
      const timer = setTimeout(() => setStep(3), 800);
      try {
        const payload = await desktop.previewOpen5e(item.key);
        if (!payload.ok) {
          preview.hidden = true;
          results.hidden = false;
          setStep(1);
          showStatus(payload.error, 'error');
          return;
        }
        setStep(4);
        showStatus('');
        markSteps(4);
        renderPreview(payload);
      } catch (error) {
        preview.hidden = true;
        results.hidden = false;
        setStep(1);
        showStatus('Не удалось загрузить карточку.', 'error');
      } finally {
        clearTimeout(timer);
      }
    };

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const query = input.value.trim();
      if (!query) {
        input.focus();
        return;
      }
      find.disabled = true;
      results.innerHTML = '';
      preview.hidden = true;
      showStatus('Ищу…');
      setStep(/[а-яё]/i.test(query) ? 0 : 1);
      const timer = setTimeout(() => setStep(1), 500);
      try {
        const payload = await desktop.searchOpen5e(query);
        if (!payload.ok) {
          setStep(0);
          showStatus(payload.error, 'error');
          return;
        }
        setStep(2);
        showStatus(`Найдено: ${payload.results.length}`);
        markSteps(2);
        renderResults(payload);
      } catch (error) {
        setStep(0);
        showStatus('Поиск не удался. Проверьте интернет.', 'error');
      } finally {
        clearTimeout(timer);
        find.disabled = false;
      }
    });

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus();
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

  /**
   * Уровни партии для расчёта сложности. Берём только листы игроков: у ДМ
   * листа нет, а игрок без листа не должен считаться первым уровнем.
   * @returns {number[]}
   */
  function encounterPartyLevels() {
    const sheets = app.room && app.room.sheets ? app.room.sheets : {};
    const levels = [];
    for (const player of (app.room && app.room.players) || []) {
      if (player.role === 'dm') continue;
      const sheet = sheets[player.playerId];
      if (!sheet) continue;
      levels.push(window.DnD5e.totalCharacterLevel(sheet));
    }
    return levels;
  }

  /**
   * Блок «Встреча»: выбрать монстров, посчитать опыт и сразу вывести их на
   * стол. Опыт считается по DMG, а не по CR напрямую: множитель за число
   * монстров сильно меняет сложность.
   * @param {object} adventure
   * @returns {HTMLElement}
   */
  function buildEncounterBlock(adventure) {
    const section = el('details', 'encounter');
    section.open = encounterOpen;
    const actors = groupByName(adventure.actors || [])
      .filter((group) => group.members.length)
      .sort((left, right) => left.name.localeCompare(right.name, 'ru'));
    const byName = new Map(actors.map((group) => [group.name, group]));
    for (const name of [...encounterSelection.keys()]) {
      if (!byName.has(name)) encounterSelection.delete(name);
    }
    const total = [...encounterSelection.values()].reduce((sum, count) => sum + count, 0);
    const summary = el('summary', 'encounter__summary',
      `⚔ Встреча${total ? ` · ${total} ${plural(total, 'монстр', 'монстра', 'монстров')}` : ''}`);
    summary.addEventListener('click', () => {
      // Следующий кадр: details.open ещё не переключён в момент click.
      setTimeout(() => { encounterOpen = section.open; }, 0);
    });
    section.appendChild(summary);

    const levels = encounterPartyLevels();
    const thresholds = window.DnD5e.partyThresholds(levels);
    section.appendChild(el('div', 'encounter__party',
      thresholds
        ? `Партия: ${thresholds.size} ${plural(thresholds.size, 'лист', 'листа', 'листов')} · `
          + `лёгкая ${thresholds.easy}, средняя ${thresholds.medium}, `
          + `тяжёлая ${thresholds.hard}, смертельная ${thresholds.deadly}`
        : 'Партия: нет листов игроков, сложность посчитать нельзя'));

    if (!actors.length) {
      section.appendChild(el('div', 'encounter__empty muted',
        'В справочнике нет персонажей. Импортируйте приключение или создайте NPC.'));
      return section;
    }

    // Выбор: один список и количество. Так мастер не ищет плюсик у каждой
    // карточки и может собрать встречу из нескольких видов монстров.
    const form = el('form', 'encounter__add');
    const select = el('select', 'select');
    select.setAttribute('aria-label', 'Монстр для встречи');
    for (const group of actors) {
      const option = el('option', null, group.name);
      option.value = group.name;
      select.appendChild(option);
    }
    if (!byName.has(encounterActorName)) encounterActorName = actors[0].name;
    select.value = encounterActorName;
    select.addEventListener('change', () => { encounterActorName = select.value; });
    form.appendChild(select);

    const count = el('input', 'input encounter__count');
    count.type = 'number';
    count.min = '1';
    count.max = '20';
    count.value = '1';
    count.setAttribute('aria-label', 'Сколько монстров');
    form.appendChild(count);

    const add = el('button', 'btn btn--accent btn--tiny', 'Добавить');
    add.type = 'submit';
    form.appendChild(add);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = select.value;
      const n = Math.max(1, Math.min(20, Math.round(Number(count.value) || 1)));
      encounterSelection.set(name, Math.min(20, (encounterSelection.get(name) || 0) + n));
      renderAdventurePanel({ force: true });
    });
    section.appendChild(form);

    if (!encounterSelection.size) {
      section.appendChild(el('div', 'encounter__empty muted',
        'Добавьте монстров: опыт и сложность посчитаются сами.'));
      return section;
    }

    const list = el('div', 'encounter__list');
    for (const [name, n] of encounterSelection) {
      const group = byName.get(name);
      const cr = group && group.members[0] && group.members[0].statblock
        ? group.members[0].statblock.cr
        : '';
      const row = el('div', 'encounter__row');
      row.appendChild(el('span', 'encounter__name', name));
      row.appendChild(el('span', 'encounter__cr', cr ? `CR ${cr}` : 'CR —'));

      const input = el('input', 'input encounter__count');
      input.type = 'number';
      input.min = '1';
      input.max = '20';
      input.value = String(n);
      input.title = 'Количество монстров этого вида';
      input.addEventListener('change', () => {
        const value = Math.max(1, Math.min(20, Math.round(Number(input.value) || 1)));
        encounterSelection.set(name, value);
        renderAdventurePanel({ force: true });
      });
      row.appendChild(input);

      const remove = el('button', 'btn btn--ghost btn--tiny encounter__remove', '×');
      remove.type = 'button';
      remove.title = `Убрать «${name}» из встречи`;
      remove.addEventListener('click', () => {
        encounterSelection.delete(name);
        renderAdventurePanel({ force: true });
      });
      row.appendChild(remove);
      list.appendChild(row);
    }
    section.appendChild(list);

    const xp = window.DnD5e.encounterXp([...encounterSelection].map(([name, n]) => ({
      cr: byName.get(name) && byName.get(name).members[0]
        ? byName.get(name).members[0].statblock?.cr
        : null,
      count: n
    })));
    const difficulty = window.DnD5e.encounterDifficulty(xp.adjustedXp, thresholds);
    const difficultyLabels = {
      trivial: 'ниже лёгкой',
      easy: 'лёгкая',
      medium: 'средняя',
      hard: 'тяжёлая',
      deadly: 'смертельная'
    };
    const xpLine = el('div', 'encounter__result');
    xpLine.appendChild(el('strong', null,
      `${xp.adjustedXp} XP`));
    xpLine.appendChild(el('span', 'muted',
      xp.multiplier > 1
        ? ` · ${xp.baseXp} × ${xp.multiplier} за число монстров`
        : ` · ${xp.baseXp} базовых`));
    if (difficulty) {
      xpLine.appendChild(el('span', `encounter__diff encounter__diff--${difficulty}`,
        ` · ${difficultyLabels[difficulty]}`));
    }
    if (xp.ignored) {
      xpLine.appendChild(el('span', 'muted', ` · ${xp.ignored} без CR не учтены`));
    }
    section.appendChild(xpLine);

    const go = el('button', 'btn btn--accent encounter__go', 'В бой');
    go.type = 'button';
    go.title = 'Создать фишки, добавить их в порядок боя и бросить инициативу';
    go.addEventListener('click', () => startEncounter(go));
    section.appendChild(go);
    section.appendChild(el('div', 'encounter__empty muted',
      'Фишки появятся на текущей карте и сразу вступят в бой.'));
    return section;
  }

  /** Создаёт фишки встречи и запускает порядок боя. */
  async function startEncounter(button) {
    const chosen = [...encounterSelection].filter(([, count]) => count > 0);
    if (!chosen.length) return;
    if (button) button.disabled = true;
    const mapType = (mapView && mapView.viewedMap) || app.room.activeMap || 'battle';
    const mapId = (mapView && mapView.currentMapId) || activeMapId();
    const created = [];
    for (let index = 0; index < chosen.length; index += 1) {
      const [name, count] = chosen[index];
      const result = await emitAck('createTokenFromAdventureActor', {
        name,
        mapType,
        mapId,
        count,
        x: 0.3 + (index % 3) * 0.2,
        y: 0.35 + Math.floor(index / 3) * 0.2
      });
      if (result && result.ok && Array.isArray(result.tokens)) created.push(...result.tokens);
    }
    if (!created.length) {
      toast('Не удалось создать фишки встречи', 'error');
      if (button) button.disabled = false;
      return;
    }
    for (const token of created) {
      // Встреча начинается сразу: фишки показываем, иначе игроки увидели бы
      // монстров в порядке боя, но не на карте.
      emit('setTokenHidden', { tokenId: token.id, hidden: false });
      emit('initiativeAdd', { kind: 'token', refId: token.id, name: token.name, modifier: 0 });
    }
    emit('initiativeRoll', {});
    encounterSelection.clear();
    renderAdventurePanel({ force: true });
    toast(`Встреча: ${created.length} фишек. Инициатива брошена.`, 'ok');
  }

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
      if (section.key === 'actors') {
        grouped.sort((left, right) => {
          const favLeft = left.members.some((member) => member.favorite) ? 1 : 0;
          const favRight = right.members.some((member) => member.favorite) ? 1 : 0;
          return favRight - favLeft || left.name.localeCompare(right.name, 'ru');
        });
      }
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
  /**
   * Бросок монстра из справочника на карту. Спрашиваем количество, потому что
   * «пять гоблинов» — обычная подготовка, а ставить их по одному долго.
   * @param {string} name
   * @param {number} x
   * @param {number} y
   */
  async function dropAdventureActor(name, x, y) {
    const answer = await modal({
      title: `Поставить «${name}» на карту`,
      message: 'Сколько фишек создать? У каждой будут свои хиты и своя полоска здоровья.',
      input: { value: '1', maxLength: 2 },
      confirmLabel: 'Поставить'
    });
    if (answer === null) return;
    const count = Math.max(1, Math.min(20, Number.parseInt(answer, 10) || 1));
    const mapType = (mapView && mapView.viewedMap) || app.room.activeMap || 'battle';
    const mapId = (mapView && mapView.currentMapId) || activeMapId();
    emit('createTokenFromAdventureActor', { name, mapType, mapId, x, y, count });
  }

  function renderAdventureGroup(section, group) {
    const card = el('article', `adv-item adv-item--group${group.members.length > 1 ? ' is-group' : ''}`);
    // По этому имени поиск находит карточку и подсвечивает её, а не только
    // фильтрует раздел: иначе мастер видит список без указания, что нашлось.
    card.dataset.advName = group.name;
    if (section.key === 'actors') {
      // Монстра можно утащить прямо на карту. Кнопки внутри карточки не
      // начинают перенос: иначе «Статблок» уезжал бы вместо нажатия.
      card.draggable = true;
      card.title = 'Перетащите на карту, чтобы поставить фишку';
      card.addEventListener('dragstart', (event) => {
        if (event.target.closest('button, input, select, textarea, a')) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData('application/x-dnd-actor', group.name);
        event.dataTransfer.setData('text/plain', group.name);
        card.classList.add('is-dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('is-dragging'));
    }
    const head = el('div', 'adv-group__head');
    head.appendChild(renderItemTitle(group.name, section.key));
    if (group.members.length > 1) {
      head.appendChild(el('span', 'adv-group__count', `× ${group.members.length}`));
    }
    if (section.key === 'actors') {
      const favorite = group.members.some((member) => member.favorite);
      const star = el('button', `adv-fav${favorite ? ' is-on' : ''}`, favorite ? '★' : '☆');
      star.type = 'button';
      star.title = favorite ? 'Убрать из избранного' : 'В избранное';
      star.setAttribute('aria-label', star.title);
      star.setAttribute('aria-pressed', String(favorite));
      star.addEventListener('click', (event) => {
        event.stopPropagation();
        emit('setAdventureActorFavorite', { name: group.name, favorite: !favorite });
      });
      head.appendChild(star);
    }
    card.appendChild(head);

    // Картинку массово ставят только тем, у кого это осмысленно: предметам
    // и персонажам. Заметку и таблицу одной картинкой не заменить.
    if (section.key === 'items' || section.key === 'actors') {
      card.appendChild(makeGroupImageButton(group.name, group.members.length, (name, image) => {
        emit('setAdventureGroupImage', { section: section.key, name, image });
      }));
    }

    if (section.key === 'actors') {
      const block = group.members[0].statblock || {};
      const summary = statblockSummary(block);
      if (summary) card.appendChild(el('div', 'adv-stat', summary));
      const macros = attackMacros(block);
      if (macros.length) {
        const dice = el('div', 'adv-dice');
        for (const macro of macros) {
          const button = el('button', 'btn btn--tiny adv-dice__btn', macro.label);
          button.type = 'button';
          button.title = `Бросить ${macro.formula}`;
          button.addEventListener('click', () => {
            emit('rollDice', {
              formula: macro.formula,
              label: `${group.name}: ${macro.label}`,
              dmOnly: true
            });
          });
          dice.appendChild(button);
        }
        card.appendChild(dice);
      }
      const actions = el('div', 'adv-item__actions');
      const edit = el('button', 'btn btn--tiny', 'Статблок');
      edit.type = 'button';
      edit.addEventListener('click', () => openStatblockEditor(group.name, block));
      actions.appendChild(edit);
      const spawn = el('button', 'btn btn--tiny btn--accent', 'На стол');
      spawn.type = 'button';
      spawn.title = 'Поставить фишку с прочностью и размером из статблока';
      spawn.addEventListener('click', () => {
        const mapType = (mapView && mapView.viewedMap) || app.room.activeMap || 'battle';
        const mapId = (mapView && mapView.currentMapId) || activeMapId();
        emit('createTokenFromAdventureActor', { name: group.name, mapType, mapId });
      });
      actions.appendChild(spawn);
      const remove = el('button', 'btn btn--tiny btn--danger btn--ghost', 'Удалить');
      remove.type = 'button';
      remove.title = 'Убрать персонажа из справочника';
      remove.addEventListener('click', async () => {
        const count = group.members.length;
        const confirmed = await modal({
          title: 'Удалить персонажа?',
          message: count > 1
            ? `Из справочника исчезнут все записи «${group.name}» (${count}). Фишки на карте останутся.`
            : `«${group.name}» исчезнет из справочника. Фишка на карте останется.`,
          confirmLabel: 'Удалить',
          danger: true
        });
        if (!confirmed) return;
        emit('deleteAdventureActor', { name: group.name });
      });
      actions.appendChild(remove);
      card.appendChild(actions);
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

  /** Короткая строка статблока для карточки персонажа. */
  function statblockSummary(block = {}) {
    const parts = [];
    if (block.ac) parts.push(`КД ${block.ac}`);
    if (block.hp) parts.push(`Хиты ${block.hp}`);
    if (block.speed) parts.push(block.speed);
    if (block.cr) parts.push(`CR ${block.cr}`);
    return parts.join(' · ');
  }

  /**
   * Достаёт из текста статблока броски атаки и урона.
   *
   * Open5e отдаёт действия одной строкой: «Клинок. Атака оружием: +4 к
   * попаданию, 5 (1d6 + 2) рубящего урона». Из неё делаются кнопки, чтобы
   * мастер не искал формулу глазами и не набирал её руками.
   * @param {object} block
   * @returns {{label: string, formula: string}[]}
   */
  function attackMacros(block = {}) {
    const lines = String(block.attacks || '').split(/\n+/).filter(Boolean);
    const macros = [];
    const seen = new Set();
    const add = (formula, label) => {
      const clean = formula.replace(/\s+/g, '');
      if (!/^1?d20[+-]\d+$|^\d*d\d+[+-]\d+$|^\d*d\d+$/i.test(clean)) return;
      const key = `${label}|${clean}`;
      if (seen.has(key)) return;
      seen.add(key);
      macros.push({ label, formula: clean });
    };
    for (const line of lines) {
      const title = String(line.split('.')[0] || 'Атака').trim().slice(0, 40);
      const hit = /([+-]\s*\d+)\s*(?:to hit|к попаданию)/i.exec(line);
      if (hit) add(`1d20${hit[1]}`, `${title}: атака`);
      const damage = /\b(\d*d\d+(?:\s*[+-]\s*\d+)?)\b/i.exec(line);
      if (damage) add(damage[1], `${title}: урон`);
      if (macros.length >= 8) break;
    }
    return macros.slice(0, 8);
  }

  /**
   * Редактор статблока. Полей немного и они плоские, поэтому обычная форма в
   * модальном окне: отдельный экран ради десятка чисел был бы лишним.
   * @param {string} name
   * @param {object} [block]
   */
  function openStatblockEditor(name, block = {}) {
    const overlay = el('div', 'modal-overlay');
    const box = el('div', 'modal modal--statblock');
    box.appendChild(el('div', 'modal__title', `Статблок: ${name}`));
    const fields = {};

    const numberField = (label, key, value, min, max) => {
      const wrap = el('label', 'field');
      wrap.appendChild(el('span', 'field__label', label));
      const input = el('input', 'input');
      input.type = 'number';
      input.min = String(min);
      input.max = String(max);
      input.value = value === undefined || value === null ? '' : String(value);
      fields[key] = input;
      wrap.appendChild(input);
      return wrap;
    };
    const textField = (label, key, value, maxLength) => {
      const wrap = el('label', 'field');
      wrap.appendChild(el('span', 'field__label', label));
      const input = el('input', 'input');
      input.type = 'text';
      input.value = value || '';
      input.maxLength = maxLength;
      fields[key] = input;
      wrap.appendChild(input);
      return wrap;
    };

    const top = el('div', 'statblock__row');
    top.appendChild(numberField('КЗ', 'ac', block.ac, 0, 99));
    top.appendChild(numberField('Хиты', 'hp', block.hp, 0, 9999));
    top.appendChild(textField('Скорость', 'speed', block.speed, 60));
    top.appendChild(textField('CR', 'cr', block.cr, 20));
    const sizeWrap = el('label', 'field');
    sizeWrap.appendChild(el('span', 'field__label', 'Размер'));
    const size = el('select', 'select');
    for (const value of [1, 2, 3, 4]) {
      const option = el('option', null, `${value}×${value}`);
      option.value = String(value);
      size.appendChild(option);
    }
    size.value = String(block.size || 1);
    fields.size = size;
    sizeWrap.appendChild(size);
    top.appendChild(sizeWrap);
    box.appendChild(top);

    const abilities = el('div', 'statblock__abilities');
    for (const key of DnD.ABILITY_KEYS) {
      const value = block.abilities && block.abilities[key] !== undefined ? block.abilities[key] : 10;
      abilities.appendChild(numberField(DnD.ABILITY_LABELS[key], key, value, 1, 30));
    }
    box.appendChild(abilities);

    const attacksWrap = el('label', 'field');
    attacksWrap.appendChild(el('span', 'field__label', 'Атаки и действия'));
    const attacks = el('textarea', 'textarea');
    attacks.rows = 4;
    attacks.maxLength = DnD.LIMITS.maxSheetTextLength;
    attacks.value = block.attacks || '';
    fields.attacks = attacks;
    attacksWrap.appendChild(attacks);
    box.appendChild(attacksWrap);

    const notesWrap = el('label', 'field');
    notesWrap.appendChild(el('span', 'field__label', 'Особенности'));
    const notes = el('textarea', 'textarea');
    notes.rows = 3;
    notes.maxLength = DnD.LIMITS.maxSheetTextLength;
    notes.value = block.notes || '';
    fields.notes = notes;
    notesWrap.appendChild(notes);
    box.appendChild(notesWrap);

    const actions = el('div', 'modal__actions');
    const cancel = el('button', 'btn btn--ghost', 'Отмена');
    cancel.type = 'button';
    const save = el('button', 'btn btn--accent', 'Сохранить');
    save.type = 'button';
    const close = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close();
    };
    cancel.addEventListener('click', close);
    save.addEventListener('click', () => {
      const statblock = {
        ac: Number(fields.ac.value) || 0,
        hp: Number(fields.hp.value) || 0,
        speed: fields.speed.value.trim(),
        cr: fields.cr.value.trim(),
        size: Number(fields.size.value) || 1,
        abilities: {},
        attacks: fields.attacks.value,
        notes: fields.notes.value
      };
      for (const key of DnD.ABILITY_KEYS) {
        statblock.abilities[key] = Number(fields[key].value) || 10;
      }
      emit('setAdventureGroupStatblock', { name, statblock });
      close();
    });
    actions.appendChild(cancel);
    actions.appendChild(save);
    box.appendChild(actions);

    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) close();
    });
    document.addEventListener('keydown', onKey);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    fields.ac.focus();
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
    card.dataset.advName = group.name;
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
    const actions = el('div', 'adv-item__actions');
    const remove = el('button', 'btn btn--tiny btn--danger btn--ghost', 'Удалить');
    remove.type = 'button';
    remove.title = 'Убрать эти фишки с карт';
    remove.addEventListener('click', async () => {
      const count = group.members.length;
      const confirmed = await modal({
        title: 'Удалить фишки?',
        message: count > 1
          ? `С карт исчезнут все фишки «${group.name}» (${count}). Записи в справочнике останутся.`
          : `Фишка «${group.name}» исчезнет с карты. Запись в справочнике останется.`,
        confirmLabel: 'Удалить',
        danger: true
      });
      if (!confirmed) return;
      // Отдельного события на группу нет: существующее удаление фишки уже
      // чистит порядок боя и рассылает всем клиентам.
      for (const token of group.members) emit('deleteToken', { tokenId: token.id });
    });
    actions.appendChild(remove);
    card.appendChild(actions);
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
    $('#journal-panel').hidden = !isDm || app.training;
    $('#btn-undo').hidden = !isDm;
    renderJournalPanel();
    renderInventoryPanel();
    renderRollRequests();
    renderReactionPrompts();
    renderGameTime();
    $('#role-badge').textContent = isDm ? 'ДМ' : 'Игрок';
    $('#role-badge').className = `badge ${isDm ? 'badge--dm' : 'badge--player'}`;
    if (isDm) renderAddresses();
    applyAddressesCollapsed();
  }

  /** Часы стола: день и час, без минут. */
  function gameTime() {
    const raw = app.room && app.room.gameTime;
    return {
      day: DnD.clampNumber(raw && raw.day, 1, 9999, 1),
      hour: DnD.clampNumber(raw && raw.hour, 0, 23, 8)
    };
  }

  /** Сдвиг часов с переносом на следующие сутки. */
  function shiftGameTime(time, hours) {
    const total = (time.day - 1) * 24 + time.hour + hours;
    return {
      day: Math.floor(total / 24) + 1,
      hour: ((total % 24) + 24) % 24
    };
  }

  function gameTimeLabel(time) {
    return `День ${time.day}, ${String(time.hour).padStart(2, '0')}:00`;
  }

  /** Часы видят все; кнопка долгого отдыха есть только у мастера. */
  function renderGameTime() {
    const node = $('#game-time');
    if (node) node.textContent = gameTimeLabel(gameTime());
    const rest = $('#btn-game-rest');
    if (rest) rest.hidden = app.role !== 'dm';
  }

  /** Сохраняет время на сервере; в тренировке двигает только это окно. */
  function sendGameTime(time) {
    const next = {
      day: DnD.clampNumber(time && time.day, 1, 9999, 1),
      hour: DnD.clampNumber(time && time.hour, 0, 23, 8)
    };
    if (app.training || !app.socket || !app.connected) {
      if (app.room) app.room.gameTime = next;
      renderGameTime();
      return;
    }
    app.socket.emit('setGameTime', next);
  }

  /**
   * Долгий отдых всей партии.
   *
   * В настоящем столе листы лежат на сервере, и он сам лечит всех: у игроков
   * нет прав на чужие листы. В тренировке лист один и живёт в этом окне.
   */
  async function partyLongRest() {
    if (app.role !== 'dm') return;
    const answer = await modal({
      title: 'Долгий отдых партии?',
      message: 'Все персонажи восстановят здоровье, ячейки заклинаний и половину костей хитов. Время сдвинется на 8 часов.',
      confirmLabel: 'Отдыхать'
    });
    if (!answer) return;
    if (app.training) {
      if (sheetView) sheetView.takeLongRest();
      sendGameTime(shiftGameTime(gameTime(), 8));
      return;
    }
    emit('partyLongRest', {});
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

  /* ------------------------------------------------------------------ *
   * Журнал кампании
   * ------------------------------------------------------------------ */

  /** Подписи видов записей. Ключи совпадают с серверными. */
  const JOURNAL_KINDS = [
    ['npc', 'НПС'],
    ['location', 'Место'],
    ['quest', 'Задание'],
    ['faction', 'Фракция'],
    ['item', 'Предмет']
  ];

  function journalKindLabel(kind) {
    const found = JOURNAL_KINDS.find(([key]) => key === kind);
    return found ? found[1] : 'НПС';
  }

  function journalEntries() {
    return app.room && Array.isArray(app.room.journalEntries) ? app.room.journalEntries : [];
  }

  /** Найденная запись или null: список мог обновиться из другого окна. */
  function journalEntry(id) {
    return journalEntries().find((entry) => entry.id === id) || null;
  }

  function journalMatches(entry, query) {
    if (!query) return true;
    const haystack = [entry.title, entry.text, ...(entry.tags || [])].join(' ').toLowerCase();
    return haystack.includes(query);
  }

  /**
   * Рисует панель журнала: поиск, список записей и открытый редактор.
   * Мастер видит и правит всё, игрок — только записи с флагом «показать».
   */
  function renderJournalPanel() {
    const panel = $('#journal-panel');
    if (!panel) return;
    const isDm = app.role === 'dm';
    const hasEntries = journalEntries().length > 0;
    panel.hidden = !(app.room && !app.training && (isDm || hasEntries));
    const add = $('#btn-journal-add');
    if (add) add.hidden = !isDm;
    const detach = $('#btn-journal-detach');
    if (detach) detach.hidden = !isDm;
    const list = $('#journal-list');
    if (!list) return;
    list.innerHTML = '';
    if (panel.hidden) return;

    const query = journalQuery.trim().toLowerCase();
    const entries = journalEntries()
      .filter((entry) => journalMatches(entry, query))
      .slice()
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

    const editor = journalEditingId ? journalEditorNode(journalEditingId, { readOnly: !isDm }) : null;
    if (editor) list.appendChild(editor);

    if (!entries.length) {
      list.appendChild(el('div', 'journal-empty muted',
        query ? 'Ничего не найдено' : 'Записей пока нет'));
      return;
    }

    for (const entry of entries) {
      const row = el('button', 'journal-row');
      row.type = 'button';
      row.appendChild(el('span', 'journal-row__kind', journalKindLabel(entry.kind)));
      const main = el('span', 'journal-row__main');
      main.appendChild(el('span', 'journal-row__title', entry.title));
      if (entry.visible && isDm) {
        main.appendChild(el('span', 'journal-row__tags', 'видна игрокам'));
      }
      if (entry.tags && entry.tags.length) {
        main.appendChild(el('span', 'journal-row__tags', entry.tags.join(' · ')));
      }
      row.appendChild(main);
      row.addEventListener('click', () => {
        journalEditingId = entry.id;
        renderJournalPanel();
      });
      list.appendChild(row);
    }
  }

  /** Редактор записи: та же форма и для новой, и для правки существующей. */
  function journalEditorNode(id, options = {}) {
    const readOnly = Boolean(options.readOnly);
    const isNew = id === 'new';
    const entry = isNew ? null : journalEntry(id);
    if (!isNew && !entry) {
      journalEditingId = null;
      return null;
    }

    const form = el('form', 'journal-editor');
    const title = el('input', 'input');
    title.id = 'journal-title-input';
    title.name = 'title';
    title.placeholder = 'Заголовок';
    title.maxLength = 120;
    title.value = (entry && entry.title) || '';
    title.setAttribute('aria-label', 'Заголовок записи');

    const kind = el('select', 'select');
    kind.name = 'kind';
    kind.setAttribute('aria-label', 'Вид записи');
    for (const [value, label] of JOURNAL_KINDS) {
      const option = el('option', null, label);
      option.value = value;
      kind.appendChild(option);
    }
    kind.value = (entry && entry.kind) || 'npc';

    const tags = el('input', 'input');
    tags.name = 'tags';
    tags.placeholder = 'Теги через запятую';
    tags.value = entry && entry.tags ? entry.tags.join(', ') : '';
    tags.setAttribute('aria-label', 'Теги через запятую');

    const text = el('textarea', 'input journal-editor__text');
    text.name = 'text';
    text.rows = 5;
    text.placeholder = 'Что известно: имена, связи, тайны, планы…';
    text.value = (entry && entry.text) || '';
    text.setAttribute('aria-label', 'Текст записи');

    const visibleLabel = el('label', 'journal-editor__visible');
    const visible = el('input');
    visible.type = 'checkbox';
    visible.checked = Boolean(entry && entry.visible);
    visible.title = 'Запись увидят игроки в своей панели журнала';
    visibleLabel.appendChild(visible);
    visibleLabel.appendChild(el('span', null, 'Показать игрокам'));

    form.appendChild(title);
    form.appendChild(kind);
    form.appendChild(tags);
    form.appendChild(text);
    form.appendChild(visibleLabel);

    if (readOnly) {
      title.readOnly = true;
      kind.disabled = true;
      tags.readOnly = true;
      text.readOnly = true;
      visible.disabled = true;
      const close = el('button', 'btn btn--ghost btn--tiny', 'Закрыть');
      close.type = 'button';
      close.addEventListener('click', () => {
        journalEditingId = null;
        renderJournalPanel();
      });
      const actions = el('div', 'journal-editor__actions');
      actions.appendChild(close);
      form.appendChild(actions);
      return form;
    }

    const actions = el('div', 'journal-editor__actions');
    const save = el('button', 'btn btn--accent btn--tiny', 'Сохранить');
    save.type = 'submit';
    const cancel = el('button', 'btn btn--ghost btn--tiny', 'Отмена');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      journalEditingId = null;
      renderJournalPanel();
    });
    actions.appendChild(save);
    actions.appendChild(cancel);

    if (entry) {
      const remove = el('button', 'btn btn--danger btn--ghost btn--tiny', 'Удалить');
      remove.type = 'button';
      remove.addEventListener('click', () => deleteJournalEntry(entry.id));
      actions.appendChild(remove);
    }
    form.appendChild(actions);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      saveJournalEntry({
        ...(entry ? { id: entry.id } : {}),
        kind: kind.value,
        title: title.value.trim(),
        text: text.value,
        tags: tags.value.split(',').map((tag) => tag.trim()).filter(Boolean),
        visible: visible.checked
      });
    });

    return form;
  }

  function saveJournalEntry(payload) {
    if (!payload.title) return toast('Нужен заголовок записи', 'error');
    if (!app.socket || !app.connected) return toast('Нет соединения со столом', 'error');
    app.socket.emit('saveJournalEntry', payload, (result) => {
      if (!result || !result.ok) {
        return toast((result && result.error) || 'Не удалось сохранить запись', 'error');
      }
      journalEditingId = null;
      renderJournalPanel();
    });
  }

  function deleteJournalEntry(id) {
    if (!app.socket || !app.connected) return toast('Нет соединения со столом', 'error');
    app.socket.emit('deleteJournalEntry', { id }, (result) => {
      if (!result || !result.ok) {
        return toast((result && result.error) || 'Не удалось удалить запись', 'error');
      }
      journalEditingId = null;
      renderJournalPanel();
    });
  }

  /** Открывает журнал отдельным окном: мастер может держать его рядом. */
  async function detachJournal() {
    if (app.role !== 'dm') return;
    if (!desktop || !desktop.openJournalWindow) {
      return toast('Отдельное окно журнала здесь недоступно', 'error');
    }
    const result = await desktop.openJournalWindow({
      role: 'dm',
      url: app.serverUrl || '',
      title: 'Журнал кампании'
    });
    if (!result || !result.ok) {
      return toast((result && result.error) || 'Не удалось открыть окно журнала', 'error');
    }
  }

  /* ------------------------------------------------------------------ *
   * Общий склад партии
   * ------------------------------------------------------------------ */

  function inventoryItems() {
    return app.room && Array.isArray(app.room.inventory) ? app.room.inventory : [];
  }

  /** Кошелёк партии: пять монет, как в листе. */
  function inventoryCoins() {
    const raw = app.room && app.room.inventoryCoins;
    const coins = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
    if (raw && typeof raw === 'object') {
      for (const key of Object.keys(coins)) coins[key] = DnD.clampNumber(raw[key], 0, DnD.LIMITS.maxCoins, 0);
    }
    return coins;
  }

  /** Строка монет общего склада. Мастер правит, игрок только читает. */
  function inventoryCoinsNode(isDm) {
    const coins = inventoryCoins();
    const row = el('div', 'inventory-coins');
    const inputs = {};
    for (const [key, label] of [['cp', 'мм'], ['sp', 'см'], ['ep', 'эл.'], ['gp', 'зм'], ['pp', 'пл']]) {
      const field = el('label', 'inventory-coins__field');
      field.appendChild(el('span', 'inventory-coins__label', label));
      const input = el('input', 'input inventory-coins__input');
      input.type = 'number';
      input.min = '0';
      input.max = String(DnD.LIMITS.maxCoins);
      input.value = String(coins[key] || 0);
      input.disabled = !isDm;
      input.title = 'Монеты общего склада';
      input.addEventListener('change', () => {
        const next = {};
        for (const coin of Object.keys(inputs)) {
          next[coin] = DnD.clampNumber(inputs[coin].value, 0, DnD.LIMITS.maxCoins, 0);
        }
        emit('setInventoryCoins', { coins: next });
      });
      inputs[key] = input;
      field.appendChild(input);
      row.appendChild(field);
    }
    return row;
  }

  /** Имя владельца предмета: пустой ownerId — общий склад. */
  function inventoryOwnerLabel(ownerId) {
    if (!ownerId) return 'Общий склад';
    const player = (app.room.players || []).find((item) => item.playerId === ownerId);
    return player ? player.name : 'Общий склад';
  }

  function inventoryPanelVisible() {
    if (!app.room) return false;
    // В тренировке ДМа нет и склад наполнить некому: пустая панель только мешает.
    if (app.training && !inventoryItems().length) return false;
    return true;
  }

  /**
   * Склад партии: список и форма мастера.
   *
   * Игроки видят тот же список без кнопок: сервер всё равно не примет от них
   * правку, а лишние поля только сбивали бы.
   */
  function renderInventoryPanel() {
    const panel = $('#inventory-panel');
    if (!panel) return;
    const isDm = app.role === 'dm';
    panel.hidden = !inventoryPanelVisible();
    const add = $('#btn-inventory-add');
    if (add) add.hidden = !isDm;
    const list = $('#inventory-list');
    if (!list) return;
    list.innerHTML = '';
    if (panel.hidden) return;

    list.appendChild(inventoryCoinsNode(isDm));

    if (isDm && inventoryEditingId) {
      const editor = inventoryEditorNode(inventoryEditingId);
      if (editor) list.appendChild(editor);
    }

    const items = inventoryItems();
    if (!items.length) {
      list.appendChild(el('div', 'journal-empty muted', 'Склад пуст'));
      return;
    }

    const total = items.reduce((sum, item) => sum + (Number(item.weight) || 0) * (Number(item.qty) || 0), 0);
    list.appendChild(el('div', 'inventory-total muted',
      `Всего: ${Math.round(total * 100) / 100} фнт.`));

    for (const item of items) {
      const row = el(isDm ? 'button' : 'div', 'inventory-row');
      row.dataset.itemId = item.id;
      if (isDm) row.type = 'button';
      const head = el('div', 'inventory-row__head');
      head.appendChild(el('span', 'inventory-row__name', item.name));
      if (item.qty !== 1) head.appendChild(el('span', 'inventory-row__qty', `× ${item.qty}`));
      if (item.attunement) {
        const mark = el('span', 'inventory-row__attunement', 'настройка');
        mark.title = 'Требует настройки';
        head.appendChild(mark);
      }
      row.appendChild(head);
      const meta = [];
      if (Number(item.weight)) meta.push(`${item.weight} фнт.`);
      meta.push(inventoryOwnerLabel(item.ownerId));
      row.appendChild(el('div', 'inventory-row__meta muted', meta.join(' · ')));
      if (item.notes) row.appendChild(el('div', 'inventory-row__notes', item.notes));
      if (isDm) {
        row.addEventListener('click', () => {
          inventoryEditingId = item.id;
          renderInventoryPanel();
          const field = $('#inventory-name-input');
          if (field) field.focus();
        });
      }
      list.appendChild(row);
    }
  }

  /** Форма предмета: одна и та же для нового и для правки. */
  function inventoryEditorNode(id) {
    const isNew = id === 'new';
    const item = isNew ? null : inventoryItems().find((entry) => entry.id === id);
    if (!isNew && !item) {
      inventoryEditingId = null;
      return null;
    }

    const form = el('form', 'journal-editor inventory-editor');
    const name = el('input', 'input');
    name.id = 'inventory-name-input';
    name.placeholder = 'Название предмета';
    name.maxLength = 120;
    name.value = (item && item.name) || '';
    name.setAttribute('aria-label', 'Название предмета');

    const qty = el('input', 'input');
    qty.type = 'number';
    qty.min = '0';
    qty.max = '9999';
    qty.placeholder = 'Кол-во';
    qty.value = String(item ? item.qty : 1);
    qty.setAttribute('aria-label', 'Количество');

    const weight = el('input', 'input');
    weight.type = 'number';
    weight.min = '0';
    weight.step = '0.01';
    weight.placeholder = 'Вес, фнт.';
    weight.value = String(item && item.weight ? item.weight : 0);
    weight.setAttribute('aria-label', 'Вес в фунтах');

    const owner = el('select', 'select');
    owner.setAttribute('aria-label', 'Владелец');
    const shared = el('option', null, 'Общий склад');
    shared.value = '';
    owner.appendChild(shared);
    for (const player of app.room.players || []) {
      if (player.role === 'dm') continue;
      const option = el('option', null, player.name);
      option.value = player.playerId;
      owner.appendChild(option);
    }
    owner.value = (item && item.ownerId) || '';

    const attuneLabel = el('label', 'settings__check');
    const attune = el('input');
    attune.type = 'checkbox';
    attune.checked = Boolean(item && item.attunement);
    attuneLabel.appendChild(attune);
    attuneLabel.appendChild(el('span', null, 'Требует настройки'));

    const notes = el('input', 'input');
    notes.placeholder = 'Заметка: где лежит, кому отдали…';
    notes.maxLength = 400;
    notes.value = (item && item.notes) || '';
    notes.setAttribute('aria-label', 'Заметка о предмете');

    form.appendChild(name);
    form.appendChild(qty);
    form.appendChild(weight);
    form.appendChild(owner);
    form.appendChild(attuneLabel);
    form.appendChild(notes);

    const actions = el('div', 'journal-editor__actions');
    const save = el('button', 'btn btn--accent btn--tiny', 'Сохранить');
    save.type = 'submit';
    const cancel = el('button', 'btn btn--ghost btn--tiny', 'Отмена');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      inventoryEditingId = null;
      renderInventoryPanel();
    });
    actions.appendChild(save);
    actions.appendChild(cancel);
    if (item) {
      const remove = el('button', 'btn btn--danger btn--ghost btn--tiny', 'Удалить');
      remove.type = 'button';
      remove.addEventListener('click', () => deleteInventoryItem(item.id));
      actions.appendChild(remove);
    }
    form.appendChild(actions);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      saveInventoryItem({
        ...(item ? { id: item.id } : {}),
        name: name.value.trim(),
        qty: Number(qty.value),
        weight: Number(weight.value),
        ownerId: owner.value,
        attunement: attune.checked,
        notes: notes.value.trim()
      });
    });

    return form;
  }

  function saveInventoryItem(payload) {
    if (!payload.name) return toast('Нужно название предмета', 'error');
    if (!app.socket || !app.connected) return toast('Нет соединения со столом', 'error');
    app.socket.emit('saveInventoryItem', payload, (result) => {
      if (!result || !result.ok) {
        return toast((result && result.error) || 'Не удалось сохранить предмет', 'error');
      }
      inventoryEditingId = null;
      renderInventoryPanel();
    });
  }

  function deleteInventoryItem(id) {
    if (!app.socket || !app.connected) return toast('Нет соединения со столом', 'error');
    app.socket.emit('deleteInventoryItem', { id }, (result) => {
      if (!result || !result.ok) {
        return toast((result && result.error) || 'Не удалось убрать предмет', 'error');
      }
      inventoryEditingId = null;
      renderInventoryPanel();
    });
  }

  /* ------------------------------------------------------------------ *
   * Просьбы о бросках
   * ------------------------------------------------------------------ */

  function rollRequests() {
    return app.room && Array.isArray(app.room.rollRequests) ? app.room.rollRequests : [];
  }

  /** Подпись проверки: название и, если задана, сложность. */
  function rollRequestLabel(request) {
    return request.dc ? `${request.label} (СЛ ${request.dc})` : request.label;
  }

  function requestRoll(request) {
    const formula = (request.formula || '1d20').trim() || '1d20';
    if (!dicePanel) return toast('Кубики ещё не готовы', 'error');
    toast(`Бросок: ${rollRequestLabel(request)}`);
    dicePanel.roll(formula);
  }

  /**
   * Проверки: форма и список у мастера, крупная карточка у всех.
   *
   * В тренировке ведущего нет, поэтому раздел скрыт целиком.
   */
  function renderRollRequests() {
    const requests = rollRequests();
    const isDm = app.role === 'dm';
    const panel = $('#roll-requests-panel');
    if (panel) {
      panel.hidden = !(isDm && app.room && !app.training);
      const form = $('#roll-request-form');
      if (form) form.hidden = panel.hidden;
      const list = $('#roll-requests-list');
      if (list) {
        list.innerHTML = '';
        if (!panel.hidden) {
          if (!requests.length) {
            list.appendChild(el('div', 'journal-empty muted', 'Активных проверок нет'));
          }
          for (const request of requests) {
            const row = el('div', 'roll-request-row');
            row.appendChild(el('span', 'roll-request-row__label', rollRequestLabel(request)));
            if (request.formula) {
              row.appendChild(el('span', 'roll-request-row__formula muted', request.formula));
            }
            const clear = el('button', 'btn btn--ghost btn--tiny', 'Снять');
            clear.type = 'button';
            clear.addEventListener('click', () => clearRollRequest(request.id));
            row.appendChild(clear);
            list.appendChild(row);
          }
        }
      }
    }

    const banner = $('#roll-request-banner');
    if (!banner) return;
    banner.innerHTML = '';
    banner.hidden = !(app.room && requests.length && !app.training);
    if (banner.hidden) return;
    banner.appendChild(el('div', 'roll-request-banner__title', 'Мастер просит бросок'));
    for (const request of requests) {
      const row = el('div', 'roll-request-banner__row');
      row.appendChild(el('span', 'roll-request-banner__label', rollRequestLabel(request)));
      const roll = el('button', 'btn btn--accent btn--tiny', 'Бросить');
      roll.type = 'button';
      roll.addEventListener('click', () => requestRoll(request));
      row.appendChild(roll);
      banner.appendChild(row);
    }
  }

  function sendRollRequest() {
    if (!app.socket || !app.connected) return toast('Нет соединения со столом', 'error');
    const label = $('#roll-request-label').value.trim();
    if (!label) return toast('Нужно название проверки', 'error');
    const dc = $('#roll-request-dc').value.trim();
    const formula = $('#roll-request-formula').value.trim();
    app.socket.emit('rollRequest', {
      label,
      dc: dc ? Number(dc) : null,
      formula
    }, (result) => {
      if (!result || !result.ok) {
        return toast((result && result.error) || 'Не удалось попросить бросок', 'error');
      }
      $('#roll-request-label').value = '';
      $('#roll-request-dc').value = '';
      $('#roll-request-formula').value = '';
    });
  }

  function clearRollRequest(id) {
    if (!app.socket || !app.connected) return toast('Нет соединения со столом', 'error');
    app.socket.emit('rollRequestClear', { id }, (result) => {
      if (!result || !result.ok) {
        return toast((result && result.error) || 'Не удалось снять проверку', 'error');
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Реакции: атака по возможности
   * ------------------------------------------------------------------ */

  /**
   * Запоминает повод для реакции и показывает карточку.
   *
   * Карточку получает тот, чья фишка атакует: мастер для монстров, игрок для
   * своего персонажа. Бонус и КД цели приходят из окна мастера, поэтому игроку
   * не нужны статы чужой фишки.
   * @param {object} attacker
   * @param {object} target
   * @param {{playerId?: string|null, bonus?: number, targetAc?: number|null}} [options]
   */
  function addReactionPrompt(attacker, target, options = {}) {
    if (!app.room || app.training || !attacker || !target) return;
    if (!options.playerId && app.role !== 'dm') return;
    if (options.playerId && options.playerId !== viewer().playerId) return;
    const id = options.id || `reaction-local-${reactionPromptSeq += 1}`;
    if (reactionPrompts.some((item) => item.id === id)) return;
    const wasEmpty = reactionPrompts.length === 0;
    reactionPrompts = [...reactionPrompts.slice(-4), {
      id,
      server: Boolean(options.id),
      attackerName: attacker.name || 'Противник',
      targetName: target.name || 'Фишка',
      bonus: Number(options.bonus) || 0,
      targetAc: Number(options.targetAc) > 0 ? Math.round(Number(options.targetAc)) : null
    }];
    renderReactionPrompts();
    // Панель свёрнута: карточку не видно, поэтому хотя бы коротко скажем,
    // что реакция ждёт ответа. Значок на кнопке панели остаётся до ответа.
    if (wasEmpty && panelCollapsed(RIGHT_COLLAPSED_KEY)) {
      toast(`Реакция: ${attacker.name || 'Противник'} → ${target.name || 'Фишка'}`);
    }
  }

  /** Заменяет карточки данными сервера: после переподключения и нового раунда. */
  function syncReactionPrompts(list) {
    const items = Array.isArray(list) ? list.slice(-5) : [];
    reactionPrompts = items
      .filter((item) => item && item.id)
      .map((item) => ({
        id: String(item.id),
        server: true,
        attackerName: item.attackerName || 'Противник',
        targetName: item.targetName || 'Фишка',
        bonus: Number(item.bonus) || 0,
        targetAc: Number(item.targetAc) > 0 ? Math.round(Number(item.targetAc)) : null
      }));
    renderReactionPrompts();
  }

  function removeReactionPrompt(id) {
    reactionPrompts = reactionPrompts.filter((item) => item.id !== id);
    renderReactionPrompts();
    renderReactionBadge();
  }

  /**
   * Игрок ответил или отказался. Сервер снимает карточку у всех, а локальную
   * карточку мастера снимаем только здесь.
   * @param {object} prompt
   */
  function resolveReactionPrompt(prompt) {
    if (!prompt) return;
    if (prompt.server && app.connected) {
      app.socket.emit('reactionResolved', { id: prompt.id });
    }
    removeReactionPrompt(prompt.id);
  }

  function rollReactionAttack(prompt) {
    const bonus = Number(prompt.bonus) || 0;
    emit('rollDice', {
      formula: bonus ? `d20${bonus > 0 ? '+' : ''}${bonus}` : 'd20',
      label: `Атака по возможности: ${prompt.attackerName} → ${prompt.targetName}`,
      ...(prompt.targetAc ? { targetAc: prompt.targetAc } : {})
    });
    resolveReactionPrompt(prompt);
  }

  /** Счётчик на кнопке правой панели: карточка видна, даже когда панель свёрнута. */
  function renderReactionBadge() {
    const button = $('#btn-panel-right');
    if (!button) return;
    const count = reactionPrompts.length;
    button.classList.toggle('has-reaction', count > 0);
    if (count > 0) button.dataset.count = String(count);
    else delete button.dataset.count;
  }

  function renderReactionPrompts() {
    const banner = $('#reaction-banner');
    if (!banner) return;
    const show = Boolean(app.room) && !app.training && reactionPrompts.length > 0;
    banner.hidden = !show;
    banner.innerHTML = '';
    if (!show) {
      renderReactionBadge();
      return;
    }
    banner.appendChild(el('div', 'reaction-banner__title', 'Реакция: атака по возможности'));
    for (const prompt of reactionPrompts) {
      const row = el('div', 'reaction-banner__row');
      row.appendChild(el('span', 'reaction-banner__label',
        `${prompt.attackerName} может атаковать ${prompt.targetName}`));
      const attack = el('button', 'btn btn--accent btn--tiny',
        prompt.bonus ? `Атака d20${prompt.bonus > 0 ? '+' : ''}${prompt.bonus}` : 'Атака d20');
      attack.type = 'button';
      attack.title = prompt.targetAc
        ? `Бросок против КД ${prompt.targetAc}: попадание сервер посчитает сам`
        : 'Бросок уходит в чат. Попадание и урон считает мастер.';
      attack.addEventListener('click', () => rollReactionAttack(prompt));
      row.appendChild(attack);
      const skip = el('button', 'btn btn--ghost btn--tiny', 'Пропустить');
      skip.type = 'button';
      skip.addEventListener('click', () => resolveReactionPrompt(prompt));
      row.appendChild(skip);
      banner.appendChild(row);
    }
    banner.appendChild(el('div', 'reaction-banner__note',
      'Существо покинуло досягаемость и потратило реакцию этого раунда.'));
    renderReactionBadge();
  }

  /* ------------------------------------------------------------------ *
   * Поиск по кампании
   * ------------------------------------------------------------------ */

  /** Всё, что ищется: журнал, чат с подписями картинок и склад. */
  function campaignSearchResults(query) {
    const text = String(query || '').trim().toLowerCase();
    if (!text) return [];
    const groups = [];
    const match = (...parts) => parts.join(' ').toLowerCase().includes(text);

    const journal = journalEntries()
      .filter((entry) => match(entry.title, entry.text, ...(entry.tags || [])))
      .slice(0, 6);
    if (journal.length) {
      groups.push({
        title: 'Журнал',
        items: journal.map((entry) => ({
          key: `journal-${entry.id}`,
          title: entry.title,
          note: entry.text || journalKindLabel(entry.kind),
          open: () => {
            if (app.role !== 'dm') return;
            journalEditingId = entry.id;
            renderJournalPanel();
            const box = $('#journal-panel');
            if (box) box.scrollIntoView({ block: 'nearest' });
          }
        }))
      });
    }

    const chat = app.room.chatHistory
      .filter((message) => match(message.from || '', message.text || ''))
      .slice(-6)
      .reverse()
      .map((message) => ({
        key: `chat-${message.time}-${message.playerId}`,
        title: message.from || 'Стол',
        note: message.text || 'Картинка',
        open: () => {
          if (panelCollapsed(RIGHT_COLLAPSED_KEY)) setPanelCollapsed('right', false);
          activateTab('chat');
          if (!chatPanel) return;
          if (chatPanel.searchInput) chatPanel.searchInput.value = text;
          chatPanel.setQuery(text);
          const hit = $('#tab-chat .chat__msg.is-hit');
          if (hit) hit.scrollIntoView({ block: 'center' });
        }
      }));
    if (chat.length) groups.push({ title: 'Чат', items: chat });

    const inventory = inventoryItems()
      .filter((item) => match(item.name, item.notes))
      .slice(0, 6)
      .map((item) => ({
        key: `inventory-${item.id}`,
        title: item.name,
        note: [item.notes, inventoryOwnerLabel(item.ownerId)].filter(Boolean).join(' · '),
        open: () => {
          const panel = $('#inventory-panel');
          if (panel) panel.scrollIntoView({ block: 'nearest' });
          renderInventoryPanel();
          const row = document.querySelector(`#inventory-list [data-item-id="${item.id}"]`);
          if (!row) return;
          row.classList.add('is-hit');
          row.scrollIntoView({ block: 'center' });
          setTimeout(() => row.classList.remove('is-hit'), 2000);
        }
      }));
    if (inventory.length) groups.push({ title: 'Склад', items: inventory });

    // Справочник приключения: искать НПС и предметы посреди игры приходится
    // чаще, чем листать вкладку. Мастеру он и доступен.
    const adventure = app.role === 'dm' ? app.adventure : null;
    if (adventure) {
      const found = [];
      for (const section of ADVENTURE_SECTIONS) {
        for (const item of (adventure[section.key] || [])) {
          if (!match(item.title, item.name, item.text, item.description)) continue;
          found.push({ section, item });
        }
      }
      if (found.length) {
        groups.push({
          title: 'Приключение',
          items: found.slice(0, 6).map(({ section, item }) => {
            const name = item.title || item.name || 'Без названия';
            return {
              key: `adventure-${section.key}-${name}`,
              title: name,
              note: section.label,
              open: () => {
                activateTab('adventure');
                // Сужаем список до найденного и подсвечиваем саму карточку:
                // отфильтрованный раздел ещё надо найти глазами.
                const input = $('#tab-adventure .adv-search');
                if (!input) return;
                input.value = name;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                setTimeout(() => {
                  const card = [...document.querySelectorAll('#tab-adventure .adv-item[data-adv-name]')]
                    .find((node) => node.dataset.advName === name);
                  if (!card) return;
                  card.classList.add('is-hit');
                  card.scrollIntoView({ block: 'center' });
                  setTimeout(() => card.classList.remove('is-hit'), 2000);
                }, 180);
              }
            };
          })
        });
      }
    }

    // Листы персонажей: имя, класс, раса и заметки.
    const sheets = Object.entries(app.room.sheets || {})
      .map(([playerId, sheet]) => {
        const player = app.room.players.find((entry) => entry.playerId === playerId);
        return { playerId, sheet, player };
      })
      .filter(({ sheet, player }) => match(
        sheet.characterName, sheet.playerName, sheet.charClass, sheet.race,
        sheet.background, sheet.notes, player && player.name
      ))
      .slice(0, 6);
    if (sheets.length) {
      groups.push({
        title: 'Листы',
        items: sheets.map(({ playerId, sheet, player }) => ({
          key: `sheet-${playerId}`,
          title: sheet.characterName || (player && player.name) || 'Лист персонажа',
          note: [sheet.charClass, sheet.race, player && player.name].filter(Boolean).join(' · '),
          open: () => {
            if (app.role === 'dm') openPlayerSheet(playerId);
            else activateTab('sheet');
          }
        }))
      });
    }

    return groups;
  }

  /**
   * Шпаргалка по горячим клавишам по «?».
   *
   * Клавиши есть, но узнать о них можно только из кода: в интерфейсе они
   * нигде не перечислены. Отдельное окно дешевле, чем раздел в настройках.
   */
  function openShortcuts() {
    if ($('#shortcuts-overlay')) return;
    const overlay = el('div', 'modal-overlay');
    overlay.id = 'shortcuts-overlay';
    const box = el('div', 'modal modal--shortcuts');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Горячие клавиши');
    const release = trapFocus(box);
    box.appendChild(el('div', 'modal__title', 'Горячие клавиши'));

    const rows = [
      ['1 … 9', 'Переключить вкладку'],
      ['Ctrl + K', 'Поиск по кампании'],
      ['Ctrl + F', 'Поиск по чату'],
      ['← ↑ → ↓', 'Двинуть выбранную фишку на клетку'],
      ['?', 'Эта шпаргалка'],
      ['Esc', 'Закрыть окно или меню']
    ];
    const list = el('div', 'shortcuts');
    for (const [keys, label] of rows) {
      const row = el('div', 'shortcuts__row');
      row.appendChild(el('span', 'shortcuts__label', label));
      row.appendChild(el('kbd', 'shortcuts__keys', keys));
      list.appendChild(row);
    }
    box.appendChild(list);

    const close = () => {
      document.removeEventListener('keydown', onKey);
      release();
      overlay.remove();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) close();
    });
    const done = el('button', 'btn btn--accent', 'Понятно');
    done.type = 'button';
    done.addEventListener('click', close);
    box.appendChild(done);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    done.focus();
  }

  /** Модальное окно поиска: открывается кнопкой и Ctrl+K. */
  function openSearch() {
    if (!app.room) return;
    const existing = $('#campaign-search-overlay');
    if (existing) {
      const field = existing.querySelector('input');
      if (field) field.focus();
      return;
    }

    const overlay = el('div', 'modal-overlay');
    overlay.id = 'campaign-search-overlay';
    const box = el('div', 'modal modal--search');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Поиск по кампании');
    const release = trapFocus(box);
    box.appendChild(el('div', 'modal__title', 'Поиск по кампании'));
    const input = el('input', 'input');
    input.type = 'search';
    input.placeholder = 'Журнал, чат, склад, NPC, листы…';
    input.setAttribute('aria-label', 'Поиск по кампании');
    box.appendChild(input);
    const results = el('div', 'search-results');
    box.appendChild(results);
    overlay.appendChild(box);

    const close = () => {
      document.removeEventListener('keydown', onKey);
      release();
      overlay.remove();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) close();
    });

    const render = () => {
      results.innerHTML = '';
      const query = input.value;
      if (!query.trim()) {
        results.appendChild(el('div', 'journal-empty muted',
          'Начните печатать: ищем в журнале, чате, складе, приключении и листах'));
        return;
      }
      const groups = campaignSearchResults(query);
      if (!groups.length) {
        results.appendChild(el('div', 'journal-empty muted', 'Ничего не найдено'));
        return;
      }
      for (const group of groups) {
        results.appendChild(el('div', 'search-group__title', group.title));
        for (const item of group.items) {
          const row = el('button', 'search-result');
          row.type = 'button';
          row.dataset.searchKey = item.key;
          row.appendChild(el('span', 'search-result__title', item.title));
          if (item.note) row.appendChild(el('span', 'search-result__note muted', item.note));
          row.addEventListener('click', () => {
            close();
            item.open();
          });
          results.appendChild(row);
        }
      }
    };

    input.addEventListener('input', render);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        const first = results.querySelector('.search-result');
        if (first) first.click();
      }
    });

    document.body.appendChild(overlay);
    input.focus();
    // Старый запрос мог остаться в поле после перерисовки: рисуем сразу.
    render();
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
    // QR рисует main-процесс: в renderer нет библиотеки кодирования.
    if (window.desktop && window.desktop.irohTicketQr) {
      const qr = el('img', 'addr__qr');
      qr.alt = 'QR-код P2P-билета';
      qr.hidden = true;
      row.appendChild(qr);
      window.desktop.irohTicketQr(ticket).then((result) => {
        if (result && result.ok && result.dataUrl) {
          qr.src = result.dataUrl;
          qr.hidden = false;
        }
      }).catch(() => {});
    }
    block.appendChild(row);
    root.appendChild(block);
    applyAddressesCollapsed();
  }

  /* ------------------------------------------------------------------ *
   * Настройки и панель адресов
   * ------------------------------------------------------------------ */

  let settingsGridInput = null;
  let settingsGridFields = null;
  let settingsPanelPosition = null;

  /** Выбранный интервал автосохранения кампании в секундах. */
  function autosaveSeconds() {
    const saved = Number(localStorage.getItem(AUTOSAVE_KEY));
    return AUTOSAVE_CHOICES.includes(saved) ? saved : AUTOSAVE_DEFAULT_SECONDS;
  }

  /**
   * Запоминает интервал автосохранения и сообщает его main-процессу.
   * Пока стол не запущен, таймера нет, и значение подхватится при старте.
   * @param {number} seconds
   */
  function applyAutosaveSeconds(seconds) {
    localStorage.setItem(AUTOSAVE_KEY, String(seconds));
    if (desktop && typeof desktop.setAutosaveInterval === 'function') {
      desktop.setAutosaveInterval(seconds);
    }
  }

  /**
   * Окно настроек — одно и то же на главном экране и за столом.
   * Здесь же будет выбор языка, когда в приложении появится второй.
   */
  function openSettings() {
    const overlay = el('div', 'modal-overlay');
    const box = el('div', 'modal modal--settings');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Настройки');
    box.tabIndex = -1;
    const release = trapFocus(box);
    box.appendChild(el('div', 'modal__title', 'Настройки'));

    // Разделы вместо одной длинной колонки: у каждого своя вкладка слева.
    // Панели остаются в DOM и только скрываются, поэтому обработчики и
    // значения полей не теряются при переключении.
    const sectionMeta = [];
    const settingsBody = el('div', 'settings');
    const settingsNav = el('div', 'settings__nav');
    settingsNav.setAttribute('role', 'tablist');
    settingsNav.setAttribute('aria-orientation', 'vertical');
    settingsNav.setAttribute('aria-label', 'Разделы настроек');
    const settingsContent = el('div', 'settings__content');
    settingsBody.appendChild(settingsNav);
    settingsBody.appendChild(settingsContent);

    function selectSection(id, focusTab) {
      const active = sectionMeta.find((item) => item.id === id) || sectionMeta[0];
      if (!active) return;
      for (const item of sectionMeta) {
        const on = item === active;
        item.tab.classList.toggle('is-active', on);
        item.tab.setAttribute('aria-selected', String(on));
        item.tab.tabIndex = on ? 0 : -1;
        item.panel.hidden = !on;
      }
      localStorage.setItem(SETTINGS_SECTION_KEY, active.id);
      settingsContent.scrollTop = 0;
      if (focusTab) active.tab.focus();
    }

    const addSection = (id, title) => {
      const tab = el('button', 'settings__tab', title);
      tab.type = 'button';
      tab.id = `settings-tab-${id}`;
      tab.dataset.settingsSection = id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', 'false');
      tab.setAttribute('aria-controls', `settings-panel-${id}`);
      tab.tabIndex = -1;
      const panel = el('div', 'settings__panel');
      panel.id = `settings-panel-${id}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      panel.hidden = true;
      tab.addEventListener('click', () => selectSection(id));
      settingsNav.appendChild(tab);
      settingsContent.appendChild(panel);
      sectionMeta.push({ id, tab, panel });
      return panel;
    };

    settingsNav.addEventListener('keydown', (event) => {
      const index = sectionMeta.findIndex((item) => item.tab === document.activeElement);
      if (index < 0) return;
      let next = null;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % sectionMeta.length;
      else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + sectionMeta.length) % sectionMeta.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = sectionMeta.length - 1;
      if (next === null) return;
      event.preventDefault();
      selectSection(sectionMeta[next].id, true);
    });

    const generalPanel = addSection('general', 'Общие');
    const tablePanel = addSection('table', 'Стол');
    const campaignPanel = (app.campaign || (app.role === 'dm' && app.room))
      ? addSection('campaign', 'Кампания')
      : null;
    const appearancePanel = addSection('appearance', 'Оформление');
    const soundPanel = addSection('sound', 'Звук');
    const a11yPanel = addSection('accessibility', 'Доступность');
    box.appendChild(settingsBody);

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

    // Автосохранение кампании. Таймер живёт в main-процессе, здесь только
    // выбор; на Android стола нет, и строки тоже нет.
    if (typeof desktop.setAutosaveInterval === 'function') {
      const autosaveRow = el('div', 'settings__row');
      autosaveRow.appendChild(el('span', 'settings__label', 'Автосохранение'));
      const autosaveSelect = el('select', 'select settings__select');
      autosaveSelect.dataset.setting = 'autosave';
      for (const seconds of AUTOSAVE_CHOICES) {
        const label = seconds < 60 ? `${seconds} секунд` : `${seconds / 60} мин`;
        const option = el('option', null, label);
        option.value = String(seconds);
        autosaveSelect.appendChild(option);
      }
      autosaveSelect.value = String(autosaveSeconds());
      autosaveSelect.addEventListener('change', () => {
        const seconds = Number(autosaveSelect.value);
        applyAutosaveSeconds(seconds);
        toast(`Автосохранение: раз в ${seconds < 60 ? `${seconds} секунд` : `${seconds / 60} мин`}`, 'ok');
      });
      autosaveRow.appendChild(autosaveSelect);
      appBox.appendChild(autosaveRow);
      appBox.appendChild(el('div', 'box__note',
        'Действует, когда вы ведёте стол: чаще — меньше теряется при сбое, '
        + 'реже — тише работа с диском.'));
    }

    if (app.campaign) {
      // Копии: сколько их и когда последняя. Кроме счётчика нужен список,
      // иначе восстановление оставалось бы ручной работой с папками.
      const backupsRow = el('div', 'settings__row');
      backupsRow.appendChild(el('span', 'settings__label', 'Копии кампании'));
      const backupsValue = el('span', 'settings__value', '…');
      backupsRow.appendChild(backupsValue);
      campaignPanel.appendChild(backupsRow);
      const copiesList = el('div', 'settings__backups');
      copiesList.hidden = true;
      campaignPanel.appendChild(copiesList);

      const refreshBackups = () => {
        if (typeof desktop.backupInfo !== 'function') return;
        desktop.backupInfo().then((info) => {
          if (!info || !info.ok) {
            backupsValue.textContent = 'нет данных';
            copiesList.hidden = true;
            return;
          }
          const when = info.lastAt
            ? new Date(info.lastAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
            : null;
          backupsValue.textContent = info.count
            ? `${info.count} из 5, последняя ${when}`
            : 'пока ни одной';
          copiesList.innerHTML = '';
          const items = Array.isArray(info.items) ? info.items : [];
          for (const copy of items) {
            const row = el('div', 'settings__backup');
            row.appendChild(el('span', 'settings__backup-date',
              new Date(copy.at).toLocaleString('ru-RU', {
                day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
              })));
            // Без моста restoreBackup (Android, старый preload) список остаётся
            // справочным: кнопка, которая ничего не делает, хуже её отсутствия.
            if (typeof desktop.restoreBackup === 'function') {
              const restore = el('button', 'btn btn--tiny', 'Вернуть');
              restore.type = 'button';
              restore.title = 'Заменить текущую кампанию этой копией';
              restore.addEventListener('click', async () => {
                const answer = await modal({
                  title: 'Восстановить копию?',
                  message: 'Текущее состояние кампании будет заменено копией. '
                    + 'Сам стол остановится, а окно откроется заново.',
                  confirmLabel: 'Восстановить',
                  danger: true
                });
                if (!answer) return;
                const result = await desktop.restoreBackup(app.campaign.id, copy.name);
                if (!result || !result.ok) {
                  toast((result && result.error) || 'Не удалось восстановить копию', 'error');
                  return;
                }
                toast('Кампания восстановлена. Открываю заново…', 'ok');
                setTimeout(() => location.reload(), 600);
              });
              row.appendChild(restore);
            }
            copiesList.appendChild(row);
          }
          copiesList.hidden = !items.length;
        }).catch(() => { backupsValue.textContent = 'нет данных'; });
      };
      refreshBackups();

      const backupButton = el('button', 'btn btn--tiny', 'Сохранить копию кампании');
      backupButton.type = 'button';
      backupButton.title = 'Копия папки кампании со всеми картинками в data/backups';
      backupButton.addEventListener('click', async () => {
        const result = await desktop.backupCampaign();
        if (!result || !result.ok) {
          toast((result && result.error) || 'Не удалось сделать копию', 'error');
          return;
        }
        toast(`Копия кампании: ${result.dir}`, 'ok');
        refreshBackups();
      });
      campaignPanel.appendChild(backupButton);
      if (desktop && typeof desktop.exportCampaign === 'function') {
        const exportButton = el('button', 'btn btn--tiny', 'Экспортировать кампанию в папку');
        exportButton.type = 'button';
        exportButton.title = 'Копия кампании для другого компьютера: campaign.json и все картинки';
        exportButton.addEventListener('click', async () => {
          const result = await desktop.exportCampaign();
          if (!result || result.canceled) return;
          if (!result.ok) {
            toast((result && result.error) || 'Не удалось экспортировать кампанию', 'error');
            return;
          }
          toast(`Кампания сохранена: ${result.dir}`, 'ok');
        });
        campaignPanel.appendChild(exportButton);
      }
      if (typeof desktop.openBackups === 'function') {
        const openBackups = el('button', 'btn btn--tiny', 'Открыть папку копий');
        openBackups.type = 'button';
        openBackups.addEventListener('click', () => desktop.openBackups());
        campaignPanel.appendChild(openBackups);
      }
      campaignPanel.appendChild(el('div', 'box__note',
        'Копия делается сама при первом запуске стола за сутки. Хранятся пять последних. '
        + '«Вернуть» заменяет кампанию выбранной копией.'));
      if (app.role) {
        const exportButton = el('button', 'btn btn--tiny', 'Экспорт сессии в Markdown');
        exportButton.type = 'button';
        exportButton.title = 'Журнал, чат и броски в одном файле';
        exportButton.addEventListener('click', exportSession);
        campaignPanel.appendChild(exportButton);
      }
    }

    // Имя за столом. У мастера оно по умолчанию «Мастер», и под таким именем
    // он остаётся во всех заметках и разговорах, если не задал своё.
    const nameRow = el('div', 'settings__row');
    const nameLabel = el('label', 'settings__check');
    const nameInput = el('input', 'input settings__input');
    nameInput.type = 'text';
    nameInput.maxLength = String(DnD.LIMITS.maxNameLength);
    nameInput.placeholder = app.role === 'dm' ? 'Мастер' : 'Игрок';
    nameInput.value = storedName();
    nameInput.title = 'Имя видят все за столом';
    nameLabel.appendChild(nameInput);
    nameLabel.appendChild(el('span', null, 'Ваше имя за столом'));
    nameRow.appendChild(nameLabel);
    const nameSave = el('button', 'btn btn--tiny', 'Сохранить');
    nameSave.type = 'button';
    nameSave.addEventListener('click', () => {
      if (!applyMyName(nameInput.value)) return;
      nameInput.value = storedName();
      toast(app.socket && app.connected ? 'Имя изменено' : 'Имя сохранено', 'ok');
    });
    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') nameSave.click();
    });
    nameRow.appendChild(nameSave);
    appBox.appendChild(nameRow);
    appBox.appendChild(el('div', 'box__note',
      app.connected
        ? 'Меняется сразу у всех участников стола.'
        : 'Сохранится и пригодится, когда вы запустите стол или подключитесь.'));
    generalPanel.appendChild(appBox);

    if (app.role === 'dm' && app.room && campaignPanel) {
      // Часы кампании: мастер ставит время сам, кнопки двигают его на час или
      // на долгий отдых. Игроки видят то же время в шапке стола.
      const timeBox = el('div', 'box');
      timeBox.appendChild(el('div', 'box__title', 'Время в игре'));
      const timeRow = el('div', 'settings__row');
      const timeInput = (label, value, min, max) => {
        const wrap = el('label', 'settings__check');
        wrap.appendChild(el('span', null, label));
        const input = el('input', 'input settings__input');
        input.type = 'number';
        input.min = String(min);
        input.max = String(max);
        input.value = String(value);
        wrap.appendChild(input);
        timeRow.appendChild(wrap);
        return input;
      };
      const current = gameTime();
      const dayInput = timeInput('День', current.day, 1, 9999);
      const hourInput = timeInput('Час', current.hour, 0, 23);
      timeBox.appendChild(timeRow);
      const timeActions = el('div', 'inline-row');
      const read = () => ({
        day: DnD.clampNumber(dayInput.value, 1, 9999, 1),
        hour: DnD.clampNumber(hourInput.value, 0, 23, 8)
      });
      const apply = (next) => {
        dayInput.value = String(next.day);
        hourInput.value = String(next.hour);
        sendGameTime(next);
      };
      const plusHour = el('button', 'btn btn--tiny', '+1 час');
      plusHour.type = 'button';
      plusHour.addEventListener('click', () => apply(shiftGameTime(read(), 1)));
      const plusRest = el('button', 'btn btn--tiny', '+8 часов');
      plusRest.type = 'button';
      plusRest.title = 'Сдвинуть время на 8 часов';
      plusRest.addEventListener('click', () => apply(shiftGameTime(read(), 8)));
      const restParty = el('button', 'btn btn--tiny', 'Долгий отдых партии');
      restParty.type = 'button';
      restParty.title = 'Вылечить всю партию и сдвинуть время на 8 часов';
      restParty.addEventListener('click', () => partyLongRest());
      const saveTime = el('button', 'btn btn--accent btn--tiny', 'Сохранить');
      saveTime.type = 'button';
      saveTime.addEventListener('click', () => apply(read()));
      timeActions.appendChild(plusHour);
      timeActions.appendChild(plusRest);
      timeActions.appendChild(restParty);
      timeActions.appendChild(saveTime);
      timeBox.appendChild(timeActions);
      timeBox.appendChild(el('div', 'box__note',
        'Видят все участники. Само время не идёт: его двигает мастер, а долгий отдых лечит партию и переводит часы на 8 часов вперёд.'));
      campaignPanel.appendChild(timeBox);

      const journalBox = el('div', 'box');
      journalBox.appendChild(el('div', 'box__title', 'Журнал кампании'));
      const journal = el('textarea', 'input settings__textarea');
      journal.rows = 8;
      journal.value = app.room.journal || '';
      journal.placeholder = 'Что случилось в этой кампании: сюжет, обещания, планы на следующую игру…';
      journalBox.appendChild(journal);
      const saveJournal = el('button', 'btn btn--tiny', 'Сохранить журнал');
      saveJournal.type = 'button';
      saveJournal.addEventListener('click', () => {
        app.room.journal = journal.value;
        if (!app.socket || !app.connected) {
          toast('Журнал сохранится вместе с кампанией', 'ok');
          return;
        }
        app.socket.emit('saveJournal', { text: journal.value }, (result) => {
          if (result && result.ok) toast('Журнал сохранён', 'ok');
          else toast((result && result.error) || 'Не удалось сохранить журнал', 'error');
        });
      });
      journalBox.appendChild(saveJournal);
      journalBox.appendChild(el('div', 'box__note',
        'Журнал видит только мастер. Он сохраняется вместе с кампанией.'));
      campaignPanel.insertBefore(journalBox, campaignPanel.firstChild);
    }

    /** Строка с галочкой: одинаково выглядит для движения, фокуса и звука. */
    const settingsCheck = (label, checked, setting, onChange) => {
      const row = el('div', 'settings__row');
      const wrap = el('label', 'settings__check');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = checked;
      input.dataset.setting = setting;
      input.addEventListener('change', () => onChange(input.checked));
      wrap.appendChild(input);
      wrap.appendChild(el('span', null, label));
      row.appendChild(wrap);
      return row;
    };

    // Присутствие в Discord: только настольная версия. Android-мост метод не
    // объявляет, поэтому одной проверки моста достаточно.
    if (desktop && typeof desktop.setPresence === 'function') {
      const discordBox = el('div', 'box');
      discordBox.appendChild(el('div', 'box__title', 'Discord'));
      discordBox.appendChild(settingsCheck(
        'Показывать игру в Discord',
        presenceEnabled(),
        'discord-presence',
        (on) => {
          localStorage.setItem(PRESENCE_KEY, on ? '1' : '0');
          syncPresence();
          toast(on ? 'Discord: игра видна друзьям' : 'Discord: присутствие выключено', 'ok');
        }
      ));
      discordBox.appendChild(el('div', 'box__note',
        'Друзья и участники общих серверов увидят название кампании и имя персонажа. '
        + 'Карта, чат и P2P-билет не показываются.'));
      generalPanel.appendChild(discordBox);
    }

    // Обновления: только установленная Windows-версия. Портативная и Android
    // обновляются вручную, поэтому кнопка им не нужна.
    if (config.canUpdate && desktop && typeof desktop.checkForUpdates === 'function') {
      const updateBox = el('div', 'box');
      updateBox.appendChild(el('div', 'box__title', 'Обновления'));
      const updateRow = el('div', 'settings__row');
      const updateButton = el('button', 'btn btn--tiny', 'Проверить обновления');
      updateButton.type = 'button';
      updateButton.dataset.setting = 'check-updates';
      const updateStatus = el('span', 'settings__value settings__update-status',
        `Версия ${config.versionLabel || config.version || '—'}`);
      updateButton.addEventListener('click', async () => {
        updateButton.disabled = true;
        updateStatus.textContent = 'Проверяю…';
        try {
          const result = await desktop.checkForUpdates();
          if (!result || !result.ok) {
            updateStatus.textContent = (result && result.error)
              || 'Не удалось проверить обновления.';
            return;
          }
          if (result.state === 'latest') {
            updateStatus.textContent = `Установлена последняя версия ${result.version}.`;
          } else if (result.state === 'downloading') {
            updateStatus.textContent = `Скачивается версия ${result.version}…`;
          } else if (result.state === 'downloaded') {
            updateStatus.textContent = `Версия ${result.version} скачана. Перезапустите игру.`;
          } else {
            updateStatus.textContent = 'Проверка уже идёт…';
          }
        } catch (error) {
          updateStatus.textContent = 'Не удалось проверить обновления.';
        } finally {
          updateButton.disabled = false;
        }
      });
      updateRow.appendChild(updateButton);
      updateRow.appendChild(updateStatus);
      updateBox.appendChild(updateRow);
      updateBox.appendChild(el('div', 'box__note',
        'Обновления проверяются сами раз в четыре часа. Новая версия скачивается '
        + 'в фоне, после чего игра предложит перезапуск.'));
      generalPanel.appendChild(updateBox);
    }

    const themeBox = el('div', 'box');
    // Перерисовываем только этот блок: смена тона меняет и превью, и набор
    // безопасных акцентов, но не должна закрывать всё окно настроек.
    const renderThemeBox = () => {
      themeBox.textContent = '';
      themeBox.appendChild(el('div', 'box__title', 'Оформление'));

      const toneRow = el('div', 'settings__row');
      toneRow.appendChild(el('span', 'settings__label', 'Тон'));
      const toneSeg = el('div', 'settings__seg');
      for (const [id, label] of [['dark', 'Тёмная'], ['light', 'Светлая']]) {
        const button = el('button', null, label);
        button.type = 'button';
        button.dataset.setting = 'tone';
        button.dataset.tone = id;
        if (window.DnDTheme.currentTone() === id) button.classList.add('is-on');
        button.addEventListener('click', () => {
          window.DnDTheme.setTone(id);
          renderThemeBox();
        });
        toneSeg.appendChild(button);
      }
      toneRow.appendChild(toneSeg);
      themeBox.appendChild(toneRow);

      const grid = el('div', 'theme-grid');
      grid.dataset.setting = 'theme';
      const tone = window.DnDTheme.currentTone();
      for (const theme of window.DnDTheme.THEMES) {
        const preview = tone === 'light' ? theme.previewLight : theme.preview;
        const card = el('button', 'theme-card');
        card.type = 'button';
        card.dataset.themeId = theme.id;
        if (theme.id === window.DnDTheme.current()) card.classList.add('is-active');
        card.style.setProperty('--pv-bg', preview.bg);
        card.style.setProperty('--pv-surface', preview.surface);
        card.style.setProperty('--pv-accent', preview.accent);
        card.style.setProperty('--pv-text', preview.text);
        card.appendChild(el('span', 'theme-card__scene'));
        card.appendChild(el('span', 'theme-card__label', theme.label));
        card.appendChild(el('span', 'theme-card__note', theme.note));
        card.addEventListener('click', () => {
          window.DnDTheme.apply(theme.id);
          renderThemeBox();
        });
        grid.appendChild(card);
      }
      themeBox.appendChild(grid);

      const accentRow = el('div', 'settings__row');
      accentRow.appendChild(el('span', 'settings__label', 'Акцент'));
      const accents = el('div', 'accent-row');
      const chosen = window.DnDTheme.accentFor(window.DnDTheme.current());
      for (const accent of window.DnDTheme.accentChoices(window.DnDTheme.current())) {
        const swatch = el('button', 'accent-swatch');
        swatch.type = 'button';
        swatch.dataset.setting = 'accent';
        swatch.dataset.accent = accent.color;
        swatch.title = accent.label;
        swatch.setAttribute('aria-label', accent.label);
        swatch.style.setProperty('--swatch', accent.color);
        if (chosen === accent.color) swatch.classList.add('is-on');
        swatch.addEventListener('click', () => {
          window.DnDTheme.setAccent(window.DnDTheme.current(), accent.color);
          renderThemeBox();
        });
        accents.appendChild(swatch);
      }
      const resetAccent = el('button', 'accent-reset', 'Как в теме');
      resetAccent.type = 'button';
      resetAccent.dataset.setting = 'accent-reset';
      resetAccent.addEventListener('click', () => {
        window.DnDTheme.clearAccent(window.DnDTheme.current());
        renderThemeBox();
      });
      accents.appendChild(resetAccent);
      accentRow.appendChild(accents);
      themeBox.appendChild(accentRow);

      themeBox.appendChild(settingsCheck(
        'Минимализм: без текстур и орнамента',
        window.DnDTheme.focusOn(),
        'focus',
        (on) => window.DnDTheme.setFocus(on)
      ));
      themeBox.appendChild(settingsCheck(
        'Анимации интерфейса',
        window.DnDTheme.motionOn(),
        'motion',
        (on) => window.DnDTheme.setMotion(on)
      ));
      themeBox.appendChild(el('div', 'box__note',
        'Тема, тон и акцент меняются сразу у вас на этом компьютере и в окне листа персонажа.'));
    };
    renderThemeBox();
    appearancePanel.appendChild(themeBox);

    const soundBox = el('div', 'box');
    soundBox.appendChild(el('div', 'box__title', 'Звук'));
    const sound = window.DnDSound;
    if (!sound) {
      soundBox.appendChild(el('div', 'box__note', 'Звук недоступен в этом окне.'));
    } else {
      soundBox.appendChild(settingsCheck(
        'Звук интерфейса',
        sound.enabled(),
        'sound',
        (on) => sound.setEnabled(on)
      ));
      soundBox.appendChild(settingsCheck(
        'Звуки темы на главном экране',
        sound.ambientEnabled(),
        'ambient',
        (on) => sound.setAmbient(on)
      ));

      const skinRow = el('div', 'settings__row');
      skinRow.appendChild(el('span', 'settings__label', 'Скин'));
      const skinSelect = el('select', 'select settings__select');
      skinSelect.dataset.setting = 'sound-skin';
      for (const item of sound.SKINS) {
        const option = el('option', null, item.label);
        option.value = item.id;
        skinSelect.appendChild(option);
      }
      skinSelect.value = sound.skin();
      skinSelect.addEventListener('change', () => sound.setSkin(skinSelect.value));
      skinRow.appendChild(skinSelect);
      const testSound = el('button', 'btn btn--tiny settings__sound-test', 'Проверить');
      testSound.type = 'button';
      testSound.dataset.soundSkip = '';
      testSound.addEventListener('click', () => sound.preview());
      skinRow.appendChild(testSound);
      const testAmbient = el('button', 'btn btn--tiny settings__sound-test', 'Атмосфера');
      testAmbient.type = 'button';
      testAmbient.dataset.soundSkip = '';
      testAmbient.title = 'Послушать звуки выбранной темы четыре секунды';
      testAmbient.addEventListener('click', () => sound.previewAmbient());
      skinRow.appendChild(testAmbient);
      soundBox.appendChild(skinRow);

      const volumeRow = el('div', 'settings__row');
      volumeRow.appendChild(el('span', 'settings__label', 'Громкость'));
      const volume = el('input', 'settings__range');
      volume.type = 'range';
      volume.min = '0';
      volume.max = '100';
      volume.step = '5';
      volume.value = String(Math.round(sound.volume() * 100));
      volume.dataset.setting = 'sound-volume';
      const volumeValue = el('span', 'settings__value', `${volume.value}%`);
      volume.addEventListener('input', () => {
        sound.setVolume(volume.value);
        volumeValue.textContent = `${volume.value}%`;
      });
      volumeRow.appendChild(volume);
      volumeRow.appendChild(volumeValue);
      soundBox.appendChild(volumeRow);

      const ambientRow = el('div', 'settings__row');
      ambientRow.appendChild(el('span', 'settings__label', 'Громкость атмосферы'));
      const ambientVolume = el('input', 'settings__range');
      ambientVolume.type = 'range';
      ambientVolume.min = '0';
      ambientVolume.max = '100';
      ambientVolume.step = '5';
      ambientVolume.value = String(Math.round(sound.ambientVolume() * 100));
      ambientVolume.dataset.setting = 'sound-ambient-volume';
      const ambientVolumeValue = el('span', 'settings__value', `${ambientVolume.value}%`);
      ambientVolume.addEventListener('input', () => {
        sound.setAmbientVolume(ambientVolume.value);
        ambientVolumeValue.textContent = `${ambientVolume.value}%`;
      });
      ambientRow.appendChild(ambientVolume);
      ambientRow.appendChild(ambientVolumeValue);
      soundBox.appendChild(ambientRow);
      soundBox.appendChild(el('div', 'box__note',
        'Щелчки не привязаны к теме. Атмосфера главного экрана подстраивается: '
        + 'лес шумит ветром и птицами, океан дышит прибоем, магия звенит, '
        + 'стимпанк шипит паром. Звук включается после первого клика.'));
    }
    soundPanel.appendChild(soundBox);

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
    generalPanel.appendChild(langBox);

    const a11yBox = el('div', 'box');
    a11yBox.appendChild(el('div', 'box__title', 'Доступность'));
    const a11yScaleRow = el('div', 'settings__row');
    a11yScaleRow.appendChild(el('span', 'settings__label', 'Масштаб'));
    const scaleSelect = el('select', 'select settings__select');
    scaleSelect.dataset.setting = 'a11y-scale';
    for (const scale of window.DnDTheme.SCALES) {
      const option = el('option', null, scale === 1 ? 'Обычный (100%)' : `${Math.round(scale * 100)}%`);
      option.value = String(scale);
      scaleSelect.appendChild(option);
    }
    scaleSelect.value = String(window.DnDTheme.fontScale());
    scaleSelect.addEventListener('change', () => {
      window.DnDTheme.setFontScale(Number(scaleSelect.value));
    });
    a11yScaleRow.appendChild(scaleSelect);
    a11yBox.appendChild(a11yScaleRow);

    a11yBox.appendChild(settingsCheck(
      'Высокий контраст: ярче текст и рамки',
      window.DnDTheme.contrastOn(),
      'a11y-contrast',
      (on) => window.DnDTheme.setContrast(on)
    ));
    a11yBox.appendChild(settingsCheck(
      'Палитра для дальтоников: успех и опасность не красным и зелёным',
      window.DnDTheme.colorblindOn(),
      'a11y-colorblind',
      (on) => window.DnDTheme.setColorblind(on)
    ));
    // Настройки общие с окном журнала и листа: theme.js там тот же, а значит,
    // масштаб и контраст подхватятся и в них без отдельного кода.
    a11yBox.appendChild(el('div', 'box__note',
      'Применяется сразу на этом компьютере и в окнах журнала и листа. '
      + 'Полный английский интерфейс пока не готов.'));
    a11yPanel.appendChild(a11yBox);

    const tableBox = el('div', 'box');
    tableBox.appendChild(el('div', 'box__title', 'Стол'));

    // Положение панели вкладок. На широком мониторе удобнее сбоку, на высоком
    // под картой: выбирает мастер, и выбор переживает перезапуск.
    const positionRow = el('div', 'settings__row');
    const positionSelect = el('select', 'select settings__select');
    positionSelect.dataset.setting = 'panelPosition';
    for (const [value, label] of [['right', 'Справа от карты'], ['bottom', 'Снизу под картой']]) {
      const option = el('option', null, label);
      option.value = value;
      if (value === rightPanelPosition()) option.selected = true;
      positionSelect.appendChild(option);
    }
    positionSelect.addEventListener('change', () => {
      applyPanelPosition(positionSelect.value);
      if (settingsPanelPosition) settingsPanelPosition.value = positionSelect.value;
    });
    positionRow.appendChild(el('span', 'muted', 'Панель вкладок'));
    positionRow.appendChild(positionSelect);
    tableBox.appendChild(positionRow);
    settingsPanelPosition = positionSelect;

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
    const gridOnOff = el('span', 'muted', app.room.grid.enabled ? 'видна всем' : 'скрыта');
    gridRow.appendChild(gridOnOff);
    tableBox.appendChild(gridRow);

    // Подгонка сетки под карту: мастер говорит, сколько клеток укладывается
    // по ширине, а размер клетки считается от настоящей ширины подложки.
    // Так сетка ровная на любой карте, и фишка всегда занимает ровно клетку.
    //
    // Шаг в половине клетки: картинка шириной 1600 пикселей на 37 клеток даёт
    // 43.24 пикселя на клетку, и целое число клеток клало бы сетку с
    // ошибкой в несколько пикселей на всю карту.
    const fitRow = el('div', 'settings__row');
    const fitLabel = el('label', 'settings__check');
    const fitInput = el('input', 'input settings__input settings__input--narrow');
    fitInput.type = 'number';
    fitInput.min = '0';
    fitInput.max = String(DnD.GRID.maxColumns);
    fitInput.step = String(DnD.GRID.minColumnsStep);
    fitInput.dataset.setting = 'columns';
    fitInput.value = String(app.room.grid.columns || 0);
    fitInput.disabled = !canManageGrid;
    fitInput.title = '0 — размер клетки задаётся вручную. Например, 37.5 — тридцать семь с половиной клеток по ширине карты.';
    fitLabel.appendChild(fitInput);
    fitLabel.appendChild(el('span', null, 'клеток по ширине карты (0 — вручную)'));
    fitRow.appendChild(fitLabel);
    tableBox.appendChild(fitRow);

    // Ручной размер клетки в пикселях картинки. Число, а не список готовых:
    // список из пяти вариантов не подгоняет сетку к конкретной карте.
    const cellRow = el('div', 'settings__row');
    const cellLabel = el('label', 'settings__check');
    const cellInput = el('input', 'input settings__input settings__input--narrow');
    cellInput.type = 'number';
    cellInput.min = String(DnD.GRID.minCell);
    cellInput.max = String(DnD.GRID.maxCell);
    cellInput.step = '1';
    cellInput.dataset.setting = 'cell';
    cellInput.value = String(app.room.grid.cell || DnD.GRID.defaultCell);
    cellInput.disabled = !canManageGrid;
    cellInput.title = 'Размер клетки в пикселях картинки, если клеток по ширине не задано. Фишка занимает ровно клетку.';
    cellLabel.appendChild(cellInput);
    cellLabel.appendChild(el('span', null, 'размер клетки, px (вручную)'));
    cellRow.appendChild(cellLabel);
    tableBox.appendChild(cellRow);

    // Сдвиг сетки: у готовой карты клетки начинаются не обязательно с угла
    // файла. Два числа двигают нашу сетку туда же, где начинается её.
    const shiftRow = el('div', 'settings__row');
    const shiftLabel = el('label', 'settings__check');
    const shiftX = el('input', 'input settings__input settings__input--narrow');
    shiftX.type = 'number';
    shiftX.min = String(-DnD.GRID.maxOffset);
    shiftX.max = String(DnD.GRID.maxOffset);
    shiftX.step = '1';
    shiftX.dataset.setting = 'offsetX';
    shiftX.value = String(app.room.grid.offsetX || 0);
    shiftX.disabled = !canManageGrid;
    shiftX.title = 'Сдвиг сетки вправо, в пикселях картинки.';
    const shiftY = el('input', 'input settings__input settings__input--narrow');
    shiftY.type = 'number';
    shiftY.min = String(-DnD.GRID.maxOffset);
    shiftY.max = String(DnD.GRID.maxOffset);
    shiftY.step = '1';
    shiftY.dataset.setting = 'offsetY';
    shiftY.value = String(app.room.grid.offsetY || 0);
    shiftY.disabled = !canManageGrid;
    shiftY.title = 'Сдвиг сетки вниз, в пикселях картинки.';
    shiftLabel.appendChild(shiftX);
    shiftLabel.appendChild(el('span', null, 'сдвиг сетки, px'));
    shiftLabel.appendChild(shiftY);
    shiftRow.appendChild(shiftLabel);
    tableBox.appendChild(shiftRow);

    // Футов в клетке. По правилам 5e клетка пять футов, и в этой мере задана
    // дальность света: «факел светит на 20 футов» — это четыре клетки, а не
    // двадцать. На карте с другой мерой мастер ставит своё число.
    const scaleRow = el('div', 'settings__row');
    const scaleLabel = el('label', 'settings__check');
    const scaleInput = el('input', 'input settings__input settings__input--narrow');
    scaleInput.type = 'number';
    scaleInput.min = String(DnD.GRID.minFeetPerCell);
    scaleInput.max = String(DnD.GRID.maxFeetPerCell);
    scaleInput.step = '1';
    scaleInput.dataset.setting = 'feetPerCell';
    scaleInput.value = String(app.room.grid.feetPerCell || DnD.GRID.defaultFeetPerCell);
    scaleInput.disabled = !canManageGrid;
    scaleInput.title = 'Сколько футов укладывается в клетку сетки. По правилам 5e — пять.';
    scaleLabel.appendChild(scaleInput);
    scaleLabel.appendChild(el('span', null, 'футов в клетке'));
    scaleRow.appendChild(scaleLabel);
    tableBox.appendChild(scaleRow);

    tableBox.appendChild(el('div', 'box__note', app.training
      ? 'Проверка без сети: сетка и размер клетки — только у вас, других участников здесь нет.'
      : (isDm
        ? 'Клетка ровно по размеру фишки. Число клеток можно задать с половиной, а сдвигом сетку кладут на клетки самой карты. Видят все участники стола.'
        : 'Сетку на карте, размер клетки и масштаб задаёт ДМ за столом.')));

    const applyGrid = () => {
      const columns = DnD.roundColumns(Math.min(
        DnD.GRID.maxColumns,
        Math.max(0, Number(fitInput.value) || 0)
      ));
      const feetPerCell = Math.max(
        DnD.GRID.minFeetPerCell,
        Math.min(DnD.GRID.maxFeetPerCell, Number(scaleInput.value) || DnD.GRID.defaultFeetPerCell)
      );
      emit('setGrid', {
        enabled: gridInput.checked,
        cell: Number(cellInput.value) || DnD.GRID.defaultCell,
        columns,
        feetPerCell,
        offsetX: Number(shiftX.value) || 0,
        offsetY: Number(shiftY.value) || 0
      });
    };
    gridInput.addEventListener('change', applyGrid);
    fitInput.addEventListener('change', applyGrid);
    cellInput.addEventListener('change', applyGrid);
    shiftX.addEventListener('change', applyGrid);
    shiftY.addEventListener('change', applyGrid);
    scaleInput.addEventListener('change', applyGrid);
    settingsGridInput = gridInput;
    settingsGridFields = {
      columns: fitInput,
      cell: cellInput,
      offsetX: shiftX,
      offsetY: shiftY,
      // Без этого поля ответ стола не обновлял «футов в клетке», и следующая
      // правка любого поля отправляла старое значение обратно.
      feetPerCell: scaleInput
    };

    tablePanel.appendChild(tableBox);

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
      tablePanel.appendChild(trainBox);
    }

    const actions = el('div', 'modal__actions');
    const close = el('button', 'btn btn--accent', 'Закрыть');
    close.type = 'button';
    const dismiss = () => {
      settingsGridInput = null;
      settingsGridFields = null;
      settingsPanelPosition = null;
      document.removeEventListener('keydown', onKey);
      release();
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
    const savedSection = localStorage.getItem(SETTINGS_SECTION_KEY);
    selectSection(sectionMeta.some((item) => item.id === savedSection) ? savedSection : 'general', true);
  }

  /** Обновляет настройки сетки в открытом окне настроек (после ответа сервера). */
  function syncSettingsGrid() {
    if (!settingsGridInput || !settingsGridFields) return;
    settingsGridInput.checked = Boolean(app.room.grid.enabled);
    // Поля, пока мастер в них печатает, не трогаем: ответ сервера прилетел бы
    // посреди набора и затирал бы половину написанного.
    if (document.activeElement && document.activeElement.dataset) {
      const editing = document.activeElement.dataset.setting;
      for (const [key, field] of Object.entries(settingsGridFields)) {
        if (key === editing) continue;
        field.value = String(app.room.grid[key] ?? 0);
      }
      return;
    }
    for (const [key, field] of Object.entries(settingsGridFields)) {
      field.value = String(app.room.grid[key] ?? 0);
    }
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
   * Где стоит панель вкладок.
   *
   * Выбор мастера, а не ширина окна: на широком мониторе панель удобнее сбоку,
   * на высоком — под картой, и переключение должно быть мгновенным и без
   * перезагрузки стола.
   * @returns {'right'|'bottom'}
   */
  function rightPanelPosition() {
    return localStorage.getItem(RIGHT_PANEL_POS_KEY) === 'bottom' ? 'bottom' : 'right';
  }

  function applyPanelPosition(position) {
    const layout = $('.layout');
    if (!layout) return;
    layout.classList.toggle('is-right-bottom', position === 'bottom');
    localStorage.setItem(RIGHT_PANEL_POS_KEY, position === 'bottom' ? 'bottom' : 'right');
    applyPanels();
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
    // Положение панели хранится рядом со сворачиванием, но выбирается отдельно:
    // поменять сторону и не потерять свёрнутое состояние можно одним движением.
    layout.classList.toggle('is-right-bottom', rightPanelPosition() === 'bottom');

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

  /** Свёрнутые разделы левой колонки. */
  function readCollapsedPanels() {
    try {
      const raw = JSON.parse(localStorage.getItem(COLLAPSED_PANELS_KEY) || '[]');
      return new Set(Array.isArray(raw) ? raw.map(String) : []);
    } catch (err) {
      return new Set();
    }
  }

  function writeCollapsedPanels(keys) {
    localStorage.setItem(COLLAPSED_PANELS_KEY, JSON.stringify([...keys]));
  }

  /**
   * Сворачивает разделы левой колонки.
   *
   * Участники, журнал, склад, проверки и приглашение стоят друг под другом и
   * вместе занимают больше экрана, чем карта. Каждый получает кнопку-галочку,
   * а выбор переживает перезапуск: мастер один раз убирает то, чем в этой игре
   * не пользуется, и колонка остаётся короткой.
   */
  function setupLeftPanels() {
    const collapsed = readCollapsedPanels();
    for (const panel of document.querySelectorAll('.col--left > .panel[data-panel]')) {
      const title = panel.querySelector('.panel__title');
      if (!title) continue;
      const key = panel.dataset.panel;
      const label = (title.querySelector('span') || title).textContent.trim() || 'раздел';
      const fold = el('button', 'panel__fold', '▾');
      fold.type = 'button';
      const updateFold = () => {
        const isCollapsed = panel.classList.contains('is-collapsed');
        fold.setAttribute('aria-expanded', String(!isCollapsed));
        fold.setAttribute('aria-label',
          `${isCollapsed ? 'Развернуть' : 'Свернуть'} раздел «${label}»`);
        fold.title = `${isCollapsed ? 'Развернуть' : 'Свернуть'}: ${label}`;
      };
      fold.addEventListener('click', () => {
        const next = !panel.classList.contains('is-collapsed');
        panel.classList.toggle('is-collapsed', next);
        if (next) collapsed.add(key);
        else collapsed.delete(key);
        writeCollapsedPanels(collapsed);
        updateFold();
      });
      title.insertBefore(fold, title.firstChild);
      panel.classList.toggle('is-collapsed', collapsed.has(key));
      updateFold();
    }
  }

  /**
   * Разделитель правой колонки: тянуть мышью или двигать стрелками.
   *
   * Ширина живёт в CSS-переменной --right-user-width, потому что раскладка
   * описана гридом с колонками и иначе пришлось бы считать треки вручную.
   * Пока мастер ничего не тянул, переменную не задаём: иначе сохранённое нами
   * значение перекрыло бы узкий вариант из медиазапроса, и на экране уже
   * 1500 пикселей колонка оставалась бы широкой. Правый край панели привязан к
   * правому краю окна, поэтому за мышью тянем влево.
   */
  function setupRightResizer() {
    const resizer = $('#resizer-right');
    const layout = $('.layout');
    if (!resizer || !layout) return;

    const applyWidth = (width) => {
      const value = Math.round(Math.max(RIGHT_WIDTH_MIN, Math.min(RIGHT_WIDTH_MAX, width)));
      layout.style.setProperty('--right-user-width', `${value}px`);
      localStorage.setItem(RIGHT_WIDTH_KEY, String(value));
    };

    const applyHeight = (height) => {
      const value = Math.round(Math.max(RIGHT_HEIGHT_MIN, Math.min(RIGHT_HEIGHT_MAX, height)));
      layout.style.setProperty('--right-user-height', `${value}px`);
      localStorage.setItem(RIGHT_HEIGHT_KEY, String(value));
    };

    resizer.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      document.body.classList.add('is-resizing');
      const bottom = rightPanelPosition() === 'bottom';
      // Внизу разделитель лежит, а не стоит: тянем по другой оси.
      const move = (moveEvent) => (bottom
        ? applyHeight(window.innerHeight - moveEvent.clientY)
        : applyWidth(window.innerWidth - moveEvent.clientX));
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.body.classList.remove('is-resizing');
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      // Первое движение мыши может не совпасть с нажатием, поэтому размер
      // пересчитываем сразу: иначе панель дёргалась бы на пиксель.
      move(event);
    });

    // Стрелки с клавиатуры: тянуть мышью нельзя, а колонку под лист на узком
    // экране всё равно надо расширить.
    resizer.addEventListener('keydown', (event) => {
      const keys = rightPanelPosition() === 'bottom'
        ? ['ArrowUp', 'ArrowDown']
        : ['ArrowLeft', 'ArrowRight'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const step = event.shiftKey ? 40 : 12;
      const panel = document.querySelector('.col--right');
      if (!panel) return;
      const box = panel.getBoundingClientRect();
      if (rightPanelPosition() === 'bottom') {
        // Стрелка вверх тянет разделитель вверх, то есть панель становится ниже.
        applyHeight(event.key === 'ArrowUp' ? box.height + step : box.height - step);
        return;
      }
      // Отсчитываем от текущей ширины колонки, а не от --right-user-width:
      // его может не быть вовсе, пока мастер не тянул разделитель.
      // Стрелка влево тянет разделитель влево, то есть колонка становится уже.
      applyWidth(event.key === 'ArrowLeft' ? box.width - step : box.width + step);
    });

    const stored = storedRightWidth();
    if (stored) applyWidth(stored);
    const storedHeight = storedRightHeight();
    if (storedHeight) applyHeight(storedHeight);
  }

  /**
   * Высота нижней панели из прошлой сессии.
   * @returns {number|null} null, если мастер её ещё не выбирал.
   */
  function storedRightHeight() {
    const saved = Number.parseInt(localStorage.getItem(RIGHT_HEIGHT_KEY) || '', 10);
    if (!Number.isFinite(saved)) return null;
    return Math.max(RIGHT_HEIGHT_MIN, Math.min(RIGHT_HEIGHT_MAX, saved));
  }

  /**
   * Ширина правой колонки из прошлой сессии.
   * @returns {number|null} null, если мастер её ещё не выбирал.
   */
  function storedRightWidth() {
    const saved = Number.parseInt(localStorage.getItem(RIGHT_WIDTH_KEY) || '', 10);
    if (!Number.isFinite(saved)) return null;
    return Math.max(RIGHT_WIDTH_MIN, Math.min(RIGHT_WIDTH_MAX, saved));
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
      playerKey: storedPlayerKey(),
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
      syncPresence();
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
      // Игрок отключился и пропал из списка — возвращаемся к подсказке.
      if (app.viewedSheetPlayerId && !targets.some((player) => player.playerId === app.viewedSheetPlayerId)) {
        app.viewedSheetPlayerId = null;
        app.sheetShownFor = null;
      }
      sheetView.setReadOnly(true);
      // Портрет в листе мастера показываем, но править не даём: аватар
      // меняет сам игрок. А свой мастер меняет в панели участников слева,
      // где для него и живёт собственный блок портрета.
      sheetView.setAvatarEditable(false);

      // Списка игроков в этой вкладке больше нет: он целиком живёт слева, где
      // кнопка «Открыть лист» стоит рядом с именем и с «Вывести».
      if (!app.viewedSheetPlayerId) {
        sheetView.setMode('pick');
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

  /** Имя мастера — для буквы-заглушки, пока портрет не поставлен. */
  function dmName() {
    const dm = app.room.players.find((entry) => entry.playerId === 'dm');
    return dm ? dm.name : 'Мастер';
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

  function activateTab(name, options = {}) {
    for (const button of document.querySelectorAll('.tabs__btn')) {
      const active = button.dataset.tab === name;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
      // В табуляцию входит только открытая вкладка, остальные листаются
      // стрелками. Так панель не отнимает семь шагов Tab у клавиатуры.
      button.tabIndex = active ? 0 : -1;
    }
    for (const panel of document.querySelectorAll('.panel--tab')) {
      panel.classList.toggle('is-active', panel.id === `tab-${name}`);
    }
    // При открытии стола вкладка восстанавливается из памяти, и записывать
    // её обратно незачем: скрытая на тот момент вкладка справочника сбросила
    // бы память на «Чат».
    if (options.remember !== false) localStorage.setItem(ACTIVE_TAB_KEY, name);
    // Пока справочник был закрыт, его данные могли устареть. Догоняем один
    // раз — при открытии вкладки, а не на каждое событие фишки.
    if (name === 'adventure' && adventurePanelStale) renderAdventurePanel({ force: true });
  }

  /**
   * Переключение вкладок с клавиатуры и память последней открытой.
   *
   * Цифры работают только когда фокус не в поле ввода: иначе «2» в поле броска
   * переключала бы вкладку вместо того, чтобы попасть в формулу.
   */
  function setupTabHotkeys() {
    document.addEventListener('keydown', (event) => {
      const table = $('#screen-table');
      if (!table || !table.classList.contains('is-active')) return;
      const target = event.target;
      const typing = target && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT'
        || target.isContentEditable
      );

      // Ctrl+F открывает поиск по чату. В полях ввода он не перехватывается:
      // иначе нельзя было бы искать ничего, кроме чата.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !typing) {
        event.preventDefault();
        if (panelCollapsed(RIGHT_COLLAPSED_KEY)) setPanelCollapsed('right', false);
        activateTab('chat');
        if (chatPanel && chatPanel.searchInput) {
          chatPanel.searchInput.focus();
          chatPanel.searchInput.select();
        }
        return;
      }
      // Ctrl+K — поиск по всей кампании, а не только по чату.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !typing) {
        event.preventDefault();
        openSearch();
        return;
      }
      // «?» — шпаргалка по горячим клавишам. Спрашивают о них чаще, чем
      // находят в настройках.
      if (event.key === '?' && !typing) {
        event.preventDefault();
        openShortcuts();
        return;
      }
      if (typing || event.ctrlKey || event.metaKey || event.altKey) return;

      // Стрелки двигают выбранную в бою фишку на клетку. Только когда карта
      // в фокусе: иначе они отобрали бы прокрутку у списков и полей.
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        const mapRoot = $('#map-root');
        const active = document.activeElement;
        const mapFocused = active === document.body || (mapRoot && mapRoot.contains(active));
        if (mapFocused && mapView && mapView.moveSelectedByKey(event.key)) {
          event.preventDefault();
          return;
        }
      }

      // Стрелки по вкладкам: стандартное поведение табуляции ARIA. Фокус
      // переезжает вместе с открытой панелью, иначе он остался бы на скрытой.
      const tabButton = target && target.closest
        ? target.closest('.tabs__btn[role="tab"]')
        : null;
      if (tabButton) {
        const buttons = [...document.querySelectorAll('.tabs__btn:not([hidden])')];
        const current = buttons.indexOf(tabButton);
        let next = current;
        if (event.key === 'ArrowRight') next = (current + 1) % buttons.length;
        else if (event.key === 'ArrowLeft') next = (current - 1 + buttons.length) % buttons.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = buttons.length - 1;
        if (next !== current) {
          event.preventDefault();
          if (panelCollapsed(RIGHT_COLLAPSED_KEY)) setPanelCollapsed('right', false);
          const button = buttons[next];
          activateTab(button.dataset.tab);
          button.focus();
          return;
        }
      }

      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= 9) return;
      const buttons = [...document.querySelectorAll('.tabs__btn:not([hidden])')];
      const button = buttons[index];
      if (!button) return;
      event.preventDefault();
      if (panelCollapsed(RIGHT_COLLAPSED_KEY)) setPanelCollapsed('right', false);
      activateTab(button.dataset.tab);
    });
  }

  /** Возвращает ту вкладку, которая была открыта в прошлый раз. */
  function restoreActiveTab() {
    const saved = localStorage.getItem(ACTIVE_TAB_KEY);
    const button = saved && document.querySelector(`.tabs__btn[data-tab="${saved}"]:not([hidden])`);
    activateTab(button ? button.dataset.tab : 'chat', { remember: false });
  }

  /* ------------------------------------------------------------------ *
   * Действия на экране стола
   * ------------------------------------------------------------------ */

  /** Отмена последнего действия мастера: сервер присылает свежий снимок. */
  function undoDmAction() {
    if (!app.socket || !app.connected) return toast('Нет соединения со столом', 'error');
    app.socket.emit('undoDmAction', {}, (result) => {
      if (!result || !result.ok) {
        return toast((result && result.error) || 'Нечего отменять', 'error');
      }
      toast('Действие отменено', 'ok');
    });
  }

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
      activeMap: null, grid: { enabled: false, cell: 46, columns: 0, feetPerCell: DnD.GRID.defaultFeetPerCell, offsetX: 0, offsetY: 0 },
      tokens: [], initiative: { entries: [], turnId: null, round: 1 }, combat: { enabled: false },
      diceHistory: [], chatHistory: [], journal: '', journalEntries: [], inventory: [], rollRequests: []
    };
    app.sheetShownFor = null;
    app.viewedSheetPlayerId = null;
    app.training = false;
    // Выбранный лист уехал на стол. Если сюда вернуться со следующей игрой,
    // выбор должен быть сделан заново, а не молча взят прежний.
    chosenSheetId = null;
    showScreen('screen-home');
    await initHomeData();
  }

  async function initHomeData() {
    const status = await desktop.hostStatus();
    if (!status.running) app.host = null;
  }

  /** Собирает Markdown сессии: журнал, чат и броски. */
  function sessionMarkdown() {
    const campaign = app.campaign || {};
    const lines = [
      `# ${campaign.name || 'Кампания'}`,
      '',
      `Экспорт: ${new Date().toLocaleString('ru-RU')}`,
      ''
    ];
    if (app.role === 'dm') {
      lines.push('## Журнал', '', app.room.journal || '(пусто)', '');
    }
    lines.push('## Чат', '');
    for (const message of app.room.chatHistory || []) {
      const time = message.time
        ? new Date(message.time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
        : '';
      const author = message.from || (message.system ? 'Стол' : '');
      let text = String(message.text || '').replace(/\n/g, ' ');
      if (message.image) {
        const url = assetUrl(message.image);
        text += `${text ? ' ' : ''}[картинка](${url})`;
      }
      if (!text) continue;
      lines.push(`- ${time ? `${time} ` : ''}${author ? `**${author}**: ` : ''}${text}`);
    }
    lines.push('', '## Броски', '');
    for (const roll of app.room.diceHistory || []) {
      const time = roll.time
        ? new Date(roll.time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
        : '';
      const name = roll.playerName || '';
      const dice = window.DnDDice;
      const text = dice ? dice.describeRoll(roll) : `бросок ${roll.formula || ''}`;
      lines.push(`- ${time ? `${time} ` : ''}${name ? `**${name}**: ` : ''}${text}`);
    }
    return lines.join('\n');
  }

  function exportSession() {
    const name = String((app.campaign && app.campaign.name) || 'campaign')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .slice(0, 60);
    const blob = new Blob([sessionMarkdown()], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = el('a');
    link.href = url;
    link.download = `${name || 'campaign'}-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Сессия выгружена в Markdown', 'ok');
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
    $('#btn-go-sheet').addEventListener('click', () => openSheetEditor());
    $('#btn-join-new-sheet').addEventListener('click', () => openSheetEditor({ from: 'screen-join' }));
    $('#btn-join-edit-sheet').addEventListener('click', () => {
      if (chosenSheetId) openSheetEditor({ id: chosenSheetId, from: 'screen-join' });
    });
    $('#btn-sheet-back').addEventListener('click', () => {
      showScreen(sheetEditorReturn);
      if (sheetEditorReturn === 'screen-join') renderSheetChoice();
    });
    $('#btn-sheet-save').addEventListener('click', () => {
      // Кнопка для тех, кто хочет увидеть подтверждение: само сохранение уже
      // произошло при правке поля.
      if (sheetEditorView) onSheetEditorChange(sheetEditorView.sheet);
      setStatus('#sheet-editor-status', 'Лист сохранён на этом компьютере');
    });
    for (const back of document.querySelectorAll('[data-back]')) {
      back.addEventListener('click', () => showScreen('screen-home'));
    }

    $('#btn-create-start').addEventListener('click', createAndStart);
    $('#create-name').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') createAndStart();
    });

    $('#btn-start-loaded').addEventListener('click', startTable);

    const importButton = $('#btn-import-campaign');
    if (importButton) {
      if (!desktop || typeof desktop.importCampaign !== 'function') {
        importButton.hidden = true;
      } else {
        importButton.addEventListener('click', async () => {
          const result = await desktop.importCampaign();
          if (!result || result.canceled) return;
          if (!result.ok) {
            setStatus('#load-status', result.error || 'Не удалось импортировать кампанию', 'error');
            return;
          }
          toast(`Кампания «${result.campaign.name}» импортирована`, 'ok');
          await refreshCampaignList();
        });
      }
    }

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
    $('#btn-search').addEventListener('click', openSearch);
    $('#btn-undo').addEventListener('click', undoDmAction);
    $('#btn-game-rest').addEventListener('click', () => {
      partyLongRest();
    });
    $('#btn-inventory-add').addEventListener('click', () => {
      inventoryEditingId = 'new';
      renderInventoryPanel();
      const field = $('#inventory-name-input');
      if (field) field.focus();
    });
    $('#roll-request-form').addEventListener('submit', (event) => {
      event.preventDefault();
      sendRollRequest();
    });

    $('#btn-settings-home').addEventListener('click', openSettings);
    $('#btn-settings-table').addEventListener('click', openSettings);
    $('#addresses-toggle').addEventListener('click', toggleAddresses);
    $('#btn-journal-add').addEventListener('click', () => {
      journalEditingId = 'new';
      renderJournalPanel();
      const field = $('#journal-title-input');
      if (field) field.focus();
    });
    $('#btn-journal-detach').addEventListener('click', detachJournal);
    $('#journal-search').addEventListener('input', (event) => {
      journalQuery = event.target.value;
      renderJournalPanel();
    });
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
    setupLeftPanels();
    setupRightResizer();
    setupTabHotkeys();
    restoreActiveTab();

    desktop.onCampaignSaved(({ meta, reason }) => {
      app.campaign = meta;
      updateTableHeader();
      // На пятнадцати секундах тост каждые пятнадцать секунд — шум, а не
      // новость: там автосохранение и так ожидаемо. Отметку в шапке не трогаем.
      if (reason === 'auto' && autosaveSeconds() >= 60) {
        toast(`Автосохранение: ${formatDateTime(meta.updatedAt)}`, 'info', 2500);
      }
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
    renderSheetChoice();
    showScreen('screen-join');
    $('#join-p2p-ticket').focus();
  }

  /* ------------------------------------------------ листы персонажа */

  /**
   * Подготовка листа без стола.
   *
   * Отдельный экран, а не панель стола: подключаться к мастеру ради того, чтобы
   * заполнить лист, незачем. Всё, что введено, сразу уходит в библиотеку на
   * этом компьютере, а оттуда лист выбирается при подключении.
   *
   * @param {{id?: string, from?: string}} [options] Какой лист править и куда
   *   возвращаться: на главный экран или к подключению.
   */
  function openSheetEditor(options = {}) {
    const entry = options.id ? LocalTable.getLocalSheet(options.id) : null;
    sheetEditorId = entry ? entry.id : null;
    sheetEditorReturn = options.from || 'screen-home';
    if (!sheetEditorView) {
      sheetEditorView = new window.SheetView($('#sheet-editor-root'), {
        onChange: onSheetEditorChange
      });
    }
    // Кнопка «Отдельным окном» здесь лишняя: отдельное окно имеет смысл, когда
    // лист открыт на столе, а здесь лист и есть всё окно.
    sheetEditorView.setMode('sheet', { canDetach: false });
    sheetEditorView.setSheet(entry ? entry.sheet : DnD.createEmptySheet(storedName()));
    setStatus('#sheet-editor-status', entry ? `Правка: ${entry.sheet.characterName || 'без имени'}` : 'Новый лист');
    showScreen('screen-sheet');
  }

  /**
   * Автосохранение при правке поля.
   *
   * Лист сохраняется сразу, без кнопки: кнопка «Сохранить» тоже есть, но
   * потерять час вписанного из-за закрытия окна обидно. Черновик обновляется
   * тем же, что и раньше, иначе выбранный на экране подключения лист и
   * отредактированный здесь разошлись бы.
   */
  function onSheetEditorChange(sheet) {
    if (!sheet) return;
    const id = LocalTable.upsertLocalSheet(sheet, sheetEditorId);
    if (!sheetEditorId) sheetEditorId = id;
    LocalTable.saveDraft(localPlayerId(), sheet);
    setStatus('#sheet-editor-status', 'Сохранено на этом компьютере');
  }

  /**
   * Список листов на экране подключения.
   *
   * Показывается и когда библиотека пуста: игрок должен видеть, что лист можно
   * завести, иначе он пойдёт на стол с пустым и удивится.
   */
  function renderSheetChoice() {
    const list = $('#join-sheets');
    const sheets = LocalTable.listLocalSheets();
    if (!chosenSheetId) chosenSheetId = matchDraftSheetId(sheets);
    list.innerHTML = '';
    for (const item of sheets) {
      const row = el('li', 'sheet-choice__item');
      if (item.id === chosenSheetId) row.classList.add('is-selected');
      const info = el('div', 'sheet-choice__info');
      info.appendChild(el('span', 'sheet-choice__name', item.characterName));
      const className = [item.charClass, item.subclass].filter(Boolean).join(' · ');
      const about = [item.playerName, item.race, className, `${item.level} ур.`]
        .filter(Boolean).join(' · ');
      info.appendChild(el('span', 'sheet-choice__about', about || 'Лист без класса и предыстории'));
      row.appendChild(info);
      const actions = el('div', 'sheet-choice__row-actions');
      const take = el('button', 'btn btn--accent btn--tiny', item.id === chosenSheetId ? 'Взят на стол' : 'Взять на стол');
      take.type = 'button';
      take.addEventListener('click', () => chooseLocalSheet(item.id));
      actions.appendChild(take);
      const remove = el('button', 'btn btn--ghost btn--tiny', 'Удалить');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        LocalTable.deleteLocalSheet(item.id);
        if (chosenSheetId === item.id) chosenSheetId = null;
        renderSheetChoice();
      });
      actions.appendChild(remove);
      row.appendChild(actions);
      list.appendChild(row);
    }
    if (!sheets.length) {
      list.appendChild(el('li', 'sheet-choice__empty',
        'Листов пока нет. Заведите персонажа — потом его можно будет взять на любой стол.'));
    }
    $('#sheet-choice-hint').hidden = !sheets.length;
    $('#btn-join-edit-sheet').hidden = !chosenSheetId;
  }

  /**
   * Какой лист уже выбран: сначала то, что игрок взял сам, а если он ещё не
   * выбирал — тот, чей черновик уже лежит и уедет на стол при подключении.
   * @param {{characterName: string, charClass: string}[]} sheets
   * @returns {string|null}
   */
  function matchDraftSheetId(sheets) {
    const draft = LocalTable.readDraft(localPlayerId());
    if (!draft) return null;
    const wanted = [draft.characterName, draft.charClass]
      .map((value) => String(value || '').trim().toLowerCase()).join('::');
    const found = sheets.find((item) => [item.characterName, item.charClass]
      .map((value) => String(value || '').trim().toLowerCase()).join('::') === wanted);
    return found ? found.id : null;
  }

  /**
   * Кладёт выбранный лист в черновик: он уедет на стол один раз при
   * подключении, когда сервер создаст игроку пустой лист и предложит заготовку.
   * @param {string} id
   */
  function chooseLocalSheet(id) {
    const entry = LocalTable.getLocalSheet(id);
    if (!entry) return;
    chosenSheetId = id;
    LocalTable.saveDraft(localPlayerId(), entry.sheet);
    renderSheetChoice();
    toast(`Лист «${entry.sheet.characterName || 'без имени'}» пойдёт на стол`, 'ok');
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
  /** Выбранные для встречи монстры: имя → количество. */
  const encounterSelection = new Map();
  let encounterActorName = '';
  let encounterOpen = false;
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
  // Главный экран уже активен в разметке, поэтому сцену включаем сразу.
  // Автоплей разрешён на уровне приложения, но если браузер на старой сборке
  // всё-таки блокирует аудио, атмосфера подхватится на первом жесте.
  if (window.DnDSound) window.DnDSound.setScene('home');
  initHome().catch((error) => toast(`Ошибка запуска: ${error.message}`, 'error'));

})();
