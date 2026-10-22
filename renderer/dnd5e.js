'use strict';

/**
 * Правила и структура листа персонажа D&D 5e (2014).
 *
 * Здесь только механика и названия полей — без текстов правил.
 * Формулы:
 *   модификатор характеристики = floor((значение - 10) / 2)
 *   бонус мастерства по уровню  = 2 + floor((уровень - 1) / 4)
 *   навык/спасбросок с владением = модификатор + бонус мастерства
 *   компетентность (expertise)   = модификатор + 2 * бонус мастерства
 *   пассивная Внимательность     = 10 + бонус Внимательности
 */

(function (global) {
  const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

  const ABILITIES = [
    { key: 'str', label: 'Сила', abbr: 'СИЛ' },
    { key: 'dex', label: 'Ловкость', abbr: 'ЛОВ' },
    { key: 'con', label: 'Телосложение', abbr: 'ТЕЛ' },
    { key: 'int', label: 'Интеллект', abbr: 'ИНТ' },
    { key: 'wis', label: 'Мудрость', abbr: 'МДР' },
    { key: 'cha', label: 'Харизма', abbr: 'ХАР' }
  ];

  /** 18 навыков D&D 5e 2014: ключ, название, характеристика. */
  const SKILLS = [
    { key: 'acrobatics', label: 'Акробатика', ability: 'dex' },
    { key: 'animalHandling', label: 'Уход за животными', ability: 'wis' },
    { key: 'arcana', label: 'Магия', ability: 'int' },
    { key: 'athletics', label: 'Атлетика', ability: 'str' },
    { key: 'deception', label: 'Обман', ability: 'cha' },
    { key: 'history', label: 'История', ability: 'int' },
    { key: 'insight', label: 'Проницательность', ability: 'wis' },
    { key: 'intimidation', label: 'Запугивание', ability: 'cha' },
    { key: 'investigation', label: 'Анализ', ability: 'int' },
    { key: 'medicine', label: 'Медицина', ability: 'wis' },
    { key: 'nature', label: 'Природа', ability: 'int' },
    { key: 'perception', label: 'Внимательность', ability: 'wis' },
    { key: 'performance', label: 'Выступление', ability: 'cha' },
    { key: 'persuasion', label: 'Убеждение', ability: 'cha' },
    { key: 'religion', label: 'Религия', ability: 'int' },
    { key: 'sleightOfHand', label: 'Ловкость рук', ability: 'dex' },
    { key: 'stealth', label: 'Скрытность', ability: 'dex' },
    { key: 'survival', label: 'Выживание', ability: 'wis' }
  ];


  const ABILITY_LABELS = ABILITIES.reduce((acc, ability) => {
    acc[ability.key] = ability.label;
    return acc;
  }, {});

  const HIT_DICE = ['1d6', '1d8', '1d10', '1d12'];

  /**
   * Классы D&D 5e (2014) и их кости хитов.
   *
   * Подкласс сюда не входит: его названий слишком много и они зависят от
   * дополнений, поэтому подкласс в листе остаётся свободным полем.
   */
  const CLASSES = [
    { label: 'Варвар', hitDie: 'd12' },
    { label: 'Бард', hitDie: 'd8' },
    { label: 'Воин', hitDie: 'd10' },
    { label: 'Волшебник', hitDie: 'd6' },
    { label: 'Друид', hitDie: 'd8' },
    { label: 'Жрец', hitDie: 'd8' },
    { label: 'Колдун', hitDie: 'd8' },
    { label: 'Монах', hitDie: 'd8' },
    { label: 'Паладин', hitDie: 'd10' },
    { label: 'Плут', hitDie: 'd8' },
    { label: 'Следопыт', hitDie: 'd10' },
    { label: 'Чародей', hitDie: 'd6' }
  ];

  /**
   * Достаёт число граней из записи кости хитов: «1d8», «d10», «5d8».
   * @param {unknown} value
   * @returns {number|null} null, если запись не похожа на кость.
   */
  function hitDieSides(value) {
    const match = String(value || '').match(/(\d*)d(\d+)/i);
    if (!match) return null;
    const sides = Number(match[2]);
    return Number.isInteger(sides) && sides >= 2 && sides <= 100 ? sides : null;
  }

  /** Больше этого классов на одном листе не бывает: мультикласс обычно 2-3. */
  const MAX_CLASS_ENTRIES = 6;

  /**
   * Кость хитов класса по его названию.
   * @param {unknown} name
   * @returns {string|null}
   */
  function classHitDie(name) {
    const value = String(name || '').trim().toLowerCase();
    if (!value) return null;
    const found = CLASSES.find((item) => item.label.toLowerCase() === value);
    return found ? found.hitDie : null;
  }

  /**
   * Приводит список классов листа к чистому виду: имя + уровень, без пустых
   * строк, уровень 1..20, суммарно не больше 20 уровней.
   * @param {unknown} value
   * @returns {{name: string, level: number}[]}
   */
  function normalizeClasses(value) {
    const list = Array.isArray(value) ? value : [];
    const result = [];
    let sum = 0;
    for (const entry of list) {
      if (result.length >= MAX_CLASS_ENTRIES) break;
      const name = String((entry && entry.name) || '').trim().slice(0, LIMITS.maxClassLength);
      if (!name) continue;
      const room = LIMITS.maxLevel - sum;
      if (room <= 0) break;
      const level = Math.min(clampNumber(entry && entry.level, LIMITS.minLevel, LIMITS.maxLevel, 1), room);
      result.push({ name, level });
      sum += level;
    }
    return result;
  }

  /**
   * Классы листа. Лист старого формата (один класс и уровень) читается как
   * один класс, чтобы мультикласс не ломал уже заполненные листы.
   * @param {object} sheet
   * @returns {{name: string, level: number}[]}
   */
  function classLevels(sheet) {
    const raw = sheet && typeof sheet === 'object' ? sheet : {};
    const list = normalizeClasses(raw.classes);
    if (list.length) return list;
    const name = String(raw.charClass || '').trim();
    if (!name) return [];
    return [{
      name: name.slice(0, LIMITS.maxClassLength),
      level: clampNumber(raw.level, LIMITS.minLevel, LIMITS.maxLevel, 1)
    }];
  }

  /** Суммарный уровень персонажа: он же уровень для бонуса мастерства. */
  function totalCharacterLevel(sheet) {
    const list = classLevels(sheet);
    if (!list.length) {
      return clampNumber(sheet && sheet.level, LIMITS.minLevel, LIMITS.maxLevel, 1);
    }
    const sum = list.reduce((acc, entry) => acc + entry.level, 0);
    return Math.min(LIMITS.maxLevel, Math.max(LIMITS.minLevel, sum));
  }

  /**
   * Пул костей хитов: по одной записи на каждый размер кости. У Воина 5 /
   * Волшебника 3 выходит d10×5 и d6×3.
   * @param {object} sheet
   * @returns {{die: string, sides: number, count: number}[]}
   */
  function hitDicePool(sheet) {
    /** @type {Map<string, {die: string, sides: number, count: number}>} */
    const pool = new Map();
    for (const entry of classLevels(sheet)) {
      const die = classHitDie(entry.name);
      const sides = hitDieSides(die);
      if (!die || !sides) continue;
      const current = pool.get(die) || { die, sides, count: 0 };
      current.count += entry.level;
      pool.set(die, current);
    }
    if (!pool.size) {
      const sides = hitDieSides(sheet && sheet.hitDice);
      if (sides) pool.set(`d${sides}`, { die: `d${sides}`, sides, count: 1 });
    }
    return [...pool.values()];
  }

  /**
   * Суммарный уровень полных заклинателей: так считаются общие ячейки у
   * мультикласса. Полукластеры (паладин, следопыт) намеренно не в счёте: своей
   * таблицы у них нет, а приложение не выдумывает числа.
   */
  function combinedCasterLevel(sheet) {
    let sum = 0;
    for (const entry of classLevels(sheet)) {
      if (FULL_CASTER_CLASSES.includes(entry.name.trim().toLowerCase())) sum += entry.level;
    }
    return sum;
  }

  /** Строка ячеек по суммарному уровню полных заклинателей (или null). */
  function casterSlotRow(sheet) {
    const level = combinedCasterLevel(sheet);
    if (!level) return null;
    const lv = Math.max(1, Math.min(20, level));
    return (FULL_CASTER_SLOTS[lv - 1] || FULL_CASTER_SLOTS[0]).slice();
  }

  const MAP_TYPES = ['world', 'battle', 'sketch'];
  const MAP_LABELS = {
    world: 'Общая карта',
    battle: 'Карта локации / битвы',
    sketch: 'Рисунок'
  };

  /**
   * Сетка на карте: клетка ровно по размеру фишки, размер в пикселях карты.
   *
   * Те же границы, что в server/state.js: иначе интерфейс предложил бы мастеру
   * клетку, которую сервер всё равно обрежет по своим пределам.
   */
  /**
 * Состояния поверхности, которые мастер рисует по клеткам.
 *
 * Это не то же самое, что состояния фишки: кислота лежит на полу и жжёт всех,
 * кто по ней прошёл, а «опутан» держит конкретного героя. Читается сервером и
 * интерфейсом, поэтому список один.
 *
 * Цвет здесь — содержимое карты, а не оформление окна: им красится клетка на
 * холсте, и менять его должна тема оформления не вместе с палитрой интерфейса.
 */
const SURFACE_TYPES = [
    { id: 'fire', label: 'Огонь', short: 'огонь', color: '#e0702c' },
    { id: 'acid', label: 'Кислота', short: 'кислота', color: '#a86ed8' },
    { id: 'water', label: 'Вода', short: 'вода', color: '#3f8fd0' },
    { id: 'ice', label: 'Лёд', short: 'лёд', color: '#9fd8e8' },
    { id: 'poison', label: 'Яд', short: 'яд', color: '#7fb23f' },
    { id: 'slick', label: 'Скользкость', short: 'скользко', color: '#c9b46a' },
    { id: 'smoke', label: 'Дым', short: 'дым', color: '#8b8b93' },
    { id: 'rubble', label: 'Руины', short: 'руины', color: '#8d7a63' }
  ];

  /** Типы поверхности: сервер отбрасывает всё, чего в списке нет. */
  const SURFACE_IDS = new Set(SURFACE_TYPES.map((item) => item.id));

  /**
   * Приводит клетки поверхности к виду, который согласуют клиент и сервер.
   *
   * Приходит из файла кампании и из сообщений, поэтому здесь отсекаются
   * несуществующие типы, дробные координаты и всё, что дальше полутора
   * тысяч клеток: карта на 200x200 — это уже не поверхность, а ошибка.
   * @param {unknown} raw
   * @returns {{cells: Record<string, string>}}
   */
  function normalizeSurface(raw) {
    const cells = {};
    const source = raw && typeof raw === 'object' ? raw.cells : null;
    if (!source || typeof source !== 'object') return { cells };
    for (const [key, value] of Object.entries(source)) {
      if (Object.keys(cells).length >= 1500) break;
      const parts = String(key).split(',');
      if (parts.length !== 2) continue;
      const col = Number.parseInt(parts[0], 10);
      const row = Number.parseInt(parts[1], 10);
      if (!Number.isInteger(col) || !Number.isInteger(row)) continue;
      if (col < 0 || row < 0) continue;
      const type = String(value || '');
      if (!SURFACE_IDS.has(type)) continue;
      cells[`${col},${row}`] = type;
    }
    return { cells };
  }

const GRID = {
    minCell: 8,
    maxCell: 512,
    defaultCell: 46,
    minColumns: 2,
    maxColumns: 200,
    // Сетку надо не только растянуть, но и положить на картинку. Число клеток
    // по ширине берётся с половиной: картинка на 1600 пикселей при 37 клетках
    // даёт 43.24 пикселя на клетку, и целое число клеток сетку клало бы на
    // картинку с ошибкой в несколько пикселей на всю ширину.
    minColumnsStep: 0.5,
    // Сдвиг сетки в пикселях картинки: у готовой карты своя сетка начинается не
    // обязательно с левого верхнего угла, и без сдвига наша сетка на полклетки
    // отстаёт от неё.
    maxOffset: 4096,
    // Футов в клетке. Правила 5e держат клетку в пяти футах, и без этого
    // числа дальность света («факел светит на 20 футов») переводить в клетки
    // нечем. Мастер может поставить своё: на картах с другой мерой это иначе
    // не выразить.
    minFeetPerCell: 1,
    maxFeetPerCell: 50,
    defaultFeetPerCell: 5
  };

  /**
   * Округляет число клеток по ширине до половины клетки.
   *
   * Полклетки — предел разумного: точнее сетку поставить нечем, картинку мастер
   * всё равно меряет на глаз по её клеткам.
   * @param {unknown} value
   * @returns {number}
   */
  function roundColumns(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.round(number / GRID.minColumnsStep) * GRID.minColumnsStep;
  }

  /**
   * Приводит настройки сетки к виду, который согласуют клиент и сервер.
   *
   * Правила живут здесь, потому что их читают и снимок состояния, и сообщение
   * о смене сетки, и кампания на диске. Своя копия в сервере разъехалась бы с
   * интерфейсом при первом же изменении пределов.
   * @param {unknown} raw
   * @returns {{enabled: boolean, cell: number, columns: number, feetPerCell: number, offsetX: number, offsetY: number}}
   */
  function normalizeGrid(raw) {
    const grid = raw && typeof raw === 'object' ? raw : {};
    const clamp = (value, min, max, fallback) => {
      const number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.min(max, Math.max(min, number));
    };
    const offsetX = Math.round(clamp(grid.offsetX, -GRID.maxOffset, GRID.maxOffset, 0));
    const offsetY = Math.round(clamp(grid.offsetY, -GRID.maxOffset, GRID.maxOffset, 0));
    return {
      enabled: Boolean(grid.enabled),
      // Пределы зажимаются, а не отбрасываются: мастер ввёл 900, и клетка в 900
      // пикселей бесполезна, но клетка по крайнему пределу всё ещё осмысленна.
      cell: Math.round(clamp(grid.cell, GRID.minCell, GRID.maxCell, GRID.defaultCell)),
      columns: clamp(roundColumns(grid.columns), 0, GRID.maxColumns, 0),
      feetPerCell: Math.round(clamp(
        grid.feetPerCell,
        GRID.minFeetPerCell,
        GRID.maxFeetPerCell,
        GRID.defaultFeetPerCell
      )),
      offsetX,
      offsetY
    };
  }

  /**
   * Размер клетки в пикселях картинки.
   *
   * Если мастер задал число клеток по ширине, клетка считается от настоящей
   * ширины подложки и не округляется: округление здесь ровно то, из-за чего
   * сетка ложилась на картинку не до конца. Фишка рисуется тем же размером и
   * занимает ровно одну клетку.
   * @param {object} grid
   * @param {number} naturalWidth ширина картинки в пикселях
   * @returns {number}
   */
  function gridCellSize(grid, naturalWidth) {
    const columns = Number(grid && grid.columns) || 0;
    const width = Number(naturalWidth) || 0;
    if (columns > 1 && width > 0) {
      const fitted = width / columns;
      return Math.min(GRID.maxCell, Math.max(GRID.minCell, fitted));
    }
    const manual = Number(grid && grid.cell) || GRID.defaultCell;
    return Math.min(GRID.maxCell, Math.max(GRID.minCell, manual));
  }

  /**
   * Источники света из правил 5e.
   *
   * Дальность в футах, а не в клетках: у правил своя мерка, и мастер должен
   * видеть ровно то, что написано в книге. Пересчёт в клетки — уже забота
   * сетки (см. GRID.feetPerCell).
   *
   * Цвет у каждого свой, и он виден в игре: факел и костёр жгут жёлтым,
   * лунный свет холодный и синий, огонь на болоте зеленоватый. Пять оттенков
   * на все случаи не хватило бы, поэтому у каждого источника есть готовая
   * палитра, а мастер может подвинуть её, если захочет.
   */
  const LIGHT_PRESETS = [
    { id: 'torch', label: 'Факел', radius: 20, color: '#ffab4d' },
    { id: 'lantern', label: 'Фонарь', radius: 30, color: '#ffd27a' },
    { id: 'campfire', label: 'Костёр', radius: 40, color: '#ff8b3d' },
    { id: 'candle', label: 'Свеча', radius: 5, color: '#fff0c2' },
    { id: 'hood', label: 'Фонарь в капюшоне', radius: 10, color: '#b9c8ff' },
    { id: 'moon', label: 'Лунный свет', radius: 60, color: '#7d9cff' },
    { id: 'stars', label: 'Свет звёзд', radius: 80, color: '#9fd0ff' },
    { id: 'torchlight', label: 'Свет фонаря на клинке', radius: 25, color: '#ffc27a' },
    { id: 'will-o-wisp', label: 'Болотный огонь', radius: 20, color: '#8ef0a8' },
    { id: 'arcane', label: 'Волшебный свет', radius: 30, color: '#c49bff' },
    { id: 'blood', label: 'Красный свет', radius: 20, color: '#ff6b6b' },
    { id: 'daylight', label: 'Дневной свет', radius: 120, color: '#fff6e0' }
  ];

  /**
   * Ночной тон: каким выглядит неосвещённая карта.
   *
   * Не чёрный: ночью темно, а не мёртво, и синеватый тон читается как ночь
   * лучше, чем любая дымка.
   */
  const LIGHT_AMBIENT = '#080a18';

  /**
   * Холст для рисования карты. Размер холста складывается из клеток сетки,
   * поэтому здесь только предел по большой стороне.
   */
  const SKETCH = { maxSide: 1600 };

  /**
   * Настоящие кости D&D: шесть основных плюс сотня для процентных бросков.
   *
   * В игре нет кубиков на три, пять или семь граней, поэтому в списке их нет:
   * раньше панель предлагала все двадцать, и половина вариантов не имела
   * никакого смысла. Сервер проверяет бросок по тому же списку, так что
   * «лишнюю» кость нельзя подсунуть и сообщением.
   *
   * Дублируется в server/state.js — renderer не может потребовать серверный
   * файл. Списки сверяются проверкой в test/integration.js.
   */
  const DICE_SIDES = [4, 6, 8, 10, 12, 20, 100];

  /**
   * Состояния по правилам 5e для фишек и персонажей.
   *
   * Список один на клиента и сервер: сервер отбрасывает всё, чего здесь нет, а
   * интерфейс рисует только то, что есть. Своя копия на стороне сервера
   * разъехалась бы на первом же новом состоянии.
   *
   * «Без сознания» здесь нет намеренно: оно не состояние, а следствие нулевых
   * хитов, и показывается само. Истощение тоже не включено: у него уровни от
   * одного до шести, а здесь переключатели включены и выключены.
   */
  /**
   * Туман войны.
   *
   * Открытые участки хранятся не списком прямоугольников, а крупной сеткой
   * букв: одна карта при 64 на 40 клетки это 2560 символов, и размер не растёт
   * от того, сколько раз мастер провёл кистью. Прямоугольники копились бы
   * беспрерывно и за пару часов игры превратили кампанию в мусор.
   *
   * Символ '1' означает открытую клетку, '0' закрытую. Разрешение выбрано
   * под кисть, которой удобно водить: клетка это примерно полтора процента
   * ширины карты, и края тумана выглядят ровно, а не лесенкой.
   * @type {{columns: number, rows: number, mask: string}}
   */
  const FOG = { columns: 64, rows: 40, open: '1', closed: '0' };

  /**
   * Пустая маска тумана: вся карта закрыта.
   * @returns {string}
   */
  function newFogMask() {
    return FOG.closed.repeat(FOG.columns * FOG.rows);
  }

  /**
   * Приводит маску из кампании к нужному размеру.
   *
   * Маска может достаться от другой версии игры или быть правлена руками, а
   * размер нужен ровно такой, чтобы клетка адресовалась по индексу.
   * @param {unknown} raw
   * @returns {string}
   */
  function normalizeFogMask(raw) {
    const size = FOG.columns * FOG.rows;
    const mask = typeof raw === 'string' ? raw.replace(/[^01]/g, '') : '';
    if (mask.length === size) return mask;
    if (!mask.length) return newFogMask();
    // Длина не совпала: обрезаем или дополняем закрытыми клетками, иначе
    // индексы поедут и карта покроется дырами в неожиданных местах.
    return (mask + FOG.closed.repeat(size)).slice(0, size);
  }

  /**
   * Открывает участок карты кистью.
   *
   * Работает прямо по строке маски и возвращает её целиком: раз в конце
   * вызывать пришлось бы гонять по всей строке на каждое движение мыши.
   * @param {string} mask Текущая маска.
   * @param {number} x Центр кисти по ширине, от 0 до 1.
   * @param {number} y Центр кисти по высоте, от 0 до 1.
   * @param {number} radius Радиус кисти по ширине карты, от 0.02 до 0.5.
   * @returns {string}
   */
  function openFogAt(mask, x, y, radius) {
    const size = FOG.columns * FOG.rows;
    const current = mask && mask.length === size ? mask : normalizeFogMask(mask);
    const r = Math.max(0.02, Math.min(0.5, Number(radius) || 0.12));
    const cx = Math.max(0, Math.min(1, Number(x) || 0));
    const cy = Math.max(0, Math.min(1, Number(y) || 0));
    const halfX = Math.max(1, Math.round(r * FOG.columns));
    const halfY = Math.max(1, Math.round(r * FOG.rows));
    const fromX = Math.max(0, Math.floor(cx * FOG.columns) - halfX);
    const toX = Math.min(FOG.columns - 1, Math.ceil(cx * FOG.columns) + halfX);
    const fromY = Math.max(0, Math.floor(cy * FOG.rows) - halfY);
    const toY = Math.min(FOG.rows - 1, Math.ceil(cy * FOG.rows) + halfY);
    // Круг, а не квадрат: кисть по краям карты должна давать круглый край,
    // иначе открывается угол, которого никто не открывал.
    const cells = [];
    for (let row = fromY; row <= toY; row += 1) {
      for (let column = fromX; column <= toX; column += 1) {
        const cellX = (column + 0.5) / FOG.columns;
        const cellY = (row + 0.5) / FOG.rows;
        const dx = (cellX - cx) / Math.max(1e-6, halfX / FOG.columns);
        const dy = (cellY - cy) / Math.max(1e-6, halfY / FOG.rows);
        if (dx * dx + dy * dy <= 1) cells.push(row * FOG.columns + column);
      }
    }
    let next = '';
    let index = 0;
    for (const cell of cells) {
      next += current.slice(index, cell) + FOG.open;
      index = cell + 1;
    }
    return next + current.slice(index);
  }

  /**
   * Открывает всю карту или снова закрывает её целиком.
   * @param {string} mask
   * @param {boolean} open
   * @returns {string}
   */
  function setFogWhole(mask, open) {
    return open ? FOG.open.repeat(FOG.columns * FOG.rows) : newFogMask();
  }

  /**
   * Есть ли на карте хоть что-то открытое.
   *
   * По этому признаку карта решает, рисовать ли туман: над картой без
   * открытых участков тёмный слой выглядит как поломка, а не как замысел мастера.
   * @param {string} mask
   * @returns {boolean}
   */
  function fogHasOpenArea(mask) {
    return typeof mask === 'string' && mask.indexOf(FOG.open) >= 0;
  }

  /* ====================================================================== *
   * Освещение: стены, источники света и то, что из них видно
   * ====================================================================== */

  /** Пределы на карту. Стен и источников на стол больше не становится. */
  const LIGHT_LIMITS = {
    maxWalls: 400,
    maxLights: 80,
    minRadius: 1,
    maxRadius: 200,
    /** Лучей по окружности источника: 64 дают круг, неотличимый от настоящего. */
    rays: 64
  };

  /**
   * Стена: отрезок, который держит свет.
   *
   * Координаты — доли от ширины и высоты карты, ровно как у фишек. Тогда стена
   * не зависит от того, как мастер приблизил карту, и переживает смену экрана.
   * Обе точки лежат на карте по разные стороны, иначе это не стена, а точка.
   */
  function normalizeWall(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const x1 = Number(raw.x1);
    const y1 = Number(raw.y1);
    const x2 = Number(raw.x2);
    const y2 = Number(raw.y2);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
    const ax = Math.max(0, Math.min(1, x1));
    const ay = Math.max(0, Math.min(1, y1));
    const bx = Math.max(0, Math.min(1, x2));
    const by = Math.max(0, Math.min(1, y2));
    // Точка или почти точка свет не держит: стеной она считаться не должна.
    if (Math.hypot(bx - ax, by - ay) < 0.004) return null;
    return {
      id: String(raw.id || '').slice(0, 40),
      x1: ax,
      y1: ay,
      x2: bx,
      y2: by
    };
  }

  /**
   * Стены карты из того, что пришло из кампании или с сервера.
   *
   * Чинится здесь же, а не на клиенте: битая стена из файла иначе портила бы
   * расчёт света у всех участников стола сразу.
   * @param {unknown} raw
   * @returns {object[]}
   */
  function normalizeWalls(raw) {
    if (!Array.isArray(raw)) return [];
    const result = [];
    for (const item of raw.slice(0, LIGHT_LIMITS.maxWalls)) {
      const wall = normalizeWall(item);
      if (wall) result.push(wall);
    }
    return result;
  }

  /**
   * Источник света из того, что пришло из кампании или с сервера.
   * @param {unknown} raw
   * @returns {object|null}
   */
  function normalizeLight(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const x = Number(raw.x);
    const y = Number(raw.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const radius = clampNumber(raw.radius, LIGHT_LIMITS.minRadius, LIGHT_LIMITS.maxRadius, 20);
    const color = typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : '#ffb347';
    return {
      id: String(raw.id || '').slice(0, 40),
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      radius: Math.round(radius),
      color,
      // Тусклый свет по правилам светит вдвое меньше яркого и темноту выедает
      // не до конца: в нём видно силуэты, но не детали. Поэтому это не яркость,
      // а вдвое меньший радиус вдобавок с приглушённым пятном.
      dim: Boolean(raw.dim),
      // Спрятанный источник мастер гасит на время, не удаляя: у костра за
      // закрытой дверью свет нужен снова, как только дверь откроют.
      hidden: Boolean(raw.hidden)
    };
  }

  /**
   * Источники света карты.
   * @param {unknown} raw
   * @returns {object[]}
   */
  function normalizeLights(raw) {
    if (!Array.isArray(raw)) return [];
    const result = [];
    for (const item of raw.slice(0, LIGHT_LIMITS.maxLights)) {
      const light = normalizeLight(item);
      if (light) result.push(light);
    }
    return result;
  }

  /**
   * Размер сетки карты в клетках.
   *
   * Стол знает только число клеток по ширине (`grid.columns`), а по высоте их
   * столько, сколько выходит из пропорций картинки. Без пропорций свет считал
   * бы круги ованами: на карте вдвое длиннее горизонтали круг растянулся бы.
   * @param {object} grid
   * @param {number} aspect Отношение ширины картинки к высоте.
   * @returns {{columns: number, rows: number, feetPerCell: number}}
   */
  function lightGrid(grid, aspect) {
    const safe = grid && typeof grid === 'object' ? grid : {};
    const ratio = Number(aspect);
    // Пропорции неизвестны: считаем карту квадратной по клеткам, а не
    // полудлинной. Ошибка в два раза лучше, чем карта высотой в одну клетку.
    const width = Number(safe.columns) > 0 ? Number(safe.columns) : GRID.maxColumns;
    const usable = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    return {
      columns: Math.max(GRID.minColumns, Math.round(width)),
      rows: Math.max(1, Math.round(width / usable)),
      feetPerCell: clampNumber(
        safe.feetPerCell,
        GRID.minFeetPerCell,
        GRID.maxFeetPerCell,
        GRID.defaultFeetPerCell
      )
    };
  }

  /**
   * Луч из источника: где он впервые упрётся в стену.
   *
   * Ищется пересечение луча с отрезком. Возвращает расстояние до стены в
   * клетках либо `limit`, если луч ни во что не попал.
   * @param {number} ox
   * @param {number} oy
   * @param {number} dx
   * @param {number} dy
   * @param {number} limit
   * @param {object[]} walls В клетках.
   * @returns {number}
   */
  function castRay(ox, oy, dx, dy, limit, walls) {
    let best = limit;
    for (const wall of walls) {
      // Параметры луча: P = O + t*D, отрезка: P = A + u*(B-A).
      const ex = wall.x2 - wall.x1;
      const ey = wall.y2 - wall.y1;
      const denominator = dx * ey - dy * ex;
      // Параллельные: либо лежат на одной прямой, либо не пересекутся вовсе.
      if (Math.abs(denominator) < 1e-9) continue;
      const t = ((wall.x1 - ox) * ey - (wall.y1 - oy) * ex) / denominator;
      const u = ((wall.x1 - ox) * dy - (wall.y1 - oy) * dx) / denominator;
      if (t <= 1e-6 || u < 0 || u > 1) continue;
      if (t < best) best = t;
    }
    return best;
  }

  /**
   * Расстояние от точки до отрезка.
   *
   * Именно до отрезка, а не до ближайшего его конца: стена длиной в двадцать
   * клеток может подходить вплотную к источнику посередине, и по концам вышло
   * бы, что она далеко и тени не даёт.
   * @param {number} px
   * @param {number} py
   * @param {number} x1
   * @param {number} y1
   * @param {number} x2
   * @param {number} y2
   * @returns {number}
   */
  function distanceToSegment(px, py, x1, y1, x2, y2) {
    const ex = x2 - x1;
    const ey = y2 - y1;
    const lengthSquared = ex * ex + ey * ey;
    if (lengthSquared < 1e-12) return Math.hypot(px - x1, py - y1);
    const t = Math.max(0, Math.min(1, ((px - x1) * ex + (py - y1) * ey) / lengthSquared));
    return Math.hypot(px - (x1 + ex * t), py - (y1 + ey * t));
  }

  /**
   * Многоугольник, освещённый источником.
   *
   * Классический приём для света в играх: луч кидается на каждый угол стены и
   * на каждую из двух соседних точек чуть вбок. Свет, прошедший мимо угла,
   * даёт тонкий «щель» в тени за стеной, и край получается ровным, а не
   * ступенчатым. Без крайних лучей углы выглядели бы обрезанными по прямой.
   *
   * Всё считается в клетках, а не в долях карты: клетки квадратные, и круг света
   * получается круглым на любой карте.
   * @param {object} light Источник в долях карты.
   * @param {object[]} walls Стены в клетках.
   * @param {{columns: number, rows: number, feetPerCell: number}} grid
   * @returns {{points: Array<[number, number]>, radiusCells: number}}
   */
  function lightPolygon(light, walls, grid) {
    const columns = Math.max(1, grid.columns);
    const rows = Math.max(1, grid.rows);
    // Тусклый свет по правилам светит вдвое меньше яркого, поэтому половина
    // берётся здесь, вместе с остальными правилами света, а не в отрисовке:
    // иначе тень от тусклого огня отличалась бы от тени яркого того же
    // радиуса, а не стала бы ею вдвое короче.
    const reach = light.dim ? Math.max(LIGHT_LIMITS.minRadius, light.radius / 2) : light.radius;
    const radiusCells = Math.max(
      LIGHT_LIMITS.minRadius,
      reach / Math.max(0.001, grid.feetPerCell)
    );
    const ox = light.x * columns;
    const oy = light.y * rows;
    const segments = walls.filter((wall) => (
      // За пределами досягаемости стена тени не даёт, и считать её незачем.
      distanceToSegment(ox, oy, wall.x1, wall.y1, wall.x2, wall.y2) < radiusCells + 1
    ));

    // Круг без стен должен быть кругом, а для этого по окружности идёт много
    // лучей, а не четыре по сторонам света. С четырьмя лучами многоугольник
    // выходил ромбом, и пятно обрезалось им вместо круга: на карте без стен
    // факел светил квадратом, повёрнутым на сорок пять градусов.
    //
    // Шестьдесят четыре луча дают правильный многоугольник: при растягивании
    // на карту разница с кругом уже не видна, а лишних лучей считать незачем.
    const angles = [];
    for (let step = 0; step < LIGHT_LIMITS.rays; step += 1) {
      angles.push((step / LIGHT_LIMITS.rays) * Math.PI * 2);
    }
    // Плюс по три луча на каждый угол стены: свет, прошедший мимо угла, даёт
    // тонкую щель в тени за стеной, и край получается ровным, а не ступенчатым.
    for (const wall of segments) {
      for (const [px, py] of [[wall.x1, wall.y1], [wall.x2, wall.y2]]) {
        const base = Math.atan2(py - oy, px - ox);
        angles.push(base - 0.0006, base, base + 0.0006);
      }
    }
    angles.sort((a, b) => a - b);

    const points = [];
    for (const angle of angles) {
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const distance = castRay(ox, oy, dx, dy, radiusCells, segments);
      points.push([ox + dx * distance, oy + dy * distance]);
    }
    return { points, radiusCells };
  }

  /**
   * Стены в клетках: так же, как фишки лежат в долях карты, но свет считается
   * в квадратной мере.
   * @param {object[]} walls
   * @param {{columns: number, rows: number}} grid
   * @returns {object[]}
   */
  function wallsInCells(walls, grid) {
    const columns = Math.max(1, grid.columns);
    const rows = Math.max(1, grid.rows);
    return (walls || []).map((wall) => ({
      x1: wall.x1 * columns,
      y1: wall.y1 * rows,
      x2: wall.x2 * columns,
      y2: wall.y2 * rows
    }));
  }

  /**
   * Насколько карта сейчас тёмная, с точки зрения мастера и игрока.
   *
   * Разница та же, что у тумана: мастер должен видеть, где темно, иначе он не
   * отличит свою ошибку от замысла, а игроку нужен сплошной мрак.
   * @param {number} darkness Доля темноты от 0 до 1.
   * @param {boolean} isDm
   * @returns {number}
   */
  function darknessAlpha(darkness, isDm) {
    const value = clampNumber(darkness, 0, 1, 0);
    if (value <= 0) return 0;
    // Мастер видит темноту, но не тонет в ней: верхняя граница 235 против 255.
    return Math.round(value * 255 * (isDm ? 0.92 : 1));
  }

  /**
   * Ячейки заклинаний по уровням: девять ступеней, девятой нет у части классов.
   *
   * Список один на клиента и сервер, а таблица по уровням живёт тут: считать
   * её на сервере нельзя, она пришла бы второй копией и разошлась бы с
   * интерфейсом при первой же правке правил.
   */
  const SPELL_SLOT_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

  /**
   * Ячейки полного заклинателя: строки по уровню персонажа, столбцы по ступени
   * заклинания.
   *
   * Таблица из правил 5e, одинаковая для барда, жреца, друида, чародея и
   * волшебника. Первая строка это первый уровень персонажа: две ячейки первой
   * ступени. У пятого уровня жреца четыре ячейки первой, три второй и три
   * третьей, а девятых нет вовсе.
   *
   * Таблица именно двумерная. Раньше здесь лежал ряд «сколько ячеек первого
   * уровня у персонажа N уровня», и он раздавался девяти ступеням одинаково:
   * пятиуровневому жрецу показывало по четыре ячейки первого, второго,
   * третьего и всех остальных уровней сразу.
   * @type {number[][]}
   */
  const FULL_CASTER_SLOTS = [
    [2, 0, 0, 0, 0, 0, 0, 0, 0],
    [3, 0, 0, 0, 0, 0, 0, 0, 0],
    [4, 2, 0, 0, 0, 0, 0, 0, 0],
    [4, 3, 0, 0, 0, 0, 0, 0, 0],
    [4, 3, 3, 0, 0, 0, 0, 0, 0],
    [4, 3, 3, 3, 0, 0, 0, 0, 0],
    [4, 4, 3, 3, 0, 0, 0, 0, 0],
    [4, 4, 3, 3, 1, 0, 0, 0, 0],
    [4, 4, 3, 3, 2, 0, 0, 0, 0],
    [4, 4, 3, 3, 2, 1, 0, 0, 0],
    [4, 4, 3, 3, 2, 1, 0, 0, 0],
    [4, 4, 3, 3, 2, 1, 1, 0, 0],
    [4, 4, 3, 3, 2, 1, 1, 0, 0],
    [4, 4, 3, 3, 2, 1, 1, 1, 0],
    [4, 4, 3, 3, 2, 1, 1, 1, 0],
    [4, 4, 3, 3, 2, 1, 1, 1, 1],
    [4, 4, 3, 3, 2, 1, 1, 1, 1],
    [4, 4, 3, 3, 3, 1, 1, 1, 1],
    [4, 4, 3, 3, 3, 2, 1, 1, 1],
    [4, 4, 3, 3, 3, 2, 2, 1, 1]
  ];

  /**
   * Классы, у которых ячейки идут по полной таблице.
   *
   * Полупоклинатели и warlock сюда не входят намеренно: у них своя арифметика и
   * свои особые правила, а половина ступеней у них вовсе не считается. Для них
   * приложение показывает прочерк и предлагает вписать своё число, вместо
   * того чтобы выдумывать.
   *
   * Названия продублированы на английский: класс в листе это свободный текст,
   * и «Wizard» встречается не реже, чем «волшебник».
   * @type {string[]}
   */
  const FULL_CASTER_CLASSES = [
    'бард', 'bard', 'жрец', 'cleric', 'друид', 'druid',
    'чародей', 'sorcerer', 'волшебник', 'wizard'
  ];

  /**
   * Сколько ячеек положено классу на уровне персонажа, по каждой ступени.
   *
   * @param {string} charClass Класс из листа, в любом регистре.
   * @param {number} level Уровень персонажа.
   * @returns {number[]|null} Девять чисел или null, когда класс не заклинатель.
   */
  function spellSlotRow(charClass, level) {
    const name = String(charClass || '').trim().toLowerCase();
    if (!FULL_CASTER_CLASSES.includes(name)) return null;
    const lv = Math.max(1, Math.min(20, Math.round(Number(level) || 1)));
    return (FULL_CASTER_SLOTS[lv - 1] || FULL_CASTER_SLOTS[0]).slice();
  }

  /**
   * Одна ступень: сколько ячеек у класса конкретной ступени.
   * @param {string} charClass
   * @param {number} level
   * @param {number} slotLevel
   * @returns {number|null}
   */
  function spellSlotMax(charClass, level, slotLevel) {
    const row = spellSlotRow(charClass, level);
    if (!row) return null;
    const index = SPELL_SLOT_LEVELS.indexOf(slotLevel);
    return index < 0 ? null : row[index];
  }

  /**
   * Состояния фишки.
   *
   * У каждого состояния два поля, которых раньше не было:
   *   effect — что рисуется под фишкой (лоза, камневая крошка, искры и так далее);
   *   noMove — по правилам 5e такое состояние отнимает скорость целиком, то есть
   *           игрок не может переставить свою фишку сам.
   *
   * Список читает и сервер, поэтому правило движения одно и то же у обоих:
   * интерфейс не может разрешить то, что сервер всё равно отвергнет.
   *
   * Греющийся и схваченный скорость не отнимают: из положения «сбит с ног» можно
   * встать, а схвативший тянет фишку сам и мастер водит её руками. Невидимость,
   * слепота, глухота, испуг и отравление двигать не мешают вовсе.
   */
  const CONDITIONS = [
    { id: 'blinded', label: 'Слепой', short: 'Слепой', effect: 'blindfold' },
    { id: 'deafened', label: 'Глухой', short: 'Глухой', effect: 'deafened' },
    { id: 'dazzled', label: 'Ослеплён', short: 'Ослеп', effect: 'dazzled' },
    { id: 'frightened', label: 'Испуган', short: 'Испуг', effect: 'frightened' },
    { id: 'grappled', label: 'Схвачен', short: 'Схват', effect: 'grappled' },
    { id: 'incapacitated', label: 'Недееспособен', short: 'Недеесп.', effect: 'chained', noMove: true },
    { id: 'invisible', label: 'Невидим', short: 'Невид.', effect: 'veil' },
    { id: 'paralyzed', label: 'Парализован', short: 'Парал.', effect: 'bolt', noMove: true },
    { id: 'petrified', label: 'Окаменел', short: 'Окамен.', effect: 'stone', noMove: true },
    { id: 'poisoned', label: 'Отравлен', short: 'Отравл.', effect: 'poison' },
    { id: 'prone', label: 'Сбит с ног', short: 'Лежит', effect: 'prone' },
    { id: 'restrained', label: 'Опутан', short: 'Опут.', effect: 'vines', noMove: true },
    { id: 'stunned', label: 'Оглушён', short: 'Оглуш.', effect: 'dizzy', noMove: true }
  ];

  /** Состояния, из-за которых фишкой нельзя пошевелить. */
  const MOVE_BLOCKING = new Set(CONDITIONS.filter((item) => item.noMove).map((item) => item.id));

  /**
   * Первое состояние, из-за которого фишка не двигается.
   *
   * Возвращаем само состояние, а не логический флаг: интерфейс и сервер показывают
   * игроку его название («опутан»), иначе запрет выглядит как ошибка приложения.
   * @param {unknown} list состояния фишки
   * @returns {object|null}
   */
  function conditionBlocksMove(list) {
    if (!Array.isArray(list)) return null;
    for (const id of list) {
      const found = CONDITIONS.find((item) => item.id === String(id || ''));
      if (found && MOVE_BLOCKING.has(found.id)) return found;
    }
    return null;
  }

  /**
   * Рисуемые эффекты состояний без повторов: несколько состояний могут дать один
   * и тот же рисунок, а на фишке два одинаковых эффекта смотрелись бы как ошибка.
   * @param {unknown} list состояния фишки
   * @returns {string[]}
   */
  function conditionEffects(list) {
    if (!Array.isArray(list)) return [];
    const effects = new Set();
    for (const id of list) {
      const found = CONDITIONS.find((item) => item.id === String(id || ''));
      if (found && found.effect) effects.add(found.effect);
    }
    return [...effects];
  }

  const LIMITS = {
    maxNameLength: 40,
    maxChatLength: 1000,
    maxImageBytes: 10 * 1024 * 1024,
    // Прочность фишки. Те же числа, что в LIMITS в server/state.js: поле
    // ввода показывает этот предел, и сервер обязан соглашаться.
    maxTokenHp: 9999,
    // Состояний на одной фишке не бывает больше, чем есть в правилах.
    maxTokenConditions: 13,
    /** Заметка мастера об игроке: столько же, сколько заметки в листе. */
    maxDmNote: 4000,
    // Аватар ездит вместе с игроком и рисуется в кружке 30px, поэтому его
    // предел заметно меньше карты. Те же числа, что в server/state.js.
    maxAvatarBytes: 2 * 1024 * 1024,
    // Пределы листа. Раньше они были в четырёх местах, и клиент с сервером
    // разошлись: форма показывала одно значение, а сохранялось другое.
    // Теперь клиент и сервер берут числа отсюда и из серверных LIMITS.
    minAbility: 1,
    maxAbility: 30,
    minLevel: 1,
    maxLevel: 20,
    minHp: -999,
    maxHp: 9999,
    /** Счётчик спасбросков смерти: дальше трёх он не идёт по правилам. */
    maxDeathSaves: 3,
    /** Ячейки на одной ступени: в правилах больше не бывает. */
    maxSpellSlotsPerLevel: 9,
    minArmorClass: 0,
    maxArmorClass: 99,
    minInitiativeMisc: -20,
    maxInitiativeMisc: 20,
    minSpeed: 0,
    maxSpeed: 999,
    minProficiencyBonus: 0,
    maxProficiencyBonus: 12,
    maxExperience: 9999999,
    maxSheetTextLength: 4000,
    maxHitDiceLength: 20,
    maxClassLength: 60,
    /** Строк атак в листе: больше двадцати за бой всё равно не пригодится. */
    maxSheetAttacks: 20,
    maxAttackName: 60,
    maxAttackDamage: 80
  };

  /**
   * Приводит число к пределам листа — теми же, что на сервере.
   *
   * Без этого игрок видел в форме одно значение, а в кампании сохранялось
   * другое: например, сила 99 показывала модификатор +44, но на сервере
   * резалась до 30, и исправления игрок не видел никогда.
   * @param {number|string} value
   * @param {number} min
   * @param {number} max
   * @param {number} fallback
   * @returns {number}
   */
  function clampNumber(value, min, max, fallback) {
    // Пустое поле — это «значение не введено», а не ноль. Иначе очищенная
    // Сила превращалась бы в 1, а не возвращалась к десяти, и игрок видел бы
    // не то, что вводил.
    if (value === '' || value === null || value === undefined) return fallback;
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  /**
   * Модификатор характеристики: floor((score - 10) / 2).
   * @param {number} score
   * @returns {number}
   */
  function abilityModifier(score) {
    const value = Number(score);
    if (!Number.isFinite(value)) return 0;
    return Math.floor((value - 10) / 2);
  }

  /**
   * Бонус мастерства по уровню: 1-4 -> +2, 5-8 -> +3, 9-12 -> +4, 13-16 -> +5, 17-20 -> +6.
   * @param {number} level
   * @returns {number}
   */
  function proficiencyBonus(level) {
    const lvl = Math.min(20, Math.max(1, Math.round(Number(level) || 1)));
    return 2 + Math.floor((lvl - 1) / 4);
  }

  /** @param {number} value @returns {string} */
  function formatModifier(value) {
    const num = Number(value) || 0;
    return num >= 0 ? `+${num}` : `${num}`;
  }

  /** Лист персонажа по умолчанию (пустой). */
  function createEmptySheet(playerName = '') {
    const sheet = {
      playerName,
      characterName: '',
      charClass: '',
      subclass: '',
      // Мультикласс: [{name, level}]. Пусто — лист считается одноклассовым, и
      // класс берётся из charClass/level.
      classes: [],
      race: '',
      background: '',
      alignment: '',
      level: 1,
      experience: 0,
      proficiencyBonusManual: null,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      saveProficiencies: {},
      skillProficiencies: {},
      skillExpertise: {},
      hp: 10,
      maxHp: 10,
      tempHp: 0,
      // Спасброски смерти. Считаются только пока здоровье на нуле: спасброски
      // без сознания идут вместо обычных бросков, пока не три успеха или три
      // неудачи.
      deathSavesSuccesses: 0,
      deathSavesFailures: 0,
      /**
       * Ячейки заклинаний по ступеням, девять чисел: занято и сколько всего.
       * Хранится парами, а не объектом по уровню: в разметке это девять рядов,
       * и массив читается глазами быстрее, чем объект с ключами.
       */
      spellSlotsUsed: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      spellSlotsMax: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      hitDice: '1d8',
      // Сколько костей хитов уже потрачено. Пул общий: у мультикласса
      // конкретную кость выбирают в листе, а счётчик один.
      hitDiceSpent: 0,
      armorClass: 10,
      initiativeMisc: 0,
      speed: 30,
      // Атаки для быстрых бросков: [{name, bonus, damage}]. Текстовое поле
      // attacks остаётся для описаний и старых листов.
      attackList: [],
      attacks: '',
      equipment: '',
      features: '',
      notes: ''
    };
    for (const key of ABILITY_KEYS) sheet.saveProficiencies[key] = false;
    for (const skill of SKILLS) {
      sheet.skillProficiencies[skill.key] = false;
      sheet.skillExpertise[skill.key] = false;
    }
    return sheet;
  }

  /**
   * Все производные значения листа: модификаторы, спасброски, навыки,
   * инициатива, пассивная Внимательность.
   * @param {object} sheet
   */
  /**
   * Состояние персонажа по здоровью и спасброскам смерти.
   *
   * Пока здоровье не упало в ноль, счётчики не значат ничего, и прятать их
   * надо именно поэтому: три неудачи рядом со здоровым героем выглядят как
   * ошибка, а не как отметка.
   *
   * @param {object} sheet
   * @returns {{down: boolean, success: number, failure: number, label: string}}
   */
  /**
   * Ячейки заклинаний листа.
   *
   * Итог берётся из того, что вписал человек, а подставляется только когда он
   * пустой и класс известен: у незнакомого класса приложение своё число
   * выдумывать не станет.
   *
   * @param {object} sheet
   * @returns {{levels: number, rows: {level: number, used: number, max: number|null}[]}}
   */
  function computeSpellSlots(sheet) {
    const raw = sheet && typeof sheet === 'object' ? sheet : {};
    const used = Array.isArray(raw.spellSlotsUsed) ? raw.spellSlotsUsed : [];
    const max = Array.isArray(raw.spellSlotsMax) ? raw.spellSlotsMax : [];
    // Число из листа главнее: вписал человек, значит человек и прав.
    // Таблица класса только заполняет пустое, иначе приложение затирало бы
    // собственный подсчёт человека.
    const automatic = casterSlotRow(raw);
    const rows = SPELL_SLOT_LEVELS.map((level, index) => {
      const usedValue = Math.max(0, Math.min(LIMITS.maxSpellSlotsPerLevel, Math.round(Number(used[index]) || 0)));
      const written = Math.round(Number(max[index]) || 0);
      return {
        level,
        used: usedValue,
        max: written > 0 ? written : (automatic ? automatic[index] : null)
      };
    });
    const levels = rows.some((row) => (row.max || 0) > 0 || row.used > 0) ? 9 : 0;
    return { levels, rows };
  }

  function computeVitalState(sheet) {
    const raw = sheet && typeof sheet === 'object' ? sheet : {};
    const hp = Number.isFinite(Number(raw.hp)) ? Number(raw.hp) : 0;
    const success = Math.max(0, Math.min(LIMITS.maxDeathSaves, Math.round(Number(raw.deathSavesSuccesses) || 0)));
    const failure = Math.max(0, Math.min(LIMITS.maxDeathSaves, Math.round(Number(raw.deathSavesFailures) || 0)));
    if (hp > 0) {
      return { down: false, success: 0, failure: 0, label: '' };
    }
    if (failure >= LIMITS.maxDeathSaves) return { down: true, success, failure, label: 'Мёртв' };
    if (success >= LIMITS.maxDeathSaves) return { down: true, success, failure, label: 'Стабилизирован' };
    return { down: true, success, failure, label: 'При смерти' };
  }

  function computeDerived(sheet) {
    const safe = sheet && typeof sheet === 'object' ? sheet : createEmptySheet();
    const level = totalCharacterLevel(safe);
    const profBonus = safe.proficiencyBonusManual === null || safe.proficiencyBonusManual === undefined
      ? proficiencyBonus(level)
      : Math.round(Number(safe.proficiencyBonusManual) || 0);

    const modifiers = {};
    for (const key of ABILITY_KEYS) {
      modifiers[key] = abilityModifier(safe.abilities ? safe.abilities[key] : 10);
    }

    const saves = {};
    for (const key of ABILITY_KEYS) {
      const proficient = Boolean(safe.saveProficiencies && safe.saveProficiencies[key]);
      saves[key] = {
        ability: key,
        proficient,
        base: modifiers[key],
        total: modifiers[key] + (proficient ? profBonus : 0)
      };
    }

    const skills = {};
    for (const skill of SKILLS) {
      const proficient = Boolean(safe.skillProficiencies && safe.skillProficiencies[skill.key]);
      const expertise = proficient && Boolean(safe.skillExpertise && safe.skillExpertise[skill.key]);
      const bonus = profBonus * (expertise ? 2 : (proficient ? 1 : 0));
      skills[skill.key] = {
        key: skill.key,
        label: skill.label,
        ability: skill.ability,
        proficient,
        expertise,
        base: modifiers[skill.ability],
        total: modifiers[skill.ability] + bonus
      };
    }

    const initiative = modifiers.dex + (Math.round(Number(safe.initiativeMisc) || 0));
    const passivePerception = 10 + skills.perception.total;

    return { level, profBonus, modifiers, saves, skills, initiative, passivePerception };
  }

  global.DnD5e = {
    ABILITY_KEYS,
    ABILITIES,
    ABILITY_LABELS,
    CLASSES,
    CONDITIONS,
    MOVE_BLOCKING,
    SURFACE_TYPES,
    SURFACE_IDS,
    DICE_SIDES,
    FOG,
    FULL_CASTER_CLASSES,
    FULL_CASTER_SLOTS,
    SPELL_SLOT_LEVELS,
    GRID,
    HIT_DICE,
    hitDieSides,
    MAX_CLASS_ENTRIES,
    classHitDie,
    normalizeClasses,
    classLevels,
    totalCharacterLevel,
    hitDicePool,
    combinedCasterLevel,
    casterSlotRow,
    LIGHT_AMBIENT,
    LIGHT_LIMITS,
    LIGHT_PRESETS,
    LIMITS,
    MAP_LABELS,
    MAP_TYPES,
    SKETCH,
    SKILLS,
abilityModifier,
      clampNumber,
      castRay,
      computeDerived,
      computeSpellSlots,
      computeVitalState,
      conditionBlocksMove,
      conditionEffects,
    createEmptySheet,
    darknessAlpha,
    distanceToSegment,
    formatModifier,
    proficiencyBonus,
fogHasOpenArea,
      gridCellSize,
      lightGrid,
    lightPolygon,
    newFogMask,
    normalizeFogMask,
normalizeLight,
      normalizeLights,
      normalizeWall,
      normalizeWalls,
      normalizeGrid,
      normalizeSurface,
openFogAt,
      roundColumns,
      setFogWhole,
    spellSlotMax,
    spellSlotRow,
    wallsInCells
  };
  // Отдаём себя и через module.exports: сервер требует этот файл ради списка
  // состояний, и в Node окна нет. В браузере module не объявлен, поэтому
  // условие ложно и всё остаётся как было.
  if (typeof module === 'object' && module.exports) module.exports = global.DnD5e;
})(typeof window !== 'undefined' ? window : globalThis);
