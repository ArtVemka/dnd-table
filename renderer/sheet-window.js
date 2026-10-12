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
      setStatus('Стол не запущен — окно листа подключать не к чему.', 'error');
      return;
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
      }
    });
    sheetView.setMode('sheet');
    sheetView.setReadOnly(Boolean(context.readOnly));

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

    $('#btn-refresh-sheet').addEventListener('click', () => {
      table.emit('requestCharacterSheet', { playerId: context.viewPlayerId });
      if (lastSheet) applySheet(lastSheet, true);
    });

    window.addEventListener('beforeunload', () => {
      if (table) table.disconnect();
    });
  })();
})();
