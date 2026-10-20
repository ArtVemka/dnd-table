'use strict';

/**
 * Темы оформления.
 *
 * Скрипт подключается в head, до подключения стилей: иначе окно на секунду
 * показывало бы стандартную тему и потом дёргалось на выбранную. Отдельный
 * файл, а не код в конце app.js, ещё и потому, что политика безопасности
 * запрещает встроенные скрипты, а окно листа персонажа открывается раньше.
 */

(function initTheme(global) {
  const STORAGE_KEY = 'dnd-table.theme';
  const DEFAULT_THEME = 'standart';

  const THEMES = [
    { id: 'standart', label: 'Стандартная' },
    { id: 'les', label: 'Лес' },
    { id: 'magiya', label: 'Магия' },
    { id: 'okean', label: 'Океан' },
    { id: 'traktir', label: 'Трактир' },
    { id: 'par', label: 'Стимпанк' }
  ];

  const KNOWN = THEMES.map((theme) => theme.id);

  /** Записанная тема или стандартная, если записана незнакомая. */
  function current() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return KNOWN.includes(stored) ? stored : DEFAULT_THEME;
    } catch {
      // При отключённом хранилище (например, в отдельном окне без доступа)
      // просто остаёмся на стандартной теме, а не падаем.
      return DEFAULT_THEME;
    }
  }

  /**
   * Переключает тему и запоминает выбор.
   * @param {string} id
   */
  function apply(id) {
    const theme = KNOWN.includes(id) ? id : DEFAULT_THEME;
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Выбор просто не переживёт перезапуск — это не повод ломать окно.
    }
    return theme;
  }

  apply(current());

  // Окно листа персонажа открывается отдельным окном и держит свою копию
  // страницы. Событие storage приходит в чужие окна при изменении хранилища,
  // поэтому смена темы в главном окне сразу видна и в листе — без всяких
  // сообщений между процессами.
  try {
    global.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY) return;
      const theme = KNOWN.includes(event.newValue) ? event.newValue : DEFAULT_THEME;
      document.documentElement.dataset.theme = theme;
    });
  } catch {
    // Старый или ограниченный контекст без события storage: тема просто
    // обновится при следующем открытии окна.
  }

  global.DnDTheme = { STORAGE_KEY, DEFAULT_THEME, THEMES, current, apply };
}(window));
