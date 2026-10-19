'use strict';

/**
 * Отдельное окно с листом персонажа.
 *
 * Зачем: за столом лист тесный, а игроку хочется держать его рядом — на втором
 * мониторе или просто поверх стола. Окно подключается к тому же столу тем же
 * персонажем (своим playerId), поэтому правки видны и здесь, и в основном окне.
 *
 * ДМ открывает так лист игрока — тогда окно только для чтения.
 */

(function () {
  const bridge = window.sheetWindow;
  const DnD = window.DnD5e;

  const $ = (selector) => document.querySelector(selector);

  function setStatus(text, kind) {
    const node = $('#sheet-sub');
    if (!node) return;
    node.textContent = text || '';
    node.className = `sheet-window__sub${kind ? ` status--${kind}` : ''}`;
  }

  function setConnection(online) {
    const badge = $('#sheet-conn');
    if (!badge) return;
    badge.textContent = online ? 'на связи' : 'нет связи';
    badge.className = `badge ${online ? 'badge--on' : 'badge--off'}`;
  }

  function toast(message, kind = 'info') {
    const root = $('#toasts');
    if (!root) return;
    const node = document.createElement('div');
    node.className = `toast toast--${kind}`;
    node.textContent = message;
    root.appendChild(node);
    setTimeout(() => {
      node.classList.add('is-out');
      setTimeout(() => node.remove(), 300);
    }, 4200);
  }

  if (!bridge) {
    document.body.innerHTML = '<p style="padding:24px">Это окно открывает само приложение (кнопка «Отдельным окном» у листа).</p>';
    return;
  }

  (async () => {
    const context = await bridge.getContext();
    if (!context || (!context.url && !context.training)) {
      setStatus('Стол не запущен — окно листа подключаться не к чему.', 'error');
      return;
    }

    const contextUrl = context.url || '';

    /**
     * Картинки кампании лежат на столе и приходят как /files/<имя>, а окно
     * открыто по file://: без адреса стола браузер искал бы файл в корне диска.
     * Портрет мастера по умолчанию — это путь из поставки (avatar-dm.png),
     * такой оставляем как есть.
     * @param {string} path
     * @returns {string}
     */
    function assetUrl(path) {
      if (!path) return '';
      if (/^(https?:|data:|blob:)/i.test(path)) return path;
      if (path.startsWith('/')) return `${contextUrl}${path}`;
      return path;
    }

    /**
     * Читает выбранный файл в base64 data URL. Все проверки сервер делает и сам,
     * здесь нужен только ранний отказ с понятным текстом: ждать ответа стола,
     * чтобы узнать, что файл не картинка, невежливо.
     * @param {File} file
     * @returns {Promise<{dataUrl?: string, canceled?: boolean, error?: string}>}
     */
    function readImageFile(file, maxBytes) {
      return new Promise((resolve) => {
        if (!file) return resolve({ canceled: true });
        if (!file.size) return resolve({ error: `Файл «${file.name}» пустой.` });
        if (file.size > maxBytes) {
          return resolve({
            error: `Файл «${file.name}» весит ${(file.size / 1024 / 1024).toFixed(1)} МБ, `
              + `а можно не больше ${Math.round(maxBytes / 1024 / 1024)} МБ. Уменьшите изображение.`
          });
        }
        if (!/^image\/(png|jpeg|jpg|webp)$/i.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) {
          return resolve({ error: `Файл «${file.name}» не поддерживается. Нужны PNG, JPG или WEBP.` });
        }
        const reader = new FileReader();
        reader.onload = () => resolve({ dataUrl: String(reader.result) });
        reader.onerror = () => resolve({ error: `Не удалось прочитать файл «${file.name}».` });
        reader.readAsDataURL(file);
      });
    }


    document.title = context.title || 'Лист персонажа';
    $('#sheet-title').textContent = context.title || 'Лист персонажа';
    setStatus(context.training
      ? 'Проверка без сети: лист сохраняется на этом компьютере'
      : (context.readOnly ? 'Режим просмотра — правит игрок' : 'Ваш лист: правки сохраняются сами'));
    if (context.training) {
      // Связи здесь нет по определению — и бейдж говорит об этом прямо.
      const badge = $('#sheet-conn');
      badge.textContent = 'без сети';
      badge.className = 'badge badge--train';
    }

    let saveTimer = null;
    let lastSheet = null;

    const sheetView = new window.SheetView($('#sheet-root'), {
      onChange: (sheet) => {
        if (context.readOnly) return;
        lastSheet = sheet;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => table.emit('saveCharacterSheet', { sheet }), 400);
      },
      // Проверка уходит на стол тем же броском, что и из панели кубиков.
      onRollCheck: (formula) => table.emit('rollDice', { formula }),
      // Спасбросок смерти считает сервер, в отдельном окне так же.
      onDeathSave: () => table.emit('rollDeathSave', {}),
      onResetDeathSaves: () => table.emit('resetDeathSaves', {}),
      onAvatarPick: async (file) => {
        if (context.readOnly) return;
        const read = await readImageFile(file, DnD.LIMITS.maxAvatarBytes);
        if (read.canceled) return;
        if (read.error) return toast(read.error, 'error');
        table.emit('setAvatar', { image: read.dataUrl });
      },
      onAvatarClear: () => {
        if (context.readOnly) return;
        table.emit('setAvatar', { image: null });
      },
      resolveUrl: assetUrl
    });
    sheetView.setMode('sheet');
    sheetView.setReadOnly(Boolean(context.readOnly));
    // Чужой портрет мастер не правит: аватар меняет сам игрок.
    sheetView.setAvatarEditable(!context.readOnly);

    // В тренировочном столе сервера нет: и лист, и его хранение живут в общем
    // хранилище окон, поэтому здесь тот же локальный стол, что и в основном окне.
    const table = context.training
      ? window.LocalTable.createLocalTable({ playerId: context.playerId, name: context.name })
      : io(context.url, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 800
      });

    /** Не перебиваем то, что человек печатает прямо сейчас. */
    const applySheet = (sheet, force = false) => {
      const focused = document.activeElement && sheetView.root.contains(document.activeElement);
      if (!force && focused) return;
      lastSheet = sheet;
      sheetView.setSheet(sheet);
    };

    table.on('connect', () => {
      if (!context.training) setConnection(true);
      table.emit('joinRoom', {
        name: context.name,
        playerId: context.playerId,
        playerKey: context.playerKey,
        hostKey: context.hostKey
      }, (response) => {
        if (!response || !response.ok) {
          const message = (response && response.error) || 'Стол отклонил подключение';
          setStatus(message, 'error');
          toast(message, 'error');
          return;
        }
        table.emit('requestCharacterSheet', { playerId: context.viewPlayerId });
      });
    });

    table.on('disconnect', () => {
      setConnection(false);
      setStatus('Связь со столом потеряна, подключаемся заново…', 'error');
    });

    table.on('connect_error', () => {
      setConnection(false);
      setStatus(`Не удалось подключиться к ${context.url}`, 'error');
    });

    table.on('characterSheetData', ({ playerId, sheet }) => {
      if (playerId !== context.viewPlayerId) return;
      applySheet(sheet);
      if (!context.readOnly) {
        setStatus(context.training
          ? 'Лист тренировочного стола: сохраняется на этом компьютере'
          : 'Лист загружен — правки сохраняются сами', 'ok');
      }
    });

    table.on('characterSheetUpdated', ({ playerId, sheet }) => {
      if (playerId !== context.viewPlayerId) return;
      applySheet(sheet);
    });

    table.on('errorMessage', ({ message }) => {
      setStatus(message, 'error');
      toast(message, 'error');
    });

    /**
     * Портрет берём из списка участников: он и у игрока, и у мастера хранится
     * там, а не в листе. Окно листа показывает аватар того, кого смотрит, —
     * у мастера это чужой игрок, и подменять его своим нельзя.
     */
    const paintAvatar = (players) => {
      if (context.readOnly) return;
      const me = (players || []).find((player) => player.playerId === context.playerId);
      if (!me) return;
      const name = (lastSheet && lastSheet.characterName) || me.name;
      sheetView.setAvatar(assetUrl(me.avatar), name);
    };
    table.on('playersUpdate', paintAvatar);
    table.on('joined', (payload) => {
      if (!payload || !payload.state) return;
      const list = (payload.state.players) || [];
      const me = list.find((player) => player.playerId === context.playerId);
      if (me) sheetView.setAvatar(assetUrl(me.avatar), (lastSheet && lastSheet.characterName) || me.name);
    });

    $('#btn-refresh-sheet').addEventListener('click', () => {
      table.emit('requestCharacterSheet', { playerId: context.viewPlayerId });
      if (lastSheet) applySheet(lastSheet, true);
    });

    window.addEventListener('beforeunload', () => {
      if (table) table.disconnect();
    });
  })();
})();
