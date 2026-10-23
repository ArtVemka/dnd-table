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
  const TONE_KEY = 'dnd-table.tone';
  const FOCUS_KEY = 'dnd-table.focus';
  const MOTION_KEY = 'dnd-table.motion';
  const ACCENT_KEY = 'dnd-table.accents';
  /** Доступность: масштаб, контраст и безопасная для дальтоников палитра. */
  const SCALE_KEY = 'dnd-table.a11yScale';
  const CONTRAST_KEY = 'dnd-table.a11yContrast';
  const COLORBLIND_KEY = 'dnd-table.a11yColorblind';
  /** Разрешённые масштабы: ступени выбраны так, чтобы интерфейс не разъезжался. */
  const SCALES = [0.9, 1, 1.15, 1.3];
  const DEFAULT_THEME = 'standart';
  const DEFAULT_TONE = 'dark';

  /**
   * Метаданные тем: подпись, настроение, цвета превью и безопасные акценты.
   *
   * Цвета превью нужны только карточкам в настройках и не являются рабочей
   * палитрой: рабочие токены лежат в 01-tokens.css и 09-theme-studio.css.
   * Акценты подобраны так, чтобы оставаться читаемыми на своей поверхности.
   */
  const THEMES = [
    {
      id: 'standart',
      label: 'Стандартная',
      note: 'пергамент и бронза',
      preview: { bg: '#14100c', surface: '#1e1811', accent: '#d07d58', text: '#f0e6d6' },
      previewLight: { bg: '#f4eee2', surface: '#fffaf0', accent: '#9c4e29', text: '#2a2118' },
      accents: [
        { label: 'Медь', color: '#d07d58' },
        { label: 'Бронза', color: '#b08d57' },
        { label: 'Обожжённая глина', color: '#de7848' }
      ],
      accentsLight: [
        { label: 'Медь', color: '#9c4e29' },
        { label: 'Бронза', color: '#80602a' },
        { label: 'Обожжённая глина', color: '#a34a24' }
      ]
    },
    {
      id: 'les',
      label: 'Лес',
      note: 'мох, хвоя и кора',
      preview: { bg: '#0d1410', surface: '#141d17', accent: '#6fae5a', text: '#e3ece0' },
      previewLight: { bg: '#eef2e6', surface: '#f8faf1', accent: '#39742d', text: '#1f2a1a' },
      accents: [
        { label: 'Мох', color: '#6fae5a' },
        { label: 'Папоротник', color: '#86c46f' },
        { label: 'Янтарь', color: '#c8b06a' }
      ],
      accentsLight: [
        { label: 'Мох', color: '#39742d' },
        { label: 'Папоротник', color: '#356b2c' },
        { label: 'Янтарь', color: '#7d6420' }
      ]
    },
    {
      id: 'magiya',
      label: 'Магия',
      note: 'индиго, звёзды и золото',
      preview: { bg: '#100c18', surface: '#181329', accent: '#9b7ce8', text: '#ece6f8' },
      previewLight: { bg: '#f1edfa', surface: '#faf8ff', accent: '#6b46c1', text: '#241a38' },
      accents: [
        { label: 'Аметист', color: '#9b7ce8' },
        { label: 'Роза', color: '#ca71b2' },
        { label: 'Сапфир', color: '#6f8fe8' }
      ],
      accentsLight: [
        { label: 'Аметист', color: '#6b46c1' },
        { label: 'Роза', color: '#9c3f82' },
        { label: 'Сапфир', color: '#3f5fb0' }
      ]
    },
    {
      id: 'okean',
      label: 'Океан',
      note: 'глубина, бирюза и пена',
      preview: { bg: '#0a1418', surface: '#101d22', accent: '#4ea3c4', text: '#e0eef1' },
      previewLight: { bg: '#e8f3f5', surface: '#f7fcfd', accent: '#1f6f8b', text: '#15313a' },
      accents: [
        { label: 'Лагуна', color: '#4ea3c4' },
        { label: 'Коралл', color: '#e1806a' },
        { label: 'Глубина', color: '#6bbcd9' }
      ],
      accentsLight: [
        { label: 'Лагуна', color: '#1f6f8b' },
        { label: 'Коралл', color: '#a34a3a' },
        { label: 'Глубина', color: '#145a73' }
      ]
    },
    {
      id: 'traktir',
      label: 'Трактир',
      note: 'дерево, охра и свечи',
      preview: { bg: '#171009', surface: '#21170e', accent: '#d08a3c', text: '#f3e6cd' },
      previewLight: { bg: '#f6ecdc', surface: '#fff8ea', accent: '#945419', text: '#2a1b0e' },
      accents: [
        { label: 'Мёд', color: '#d08a3c' },
        { label: 'Воск', color: '#e0b552' },
        { label: 'Сидр', color: '#cb844e' }
      ],
      accentsLight: [
        { label: 'Мёд', color: '#945419' },
        { label: 'Воск', color: '#7d6218' },
        { label: 'Сидр', color: '#8a4a24' }
      ]
    },
    {
      id: 'par',
      label: 'Стимпанк',
      note: 'латунь, медь и кожа',
      preview: { bg: '#14100b', surface: '#1c1710', accent: '#c98a3c', text: '#f0e3c8' },
      previewLight: { bg: '#f2ebdf', surface: '#fbf5ea', accent: '#885816', text: '#2a2117' },
      accents: [
        { label: 'Латунь', color: '#c98a3c' },
        { label: 'Медь', color: '#d18257' },
        { label: 'Патина', color: '#64a6a0' }
      ],
      accentsLight: [
        { label: 'Латунь', color: '#885816' },
        { label: 'Медь', color: '#8a4a2a' },
        { label: 'Патина', color: '#39696f' }
      ]
    }
  ];

  const KNOWN = THEMES.map((theme) => theme.id);

  /** @param {string} key @param {string} fallback */
  function read(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch {
      // При отключённом хранилище (например, в отдельном окне без доступа)
      // просто остаёмся на значении по умолчанию, а не падаем.
      return fallback;
    }
  }

  /** @param {string} key @param {string} value */
  function write(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Выбор просто не переживёт перезапуск — это не повод ломать окно.
    }
  }

  /** Записанная тема или стандартная, если записана незнакомая. */
  function current() {
    const stored = read(STORAGE_KEY, DEFAULT_THEME);
    return KNOWN.includes(stored) ? stored : DEFAULT_THEME;
  }

  /** @returns {'dark'|'light'} */
  function currentTone() {
    return read(TONE_KEY, DEFAULT_TONE) === 'light' ? 'light' : 'dark';
  }

  function focusOn() {
    return read(FOCUS_KEY, 'off') === 'on';
  }

  function motionOn() {
    return read(MOTION_KEY, 'on') !== 'off';
  }

  /** Масштаб интерфейса: 0.9, 1, 1.15 или 1.3. */
  function fontScale() {
    const value = Number(read(SCALE_KEY, '1'));
    return SCALES.includes(value) ? value : 1;
  }

  function contrastOn() {
    return read(CONTRAST_KEY, 'off') === 'on';
  }

  function colorblindOn() {
    return read(COLORBLIND_KEY, 'off') === 'on';
  }

  /** @param {string} theme @returns {object[]} */
  function accentChoices(theme) {
    const source = THEMES.find((item) => item.id === theme) || THEMES[0];
    return currentTone() === 'light' ? source.accentsLight : source.accents;
  }

  /** @returns {Record<string,string>} */
  function readAccents() {
    try {
      const parsed = JSON.parse(read(ACCENT_KEY, '{}'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** @param {string} theme */
  function accentFor(theme) {
    const value = readAccents()[`${theme}:${currentTone()}`];
    return typeof value === 'string' ? value : '';
  }

  /**
   * Применяет акцент темы как набор переменных. Если акцент не выбран,
   * убирает подстановки и оставляет цвет из темы.
   * @param {string} theme
   */
  function applyAccent(theme) {
    const root = document.documentElement;
    for (const key of ['--accent', '--accent-hover', '--accent-soft', '--accent-ink',
      '--ring', '--wash', '--glow']) {
      root.style.removeProperty(key);
    }
    const color = accentFor(theme);
    if (!color) return;
    const light = currentTone() === 'light';
    root.style.setProperty('--accent', color);
    root.style.setProperty('--accent-hover', light
      ? `color-mix(in srgb, ${color} 82%, #000)`
      : `color-mix(in srgb, ${color} 82%, #fff)`);
    root.style.setProperty('--accent-soft', `color-mix(in srgb, ${color} 18%, transparent)`);
    root.style.setProperty('--accent-ink', light ? '#fff' : '#1f140b');
    root.style.setProperty('--ring', `color-mix(in srgb, ${color} 55%, transparent)`);
    root.style.setProperty('--wash', `color-mix(in srgb, ${color} 9%, transparent)`);
    root.style.setProperty('--glow', `color-mix(in srgb, ${color} 40%, transparent)`);
  }

  /** Собирает все настройки оформления в атрибуты html. */
  function applyState() {
    const root = document.documentElement;
    root.dataset.theme = current();
    root.dataset.tone = currentTone();
    root.dataset.focus = focusOn() ? 'on' : 'off';
    root.dataset.motion = motionOn() ? 'on' : 'off';
    // Масштаб — атрибутом, чтобы CSS не знал про localStorage: так же в окне
    // журнала и листа, где этот файл общий.
    const scale = fontScale();
    if (scale === 1) delete root.dataset.a11yScale;
    else root.dataset.a11yScale = String(scale);
    root.dataset.a11yContrast = contrastOn() ? 'on' : 'off';
    root.dataset.a11yColorblind = colorblindOn() ? 'on' : 'off';
    applyAccent(current());
  }

  function notify() {
    try {
      global.dispatchEvent(new CustomEvent('dnd-theme-change', {
        detail: {
          theme: current(),
          tone: currentTone(),
          focus: focusOn(),
          motion: motionOn()
        }
      }));
    } catch {
      // Старый контекст без CustomEvent: настройки уже применены.
    }
  }

  /**
   * Переключает тему и запоминает выбор.
   * @param {string} id
   */
  function apply(id) {
    const theme = KNOWN.includes(id) ? id : DEFAULT_THEME;
    write(STORAGE_KEY, theme);
    applyState();
    notify();
    return theme;
  }

  /** @param {'dark'|'light'} tone */
  function setTone(tone) {
    write(TONE_KEY, tone === 'light' ? 'light' : 'dark');
    applyState();
    notify();
  }

  /** @param {boolean} on */
  function setFocus(on) {
    write(FOCUS_KEY, on ? 'on' : 'off');
    applyState();
    notify();
  }

  /** @param {boolean} on */
  function setMotion(on) {
    write(MOTION_KEY, on ? 'on' : 'off');
    applyState();
    notify();
  }

  /** @param {number} scale */
  function setFontScale(scale) {
    const value = Number(scale);
    write(SCALE_KEY, String(SCALES.includes(value) ? value : 1));
    applyState();
    notify();
  }

  /** @param {boolean} on */
  function setContrast(on) {
    write(CONTRAST_KEY, on ? 'on' : 'off');
    applyState();
    notify();
  }

  /** @param {boolean} on */
  function setColorblind(on) {
    write(COLORBLIND_KEY, on ? 'on' : 'off');
    applyState();
    notify();
  }

  /**
   * @param {string} theme
   * @param {string} color пустая строка возвращает цвет темы
   */
  function setAccent(theme, color) {
    const map = readAccents();
    const key = `${theme}:${currentTone()}`;
    if (color) map[key] = color;
    else delete map[key];
    write(ACCENT_KEY, JSON.stringify(map));
    applyAccent(current());
    notify();
  }

  /** @param {string} theme */
  function clearAccent(theme) {
    setAccent(theme, '');
  }

  applyState();

  // Окно листа персонажа открывается отдельным окном и держит свою копию
  // страницы. Событие storage приходит в чужие окна при изменении хранилища,
  // поэтому смена темы, тона и режима в главном окне сразу видна и в листе.
  try {
    const watched = new Set([STORAGE_KEY, TONE_KEY, FOCUS_KEY, MOTION_KEY, ACCENT_KEY,
      SCALE_KEY, CONTRAST_KEY, COLORBLIND_KEY]);
    global.addEventListener('storage', (event) => {
      if (!watched.has(event.key)) return;
      applyState();
      notify();
    });
  } catch {
    // Старый или ограниченный контекст без события storage: тема просто
    // обновится при следующем открытии окна.
  }

  global.DnDTheme = {
    STORAGE_KEY,
    TONE_KEY,
    FOCUS_KEY,
    MOTION_KEY,
    ACCENT_KEY,
    SCALE_KEY,
    CONTRAST_KEY,
    COLORBLIND_KEY,
    SCALES,
    DEFAULT_THEME,
    DEFAULT_TONE,
    THEMES,
    current,
    currentTone,
    focusOn,
    motionOn,
    fontScale,
    contrastOn,
    colorblindOn,
    accentFor,
    accentChoices,
    apply,
    setTone,
    setFocus,
    setMotion,
    setFontScale,
    setContrast,
    setColorblind,
    setAccent,
    clearAccent
  };
}(window));
