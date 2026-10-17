'use strict';

/**
 * Компоненты общего стола: карта с фишками, список игроков, чат и панель кубиков.
 *
 * Координаты фишек хранятся как доли от размера карты (x и y от 0 до 1),
 * поэтому позиции совпадают у всех клиентов независимо от размера окна.
 */

(function (global) {
  const DnD = global.DnD5e;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
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
      this.previousActiveMap = null;
      this.viewedMap = null;
      this.playerPeek = null;
      this.tokens = [];
      this.players = [];
      this.grid = { enabled: false, cell: DnD.GRID.defaultCell };
      this.editing = false;
      this.editor = null;
      /** Приближение карты — личное для каждого клиента, у других не меняется. */
      this.zoom = 1;
      this.pan = { x: 0, y: 0 };
      this.dragState = null;
      this.lastEmit = 0;
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

    build() {
      this.root.innerHTML = '';
      this.root.classList.add('mapview');

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
      this.root.appendChild(tabs);

      const toolbar = el('div', 'map-toolbar');
      this.toolbar = toolbar;
      this.root.appendChild(toolbar);

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

      const layer = el('div', 'token-layer');
      this.tokenLayer = layer;
      surface.appendChild(layer);

      const empty = el('div', 'map-empty');
      empty.appendChild(el('div', 'map-empty__icon', '🗺'));
      empty.appendChild(el('div', 'map-empty__text', 'Карта ещё не загружена ДМ'));
      this.empty = empty;

      stage.appendChild(surface);
      stage.appendChild(empty);

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
      zoomBar.appendChild(zoomOut);
      zoomBar.appendChild(zoomValue);
      zoomBar.appendChild(zoomIn);
      zoomBar.appendChild(zoomReset);
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

      this.image.addEventListener('load', () => this.layoutSurface());
      if (typeof ResizeObserver === 'function') {
        this.resizeObserver = new ResizeObserver(() => {
          this.layoutSurface();
          if (this.editing && this.editor) this.editor.layout();
        });
        this.resizeObserver.observe(stage);
      }
      window.addEventListener('resize', () => {
        this.layoutSurface();
        if (this.editing && this.editor) this.editor.layout();
      });
    }

    onTabClick(type) {
      // Смена вкладки закрывает холст: рисование всегда привязано к карте,
      // поверх которой оно начато.
      if (this.editing) this.closeEditor();
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
      this.tokens = source.tokens || [];
      this.players = source.players || [];
      if (source.grid && typeof source.grid === 'object') {
        this.grid = {
          enabled: Boolean(source.grid.enabled),
          cell: Number(source.grid.cell) || DnD.GRID.defaultCell,
          columns: Number(source.grid.columns) || 0
        };
      }
      this.applyGrid();

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
        button.classList.toggle('is-active', this.viewedMap === type);
        button.classList.toggle('is-empty', this.mapCount(type) === 0);
        button.title = this.mapCount(type) > 1 ? `Карт во вкладке: ${this.mapCount(type)}` : '';
        dot.classList.toggle('is-on', isActive);
        dot.title = isActive ? 'Показана игрокам' : '';
      }

      // При смене карты сдвиг вида сбрасываем: иначе новая карта открывается
      // сдвинутой в сторону. Приближение остаётся — оно личное дело каждого.
      if (this.viewedMap !== previousViewed) this.pan = { x: 0, y: 0 };

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
    }

    /** Применяет настройки сетки стола к карте. */
    applyGrid() {
      const cell = this.effectiveCell();
      this.surface.style.setProperty('--cell', `${cell}px`);
      this.gridLayer.hidden = !this.grid.enabled;
      if (this.editor) this.editor.setGrid(cell);
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
      const columns = Number(this.grid.columns) || 0;
      if (columns > 1 && this.image && this.image.naturalWidth) {
        const fitted = Math.round(this.image.naturalWidth / columns);
        return Math.min(DnD.GRID.maxCell, Math.max(DnD.GRID.minCell, fitted));
      }
      const manual = Number(this.grid.cell) || DnD.GRID.defaultCell;
      return Math.min(DnD.GRID.maxCell, Math.max(DnD.GRID.minCell, manual));
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
      this.editorHost.hidden = true;
      this.renderToolbar();
      this.renderBody();
    }

    renderToolbar() {
      this.toolbar.innerHTML = '';
      const type = this.viewedMap;
      const map = this.mapOf(type);
      const count = this.mapCount(type);

      // Во время рисования у холста своя панель инструментов.
      if (this.editing) {
        this.toolbar.hidden = true;
        return;
      }

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
          const option = el('option', null, item.name || 'Карта');
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

      if (map && this.role === 'dm') {
        const activate = el('button', 'btn btn--ghost', this.activeMap === this.viewedMap ? '● Показана игрокам' : 'Показать игрокам');
        activate.type = 'button';
        activate.disabled = this.activeMap === this.viewedMap;
        activate.addEventListener('click', () => {
          if (this.handlers.onSetActive) this.handlers.onSetActive(this.viewedMap);
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
        this.image.onload = () => this.applyGrid();
        this.image.onerror = () => this.applyGrid();
      }
      this.layoutSurface();
      this.applyGrid();
      this.renderTokens();
    }

    renderTokens() {
      // Во время перетаскивания фишки слой не трогаем: иначе очистка снесла бы
      // ту самую фишку, которую сейчас тащат.
      if (this.dragState) return;
      const type = this.viewedMap;
      const activeMapId = (this.mapOf(type) || {}).id || '';
      // Показываем фишки той карты, что открыта. Фишка без mapId — из кампании,
      // заведённой до появления этого поля, и видна на любой карте вкладки,
      // как было раньше.
      const tokens = this.tokens.filter((token) => (
        token.mapType === type && (!token.mapId || !activeMapId || token.mapId === activeMapId)
      ));
      this.tokenLayer.innerHTML = '';

      for (const token of tokens) {
        this.tokenLayer.appendChild(this.buildToken(token));
      }
    }

    canMove(token) {
      if (this.role === 'dm') return true;
      return Boolean(token.assignedPlayerId) && token.assignedPlayerId === this.myPlayerId;
    }

    buildToken(token) {
      const node = el('div', 'token');
      const movable = this.canMove(token);
      node.classList.toggle('token--movable', movable);
      node.classList.toggle('token--mine', Boolean(token.assignedPlayerId) && token.assignedPlayerId === this.myPlayerId);
      node.dataset.tokenId = token.id;
      node.style.left = `${token.x * 100}%`;
      node.style.top = `${token.y * 100}%`;

      const circle = el('div', 'token__circle');
      if (token.imageUrl) {
        circle.style.backgroundImage = `url("${this.resolveUrl(token.imageUrl)}")`;
        circle.classList.add('token__circle--image');
      } else {
        circle.style.setProperty('--token-color', token.color || '#c96f4a');
        circle.appendChild(el('span', 'token__initial', initials(token.name)));
      }
      node.appendChild(circle);

      const label = el('div', 'token__label', token.name);
      node.appendChild(label);

      if (token.assignedPlayerId) {
        const owner = this.players.find((player) => player.playerId === token.assignedPlayerId);
        if (owner) node.appendChild(el('div', 'token__owner', owner.name));
      }

      node.addEventListener('contextmenu', (event) => {
        if (this.role !== 'dm') return;
        event.preventDefault();
        this.showTokenMenu(token, event.clientX, event.clientY);
      });

      if (movable) {
        node.addEventListener('pointerdown', (event) => this.startDrag(event, token));
      } else if (this.role !== 'dm') {
        node.addEventListener('click', () => {
          if (this.handlers.onNotice) this.handlers.onNotice('Эта фишка назначена другому игроку');
        });
      }
      return node;
    }

    showTokenMenu(token, clientX, clientY) {
      this.closeMenu();
      const menu = el('div', 'token-menu');
      menu.style.left = `${clientX}px`;
      menu.style.top = `${clientY}px`;

      const rename = el('button', 'token-menu__item', 'Переименовать');
      rename.type = 'button';
      rename.addEventListener('click', () => {
        this.closeMenu();
        if (this.handlers.onRenameToken) this.handlers.onRenameToken(token);
      });
      menu.appendChild(rename);

      const imageLabel = el('label', 'token-menu__item');
      imageLabel.appendChild(el('span', null, token.imageUrl ? 'Заменить изображение' : 'Изображение'));
      const file = el('input');
      file.type = 'file';
      file.accept = 'image/png,image/jpeg,image/webp';
      file.hidden = true;
      file.addEventListener('change', () => {
        const selected = file.files && file.files[0];
        this.closeMenu();
        if (selected && this.handlers.onSetTokenImage) this.handlers.onSetTokenImage(token.id, selected);
      });
      imageLabel.appendChild(file);
      menu.appendChild(imageLabel);

      const assign = el('div', 'token-menu__section');
      assign.appendChild(el('div', 'token-menu__title', 'Назначить игроку'));
      const select = el('select', 'select');
      const none = el('option', null, '— никому —');
      none.value = '';
      select.appendChild(none);
      for (const player of this.players) {
        if (player.role === 'dm') continue;
        const option = el('option', null, player.name);
        option.value = player.playerId;
        if (player.playerId === token.assignedPlayerId) option.selected = true;
        select.appendChild(option);
      }
      select.addEventListener('change', () => {
        this.closeMenu();
        if (this.handlers.onAssignToken) this.handlers.onAssignToken(token.id, select.value || null);
      });
      assign.appendChild(select);
      menu.appendChild(assign);

      const remove = el('button', 'token-menu__item token-menu__item--danger', 'Удалить фишку');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        this.closeMenu();
        if (this.handlers.onDeleteToken) this.handlers.onDeleteToken(token.id);
      });
      menu.appendChild(remove);

      document.body.appendChild(menu);
      this.openMenu = menu;
      // Меню закрывается по клику вне него — но не по клику внутри: если
      // убрать меню на pointerdown, кнопка исчезнет из документа раньше
      // события click, и ни один пункт (и выбор файла) не сработает.
      this.closeMenuHandler = (event) => {
        if (menu.contains(event.target)) return;
        this.closeMenu();
      };
      this.escapeHandler = (event) => {
        if (event.key === 'Escape') this.closeMenu();
      };
      setTimeout(() => {
        if (this.openMenu !== menu) return;
        document.addEventListener('pointerdown', this.closeMenuHandler, true);
        document.addEventListener('keydown', this.escapeHandler);
      }, 0);
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
      const rect = this.surface.getBoundingClientRect();
      const node = event.currentTarget;
      node.classList.add('token--dragging');
      this.dragState = { tokenId: token.id, node, rect };
      node.setPointerCapture(event.pointerId);

      const onMove = (moveEvent) => this.onDragMove(moveEvent);
      const onUp = (upEvent) => {
        node.removeEventListener('pointermove', onMove);
        node.removeEventListener('pointerup', onUp);
        node.removeEventListener('pointercancel', onUp);
        this.finishDrag(upEvent);
      };
      node.addEventListener('pointermove', onMove);
      node.addEventListener('pointerup', onUp);
      node.addEventListener('pointercancel', onUp);
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
      this.listNode = el('div', 'players');
      root.appendChild(this.listNode);
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

        if (this.role === 'dm' && player.role !== 'dm') {
          // Вывести фишку из листа можно один раз: пока у игрока её нет,
          // кнопка стоит, а после появления фишки исчезает.
          if (!player.tokenId) {
            const spawn = el('button', 'btn btn--tiny', 'Вывести');
            spawn.type = 'button';
            spawn.title = 'Создать фишку игрока из его листа, с аватаром';
            spawn.addEventListener('click', () => {
              if (this.handlers.onSpawnToken) this.handlers.onSpawnToken(player.playerId);
            });
            row.appendChild(spawn);
          }
          const open = el('button', 'btn btn--tiny', 'Открыть лист');
          open.type = 'button';
          open.addEventListener('click', () => {
            if (this.handlers.onOpenSheet) this.handlers.onOpenSheet(player.playerId);
          });
          row.appendChild(open);
        }
        this.listNode.appendChild(row);
      }
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
      const send = el('button', 'btn btn--accent', 'Отправить');
      send.type = 'submit';
      form.appendChild(send);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        if (this.handlers.onSend) this.handlers.onSend(text);
        input.value = '';
      });
      this.root.appendChild(form);
    }

    /** @param {object[]} history */
    renderAll(history) {
      this.log.innerHTML = '';
      for (const message of history) this.append(message, false);
      this.scrollToEnd();
    }

    /** @param {object} message */
    append(message, scroll = true) {
      const row = el('div', 'chat__msg');
      if (message.role === 'dm') row.classList.add('chat__msg--dm');
      if (message.isRoll) row.classList.add('chat__msg--roll');
      const head = el('div', 'chat__head');
      // Портрет только у бросков: он отвечает на «кто именно бросил», а у
      // обычной реплики автор и так виден по имени.
      if (message.isRoll && message.avatar) {
        const resolve = this.handlers.resolveUrl || ((url) => url || '');
        head.appendChild(avatarNode(resolve(message.avatar), message.from, 'chat__avatar'));
      }
      head.appendChild(el('span', 'chat__author', message.from));
      if (message.role === 'dm') head.appendChild(el('span', 'badge badge--dm', 'ДМ'));
      if (message.isRoll) head.appendChild(el('span', 'badge badge--roll', 'бросок'));
      head.appendChild(el('span', 'chat__time', formatTime(message.time)));
      row.appendChild(head);
      row.appendChild(el('div', 'chat__text', message.isRoll ? `🎲 ${message.text}` : message.text));
      this.log.appendChild(row);
      if (this.log.childElementCount > 300) this.log.removeChild(this.log.firstChild);
      if (scroll) this.scrollToEnd();
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
      this.build();
    }

    build() {
      this.root.appendChild(el('div', 'panel__title', 'Бросок кубика'));

      const controls = el('div', 'dice__controls');
      const select = el('select', 'select');
      for (let sides = 1; sides <= 20; sides += 1) {
        const option = el('option', null, `d${sides}`);
        option.value = String(sides);
        if (sides === 20) option.selected = true;
        select.appendChild(option);
      }
      this.select = select;
      controls.appendChild(select);

      const roll = el('button', 'btn btn--accent', 'Бросить');
      roll.type = 'button';
      roll.addEventListener('click', () => {
        if (this.handlers.onRoll) this.handlers.onRoll(Number(this.select.value));
      });
      controls.appendChild(roll);
      this.root.appendChild(controls);

      this.last = el('div', 'dice__last');
      this.last.hidden = true;
      this.root.appendChild(this.last);

      this.root.appendChild(el('div', 'panel__title panel__title--sub', 'История бросков'));
      this.history = el('div', 'dice__history');
      this.root.appendChild(this.history);
    }

    /** @param {object[]} history */
    renderAll(history) {
      this.history.innerHTML = '';
      for (const roll of history) this.appendRow(roll);
      this.scrollToEnd();
    }

    /** @param {object} roll */
    append(roll) {
      this.appendRow(roll);
      this.scrollToEnd();
      this.last.hidden = false;
      this.last.innerHTML = '';
      this.last.appendChild(el('span', 'dice__last-text', `${roll.playerName} бросил d${roll.sides}:`));
      const value = el('span', 'dice__last-value', String(roll.result));
      value.classList.add('is-pop');
      this.last.appendChild(value);
      setTimeout(() => value.classList.remove('is-pop'), 600);
    }

    appendRow(roll) {
      const row = el('div', 'dice__row');
      row.appendChild(el('span', 'dice__row-name', roll.playerName));
      row.appendChild(el('span', 'dice__row-die', `d${roll.sides}`));
      row.appendChild(el('span', 'dice__row-result', String(roll.result)));
      row.appendChild(el('span', 'dice__row-time', formatTime(roll.time)));
      this.history.appendChild(row);
      if (this.history.childElementCount > 200) this.history.removeChild(this.history.firstChild);
    }

    scrollToEnd() {
      this.history.scrollTop = this.history.scrollHeight;
    }
  }

  /* ====================================================================== *
   * Панель фишек ДМ
   * ====================================================================== */

  class TokenPanel {
    constructor(root, handlers = {}) {
      this.root = root;
      this.handlers = handlers;
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
      const create = el('button', 'btn btn--accent', 'Создать фишку');
      create.type = 'submit';
      form.appendChild(create);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const name = input.value.trim();
        if (this.handlers.onCreate) this.handlers.onCreate(name);
        input.value = '';
      });
      this.root.appendChild(form);
      // Фишки создаёт ДМ; игроку эта форма не нужна — кроме тренировочного
      // стола, где просить фишку не у кого.
      this.form = form;

      this.note = el('div', 'muted', 'Правый клик по фишке на карте — переименовать, назначить игроку, задать изображение или удалить.');
      this.root.appendChild(this.note);

      // Кто ещё без фишки. Живёт здесь, а не только в панели участников:
      // левую панель мастер часто сворачивает, а вывести игрока на поле
      // удобнее оттуда, где уже работают с фишками.
      this.spawnNode = el('div', 'token-spawn');
      this.root.appendChild(this.spawnNode);

      this.list = el('div', 'token-list');
      this.root.appendChild(this.list);
    }

    /**
     * @param {object[]} tokens
     * @param {object[]} players
     * @param {object} ctx
     */
    render(tokens, players, ctx) {
      const training = Boolean(ctx.training);
      const isDm = ctx.role === 'dm';
      this.form.hidden = !isDm && !training;
      this.note.hidden = !isDm && !training;
      this.note.textContent = isDm
        ? 'Правый клик по фишке на карте — переименовать, назначить игроку, задать изображение или удалить.'
        : 'Проверка без сети: созданная фишка сразу ваша — её можно двигать по карте и задать картинку.';

      this.list.innerHTML = '';
      this.renderSpawnSection(players, ctx);
      const mine = this.buildMineSection(tokens, ctx);
      if (mine) this.list.appendChild(mine);

      if (isDm) {
        const all = el('div', 'token-list__section');
        all.appendChild(el('div', 'panel__title panel__title--sub', 'Все фишки'));
        if (!tokens.length) {
          all.appendChild(el('div', 'muted', 'Фишек пока нет'));
        }
        for (const token of tokens) {
          const row = el('div', 'token-row');
          row.appendChild(el('span', 'token-row__dot'));
          row.lastChild.style.background = token.color;
          row.appendChild(el('span', 'token-row__name', token.name));
          row.appendChild(el('span', 'token-row__meta', DnD.MAP_LABELS[token.mapType]));
          const owner = players.find((player) => player.playerId === token.assignedPlayerId);
          row.appendChild(el('span', 'token-row__meta', owner ? `→ ${owner.name}` : 'не назначена'));
          const del = el('button', 'btn btn--tiny btn--danger', 'Удалить');
          del.type = 'button';
          del.addEventListener('click', () => {
            if (this.handlers.onDeleteToken) this.handlers.onDeleteToken(token.id);
          });
          row.appendChild(del);
          all.appendChild(row);
        }
        this.list.appendChild(all);
      }
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
      const waiting = players.filter((player) => player.role !== 'dm' && !player.tokenId);
      if (!waiting.length) {
        node.appendChild(el('div', 'muted', 'У всех игроков за столом уже есть фишки'));
        return;
      }
      node.appendChild(el('div', 'panel__title panel__title--sub', 'Вывести из листа'));
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

  global.TableUI = { MapView, PlayersList, ChatPanel, DicePanel, TokenPanel, SketchEditor, formatTime };
})(window);
