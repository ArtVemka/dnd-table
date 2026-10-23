'use strict';

/**
 * Компоненты общего стола: карта с фишками, список игроков, чат и панель кубиков.
 *
 * Координаты фишек хранятся как доли от размера карты (x и y от 0 до 1),
 * поэтому позиции совпадают у всех клиентов независимо от размера окна.
 */

(function (global) {
  const DnD = global.DnD5e;
  const {
    darknessAlpha,
    lightGrid,
    lightPolygon,
    normalizeLights,
    normalizeWalls,
    wallsInCells
  } = DnD;

  /** Значение списка выбора, за которым стоит свободная строка имени. */
  const CUSTOM_PICK = 'custom';

  /**
   * Во сколько раз меньше холста считается свет.
   *
   * Свет считается по многоугольникам видимости, а не по пикселям, поэтому
   * подробность ему не нужна. Половинного хватает с запасом: растягивание с
   * билинейным сглаживанием убирает лесенку на границе тени, а просчёт на
   * полном размере карты при перетаскивании фишки заметно бы подтормаживал.
   */
  const LIGHT_RENDER_SCALE = 0.5;

  /**
   * Размытие света, доля от ширины карты.
   *
   * Без него тень от стены идёт идеально прямой линией от источника: полигон
   * видимости устроен именно так, и на настоящей настольной игре края мягкие.
   * Размываем при выводе, а не при расчёте: считать свет попиксельно ради
   * мягкости незачем, хватит готового буфера.
   */
  const LIGHT_BLUR_RATIO = 0.018;

  /**
   * Насколько пятно света подмешивается к карте.
   *
   * Свет рисуется экранированием поверх ночной завесы, и при полной силе он
   * выбеливает карту в белое: видно было бы не комнату, а пятно. Половина
   * оставляет карту читаемой, а оттенок источника всё равно различим.
   */
  const LIGHT_GLOW_STRENGTH = 0.5;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * Ступень градиента заданным цветом с нужной прозрачностью.
   *
   * Отдельная функция, потому что цвет приходит строкой `#rrggbb` из модели
   * источника, а холсту нужен rgba: разбирать цвет на каналы приходится в
   * каждой из семи ступеней градиента, а ступеней столько у каждого пятна.
   * @param {string} hex
   * @param {number} alpha От 0 до 1.
   * @returns {string}
   */
  function tintedStop(hex, alpha) {
    const color = /^#[0-9a-f]{6}$/i.test(String(hex)) ? hex : '#ffffff';
    const red = parseInt(color.slice(1, 3), 16);
    const green = parseInt(color.slice(3, 5), 16);
    const blue = parseInt(color.slice(5, 7), 16);
    return `rgba(${red}, ${green}, ${blue}, ${Math.round(alpha * 255) / 255})`;
  }

  function formatTime(iso) {
    const date = iso ? new Date(iso) : new Date();
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function initials(name) {
    const clean = String(name || '?').trim();
    return clean ? clean.slice(0, 1).toUpperCase() : '?';
  }

  /**
   * Кружок с портретом, а без картинки — с буквой имени.
   *
   * Ссылка может быть двух видов: /files/<имя> с картинками кампании (её
   * разбирает вызывающий через assetUrl) либо путь из поставки, как у портрета
   * мастера по умолчанию.
   * @param {string} [src] уже готовая ссылка
   * @param {string} name имя для буквы-заглушки
   * @param {string} [className]
   * @returns {HTMLElement}
   */
  function avatarNode(src, name, className) {
    const node = el('div', className || 'player-row__avatar');
    if (src) {
      const img = document.createElement('img');
      img.className = 'player-row__avatar-img';
      img.alt = '';
      img.src = src;
      // Портрет мог не загрузиться: нет файла, битая ссылка. Кружок с буквой
      // куда полезнее пустого или сломанного значка.
      img.addEventListener('error', () => {
        img.remove();
        node.textContent = initials(name);
        node.classList.remove('has-image');
      });
      node.appendChild(img);
      node.classList.add('has-image');
      return node;
    }
    node.textContent = initials(name);
    return node;
  }

  /**
   * Сворачиваемая секция панели: заголовок с треугольником и тело под ним.
   *
   * Правая колонка узкая, а секций в ней сразу несколько (список спавна, все
   * фишки, история бросков), и каждая по отдельности редко нужна. Свёрнутое
   * состояние помнится в localStorage: мастер, который перед боем убрал
   * спавн, не хочет видеть его снова в следующей партии.
   * @param {string} title
   * @param {string} [storageKey] ключ состояния; без него состояние не хранится
   * @param {{collapsed?: boolean, subtitle?: HTMLElement, alwaysOpen?: boolean}} [options]
   * @returns {{wrap: HTMLElement, body: HTMLElement}}
   */
  function section(title, storageKey, options = {}) {
    const wrap = el('div', 'section section--collapsible');
    const head = el('button', 'section__head');
    head.type = 'button';
    head.appendChild(el('span', 'section__caret', '▾'));
    const label = el('span', 'section__title', title);
    head.appendChild(label);
    if (options.subtitle) head.appendChild(options.subtitle);

    const body = el('div', 'section__body');
    let stored = null;
    if (storageKey) {
      try {
        stored = localStorage.getItem(storageKey);
      } catch {
        // Хранилище может быть недоступно: панель обязана собраться и без него.
        stored = null;
      }
    }
    // let, а не const: состояние переключается по клику, и на const обработчик
    // молча падал бы с «Assignment to constant variable».
    let collapsed = stored === null ? Boolean(options.collapsed) : stored === '1';

    const apply = () => {
      wrap.classList.toggle('is-collapsed', collapsed);
      body.hidden = collapsed;
      head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    };
    head.addEventListener('click', () => {
      collapsed = !collapsed;
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, collapsed ? '1' : '0');
        } catch {
          // Не запомнили — не беда, секция всё равно свернулась.
        }
      }
      apply();
      // При раскрытии содержимое успело отлежаться в свёрнутом виде: ленты,
      // которые сами себя докручивают вниз, приходится догонять руками.
      if (!collapsed && options.onExpand) options.onExpand();
    });
    apply();

    wrap.appendChild(head);
    wrap.appendChild(body);
    return { wrap, body, head };
  }

  /* ====================================================================== *
   * Меню фишки: одно и то же из правого клика по карте и по строке списка
   * ====================================================================== */

  /**
   * Собирает содержимое меню фишки.
   *
   * Отдельная функция, а не метод одной из панелей, потому что меню открывают
   * две разные вещи: правая кнопка по фишке на карте и правая кнопка по строке
   * в списке. Дублировать список пунктов значило бы со временем забыть про один
   * из них — и мастер обнаружит это в середине боя.
   * @param {object} token
   * @param {object[]} players список участников стола
   * @param {object} handlers те же обработчики, что и у панели
   * @param {Function} close закрыть меню перед действием
   * @param {{activeMap?: string|null, activeMapId?: string|null, canTransfer?: boolean}} [options]
   *   карта, которую видят игроки: нужна для переноса фишки
   * @returns {HTMLElement}
   */
  function buildTokenMenu(token, players, handlers, close, options = {}) {
    const menu = el('div', 'token-menu');

    const rename = el('button', 'token-menu__item', 'Переименовать');
    rename.type = 'button';
    rename.addEventListener('click', () => {
      close();
      if (handlers.onRenameToken) handlers.onRenameToken(token);
    });
    menu.appendChild(rename);

    // Скрытое имя — отдельный пункт, а не галочка: мастер решает по одной фишке,
    // и галочка в меню пришла бы с состоянием по умолчанию «показывать».
    const nameVisibility = el('button', 'token-menu__item',
      token.hideName ? 'Показать имя игрокам' : 'Скрыть имя от игроков');
    nameVisibility.type = 'button';
    nameVisibility.addEventListener('click', () => {
      close();
      if (handlers.onToggleTokenNameHidden) handlers.onToggleTokenNameHidden(token.id, !token.hideName);
    });
    menu.appendChild(nameVisibility);

    // Подписи снизу убираются совсем и у всех, включая мастера: на тесной карте
    // их больше, чем нужно. Это не тайна, поэтому отдельная от «скрытого имени».
    const labels = el('button', 'token-menu__item',
      token.hideLabels ? 'Показать подписи' : 'Скрыть подписи');
    labels.type = 'button';
    labels.title = token.hideLabels
      ? 'Подписи появятся у всех участников'
      : 'Убрать под фишкой имя, хозяина и состояния у всех участников';
    labels.addEventListener('click', () => {
      close();
      if (handlers.onToggleTokenLabelsHidden) handlers.onToggleTokenLabelsHidden(token.id, !token.hideLabels);
    });
    menu.appendChild(labels);

    const imageLabel = el('label', 'token-menu__item');
    imageLabel.appendChild(el('span', null, token.imageUrl ? 'Заменить изображение' : 'Изображение'));
    const file = el('input');
    file.type = 'file';
    file.accept = 'image/png,image/jpeg,image/webp';
    file.hidden = true;
    file.addEventListener('change', () => {
      const selected = file.files && file.files[0];
      close();
      if (selected && handlers.onSetTokenImage) handlers.onSetTokenImage(token.id, selected);
    });
    imageLabel.appendChild(file);
    menu.appendChild(imageLabel);

    const assign = el('div', 'token-menu__section');
    assign.appendChild(el('div', 'token-menu__title', 'Назначить игроку'));
    const select = el('select', 'select');
    const none = el('option', null, '— никому —');
    none.value = '';
    select.appendChild(none);
    for (const player of players || []) {
      if (player.role === 'dm') continue;
      const option = el('option', null, player.name);
      option.value = player.playerId;
      if (player.playerId === token.assignedPlayerId) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      close();
      if (handlers.onAssignToken) handlers.onAssignToken(token.id, select.value || null);
    });
    assign.appendChild(select);
    menu.appendChild(assign);

    // Перенос на показанную карту: заготовку можно ставить на любую вкладку,
    // а в момент сцены перевести на ту, которую уже видят игроки.
    if (options.canTransfer && options.activeMapId) {
      const onActive = token.mapType === options.activeMap
        && (!token.mapId || token.mapId === options.activeMapId);
      const transfer = el('button', 'token-menu__item', 'На карту игроков');
      transfer.type = 'button';
      transfer.disabled = onActive;
      transfer.title = onActive
        ? 'Фишка уже на карте, которую видят игроки'
        : 'Перенести фишку в центр карты, которую видят игроки';
      transfer.addEventListener('click', () => {
        close();
        if (handlers.onMoveTokenToActive) handlers.onMoveTokenToActive(token.id);
      });
      menu.appendChild(transfer);
    }

    const visibility = el('button', 'token-menu__item',
      token.hidden ? 'Показать игрокам' : 'Скрыть от игроков');
    visibility.type = 'button';
    visibility.addEventListener('click', () => {
      close();
      if (handlers.onToggleTokenHidden) handlers.onToggleTokenHidden(token.id, !token.hidden);
    });
    menu.appendChild(visibility);

    const remove = el('button', 'token-menu__item token-menu__item--danger', 'Удалить фишку');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      close();
      if (handlers.onDeleteToken) handlers.onDeleteToken(token.id);
    });
    menu.appendChild(remove);

    return menu;
  }

  /**
   * Показывает меню у точки на экране и вешает его закрытие.
   *
   * Закрытие цепляется к документу с задержкой в такт: если убрать меню по
   * pointerdown, кнопка исчезнет из документа раньше события click, и ни один
   * пункт (и выбор файла) не сработает.
   * @param {HTMLElement} menu
   * @param {number} clientX
   * @param {number} clientY
   * @param {{openMenu: HTMLElement|null, closeMenuHandler: ?Function, escapeHandler: ?Function}} owner
   */
  function placeTokenMenu(menu, clientX, clientY, owner) {
    owner.closeMenu();
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;
    document.body.appendChild(menu);
    owner.openMenu = menu;
    owner.closeMenuHandler = (event) => {
      if (menu.contains(event.target)) return;
      owner.closeMenu();
    };
    owner.escapeHandler = (event) => {
      if (event.key === 'Escape') owner.closeMenu();
    };
    setTimeout(() => {
      if (owner.openMenu !== menu) return;
      document.addEventListener('pointerdown', owner.closeMenuHandler, true);
      document.addEventListener('keydown', owner.escapeHandler);
    }, 0);
  }

  /* ====================================================================== *
   * Холст: нарисовать карту самому
   * ====================================================================== */

  const SKETCH_COLORS = ['#1b1b1b', '#c0392b', '#2c6fbb', '#3f8f45', '#d9a441', '#ffffff'];
  /** Размер чистого холста в клетках: 24x17 — привычный лист для карты. */
  const SKETCH_CELLS = { across: 24, down: 17 };
  /** Холст не делаем меньше: иначе маленькая подложка даёт крошечный рисунок. */
  const SKETCH_MIN_CELLS = 8;
  /** Пределы приближения карты (в разах). */
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 6;
  const ZOOM_STEP = 1.25;
  /**
   * Сколько миллисекунд фишка идёт на одну клетку.
   *
   * Быстрее 60 мс шаг сливается в прыжок, медленнее 150 — бой превращается в
   * ожидание. 80 мгс на клетку даёт примерно двенадцать шагов в секунду.
   */
  const COMBAT_STEP_MS = 80;

  /**
   * Простой редактор карты: два холста друг над другом (фон и штрихи),
   * поэтому ластик не «съедает» подложку, а лишь возвращает её.
   *
   * Размер ячейки сетки совпадает с размером фишки, поэтому стены удобно
   * рисовать по клеткам: то, что нарисовано в одной клетке, займёт ровно одну
   * клетку и на карте стола.
   */
  class SketchEditor {
    /**
     * @param {HTMLElement} root
     * @param {{onSave?: Function, onClose?: Function, onNotice?: Function, resolveUrl?: Function}} handlers
     */
    constructor(root, handlers = {}) {
      this.root = root;
      this.handlers = handlers;
      this.resolveUrl = handlers.resolveUrl || ((url) => url);

      this.cell = DnD.GRID.defaultCell;
      this.width = SKETCH_CELLS.across * this.cell;
      this.height = SKETCH_CELLS.down * this.cell;
      this.backgroundType = '';
      this.backgroundScale = 1;
      this.tool = 'brush';
      this.color = SKETCH_COLORS[0];
      this.size = 6;
      this.snap = true;
      this.target = 'world';
      this.strokes = [];
      this.background = null;
      this.active = false;
      this.build();
    }

    build() {
      this.root.innerHTML = '';
      this.root.classList.add('sketch');

      const tools = el('div', 'sketch__tools');
      const group = (parent) => {
        const node = el('div', 'sketch__group');
        parent.appendChild(node);
        return node;
      };

      this.toolButtons = {};
      const toolGroup = group(tools);
      for (const [key, label] of [['brush', 'Кисть'], ['line', 'Линия'], ['rect', 'Прямоугольник'], ['eraser', 'Ластик']]) {
        const button = el('button', 'btn btn--ghost', label);
        button.type = 'button';
        button.addEventListener('click', () => this.setTool(key));
        this.toolButtons[key] = button;
        toolGroup.appendChild(button);
      }

      const colorField = el('label', 'sketch__field');
      colorField.appendChild(el('span', null, 'Цвет'));
      const colorInput = el('input', 'sketch__color');
      colorInput.type = 'color';
      colorInput.value = this.color;
      colorInput.addEventListener('input', () => {
        this.color = colorInput.value;
        this.setTool('brush');
      });
      this.colorInput = colorInput;
      colorField.appendChild(colorInput);
      tools.appendChild(colorField);

      const swatches = el('div', 'sketch__swatches');
      for (const color of SKETCH_COLORS) {
        const swatch = el('button', 'sketch__swatch');
        swatch.type = 'button';
        swatch.style.background = color;
        swatch.title = color;
        swatch.addEventListener('click', () => {
          this.color = color;
          colorInput.value = color;
          if (this.tool === 'eraser') this.setTool('brush');
        });
        swatches.appendChild(swatch);
      }
      tools.appendChild(swatches);

      const sizeField = el('label', 'sketch__field');
      sizeField.appendChild(el('span', null, 'Толщина'));
      const sizeInput = el('input', 'sketch__size');
      sizeInput.type = 'range';
      sizeInput.min = '2';
      sizeInput.max = '48';
      sizeInput.value = String(this.size);
      const sizeValue = el('span', 'sketch__value', String(this.size));
      sizeInput.addEventListener('input', () => {
        this.size = Number(sizeInput.value);
        sizeValue.textContent = String(this.size);
      });
      sizeField.appendChild(sizeInput);
      sizeField.appendChild(sizeValue);
      tools.appendChild(sizeField);

      const snapLabel = el('label', 'sketch__check');
      const snapInput = el('input');
      snapInput.type = 'checkbox';
      snapInput.checked = this.snap;
      snapInput.addEventListener('change', () => { this.snap = snapInput.checked; });
      snapLabel.appendChild(snapInput);
      snapLabel.appendChild(el('span', null, 'Начало и конец штриха — по клеткам'));
      tools.appendChild(snapLabel);

      const actions = group(tools);
      const undo = el('button', 'btn btn--ghost', 'Отменить штрих');
      undo.type = 'button';
      undo.addEventListener('click', () => this.undo());
      const clear = el('button', 'btn btn--ghost btn--danger', 'Очистить');
      clear.type = 'button';
      clear.addEventListener('click', () => this.clear());
      actions.appendChild(undo);
      actions.appendChild(clear);

      const background = group(tools);
      background.appendChild(el('span', 'sketch__label', 'Подложка'));
      const bgSelect = el('select', 'select sketch__background');
      this.bgSelect = bgSelect;
      bgSelect.addEventListener('change', () => this.onBackgroundChoice(bgSelect.value));
      background.appendChild(bgSelect);
      const bgFile = el('input');
      bgFile.type = 'file';
      bgFile.accept = 'image/png,image/jpeg,image/webp';
      bgFile.hidden = true;
      bgFile.addEventListener('change', () => {
        const selected = bgFile.files && bgFile.files[0];
        bgFile.value = '';
        if (selected) this.loadBackgroundFile(selected);
      });
      this.bgFile = bgFile;
      background.appendChild(bgFile);

      const save = group(tools);
      save.appendChild(el('span', 'sketch__label', 'Сохранить в'));
      const target = el('select', 'select sketch__target');
      for (const type of DnD.MAP_TYPES) {
        const option = el('option', null, DnD.MAP_LABELS[type]);
        option.value = type;
        target.appendChild(option);
      }
      target.addEventListener('change', () => { this.target = target.value; });
      this.targetSelect = target;
      save.appendChild(target);
      const saveButton = el('button', 'btn btn--accent', 'Сделать картой');
      saveButton.type = 'button';
      saveButton.addEventListener('click', () => this.save());
      save.appendChild(saveButton);

      const exit = el('button', 'btn btn--ghost sketch__exit', '← Выйти из рисования');
      exit.type = 'button';
      exit.addEventListener('click', () => {
        if (this.handlers.onClose) this.handlers.onClose();
      });
      tools.appendChild(exit);

      this.root.appendChild(tools);

      const stage = el('div', 'sketch__stage');
      const board = el('div', 'sketch__board');
      this.board = board;

      this.bgCanvas = el('canvas', 'sketch__canvas sketch__canvas--bg');
      this.drawCanvas = el('canvas', 'sketch__canvas sketch__canvas--draw');
      this.gridLayer = el('div', 'sketch__grid');

      board.appendChild(this.bgCanvas);
      board.appendChild(this.gridLayer);
      board.appendChild(this.drawCanvas);
      stage.appendChild(board);
      this.root.appendChild(stage);
      this.stage = stage;

      this.root.appendChild(el('div', 'sketch__hint muted',
        'Рисуйте мышью по холсту. Размер клетки совпадает с размером фишки: штрих, начатый и законченный в клетке, '
        + 'займёт ровно эту клетку на карте стола. Подложкой можно взять любую загруженную карту или файл — '
        + 'тогда рисунок ляжет поверх неё.'));

      this.bgCtx = this.bgCanvas.getContext('2d');
      this.drawCtx = this.drawCanvas.getContext('2d');
      this.drawCanvas.addEventListener('pointerdown', (event) => this.startStroke(event));
      this.setTool('brush');
    }

    /** @param {string} tool */
    setTool(tool) {
      this.tool = tool;
      for (const [key, button] of Object.entries(this.toolButtons)) {
        button.classList.toggle('is-active', key === tool);
      }
      this.drawCanvas.classList.toggle('is-eraser', tool === 'eraser');
    }

    /** @param {number} cell */
    setGrid(cell) {
      this.cell = cell;
      this.board.style.setProperty('--sketch-cell', `${cell}px`);
    }

    /** @param {string} type */
    setTarget(type) {
      if (!DnD.MAP_TYPES.includes(type)) return;
      this.target = type;
      if (this.targetSelect) this.targetSelect.value = type;
    }

    /**
     * Открывает редактор.
     * @param {{cell?: number, target?: string, backgroundType?: string}} [options]
     */
    open(options = {}) {
      if (options.cell) this.setGrid(options.cell);
      this.setTarget(options.target || this.target);
      this.strokes = [];
      this.background = null;
      this.backgroundType = options.backgroundType || '';
      this.refreshBackgroundOptions();
      this.setCanvasSize(
        SKETCH_CELLS.across * this.cell,
        SKETCH_CELLS.down * this.cell
      );
      if (this.backgroundType) this.loadBackgroundFromType(this.backgroundType);
    }

    /** Список подложек: какие карты загружены, у тех и можно взять картинку. */
    refreshBackgroundOptions() {
      if (!this.bgSelect) return;
      const available = this.handlers.availableMaps ? this.handlers.availableMaps() : {};
      this.bgSelect.innerHTML = '';

      const none = el('option', null, 'чистый лист');
      none.value = '';
      this.bgSelect.appendChild(none);

      for (const type of DnD.MAP_TYPES) {
        const option = el('option', null, DnD.MAP_LABELS[type]);
        option.value = type;
        option.disabled = !available[type];
        if (!available[type]) option.textContent += ' (пусто)';
        this.bgSelect.appendChild(option);
      }

      const fromFile = el('option', null, 'из файла…');
      fromFile.value = 'file';
      this.bgSelect.appendChild(fromFile);

      this.bgSelect.value = this.backgroundType || '';
    }

    /** @param {string} value */
    onBackgroundChoice(value) {
      if (value === 'file') {
        this.bgFile.click();
        this.bgSelect.value = this.backgroundType || '';
        return;
      }
      if (!value) {
        this.background = null;
        this.backgroundType = '';
        this.paintBackground();
        return;
      }
      this.loadBackgroundFromType(value);
    }

    /** @param {string} type */
    loadBackgroundFromType(type) {
      const url = this.handlers.mapUrl ? this.handlers.mapUrl(type) : '';
      if (!url) {
        if (this.handlers.onNotice) this.handlers.onNotice(`Карта «${DnD.MAP_LABELS[type]}» ещё не загружена`);
        this.backgroundType = '';
        this.refreshBackgroundOptions();
        return;
      }
      this.backgroundType = type;
      this.bgSelect.value = type;
      this.applyBackground(url);
    }

    /**
     * Задаёт размер холста. Размер округляется вверх до целых клеток: тогда
     * линии сетки попадают ровно на клетки, а не «плывут».
     */
    setCanvasSize(width, height) {
      const cell = this.cell;
      const atLeast = SKETCH_MIN_CELLS * cell;
      this.width = Math.max(atLeast, Math.ceil(width / cell) * cell);
      this.height = Math.max(atLeast, Math.ceil(height / cell) * cell);
      for (const canvas of [this.bgCanvas, this.drawCanvas]) {
        canvas.width = this.width;
        canvas.height = this.height;
      }
      this.board.style.width = `${this.width}px`;
      this.board.style.height = `${this.height}px`;
      this.paintBackground();
      this.repaintStrokes();
      this.layout();
    }

    /** Подгоняет холст под размер окна (сам холст остаётся своего размера). */
    layout() {
      if (!this.stage) return;
      const availableWidth = this.stage.clientWidth - 16;
      const availableHeight = this.stage.clientHeight - 16;
      if (availableWidth <= 0 || availableHeight <= 0) return;
      const scale = Math.min(1, availableWidth / this.width, availableHeight / this.height);
      this.board.style.transform = `scale(${scale})`;
      // Линии сетки на уменьшенном холсте делаем тоньше, иначе они выглядят
      // расплывчатыми и «неровными».
      this.board.style.setProperty('--sketch-line', `${Math.max(1, 1 / scale).toFixed(2)}px`);
    }

    /** @param {PointerEvent} event */
    pointAt(event) {
      const rect = this.board.getBoundingClientRect();
      if (!rect.width || !rect.height) return { x: 0, y: 0 };
      const x = ((event.clientX - rect.left) / rect.width) * this.width;
      const y = ((event.clientY - rect.top) / rect.height) * this.height;
      return {
        x: Math.max(0, Math.min(this.width, x)),
        y: Math.max(0, Math.min(this.height, y))
      };
    }

    /** Округляет точку до узла сетки. */
    snapPoint(point) {
      const cell = this.cell;
      return {
        x: Math.max(0, Math.min(this.width, Math.round(point.x / cell) * cell)),
        y: Math.max(0, Math.min(this.height, Math.round(point.y / cell) * cell))
      };
    }

    startStroke(event) {
      if (this.active) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      this.active = true;

      const first = this.pointAt(event);
      const stroke = {
        tool: this.tool,
        color: this.color,
        size: this.size,
        points: [this.snap && this.tool !== 'eraser' ? this.snapPoint(first) : first]
      };

      const move = (moveEvent) => {
        const last = stroke.points[stroke.points.length - 1];
        const next = this.pointAt(moveEvent);
        if (stroke.tool === 'brush' || stroke.tool === 'eraser') {
          if (Math.hypot(next.x - last.x, next.y - last.y) < 1) return;
          stroke.points.push(next);
          this.paintSegment(last, next, stroke);
          return;
        }
        // Линия и прямоугольник: тянем второй угол.
        stroke.preview = next;
        this.repaintStrokes();
        this.paintShape(stroke, stroke.points[0], next);
      };

      const up = () => {
        this.drawCanvas.removeEventListener('pointermove', move);
        this.drawCanvas.removeEventListener('pointerup', up);
        this.drawCanvas.removeEventListener('pointercancel', up);
        this.active = false;
        let last = stroke.points[stroke.points.length - 1];
        if (stroke.preview) last = stroke.preview;
        delete stroke.preview;
        if (this.snap && stroke.tool !== 'eraser') last = this.snapPoint(last);
        stroke.points.push(last);
        this.strokes.push(stroke);
        this.repaintStrokes();
      };

      this.drawCanvas.addEventListener('pointermove', move);
      this.drawCanvas.addEventListener('pointerup', up);
      this.drawCanvas.addEventListener('pointercancel', up);

      if (stroke.tool === 'brush' || stroke.tool === 'eraser') {
        this.paintSegment(stroke.points[0], stroke.points[0], stroke);
      } else {
        this.paintShape(stroke, stroke.points[0], stroke.points[0]);
      }
    }

    applyStrokeStyle(stroke) {
      const ctx = this.drawCtx;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = stroke.size;
      if (stroke.tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0, 0, 0, 1)';
        ctx.fillStyle = 'rgba(0, 0, 0, 1)';
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = stroke.color;
        ctx.fillStyle = stroke.color;
      }
    }

    paintSegment(from, to, stroke) {
      const ctx = this.drawCtx;
      ctx.save();
      this.applyStrokeStyle(stroke);
      ctx.beginPath();
      if (from.x === to.x && from.y === to.y) {
        // Одиночный клик: крошечный отрезок, иначе следа не останется.
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(from.x + 0.01, from.y + 0.01);
      } else {
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    paintShape(stroke, from, to) {
      const ctx = this.drawCtx;
      ctx.save();
      this.applyStrokeStyle(stroke);
      ctx.beginPath();
      if (stroke.tool === 'rect') {
        ctx.rect(Math.min(from.x, to.x), Math.min(from.y, to.y), Math.abs(to.x - from.x), Math.abs(to.y - from.y));
      } else {
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    paintStroke(stroke) {
      if (stroke.tool === 'line' || stroke.tool === 'rect') {
        const points = stroke.points;
        this.paintShape(stroke, points[0], points[points.length - 1]);
        return;
      }
      const points = stroke.points;
      if (points.length === 1) {
        this.paintSegment(points[0], points[0], stroke);
        return;
      }
      for (let index = 1; index < points.length; index += 1) {
        this.paintSegment(points[index - 1], points[index], stroke);
      }
    }

    repaintStrokes() {
      this.drawCtx.clearRect(0, 0, this.width, this.height);
      for (const stroke of this.strokes) this.paintStroke(stroke);
      this.board.dataset.strokes = String(this.strokes.length);
    }

    paintBackground() {
      const ctx = this.bgCtx;
      ctx.clearRect(0, 0, this.width, this.height);
      // Светлый фон: карта не должна быть прозрачной, иначе на тёмном столе
      // вместо карты видно пустоту.
      ctx.fillStyle = '#f3ecdd';
      ctx.fillRect(0, 0, this.width, this.height);
      if (this.background) {
        // Подложку рисуем в её собственном размере, а не растягиваем на весь
        // холст: иначе карта на рисунке получается приплюснутой.
        const scale = this.backgroundScale || 1;
        ctx.drawImage(
          this.background,
          0,
          0,
          this.background.naturalWidth * scale,
          this.background.naturalHeight * scale
        );
      }
    }

    /** Подложка из выбранного файла. */
    loadBackgroundFile(file) {
      const reader = new FileReader();
      reader.onload = () => {
        this.backgroundType = '';
        this.refreshBackgroundOptions();
        this.applyBackground(String(reader.result));
      };
      reader.onerror = () => {
        if (this.handlers.onNotice) this.handlers.onNotice(`Не удалось прочитать файл «${file.name}»`);
      };
      reader.readAsDataURL(file);
    }

    /**
     * @param {string} url
     */
    applyBackground(url) {
      const image = new Image();
      // Подложка приходит с сервера стола: без crossOrigin холст «загрязнится»
      // и сохранить рисунок будет нельзя.
      image.crossOrigin = 'anonymous';
      image.onload = () => {
        if (!image.naturalWidth || !image.naturalHeight) {
          this.background = null;
          this.paintBackground();
          if (this.handlers.onNotice) this.handlers.onNotice('Подложка пустая — рисуем на чистом листе');
          return;
        }
        this.background = image;
        this.backgroundScale = Math.min(1, DnD.SKETCH.maxSide / Math.max(image.naturalWidth, image.naturalHeight));
        // setCanvasSize округлит размер вверх до целых клеток и перерисует слои.
        this.setCanvasSize(
          image.naturalWidth * this.backgroundScale,
          image.naturalHeight * this.backgroundScale
        );
      };
      image.onerror = () => {
        this.background = null;
        this.backgroundType = '';
        this.refreshBackgroundOptions();
        this.paintBackground();
        if (this.handlers.onNotice) this.handlers.onNotice('Не удалось загрузить подложку — рисуем на чистом листе');
      };
      image.src = url;
    }

    undo() {
      if (!this.strokes.length) return;
      this.strokes.pop();
      this.repaintStrokes();
    }

    clear() {
      this.strokes = [];
      this.repaintStrokes();
    }

    /** Склеивает подложку и штрихи и отдаёт готовую картинку. */
    save() {
      const out = document.createElement('canvas');
      out.width = this.width;
      out.height = this.height;
      const ctx = out.getContext('2d');
      ctx.drawImage(this.bgCanvas, 0, 0);
      ctx.drawImage(this.drawCanvas, 0, 0);
      const name = `${DnD.MAP_LABELS[this.target] || 'Рисунок'}.png`;
      try {
        out.toBlob((blob) => {
          if (!blob) {
            if (this.handlers.onNotice) this.handlers.onNotice('Не удалось сохранить рисунок');
            return;
          }
          if (this.handlers.onSave) {
            this.handlers.onSave(this.target, new File([blob], name, { type: 'image/png' }));
          }
        }, 'image/png');
      } catch (error) {
        if (this.handlers.onNotice) {
          this.handlers.onNotice(`Не удалось сохранить рисунок: ${error.message}. Попробуйте убрать подложку.`);
        }
      }
    }
  }

  /* ====================================================================== *
   * Карта + фишки
   * ====================================================================== */

  class MapView {
    /**
     * @param {HTMLElement} root
     * @param {{onSetActive?: Function, onUpload?: Function, onDelete?: Function, onMoveToken?: Function, onAssignToken?: Function, onDeleteToken?: Function, onSetTokenImage?: Function}} handlers
     */
    constructor(root, handlers = {}) {
      this.root = root;
      this.handlers = handlers;
      // Сервер отдаёт путь вида /files/<имя> (он же хранится в кампании), а окно
      // открыто по file:// — поэтому для показа путь дополняется адресом стола.
      this.resolveUrl = handlers.resolveUrl || ((url) => url);
      this.role = 'player';
      this.myPlayerId = null;
      this.maps = { world: null, battle: null, sketch: null };
      this.activeMap = null;
      // Карта, которую видят игроки. Может отличаться от activeId выбранной
      // вкладки: мастер листает заготовки, не показывая их столу.
      this.activeMapId = null;
      this.previousActiveMap = null;
      this.viewedMap = null;
      this.playerPeek = null;
      this.tokens = [];
      this.players = [];
      this.grid = { enabled: false, cell: DnD.GRID.defaultCell };
      // Что уже нарисовано в слое фишек: те же объекты и та же подпись
      // означают, что пересобирать DOM не нужно.
      this.renderedTokens = null;
      this.tokenSignature = null;
      this.editing = false;
      this.editor = null;
      /** Приближение карты — личное для каждого клиента, у других не меняется. */
      this.zoom = 1;
      this.pan = { x: 0, y: 0 };
      this.dragState = null;
      this.lastEmit = 0;
      /**
       * Режим тумана: мастер рисует открытые участки мышью по карте.
       * По умолчанию выключен, иначе первое же движение мыши съедало бы
       * карту вместо перетаскивания фишки.
       * @type {boolean}
       */
      this.fogMode = false;
      /** Радиус кисти по ширине карты. */
      this.fogBrush = 0.12;
      /**
       * Режим рисования стен и расстановки света.
       *
       * Отдельный флаг рядом с fogMode, а не вместо него: кисть тумана и
       * протяжка стены делаются по-разному, и мастер не должен каждый раз
       * выбирать между ними в одном переключателе. Выключен по умолчанию по
       * той же причине, что и туман: первое же движение мыши должно двигать
       * фишку, а не рисовать.
       * @type {'wall'|'light'|null}
       */
      this.drawMode = null;
      /** Открыта ли вкладка «Свет» вместо управления картой. */
      this.lightTabOpen = false;
      /** Каким источником света ставить новый: индекс в DnD.LIGHT_PRESETS. */
      this.lightPreset = 0;
      /** Дальность света нового источника в футах. */
      this.lightRadius = DnD.LIGHT_PRESETS[0].radius;
      /** Протягиваемая стена: откуда и куда, пока мастер тянет мышь. */
      this.wallDraft = null;
      /**
       * Кисть поверхности карты: что рисуем (null — выключена, '' — ластик) и
       * ширина в клетках.
       * @type {string|null}
       */
      this.surfaceTool = null;
      this.surfaceBrush = 1;
      /** Клетки текущего мазка: уходят на сервер по отпусканию мыши. */
      this.surfaceStroke = [];
      /**
       * Режим боя: выбранная фишка и её маршрут по клеткам.
       *
       * Хранится здесь, а не в снимке стола: выбор фишки личный, у каждого
       * участника он свой, и это не состояние кампании.
       * @type {{enabled: boolean, tokenId: string|null}}
       */
      this.combat = { enabled: false, tokenId: null };
      /** Маршрут последнего наведения: клетка назначения и расстояние. */
      this.route = null;
      /** Линейка: включена ли и где начало с концом (доли карты). */
      this.measureMode = false;
      this.measureStart = null;
      this.measureEnd = null;
      /** Пинг: включён ли режим и таймеры уже показанных меток. */
      this.pingMode = false;
      this.pingTimers = new Set();
      /** Выбранный шаблон для постановки и его предпросмотр при протяжке. */
      this.templateDraft = null;
      this.templatePreview = null;
      /** Таймер пошагового хода фишки, пока он идёт по клеткам. */
      this.walkTimer = null;
      this.build();
    }

    /**
     * Карта, которую сейчас показывать во вкладке: выбранная в списке вкладки.
     * @param {string|null} type
     * @returns {object|null}
     */
    mapOf(type) {
      const slot = type ? this.maps[type] : null;
      if (!slot || !Array.isArray(slot.items) || !slot.items.length) return null;
      return slot.items.find((item) => item.id === slot.activeId) || slot.items[0];
    }

    /** Сколько карт лежит во вкладке. */
    mapCount(type) {
      const slot = type ? this.maps[type] : null;
      return slot && Array.isArray(slot.items) ? slot.items.length : 0;
    }

    /** Свернуть или показать верхние меню карты. Выбор помнится между запусками. */
    toggleMenus() {
      this.menusCollapsed = !this.menusCollapsed;
      this.applyMenusCollapsed();
      try {
        localStorage.setItem('dnd-table.map-menus', this.menusCollapsed ? '0' : '1');
      } catch (err) {
        /* приватный режим или запрет хранилища: просто не помним выбор */
      }
    }

    /** Привести полосу меню и панель к текущему состоянию свёрнутости. */
    applyMenusCollapsed() {
      this.root.classList.toggle('is-menus-collapsed', this.menusCollapsed);
      if (!this.menusToggle) return;
      this.menusCaret.textContent = this.menusCollapsed ? '▸' : '▾';
      this.menusLabel.textContent = this.menusCollapsed ? 'Меню' : 'Свернуть';
      this.menusToggle.title = this.menusCollapsed
        ? 'Показать вкладки карт и управление'
        : 'Свернуть вкладки и управление, оставив только карту';
    }

    build() {
      this.root.innerHTML = '';
      this.root.classList.add('mapview');

      // Верхние меню (вкладки карт + тулбар) занимают две-три строки, и на
      // маленьком экране карте остаётся мало места. Тонкая полоса с названием
      // карты всегда на виду и сворачивает всё, что над картой.
      try {
        this.menusCollapsed = localStorage.getItem('dnd-table.map-menus') === '0';
      } catch (err) {
        this.menusCollapsed = false;
      }
      const menus = el('div', 'map-menus');
      const menusName = el('span', 'map-menus__name');
      this.menusName = menusName;
      menus.appendChild(menusName);
      const menusToggle = el('button', 'map-menus__toggle');
      menusToggle.type = 'button';
      const menusCaret = el('span', 'map-menus__caret', this.menusCollapsed ? '▸' : '▾');
      const menusLabel = el('span', 'map-menus__label', this.menusCollapsed ? 'Меню' : 'Свернуть');
      menusToggle.appendChild(menusCaret);
      menusToggle.appendChild(menusLabel);
      menusToggle.addEventListener('click', () => this.toggleMenus());
      menus.appendChild(menusToggle);
      this.menusBar = menus;
      this.menusCaret = menusCaret;
      this.menusLabel = menusLabel;
      this.menusToggle = menusToggle;
      this.root.appendChild(menus);
      this.applyMenusCollapsed();

      const tabs = el('div', 'map-tabs');
      this.tabButtons = {};
      for (const type of DnD.MAP_TYPES) {
        const button = el('button', 'map-tab');
        button.type = 'button';
        button.appendChild(el('span', 'map-tab__label', DnD.MAP_LABELS[type]));
        const dot = el('span', 'map-tab__dot');
        button.appendChild(dot);
        button.addEventListener('click', () => this.onTabClick(type));
        this.tabButtons[type] = { button, dot };
        tabs.appendChild(button);
      }
      // Вкладка «Свет» стоит рядом с картами, но картой не является: она
      // показывает не другую подложку, а настройки той, что открыта. Отдельная
      // вкладка нужна потому, что панель освещения занимает пол-экрана и в
      // тулбар, где живёт управление картой, просто не помещалась.
      const lightTab = el('button', 'map-tab map-tab--light');
      lightTab.type = 'button';
      lightTab.dataset.tab = 'light';
      lightTab.hidden = true;
      // Точки-метки у вкладки нет намеренно: та означает «карта показана
      // игрокам», а вкладка света картой не является.
      lightTab.appendChild(el('span', 'map-tab__label', 'Свет'));
      lightTab.addEventListener('click', () => this.toggleLightTab());
      this.lightTabButton = lightTab;
      tabs.appendChild(lightTab);
      this.root.appendChild(tabs);

      const toolbar = el('div', 'map-toolbar');
      this.toolbar = toolbar;
      this.root.appendChild(toolbar);

      // Быстрая настройка сетки прямо за столом. Поля те же, что в окне
      // настроек, но лежат рядом с картой: подгонять сетку смотрят на неё, а
      // не на список настроек. Строим один раз, значения подтягиваем в render.
      const gridMenu = el('div', 'map-grid-menu');
      gridMenu.hidden = true;
      this.gridMenu = gridMenu;
      this.gridMenuFields = {};
      const gridField = (key, label, { min, max, step, title }) => {
        const row = el('label', 'map-grid-menu__row');
        row.appendChild(el('span', 'map-grid-menu__label', label));
        const input = el('input', 'input map-grid-menu__input');
        input.type = 'number';
        input.dataset.field = key;
        if (min !== undefined) input.min = String(min);
        if (max !== undefined) input.max = String(max);
        if (step !== undefined) input.step = String(step);
        if (title) input.title = title;
        input.addEventListener('change', () => this.applyGridMenu());
        row.appendChild(input);
        gridMenu.appendChild(row);
        this.gridMenuFields[key] = input;
      };
      const gridOnLabel = el('label', 'map-grid-menu__check');
      const gridOn = el('input');
      gridOn.type = 'checkbox';
      gridOn.dataset.field = 'enabled';
      gridOn.addEventListener('change', () => this.applyGridMenu());
      gridOnLabel.appendChild(gridOn);
      gridOnLabel.appendChild(el('span', null, 'Сетка видна всем'));
      gridMenu.appendChild(gridOnLabel);
      this.gridMenuFields.enabled = gridOn;
      gridField('columns', 'клеток по ширине (0 — вручную)', {
        min: 0, max: DnD.GRID.maxColumns, step: DnD.GRID.minColumnsStep,
        title: 'Сколько клеток укладывается по ширине карты. Можно с половиной: 37.5. Ноль — клетка берётся из ручного размера.'
      });
      gridField('cell', 'размер клетки, px', {
        min: DnD.GRID.minCell, max: DnD.GRID.maxCell, step: 1,
        title: 'Размер клетки в пикселях картинки, если число клеток по ширине равно нулю. Фишка занимает ровно клетку.'
      });
      gridField('offsetX', 'сдвиг вправо, px', {
        min: -DnD.GRID.maxOffset, max: DnD.GRID.maxOffset, step: 1,
        title: 'Сдвиг сетки вправо: у готовой карты клетки начинаются не с угла файла.'
      });
      gridField('offsetY', 'сдвиг вниз, px', {
        min: -DnD.GRID.maxOffset, max: DnD.GRID.maxOffset, step: 1,
        title: 'Сдвиг сетки вниз: у готовой карты клетки начинаются не с угла файла.'
      });
      gridField('feetPerCell', 'футов в клетке', {
        min: DnD.GRID.minFeetPerCell, max: DnD.GRID.maxFeetPerCell, step: 1,
        title: 'Сколько футов укладывается в клетку. По правилам 5e — пять.'
      });
      gridMenu.appendChild(el('div', 'map-grid-menu__note',
        'Сетку, размер клетки и сдвиг видят все участники стола.'));
      // Клик вне меню закрывает его; внутри — не закрывает.
      this.root.addEventListener('pointerdown', (event) => {
        if (this.gridMenu.hidden) return;
        if (event.target.closest('.map-grid-menu') || event.target.closest('.map-grid-menu__toggle')) return;
        this.gridMenu.hidden = true;
      });
      this.root.appendChild(gridMenu);

      // Шаблоны заклинаний. Мастер выбирает фигуру и размер, затем тянет по
      // карте от центра сферы или вершины конуса: длина протяжки задаёт
      // направление, а размер берётся из поля.
      const templateMenu = el('div', 'map-grid-menu map-template-menu');
      templateMenu.hidden = true;
      this.templateMenu = templateMenu;
      const templateKindRow = el('label', 'map-grid-menu__row');
      templateKindRow.appendChild(el('span', 'map-grid-menu__label', 'Фигура'));
      const templateKind = el('select', 'select map-template-menu__kind');
      for (const [id, label] of [['sphere', 'Сфера'], ['cone', 'Конус'], ['line', 'Линия'], ['square', 'Квадрат']]) {
        const option = el('option', null, label);
        option.value = id;
        templateKind.appendChild(option);
      }
      this.templateKind = templateKind;
      templateKindRow.appendChild(templateKind);
      templateMenu.appendChild(templateKindRow);
      const templateSizeRow = el('label', 'map-grid-menu__row');
      templateSizeRow.appendChild(el('span', 'map-grid-menu__label', 'Размер, футы'));
      const templateSize = el('input', 'input map-grid-menu__input');
      templateSize.type = 'number';
      templateSize.min = '5';
      templateSize.max = '120';
      templateSize.step = '5';
      templateSize.value = '20';
      this.templateSize = templateSize;
      templateSizeRow.appendChild(templateSize);
      templateMenu.appendChild(templateSizeRow);
      const templateColorRow = el('label', 'map-grid-menu__row');
      templateColorRow.appendChild(el('span', 'map-grid-menu__label', 'Цвет'));
      const templateColor = el('input', 'input map-grid-menu__color');
      templateColor.type = 'color';
      templateColor.value = '#6aa9ff';
      this.templateColor = templateColor;
      templateColorRow.appendChild(templateColor);
      templateMenu.appendChild(templateColorRow);
      templateMenu.appendChild(el('div', 'map-grid-menu__note',
        'Протяните по карте от центра сферы или квадрата, либо от вершины конуса или линии: направление протяжки задаёт поворот.'));
      const templatePlace = el('button', 'btn btn--accent btn--tiny', 'Поставить');
      templatePlace.type = 'button';
      templatePlace.addEventListener('click', () => this.startTemplatePlacement());
      templateMenu.appendChild(templatePlace);
      const templateClear = el('button', 'btn btn--tiny', 'Убрать все');
      templateClear.type = 'button';
      templateClear.addEventListener('click', () => {
        if (this.handlers.onClearMapTemplates) {
          this.handlers.onClearMapTemplates(this.viewedMap, this.currentMapId);
        }
        this.templateMenu.hidden = true;
      });
      templateMenu.appendChild(templateClear);
      this.root.appendChild(templateMenu);
      this.root.addEventListener('pointerdown', (event) => {
        if (this.templateMenu.hidden) return;
        if (event.target.closest('.map-template-menu') || event.target.closest('.map-template__toggle')) return;
        this.templateMenu.hidden = true;
      });

      // Панель освещения: своя вкладка вместо тесного тулбара.
      const lightPanel = el('div', 'map-lightbar');
      lightPanel.hidden = true;
      this.lightPanel = lightPanel;
      this.root.appendChild(lightPanel);

      const stage = el('div', 'map-stage');
      this.stage = stage;
      const surface = el('div', 'map-surface');
      surface.hidden = true;
      this.surface = surface;

      const image = el('img', 'map-image');
      image.alt = '';
      image.draggable = false;
      this.image = image;
      surface.appendChild(image);

      // Сетка лежит поверх карты и под фишками: клетка ровно по размеру фишки.
      const gridLayer = el('div', 'map-grid');
      gridLayer.hidden = true;
      this.gridLayer = gridLayer;
      surface.appendChild(gridLayer);

      // Поверхность по клеткам лежит под фишками и над сеткой: это пол, по
      // которому стоят, поэтому фишка должна быть поверх лужи, а не под ней.
      this.surfaceCanvas = document.createElement('canvas');
      this.surfaceCanvas.className = 'map-surface-layer';
      this.surfaceCanvas.hidden = true;
      surface.appendChild(this.surfaceCanvas);
      this.surfaceContext = this.surfaceCanvas.getContext('2d');

      const layer = el('div', 'token-layer');
      this.tokenLayer = layer;
      surface.appendChild(layer);

      // Клетка назначения и подпись расстояния лежат поверх фишек. Линию
      // маршрута убрали: она уезжала от фишки, а клетка и число шагов дают
      // то же без неё.
      this.cellMark = el('div', 'map-cell');
      surface.appendChild(this.cellMark);
      this.routeLabel = el('div', 'map-route__label');
      surface.appendChild(this.routeLabel);

      // Линейка. В отличие от убранного маршрута это не постоянная линия, а
      // инструмент: включил, протянул, прочитал футы. Лежит над фишками, но
      // под светом и туманом.
      this.measureLayer = el('div', 'map-measure');
      this.measureLayer.hidden = true;
      this.measureSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.measureSvg.setAttribute('class', 'map-measure__svg');
      this.measureSvg.setAttribute('preserveAspectRatio', 'none');
      this.measureLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      this.measureLine.setAttribute('class', 'map-measure__line');
      this.measureStartDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      this.measureStartDot.setAttribute('class', 'map-measure__dot');
      this.measureEndDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      this.measureEndDot.setAttribute('class', 'map-measure__dot');
      this.measureSvg.appendChild(this.measureLine);
      this.measureSvg.appendChild(this.measureStartDot);
      this.measureSvg.appendChild(this.measureEndDot);
      this.measureLabel = el('div', 'map-measure__label');
      this.measureLayer.appendChild(this.measureSvg);
      this.measureLayer.appendChild(this.measureLabel);
      surface.appendChild(this.measureLayer);

      // Шаблоны заклинаний: сферы, конусы и линии. Общие для стола, поэтому
      // едут в кампании вместе с картой, а не живут в этом окне.
      this.templateLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.templateLayer.setAttribute('class', 'map-templates');
      this.templateLayer.setAttribute('preserveAspectRatio', 'none');
      this.templateLayer.hidden = true;
      surface.appendChild(this.templateLayer);

      // Свет лежит поверх карты, сетки и фишек, но под туманом. Порядок важен
      // в обе стороны: фишка в темноте должна быть видна, но туман должен
      // перекрывать и освещённую фишку, иначе игрок увидел бы монстра там, где
      // мастер его ещё не открыл.
      this.lightCanvas = document.createElement('canvas');
      this.lightCanvas.className = 'map-light';
      this.lightCanvas.hidden = true;
      surface.appendChild(this.lightCanvas);
      this.lightContext = this.lightCanvas.getContext('2d');
      // Пятна света лежат поверх завесы и смешиваются с ней экранированием:
      // так тёплый факел греет карту, а холодная луна окрашивает её синим.
      this.glowCanvas = document.createElement('canvas');
      this.glowCanvas.className = 'map-glow';
      this.glowCanvas.hidden = true;
      surface.appendChild(this.glowCanvas);
      this.glowContext = this.glowCanvas.getContext('2d');
      // Прямоугольники стен и точки источников рисуются на том же холсте,
      // но мастеру и только мастеру: игроку незачем знать, где стена.
      // Именно стены: сам источник на карте не виден никому, свет виден
      // и без точки, а точка только мешала бы читать карту.
      this.wallOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.wallOverlay.setAttribute('class', 'map-walls');
      this.wallOverlay.setAttribute('viewBox', '0 0 1000 1000');
      this.wallOverlay.setAttribute('preserveAspectRatio', 'none');
      this.wallOverlay.hidden = true;
      surface.appendChild(this.wallOverlay);

      // Туман войны лежит поверх всего: фишка в закрытом участке не должна
      // просвечивать, поэтому слой идёт после токенов, а под ним.
      this.fogCanvas = document.createElement('canvas');
      this.fogCanvas.className = 'map-fog';
      this.fogCanvas.hidden = true;
      surface.appendChild(this.fogCanvas);
      this.fogContext = this.fogCanvas.getContext('2d');

      // Пинги лежат выше тумана: это не часть карты, а короткий жест «сюда».
      // Слой внутри surface, поэтому метка едет вместе с приближением.
      const pingLayer = el('div', 'map-pings');
      pingLayer.setAttribute('aria-hidden', 'true');
      surface.appendChild(pingLayer);
      this.pingLayer = pingLayer;

      const empty = el('div', 'map-empty');
      // Водяной знак: гранёный куб. Он же и герб игры, и подсказка, что
      // стол пуст и ждёт карту. Цвет берётся из currentColor, поэтому знак
      // живёт в теме наравне со всем остальным.
      const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      mark.setAttribute('class', 'map-empty__mark');
      mark.setAttribute('viewBox', '0 0 100 100');
      mark.setAttribute('aria-hidden', 'true');
      const hexagon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      hexagon.setAttribute('points', '50,3 92,26 92,74 50,97 8,74 8,26');
      const triangle = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      triangle.setAttribute('points', '50,27 73,64 27,64');
      mark.appendChild(hexagon);
      mark.appendChild(triangle);
      empty.appendChild(mark);
      empty.appendChild(el('div', 'map-empty__text', 'Карта ещё не загружена ДМ'));
      this.empty = empty;

      stage.appendChild(surface);
      stage.appendChild(empty);

      // Тематический орнамент висит на верхней кромке карты. Внутри три слоя:
      // ветер качает подвес, курсор задаёт наклон, а листья и пылинки живут
      // своей жизнью. Позиция курсора уходит в CSS, поэтому браузер не
      // пересчитывает геометрию на каждое движение мыши.
      const decor = el('div', 'map-decor');
      decor.setAttribute('aria-hidden', 'true');
      const wind = el('span', 'map-decor__wind');
      const strand = el('span', 'map-decor__strand');
      for (let i = 1; i <= 3; i += 1) {
        strand.appendChild(el('span', `map-decor__leaf map-decor__leaf--${i}`));
      }
      strand.appendChild(el('span', 'map-decor__mark'));
      wind.appendChild(strand);
      decor.appendChild(wind);
      const aside = el('span', 'map-decor__aside');
      aside.appendChild(el('span', 'map-decor__aside-line'));
      aside.appendChild(el('span', 'map-decor__aside-mark'));
      decor.appendChild(aside);
      const motes = el('span', 'map-decor__motes');
      for (let i = 1; i <= 6; i += 1) {
        motes.appendChild(el('span', `map-decor__mote map-decor__mote--${i}`));
      }
      decor.appendChild(motes);
      this.decor = decor;
      stage.appendChild(decor);

      // Кромка карты не меняется на каждом движении мыши, поэтому меряем её
      // один раз и обновляем после изменения размера. Иначе pointermove
      // заставлял бы браузер считать геометрию на каждое событие.
      let decorRect = null;
      const refreshDecorRect = () => {
        decorRect = stage.getBoundingClientRect();
      };
      if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(refreshDecorRect);
        observer.observe(stage);
        this.decorRectObserver = observer;
      } else {
        window.addEventListener('resize', refreshDecorRect, { passive: true });
      }
      stage.addEventListener('pointerenter', refreshDecorRect, { passive: true });
      stage.addEventListener('pointermove', (event) => {
        if (!decorRect || !decorRect.width || !decorRect.height) refreshDecorRect();
        if (!decorRect || !decorRect.width || !decorRect.height) return;
        const x = Math.max(0, Math.min(1, (event.clientX - decorRect.left) / decorRect.width));
        decor.style.setProperty('--pointer-x', x.toFixed(3));
      }, { passive: true });
      stage.addEventListener('pointerleave', () => {
        decorRect = null;
        decor.style.setProperty('--pointer-x', '0.5');
      }, { passive: true });

      // Холст для рисования карты: появляется вместо карты, когда ДМ рисует.
      const editorHost = el('div', 'sketch-editor');
      editorHost.hidden = true;
      this.editorHost = editorHost;
      stage.appendChild(editorHost);

      // Приближение карты. Живёт прямо на столе, потому что нужно и игроку:
      // приближение у каждого своё и на других не влияет.
      const zoomBar = el('div', 'map-zoom');
      this.zoomBar = zoomBar;
      const zoomOut = el('button', 'map-zoom__btn', '−');
      zoomOut.type = 'button';
      zoomOut.title = 'Отдалить карту';
      zoomOut.addEventListener('click', (event) => {
        event.stopPropagation();
        this.zoomAroundCenter(1 / ZOOM_STEP);
      });
      const zoomValue = el('span', 'map-zoom__value', '100%');
      this.zoomValue = zoomValue;
      const zoomIn = el('button', 'map-zoom__btn', '+');
      zoomIn.type = 'button';
      zoomIn.title = 'Приблизить карту';
      zoomIn.addEventListener('click', (event) => {
        event.stopPropagation();
        this.zoomAroundCenter(ZOOM_STEP);
      });
      const zoomReset = el('button', 'map-zoom__btn map-zoom__btn--reset', '⤢');
      zoomReset.type = 'button';
      zoomReset.title = 'Сбросить приближение';
      zoomReset.addEventListener('click', (event) => {
        event.stopPropagation();
        this.resetView();
      });
      // Линейка доступна и игроку: расстояние до цели нужно всем за столом.
      const measureButton = el('button', 'map-zoom__btn map-zoom__btn--measure');
      measureButton.type = 'button';
      measureButton.title = 'Измерять расстояние по сетке';
      const measureIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      measureIcon.setAttribute('viewBox', '0 0 16 16');
      measureIcon.setAttribute('class', 'map-zoom__icon');
      measureIcon.setAttribute('aria-hidden', 'true');
      const measurePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      measurePath.setAttribute('d', 'M2 8h12M2 5v6M14 5v6M8 6v4');
      measureIcon.appendChild(measurePath);
      measureButton.appendChild(measureIcon);
      measureButton.addEventListener('click', (event) => {
        event.stopPropagation();
        this.toggleMeasure();
      });
      this.measureButton = measureButton;
      zoomBar.appendChild(zoomOut);
      zoomBar.appendChild(zoomValue);
      zoomBar.appendChild(zoomIn);
      zoomBar.appendChild(zoomReset);
      zoomBar.appendChild(measureButton);

      // Пинг нужен и игроку: «смотрите сюда» за столом звучит чаще, чем
      // «померим расстояние». Кнопка включает режим, Alt+клик работает без него.
      const pingButton = el('button', 'map-zoom__btn map-zoom__btn--ping');
      pingButton.type = 'button';
      pingButton.title = 'Пинг по карте (Alt+клик)';
      const pingIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      pingIcon.setAttribute('viewBox', '0 0 16 16');
      pingIcon.setAttribute('class', 'map-zoom__icon');
      pingIcon.setAttribute('aria-hidden', 'true');
      for (const radius of [2.4, 5.4]) {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', '8');
        circle.setAttribute('cy', '8');
        circle.setAttribute('r', String(radius));
        pingIcon.appendChild(circle);
      }
      pingButton.appendChild(pingIcon);
      pingButton.addEventListener('click', (event) => {
        event.stopPropagation();
        this.togglePing();
      });
      this.pingButton = pingButton;
      zoomBar.appendChild(pingButton);
      stage.appendChild(zoomBar);

      stage.addEventListener('pointerdown', (event) => this.startPan(event));
      stage.addEventListener('wheel', (event) => {
        if (this.editing) return;
        event.preventDefault();
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        this.zoomAt(factor, event.clientX, event.clientY);
      }, { passive: false });

      this.root.appendChild(stage);

      this.badge = el('div', 'map-badge');
      this.badge.hidden = true;
      this.root.appendChild(this.badge);

      this.image.addEventListener('load', () => {
        this.layoutSurface();
        // После загрузки картинки меняется размер подложки, а с ним и холсты
        // тумана и света: без перерисовки туман лёг бы на прошлую карту, а
        // свет посчитался бы по чужим пропорциям.
        const map = this.mapOf(this.viewedMap);
        this.paintFog(map);
        this.paintLight(map);
        this.paintWallOverlay(map);
        this.paintSurface(map);
        this.paintTemplates(map);
      });

      // Линейка перехватывает нажатие раньше кистей: пока она включена, движение
      // мыши мерит расстояние, а не открывает туман и не двигает фишки.
      this.surface.addEventListener('pointerdown', (event) => {
        if (!this.measureMode || this.editing || event.button !== 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const start = this.mapPoint(event);
        this.measureStart = start;
        this.measureEnd = start;
        this.paintMeasure();
        const move = (moveEvent) => {
          this.measureEnd = this.mapPoint(moveEvent);
          this.paintMeasure();
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });

      // Постановка шаблона: протяжка от вершины задаёт и размер круга, и
      // направление конуса с линией. Как и линейка, забирает нажатие первым.
      this.surface.addEventListener('pointerdown', (event) => {
        if (!this.templateDraft || this.role !== 'dm' || this.editing || event.button !== 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const start = this.mapPoint(event);
        let current = start;
        this.templatePreview = this.makeTemplate(start, current);
        this.paintTemplates(this.mapOf(this.viewedMap));
        const move = (moveEvent) => {
          current = this.mapPoint(moveEvent);
          this.templatePreview = this.makeTemplate(start, current);
          this.paintTemplates(this.mapOf(this.viewedMap));
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          const template = this.makeTemplate(start, current);
          this.templateDraft = null;
          this.templatePreview = null;
          this.surface.classList.remove('is-templating');
          // Рисуем сразу, не дожидаясь ответа сервера: сеть может задержаться,
          // а фигура уже брошена, и мастер должен видеть её на месте.
          const map = this.mapOf(this.viewedMap);
          if (map) {
            map.templates = [...(Array.isArray(map.templates) ? map.templates : []), template];
          }
          this.paintTemplates(map);
          if (this.handlers.onAddMapTemplate) {
            this.handlers.onAddMapTemplate(this.viewedMap, this.currentMapId, template);
          }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });

      // Пинг забирает нажатие раньше панорамирования и фишек: иначе Alt+клик
      // по фишке начинал бы её тащить, а не показывал точку. В режиме кистей
      // Alt не перехватывается, чтобы не мешать туману, свету и стенам.
      stage.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || this.editing) return;
        if (!(event.target instanceof Element)) return;
        if (event.target.closest('.map-zoom, .map-badge, .map-decor')) return;
        const masterTool = this.fogMode || this.surfaceTool !== null || this.drawMode
          || this.measureMode || this.templateDraft;
        const wantPing = this.pingMode || (event.altKey && !masterTool);
        if (!wantPing) return;
        if (!this.canPing()) {
          if (this.pingMode && this.handlers.onNotice) {
            this.handlers.onNotice('Пинг доступен на карте, которую видят игроки');
          }
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.pingAt(event);
      }, true);

      // Esc гасит линейку: после замера хочется сразу двигать фишки.
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (this.pingMode) this.setPingMode(false);
        if (this.measureMode) this.toggleMeasure();
      });

      // Кисть тумана живёт на самой подложке: в режиме тумана указатель
      // открывает карту, а не двигает фишку. Режим стен и света устроен так же.
      this.surface.addEventListener('pointerdown', (event) => {
        if (this.role !== 'dm' || this.editing) return;
        if (this.fogMode) {
          event.preventDefault();
          event.stopPropagation();
          this.openFogAt(event);
          return;
        }
        if (this.surfaceTool !== null) {
          event.preventDefault();
          event.stopPropagation();
          this.paintSurfaceAt(event);
          return;
        }
        if (event.button !== 0) return;
        if (this.drawMode === 'wall') {
          event.preventDefault();
          event.stopPropagation();
          this.startWall(event);
          return;
        }
        if (this.drawMode === 'light') {
          event.preventDefault();
          event.stopPropagation();
          this.placeLight(event);
        }
      });
      this.surface.addEventListener('pointermove', (event) => {
        if (this.role !== 'dm' || this.editing) return;
        if (this.fogMode) {
          if (event.buttons !== 1) return;
          this.openFogAt(event);
          return;
        }
        if (this.surfaceTool !== null) {
          if (event.buttons !== 1) return;
          this.paintSurfaceAt(event);
          return;
        }
        if (this.drawMode === 'wall' && this.wallDraft && event.buttons === 1) {
          this.moveWall(event);
        }
      });
      // Стена до отпускания мыши не уходит на сервер: мастер рисует движением
      // и рассылка на каждый пиксель утащила бы весь стол. Правый клик по уже
      // нарисованной стене убирает её — иначе стену пришлось бы искать заново.
      this.surface.addEventListener('pointerup', (event) => {
        if (this.surfaceTool !== null) {
          event.stopPropagation();
          this.flushSurfaceStroke();
          return;
        }
        if (this.drawMode !== 'wall' || !this.wallDraft) return;
        event.stopPropagation();
        this.finishWall(event);
      });
      this.surface.addEventListener('contextmenu', (event) => {
        if (this.role !== 'dm' || this.editing) return;
        const wall = this.wallNear(event);
        if (wall) {
          event.preventDefault();
          event.stopPropagation();
          if (this.handlers.onDeleteMapWall) {
            this.handlers.onDeleteMapWall(this.viewedMap, this.currentMapId, wall.id);
          }
          return;
        }
        // Шаблон убирается тем же правым кликом: держать для него отдельную
        // кнопку незачем, а лишняя фигура мешает читать карту.
        const template = this.templateNear(event);
        if (template) {
          event.preventDefault();
          event.stopPropagation();
          if (this.handlers.onDeleteMapTemplate) {
            this.handlers.onDeleteMapTemplate(this.viewedMap, this.currentMapId, template.id);
          }
        }
      });
      // Режим боя: нажатие по клетке отправляет выбранную фишку туда. Слушатель
      // свой и на всех ролях, потому что ходят и игроки, а мастерские кисти выше
      // сюда не доходят: туман, стены и свет включаются отдельными режимами.
      this.surface.addEventListener('pointerdown', (event) => {
        // Кисти мастера важнее: туман, стены и свет рисуются теми же нажатиями.
        if (!this.combat.enabled || this.editing || event.button !== 0) return;
        if (this.fogMode || this.drawMode) return;
        const token = this.combatToken();
        if (!token) {
          // Молчание здесь читается как «кнопка не работает»: режим включён,
          // а фишка не едет. Поэтому объясняем, что нужно сделать.
          if (this.handlers.onNotice) {
            this.handlers.onNotice('Сначала нажмите на фишку, которая пойдёт, потом на клетку');
          }
          return;
        }
        const target = this.cellAtClient(event.clientX, event.clientY);
        if (!target) {
          if (!this.cellGeometry() && this.handlers.onNotice) {
            this.handlers.onNotice('Клеток нет: загрузите карту, сетка считается от её размера');
          }
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.walkTokenTo(token, target);
      });
      // Маршрут рисуется под курсором: видно расстояние до того, как нажато.
      this.surface.addEventListener('pointermove', (event) => {
        if (!this.combat.enabled || this.editing || !this.combatToken()) return;
        if (this.fogMode || this.drawMode) return;
        this.paintRoute(this.cellAtClient(event.clientX, event.clientY));
      });
      // Увелили карту под маршрутом — перерисовываем его на новом месте.
      this.surface.addEventListener('pointerleave', () => {
        if (this.combat.enabled) this.paintRoute();
      });
      if (typeof ResizeObserver === 'function') {
        this.resizeObserver = new ResizeObserver(() => {
          this.layoutSurface();
          if (this.editing && this.editor) this.editor.layout();
          // Свет считается в размерах подложки, а она меняется вместе с окном.
          const map = this.mapOf(this.viewedMap);
          this.paintLight(map);
          this.paintFog(map);
          this.paintSurface(map);
        });
        this.resizeObserver.observe(stage);
      }
      window.addEventListener('resize', () => {
        this.layoutSurface();
        if (this.editing && this.editor) this.editor.layout();
        const map = this.mapOf(this.viewedMap);
        this.paintLight(map);
        this.paintFog(map);
        this.paintSurface(map);
      });
    }

    onTabClick(type) {
      // Смена вкладки закрывает холст: рисование всегда привязано к карте,
      // поверх которой оно начато.
      if (this.editing) this.closeEditor();
      if (this.lightTabOpen) {
        this.lightTabOpen = false;
        this.render();
      }
      if (this.role === 'dm' || this.training) {
        // ДМ (и игрок в тренировочном столе) может выбрать и ещё не загруженную
        // карту: именно её он и загрузит кнопкой в панели. Раньше пустая вкладка
        // была заблокирована, и вторую карту загрузить было нечем.
        this.viewedMap = type;
        this.render();
        return;
      }
      // Игрок по умолчанию смотрит активную карту, но может заглянуть и в другую.
      this.playerPeek = type === this.activeMap ? null : type;
      this.render();
    }

    /**
     * Вкладка «Свет»: та же карта под ней, но вместо управления картой мастер
     * видит настройки освещения.
     *
     * Карта остаётся на виду намеренно: темноту и огонь нельзя настраивать
     * вслепую, мастер должен видеть, что происходит с картой под рукой.
     */
    toggleLightTab() {
      if (this.editing) this.closeEditor();
      this.lightTabOpen = !this.lightTabOpen;
      // Режим рисования живёт на вкладке света: переключение вкладки не должно
      // оставлять курсор «рисуем» над панелью, где рисовать нечего.
      if (this.lightTabOpen && this.drawMode) {
        this.drawMode = null;
        this.wallDraft = null;
        this.surface.classList.remove('is-drawing-light', 'is-drawing-wall');
        this.paintWallDraft();
      }
      this.render();
    }

    /**
     * Подгоняет «поверхность» карты под размер окна так, чтобы она точно
     * совпадала с нарисованным изображением. Тогда координаты фишек
     * (доли от 0 до 1) попадают точно в нужные точки на карте.
     */
    layoutSurface() {
      if (!this.surface || this.surface.hidden) return;
      const width = this.image.naturalWidth;
      const height = this.image.naturalHeight;
      if (!width || !height) return;
      const stageWidth = this.stage.clientWidth;
      const stageHeight = this.stage.clientHeight;
      if (!stageWidth || !stageHeight) return;

      const ratio = width / height;
      let boxWidth = stageWidth;
      let boxHeight = stageWidth / ratio;
      if (boxHeight > stageHeight) {
        boxHeight = stageHeight;
        boxWidth = stageHeight * ratio;
      }
      this.surface.style.width = `${Math.floor(boxWidth)}px`;
      this.surface.style.height = `${Math.floor(boxHeight)}px`;
      this.applyZoom();
      // Размер подложки только что изменился: клетка и сдвиг сетки считаются
      // от него, иначе сетка осталась бы в масштабе прежнего окна.
      this.applyGrid();
    }

    /**
     * Приближение применяется как transform ко всей поверхности: карта, сетка и
     * фишки увеличиваются вместе, как если бы наклонились к столу. Размеры
     * клетки и фишек при этом остаются теми же относительно карты.
     */
    applyZoom() {
      this.surface.style.transform = `translate(-50%, -50%) translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
      if (this.zoomValue) this.zoomValue.textContent = `${Math.round(this.zoom * 100)}%`;
      if (this.zoomBar) this.zoomBar.classList.toggle('is-zoomed', this.zoom !== 1);
      this.surface.classList.toggle('is-panned', this.pan.x !== 0 || this.pan.y !== 0);
      // Маршрут задан в долях карты, но линия и подпись двигаются вместе с
      // подложкой: без перерисовки они остались бы на старом месте.
      this.paintRoute();
    }

    setZoom(zoom) {
      this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
      this.applyZoom();
    }

    /** Приближение кнопками — вокруг центра стола. */
    zoomAroundCenter(step) {
      const rect = this.stage.getBoundingClientRect();
      this.zoomAt(step, rect.left + rect.width / 2, rect.top + rect.height / 2);
    }

    /**
     * Приближение «под курсором»: точка, на которую смотрят, остаётся на месте.
     * @param {number} factor
     * @param {number} clientX
     * @param {number} clientY
     */
    zoomAt(factor, clientX, clientY) {
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom * factor));
      const applied = next / this.zoom;
      if (applied === 1) return;
      const rect = this.stage.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      this.pan.x = this.pan.x * applied + (clientX - centerX) * (1 - applied);
      this.pan.y = this.pan.y * applied + (clientY - centerY) * (1 - applied);
      this.zoom = next;
      this.applyZoom();
    }

    resetView() {
      this.zoom = 1;
      this.pan = { x: 0, y: 0 };
      this.applyZoom();
    }

    /** Таскание карты мышью: приблизил — можно посмотреть другой угол. */
    startPan(event) {
      if (this.editing) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (event.target.closest('.token') || event.target.closest('.map-zoom')) return;

      const startX = event.clientX;
      const startY = event.clientY;
      const pan = { x: this.pan.x, y: this.pan.y };
      this.stage.classList.add('is-panning');
      try {
        this.stage.setPointerCapture(event.pointerId);
      } catch { /* указатель мог уйти — не критично */ }

      const move = (moveEvent) => {
        this.pan.x = pan.x + (moveEvent.clientX - startX);
        this.pan.y = pan.y + (moveEvent.clientY - startY);
        this.applyZoom();
      };
      const up = () => {
        this.stage.classList.remove('is-panning');
        this.stage.removeEventListener('pointermove', move);
        this.stage.removeEventListener('pointerup', up);
        this.stage.removeEventListener('pointercancel', up);
      };
      this.stage.addEventListener('pointermove', move);
      this.stage.addEventListener('pointerup', up);
      this.stage.addEventListener('pointercancel', up);
      event.preventDefault();
    }

    /**
     * Панель тумана: режим кисти, её размер и две кнопки на всю карту.
     * @param {string} type Вкладка карты.
     * @param {object} map Текущая карта.
     * @returns {HTMLElement}
     */
    buildFogControls(type, map) {
      const box = el('div', 'fog-bar');
      const mode = el('button', 'btn btn--tiny', this.fogMode ? 'Туман: рисуем' : 'Туман: выключен');
      mode.type = 'button';
      mode.classList.toggle('btn--accent', this.fogMode);
      mode.title = this.fogMode
        ? 'Рисуем открытые участки. Выключите, чтобы двигать фишки'
        : 'Включить режим тумана и открывать участки карты';
      mode.addEventListener('click', (event) => {
        event.stopPropagation();
        this.setFogMode(!this.fogMode);
        this.renderToolbar();
      });
      box.appendChild(mode);

      const size = el('input', 'fog-bar__brush');
      size.type = 'range';
      size.min = '4';
      size.max = '40';
      size.step = '1';
      size.value = String(Math.round(this.fogBrush * 100));
      size.title = 'Размер кисти';
      size.addEventListener('input', () => {
        this.fogBrush = Number(size.value) / 100;
      });
      size.addEventListener('click', (event) => event.stopPropagation());
      box.appendChild(size);

      const openAll = el('button', 'btn btn--tiny btn--ghost', 'Открыть всё');
      openAll.type = 'button';
      openAll.title = 'Убрать туман с карты целиком';
      openAll.addEventListener('click', (event) => {
        event.stopPropagation();
        if (this.handlers.onSetMapFog) this.handlers.onSetMapFog(type, map.id, true);
      });
      box.appendChild(openAll);

      const coverAll = el('button', 'btn btn--tiny btn--ghost', 'Закрыть всё');
      coverAll.type = 'button';
      coverAll.title = 'Снова закрыть карту целиком';
      coverAll.addEventListener('click', (event) => {
        event.stopPropagation();
        if (this.handlers.onSetMapFog) this.handlers.onSetMapFog(type, map.id, false);
      });
      box.appendChild(coverAll);
      return box;
    }

    /**
     * Панель света: темнота карты, два инструмента и список источников.
     *
     * Живёт на отдельной вкладке и в строку не умещается, поэтому каждый
     * ползунок и каждый выбор получают подпись: без неё «20 фт» и «40 фт»
     * рядом друг с другом неотличимы. Порядок повторяет работу мастера: сначала
     * «наступила ночь», потом инструменты, и только потом список того, что уже
     * горит. Список нужен ещё и для того, чтобы погасить костёр, не находя его
     * взглядом на карте: источник на ней не виден.
     * @param {string} type Вкладка карты.
     * @param {object} map Текущая карта.
     * @returns {HTMLElement}
     */
    buildLightControls(type, map) {
      const box = el('div', 'light-panel');
      const tools = el('div', 'light-panel__tools');

      /** Ползунок с подписью: подпись и объяснение, что он значит. */
      const slider = (label, hint, input) => {
        const row = el('label', 'light-panel__field');
        row.appendChild(el('span', 'light-panel__label', label));
        row.appendChild(input);
        row.title = hint;
        return row;
      };

      const darkness = Math.round((Number(map.darkness) || 0) * 100);
      const darknessInput = el('input', 'light-panel__slider');
      darknessInput.type = 'range';
      darknessInput.min = '0';
      darknessInput.max = '100';
      darknessInput.step = '5';
      darknessInput.value = String(darkness);
      darknessInput.title = 'Насколько темно на карте. 0 — дневной свет, 100 — кромешная тьма';
      darknessInput.setAttribute('aria-label', 'Темнота карты');
      darknessInput.addEventListener('input', () => {
        const value = Number(darknessInput.value) / 100;
        // Применяем сразу, без ответа сервера: мастер тянет ползунок и должен
        // видеть темноту так же, как игрок её увидит.
        map.darkness = value;
        darknessValue.textContent = `${darknessInput.value}%`;
        this.paintLight(map);
      });
      darknessInput.addEventListener('change', () => {
        if (this.handlers.onSetMapDarkness) {
          this.handlers.onSetMapDarkness(type, map.id, Number(darknessInput.value) / 100);
        }
      });
      const darknessValue = el('span', 'light-panel__value', `${darkness}%`);
      const darknessField = slider('Темнота карты', 'Ноль это дневной свет', darknessInput);
      darknessField.appendChild(darknessValue);
      tools.appendChild(darknessField);

      const radius = el('input', 'light-panel__slider');
      radius.type = 'range';
      radius.min = '5';
      radius.max = '120';
      radius.step = '5';
      radius.value = String(this.lightRadius);
      radius.setAttribute('aria-label', 'Дальность света в футах');
      radius.addEventListener('input', () => {
        this.lightRadius = Number(radius.value);
        radiusValue.textContent = `${radius.value} фт`;
      });
      const radiusValue = el('span', 'light-panel__value', `${this.lightRadius} фт`);
      const radiusField = slider('Дальность источника', 'По правилам 5e факел светит на 20 футов', radius);
      radiusField.appendChild(radiusValue);
      tools.appendChild(radiusField);

      const preset = el('select', 'select light-panel__select');
      for (const item of DnD.LIGHT_PRESETS) {
        const option = el('option', null, `${item.label} — ${item.radius} фт`);
        option.value = item.id;
        option.selected = item.id === (DnD.LIGHT_PRESETS[this.lightPreset] || {}).id;
        preset.appendChild(option);
      }
      preset.title = 'Какой свет поставить';
      preset.addEventListener('change', () => {
        const index = DnD.LIGHT_PRESETS.findIndex((item) => item.id === preset.value);
        if (index >= 0) {
          this.lightPreset = index;
          this.lightRadius = DnD.LIGHT_PRESETS[index].radius;
          radius.value = String(this.lightRadius);
          radiusValue.textContent = `${this.lightRadius} фт`;
        }
      });
      const presetField = el('label', 'light-panel__field');
      presetField.appendChild(el('span', 'light-panel__label', 'Источник'));
      presetField.appendChild(preset);
      tools.appendChild(presetField);
      box.appendChild(tools);

      // Инструменты отдельной строкой: они включают режим на карте, и держать
      // их рядом с ползунками значило бы тянуться через всю панель.
      const modes = el('div', 'light-panel__modes');
      const lightTool = el('button', 'btn', this.drawMode === 'light' ? 'Свет: ставим' : 'Поставить свет');
      lightTool.type = 'button';
      lightTool.dataset.tool = 'light';
      lightTool.classList.toggle('btn--accent', this.drawMode === 'light');
      lightTool.title = 'Клик по карте ставит источник света. Сам источник на карте не виден';
      lightTool.addEventListener('click', () => this.setDrawMode('light'));
      modes.appendChild(lightTool);

      const wallTool = el('button', 'btn', this.drawMode === 'wall' ? 'Стены: рисуем' : 'Рисовать стены');
      wallTool.type = 'button';
      wallTool.dataset.tool = 'wall';
      wallTool.classList.toggle('btn--accent', this.drawMode === 'wall');
      wallTool.title = 'Протяните мышью стену: она держит свет. Правый клик по стене убирает её';
      wallTool.addEventListener('click', () => this.setDrawMode('wall'));
      modes.appendChild(wallTool);

      const clearWalls = el('button', 'btn btn--ghost', 'Убрать все стены');
      clearWalls.type = 'button';
      clearWalls.title = 'Снести все стены карты';
      clearWalls.disabled = !normalizeWalls(map.walls).length;
      clearWalls.addEventListener('click', () => {
        if (this.handlers.onClearMapWalls) this.handlers.onClearMapWalls(type, map.id);
      });
      modes.appendChild(clearWalls);
      box.appendChild(modes);

      const lights = normalizeLights(map.lights);
      box.appendChild(el('div', 'light-panel__title', lights.length
        ? `Источников на карте: ${lights.length}`
        : 'Источников на карте пока нет'));
      const list = el('div', 'light-panel__list');
      for (const light of lights) {
        const row = el('div', `light-row${light.hidden ? ' is-hidden' : ''}`);
        const dot = el('span', 'light-row__dot');
        dot.style.background = light.color;
        row.appendChild(dot);
        row.appendChild(el('span', 'light-row__radius', light.dim ? `${light.radius} фт · тусклый` : `${light.radius} фт`));
        row.appendChild(el('span', 'light-row__place',
          `${Math.round(light.x * 100)}%, ${Math.round(light.y * 100)}%`));
        if (light.hidden) row.appendChild(el('span', 'light-row__state', 'погашен'));

        // Тусклый и яркий по правилам светят на разные расстояния, поэтому это
        // переключатель, а не выбор в списке: список источников отвечает на
        // «чем горит», а этот — на «сильно ли».
        const dim = el('button', 'btn btn--tiny btn--ghost', light.dim ? 'Тусклый' : 'Яркий');
        dim.type = 'button';
        dim.title = light.dim
          ? 'Сделать свет ярким: он будет светить на всю указанную дальность'
          : 'Сделать свет тусклым: вдвое меньше и приглушённее, видны силуэты';
        dim.addEventListener('click', () => {
          if (this.handlers.onSetMapLight) {
            this.handlers.onSetMapLight(type, map.id, light.id, { dim: !light.dim });
          }
        });
        row.appendChild(dim);

        const toggle = el('button', 'btn btn--tiny btn--ghost', light.hidden ? 'Зажечь' : 'Погасить');
        toggle.type = 'button';
        toggle.title = 'Погасить свет, не убирая источник совсем';
        toggle.addEventListener('click', () => {
          if (this.handlers.onSetMapLight) {
            this.handlers.onSetMapLight(type, map.id, light.id, { hidden: !light.hidden });
          }
        });
        row.appendChild(toggle);

        const remove = el('button', 'btn btn--tiny btn--danger', '✕');
        remove.type = 'button';
        remove.title = 'Убрать источник света';
        remove.addEventListener('click', () => {
          if (this.handlers.onDeleteMapLight) this.handlers.onDeleteMapLight(type, map.id, light.id);
        });
        row.appendChild(remove);

        list.appendChild(row);
      }
      box.appendChild(list);
      return box;
    }

    /**
     * Включает или выключает режим кисти.
     * @param {boolean} value
     */
    setFogMode(value) {
      this.fogMode = Boolean(value);
      // Туман и стены рисуются разными инструментами: включенный туман
      // выключает остальное, иначе протяжка стены открывала бы ещё и карту.
      if (this.fogMode && this.drawMode) {
        this.drawMode = null;
        this.wallDraft = null;
        this.surface.classList.remove('is-drawing-light', 'is-drawing-wall');
        this.paintWallDraft();
      }
      this.surface.classList.toggle('is-fogging', this.fogMode);
    }

    /**
     * Где на карте оказался указатель, в долях от размера карты.
     * @param {PointerEvent|MouseEvent} event
     * @returns {{x: number, y: number}}
     */
    mapPoint(event) {
      const rect = this.surface.getBoundingClientRect();
      return {
        x: rect.width ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0,
        y: rect.height ? Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) : 0
      };
    }

    /* ------------------------------------------- Поверхность карты по клеткам */

    /**
     * Рисует поверхность: кислота, огонь, вода и прочее по клеткам.
     *
     * Слой полупрозрачный и лежит под фишками: это пол, а не то, что стоит на
     * нём. Каждая клетка рисуется со своей текстурой, иначе восемь типов
     * выглядели бы восемью оттенками одного пятна.
     * @param {object|null} map Текущая карта.
     */
    paintSurface(map) {
      const canvas = this.surfaceCanvas;
      if (!canvas) return;
      const cells = map && map.surface && map.surface.cells ? map.surface.cells : {};
      const keys = Object.keys(cells);
      if (!keys.length) {
        canvas.hidden = true;
        return;
      }
      canvas.hidden = false;
      const width = Math.max(1, Math.round(this.surface.clientWidth));
      const height = Math.max(1, Math.round(this.surface.clientHeight));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const context = this.surfaceContext;
      context.clearRect(0, 0, width, height);
      const imageWidth = this.image ? this.image.naturalWidth : 0;
      const imageHeight = this.image ? this.image.naturalHeight : 0;
      if (!imageWidth || !imageHeight) return;
      const cell = this.effectiveCell();
      const scaleX = width / imageWidth;
      const scaleY = height / imageHeight;
      const shiftX = (Number(this.grid.offsetX) || 0) * scaleX;
      const shiftY = (Number(this.grid.offsetY) || 0) * scaleY;
      const sizeX = Math.max(1, cell * scaleX);
      const sizeY = Math.max(1, cell * scaleY);

      for (const key of keys) {
        const type = DnD.SURFACE_TYPES.find((item) => item.id === cells[key]);
        const parts = key.split(',');
        if (!type || parts.length !== 2) continue;
        const col = Number(parts[0]);
        const row = Number(parts[1]);
        const x = shiftX + col * sizeX;
        const y = shiftY + row * sizeY;
        context.save();
        context.globalAlpha = 0.55;
        context.fillStyle = type.color;
        context.fillRect(x, y, sizeX, sizeY);
        // Штриховка поверх заливки: по одному цвету половина типов не
        // отличилась бы от другой, а поверхность читают с одного взгляда.
        context.globalAlpha = 0.35;
        context.strokeStyle = type.color;
        context.lineWidth = Math.max(1, Math.min(sizeX, sizeY) / 14);
        this.surfaceTexture(context, type.id, x, y, sizeX, sizeY);
        context.restore();
      }
    }

    /**
     * Штриховка типа поверхности внутри клетки.
     *
     * Разная у каждого типа: огонь идёт языками, вода — волной, руины —
     * обломками. Рисуется линиями, а не картинками: картинка тянулась бы с
     * сервера вместе с кампанией и весила бы больше, чем сама карта.
     * @param {CanvasRenderingContext2D} context
     * @param {string} type
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     */
    surfaceTexture(context, type, x, y, width, height) {
      const step = Math.max(2, Math.min(width, height) / 4);
      context.beginPath();
      if (type === 'fire') {
        for (let i = 0; i <= 3; i += 1) {
          const px = x + width * (i + 0.5) / 4;
          context.moveTo(px, y + height);
          context.lineTo(px + (i % 2 ? width / 8 : -width / 8), y);
        }
      } else if (type === 'water' || type === 'slick') {
        for (let row = 1; row <= 2; row += 1) {
          const py = y + height * row / 3;
          for (let i = 0; i <= 3; i += 1) {
            const px = x + width * i / 3;
            context.moveTo(px, py);
            context.lineTo(px + width / 6, py + (row === 1 ? step / 2 : -step / 2));
          }
        }
      } else if (type === 'ice') {
        context.moveTo(x, y + height / 2);
        context.lineTo(x + width / 2, y);
        context.lineTo(x + width, y + height / 2);
        context.moveTo(x + width / 2, y + height / 2);
        context.lineTo(x + width / 2, y + height);
        context.moveTo(x, y + height / 2);
        context.lineTo(x + width / 2, y + height / 2);
        context.lineTo(x + width, y + height / 2);
      } else if (type === 'rubble') {
        context.moveTo(x, y + height);
        context.lineTo(x + width * 0.4, y + height * 0.3);
        context.lineTo(x + width, y + height);
        context.moveTo(x + width * 0.4, y + height * 0.3);
        context.lineTo(x + width * 0.7, y);
      } else if (type === 'smoke') {
        for (let i = 0; i <= 2; i += 1) {
          context.moveTo(x + width * i / 2, y + height);
          context.lineTo(x + width * (i + 0.6) / 2, y);
        }
      } else if (type === 'poison') {
        context.arc(x + width / 3, y + height / 3, step / 2, 0, Math.PI * 2);
        context.arc(x + width * 2 / 3, y + height * 2 / 3, step / 3, 0, Math.PI * 2);
      } else {
        // Кислота и всё, чего правила не знают: капли с краю.
        context.moveTo(x, y + height);
        context.quadraticCurveTo(x + width / 2, y + height * 0.4, x + width, y + height);
      }
      context.stroke();
    }

    /**
     * Кисть поверхности: клетки под указателем и под ним самим.
     *
     * Мазок копится и уходит на сервер по отпусканию мыши: рассылка на каждое
     * движение отправила бы сотни сообщений за один мазок.
     * @param {PointerEvent|MouseEvent} event
     */
    paintSurfaceAt(event) {
      // null — кисть выключена; пустая строка — ластик, и он тоже рисует
      // (точнее, стирает). Проверка на falsy убивала ластик молча.
      if (this.surfaceTool === null) return;
      const map = this.mapOf(this.viewedMap);
      if (!map) return;
      const cell = this.cellAtClient(event.clientX, event.clientY);
      if (!cell) return;
      const brush = Math.max(0, Math.round(this.surfaceBrush)) - 1;
      for (let row = cell.row - brush; row <= cell.row + brush; row += 1) {
        for (let col = cell.col - brush; col <= cell.col + brush; col += 1) {
          if (col < 0 || row < 0) continue;
          const key = `${col},${row}`;
          if (!this.surfaceStroke.some((item) => item[0] === col && item[1] === row)) {
            this.surfaceStroke.push([col, row, this.surfaceTool]);
          }
        }
      }
      map.surface = map.surface && typeof map.surface === 'object' ? map.surface : { cells: {} };
      map.surface.cells = { ...map.surface.cells };
      for (const [col, row, type] of this.surfaceStroke) {
        if (type) map.surface.cells[`${col},${row}`] = type;
        else delete map.surface.cells[`${col},${row}`];
      }
      this.paintSurface(map);
    }

    /** Отправляет накопленный мазок и очищает его. */
    flushSurfaceStroke() {
      if (!this.surfaceStroke.length) return;
      const cells = this.surfaceStroke;
      this.surfaceStroke = [];
      if (this.handlers.onPaintSurface) {
        this.handlers.onPaintSurface(this.viewedMap, this.currentMapId, cells);
      }
    }

    /**
     * Включает кисть поверхности.
     * @param {string|null} type Тип поверхности или null, если инструмент выключен.
     */
    setSurfaceTool(type) {
      // Ластик и кисть несовместимы: стирать можно только тем, чем нарисовано.
      this.surfaceTool = type === '' ? '' : (type || null);
      this.surfaceStroke = [];
      this.surface.classList.toggle('is-painting-surface', Boolean(this.surfaceTool !== null));
      this.renderToolbar();
    }

    /**
     * Рисует туман по маске карты.
     *
     * Маска рисуется в её собственном масштабе и растягивается на всю карту.
     * Так граница получается мягкой: билинейное сглаживание холста превращает
     * лесенку клеток в плавный переход, а 2560 прямоугольников на каждый кадр
     * не рисуются вовсе.
     *
     * У мастера туман бледнее: мастер должен видеть, где ещё темно, а игроку
     * нужен почти сплошной мрак.
     * @param {object|null} map Текущая карта.
     */
    paintFog(map) {
      const canvas = this.fogCanvas;
      if (!canvas) return;
      const mask = map && typeof map.fogMask === 'string' ? map.fogMask : '';
      // Открытых участков нет: слой не рисуется вовсе. Карта без тумана не
      // должна выглядеть как сломанная только потому, что мастер его ещё не
      // открывал.
      if (!DnD.fogHasOpenArea(mask)) {
        canvas.hidden = true;
        return;
      }
      canvas.hidden = false;
      const width = Math.max(1, Math.round(this.surface.clientWidth));
      const height = Math.max(1, Math.round(this.surface.clientHeight));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const context = this.fogContext;
      context.clearRect(0, 0, width, height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.globalAlpha = 1;
      context.drawImage(this.fogLayer(mask), 0, 0, width, height);
    }

    /**
     * Мелкий холст с маской: закрытая клетка тёмная, открытая прозрачная.
     *
     * Холст переиспользуется между вызовами, а пиксели заливаются только когда
     * маска действительно изменилась: кисть шлёт событие на каждое движение
     * мыши, и пересобирать картинку заново было бы заметно.
     * @param {string} mask
     * @returns {HTMLCanvasElement}
     */
    fogLayer(mask) {
      if (!this.fogSource) {
        const source = document.createElement('canvas');
        source.width = DnD.FOG.columns;
        source.height = DnD.FOG.rows;
        this.fogSource = source;
        this.fogSourceContext = source.getContext('2d');
        this.fogSourceImage = this.fogSourceContext.createImageData(DnD.FOG.columns, DnD.FOG.rows);
        this.fogSourceMask = '';
      }
      if (this.fogSourceMask === mask) return this.fogSource;
      this.fogSourceMask = mask;
      const data = this.fogSourceImage.data;
      const alpha = this.role === 'dm' ? 140 : 247;
      for (let row = 0; row < DnD.FOG.rows; row += 1) {
        for (let column = 0; column < DnD.FOG.columns; column += 1) {
          const index = row * DnD.FOG.columns + column;
          const offset = index * 4;
          data[offset] = 8;
          data[offset + 1] = 6;
          data[offset + 2] = 12;
          data[offset + 3] = mask[index] === DnD.FOG.open ? 0 : alpha;
        }
      }
      this.fogSourceContext.putImageData(this.fogSourceImage, 0, 0);
      return this.fogSource;
    }

    /* ------------------------------------------------------------------ *
     * Свет: темнота карты и пятна от источников
     * ------------------------------------------------------------------ */

    /**
     * Рисует темноту и пятна света.
     *
     * Свет состоит из двух слоёв, и это не украшение, а единственный способ
     * получить цвет. Первый слой — ночная завеса: она просто темнит карту там,
     * где источников нет. Второй — сами пятна, каждое своим цветом, поверх
     * завесы. Если вырезать пятна из темноты вычитанием, цвет источника
     * никуда не попадает: вычитание убирает прозрачность, но оставляет цвет
     * ночи, и лунный свет выглядел бы как факел.
     *
     * Всё считается в уменьшенных холстах: полигоны видимости строятся по
     * лучам, а не по пикселям, и подробность тут не нужна. Наружу буферы
     * отдаются размытыми, поэтому край тени получается мягким на любой карте.
     * @param {object|null} map Текущая карта.
     */
    paintLight(map) {
      const veil = this.lightCanvas;
      const glow = this.glowCanvas;
      if (!veil || !glow) return;
      const darkness = map && Number(map.darkness) > 0 ? Number(map.darkness) : 0;
      const sources = this.lightSources(map);
      // Темнота без единого огня — это и есть кромешная тьма, и она должна
      // рисоваться. Слои выключаются только там, где темноты нет вовсе:
      // дневная карта без освещения не должна выглядеть пожелтевшей.
      if (darkness <= 0) {
        veil.hidden = true;
        glow.hidden = true;
        return;
      }
      veil.hidden = false;
      glow.hidden = false;

      const width = Math.max(1, Math.round(this.surface.clientWidth));
      const height = Math.max(1, Math.round(this.surface.clientHeight));
      for (const canvas of [veil, glow]) {
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
      }

      const smallWidth = Math.max(1, Math.round(width * LIGHT_RENDER_SCALE));
      const smallHeight = Math.max(1, Math.round(height * LIGHT_RENDER_SCALE));
      const grid = this.lightMapGrid(map, width, height);
      const cells = wallsInCells(normalizeWalls(map.walls), grid);

      // Пятна не пересчитываются, пока не сдвинулась стена, не горит или не
      // погас источник и не изменился размер карты. Пересчёт всех полигонов на
      // каждое движение мыши при протяжке стены заметно подтормаживал.
      const key = this.lightCacheKey(sources, cells, grid, smallWidth, smallHeight);
      if (key !== this.lightKey) {
        this.lightKey = key;
        this.renderLightBuffers(sources, cells, grid, smallWidth, smallHeight, darkness);
      }

      const blur = Math.max(2, Math.round(width * LIGHT_BLUR_RATIO));
      this.drawLightLayer(veil, this.lightSource, width, height, blur, this.lightContext);
      this.drawLightLayer(glow, this.glowSource, width, height, blur, this.glowContext, LIGHT_GLOW_STRENGTH);
    }

    /**
     * Ключ, по которому решается, что свет надо пересчитать.
     *
     * Темнота в него не входит намеренно: она меняет только прозрачность
     * завесы, а пятна от неё не зависят, и тянуть ползунок не заставит
     * перестраивать все многоугольники заново.
     * @param {object[]} sources
     * @param {object[]} cells Стены в клетках.
     * @param {object} grid
     * @param {number} smallWidth
     * @param {number} smallHeight
     * @returns {string}
     */
    lightCacheKey(sources, cells, grid, smallWidth, smallHeight) {
      const lights = sources
        .map((light) => `${light.x},${light.y},${light.radius},${light.color || ''},${light.dim ? 'd' : 'b'}`)
        .join(';');
      const walls = cells
        .map((wall) => `${wall.x1.toFixed(3)},${wall.y1.toFixed(3)},${wall.x2.toFixed(3)},${wall.y2.toFixed(3)}`)
        .join(';');
      return `${smallWidth}x${smallHeight}|${grid.columns}x${grid.rows}|${lights}|${walls}`;
    }

    /**
     * Наполняет уменьшенные буферы: ночную завесу и цветные пятна.
     * @param {object[]} sources
     * @param {object[]} cells Стены в клетках.
     * @param {object} grid
     * @param {number} smallWidth
     * @param {number} smallHeight
     * @param {number} darkness
     */
    renderLightBuffers(sources, cells, grid, smallWidth, smallHeight, darkness) {
      if (!this.lightSource) {
        this.lightSource = document.createElement('canvas');
        this.lightSourceContext = this.lightSource.getContext('2d');
        this.glowSource = document.createElement('canvas');
        this.glowSourceContext = this.glowSource.getContext('2d');
      }
      const source = this.lightSource;
      const glowSource = this.glowSource;
      if (source.width !== smallWidth || source.height !== smallHeight) {
        source.width = smallWidth;
        source.height = smallHeight;
        glowSource.width = smallWidth;
        glowSource.height = smallHeight;
      }

      // Пятна идут первыми: их прозрачность нужна завесе, чтобы знать, где
      // темнота уже выедена и насколько.
      const glow = this.glowSourceContext;
      glow.setTransform(1, 0, 0, 1, 0, 0);
      glow.globalCompositeOperation = 'source-over';
      glow.globalAlpha = 1;
      glow.filter = 'none';
      glow.clearRect(0, 0, smallWidth, smallHeight);

      // Стена должна попадать в буфер шире своего пятна: иначе край тени
      // окажется за границей кадра и размытие срежет его по прямой.
      const bleed = smallWidth * 0.12;
      for (const light of sources) {
        // Тусклый свет светит вдвое меньше и выедает темноту не до конца: в нём
        // видно силуэты, но не детали. Дальность берёт на себя модель света,
        // здесь остаётся только приглушить само пятно.
        const polygon = lightPolygon(light, cells, grid);
        // Пик яркого света не единица: при перекрытии двух факелов единицы
        // складываются в пересвет, и комната пропадает.
        const peak = light.dim ? 0.45 : 0.85;
        // Пятно рисуется по многоугольнику видимости, а не по кругу: иначе
        // стены не держали бы свет и вся затея была бы пустой.
        glow.save();
        glow.beginPath();
        for (let i = 0; i < polygon.points.length; i += 1) {
          const [x, y] = polygon.points[i];
          const px = (x / grid.columns) * smallWidth;
          const py = (y / grid.rows) * smallHeight;
          if (i === 0) glow.moveTo(px, py);
          else glow.lineTo(px, py);
        }
        glow.closePath();
        glow.clip();
        // Градиент с несколькими ступенями, а не двумя: настоящий факел не
        // гаснет рывком у края, и на двух точках край пятна читается как
        // обводка.
        const radiusPx = (polygon.radiusCells / grid.columns) * smallWidth;
        const centerX = light.x * smallWidth;
        const centerY = light.y * smallHeight;
        const gradient = glow.createRadialGradient(
          centerX, centerY, 0,
          centerX, centerY, Math.max(1, radiusPx)
        );
        const steps = [
          [0, peak],
          [0.25, peak * 0.97],
          [0.45, peak * 0.88],
          [0.65, peak * 0.7],
          [0.82, peak * 0.42],
          [0.93, peak * 0.16],
          [1, 0]
        ];
        for (const [offset, value] of steps) {
          gradient.addColorStop(offset, tintedStop(light.color, value));
        }
        // Сложение: два рядом стоящих факела дают одно перекрытое пятно, а не
        // два наложенных круга с видимой границей.
        glow.globalCompositeOperation = 'lighter';
        glow.fillStyle = gradient;
        glow.fillRect(
          centerX - radiusPx - bleed,
          centerY - radiusPx - bleed,
          (radiusPx + bleed) * 2,
          (radiusPx + bleed) * 2
        );
        glow.restore();
      }

      const context = this.lightSourceContext;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalCompositeOperation = 'source-over';
      context.globalAlpha = 1;
      context.filter = 'none';
      context.fillStyle = DnD.LIGHT_AMBIENT;
      context.globalAlpha = darknessAlpha(darkness, this.role);
      context.fillRect(0, 0, smallWidth, smallHeight);
      context.globalAlpha = 1;
      // Завеса выедается там, где есть свет: чем ярче пятно, тем прозрачнее
      // темнота, и два перекрытых огня дают одно общее светлое место.
      context.globalCompositeOperation = 'destination-out';
      context.drawImage(glowSource, 0, 0);
      context.globalCompositeOperation = 'source-over';
    }

    /**
     * Выводит готовый буфер на слой карты, размытым по краю.
     *
     * Радиус размытия считается от ширины карты, чтобы на маленькой карте край
     * был таким же мягким, как на большой.
     * @param {HTMLCanvasElement} canvas Слой на карте.
     * @param {HTMLCanvasElement} source Готовый уменьшенный буфер.
     * @param {number} width
     * @param {number} height
     * @param {number} blur
     * @param {CanvasRenderingContext2D} context
     */
    drawLightLayer(canvas, source, width, height, blur, context, strength) {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = 'source-over';
      // Завеса рисуется в полную силу, а пятна — приглушённо: иначе свет
      // выбеливает карту и комнату перестаёт быть видно.
      context.globalAlpha = strength === undefined ? 1 : strength;
      context.filter = 'none';
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.filter = `blur(${blur}px)`;
      context.drawImage(source, 0, 0, width, height);
      context.filter = 'none';
      context.globalAlpha = 1;
    }

    /**
     * Все источники света на карте: поставленные мастером и горящие фишки.
     *
     * Фишка светит там, где стоит, и едет вместе с ней, но только пока сама
     * видна игроку: спрятанная фишка — заготовка, её свет посторонним не выдаёт.
     * @param {object|null} map
     * @returns {object[]}
     */
    lightSources(map) {
      const result = [];
      if (!map) return result;
      for (const light of normalizeLights(map.lights)) {
        if (!light.hidden) result.push(light);
      }
      for (const token of this.tokens || []) {
        if (!token.light || token.light.radius <= 0) continue;
        if (token.hidden) continue;
        if (token.mapType !== this.viewedMap) continue;
        if (token.mapId && this.currentMapId && token.mapId !== this.currentMapId) continue;
        result.push({ x: token.x, y: token.y, radius: token.light.radius });
      }
      return result;
    }

    /**
     * Сетка в клетках для расчёта света.
     *
     * Число клеток по ширине стол знает не всегда: если мастер задал размер
     * клетки в пикселях, а не число клеток, колонки считаются от ширины
     * подложки — ровно так же, как их считает видимая сетка. Иначе факел на
     * двадцать футов светит на две сотни клетки ширины карты.
     *
     * Число строк берётся из пропорций картинки: высоту сетки можно узнать
     * только глядя на карту.
     * @param {object|null} map
     * @param {number} width
     * @param {number} height
     * @returns {{columns: number, rows: number, feetPerCell: number}}
     */
    lightMapGrid(map, width, height) {
      const naturalWidth = this.image ? this.image.naturalWidth : 0;
      const naturalHeight = this.image ? this.image.naturalHeight : 0;
      const natural = naturalWidth && naturalHeight ? naturalWidth / naturalHeight : 0;
      // Поверхность подогнана под пропорции картинки, но на пустой карте она
      // может быть ещё не готова: тогда верим ей самой.
      const aspect = natural > 0 ? natural : (width && height ? width / height : 1);
      const grid = { ...this.grid };
      if (!(Number(grid.columns) > 0) && naturalWidth > 0) {
        // Клетка задана в пикселях картинки: столько их и укладывается в ширину.
        grid.columns = Math.max(
          DnD.GRID.minColumns,
          Math.round(naturalWidth / Math.max(1, Number(grid.cell) || DnD.GRID.defaultCell))
        );
      }
      return lightGrid(grid, aspect);
    }

    /**
     * Стены поверх карты: подсказка мастеру, а не часть освещения.
     *
     * Это чистая видимость, и игроку она не достаётся вовсе: стена выдала бы
     * заранее задуманную тактику. Источники света здесь не рисуются: сам он
     * виден и без точки, а точка только мешала бы читать карту.
     *
     * Рисуется SVG, а не набором повёрнутых прямоугольников: у прямоугольника
     * нельзя задать длину отрезка одной величиной, проценты по ширине и по
     * высоте не совпадают, и наклонная стена уезжала куда-то мимо карты.
     * @param {object|null} map
     */
    paintWallOverlay(map) {
      const overlay = this.wallOverlay;
      if (!overlay) return;
      while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
      const show = this.role === 'dm' && map;
      overlay.hidden = !show;
      if (!show) return;
      for (const wall of normalizeWalls(map.walls)) {
        overlay.appendChild(this.wallNode(wall, false));
      }
    }

    /**
     * Один отрезок стены в координатах карты.
     * @param {object} wall Точки в долях от 0 до 1.
     * @param {boolean} draft Черновик, который мастер тянет прямо сейчас.
     * @returns {SVGLineElement}
     */
    wallNode(wall, draft) {
      const node = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      node.setAttribute('x1', String(wall.x1 * 1000));
      node.setAttribute('y1', String(wall.y1 * 1000));
      node.setAttribute('x2', String(wall.x2 * 1000));
      node.setAttribute('y2', String(wall.y2 * 1000));
      if (draft) node.setAttribute('class', 'map-wall--draft');
      if (!draft) {
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = 'Стена: держит свет. Правый клик по ней убирает.';
        node.appendChild(title);
      }
      return node;
    }

    /**
     * Открывает участок карты под указателем и показывает результат сразу.
     *
     * Маску считает сервер, но ждать ответа нельзя: карта отставала бы от
     * руки на полсекунды, и мастер видел бы, куда он уже открыл, а куда ещё
     * нет. Поэтому маска применяется сразу и уходит наверх, а ответ сервера
     * её только подтверждает.
     * @param {PointerEvent} event
     */
    openFogAt(event) {
      const type = this.viewedMap;
      const map = this.mapOf(type);
      if (!map) return;
      const point = this.mapPoint(event);
      map.fogMask = DnD.openFogAt(map.fogMask, point.x, point.y, this.fogBrush);
      this.paintFog(map);
      if (this.handlers.onOpenMapFog) {
        this.handlers.onOpenMapFog(type, map.id, point.x, point.y, this.fogBrush);
      }
    }

    /**
     * Начало стены: мастер зажал левую кнопку на месте.
     *
     * Пока мышь не отпущена, стена рисуется на месте и держит свет — иначе
     * мастер увидел бы голый край тени и не понял бы, куда ведёт линия.
     * @param {PointerEvent} event
     */
    startWall(event) {
      const point = this.mapPoint(event);
      // Идентификатор сразу и окончательный: сервер примет тот же, и стена не
      // появится на карте второй копией, когда ответ придёт.
      this.wallDraft = { id: `w${Date.now()}${Math.round(point.x * 1000)}`, x1: point.x, y1: point.y, x2: point.x, y2: point.y };
      this.surface.classList.add('is-drawing-wall');
      this.paintWallDraft();
    }

    /** Протяжка: конец стены следует за мышью. */
    moveWall(event) {
      if (!this.wallDraft) return;
      const point = this.mapPoint(event);
      this.wallDraft.x2 = point.x;
      this.wallDraft.y2 = point.y;
      this.paintWallDraft();
    }

    /**
     * Отпустили мышь: стена уходит на сервер целиком.
     * @param {PointerEvent} event
     */
    finishWall(event) {
      const draft = this.wallDraft;
      this.wallDraft = null;
      this.surface.classList.remove('is-drawing-wall');
      if (!draft) return;
      const point = this.mapPoint(event);
      draft.x2 = point.x;
      draft.y2 = point.y;
      const map = this.mapOf(this.viewedMap);
      // Клик, а не протяжка: линия короче нескольких процентов карты — это
      // промах, а не стена, и иначе на карте накапливались бы невидимые точки.
      const wall = DnD.normalizeWall(draft);
      if (map && wall) {
        map.walls = normalizeWalls([...(map.walls || []), wall]);
      }
      this.paintWallDraft();
      this.paintWallOverlay(map);
      this.paintLight(map);
      if (wall && this.handlers.onAddMapWall) {
        this.handlers.onAddMapWall(this.viewedMap, this.currentMapId, wall);
      }
    }

    /** Черновик стены показывается поверх карты, пока её рисуют. */
    paintWallDraft() {
      const draft = this.wallDraft;
      let node = this.wallOverlay.querySelector('.map-wall--draft');
      if (!draft) {
        if (node) node.remove();
        return;
      }
      if (!node) {
        node = this.wallNode(draft, true);
        this.wallOverlay.appendChild(node);
      } else {
        node.setAttribute('x2', String(draft.x2 * 1000));
        node.setAttribute('y2', String(draft.y2 * 1000));
      }
      this.paintLight(this.mapOf(this.viewedMap));
    }

    /**
     * Ставит источник света под курсор.
     *
     * Клик, а не протяжка: дальность задаётся ползунком в панели, а тянуть
     * мышью круг на карте мастеру было бы медленнее, чем выбрать факел.
     * @param {PointerEvent} event
     */
    placeLight(event) {
      const map = this.mapOf(this.viewedMap);
      if (!map) return;
      const point = this.mapPoint(event);
      const preset = DnD.LIGHT_PRESETS[this.lightPreset] || DnD.LIGHT_PRESETS[0];
      const light = {
        id: `l${Date.now()}${Math.round(point.x * 1000)}`,
        x: point.x,
        y: point.y,
        radius: this.lightRadius,
        color: preset.color,
        // Новый источник появляется тусклым, а не ярким: яркий свет от мастера
        // видят все сразу, и заготовка перестаёт быть заготовкой.
        dim: true
      };
      // Свет рисуется сразу, на месте: иначе мастер поставил бы факел и не
      // увидел бы света до ответа сервера, а ответ идёт по сети.
      map.lights = normalizeLights([...(map.lights || []), light]);
      this.paintLight(map);
      this.paintWallOverlay(map);
      // Тулбар перерисовывается, чтобы источник сразу появился в списке: там
      // его можно погасить и убрать, не разыскивая точку на карте.
      this.renderToolbar();
      if (this.handlers.onAddMapLight) {
        this.handlers.onAddMapLight(this.viewedMap, this.currentMapId, light);
      }
    }

    /**
     * Стена под курсором, если указатель близко к её отрезку.
     *
     * Ищется в долях карты, а не в пикселях, чтобы попадание не зависело от
     * того, насколько мастер приблизил карту.
     * @param {PointerEvent} event
     * @returns {object|null}
     */
    wallNear(event) {
      const map = this.mapOf(this.viewedMap);
      if (!map) return null;
      const point = this.mapPoint(event);
      const grab = 0.012;
      for (const wall of normalizeWalls(map.walls)) {
        if (DnD.distanceToSegment(point.x, point.y, wall.x1, wall.y1, wall.x2, wall.y2) <= grab) {
          return wall;
        }
      }
      return null;
    }

    /** Включает или выключает рисование стен и расстановку света. */
    setDrawMode(value) {
      this.drawMode = this.drawMode === value ? null : value;
      if (this.drawMode !== 'wall') {
        this.wallDraft = null;
        this.paintWallDraft();
      }
      this.setFogMode(false);
      // Курсор показывает, что нажатие на карте теперь рисует, а не двигает
      // фишку: без этого мастер тянет стену и вместо неё таскает монстра.
      this.surface.classList.toggle('is-drawing-light', this.drawMode === 'light');
      this.surface.classList.toggle('is-drawing-wall', this.drawMode === 'wall');
      this.renderToolbar();
      this.paintWallOverlay(this.mapOf(this.viewedMap));
    }

    /**
     * @param {object} [state] снимок состояния стола
     * @param {{role: string, playerId: string}} [ctx]
     */
    render(state, ctx) {
      if (state) this.lastState = state;
      if (ctx) this.lastCtx = ctx;
      const source = this.lastState || {};
      const context = this.lastCtx || {};

      this.role = context.role || this.role;
      this.myPlayerId = context.playerId || this.myPlayerId;
      // Тренировочный стол: ДМа в нём нет, но карту для проверки загрузить
      // нужно — панель карты показывается с пометкой «проверка».
      this.training = Boolean(context.training);
      // Каждая вкладка хранит свой список карт: {items: [...], activeId}.
      this.maps = {};
      for (const type of DnD.MAP_TYPES) {
        const slot = source.maps ? source.maps[type] : null;
        this.maps[type] = slot && typeof slot === 'object' ? slot : { items: [], activeId: null };
      }
      this.previousActiveMap = this.activeMap;
      this.activeMap = source.activeMap || null;
      this.activeMapId = source.activeMapId || null;
      this.tokens = source.tokens || [];
      this.players = source.players || [];
      if (source.grid && typeof source.grid === 'object') {
        this.grid = {
          enabled: Boolean(source.grid.enabled),
          cell: Number(source.grid.cell) || DnD.GRID.defaultCell,
          columns: Number(source.grid.columns) || 0,
          // Футов в клетке: по нему дальность света переводится в клетки.
          feetPerCell: Number(source.grid.feetPerCell) || DnD.GRID.defaultFeetPerCell,
          // Сдвиг сетки: по нему клетка назначения считается так же, как её
          // рисует полоса на карте.
          offsetX: Number(source.grid.offsetX) || 0,
          offsetY: Number(source.grid.offsetY) || 0
        };
      }
      // Режим боя приходит со стола: он общий, иначе участники смотрели бы
      // на один и тот же бой по-разному.
      const combatEnabled = Boolean(source.combat && source.combat.enabled);
      if (combatEnabled !== this.combat.enabled) {
        this.combat.enabled = combatEnabled;
        if (!combatEnabled) this.combat.tokenId = null;
        // Перетаскивание, оставшееся незаконченным, держит слой фишек: он
        // перестаёт перерисовываться, и смена режима боя выглядит как «ничего
        // не произошло». Раз незахват состояние сменилось, снимаем его.
        if (this.dragState && !this.dragState.walk) this.dragState = null;
      }
      this.applyGrid();
      this.syncGridMenu(this.grid);

      const fallback = this.activeMap || DnD.MAP_TYPES.find((candidate) => this.mapOf(candidate)) || null;
      const previousViewed = this.viewedMap;
      if (this.role === 'dm') {
        // У ДМ всегда есть выбранная карта — иначе кнопка загрузки отправляла бы
        // запрос без типа карты. Уже выбранную вкладку (даже пустую) не сбрасываем:
        // так ДМ может загрузить карту и в третью вкладку.
        if (!DnD.MAP_TYPES.includes(this.viewedMap)) this.viewedMap = fallback || 'world';
      } else if (this.training) {
        // В тренировочном столе карту загружает сам игрок, поэтому вкладку он
        // выбирает свободно — как ДМ, а не ждёт, какую покажут.
        if (!DnD.MAP_TYPES.includes(this.viewedMap)) this.viewedMap = fallback || 'world';
      } else {
        // Игрок следует за ДМ, но может заглянуть во вторую карту.
        if (this.activeMap !== this.previousActiveMap) this.playerPeek = null;
        this.viewedMap = this.playerPeek && this.mapOf(this.playerPeek) ? this.playerPeek : fallback;
      }

      for (const type of DnD.MAP_TYPES) {
        const { button, dot } = this.tabButtons[type];
        const isActive = this.activeMap === type;
        button.classList.toggle('is-active', this.viewedMap === type && !this.lightTabOpen);
        button.classList.toggle('is-empty', this.mapCount(type) === 0);
        button.title = this.mapCount(type) > 1 ? `Карт во вкладке: ${this.mapCount(type)}` : '';
        dot.classList.toggle('is-on', isActive);
        dot.title = isActive ? 'Показана игрокам' : '';
      }
      // Вкладка света есть только у мастера и только с картой на экране:
      // без карты настраивать нечего, а игроку это и подавно не нужно.
      const lightMap = this.mapOf(this.viewedMap);
      this.lightTabButton.hidden = this.role !== 'dm' || !lightMap;
      this.lightTabButton.classList.toggle('is-active', this.lightTabOpen);
      this.lightTabButton.title = this.lightTabOpen
        ? 'Вернуться к управлению картой'
        : 'Настройки освещения: темнота, источники и стены';

      // При смене карты сдвиг вида сбрасываем: иначе новая карта открывается
      // сдвинутой в сторону. Приближение остаётся — оно личное дело каждого.
      if (this.viewedMap !== previousViewed) this.pan = { x: 0, y: 0 };
      const previousMapId = this.currentMapId;
      this.currentMapId = (this.mapOf(this.viewedMap) || {}).id || null;
      if (this.viewedMap !== previousViewed || this.currentMapId !== previousMapId) this.clearPings();

      if (this.editing) {
        this.badge.hidden = true;
      } else if (this.activeMap && this.role !== 'dm' && !this.training && this.viewedMap !== this.activeMap) {
        this.badge.hidden = false;
        this.badge.textContent = `ДМ показывает другую карту: ${DnD.MAP_LABELS[this.activeMap]}`;
      } else {
        this.badge.hidden = true;
      }

      this.renderToolbar();
      this.renderBody();
      this.updatePingAvailability();
    }

    /**
     * Обновляет только фишки, не трогая карту, сетку и слои.
     *
     * Сервер присылает tokenCreated/tokenUpdated/tokenHidden на каждое
     * изменение фишки, и полная перерисовка карты тут не нужна: подложка,
     * туман, свет и стены не менялись. Это заметно на больших картах, где
     * paintFog и paintLight пересобирают холсты.
     * @param {object} [state] снимок состояния стола
     * @param {{role: string, playerId: string}} [ctx]
     */
    refreshTokens(state, ctx) {
      if (state) this.lastState = state;
      if (ctx) this.lastCtx = ctx;
      const source = this.lastState || {};
      const context = this.lastCtx || {};

      this.role = context.role || this.role;
      this.myPlayerId = context.playerId || this.myPlayerId;
      this.training = Boolean(context.training);
      this.tokens = source.tokens || [];
      this.players = source.players || [];
      this.renderTokens();
      this.updatePingAvailability();
    }

    /**
     * Переключает режим боя без перерисовки карты и остальных панелей.
     * Меняются только кнопка в панели карты и поведение фишек.
     * @param {object} [state] снимок состояния стола
     * @param {{role: string, playerId: string}} [ctx]
     */
    refreshCombat(state, ctx) {
      if (state) this.lastState = state;
      if (ctx) this.lastCtx = ctx;
      const source = this.lastState || {};
      const context = this.lastCtx || {};

      this.role = context.role || this.role;
      this.myPlayerId = context.playerId || this.myPlayerId;
      const enabled = Boolean(source.combat && source.combat.enabled);
      if (enabled !== this.combat.enabled) {
        this.combat.enabled = enabled;
        if (!enabled) this.combat.tokenId = null;
        if (this.dragState && !this.dragState.walk) this.dragState = null;
      }
      this.renderToolbar();
      this.renderTokens();
    }

    /** Применяет настройки сетки стола к карте. */
    applyGrid() {
      const cell = this.effectiveCell();
      const scale = this.displayScale();
      // Клетка и сдвиг заданы в пикселях картинки, а сетка и фишки рисуются в
      // пикселях подложки. Подложка подгоняется под окно, поэтому без масштаба
      // сетка была бы крупнее самой карты: клетка 46 px картинки занимала бы
      // 46 px экрана вместо 46 × масштаб, и на уменьшенной карте линия маршрута
      // не совпадала бы с клетками, по которым посчитаны шаги.
      this.surface.style.setProperty('--cell', `${cell * scale}px`);
      // Сдвиг нужен, чтобы сетка легла на картинку с того же места, с которого
      // начинается сетка самой карты, а не с левого верхнего угла файла.
      this.surface.style.setProperty('--grid-shift-x', `${(Number(this.grid.offsetX) || 0) * scale}px`);
      this.surface.style.setProperty('--grid-shift-y', `${(Number(this.grid.offsetY) || 0) * scale}px`);
      this.gridLayer.hidden = !this.grid.enabled;
      if (this.editor) this.editor.setGrid(cell);
    }

    /**
     * Во сколько раз подложка на экране отличается от картинки.
     *
     * Нужен, чтобы сетка, фишки и метка клетки жили в тех же единицах, что и
     * карта: клетка задана в пикселях картинки, а рисуется в пикселях подложки.
     * @returns {number}
     */
    displayScale() {
      const natural = this.image ? this.image.naturalWidth : 0;
      const shown = this.surface ? this.surface.offsetWidth : 0;
      if (!natural || !shown) return 1;
      return shown / natural;
    }

    /** Показывает или прячет быструю настройку сетки за столом. */
    toggleGridMenu() {
      if (!this.gridMenu) return;
      const open = this.gridMenu.hidden;
      this.gridMenu.hidden = !open;
      if (this.gridMenuButton) this.gridMenuButton.classList.toggle('is-on', open);
      if (!open) return;
      this.syncGridMenu(this.grid);
      // Ставим меню под кнопкой: тулбар переносится по строкам, и жёсткое
      // смещение в CSS попадало бы то на карту, то на панель.
      if (this.gridMenuButton) {
        const rootRect = this.root.getBoundingClientRect();
        const buttonRect = this.gridMenuButton.getBoundingClientRect();
        const menuWidth = this.gridMenu.offsetWidth || 262;
        const left = Math.max(0, Math.min(
          buttonRect.left - rootRect.left,
          rootRect.width - menuWidth - 4
        ));
        this.gridMenu.style.top = `${buttonRect.bottom - rootRect.top + 6}px`;
        this.gridMenu.style.left = `${left}px`;
      }
    }

    /** Отправляет сетку из быстрого меню на стол, тем же полем, что и настройки. */
    applyGridMenu() {
      if (!this.handlers.onSetGrid || !this.gridMenuFields) return;
      const fields = this.gridMenuFields;
      const num = (input, fallback) => {
        const value = Number(input.value);
        return Number.isFinite(value) ? value : fallback;
      };
      const columns = Math.min(
        DnD.GRID.maxColumns,
        Math.max(0, DnD.roundColumns(num(fields.columns, 0)))
      );
      this.handlers.onSetGrid({
        enabled: fields.enabled.checked,
        cell: Math.round(num(fields.cell, DnD.GRID.defaultCell)),
        columns,
        feetPerCell: Math.round(num(fields.feetPerCell, DnD.GRID.defaultFeetPerCell)),
        offsetX: Math.round(num(fields.offsetX, 0)),
        offsetY: Math.round(num(fields.offsetY, 0))
      });
    }

    /**
     * Подтягивает поля быстрого меню к текущей сетке.
     * @param {object} grid
     */
    syncGridMenu(grid) {
      if (!this.gridMenu || !this.gridMenuFields) return;
      const fields = this.gridMenuFields;
      const set = (input, value) => {
        // Поле под курсором не трогаем: иначе ответ стола перебивал бы набор.
        if (document.activeElement === input) return;
        if (input.value !== String(value)) input.value = String(value);
      };
      fields.enabled.checked = Boolean(grid.enabled);
      set(fields.columns, grid.columns || 0);
      set(fields.cell, grid.cell || DnD.GRID.defaultCell);
      set(fields.offsetX, grid.offsetX || 0);
      set(fields.offsetY, grid.offsetY || 0);
      set(fields.feetPerCell, grid.feetPerCell || DnD.GRID.defaultFeetPerCell);
    }

    /**
     * Размер клетки в пикселях карты.
     *
     * Если мастер задал, сколько клеток укладывается по ширине, клетка
     * считается от настоящей ширины подложки: сетка одинаково ложится и на
     * маленькую, и на большую карту. Фишка рисуется тем же --cell, поэтому
     * ровно занимает одну клетку.
     * @returns {number}
     */
    effectiveCell() {
      return DnD.gridCellSize(this.grid, this.image ? this.image.naturalWidth : 0);
    }

    /* --------------------------------------------- Ход по клеткам: режим боя */

    /**
     * Геометрия сетки в пикселях картинки.
     *
     * Всё считается от настоящей ширины подложки и от того же сдвига, что и
     * полоса сетки на экране: клетка под курсором и нарисованная клетка обязаны
     * быть одной и той же, иначе фишка встаёт не туда.
     * @returns {{cell: number, offsetX: number, offsetY: number, columns: number, rows: number}|null}
     */
    cellGeometry() {
      const width = this.image ? this.image.naturalWidth : 0;
      const height = this.image ? this.image.naturalHeight : 0;
      if (!width || !height) return null;
      const cell = this.effectiveCell();
      if (!cell || cell <= 0) return null;
      const offsetX = Number(this.grid.offsetX) || 0;
      const offsetY = Number(this.grid.offsetY) || 0;
      return {
        cell,
        offsetX,
        offsetY,
        columns: Math.max(1, Math.ceil((width - offsetX) / cell)),
        rows: Math.max(1, Math.ceil((height - offsetY) / cell))
      };
    }

    /**
     * Клетка под указателем.
     * @param {number} clientX
     * @param {number} clientY
     * @returns {{col: number, row: number}|null}
     */
    cellAtClient(clientX, clientY) {
      const geometry = this.cellGeometry();
      const rect = this.surface.getBoundingClientRect();
      if (!geometry || !rect.width || !rect.height) return null;
      const width = this.image.naturalWidth;
      const height = this.image.naturalHeight;
      const px = (clientX - rect.left) / rect.width * width;
      const py = (clientY - rect.top) / rect.height * height;
      const col = Math.floor((px - geometry.offsetX) / geometry.cell);
      const row = Math.floor((py - geometry.offsetY) / geometry.cell);
      if (col < 0 || row < 0 || col >= geometry.columns || row >= geometry.rows) return null;
      return { col, row };
    }

    /**
     * Центр клетки в долях карты: координаты фишек по нулям и единицам.
     * @param {number} col
     * @param {number} row
     * @returns {{x: number, y: number}}
     */
    cellCenterInMap(col, row) {
      const geometry = this.cellGeometry();
      if (!geometry) return { x: 0, y: 0 };
      const width = this.image.naturalWidth;
      const height = this.image.naturalHeight;
      const x = geometry.offsetX + (col + 0.5) * geometry.cell;
      const y = geometry.offsetY + (row + 0.5) * geometry.cell;
      return { x: x / width, y: y / height };
    }

    /**
     * Клетка, в которой стоит фишка.
     * @param {object} token
     * @returns {{col: number, row: number}|null}
     */
    tokenCell(token) {
      const geometry = this.cellGeometry();
      if (!geometry || !token) return null;
      const width = this.image.naturalWidth;
      const height = this.image.naturalHeight;
      // Положение берём у нарисованной фишки, а не из token.x/y: во время хода
      // по клеткам узел уже стоит в новой клетке, а координаты в снимке ещё
      // старые, и маршрут начинался бы там, откуда фишка ушла.
      const point = this.tokenMapPoint(token);
      const px = point.x * width;
      const py = point.y * height;
      const col = Math.floor((px - geometry.offsetX) / geometry.cell);
      const row = Math.floor((py - geometry.offsetY) / geometry.cell);
      if (col < 0 || row < 0) return { col: 0, row: 0 };
      return {
        col: Math.min(geometry.columns - 1, col),
        row: Math.min(geometry.rows - 1, row)
      };
    }

    /**
     * Где фишка нарисована сейчас, в долях карты.
     *
     * Обычно это token.x/y, но во время перетаскивания и пошагового хода узел
     * двигается раньше, чем приходит обновление снимка. Брать координаты из
     * узла надёжнее: линия маршрута обязана начинаться у кружка, который видит
     * человек, а не там, где фишка была до хода.
     * @param {object} token
     * @returns {{x: number, y: number}}
     */
    tokenMapPoint(token) {
      if (this.dragState && this.dragState.tokenId === token.id
        && Number.isFinite(this.dragState.x) && Number.isFinite(this.dragState.y)) {
        return { x: this.dragState.x, y: this.dragState.y };
      }
      const node = this.tokenLayer
        ? this.tokenLayer.querySelector(`[data-token-id="${token.id}"]`)
        : null;
      if (node && node.style.left && node.style.top) {
        const x = parseFloat(node.style.left) / 100;
        const y = parseFloat(node.style.top) / 100;
        if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
      }
      return { x: Number(token.x), y: Number(token.y) };
    }

    /**
     * Путь от фишки до клетки: только по сторонам клеток, с одним поворотом.
     *
     * Диагонали нет намеренно: сквозь угол клетки фишка не ходит, поэтому путь
     * идёт сначала по вертикали до строки цели, потом по горизонтали до её
     * столбца. Поворот один, и он всегда в строке цели: иначе длина пути была
     * бы одинаковой, а рисунок скакал бы от клетки к клетке.
     * @param {{col: number, row: number}} from
     * @param {{col: number, row: number}} to
     * @returns {{col: number, row: number}[]} Точки от старта до цели, без старта.
     */
    combatPath(from, to) {
      const points = [];
      // Шаг в ноль означает «по этой оси не идём»: без такой проверки цикл от
      // равных клеток ушёл бы в бесконечность.
      const rowStep = to.row > from.row ? 1 : (to.row < from.row ? -1 : 0);
      for (let row = from.row + rowStep; row !== to.row; row += rowStep) {
        points.push({ col: from.col, row });
      }
      // Угол пути: клетка в строке цели и в столбце фишки. Без неё ломаная
      // перескакивала бы через угол клетки, то есть по диагонали.
      const colStep = to.col > from.col ? 1 : (to.col < from.col ? -1 : 0);
      if (rowStep !== 0 && colStep !== 0) points.push({ col: from.col, row: to.row });
      for (let col = from.col + colStep; col !== to.col; col += colStep) {
        points.push({ col, row: to.row });
      }
      points.push({ col: to.col, row: to.row });
      return points;
    }

    /**
     * Расстояние между клетками.
     *
     * Раз путь идёт только по сторонам клеток, диагонали в нём нет, а значит
     * шаг равен клетке, и расстояние считается как в сетке: разница по столбцам
     * плюс разница по строкам. Футы берутся из настройки стола, поэтому у карты
     * со своей мерой счёт остаётся верным.
     * @param {{col: number, row: number}} from
     * @param {{col: number, row: number}} to
     * @returns {{steps: number, cells: number, feet: number}}
     */
    combatMeasure(from, to) {
      const steps = Math.abs(to.col - from.col) + Math.abs(to.row - from.row);
      const feetPerCell = Number(this.grid.feetPerCell) || DnD.GRID.defaultFeetPerCell;
      return { steps, cells: steps, feet: steps * feetPerCell };
    }

    /**
     * Подпись расстояния на карте.
     *
     * Три числа, потому что три вопроса: сколько шагов, сколько клеток и сколько
     * это футов. Одного числа мастеру мало: шагов он считает за ход, а футы
     * сверяет со скоростью персонажа.
     * @param {{steps: number, cells: number, feet: number}} measure
     * @returns {string}
     */
    combatDistanceText(measure) {
      const plural = (value, one, few, many) => {
        const last10 = value % 10;
        const last100 = value % 100;
        if (last10 === 1 && last100 !== 11) return one;
        if (last10 >= 2 && last10 <= 4 && (last100 < 10 || last100 >= 20)) return few;
        return many;
      };
      const steps = Math.round(measure.steps);
      if (!steps) return 'здесь же';
      const cells = measure.cells.toFixed(1).replace('.', ',');
      const feet = Math.round(measure.feet);
      return `${steps} ${plural(steps, 'шаг', 'шага', 'шагов')}`
        + ` · ${cells} ${plural(Number(cells.replace(',', '.')), 'клетка', 'клетки', 'клеток')}`
        + ` · ${feet} ${plural(feet, 'фут', 'фута', 'футов')}`;
    }

    /**
     * Выбирает фишку, которая будет ходить.
     * @param {string|null} tokenId
     */
    selectCombatToken(tokenId) {
      const next = tokenId && this.combat.enabled ? tokenId : null;
      if (this.combat.tokenId === next) return;
      this.combat.tokenId = next;
      this.route = null;
      this.surface.classList.toggle('is-combat', Boolean(next));
      this.renderTokens();
      this.paintRoute();
    }

    /** Включает и выключает линейку. */
    toggleMeasure() {
      this.measureMode = !this.measureMode;
      if (this.measureButton) {
        this.measureButton.classList.toggle('is-on', this.measureMode);
        this.measureButton.title = this.measureMode
          ? 'Выключить измерение'
          : 'Измерять расстояние по сетке';
      }
      this.surface.classList.toggle('is-measuring', this.measureMode);
      if (!this.measureMode) this.clearMeasure();
    }

    /** Убирает линию линейки с карты. */
    clearMeasure() {
      this.measureStart = null;
      this.measureEnd = null;
      if (this.measureLayer) this.measureLayer.hidden = true;
    }

    /**
     * Можно ли пинговать: только на карте, которую сейчас видят игроки.
     *
     * Пинг на скрытой заготовке не показал бы ничего, кроме её существования.
     * В тренировочном столе других участников нет, поэтому кнопка выключена.
     * @returns {boolean}
     */
    canPing() {
      return Boolean(
        !this.training
        && this.currentMapId
        && this.activeMap
        && this.activeMap === this.viewedMap
        && this.activeMapId === this.currentMapId
      );
    }

    /** Включает и выключает режим пинга. */
    togglePing() {
      if (!this.canPing()) {
        if (this.handlers.onNotice) {
          this.handlers.onNotice('Пинг доступен на карте, которую видят игроки');
        }
        return;
      }
      if (!this.pingMode && this.measureMode) this.toggleMeasure();
      this.setPingMode(!this.pingMode);
    }

    /** @param {boolean} value */
    setPingMode(value) {
      this.pingMode = Boolean(value) && this.canPing();
      if (this.surface) this.surface.classList.toggle('is-pinging', this.pingMode);
      if (this.pingButton) {
        this.pingButton.classList.toggle('is-on', this.pingMode);
        this.pingButton.setAttribute('aria-pressed', this.pingMode ? 'true' : 'false');
        this.pingButton.title = this.pingMode
          ? 'Пинг включён: нажмите на карту'
          : 'Пинг по карте (Alt+клик)';
      }
    }

    /** Обновляет доступность кнопки пинга при смене карты. */
    updatePingAvailability() {
      if (!this.pingButton) return;
      const can = this.canPing();
      this.pingButton.disabled = !can;
      this.pingButton.title = can
        ? (this.pingMode ? 'Пинг включён: нажмите на карту' : 'Пинг по карте (Alt+клик)')
        : 'Пинг доступен на карте, которую видят игроки';
      if (!can && this.pingMode) this.setPingMode(false);
    }

    /** Отправляет пинг в точке, где нажали. @param {PointerEvent} event */
    pingAt(event) {
      if (!this.canPing() || !this.handlers.onPing) return;
      const rect = this.surface.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      if (event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom) return;
      const point = this.mapPoint(event);
      this.handlers.onPing(this.viewedMap, this.currentMapId, point.x, point.y);
    }

    /**
     * Показывает пинг, пришедший с сервера. Метка живёт пару секунд и
     * исчезает сама, в кампанию не попадает.
     * @param {{mapType: string, mapId: string, x: number, y: number, name?: string, role?: string}} ping
     */
    showPing(ping) {
      if (!ping || !this.pingLayer) return;
      if (ping.mapType !== this.viewedMap || ping.mapId !== this.currentMapId) return;
      const x = Math.max(0, Math.min(1, Number(ping.x)));
      const y = Math.max(0, Math.min(1, Number(ping.y)));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const node = el('div', 'map-ping');
      node.classList.toggle('map-ping--dm', ping.role === 'dm');
      node.style.left = `${x * 100}%`;
      node.style.top = `${y * 100}%`;
      node.appendChild(el('span', 'map-ping__ring'));
      node.appendChild(el('span', 'map-ping__dot'));
      const name = el('span', 'map-ping__name');
      name.textContent = ping.name || (ping.role === 'dm' ? 'Мастер' : 'Игрок');
      node.appendChild(name);
      this.pingLayer.appendChild(node);
      const timer = setTimeout(() => {
        node.remove();
        this.pingTimers.delete(timer);
      }, 2400);
      this.pingTimers.add(timer);
    }

    /** Убирает все пинги, например при переходе на другую карту. */
    clearPings() {
      for (const timer of this.pingTimers) clearTimeout(timer);
      this.pingTimers.clear();
      if (this.pingLayer) this.pingLayer.replaceChildren();
    }

    /** Рисует линию линейки и подпись с футами по сетке. */
    paintMeasure() {
      if (!this.measureLayer) return;
      const start = this.measureStart;
      const end = this.measureEnd;
      if (!start || !end) {
        this.measureLayer.hidden = true;
        return;
      }
      const width = Math.max(1, this.surface.clientWidth);
      const height = Math.max(1, this.surface.clientHeight);
      this.measureSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      const x1 = start.x * width;
      const y1 = start.y * height;
      const x2 = end.x * width;
      const y2 = end.y * height;
      this.measureLine.setAttribute('x1', String(x1));
      this.measureLine.setAttribute('y1', String(y1));
      this.measureLine.setAttribute('x2', String(x2));
      this.measureLine.setAttribute('y2', String(y2));
      this.measureStartDot.setAttribute('cx', String(x1));
      this.measureStartDot.setAttribute('cy', String(y1));
      this.measureStartDot.setAttribute('r', '5');
      this.measureEndDot.setAttribute('cx', String(x2));
      this.measureEndDot.setAttribute('cy', String(y2));
      this.measureEndDot.setAttribute('r', '5');

      const imageWidth = this.image.naturalWidth || width;
      const imageHeight = this.image.naturalHeight || height;
      const cell = Math.max(1, this.effectiveCell());
      const cells = Math.hypot((end.x - start.x) * imageWidth, (end.y - start.y) * imageHeight) / cell;
      const whole = Math.max(0, Math.round(cells));
      const feetPerCell = Number(this.grid.feetPerCell) || DnD.GRID.defaultFeetPerCell;
      this.measureLabel.textContent = `${whole * feetPerCell} фут. · ${whole} кл.`;
      this.measureLabel.style.left = `${((start.x + end.x) / 2) * width}px`;
      this.measureLabel.style.top = `${((start.y + end.y) / 2) * height}px`;
      this.measureLayer.hidden = false;
    }

    /** Открывает и закрывает меню шаблонов рядом с тулбаром карты. */
    toggleTemplateMenu() {
      const open = this.templateMenu.hidden;
      this.templateMenu.hidden = !open;
      if (this.gridMenu) this.gridMenu.hidden = true;
      if (this.templateButton) this.templateButton.classList.toggle('is-on', open);
    }

    /** Берёт фигуру и размер из меню и переводит карту в режим постановки. */
    startTemplatePlacement() {
      const kind = this.templateKind ? this.templateKind.value : 'sphere';
      const size = Math.max(5, Math.min(120, Math.round(Number(this.templateSize && this.templateSize.value) || 20)));
      const color = this.templateColor && /^#[0-9a-f]{6}$/i.test(this.templateColor.value)
        ? this.templateColor.value
        : '#6aa9ff';
      this.templateDraft = { kind, size, color };
      this.templateMenu.hidden = true;
      if (this.templateButton) this.templateButton.classList.remove('is-on');
      this.surface.classList.add('is-templating');
      if (this.handlers.onNotice) {
        this.handlers.onNotice(kind === 'sphere' || kind === 'square'
          ? 'Нажмите на центр фигуры и потяните, чтобы задать размер и поворот'
          : 'Нажмите на вершину и потяните в сторону действия');
      }
    }

    /**
     * Собирает шаблон из протяжки: начало — центр или вершина, направление
     * протяжки — поворот (0° вверх, по часовой стрелке).
     * @param {{x: number, y: number}} start
     * @param {{x: number, y: number}} end
     */
    makeTemplate(start, end) {
      const draft = this.templateDraft || { kind: 'sphere', size: 20 };
      const width = this.image.naturalWidth || 1;
      const height = this.image.naturalHeight || 1;
      const dx = (end.x - start.x) * width;
      const dy = (end.y - start.y) * height;
      const rotation = Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01
        ? 0
        : (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
      return {
        id: `t-${Math.random().toString(36).slice(2, 10)}`,
        kind: draft.kind,
        x: start.x,
        y: start.y,
        size: draft.size,
        rotation: Math.round(rotation),
        color: draft.color || ''
      };
    }

    /**
     * Рисует шаблоны карты и, если мастер сейчас тянет, предпросмотр.
     * @param {object|null} map
     */
    paintTemplates(map) {
      const layer = this.templateLayer;
      if (!layer) return;
      layer.innerHTML = '';
      const templates = map && Array.isArray(map.templates) ? map.templates.slice() : [];
      if (this.templatePreview) templates.push(this.templatePreview);
      const width = this.image.naturalWidth;
      const height = this.image.naturalHeight;
      if (!templates.length || !width || !height) {
        layer.hidden = true;
        return;
      }
      layer.hidden = false;
      layer.setAttribute('viewBox', `0 0 ${width} ${height}`);
      const cell = Math.max(1, this.effectiveCell());
      const feetPerCell = Number(this.grid.feetPerCell) || DnD.GRID.defaultFeetPerCell;
      const pxPerFoot = cell / Math.max(1, feetPerCell);
      for (const template of templates) {
        this.appendTemplate(layer, template, width, height, pxPerFoot);
      }
    }

    /** @param {SVGElement} layer */
    appendTemplate(layer, template, width, height, pxPerFoot) {
      const cx = template.x * width;
      const cy = template.y * height;
      const length = Math.max(1, template.size * pxPerFoot);
      const angle = (template.rotation * Math.PI) / 180;
      const dirX = Math.sin(angle);
      const dirY = -Math.cos(angle);
      const namespace = 'http://www.w3.org/2000/svg';
      const tag = template.kind === 'sphere'
        ? 'circle'
        : template.kind === 'square'
          ? 'rect'
          : template.kind === 'cone'
            ? 'polygon'
            : 'line';
      const shape = document.createElementNS(namespace, tag);
      shape.setAttribute('class', `map-template map-template--${template.kind}`);
      if (template.kind === 'sphere') {
        shape.setAttribute('cx', String(cx));
        shape.setAttribute('cy', String(cy));
        shape.setAttribute('r', String(length));
      } else if (template.kind === 'square') {
        shape.setAttribute('x', String(cx - length / 2));
        shape.setAttribute('y', String(cy - length / 2));
        shape.setAttribute('width', String(length));
        shape.setAttribute('height', String(length));
        shape.setAttribute('transform', `rotate(${template.rotation} ${cx} ${cy})`);
      } else if (template.kind === 'cone') {
        const baseX = cx + dirX * length;
        const baseY = cy + dirY * length;
        const half = length / 2;
        const perpX = Math.cos(angle);
        const perpY = Math.sin(angle);
        shape.setAttribute('points', [
          `${cx},${cy}`,
          `${baseX + perpX * half},${baseY + perpY * half}`,
          `${baseX - perpX * half},${baseY - perpY * half}`
        ].join(' '));
      } else {
        shape.setAttribute('x1', String(cx));
        shape.setAttribute('y1', String(cy));
        shape.setAttribute('x2', String(cx + dirX * length));
        shape.setAttribute('y2', String(cy + dirY * length));
      }
      if (template.color && /^#[0-9a-f]{6}$/i.test(template.color)) {
        shape.setAttribute('stroke', template.color);
        if (template.kind !== 'line') {
          shape.setAttribute('fill', template.color);
          shape.setAttribute('fill-opacity', '0.16');
        }
      }
      layer.appendChild(shape);
    }

    /**
     * Ищет шаблон под указателем: правый клик по нему убирает фигуру.
     * @param {PointerEvent|MouseEvent} event
     */
    templateNear(event) {
      const map = this.mapOf(this.viewedMap);
      if (!map || !Array.isArray(map.templates) || !map.templates.length) return null;
      const width = this.image.naturalWidth;
      const height = this.image.naturalHeight;
      if (!width || !height) return null;
      const point = this.mapPoint(event);
      const cell = Math.max(1, this.effectiveCell());
      const feetPerCell = Number(this.grid.feetPerCell) || DnD.GRID.defaultFeetPerCell;
      const pxPerFoot = cell / Math.max(1, feetPerCell);
      for (const template of map.templates) {
        const distance = Math.hypot((point.x - template.x) * width, (point.y - template.y) * height);
        const reach = template.kind === 'sphere'
          ? template.size * pxPerFoot
          : Math.max(12, (template.size * pxPerFoot) / 2);
        if (distance <= reach) return template;
      }
      return null;
    }

    /**
     * Показывает клетку назначения и расстояние до неё.
     * @param {{col: number, row: number}} [target]
     */
    paintRoute(target) {      const geometry = this.cellGeometry();
      const cellMark = this.cellMark;
      const label = this.routeLabel;
      if (!geometry) {
        this.route = null;
        cellMark.hidden = true;
        label.hidden = true;
        return;
      }
      if (target) this.route = target;
      const route = this.route;
      const token = this.combatToken();
      if (!route || !token) {
        cellMark.hidden = true;
        label.hidden = true;
        return;
      }
      const from = this.tokenCell(token);
      const measure = this.combatMeasure(from, route);
      const toCenter = this.cellCenterInMap(route.col, route.row);

      // Клетка назначения рисуется в процентах от картинки, иначе её размер
      // уезжал бы от клетки при приближении.
      cellMark.hidden = false;
      cellMark.style.width = `${(geometry.cell / this.image.naturalWidth) * 100}%`;
      cellMark.style.height = `${(geometry.cell / this.image.naturalHeight) * 100}%`;
      cellMark.style.left = `${toCenter.x * 100}%`;
      cellMark.style.top = `${toCenter.y * 100}%`;

      // Подпись ставим между фишкой и клеткой назначения: линии больше нет,
      // и без подписи у клетки было бы не понять, сколько это шагов.
      const here = this.tokenMapPoint(token);
      label.hidden = false;
      label.textContent = this.combatDistanceText(measure);
      label.style.left = `${((here.x + toCenter.x) / 2) * 100}%`;
      label.style.top = `${((here.y + toCenter.y) / 2) * 100}%`;
    }

    /** Фишка, выбранная для хода, если её всё ещё можно двигать. */
    combatToken() {
      if (!this.combat.tokenId) return null;
      const token = (this.tokens || []).find((item) => item.id === this.combat.tokenId);
      if (!token || !this.canMove(token)) return null;
      return token;
    }

    /**
     * Ведёт фишку по клеткам до цели.
     *
     * Фишка не телепортируется: она проходит клетку за клеткой, и только
     * последняя точка уходит на сервер. Так видно, куда она шла, а стол не
     * получает сорок сообщений о движении за один ход.
     * @param {object} token
     * @param {{col: number, row: number}} target
     */
    walkTokenTo(token, target) {
      if (this.walkTimer) return;
      const from = this.tokenCell(token);
      if (!from) return;
      const measure = this.combatMeasure(from, target);
      if (!measure.steps) {
        this.route = null;
        this.paintRoute();
        return;
      }
      const node = this.tokenLayer.querySelector(`[data-token-id="${token.id}"]`);
      // Фишка идёт по тому же пути, что нарисован: сперва в центр своей клетки,
      // потом клетка за клеткой и с тем же поворотом. Прямая через угол клетки
      // выглядела бы быстрее, но вела бы мимо клеток.
      const route = [
        this.tokenMapPoint(token),
        this.cellCenterInMap(from.col, from.row),
        ...this.combatPath(from, target).map((cell) => this.cellCenterInMap(cell.col, cell.row))
      ];
      const steps = route.length - 1;
      const finish = route[route.length - 1];
      this.route = null;
      this.paintRoute();
      if (node) node.classList.add('token--walking');
      // Пока фишка идёт, слой не перерисовывается: очистка уничтожила бы её.
      this.dragState = { walk: true, tokenId: token.id, node };

      let step = 0;
      this.walkTimer = setInterval(() => {
        step += 1;
        const point = route[step];
        if (node) {
          node.style.left = `${point.x * 100}%`;
          node.style.top = `${point.y * 100}%`;
        }
        if (step < steps) return;
        clearInterval(this.walkTimer);
        this.walkTimer = null;
        this.dragState = null;
        if (node) node.classList.remove('token--walking');
        // Записываем конечную точку сразу, не дожидаясь ответа стола: иначе
        // renderTokens ниже переставил бы фишку обратно в старую клетку, и
        // маршрут до прихода снимка начинался бы не от неё.
        token.x = finish.x;
        token.y = finish.y;
        if (this.handlers.onMoveToken) {
          this.handlers.onMoveToken(token.id, Number(finish.x.toFixed(4)), Number(finish.y.toFixed(4)));
        }
        this.renderTokens();
        this.paintLight(this.mapOf(this.viewedMap));
      }, COMBAT_STEP_MS);
    }

    /** Обрывает ход и перетаскивание: окно уходит из-за стола. */
    cancelPending() {
      if (this.walkTimer) {
        clearInterval(this.walkTimer);
        this.walkTimer = null;
      }
      this.dragState = null;
      this.surfaceStroke = [];
    }

    /** Создаёт холст при первом обращении: он нужен только тому, кто рисует. */
    ensureEditor() {
      if (this.editor) return this.editor;
      this.editor = new SketchEditor(this.editorHost, {
        resolveUrl: this.resolveUrl,
        availableMaps: () => {
          const available = {};
          for (const type of DnD.MAP_TYPES) available[type] = this.mapCount(type) > 0;
          return available;
        },
        mapUrl: (type) => {
          const map = this.mapOf(type);
          return map ? this.resolveUrl(map.url) : '';
        },
        onNotice: (message) => {
          if (this.handlers.onNotice) this.handlers.onNotice(message);
        },
        onClose: () => this.closeEditor(),
        onSave: (type, file) => {
          this.closeEditor();
          if (this.handlers.onUpload) this.handlers.onUpload(type, file);
        }
      });
      return this.editor;
    }

    /**
     * Что взять подложкой: карту текущей вкладки, иначе ту, что показана
     * игрокам, иначе первую загруженную. Благодаря этому холст не открывается
     * пустым, когда карты на столе есть.
     */
    pickBackgroundType() {
      const loaded = DnD.MAP_TYPES.filter((type) => this.mapCount(type) > 0);
      if (!loaded.length) return '';
      if (this.viewedMap && this.mapCount(this.viewedMap) > 0) return this.viewedMap;
      if (this.activeMap && this.mapCount(this.activeMap) > 0) return this.activeMap;
      return loaded[0];
    }

    openEditor() {
      if (this.role !== 'dm') return;
      const editor = this.ensureEditor();
      this.editing = true;
      this.surface.hidden = true;
      this.empty.hidden = true;
      if (this.decor) this.decor.hidden = true;
      this.editorHost.hidden = false;
      this.renderToolbar();

      const backgroundType = this.pickBackgroundType();
      editor.open({
        cell: this.grid.cell,
        target: this.viewedMap || 'sketch',
        backgroundType
      });
      if (backgroundType && backgroundType !== this.viewedMap) {
        // Не оставляем загадок: если подложка взята с другой вкладки — говорим.
        if (this.handlers.onNotice) {
          this.handlers.onNotice(`Подложка взята с карты «${DnD.MAP_LABELS[backgroundType]}»`);
        }
      }
    }

    closeEditor() {
      if (!this.editing) return;
      this.editing = false;
      if (this.decor) this.decor.hidden = false;
      this.editorHost.hidden = true;
      this.renderToolbar();
      this.renderBody();
    }

    renderToolbar() {
      this.toolbar.innerHTML = '';
      const type = this.viewedMap;
      const map = this.mapOf(type);
      if (this.menusName) {
        this.menusName.textContent = map ? map.name : 'Карта не выбрана';
        this.menusName.title = map ? map.name : '';
      }

      // Во время рисования у холста своя панель инструментов.
      if (this.editing) {
        this.toolbar.hidden = true;
        this.lightPanel.hidden = true;
        return;
      }

      // Вкладка «Свет» занимает место тулбара целиком: это другой экран панели
      // карты, а не ещё одна строка кнопок в том же.
      if (this.lightTabOpen) {
        this.toolbar.hidden = true;
        this.lightPanel.hidden = false;
        this.lightPanel.innerHTML = '';
        if (this.role !== 'dm' || !map) {
          this.lightPanel.appendChild(el('div', 'box__note',
            'Вкладка света доступна мастеру и только с загруженной картой.'));
          return;
        }
        this.lightPanel.appendChild(this.buildLightControls(type, map));
        return;
      }
      this.lightPanel.hidden = true;

      if (this.role !== 'dm' && !this.training) {
        this.toolbar.hidden = true;
        return;
      }
      this.toolbar.hidden = false;
      if (this.training) {
        // В тренировочном столе ДМа нет, и часть кнопок принадлежит ему — о
        // подмене лучше сказать прямо, чем оставлять человека догадываться.
        this.toolbar.appendChild(el('span', 'map-toolbar__note', 'Проверка без сети:'));
      }

      const slot = type ? this.maps[type] : null;
      const index = map && slot ? slot.items.findIndex((item) => item.id === map.id) : -1;
      const count = this.mapCount(type);

      // Туман войны — только мастеру. Игрок получает уже открытые участки и
      // ничего не может изменить. Освещения здесь нет: оно живёт на своей
      // вкладке, а тулбар и без того тесный от загрузки карт.
      if (map && this.role === 'dm') {
        this.toolbar.appendChild(this.buildFogControls(type, map));
      }

      // Переключение между картами одной вкладки: их может быть много.
      if (count > 1) {
        const prev = el('button', 'btn btn--ghost', '◀');
        prev.type = 'button';
        prev.title = 'Предыдущая карта вкладки';
        prev.addEventListener('click', () => {
          const target = slot.items[(index - 1 + count) % count];
          if (this.handlers.onSelectMap) this.handlers.onSelectMap(this.viewedMap, target.id);
        });
        this.toolbar.appendChild(prev);

        const list = el('select', 'select map-toolbar__list');
        for (const item of slot.items) {
          // Мастеру видно, какая из карт вкладки уже стоит перед игроками,
          // а какая ещё заготовка.
          const mark = item.id === this.activeMapId ? ' · показана' : '';
          const option = el('option', null, `${item.name || 'Карта'}${mark}`);
          option.value = item.id;
          option.selected = item.id === (map && map.id);
          list.appendChild(option);
        }
        list.addEventListener('change', () => {
          if (this.handlers.onSelectMap) this.handlers.onSelectMap(this.viewedMap, list.value);
        });
        this.toolbar.appendChild(list);

        const next = el('button', 'btn btn--ghost', '▶');
        next.type = 'button';
        next.title = 'Следующая карта вкладки';
        next.addEventListener('click', () => {
          const target = slot.items[(index + 1) % count];
          if (this.handlers.onSelectMap) this.handlers.onSelectMap(this.viewedMap, target.id);
        });
        this.toolbar.appendChild(next);
      }

      const uploadLabel = el('label', 'btn btn--ghost');
      uploadLabel.appendChild(el('span', null, count ? 'Загрузить ещё карту' : 'Загрузить карту'));
      const file = el('input');
      file.type = 'file';
      file.accept = 'image/png,image/jpeg,image/webp';
      file.hidden = true;
      file.addEventListener('change', () => {
        const selected = file.files && file.files[0];
        file.value = '';
        if (selected && this.handlers.onUpload) this.handlers.onUpload(this.viewedMap, selected);
      });
      uploadLabel.appendChild(file);
      this.toolbar.appendChild(uploadLabel);

      // Рисование карты и показ её игрокам остаются делом ДМ: в тренировочном
      // столе для них нет ни инструментов, ни зрителей.
      if (this.role === 'dm') {
        const draw = el('button', 'btn btn--ghost', map ? 'Рисовать поверх карты' : 'Нарисовать карту');
        draw.type = 'button';
        draw.addEventListener('click', () => this.openEditor());
        this.toolbar.appendChild(draw);
      }

      const gridButton = el('button', `btn btn--ghost toggle${this.grid.enabled ? ' is-on' : ''}`,
        this.grid.enabled ? 'Сетка: вкл' : 'Сетка: выкл');
      gridButton.type = 'button';
      gridButton.title = `Клетка ${this.grid.cell}×${this.grid.cell} px — ровно по размеру фишки`;
      gridButton.addEventListener('click', () => {
        if (this.handlers.onToggleGrid) this.handlers.onToggleGrid(!this.grid.enabled);
      });
      this.toolbar.appendChild(gridButton);

      // Настройка сетки за столом: те же поля, что в окне настроек, но рядом
      // с картой. Кнопка-стрелка открывает меню, сама сетка включается рядом.
      if (this.role === 'dm' || this.training) {
        const gridMenuButton = el('button', 'btn btn--ghost map-grid-menu__toggle', '▾');
        gridMenuButton.type = 'button';
        gridMenuButton.title = 'Настроить сетку за столом: клетки по ширине, размер клетки и сдвиг';
        gridMenuButton.classList.toggle('is-on', Boolean(this.gridMenu && !this.gridMenu.hidden));
        gridMenuButton.addEventListener('click', (event) => {
          event.stopPropagation();
          this.toggleGridMenu();
        });
        this.gridMenuButton = gridMenuButton;
        this.toolbar.appendChild(gridMenuButton);
      } else {
        this.gridMenuButton = null;
      }

      // Режим боя: фишки ходят по клеткам, а по клетке сразу видно, сколько
      // это шагов и футов. Включает мастер, а включается он сам при броске
      // порядка боя.
      const combatButton = el('button', `btn btn--ghost toggle${this.combat.enabled ? ' is-on' : ''}`,
        this.combat.enabled ? 'Бой: вкл' : 'Бой: выкл');
      combatButton.type = 'button';
      combatButton.title = this.combat.enabled
        ? 'Бой идёт: фишка идёт по клеткам. Нажмите на клетку, чтобы отправить её туда'
        : 'Включить режим боя: ход по клеткам с подсчётом расстояния';
      if (this.role !== 'dm') combatButton.disabled = true;
      combatButton.addEventListener('click', () => {
        const next = !this.combat.enabled;
        // Включить боя без карты можно, но ходить тогда нечем: клетки
        // считаются от размера подложки. Говорим об этом сразу, а не после
        // первого нажатия на пустую карту.
        if (next && !this.cellGeometry() && this.handlers.onNotice) {
          this.handlers.onNotice('Режим боя включён, но ходить пока нечем: загрузите карту');
        }
        if (this.handlers.onSetCombatMode) this.handlers.onSetCombatMode(next);
      });
      this.toolbar.appendChild(combatButton);

      // Шаблоны заклинаний: мастер ставит, видят все. Кнопка рядом с боем,
      // потому что пользуются ими в бою.
      if (this.role === 'dm') {
        const templateButton = el('button', 'btn btn--ghost map-template__toggle', 'Шаблон');
        templateButton.type = 'button';
        templateButton.title = 'Поставить шаблон заклинания: сфера, конус или линия';
        templateButton.classList.toggle('is-on', Boolean(this.templateMenu && !this.templateMenu.hidden));
        templateButton.addEventListener('click', (event) => {
          event.stopPropagation();
          this.toggleTemplateMenu();
        });
        this.templateButton = templateButton;
        this.toolbar.appendChild(templateButton);
      } else {
        this.templateButton = null;
      }

      if (map && this.role === 'dm') {
        const shown = this.activeMap === this.viewedMap && this.activeMapId === map.id;
        const activate = el('button', 'btn btn--ghost',
          shown ? '● Показана игрокам' : 'Показать игрокам');
        activate.type = 'button';
        activate.disabled = shown;
        activate.title = shown
          ? 'Эту карту сейчас видят игроки'
          : 'Показать эту карту всем игрокам';
        activate.addEventListener('click', () => {
          if (this.handlers.onSetActive) this.handlers.onSetActive(this.viewedMap, map.id);
        });
        this.toolbar.appendChild(activate);

        const remove = el('button', 'btn btn--danger btn--ghost', 'Удалить карту');
        remove.type = 'button';
        remove.title = count > 1 ? `Останется карт во вкладке: ${count - 1}` : 'Вкладка станет пустой';
        remove.addEventListener('click', () => {
          if (this.handlers.onDelete) this.handlers.onDelete(this.viewedMap, map.id);
        });
        this.toolbar.appendChild(remove);

        this.toolbar.appendChild(el('span', 'map-toolbar__name',
          count > 1 ? `${map.name || ''} · ${index + 1} из ${count}` : (map.name || '')));
      }
    }

    renderBody() {
      if (this.editing) return;
      const type = this.viewedMap;
      const map = this.mapOf(type);

      if (!map) {
        this.surface.hidden = true;
        this.empty.hidden = false;
        this.empty.querySelector('.map-empty__text').textContent = type === 'sketch'
          ? 'Рисунок пока пуст: нажмите «Нарисовать карту» или загрузите изображение'
          : 'Карта ещё не загружена ДМ';
        this.tokenLayer.innerHTML = '';
        this.renderedTokens = null;
        this.tokenSignature = null;
        // Пустая карта: слои света и стен гасим явно, иначе они остались бы
        // висеть от прошлой карты, пока новая грузится.
        this.paintLight(null);
        this.paintFog(null);
        this.paintWallOverlay(null);
        return;
      }

      this.empty.hidden = true;
      this.surface.hidden = false;
      const src = this.resolveUrl(map.url);
      if (this.image.dataset.url !== src) {
        this.image.dataset.url = src;
        this.image.src = src;
        // Клетка считается от ширины подложки, а та станет известна только
        // после загрузки картинки — иначе сетка легла бы по старой карте.
        this.image.onload = () => {
          this.layoutSurface();
          this.applyGrid();
        };
        this.image.onerror = () => this.applyGrid();
      }
      this.layoutSurface();
      this.applyGrid();
      this.renderTokens();
      this.paintLight(map);
      this.paintFog(map);
      this.paintSurface(map);
      this.paintWallOverlay(map);
      this.paintTemplates(map);
    }

    /**
     * Подпись всего, что влияет на вид слоя фишек.
     *
     * Сравниваем не только данные фишек, но и ссылки на объекты: если сервер
     * прислал новую фишку с теми же полями, обработчики на старом узле не
     * должны остаться с устаревшим объектом.
     * @param {object[]} tokens
     * @param {string} activeMapId
     * @returns {string}
     */
    tokenSignatureFor(tokens, activeMapId) {
      const parts = [
        this.role || '',
        this.myPlayerId || '',
        this.training ? 1 : 0,
        this.viewedMap || '',
        activeMapId,
        this.combat.enabled ? 1 : 0,
        this.combat.tokenId || ''
      ];
      for (const token of tokens) {
        parts.push(
          token.id,
          token.x,
          token.y,
          token.name || '',
          token.nameHidden ? 1 : 0,
          token.hideLabels ? 1 : 0,
          token.imageUrl || '',
          token.color || '',
          token.size || 1,
          token.maxHp || 0,
          token.hp === undefined ? '' : token.hp,
          token.assignedPlayerId || '',
          token.hidden ? 1 : 0,
          (token.conditions || []).join(','),
          token.conditionDurations ? JSON.stringify(token.conditionDurations) : ''
        );
      }
      for (const player of this.players) parts.push(player.playerId, player.name || '');
      return JSON.stringify(parts);
    }

    renderTokens() {
      // Во время перетаскивания фишки слой не трогаем: иначе очистка снесла бы
      // ту самую фишку, которую сейчас тащат.
      //
      // Ход по клеткам тоже двигает узел напрямую, и перерисовка посреди хода
      // отвязала бы его от таймера: фишка замерла бы на месте, пока идёт анимация.
      if (this.dragState) {
        if (!this.dragState.walk) return;
        if (this.walkTimer) return;
        // Таймер уже погас, а состояние осталось: иначе слой застыл бы навсегда.
        this.dragState = null;
      }
      const type = this.viewedMap;
      const activeMapId = (this.mapOf(type) || {}).id || '';
      // Показываем фишки той карты, что открыта. Фишка без mapId — из кампании,
      // заведённой до появления этого поля, и видна на любой карте вкладки,
      // как было раньше.
      //
      // Скрытые заготовки мастера игроку не рисуются. Сервер их и не шлёт,
      // но фильтр здесь тоже нужен: иначе одна ошибка на сервере — и монстр,
      // которого мастер готовил тайно, окажется у игроков на карте.
      const tokens = this.tokens.filter((token) => {
        if (token.hidden && this.role !== 'dm') return false;
        return token.mapType === type && (!token.mapId || !activeMapId || token.mapId === activeMapId);
      });
      // Пересборка слоя сбрасывает выделение и заново вешает обработчики на
      // каждую фишку. Если с прошлого раза не изменилось ни одного видимого
      // поля, достаточно перерисовать маршрут.
      const sameObjects = this.renderedTokens
        && this.renderedTokens.length === tokens.length
        && tokens.every((token, index) => token === this.renderedTokens[index]);
      const signature = this.tokenSignatureFor(tokens, activeMapId);
      if (sameObjects && signature === this.tokenSignature) {
        this.paintRoute();
        return;
      }
      this.renderedTokens = tokens.slice();
      this.tokenSignature = signature;
      // Собираем слой одной вставкой: appendChild в цикле заставляет браузер
      // пересчитывать раскладку после каждой фишки, а на большой карте их
      // бывает несколько десятков.
      const fragment = document.createDocumentFragment();
      for (const token of tokens) {
        const node = this.buildToken(token);
        if (token.id === this.combat.tokenId) node.classList.add('token--combat');
        fragment.appendChild(node);
      }
      this.tokenLayer.replaceChildren(fragment);
      // Выбранная фишка могла исчезнуть: её удалили, скрыли или перевели на
      // другую карту. Тогда маршрут был бы от фишки, которой на карте нет.
      if (this.combat.tokenId && !tokens.some((token) => token.id === this.combat.tokenId)) {
        this.selectCombatToken(null);
      }
      this.paintRoute();
    }

    canMove(token) {
      if (this.role === 'dm') return true;
      if (!token.assignedPlayerId || token.assignedPlayerId !== this.myPlayerId) return false;
      // Состояние, отнимающее скорость, запрещает игроку переставить фишку самому.
      // Мастеру движение остаётся всегда: он водит фишки руками в любом случае.
      return !DnD.conditionBlocksMove(token.conditions);
    }

    /**
     * Состояние, из-за которого игрок не двигает фишку. Нужно и для подсказки,
     * и для класса: запрет должен быть виден на карте, а не выясняться попыткой.
     * @param {object} token
     * @returns {object|null}
     */
    moveBlocker(token) {
      return DnD.conditionBlocksMove(token && token.conditions);
    }

    buildToken(token) {
      const node = el('div', 'token');
      const movable = this.canMove(token);
      node.classList.toggle('token--movable', movable);
      node.classList.toggle('token--mine', Boolean(token.assignedPlayerId) && token.assignedPlayerId === this.myPlayerId);
      // Скрытая фишка видна мастеру полупрозрачной с пунктиром: иначе он
      // забудет, что она заготовка, и начнёт бой с монстрами, которых никто
      // из игроков не видит.
      node.classList.toggle('token--hidden', Boolean(token.hidden));
      node.classList.toggle('token--bound', !movable && this.role !== 'dm' && Boolean(this.moveBlocker(token)));
      node.dataset.tokenId = token.id;
      node.style.left = `${token.x * 100}%`;
      node.style.top = `${token.y * 100}%`;
      // Размер в клетках. Якорь остаётся центром, поэтому фишка растёт от
      // центра и закрывает соседние клетки с обеих сторон.
      node.style.setProperty('--token-size', String(DnD.clampNumber(token.size, 1, 4, 1)));

      // Прочность видна прямо на поле, а не только в списке фишек: за боком
      // мастер смотрит на карту, а не в правую колонку.
      if (token.maxHp) {
        const hp = Math.max(0, Math.min(Number(token.maxHp), Number(token.hp)));
        const hpNode = el('div', 'token__hp');
        const track = el('div', 'token__hp-track');
        const fill = el('div', 'token__hp-fill');
        fill.style.width = `${Math.round((hp / Number(token.maxHp)) * 100)}%`;
        if (hp === 0) node.classList.add('token--down');
        else if (hp * 2 <= Number(token.maxHp)) node.classList.add('token--hurt');
        track.appendChild(fill);
        hpNode.appendChild(track);
        hpNode.appendChild(el('span', 'token__hp-value', `${hp}/${token.maxHp}`));
        node.appendChild(hpNode);
      }

      // Кружок лежит в своей обёртке: рисунки состояний должны сидеть ровно по его
      // краям, а фишка растёт вниз подписями и прочностью, и «низ фишки» от
      // кружка каждый раз был бы разным.
      const body = el('div', 'token__body');
      const circle = el('div', 'token__circle');
      if (token.imageUrl) {
        circle.style.backgroundImage = `url("${this.resolveUrl(token.imageUrl)}")`;
        circle.classList.add('token__circle--image');
      } else {
        circle.style.setProperty('--token-color', token.color || '#c96f4a');
        // У фишки со скрытым именем сервер присылает пустую строку, а не флаг
        // «не рисуй»: иначе имя осталось бы в снимке состояния. Буква отсюда
        // тоже браться не может, поэтому вместо неё вопросительный знак.
        circle.appendChild(el('span', 'token__initial', token.nameHidden ? '?' : initials(token.name)));
      }
      body.appendChild(circle);
      node.appendChild(body);

      // Подписи лежат отдельным слоем и не участвуют в разметке фишки.
      //
      // Якорь фишки (token.x, token.y) обязан совпадать с центром кружка:
      // по нему считается клетка фишки, начало маршрута хода и место удара
      // мышью. Если подписи стоят в потоке, колонка растягивается, и якорь
      // уезжает от кружка — тогда линия маршрута начинается выше фишки, а
      // сама фишка встаёт не на ту клетку, куда её поставили.
      const info = el('div', 'token__info');

      if (!token.nameHidden && !token.hideLabels) {
        const label = el('div', 'token__label', token.name);
        info.appendChild(label);
      }

      // Состояния под фишкой видны всем: по ним и ориентируются, кого бить
      // можно, а кого нельзя.
      const conditions = Array.isArray(token.conditions) ? token.conditions : [];
      const durations = token.conditionDurations && typeof token.conditionDurations === 'object'
        ? token.conditionDurations
        : {};
      const conditionText = (id) => {
        const item = DnD.CONDITIONS.find((entry) => entry.id === id);
        const label = (item && item.label) || id;
        const rounds = Number(durations[id]) || 0;
        return rounds > 0 ? `${label}, ${rounds} р.` : label;
      };
      if (conditions.length && !token.hideLabels) {
        const badges = el('div', 'token__conditions');
        for (const id of conditions) {
          const item = DnD.CONDITIONS.find((entry) => entry.id === id);
          if (!item) continue;
          const rounds = Number(durations[id]) || 0;
          badges.appendChild(el('span', 'token__condition', rounds > 0 ? `${item.short} ${rounds}` : item.short));
        }
        badges.title = conditions.map(conditionText).join(', ');
        info.appendChild(badges);
      }
      // Рисунок состояния рисуется независимо от подписей: лоза под фишкой и
      // скрытая подпись — разные вещи, и состояние не должно пропадать вместе
      // с именем.
      const effects = DnD.conditionEffects(conditions);
      if (effects.length) {
        node.classList.add('token--conditioned');
        // Класс по самому состоянию, а не по рисунку: несколько состояний
        // делят один рисунок, но двигают и дрожат фишку по-разному.
        for (const id of conditions) {
          node.classList.add(`token--cond-${id}`);
        }
        for (const effect of effects) {
          body.appendChild(el('div', `token__fx token__fx--${effect}`));
        }
        node.title = conditions.map(conditionText).join(', ');
      }
      // Невидимую фишку видно только мастеру и полупрозрачно: так её не спутать
      // со снятой картинкой.
      if (conditions.includes('invisible')) node.classList.add('token--invisible');

      if (token.assignedPlayerId) {
        const owner = this.players.find((player) => player.playerId === token.assignedPlayerId);
        // Имя владельца — тоже имя, и скрытие подписи без скрытия подписи
        // хозяина оставило бы мастеру подсказку там, где он просил убрать всё.
        if (owner && !token.nameHidden && !token.hideLabels) {
          info.appendChild(el('div', 'token__owner', owner.name));
        }
      }
      if (info.childNodes.length) node.appendChild(info);

      node.addEventListener('contextmenu', (event) => {
        if (this.role !== 'dm') return;
        event.preventDefault();
        this.showTokenMenu(token, event.clientX, event.clientY);
      });

      // Двойной клик переименовывает: правый клик работает, но догадаться о нём
      // трудно, а переименовывать приходится часто.
      node.addEventListener('dblclick', (event) => {
        if (this.role !== 'dm') return;
        event.preventDefault();
        event.stopPropagation();
        if (this.handlers.onRenameToken) this.handlers.onRenameToken(token);
      });

      if (movable) {
        if (this.combat.enabled) {
          // В бою фишку не таскают: нажатие выбирает её, а ход идёт по клеткам.
          node.classList.add('token--selectable');
          node.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const next = this.combat.tokenId === token.id ? null : token.id;
            this.selectCombatToken(next);
          });
        } else {
          node.addEventListener('pointerdown', (event) => {
        // Пока включена линейка, фишка не хватает фишку за клик: он мерит.
        if (this.measureMode) return;
        this.startDrag(event, token);
      });
        }
      } else if (this.role !== 'dm') {
        node.addEventListener('click', () => {
          const blocker = this.moveBlocker(token);
          if (blocker) {
            // Отказ объясняем словами состояния: иначе фишка просто не едет,
            // и игрок решит, что карта сломалась.
            if (this.handlers.onNotice) {
              this.handlers.onNotice(`Фишка «${blocker.label.toLowerCase()}»: сними состояние, и снова можно будет двигать`);
            }
            return;
          }
          if (this.handlers.onNotice) this.handlers.onNotice('Эта фишка назначена другому игроку');
        });
      }
      return node;
    }

    showTokenMenu(token, clientX, clientY) {
      placeTokenMenu(
        buildTokenMenu(token, this.players, this.handlers, () => this.closeMenu(), {
          activeMap: this.activeMap,
          activeMapId: this.activeMapId,
          canTransfer: this.role === 'dm'
        }),
        clientX,
        clientY,
        this
      );
    }

    closeMenu() {
      if (this.closeMenuHandler) {
        document.removeEventListener('pointerdown', this.closeMenuHandler, true);
        this.closeMenuHandler = null;
      }
      if (this.escapeHandler) {
        document.removeEventListener('keydown', this.escapeHandler);
        this.escapeHandler = null;
      }
      if (this.openMenu && this.openMenu.parentNode) this.openMenu.parentNode.removeChild(this.openMenu);
      this.openMenu = null;
    }

    startDrag(event, token) {
      event.preventDefault();
      // Повторная проверка на самом перетаскивании: между отрисовкой фишки и
      // кликом мастер мог повесить состояние, и сервер всё равно откажет.
      if (!this.canMove(token)) {
        const blocker = this.moveBlocker(token);
        if (blocker && this.handlers.onNotice) {
          this.handlers.onNotice(`Фишка «${blocker.label.toLowerCase()}»: сними состояние, и снова можно будет двигать`);
        }
        return;
      }
      const rect = this.surface.getBoundingClientRect();
      const node = event.currentTarget;
      node.classList.add('token--dragging');
      this.dragState = { tokenId: token.id, node, rect };
      // Слушатели вешаем и на фишку, и на окно. Захват указателя может не
      // сработать, и тогда отпускание кнопки фишке не дойдёт: перетаскивание
      // останется незаконченным, слой перестанет перерисовываться, а режим боя
      // вместе с ним перестанет брать фишки.
      const target = node;
      const onMove = (moveEvent) => this.onDragMove(moveEvent);
      const onUp = (upEvent) => {
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        this.finishDrag(upEvent);
      };
      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      try {
        node.setPointerCapture(event.pointerId);
      } catch {
        // Захват недоступен — обойдёмся слушателями на окне, они уже навешаны.
      }
    }

    onDragMove(event) {
      if (!this.dragState) return;
      const rect = this.surface.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
      this.dragState.x = x;
      this.dragState.y = y;
      this.dragState.node.style.left = `${x * 100}%`;
      this.dragState.node.style.top = `${y * 100}%`;

      const now = Date.now();
      if (now - this.lastEmit > 80) {
        this.lastEmit = now;
        this.emitMove(x, y, false);
      }
    }

    emitMove(x, y, force) {
      if (!this.dragState) return;
      if (this.handlers.onMoveToken) {
        this.handlers.onMoveToken(this.dragState.tokenId, Number(x.toFixed(4)), Number(y.toFixed(4)));
      }
      if (force) this.lastEmit = Date.now();
    }

    finishDrag() {
      if (!this.dragState) return;
      const { tokenId, x, y, node } = this.dragState;
      node.classList.remove('token--dragging');
      this.dragState = null;
      // Свет едет вместе с фишкой: пятно от факела должно подъехать к новому
      // месту, а не остаться там, откуда фишку увели.
      const token = this.tokens.find((item) => item.id === tokenId);
      if (token && typeof x === 'number' && typeof y === 'number') {
        token.x = x;
        token.y = y;
        this.paintLight(this.mapOf(this.viewedMap));
      }
      if (typeof x === 'number' && typeof y === 'number' && this.handlers.onMoveToken) {
        this.handlers.onMoveToken(tokenId, Number(x.toFixed(4)), Number(y.toFixed(4)));
      }
      this.renderTokens();
    }

    /** Точечное обновление позиции фишки без полной перерисовки. */
    applyTokenMove(tokenId, x, y) {
      const token = this.tokens.find((item) => item.id === tokenId);
      if (token) {
        token.x = x;
        token.y = y;
        // Пока фишку тянут, пятно света обязано ехать вместе с ней: иначе
        // мастер водит факел в темноте и ничего не видит.
        if (token.light && token.light.radius > 0) {
          this.paintLight(this.mapOf(this.viewedMap));
        }
      }
      const node = this.tokenLayer.querySelector(`[data-token-id="${tokenId}"]`);
      if (node) {
        node.style.left = `${x * 100}%`;
        node.style.top = `${y * 100}%`;
      }
    }
  }

  /* ====================================================================== *
   * Список игроков
   * ====================================================================== */

  class PlayersList {
    /**
     * @param {HTMLElement} root
     * @param {{onOpenSheet?: Function, onSpawnToken?: Function, resolveUrl?: Function, onNotice?: Function}} handlers
     */
    constructor(root, handlers = {}) {
      this.root = root;
      this.handlers = handlers;
      this.role = 'player';
      // Портрет мастера живёт над списком и перерисовывается вместе с ним:
      // отдельно он жил во вкладке листа, а лист у мастера — только чужой.
      this.selfNode = el('div', 'players-self');
      this.selfNode.hidden = true;
      root.appendChild(this.selfNode);
      this.listNode = el('div', 'players');
      root.appendChild(this.listNode);
    }

    /**
     * Блок «Ваш портрет» над списком участников.
     *
     * У мастера нет листа персонажа, а портрет нужен: он стоит рядом с его
     * именем в списке и у его бросков в чате. Раньше блок жил во вкладке
     * листов, но лист открывают чужие игроки, а свой портрет мастер туда не
     * вносит, и вкладка в этом не участвует.
     * @param {{avatarUrl: string|null, name: string}} own
     */
    renderSelfAvatar(own) {
      const self = own || {};
      const show = this.role === 'dm' && Boolean(this.handlers.onAvatarPick);
      this.selfNode.hidden = !show;
      if (!show) return;
      this.selfNode.innerHTML = '';
      this.selfNode.appendChild(el('div', 'players-self__title', 'Ваш портрет'));

      const row = el('div', 'avatar-pick');
      const preview = avatarNode(this.handlers.resolveUrl
        ? this.handlers.resolveUrl(self.avatarUrl)
        : self.avatarUrl, self.name || '');
      preview.classList.add('avatar-pick__preview');
      row.appendChild(preview);

      const side = el('div', 'avatar-pick__side');
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/webp';
      input.className = 'avatar-pick__file';
      input.hidden = true;
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        input.value = '';
        if (file && this.handlers.onAvatarPick) this.handlers.onAvatarPick(file);
      });
      side.appendChild(input);
      const pick = el('button', 'btn btn--tiny', self.avatarUrl ? 'Заменить' : 'Поставить портрет');
      pick.type = 'button';
      pick.addEventListener('click', () => input.click());
      side.appendChild(pick);
      if (self.avatarUrl && this.handlers.onAvatarClear) {
        const clear = el('button', 'btn btn--ghost btn--tiny', 'Убрать');
        clear.type = 'button';
        clear.addEventListener('click', () => this.handlers.onAvatarClear());
        side.appendChild(clear);
      }
      row.appendChild(side);
      this.selfNode.appendChild(row);
      this.selfNode.appendChild(el('div', 'muted',
        'Виден игрокам в списке участников и рядом с вашими бросками в чате.'));
    }

    render(players, ctx) {
      this.role = ctx.role;
      this.listNode.innerHTML = '';
      if (!players.length) {
        this.listNode.appendChild(el('div', 'muted', 'Пока никого нет'));
        return;
      }
      const resolve = this.handlers.resolveUrl || ((url) => url || '');
      for (const player of players) {
        const row = el('div', 'player-row');
        row.classList.toggle('is-offline', !player.online);

        const avatar = avatarNode(resolve(player.avatar), player.name);
        if (player.role === 'dm') avatar.classList.add('player-row__avatar--dm');
        row.appendChild(avatar);

        const main = el('div', 'player-row__main');
        const nameRow = el('div', 'player-row__name');
        nameRow.appendChild(el('span', null, player.name));
        nameRow.appendChild(el('span',
          `badge ${player.role === 'dm' ? 'badge--dm' : 'badge--player'}`,
          player.role === 'dm' ? 'ДМ' : 'игрок'));
        if (player.playerId === ctx.playerId) nameRow.appendChild(el('span', 'badge badge--me', 'это вы'));
        main.appendChild(nameRow);

        const meta = el('div', 'player-row__meta');
        meta.appendChild(el('span', `dot ${player.online ? 'dot--on' : 'dot--off'}`));
        meta.appendChild(el('span', null, player.online ? 'в сети' : 'не в сети'));
        if (player.tokenId) meta.appendChild(el('span', 'muted', '· фишка на поле'));
        else if (player.hasSheet) meta.appendChild(el('span', 'muted', '· лист есть'));
        main.appendChild(meta);
        row.appendChild(main);

        // Своё имя меняется кнопкой в своей же строке: «Мастер» в списке
        // видно сразу, а лезть в настройки ради одного слова не нужно.
        if (player.playerId === ctx.playerId && this.handlers.onRenameSelf) {
          const selfActions = el('div', 'player-row__actions');
          const rename = el('button', 'btn btn--tiny btn--ghost', 'Имя');
          rename.type = 'button';
          rename.title = 'Изменить своё имя у стола';
          rename.addEventListener('click', () => this.handlers.onRenameSelf(player));
          selfActions.appendChild(rename);
          row.appendChild(selfActions);
        }

        if (this.role === 'dm' && player.role !== 'dm') {
          // Кнопки собраны в группу: переноситься на другую строку они должны
          // вместе, иначе одна остаётся внизу, а вторая жмётся в угол.
          const actions = el('div', 'player-row__actions');
          // Открыть лист — действие почаще, поэтому кнопка первая. Иначе её
          // находили бы только по тексту: «Вывести» стояла бы впереди и
          // перехватывала бы клик по первой кнопке в строке.
          const open = el('button', 'btn btn--tiny', 'Открыть лист');
          open.type = 'button';
          open.addEventListener('click', () => {
            if (this.handlers.onOpenSheet) this.handlers.onOpenSheet(player.playerId);
          });
          actions.appendChild(open);
          // Вывести фишку из листа можно один раз: пока у игрока её нет,
          // кнопка стоит, а после появления фишки исчезает.
          if (!player.tokenId) {
            const spawn = el('button', 'btn btn--tiny', 'Вывести');
            spawn.type = 'button';
            spawn.title = 'Создать фишку игрока из его листа, с аватаром';
            spawn.addEventListener('click', () => {
              if (this.handlers.onSpawnToken) this.handlers.onSpawnToken(player.playerId);
            });
            actions.appendChild(spawn);
          }
          // Заметка мастера: игроки её не видят и не должны даже знать, что она
          // есть. Пометка на кнопке показывает, что заметка не пустая, иначе
          // мастер забыл бы про неё к следующей сессии.
          const note = el('button', 'btn btn--tiny btn--ghost', 'Заметка');
          note.type = 'button';
          note.classList.toggle('has-note', Boolean(player.dmNote));
          note.title = player.dmNote
            ? `Заметка мастера: ${player.dmNote}`
            : 'Заметка для себя об этом игроке';
          note.addEventListener('click', () => this.openNote(player));
          actions.appendChild(note);
          row.appendChild(actions);
        }
        if (ctx.role === 'dm' && player.role !== 'dm' && player.dmNote) {
          const noteLine = el('div', 'player-row__note', player.dmNote);
          row.appendChild(noteLine);
        }
        this.listNode.appendChild(row);
      }
    }

    /**
     * Заметка мастера об игроке.
     *
     * Отдельная форма поверх списка, а не поле в строке: строка и так тесная, а
     * поле в ней прыгало бы при каждой рассылке списка участников.
     * @param {object} player
     */
    openNote(player) {
      this.closeNote();
      const form = el('form', 'dm-note');
      const head = el('div', 'dm-note__head');
      head.appendChild(el('span', 'dm-note__title', `Заметка об ${player.name}`));
      const close = el('button', 'btn btn--ghost btn--tiny', 'Закрыть');
      close.type = 'button';
      close.addEventListener('click', () => this.closeNote());
      head.appendChild(close);
      form.appendChild(head);

      const area = el('textarea', 'dm-note__area');
      area.value = player.dmNote || '';
      area.maxLength = DnD.LIMITS.maxDmNote;
      area.placeholder = 'Что игрок на самом деле скрывает. Игроки этого не видят.';
      form.appendChild(area);

      const actions = el('div', 'dm-note__actions');
      const save = el('button', 'btn btn--accent btn--tiny', 'Сохранить');
      save.type = 'submit';
      actions.appendChild(save);
      form.appendChild(actions);

      let timer = null;
      // Отправляем на лету: заметка мастера это то, о чём вспоминают через
      // десять минут, и терять её из-за того, что не нажали «Сохранить», нельзя.
      form.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (this.handlers.onSetDmNote) this.handlers.onSetDmNote(player.playerId, area.value);
        }, 400);
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        clearTimeout(timer);
        if (this.handlers.onSetDmNote) this.handlers.onSetDmNote(player.playerId, area.value);
        this.closeNote();
      });

      this.noteForm = form;
      this.root.appendChild(form);
      area.focus();
    }

    /** Убирает форму заметки, если она открыта. */
    closeNote() {
      if (this.noteForm) this.noteForm.remove();
      this.noteForm = null;
    }
  }

  /* ====================================================================== *
   * Чат
   * ====================================================================== */

  class ChatPanel {
    /**
     * @param {HTMLElement} root
     * @param {{onSend?: Function, resolveUrl?: Function}} [handlers]
     */
    constructor(root, handlers = {}) {
      this.root = root;
      this.handlers = handlers;
      this.build();
    }

    build() {
      this.root.appendChild(el('div', 'panel__title', 'Чат стола'));

      // Поиск по ленте. За столом правило всплывает спустя час, а найти его в
      // истории можно только прокруткой. Ищем по видимому тексту сообщения и
      // по имени автора: «что говорил Мастер про ловушки» начинается с имени.
      const search = el('div', 'chat__search');
      const searchInput = el('input', 'input chat__search-input');
      searchInput.type = 'search';
      searchInput.placeholder = 'Поиск по чату';
      searchInput.maxLength = DnD.LIMITS.maxChatLength;
      searchInput.autocomplete = 'off';
      this.searchInput = searchInput;
      search.appendChild(searchInput);
      const counter = el('span', 'chat__search-count', '');
      this.searchCounter = counter;
      search.appendChild(counter);
      const clear = el('button', 'btn btn--ghost btn--tiny', '✕');
      clear.type = 'button';
      clear.title = 'Сбросить поиск';
      clear.hidden = true;
      clear.addEventListener('click', () => this.setQuery(''));
      this.searchClear = clear;
      search.appendChild(clear);
      this.root.appendChild(search);

      const log = el('div', 'chat__log');
      this.log = log;
      this.root.appendChild(log);

      const form = el('form', 'chat__form');
      const input = el('input', 'input');
      input.type = 'text';
      input.placeholder = 'Сообщение…';
      input.maxLength = DnD.LIMITS.maxChatLength;
      this.input = input;
      form.appendChild(input);

      // Хендаут картинкой: мастер показывает письмо, портрет или обрывок
      // карты. Игроку кнопка не нужна, поэтому её видимость решает коннектор.
      const attach = el('button', 'btn btn--ghost btn--tiny chat__attach', '📎');
      attach.type = 'button';
      attach.title = 'Прикрепить изображение';
      attach.setAttribute('aria-label', 'Прикрепить изображение');
      attach.hidden = true;
      this.attachButton = attach;
      form.appendChild(attach);

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/png,image/jpeg,image/webp';
      fileInput.hidden = true;
      // input.value хранит подпись, и после успешной отправки её нужно очистить.
      fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];
        const caption = input.value.trim();
        fileInput.value = '';
        if (!file || !this.handlers.onImage) return;
        const sent = this.handlers.onImage(file, caption);
        Promise.resolve(sent).then((ok) => {
          if (ok && input.value.trim() === caption) input.value = '';
        });
      });
      attach.addEventListener('click', () => fileInput.click());
      form.appendChild(fileInput);

      // Шёпот мастеру: одноразовый режим, после отправки выключается сам.
      // Скрыт у мастера и в тренировочном столе, где ведущего нет.
      const whisper = el('button', 'btn btn--ghost btn--tiny chat__whisper', 'Шёпот');
      whisper.type = 'button';
      whisper.title = 'Шёпот мастеру: сообщение увидит только ведущий';
      whisper.setAttribute('aria-pressed', 'false');
      whisper.addEventListener('click', () => this.setWhisper(!this.whisper));
      this.whisperButton = whisper;
      this.whisper = false;
      form.appendChild(whisper);

      const send = el('button', 'btn btn--accent', 'Отправить');
      send.type = 'submit';
      form.appendChild(send);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        if (this.handlers.onSend) this.handlers.onSend(text, this.whisper);
        input.value = '';
        this.setWhisper(false);
      });
      this.root.appendChild(form);

      // Поиск живёт только пока открыт чат: иначе он просит символы в фоне.
      let searchTimer = null;
      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        // Каждое нажатие перебирает всю ленту, а она бывает на триста сообщений.
        // Ждём паузу, чтобы не дёргать перерисовку на каждой букве.
        searchTimer = setTimeout(() => this.setQuery(searchInput.value), 120);
      });
      searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && searchInput.value) {
          event.preventDefault();
          this.setQuery('');
          searchInput.value = '';
        }
      });
    }

    /**
     * Подсвечивает в ленте сообщения, где встречается запрос.
     *
     * Не скрываем остальные: правило почти всегда находят в контексте разговора,
     * и пустая лента из двух строк ничего не объясняет. Счётчик показывает,
     * сколько найдено, чтобы было видно, что запрос сработал.
     * @param {string} value
     */
    setQuery(value) {
      const query = String(value || '').trim().toLowerCase();
      this.query = query;
      const rows = [...this.log.querySelectorAll('.chat__msg')];
      let found = 0;
      for (const row of rows) {
        // Текст сообщения лежит в последнем узле строки, автор — в шапке.
        // Смотрим всю строку целиком: поиск по имени автора и по слову внутри
        // сообщения должен находиться одинаково.
        const haystack = row.textContent.toLowerCase();
        const hit = Boolean(query) && haystack.includes(query);
        row.classList.toggle('is-hit', hit);
        row.classList.toggle('is-miss', Boolean(query) && !hit);
        if (hit) found += 1;
      }
      if (this.searchCounter) {
        this.searchCounter.textContent = query ? `${found} найдено` : '';
      }
      if (this.searchClear) this.searchClear.hidden = !query;
      // Контроллер держит запрос: снимок стола может прийти в любой момент, и
      // подсветка должна восстановиться вместе с лентой.
      if (this.handlers.onQuery) this.handlers.onQuery(query);
    }

    /** @param {boolean} on */
    setWhisper(on) {
      this.whisper = Boolean(on);
      if (!this.whisperButton) return;
      this.whisperButton.classList.toggle('btn--accent', this.whisper);
      this.whisperButton.setAttribute('aria-pressed', String(this.whisper));
      this.whisperButton.textContent = this.whisper ? 'Шёпот: вкл' : 'Шёпот';
    }

    /**
     * @param {object[]} history
     * @param {string} [query] Запрос поиска: снимок стола приходит вместе с
     *   историей, и иначе подсветка молча пропала бы после переподключения.
     */
    renderAll(history, query) {
      if (this.whisperButton) {
        const allowed = !this.handlers.canWhisper || this.handlers.canWhisper();
        this.whisperButton.hidden = !allowed;
        if (!allowed) this.setWhisper(false);
      }
      if (this.attachButton) {
        this.attachButton.hidden = !(this.handlers.canAttach && this.handlers.canAttach());
      }
      // Собираем ленту в фрагмент и вставляем один раз: appendChild в цикле
      // заставляет браузер пересчитывать раскладку на каждую строку. Заодно
      // не гоняем поиск по всей ленте после каждого сообщения.
      const fragment = document.createDocumentFragment();
      for (const message of history) this.append(message, false, fragment);
      this.log.replaceChildren(fragment);
      while (this.log.childElementCount > 300) this.log.removeChild(this.log.firstChild);
      if (this.searchInput && query !== undefined) this.searchInput.value = query;
      this.setQuery(query !== undefined ? query : (this.searchInput ? this.searchInput.value : ''));
      this.scrollToEnd();
    }

    /**
     * @param {object} message
     * @param {boolean} [scroll] прокрутить ленту к новому сообщению
     * @param {Node} [parent] куда вставлять строку; при перерисовке это
     *   фрагмент, а не живая лента
     */
    append(message, scroll = true, parent = this.log) {
      const row = el('div', 'chat__msg');
      if (message.role === 'dm') row.classList.add('chat__msg--dm');
      if (message.isRoll) row.classList.add('chat__msg--roll');
      if (message.whisper) row.classList.add('chat__msg--whisper');
      // Служебные объявления стола, например о режиме боя: их пишет сервер, а
      // не человек, и подпись автора у них лишняя.
      if (message.system) {
        const system = el('div', 'chat__msg chat__msg--system');
        system.appendChild(el('div', 'chat__system', message.text));
        parent.appendChild(system);
        if (parent === this.log && scroll) this.scrollToEnd();
        return;
      }
      if (message.role === 'dm') row.classList.add('chat__msg--dm');
      if (message.isRoll) row.classList.add('chat__msg--roll');
      const resolve = this.handlers.resolveUrl || ((url) => url || '');
      const head = el('div', 'chat__head');
      // Портрет только у бросков: он отвечает на «кто именно бросил», а у
      // обычной реплики автор и так виден по имени.
      if (message.isRoll && message.avatar) {
        head.appendChild(avatarNode(resolve(message.avatar), message.from, 'chat__avatar'));
      }
      head.appendChild(el('span', 'chat__author', message.from));
      if (message.role === 'dm') head.appendChild(el('span', 'badge badge--dm', 'ДМ'));
      if (message.isRoll) head.appendChild(el('span', 'badge badge--roll', 'бросок'));
      if (message.whisper) head.appendChild(el('span', 'badge badge--whisper', 'мастеру'));
      head.appendChild(el('span', 'chat__time', formatTime(message.time)));
      row.appendChild(head);
      if (message.image) {
        const src = resolve(message.image);
        const open = el('button', 'chat__image-button');
        open.type = 'button';
        open.title = 'Открыть изображение';
        const picture = el('img', 'chat__image');
        picture.src = src;
        picture.alt = message.text || 'Изображение';
        picture.loading = 'lazy';
        open.appendChild(picture);
        open.addEventListener('click', () => this.openImage(src, message.text || 'Изображение'));
        row.appendChild(open);
      }
      if (message.text) {
        row.appendChild(el('div', 'chat__text', message.isRoll ? `🎲 ${message.text}` : message.text));
      }
      parent.appendChild(row);
      if (parent !== this.log) return;
      if (this.log.childElementCount > 300) this.log.removeChild(this.log.firstChild);
      // Новое сообщение должно попасть под текущий запрос: чат идёт во время
      // поиска, и иначе находка молча переставала бы совпадать с лентой.
      if (this.query) this.setQuery(this.query);
      if (scroll) this.scrollToEnd();
    }

    /** Показывает хендаут целиком, не уводя со стола. */
    openImage(url, caption) {
      const overlay = el('div', 'chat-lightbox');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      const box = el('div', 'chat-lightbox__box');
      const picture = el('img', 'chat-lightbox__image');
      picture.src = url;
      picture.alt = caption || 'Изображение';
      const close = el('button', 'chat-lightbox__close', '✕');
      close.type = 'button';
      close.title = 'Закрыть';
      close.setAttribute('aria-label', 'Закрыть изображение');
      const closeLightbox = () => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
      };
      const onKey = (event) => {
        if (event.key === 'Escape') closeLightbox();
      };
      close.addEventListener('click', closeLightbox);
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closeLightbox();
      });
      document.addEventListener('keydown', onKey);
      box.appendChild(picture);
      if (caption) box.appendChild(el('div', 'chat-lightbox__caption', caption));
      box.appendChild(close);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      close.focus();
    }

    scrollToEnd() {
      this.log.scrollTop = this.log.scrollHeight;
    }
  }

  /* ====================================================================== *
   * Кубики
   * ====================================================================== */

  class DicePanel {
    constructor(root, handlers = {}) {
      this.root = root;
      this.handlers = handlers;
      this.rolling = false;
      this.pendingResult = null;
      this.rollTimer = null;
      this.rollWatchdog = null;
      this.rollStartedAt = 0;
      // Минимум, на который плашка задерживает результат: иначе ответ сервера
      // приходит раньше, чем глаз успевает заметить бросок.
      this.minRollMs = 560;
      this.build();
    }

    build() {
      this.root.appendChild(el('div', 'panel__title', 'Бросок кубика'));

      // Быстрые кости: бросить одну кость в один клик. Список тот же, что
      // у DnD.DICE_SIDES: костей на три или семь граней в игре нет.
      const quick = el('div', 'dice__quick');
      for (const sides of DnD.DICE_SIDES) {
        const quickButton = el('button', 'btn dice__quick-btn', `d${sides}`);
        quickButton.type = 'button';
        quickButton.title = `Бросить d${sides}`;
        quickButton.addEventListener('click', () => this.roll(`d${sides}`));
        quick.appendChild(quickButton);
      }
      this.root.appendChild(quick);

      const controls = el('div', 'dice__controls');
      const input = el('input', 'input dice__formula');
      input.type = 'text';
      input.placeholder = '2d6+3';
      input.maxLength = 40;
      // Формула набирается с клавиатуры: пока жмится «Enter», поле должно
      // оставаться в форме, а не отправлять страницу.
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.rollFromInput();
        }
      });
      this.input = input;
      controls.appendChild(input);

      const roll = el('button', 'btn btn--accent', 'Бросить');
      roll.type = 'button';
      roll.addEventListener('click', () => this.rollFromInput());
      controls.appendChild(roll);
      this.root.appendChild(controls);

      // Переброс: тот же бросок ещё раз. Кнопка появляется после первого
      // броска этой панелью и повторяет последнюю отправленную формулу.
      const reroll = el('button', 'btn btn--ghost dice__reroll', 'Перебросить');
      reroll.type = 'button';
      reroll.hidden = true;
      reroll.addEventListener('click', () => {
        if (this.lastFormula) this.roll(this.lastFormula, { keepFormula: true });
      });
      this.reroll = reroll;
      this.root.appendChild(reroll);

      // Тайный бросок умеет только мастер. Поле всегда есть в разметке, но
      // показывается по роли: панель собирается до подключения, роль в этот
      // момент ещё неизвестна, и к моменту показа у мастера она уже есть.
      // Игрок, бросивший тайно, видел бы число лишь сам, то есть «тайно» ничего
      // бы не значило; сервер проверяет это повторно.
      const hiddenLabel = el('label', 'dice__hidden');
      const hiddenBox = el('input', null);
      hiddenBox.type = 'checkbox';
      hiddenLabel.appendChild(hiddenBox);
      hiddenLabel.appendChild(el('span', null, 'тайно'));
      this.hiddenBox = hiddenBox;
      this.hiddenLabel = hiddenLabel;
      this.canRollHidden = typeof this.handlers.canRollHidden === 'function'
        ? this.handlers.canRollHidden
        : () => false;
      this.root.appendChild(hiddenLabel);
      this.updateHiddenAvailability();

      // Подсказка живёт под полем броска и до заголовка истории: ошибка
      // разбора должна быть рядом с полем, а не внизу панели.
      this.hint = el('div', 'dice__hint');
      this.root.appendChild(this.hint);

      this.last = el('div', 'dice__last');
      this.last.hidden = true;
      this.root.appendChild(this.last);

      // История сворачивается: за бой она идёт вниз и занимает полпанели,
// а бросить кость мастеру нужнее, чем перечитывать двести строк. Свёрнутое
// состояние переживает перезапуск окна.
      const history = section('История бросков', 'dnd-table.panel.diceHistory', {
        onExpand: () => this.scrollToEnd()
      });
      this.history = el('div', 'dice__history');
      history.body.appendChild(this.history);
      this.root.appendChild(history.wrap);
    }

    /**
     * Отправляет бросок. Формулу разбирает сервер: клиент знает только
     * набор настоящих костей и отдаёт написанное текстом.
     * @param {string} formula
     * @param {{keepFormula?: boolean}} [options]
     */
    roll(formula, options = {}) {
      const text = String(formula || '').trim();
      if (!text) return;
      const parsed = DnDDice.parseFormula(text);
      if (!parsed.ok) {
        this.showHint(parsed.error);
        return;
      }
      this.lastFormula = parsed.normalized;
      if (this.reroll) this.reroll.hidden = false;
      // Набранный текст после броска не нужен: он остаётся в перебросе, а поле
      // очищается, чтобы следующий бросок не отличался от предыдущего одним
      // нажатием.
      if (this.input && !options.keepFormula) this.input.value = '';
      this.showHint('');
      this.startRolling(parsed.normalized);
      if (this.handlers.onRoll) {
        this.handlers.onRoll(parsed.normalized, {
          hidden: this.canRollHidden() && Boolean(this.hiddenBox && this.hiddenBox.checked)
        });
      }
    }

    /** Бросок из строки формулы: пустая строка не отправляется. */
    rollFromInput() {
      const text = this.input ? this.input.value.trim() : '';
      if (!text) {
        this.showHint('Введите формулу броска, например 2d6+3');
        return;
      }
      this.roll(text);
    }

    /**
     * Подсказка под полем броска: сюда же сервер присылает отказ, если
     * формула не разобралась. Ошибка должна быть видна рядом с полем, а не
     * только во всплывающем сообщении.
     * @param {string} text
     */
    showHint(text) {
      if (!this.hint) return;
      this.hint.textContent = text || '';
      this.hint.classList.toggle('is-error', Boolean(text));
      if (text && this.rolling) this.finishRolling();
    }

    /** @param {object[]} history */
    renderAll(history) {
      this.updateHiddenAvailability();
      const fragment = document.createDocumentFragment();
      for (const roll of history) this.appendRow(roll, fragment);
      this.history.replaceChildren(fragment);
      while (this.history.childElementCount > 200) this.history.removeChild(this.history.firstChild);
      this.scrollToEnd();
    }

    /** Показывает поле «тайно» только мастеру и только пока он не отправлен. */
    updateHiddenAvailability() {
      if (!this.hiddenLabel) return;
      this.hiddenLabel.hidden = !this.canRollHidden();
      if (this.hiddenLabel.hidden) this.hiddenBox.checked = false;
    }

    /**
     * Подпись броска: формула, а если броска не было, одна кость.
     * Старые броски в истории кампании хранят только грани, и «d20» должно
     * остаться читаемым.
     * @param {object} roll
     * @returns {string}
     */
    rollLabel(roll) {
      return roll.formula || `d${roll.sides}`;
    }

    /**
     * Показывать ли число броска.
     *
     * Решает не флаг hidden, а само наличие числа: тайный бросок приходит
     * мастеру с флагом и с числом, и прятать его от мастера незачем. Игроку
     * приходит тот же бросок с result: null, и это единственный признак, по
     * которому нужно показать вопросительный знак.
     * @param {object} roll
     * @returns {boolean}
     */
    showsResult(roll) {
      return roll.result !== null && roll.result !== undefined;
    }

    /** @param {object} roll */
    append(roll) {
      this.appendRow(roll);
      this.scrollToEnd();
      // Пока кость крутится, результат ждёт своей очереди: плашка не должна
      // мигнуть числом раньше, чем закончится бросок.
      if (this.rolling) {
        this.pendingResult = roll;
        if (Date.now() - this.rollStartedAt >= this.minRollMs) this.finishRolling();
        return;
      }
      this.showLast(roll);
    }

    /**
     * Начинает анимацию броска. Плашка показывает формулу и крутящуюся кость,
     * а прежний результат убирает: иначе было бы непонятно, что бросок идёт.
     * @param {string} formula
     */
    startRolling(formula) {
      if (!this.last) return;
      // Звук стартует вместе с анимацией, а не после ответа сервера: иначе
      // бросок «молчит» всю паузу и звук приходит невпопад.
      if (window.DnDSound) window.DnDSound.play('dice');
      this.rolling = true;
      this.pendingResult = null;
      this.rollStartedAt = Date.now();
      clearTimeout(this.rollTimer);
      clearTimeout(this.rollWatchdog);
      this.last.hidden = false;
      this.last.classList.remove('is-rolling');
      this.last.classList.add('is-tumbling');
      this.last.innerHTML = '';
      this.last.appendChild(el('span', 'dice__last-text', `Бросаем ${formula}…`));
      const tumbler = el('span', 'dice__tumbler');
      tumbler.appendChild(el('span', 'dice__tumbler-die', 'd20'));
      this.last.appendChild(tumbler);
      // Перезапуск анимации: без перечитывания класса она не начнётся снова.
      void this.last.offsetWidth;
      this.rollTimer = setTimeout(() => this.finishRolling(), this.minRollMs);
      // Если ответа нет вовсе, «Бросаем…» не должно висеть вечно.
      this.rollWatchdog = setTimeout(() => this.finishRolling(), 4000);
    }

    /** Завершает анимацию и показывает последний пришедший результат. */
    finishRolling() {
      clearTimeout(this.rollTimer);
      clearTimeout(this.rollWatchdog);
      this.rollTimer = null;
      this.rollWatchdog = null;
      if (!this.last) return;
      this.rolling = false;
      this.last.classList.remove('is-tumbling');
      const roll = this.pendingResult;
      this.pendingResult = null;
      if (roll) {
        this.showLast(roll);
      } else if (!this.last.querySelector('.dice__last-value')) {
        // Бросок отклонён или ответ не пришёл: пустая плашка не нужна.
        this.last.hidden = true;
        this.last.innerHTML = '';
      }
    }

    /**
     * Показывает результат броска и запускает посадку кости.
     * @param {object} roll
     */
    showLast(roll) {
      this.last.hidden = false;
      this.last.classList.remove('is-tumbling');
      this.last.innerHTML = '';
      this.last.appendChild(el('span', 'dice__last-text', `${roll.playerName} бросил ${this.rollLabel(roll)}:`));
      const known = this.showsResult(roll);
      const value = el('span', 'dice__last-value', known ? String(roll.result) : '?');
      if (!known) value.classList.add('is-secret');
      value.classList.add('is-pop');
      this.last.appendChild(value);
      setTimeout(() => value.classList.remove('is-pop'), 600);
      // Кольцо, расходящееся от места броска: короткое, чтобы не мельтешить.
      this.last.classList.remove('is-rolling');
      // Перезапуск анимации: без перечитывания класса она не начнётся снова.
      void this.last.offsetWidth;
      this.last.classList.add('is-rolling');
      setTimeout(() => this.last.classList.remove('is-rolling'), 700);
    }

    /**
     * @param {object} roll
     * @param {Node} [parent] куда вставлять строку; при перерисовке это
     *   фрагмент, а не живая история
     */
    appendRow(roll, parent = this.history) {
      const row = el('div', 'dice__row');
      row.appendChild(el('span', 'dice__row-name', roll.playerName));
      const known = this.showsResult(roll);
      const label = el('span', 'dice__row-die', this.rollLabel(roll));
      // Скрытость результата, а не флаг hidden: поле показывается по той же
      // причине, по которой скрыт результат.
      if (!known) label.classList.add('is-secret');
      row.appendChild(label);
      row.appendChild(el('span', 'dice__row-result', known ? String(roll.result) : '?'));
      row.appendChild(el('span', 'dice__row-time', formatTime(roll.time)));
      parent.appendChild(row);
      if (parent === this.history && this.history.childElementCount > 200) {
        this.history.removeChild(this.history.firstChild);
      }
    }

    scrollToEnd() {
      this.history.scrollTop = this.history.scrollHeight;
    }
  }

  /* ====================================================================== *
   * Порядок боя
   *
   * Список ведёт мастер, видят его все: «кто за кем ходит» и есть объявление
   * для игроков. Модификатор игрока берётся из его листа, но присылает его
   * мастер вместе с записью: производные значения листа считает интерфейс,
   * и вторая копия расчёта на сервере разошлась бы с первой.
   * ==================================================================== */

  class InitiativePanel {
    constructor(root, handlers = {}) {
      this.root = root;
      this.handlers = handlers;
      this.isDm = false;
      this.players = [];
      this.tokens = [];
      this.sheets = {};
      this.state = { entries: [], turnId: null, round: 1 };
      this.build();
    }

    build() {
      this.root.appendChild(el('div', 'panel__title', 'Порядок боя'));

      this.actions = el('div', 'initiative__actions');
      const addPlayersButton = el('button', 'btn', 'Все игроки');
      addPlayersButton.type = 'button';
      addPlayersButton.title = 'Добавить в бой всех игроков стола';
      addPlayersButton.addEventListener('click', () => {
        if (this.handlers.onAddPlayers) this.handlers.onAddPlayers();
      });
      this.actions.appendChild(addPlayersButton);
      this.addPlayersButton = addPlayersButton;

      this.rollButton = el('button', 'btn btn--accent', 'Бросить');
      this.rollButton.type = 'button';
      this.rollButton.addEventListener('click', () => {
        if (this.handlers.onRoll) this.handlers.onRoll();
      });
      this.actions.appendChild(this.rollButton);

      this.resetButton = el('button', 'btn btn--ghost', 'Очистить');
      this.resetButton.type = 'button';
      this.resetButton.addEventListener('click', () => {
        if (this.handlers.onReset) this.handlers.onReset();
      });
      this.actions.appendChild(this.resetButton);
      this.root.appendChild(this.actions);

      // Кого добавлять: игроки из списка участников, фишки с поля и свободная
      // строка для того, чего на столе нет: «Солдат-нежить».
      const form = el('form', 'initiative__form');
      this.pick = el('select', 'select');
      form.appendChild(this.pick);

      this.customName = el('input', 'input');
      this.customName.type = 'text';
      this.customName.placeholder = 'Своё имя';
      this.customName.maxLength = DnD.LIMITS.maxNameLength;
      this.customName.hidden = true;
      form.appendChild(this.customName);

      this.modifier = el('input', 'input initiative__modifier');
      this.modifier.type = 'number';
      this.modifier.min = String(-20);
      this.modifier.max = String(20);
      this.modifier.step = '1';
      this.modifier.title = 'Модификатор инициативы';
      form.appendChild(this.modifier);

      const add = el('button', 'btn btn--accent', 'Добавить');
      add.type = 'submit';
      form.appendChild(add);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        this.add();
      });
      this.pick.addEventListener('change', () => {
        const custom = this.pick.value === CUSTOM_PICK;
        this.customName.hidden = !custom;
        if (custom) this.customName.focus();
        else this.modifier.value = String(this.pickModifier());
      });
      this.form = form;
      this.root.appendChild(form);

      this.status = el('div', 'initiative__status');
      this.root.appendChild(this.status);

      this.list = el('div', 'initiative__list');
      this.root.appendChild(this.list);

      const stepper = el('div', 'initiative__stepper');
      const back = el('button', 'btn btn--ghost', 'Назад');
      back.type = 'button';
      back.addEventListener('click', () => {
        if (this.handlers.onStep) this.handlers.onStep(-1);
      });
      stepper.appendChild(back);
      this.forward = el('button', 'btn btn--accent', 'Следующий');
      this.forward.type = 'button';
      this.forward.addEventListener('click', () => {
        if (this.handlers.onStep) this.handlers.onStep(1);
      });
      stepper.appendChild(this.forward);
      this.root.appendChild(stepper);
    }

    /**
     * Модификатор выбранного игрока: инициатива из его листа считается
     * интерфейсом, и мастеру остаётся только подтвердить число.
     * @returns {number}
     */
    pickModifier() {
      const value = this.pick.value;
      if (!value || value === CUSTOM_PICK) return 0;
      if (value.startsWith('player:')) {
        const sheet = this.sheets[value.slice(7)];
        if (!sheet) return 0;
        return DnD.computeDerived(sheet).initiative;
      }
      return 0;
    }

    /** Отправляет выбранного участника в список боя. */
    add() {
      const value = this.pick.value;
      const modifier = Number(this.modifier.value);
      const payload = { modifier: Number.isFinite(modifier) ? Math.round(modifier) : 0 };
      if (value === CUSTOM_PICK) {
        payload.kind = 'other';
        payload.name = this.customName.value;
      } else if (value) {
        const kind = value.slice(0, value.indexOf(':'));
        payload.kind = kind;
        payload.refId = value.slice(kind.length + 1);
        const known = kind === 'player'
          ? this.players.find((player) => player.playerId === payload.refId)
          : this.tokens.find((token) => token.id === payload.refId);
        if (!known) return;
        payload.name = known.name;
      } else {
        return;
      }
      if (this.handlers.onAdd) this.handlers.onAdd(payload);
      this.customName.value = '';
    }

    /**
     * @param {{entries: object[], turnId: string|null, round: number}} state
     * @param {object[]} players
     * @param {object[]} tokens
     * @param {{role: string}} viewer
     * @param {Record<string, object>} sheets
     */
    render(state, players, tokens, viewer, sheets) {
      this.state = state && Array.isArray(state.entries) ? state : { entries: [], turnId: null, round: 1 };
      this.players = players || [];
      this.tokens = tokens || [];
      this.sheets = sheets || {};
      this.isDm = Boolean(viewer && viewer.role === 'dm');

      for (const button of [this.addPlayersButton, this.rollButton, this.resetButton, this.forward]) {
        button.hidden = !this.isDm;
      }
      // Форму целиком, а не по кнопкам: иначе у игрока осталась бы одна
      // кнопка «Добавить» без полей.
      this.form.hidden = !this.isDm;
      this.fillPick();
      this.renderStatus();
      this.renderList();
    }

    /** Наполняет список выбора игроками и фишками, кроме уже добавленных. */
    fillPick() {
      const taken = new Set(this.state.entries.map((entry) => entry.refId));
      const previous = this.pick.value;
      this.pick.innerHTML = '';
      const players = this.players.filter((player) => !taken.has(player.playerId));
      if (players.length) {
        const group = document.createElement('optgroup');
        group.label = 'Игроки';
        for (const player of players) {
          group.appendChild(el('option', null, player.name)).value = `player:${player.playerId}`;
        }
        this.pick.appendChild(group);
      }
      const tokens = this.tokens.filter((token) => !taken.has(token.id));
      if (tokens.length) {
        const group = document.createElement('optgroup');
        group.label = 'Фишки';
        for (const token of tokens) {
          group.appendChild(el('option', null, token.name)).value = `token:${token.id}`;
        }
        this.pick.appendChild(group);
      }
      if (players.length || tokens.length) {
        const custom = el('option', null, 'Другое имя');
        custom.value = CUSTOM_PICK;
        this.pick.appendChild(custom);
      }
      // Возвращаем прежний выбор, если он ещё доступен: мастер добавляет
      // участников по одному, и сбрасывать выбор после каждого неудобно.
      if (previous && [...this.pick.options].some((option) => option.value === previous)) {
        this.pick.value = previous;
      }
      if (this.pick.value !== CUSTOM_PICK) this.modifier.value = String(this.pickModifier());
    }

    renderStatus() {
      const { entries, turnId, round } = this.state;
      const current = entries.find((entry) => entry.id === turnId);
      this.status.innerHTML = '';
      if (!entries.length) {
        this.status.appendChild(el('span', 'initiative__hint', 'Список пуст: добавьте игроков и фишек'));
        return;
      }
      const rolled = entries.some((entry) => entry.total !== null && entry.total !== undefined);
      this.status.appendChild(el('span', 'initiative__round', `Раунд ${round}`));
      this.status.appendChild(el('span', 'initiative__current',
        current ? `Ходит: ${current.name}` : (rolled ? 'Ход не объявлен' : 'Бросьте инициативу')));
    }

    renderList() {
      this.list.innerHTML = '';
      const { entries, turnId } = this.state;
      if (!entries.length) return;
      entries.forEach((entry, index) => {
        const row = el('div', 'initiative__row');
        if (entry.id === turnId) row.classList.add('is-current');
        row.appendChild(el('span', 'initiative__index', String(index + 1)));
        row.appendChild(el('span', 'initiative__name', entry.name));
        const total = entry.total === null || entry.total === undefined ? '—' : String(entry.total);
        row.appendChild(el('span', 'initiative__total', total));
        row.appendChild(el('span', 'initiative__modifier',
          `${entry.modifier >= 0 ? '+' : ''}${entry.modifier}`));
        if (this.isDm) {
          const actions = el('span', 'initiative__row-actions');
          const reroll = el('button', 'btn btn--ghost', 'Бросить');
          reroll.type = 'button';
          reroll.title = 'Перебросить инициативу этого участника';
          reroll.addEventListener('click', (event) => {
            event.stopPropagation();
            if (this.handlers.onRollOne) this.handlers.onRollOne(entry.id);
          });
          actions.appendChild(reroll);
          const remove = el('button', 'btn btn--ghost', 'Убрать');
          remove.type = 'button';
          remove.addEventListener('click', (event) => {
            event.stopPropagation();
            if (this.handlers.onRemove) this.handlers.onRemove(entry.id);
          });
          actions.appendChild(remove);
          row.appendChild(actions);
          // Клик по строке объявляет, чей ход: удобнее, чем искать кнопку.
          row.addEventListener('click', () => {
            if (this.handlers.onSetTurn) this.handlers.onSetTurn(entry.id);
          });
        }
        this.list.appendChild(row);
      });
    }
  }

  /* ====================================================================== *
   * Панель поверхности карты
   * ====================================================================== */

  /**
   * Панель рисования поверхности: кислота, огонь, вода и прочее.
   *
   * Отдельная вкладка, а не ещё одна кнопка в строке карты: типов восемь, и
   * в строке они не поместились бы вместе с туманом, светом и загрузкой карты.
   * Кисть при этом живёт на карте — выбрали здесь, рисуем там.
   */
  class SurfacePanel {
    /**
     * @param {HTMLElement} root
     * @param {{onPick?: Function, onBrush?: Function, onErase?: Function, onClear?: Function}} handlers
     */
    constructor(root, handlers = {}) {
      this.root = root;
      this.handlers = handlers;
      this.tool = null;
      this.brush = 1;
      this.count = 0;
      this.build();
    }

    build() {
      this.root.appendChild(el('div', 'panel__title', 'Поверхность'));

      this.hint = el('div', 'muted',
        'Выберите, что рисовать, и проведите по карте. Поверхность ложится по клеткам под фишки, и её видят все участники.');
      this.root.appendChild(this.hint);

      const grid = el('div', 'surface-panel__types');
      this.typeNodes = new Map();
      for (const item of DnD.SURFACE_TYPES) {
        const chip = el('button', 'surface-chip');
        chip.type = 'button';
        chip.title = `${item.label}: рисуется по клеткам`;
        const dot = el('span', 'surface-chip__dot');
        // Цвет берём из правил, а не из темы: это содержимое карты, и мастер
        // должен узнавать лужу по цвету при любом оформлении.
        dot.style.background = item.color;
        chip.appendChild(dot);
        chip.appendChild(el('span', null, item.label));
        chip.addEventListener('click', () => {
          if (this.handlers.onPick) this.handlers.onPick(this.tool === item.id ? null : item.id);
        });
        this.typeNodes.set(item.id, chip);
        grid.appendChild(chip);
      }
      this.root.appendChild(grid);

      const row = el('div', 'surface-panel__row');
      this.eraseButton = el('button', 'btn btn--tiny btn--ghost', 'Ластик');
      this.eraseButton.type = 'button';
      this.eraseButton.title = 'Стирать поверхность по клеткам';
      this.eraseButton.addEventListener('click', () => {
        if (this.handlers.onErase) this.handlers.onErase();
      });
      row.appendChild(this.eraseButton);

      const brushWrap = el('label', 'surface-panel__brush');
      brushWrap.appendChild(el('span', null, 'Ширина'));
      this.brushInput = el('input', 'fog-bar__brush');
      this.brushInput.type = 'range';
      this.brushInput.min = '1';
      this.brushInput.max = '5';
      this.brushInput.step = '1';
      this.brushInput.value = String(this.brush);
      this.brushInput.title = 'Ширина кисти в клетках';
      this.brushInput.addEventListener('input', () => {
        this.brush = Number(this.brushInput.value);
        if (this.handlers.onBrush) this.handlers.onBrush(this.brush);
      });
      brushWrap.appendChild(this.brushInput);
      row.appendChild(brushWrap);

      this.clearButton = el('button', 'btn btn--tiny btn--ghost', 'Очистить карту');
      this.clearButton.type = 'button';
      this.clearButton.title = 'Убрать всю поверхность с открытой карты';
      this.clearButton.addEventListener('click', () => {
        if (this.handlers.onClear) this.handlers.onClear();
      });
      row.appendChild(this.clearButton);
      this.root.appendChild(row);

      this.countNode = el('div', 'muted', '');
      this.root.appendChild(this.countNode);
    }

    /**
     * Показывает выбранный инструмент и число раскрашенных клеток.
     * @param {{tool: string|null, brush: number, painted: number}} state
     */
    render(state) {
      const next = state || {};
      this.tool = next.tool === undefined ? this.tool : next.tool;
      this.brush = next.brush || this.brush;
      this.brushInput.value = String(this.brush);
      this.count = Number(next.painted) || 0;
      for (const [id, chip] of this.typeNodes) {
        chip.classList.toggle('is-on', this.tool === id);
      }
      this.eraseButton.classList.toggle('is-on', this.tool === '');
      this.clearButton.disabled = this.count === 0;
      const active = this.tool === null ? '' : `Выбрано: ${this.tool === '' ? 'ластик' : (DnD.SURFACE_TYPES.find((item) => item.id === this.tool) || {}).label}.`;
      this.countNode.textContent = `${active} Клеток на карте: ${this.count}`;
    }
  }

  /* ====================================================================== *
   * Панель фишек ДМ
   * ====================================================================== */

  class TokenPanel {
    constructor(root, handlers = {}) {
      this.root = root;
      this.handlers = handlers;
      // Карта, которую видят игроки: список фишек открывает то же меню, что и
      // карта, и перенос из него должен вести туда же.
      this.activeMapInfo = handlers.activeMapInfo || (() => ({}));
      this.isDm = false;
      /** Фишки в текущем списке, а не в кампании: фильтр и поиск
       *  только по ним, и снизу видно, сколько всего показано из
       *  найденного. Здесь же хранится <выбранная>. */
      this.query = '';
      this.filter = 'all';
      this.tokens = [];
      this.players = [];
      this.build();
    }

    build() {
      this.root.appendChild(el('div', 'panel__title', 'Фишки'));

      const form = el('form', 'token-form');
      const input = el('input', 'input');
      input.type = 'text';
      input.placeholder = 'Имя фишки (например, «Гоблин 1»)';
      input.maxLength = DnD.LIMITS.maxNameLength;
      form.appendChild(input);
      // Прочность при создании: монстра заводят на стол вместе с его хитами.
      // Пустое поле означает фишку без здоровья: метку или шарик, которому
      // урон не наносится.
      const hpInput = el('input', 'input token-form__hp');
      hpInput.type = 'number';
      hpInput.min = '1';
      hpInput.max = String(DnD.LIMITS.maxTokenHp);
      hpInput.placeholder = 'Прочность';
      hpInput.title = 'Максимальная прочность фишки (необязательно)';
      form.appendChild(hpInput);
      this.hpInput = hpInput;

      // Размер в клетках: большой монстр занимает 2×2, огромный 3×3.
      const sizeInput = el('select', 'select select--tiny token-form__size');
      sizeInput.title = 'Размер фишки в клетках';
      for (const size of [1, 2, 3, 4]) {
        const option = el('option', null, `${size}×${size}`);
        option.value = String(size);
        sizeInput.appendChild(option);
      }
      form.appendChild(sizeInput);
      this.sizeInput = sizeInput;

      const create = el('button', 'btn btn--accent', 'Создать фишку');
      create.type = 'submit';
      form.appendChild(create);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const name = input.value.trim();
        const maxHp = Number(hpInput.value);
        if (this.handlers.onCreate) {
          this.handlers.onCreate(
            name,
            Number.isFinite(maxHp) && maxHp > 0 ? maxHp : null,
            Number(sizeInput.value) || 1
          );
        }
        input.value = '';
        hpInput.value = '';
        sizeInput.value = '1';
      });
      form.appendChild(create);
      this.root.appendChild(form);
      // Фишки создаёт ДМ; игроку эта форма не нужна — кроме тренировочного
      // стола, где просить фишку не у кого.
      this.form = form;

      this.note = el('div', 'muted', 'Правый клик по фишке на карте или по строке ниже — переименовать, назначить игроку, задать изображение или удалить.');
      this.root.appendChild(this.note);

      // Поиск и фильтры. Под списком, а не над всей панелью: ищут по фишкам,
      // а не по листу и не по чату.
      this.searchBox = this.buildSearch();
      this.root.appendChild(this.searchBox);

      this.list = el('div', 'token-list');
      this.root.appendChild(this.list);

      // Подсказка «ничего не найдено». Отдельным узлом, а не пустым списком:
      // пустой список рядом с полем поиска выглядит как «фишек нет вовсе», и
      // мастер начинает искать монстра там, где он уже на столе.
      this.emptyHint = el('div', 'muted token-list__empty', 'Фишек пока нет');
      this.emptyHint.hidden = true;
      this.root.appendChild(this.emptyHint);
    }

    /**
     * Прячет строки, которые не прошли поиск и фильтр.
     *
     * Список перерисовывается целиком на каждое событие фишки, поэтому поиск
     * живёт в панели и применяется сразу к новому списку, а не после лишнего
     * рендера: сорок фишек перерисовывать ради одного введённого символа
     * незачем.
     */
    applyFilters() {
      const shown = this.filteredTokens();
      for (const node of this.list.querySelectorAll('.token-row[data-token-id]')) {
        node.hidden = !shown.has(node.dataset.tokenId);
      }
      for (const [id, button] of Object.entries(this.filterButtons)) {
        button.classList.toggle('is-on', this.filter === id);
      }
      const none = shown.size === 0;
      this.emptyHint.hidden = !none;
      if (none) {
        this.emptyHint.textContent = this.tokens.length
          ? `Ничего не найдено: показано 0 из ${this.tokens.length}`
          : 'Фишек пока нет';
      }
    }

    /**
     * Поле поиска и три переключателя фильтра.
     *
     * Фильтр — это не украшение: за бой на столе под полсотни фишек, и найти
     * нужную в списке прокруткой мастер не может.
     * @returns {HTMLElement}
     */
    buildSearch() {
      const box = el('div', 'token-search');

      const search = el('input', 'input token-search__input');
      search.type = 'search';
      search.placeholder = 'Найти фишку по имени';
      search.maxLength = DnD.LIMITS.maxNameLength;
      search.setAttribute('aria-label', 'Поиск по фишкам');
      search.addEventListener('input', () => {
        this.query = search.value.trim().toLowerCase();
        this.applyFilters();
      });
      // Escape в поле поиска снимает его: привычка из поиска в браузере, а у
      // нас он же закрывает открытое меню, поэтому останавливаем всплытие.
      search.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        search.value = '';
        this.query = '';
        this.applyFilters();
      });
      box.appendChild(search);
      this.searchInput = search;

      const filters = el('div', 'token-search__filters');
      this.filterButtons = {};
      const variants = [
        { id: 'all', label: 'Все' },
        { id: 'hidden', label: 'Скрытые' },
        { id: 'named', label: 'С моим именем' },
        { id: 'nameless', label: 'Без имени' }
      ];
      for (const variant of variants) {
        const button = el('button', 'btn btn--tiny btn--ghost token-filter', variant.label);
        button.type = 'button';
        button.addEventListener('click', () => {
          this.filter = variant.id;
          this.applyFilters();
        });
        filters.appendChild(button);
        this.filterButtons[variant.id] = button;
      }
      box.appendChild(filters);
      return box;
    }

    /**
     * Фишки, прошедшие поиск и фильтр.
     * @returns {Set<string>}
     */
    filteredTokens() {
      const result = new Set();
      for (const token of this.tokens) {
        if (this.query && !String(token.name || '').toLowerCase().includes(this.query)) continue;
        if (this.filter === 'hidden' && !token.hidden) continue;
        if (this.filter === 'nameless' && !token.hideName) continue;
        if (this.filter === 'named' && token.hideName) continue;
        result.add(token.id);
      }
      return result;
    }

    /**
     * @param {object[]} tokens
     * @param {object[]} players
     * @param {object} ctx
     */
    render(tokens, players, ctx) {
      const training = Boolean(ctx.training);
      const isDm = ctx.role === 'dm';
      this.isDm = isDm;
      this.tokens = tokens || [];
      this.players = players || [];
      this.searchBox.hidden = !(isDm && this.tokens.length > 3);
      this.searchBox.dataset.dm = isDm ? '1' : '0';
      this.form.hidden = !isDm && !training;
      this.note.hidden = !isDm && !training;
      this.note.textContent = isDm
        ? 'Новая фишка появляется скрытой от игроков: расставьте её и нажмите «Видна». Правый клик по фишке — переименовать, назначить, изображение, скрыть или удалить.'
        : 'Проверка без сети: созданная фишка сразу ваша — её можно двигать по карте и задать картинку.';

      this.list.innerHTML = '';
      // Секции пересобираются на каждом рендере, а свёрнутое состояние живёт в
      // localStorage внутри section(): иначе состояние потерялось бы вместе с
      // узлом, и панель прыгала бы при каждом событии фишки.
      // Кто ещё без фишки. Живёт здесь, а не только в панели участников:
// левую панель мастер часто сворачивает, а вывести игрока на поле
// удобнее оттуда, где уже работают с фишками.
      const spawn = section('Вывести из листа', 'dnd-table.panel.tokensSpawn');
      this.spawnNode = el('div', 'token-spawn');
      spawn.body.appendChild(this.spawnNode);
      spawn.wrap.hidden = !isDm;
      this.list.appendChild(spawn.wrap);
      this.renderSpawnSection(players, ctx);

      const mine = this.buildMineSection(tokens, ctx);
      if (mine) this.list.appendChild(mine);

      if (isDm) {
        const all = section('Все фишки', 'dnd-table.panel.tokensAll');

        // Массовые переключатели: подготовка кончилась — открыть всё разом,
        // откатился — спрятать всё разом. Без них пришлось бы кликать по
        // каждой фишке, а их под полсотни может быть.
        const hiddenCount = tokens.filter((token) => token.hidden).length;
        if (tokens.length) {
          const bulk = el('div', 'token-bulk');
          const showAll = el('button', 'btn btn--ghost btn--tiny',
            hiddenCount === tokens.length ? 'Показать все' : `Показать все (${tokens.length - hiddenCount} скрыто)`);
          showAll.type = 'button';
          showAll.disabled = hiddenCount === 0;
          showAll.addEventListener('click', () => {
            if (this.handlers.onSetAllTokensHidden) this.handlers.onSetAllTokensHidden(false);
          });
          const hideAll = el('button', 'btn btn--ghost btn--tiny', 'Скрыть все');
          hideAll.type = 'button';
          hideAll.disabled = hiddenCount === tokens.length;
          hideAll.addEventListener('click', () => {
            if (this.handlers.onSetAllTokensHidden) this.handlers.onSetAllTokensHidden(true);
          });
          bulk.appendChild(showAll);
          bulk.appendChild(hideAll);
          all.body.appendChild(bulk);
        }

        // Про «фишек пока нет» отдельно не пишем: applyFilters() и так говорит
        // это под списком, и два одинаковых предложения подряд выглядят как
        // сбой отрисовки.
        for (const token of tokens) {
          all.body.appendChild(this.buildTokenRow(token, players));
        }
        this.list.appendChild(all.wrap);
      }
      this.applyFilters();
    }

    /**
     * Строка фишки в списке.
     *
     * Правый клик открывает то же меню, что и клик по фишке на карте, а
     * переключатель имени стоит прямо в строке: скрывать подпись приходится
     * часто и по одной фишке, лезть в меню ради этого не нужно.
     * @param {object} token
     * @param {object[]} players
     * @returns {HTMLElement}
     */
    buildTokenRow(token, players) {
      const row = el('div', 'token-row');
      row.dataset.tokenId = token.id;
      row.title = 'Правый клик — переименовать, назначить, скрыть имя или удалить';
      if (token.hidden) row.classList.add('token-row--hidden');
      if (token.hideName) row.classList.add('token-row--nameless');
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.showTokenMenu(token, event.clientX, event.clientY);
      });
      row.addEventListener('dblclick', (event) => {
        if (event.target.closest('button, input, select')) return;
        if (this.handlers.onRenameToken) this.handlers.onRenameToken(token);
      });

      row.appendChild(el('span', 'token-row__dot'));
      row.lastChild.style.background = token.color;
      const name = el('span', 'token-row__name', token.hideName ? 'Имя скрыто' : token.name);
      row.appendChild(name);
      row.appendChild(el('span', 'token-row__meta', DnD.MAP_LABELS[token.mapType]));
      const owner = players.find((player) => player.playerId === token.assignedPlayerId);
      row.appendChild(el('span', 'token-row__meta', owner ? `→ ${owner.name}` : 'не назначена'));
      if (token.maxHp) row.appendChild(this.buildHpControl(token));

      const sizeSelect = el('select', 'select select--tiny token-row__size');
      sizeSelect.title = 'Размер фишки в клетках';
      for (const size of [1, 2, 3, 4]) {
        const option = el('option', null, `${size}×${size}`);
        option.value = String(size);
        sizeSelect.appendChild(option);
      }
      sizeSelect.value = String(DnD.clampNumber(token.size, 1, 4, 1));
      sizeSelect.addEventListener('change', () => {
        if (this.handlers.onSetTokenSize) {
          this.handlers.onSetTokenSize(token.id, Number(sizeSelect.value) || 1);
        }
      });
      row.appendChild(sizeSelect);

      row.appendChild(this.buildConditionsControl(token));

      const nameless = el('button',
        `btn btn--tiny ${token.hideName ? '' : 'btn--ghost'}`,
        token.hideName ? 'Без имени' : 'С именем');
      nameless.type = 'button';
      nameless.classList.toggle('is-on', Boolean(token.hideName));
      nameless.title = token.hideName
        ? 'Показать имя фишки игрокам'
        : 'Скрыть имя фишки от игроков: подпись исчезнет, сама фишка останется';
      nameless.addEventListener('click', () => {
        if (this.handlers.onToggleTokenNameHidden) {
          this.handlers.onToggleTokenNameHidden(token.id, !token.hideName);
        }
      });
      row.appendChild(nameless);

      // Подписи снизу: убираются у всех сразу, в том числе у мастера. Отдельная
      // кнопка от «Без имени», потому что там тайна от игроков, а здесь — чистая
      // картинка без подписей.
      const nolabels = el('button',
        `btn btn--tiny ${token.hideLabels ? '' : 'btn--ghost'}`,
        token.hideLabels ? 'Без подписей' : 'С подписями');
      nolabels.type = 'button';
      nolabels.classList.toggle('is-on', Boolean(token.hideLabels));
      nolabels.title = token.hideLabels
        ? 'Показать под фишкой имя, хозяина и состояния'
        : 'Убрать под фишкой имя, хозяина и состояния у всех участников';
      nolabels.addEventListener('click', () => {
        if (this.handlers.onToggleTokenLabelsHidden) {
          this.handlers.onToggleTokenLabelsHidden(token.id, !token.hideLabels);
        }
      });
      row.appendChild(nolabels);

      // Свет фишки: ноль футов — не светит. Дальность в футах, потому что в
      // правилах так, и мастер не должен пересчитывать её в клетки за столом.
      const lightSelect = el('select', 'select select--tiny token-row__light');
      const off = el('option', null, 'Без света');
      off.value = '0';
      lightSelect.appendChild(off);
      for (const preset of DnD.LIGHT_PRESETS) {
        const option = el('option', null, preset.label);
        option.value = String(preset.radius);
        lightSelect.appendChild(option);
      }
      const currentRadius = token.light ? Number(token.light.radius) || 0 : 0;
      lightSelect.value = String(currentRadius);
      // Свою дальность мастер мог задать руками: её в списке нет, поэтому
      // добавляем отдельной строкой, иначе ползунок молча сбросился бы.
      if (currentRadius > 0 && !lightSelect.querySelector(`option[value="${currentRadius}"]`)) {
        const custom = el('option', null, `${currentRadius} фт`);
        custom.value = String(currentRadius);
        lightSelect.appendChild(custom);
      }
      lightSelect.title = 'Свет, который испускает фишка';
      lightSelect.addEventListener('change', () => {
        const radius = Number(lightSelect.value) || 0;
        if (this.handlers.onSetTokenLight) {
          const preset = DnD.LIGHT_PRESETS.find((item) => item.radius === radius);
          this.handlers.onSetTokenLight(token.id, radius, preset ? preset.color : '#ffb347');
        }
      });
      row.appendChild(lightSelect);

      const eye = el('button',
        `btn btn--tiny ${token.hidden ? 'btn--ghost' : ''}`,
        token.hidden ? 'Скрыта' : 'Видна');
      eye.type = 'button';
      eye.title = token.hidden
        ? 'Показать фишку игрокам'
        : 'Скрыть фишку от игроков';
      eye.addEventListener('click', () => {
        if (this.handlers.onToggleTokenHidden) this.handlers.onToggleTokenHidden(token.id, !token.hidden);
      });
      row.appendChild(eye);
      const del = el('button', 'btn btn--tiny btn--danger', 'Удалить');
      del.type = 'button';
      del.addEventListener('click', () => {
        if (this.handlers.onDeleteToken) this.handlers.onDeleteToken(token.id);
      });
      row.appendChild(del);
      return row;
    }

    showTokenMenu(token, clientX, clientY) {
      const info = this.activeMapInfo() || {};
      placeTokenMenu(
        buildTokenMenu(token, this.players, this.handlers, () => this.closeMenu(), {
          activeMap: info.activeMap,
          activeMapId: info.activeMapId,
          canTransfer: this.isDm
        }),
        clientX,
        clientY,
        this
      );
    }

    closeMenu() {
      if (this.closeMenuHandler) {
        document.removeEventListener('pointerdown', this.closeMenuHandler, true);
        this.closeMenuHandler = null;
      }
      if (this.escapeHandler) {
        document.removeEventListener('keydown', this.escapeHandler);
        this.escapeHandler = null;
      }
      if (this.openMenu && this.openMenu.parentNode) this.openMenu.parentNode.removeChild(this.openMenu);
      this.openMenu = null;
    }

    /**
     * Прочность фишки: полоса, поле для точного числа и кнопки урона.
     *
     * Кнопок четыре, потому что за бой нужны разные суммы: 1 и 5 закрывают
     * бытовой урон и кляксу, а поле нужно для ровного значения из правил.
     * Фишка без прочности (maxHp === null) — метка, ей урон не наносится.
     * @param {object} token
     * @returns {HTMLElement}
     */
    buildHpControl(token) {
      const max = Number(token.maxHp) || 1;
      const hp = Number.isFinite(Number(token.hp)) ? Math.max(0, Math.min(max, Number(token.hp))) : max;
      const box = el('div', 'token-hp');
      const track = el('div', 'token-hp__track');
      const fill = el('div', 'token-hp__fill');
      fill.style.width = `${Math.round((hp / max) * 100)}%`;
      if (hp === 0) box.classList.add('is-down');
      else if (hp * 2 <= max) box.classList.add('is-low');
      track.appendChild(fill);
      box.appendChild(track);

      const readout = el('input', 'token-hp__value');
      readout.type = 'number';
      readout.min = '0';
      readout.max = String(max);
      readout.value = String(hp);
      readout.title = `Прочность фишки «${token.name}»`;
      readout.addEventListener('change', () => {
        const raw = readout.value.trim();
        const value = Number(raw);
        // Пустое поле — не ноль здоровья, а «значение не задано»: стирать
        // монстра в ноль, случайно нажав Enter, нельзя.
        if (raw !== '' && Number.isFinite(value) && this.handlers.onSetTokenHp) {
          this.handlers.onSetTokenHp(token.id, Math.round(value));
        } else {
          readout.value = String(hp);
        }
      });
      box.appendChild(readout);

      for (const amount of [-5, -1, 1, 5]) {
        const button = el('button', 'btn btn--tiny btn--ghost token-hp__btn',
          amount > 0 ? `+${amount}` : String(amount));
        button.type = 'button';
        button.title = amount > 0 ? `Вылечить на ${amount}` : `Нанести урон ${-amount}`;
        button.disabled = hp === 0 && amount < 0;
        button.addEventListener('click', () => {
          if (this.handlers.onSetTokenHp) this.handlers.onSetTokenHp(token.id, hp + amount);
        });
        box.appendChild(button);
      }
      return box;
    }

    /**
     * Состояния фишки: короткая строка с включёнными состояниями и
     * переключатель всех остальных.
     *
     * Тринадцать состояний на каждую строку не поместились бы, поэтому видны
     * только включённые, а список раскрывается по клику. Состояния видны всем
     * участникам, поэтому здесь они только у мастера, а на карте показываются
     * подсказками у всех.
     * @param {object} token
     * @returns {HTMLElement}
     */
    buildConditionsControl(token) {
      const active = Array.isArray(token.conditions) ? token.conditions : [];
      // Текущий выбор живёт здесь, а не перечитывается из фишки: пока сервер не
      // ответил и панель не перерисовалась, второй клик обязан видеть первый.
      const selected = new Set(active);
      const durations = {};
      if (token.conditionDurations && typeof token.conditionDurations === 'object') {
        for (const id of active) {
          const rounds = DnD.clampNumber(token.conditionDurations[id], 0, 99, 0);
          if (rounds > 0) durations[id] = rounds;
        }
      }
      const box = el('div', 'token-conditions');
      const head = el('button', 'token-conditions__head');
      head.type = 'button';
      head.addEventListener('click', () => {
        box.classList.toggle('is-open');
      });

      const syncHead = () => {
        const names = [...selected]
          .map((id) => DnD.CONDITIONS.find((item) => item.id === id))
          .filter(Boolean)
          .map((item) => {
            const rounds = Number(durations[item.id]) || 0;
            return rounds > 0 ? `${item.label} · ${rounds} р.` : item.label;
          })
          .join(', ');
        head.classList.toggle('is-empty', !names);
        head.textContent = names || 'состояния';
        head.title = names ? `Состояния: ${names}` : 'Задать состояния';
      };
      syncHead();
      box.appendChild(head);

      const body = el('div', 'token-conditions__body');
      const grid = el('div', 'token-conditions__grid');
      const send = () => {
        if (this.handlers.onSetTokenConditions) {
          this.handlers.onSetTokenConditions(token.id, [...selected], { ...durations });
        }
      };

      const durationBox = el('div', 'token-conditions__durations');
      const renderDurations = () => {
        durationBox.replaceChildren();
        const items = [...selected]
          .map((id) => DnD.CONDITIONS.find((item) => item.id === id))
          .filter(Boolean);
        durationBox.hidden = !items.length;
        for (const item of items) {
          const row = el('label', 'token-conditions__rounds');
          row.appendChild(el('span', 'token-conditions__rounds-name', item.label));
          const input = document.createElement('input');
          input.type = 'number';
          input.className = 'input token-conditions__rounds-input';
          input.min = '0';
          input.max = '99';
          input.value = String(durations[item.id] || 0);
          input.title = 'Сколько раундов действует состояние. 0: до снятия вручную';
          input.addEventListener('change', () => {
            const value = DnD.clampNumber(input.value, 0, 99, 0);
            input.value = String(value);
            if (value > 0) durations[item.id] = value;
            else delete durations[item.id];
            syncHead();
            send();
          });
          row.appendChild(input);
          row.appendChild(el('span', 'token-conditions__rounds-unit', 'раунд.'));
          durationBox.appendChild(row);
        }
      };

      for (const item of DnD.CONDITIONS) {
        const chip = el('button', 'token-conditions__chip', item.label);
        chip.type = 'button';
        chip.title = item.label;
        const isOn = active.includes(item.id);
        chip.classList.toggle('is-on', isOn);
        chip.setAttribute('aria-pressed', isOn ? 'true' : 'false');
        chip.addEventListener('click', () => {
          // Список собирается целиком: сервер ждёт именно перечень, а не
          // «добавь одно», иначе снятие состояния пришлось бы отдельным
          // событием.
          if (selected.has(item.id)) {
            selected.delete(item.id);
            delete durations[item.id];
          } else {
            selected.add(item.id);
          }
          chip.classList.toggle('is-on', selected.has(item.id));
          chip.setAttribute('aria-pressed', selected.has(item.id) ? 'true' : 'false');
          renderDurations();
          syncHead();
          send();
        });
        grid.appendChild(chip);
      }
      body.appendChild(grid);
      body.appendChild(durationBox);
      body.appendChild(el('div', 'token-conditions__note',
        'Раунды уменьшаются в начале хода фишки. 0: до снятия вручную.'));
      box.appendChild(body);
      renderDurations();
      return box;
    }

    /**
     * Спавн: игроки, у которых ещё нет фишки. Только мастеру и только за
     * столом: игроку просить некого, а в тренировочном столе фишка и так
     * достаётся ему через форму выше.
     *
     * Показываем именно тех, кому ещё нечего выводить. Перечислять всех с
     * погашенными кнопками значило бы дублировать панель участников целиком.
     * @param {object[]} players
     * @param {object} ctx
     */
    renderSpawnSection(players, ctx) {
      const node = this.spawnNode;
      node.innerHTML = '';
      if (!ctx || ctx.role !== 'dm') {
        node.hidden = true;
        return;
      }
      node.hidden = false;
      const playersOnly = players.filter((player) => player.role !== 'dm');
      const waiting = playersOnly.filter((player) => !player.tokenId);
      if (!playersOnly.length) {
        // Разницы между «игроков нет» и «у всех есть фишки» нет только на
        // словах, а на деле она первая: пустой список пугал мастера так,
        // будто кнопка сломалась.
        node.appendChild(el('div', 'muted',
          'За столом пока нет игроков: подключите их по билету из панели слева'));
        return;
      }
      if (!waiting.length) {
        node.appendChild(el('div', 'muted', 'У всех игроков за столом уже есть фишки'));
        return;
      }
      for (const player of waiting) {
        const row = el('div', 'token-spawn__row');
        row.appendChild(el('span', 'token-spawn__name', player.name));
        const meta = el('span', 'token-spawn__meta muted');
        meta.textContent = player.online
          ? 'в сети'
          : (player.hasSheet ? 'оффлайн, лист есть' : 'оффлайн, листа нет');
        row.appendChild(meta);
        const spawn = el('button', 'btn btn--tiny', 'Вывести');
        spawn.type = 'button';
        spawn.title = 'Создать фишку игрока из его листа, с аватаром';
        spawn.addEventListener('click', () => {
          if (this.handlers.onSpawnFromSheet) this.handlers.onSpawnFromSheet(player.playerId);
        });
        row.appendChild(spawn);
        node.appendChild(row);
      }
    }

    buildMineSection(tokens, ctx) {
      if (ctx.role === 'dm') return null;
      const myToken = tokens.find((token) => token.assignedPlayerId === ctx.playerId);
      const section = el('div', 'token-list__section');
      section.appendChild(el('div', 'panel__title panel__title--sub', 'Моя фишка'));
      if (!myToken) {
        section.appendChild(el('div', 'muted', ctx.training
          ? 'Своей фишки пока нет. Создайте её формой выше — в тренировочном столе она сразу станет вашей.'
          : 'ДМ пока не назначил вам фишку. Попросите его назначить или создать фишку для вас.'));
        return section;
      }
      section.appendChild(el('div', 'token-row', myToken.name));
      const label = el('label', 'btn btn--ghost');
      label.appendChild(el('span', null, myToken.imageUrl ? 'Заменить изображение фишки' : 'Загрузить изображение фишки'));
      const file = el('input');
      file.type = 'file';
      file.accept = 'image/png,image/jpeg,image/webp';
      file.hidden = true;
      file.addEventListener('change', () => {
        const selected = file.files && file.files[0];
        file.value = '';
        if (selected && this.handlers.onSetTokenImage) this.handlers.onSetTokenImage(myToken.id, selected);
      });
      label.appendChild(file);
      section.appendChild(label);
      section.appendChild(el('div', 'muted', 'Перетаскивайте свою фишку мышью прямо по карте.'));
      return section;
    }
  }

  global.TableUI = { MapView, PlayersList, ChatPanel, DicePanel, InitiativePanel, SurfacePanel, TokenPanel, SketchEditor, formatTime };
})(window);
