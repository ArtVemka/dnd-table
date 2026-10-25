'use strict';

/**
 * Отдельное окно журнала кампании.
 *
 * Подключается к тому же столу, что и главное окно, тем же мастером. Записи
 * хранит и рассылает сервер, поэтому правки сразу видны и здесь, и в столе.
 */

(function () {
  const bridge = window.journalWindow;
  const $ = (selector) => document.querySelector(selector);

  const KINDS = [
    ['npc', 'НПС'],
    ['location', 'Место'],
    ['quest', 'Задание'],
    ['faction', 'Фракция'],
    ['item', 'Предмет']
  ];

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function setStatus(text, kind) {
    const node = $('#journal-sub');
    if (!node) return;
    node.textContent = text || '';
    node.className = `sheet-window__sub${kind ? ` status--${kind}` : ''}`;
  }

  function setConnection(online) {
    const badge = $('#journal-conn');
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
    document.body.innerHTML = '<p style="padding:24px">Это окно открывает само приложение (кнопка «Открыть окно» в журнале).</p>';
    return;
  }

  let socket = null;
  let entries = [];
  let editingId = null;
  let query = '';

  function kindLabel(kind) {
    const found = KINDS.find(([key]) => key === kind);
    return found ? found[1] : 'НПС';
  }

  function matches(entry) {
    if (!query) return true;
    return [entry.title, entry.text, ...(entry.tags || [])]
      .join(' ').toLowerCase().includes(query);
  }

  function render() {
    const list = $('#journal-list');
    if (!list) return;
    list.innerHTML = '';

    const editor = editingId ? editorNode(editingId) : null;
    if (editor) list.appendChild(editor);

    const visible = entries
      .filter(matches)
      .slice()
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

    if (!visible.length) {
      list.appendChild(el('div', 'journal-empty muted',
        query ? 'Ничего не найдено' : 'Записей пока нет'));
      return;
    }

    for (const entry of visible) {
      const row = el('button', 'journal-row');
      row.type = 'button';
      row.appendChild(el('span', 'journal-row__kind', kindLabel(entry.kind)));
      const main = el('span', 'journal-row__main');
      main.appendChild(el('span', 'journal-row__title', entry.title));
      if (entry.tags && entry.tags.length) {
        main.appendChild(el('span', 'journal-row__tags', entry.tags.join(' · ')));
      }
      row.appendChild(main);
      row.addEventListener('click', () => {
        editingId = entry.id;
        render();
      });
      list.appendChild(row);
    }
  }

  function editorNode(id) {
    const isNew = id === 'new';
    const entry = isNew ? null : entries.find((item) => item.id === id);
    if (!isNew && !entry) {
      editingId = null;
      return null;
    }

    const form = el('form', 'journal-editor');
    const title = el('input', 'input');
    title.placeholder = 'Заголовок';
    title.maxLength = 120;
    title.value = (entry && entry.title) || '';
    title.setAttribute('aria-label', 'Заголовок записи');

    const kind = el('select', 'select');
    kind.setAttribute('aria-label', 'Вид записи');
    for (const [value, label] of KINDS) {
      const option = el('option', null, label);
      option.value = value;
      kind.appendChild(option);
    }
    kind.value = (entry && entry.kind) || 'npc';

    const tags = el('input', 'input');
    tags.placeholder = 'Теги через запятую';
    tags.value = entry && entry.tags ? entry.tags.join(', ') : '';
    tags.setAttribute('aria-label', 'Теги через запятую');

    const text = el('textarea', 'input journal-editor__text');
    text.rows = 7;
    text.placeholder = 'Что известно: имена, связи, тайны, планы…';
    text.value = (entry && entry.text) || '';
    text.setAttribute('aria-label', 'Текст записи');

    form.appendChild(title);
    form.appendChild(kind);
    form.appendChild(tags);
    form.appendChild(text);

    const actions = el('div', 'journal-editor__actions');
    const save = el('button', 'btn btn--accent btn--tiny', 'Сохранить');
    save.type = 'submit';
    const cancel = el('button', 'btn btn--ghost btn--tiny', 'Отмена');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      editingId = null;
      render();
    });
    actions.appendChild(save);
    actions.appendChild(cancel);

    if (entry) {
      const remove = el('button', 'btn btn--danger btn--ghost btn--tiny', 'Удалить');
      remove.type = 'button';
      remove.addEventListener('click', () => removeEntry(entry.id));
      actions.appendChild(remove);
    }
    form.appendChild(actions);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = title.value.trim();
      if (!value) return toast('Нужен заголовок записи', 'error');
      if (!socket) return toast('Нет соединения со столом', 'error');
      socket.emit('saveJournalEntry', {
        ...(entry ? { id: entry.id } : {}),
        kind: kind.value,
        title: value,
        text: text.value,
        tags: tags.value.split(',').map((tag) => tag.trim()).filter(Boolean)
      }, (result) => {
        if (!result || !result.ok) {
          return toast((result && result.error) || 'Не удалось сохранить запись', 'error');
        }
        editingId = null;
        render();
      });
    });

    return form;
  }

  function removeEntry(id) {
    if (!socket) return toast('Нет соединения со столом', 'error');
    socket.emit('deleteJournalEntry', { id }, (result) => {
      if (!result || !result.ok) {
        return toast((result && result.error) || 'Не удалось удалить запись', 'error');
      }
      editingId = null;
      render();
    });
  }

  (async () => {
    const context = await bridge.getContext();
    if (!context || !context.url) {
      setStatus('Стол не запущен: журнал подключать не к чему.', 'error');
      return;
    }

    document.title = context.title || 'Журнал кампании';
    $('#journal-title').textContent = context.title || 'Журнал кампании';
    setStatus('Записи журнала: правки сохраняются сами');
    render();

    socket = io(context.url, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 800
    });

    socket.on('connect', () => {
      setConnection(true);
      socket.emit('joinRoom', {
        name: 'Мастер',
        playerId: 'dm',
        hostKey: context.hostKey
      }, (response) => {
        if (!response || !response.ok) {
          const message = (response && response.error) || 'Стол отклонил подключение';
          setStatus(message, 'error');
          toast(message, 'error');
          return;
        }
        socket.emit('journalRequest');
      });
    });

    socket.on('disconnect', () => {
      setConnection(false);
      setStatus('Связь со столом потеряна, подключаемся заново…', 'error');
    });

    socket.on('connect_error', () => {
      setConnection(false);
      setStatus(`Не удалось подключиться к ${context.url}`, 'error');
    });

    socket.on('journalUpdated', (list) => {
      entries = Array.isArray(list) ? list : [];
      if (editingId && editingId !== 'new' && !entries.some((item) => item.id === editingId)) {
        editingId = null;
      }
      render();
    });

    // Отмена действия мастера приходит полным снимком стола, а не отдельным
    // событием журнала. Без этого окно после отмены показывало бы старый список.
    socket.on('stateReload', (state) => {
      if (!state || !Array.isArray(state.journalEntries)) return;
      entries = state.journalEntries;
      if (editingId && editingId !== 'new' && !entries.some((item) => item.id === editingId)) {
        editingId = null;
      }
      render();
    });

    socket.on('errorMessage', ({ message }) => {
      setStatus(message, 'error');
      toast(message, 'error');
    });

    $('#btn-journal-new').addEventListener('click', () => {
      editingId = 'new';
      render();
    });
    $('#btn-journal-refresh').addEventListener('click', () => {
      if (socket) socket.emit('journalRequest');
    });
    $('#journal-search').addEventListener('input', (event) => {
      query = event.target.value.trim().toLowerCase();
      render();
    });

    window.addEventListener('beforeunload', () => {
      if (socket) socket.disconnect();
    });
  })();
})();
