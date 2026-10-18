'use strict';

/**
 * Панель листа персонажа D&D 5e 2014.
 *
 * Один компонент на два случая:
 *  - игрок — редактируемая форма своего листа;
 *  - ДМ — тот же лист в режиме просмотра (поля отключены).
 *
 * Все производные значения (модификаторы, спасброски, навыки, инициатива,
 * пассивная Внимательность) считаются на клиенте по формулам D&D 5e 2014
 * и пересчитываются на каждый ввод. Сервер их не считает: он проверяет только
 * исходные числа и обрезает их по пределам из DnD.LIMITS — тем же самым, что
 * применяет форма, поэтому введённое и сохранённое значения совпадают.
 */

(function (global) {
  const DnD = global.DnD5e;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function numberInput(field, options = {}) {
    const input = el('input');
    input.type = 'number';
    input.className = options.className || 'field__input';
    input.dataset.field = field;
    if (options.min !== undefined) input.min = String(options.min);
    if (options.max !== undefined) input.max = String(options.max);
    return input;
  }

  function textInput(field, className) {
    const input = el('input');
    input.type = 'text';
    input.className = className || 'field__input';
    input.dataset.field = field;
    return input;
  }

  function initials(name) {
    const clean = String(name || '?').trim();
    return clean ? clean.slice(0, 1).toUpperCase() : '?';
  }


  class SheetView {
    /**
     * @param {HTMLElement} root контейнер панели
     * @param {{onChange?: (sheet: object) => void, onBack?: () => void, onDetach?: () => void, onAvatarPick?: (file: File) => void, onAvatarClear?: () => void}} handlers
     */
    constructor(root, handlers = {}) {
      this.root = root;
      this.handlers = handlers;
      this.readOnly = false;
      this.mode = 'sheet';
      this.sheet = DnD.createEmptySheet();
      this.derived = DnD.computeDerived(this.sheet);
      this.statusNode = null;
      this.build();
    }

    build() {
      this.root.innerHTML = '';
      this.root.classList.add('sheet');

      // --- Шапка: заголовок, кнопка возврата к списку игроков и статус ---
      const head = el('div', 'sheet__head');
      this.titleNode = el('div', 'sheet__title', 'Лист персонажа');
      head.appendChild(this.titleNode);

      const headTools = el('div', 'sheet__head-tools');
      // Лист можно вынести в отдельное окно — тогда панель стола сворачивается.
      this.detachButton = el('button', 'btn btn--ghost btn--tiny', '⧉ Отдельным окном');
      this.detachButton.type = 'button';
      this.detachButton.title = 'Открыть лист в отдельном окне';
      this.detachButton.addEventListener('click', () => {
        if (this.handlers.onDetach) this.handlers.onDetach();
      });
      headTools.appendChild(this.detachButton);

      // У ДМ лист открывается со списка игроков — кнопка возвращает обратно.
      this.backButton = el('button', 'btn btn--ghost btn--tiny', '← К списку игроков');
      this.backButton.type = 'button';
      this.backButton.hidden = true;
      this.backButton.addEventListener('click', () => {
        if (this.handlers.onBack) this.handlers.onBack();
      });
      headTools.appendChild(this.backButton);

      // Печать: игроки держат лист под рукой, и из окна приложения его нужно
      // унести в PDF. Системное окно печати умеет и «Сохранить как PDF», а
      // отдельный вызов printToPDF всё равно открывал бы файловый диалог.
      this.printButton = el('button', 'btn btn--ghost btn--tiny', '⎙ Печать');
      this.printButton.type = 'button';
      this.printButton.title = 'Напечатать лист или сохранить в PDF';
      this.printButton.addEventListener('click', () => {
        if (this.handlers.onPrint) {
          this.handlers.onPrint();
          return;
        }
        window.print();
      });
      headTools.appendChild(this.printButton);

      this.statusNode = el('span', 'sheet__status', '');
      headTools.appendChild(this.statusNode);
      head.appendChild(headTools);
      this.root.appendChild(head);

      // --- Подсказка мастеру: игрок выбирается в панели участников слева ---
      // Списка игроков в этой вкладке больше нет: он целиком живёт слева, где
      // у каждого есть кнопка «Открыть лист», а здесь остаётся сам лист.
      this.pickNode = el('div', 'sheet__pick');
      this.pickNode.hidden = true;
      this.pickNode.appendChild(el('div', 'sheet__pick-title', 'Чей лист открыть?'));
      this.pickNode.appendChild(el('div', 'muted',
        'Выберите игрока в панели «Участники» слева и нажмите «Открыть лист». '
        + 'Список игроков переехал туда целиком, чтобы не искать игрока в двух местах.'));
      this.root.appendChild(this.pickNode);

      const grid = el('div', 'sheet__grid');
      this.gridNode = grid;
      this.root.appendChild(grid);

      // --- Колонка 1: характеристики, спасброски, бой ---
      const col1 = el('section', 'sheet__col');

      const identity = el('div', 'box');
      identity.appendChild(el('div', 'box__title', 'Персонаж'));
      identity.appendChild(this.buildAvatarBlock());
      identity.appendChild(this.field('characterName', 'Имя персонажа'));
      identity.appendChild(this.field('playerName', 'Имя игрока'));
      identity.appendChild(this.field('charClass', 'Класс'));
      identity.appendChild(this.field('race', 'Раса'));
      identity.appendChild(this.field('background', 'Предыстория'));
      identity.appendChild(this.field('alignment', 'Мировоззрение'));
      col1.appendChild(identity);

      const abilities = el('div', 'box');
      abilities.appendChild(el('div', 'box__title', 'Характеристики'));

      // Режим проверки: обычный бросок, преимущество или помеха. Переключатель
      // один на весь лист, потому что за бой преимущество нужно почти всегда, а
      // кнопки «преимущество» у каждой характеристики превратили бы лист в
      // список мелких кнопок.
      this.rollMode = 'normal';
      const modes = el('div', 'sheet__roll-modes');
      const modeRow = el('div', 'inline-row sheet__roll-row');
      modeRow.appendChild(el('span', 'sheet__roll-label', 'Проверка'));
      this.rollModeNodes = {};
      for (const mode of [
        { id: 'normal', label: 'обычно' },
        { id: 'advantage', label: 'преимущ.' },
        { id: 'disadvantage', label: 'помеха' }
      ]) {
        const button = el('button', `sheet__roll-mode${mode.id === 'normal' ? ' is-active' : ''}`, mode.label);
        button.type = 'button';
        button.dataset.mode = mode.id;
        button.addEventListener('click', () => this.setRollMode(mode.id));
        this.rollModeNodes[mode.id] = button;
        modes.appendChild(button);
      }
      this.rollModes = modes;
      modeRow.appendChild(modes);
      this.rollRow = modeRow;
      abilities.appendChild(modeRow);

      const abilityGrid = el('div', 'abil-grid');
      this.abilityNodes = {};
      for (const ability of DnD.ABILITIES) {
        const card = el('div', 'abil');
        card.appendChild(el('div', 'abil__name', ability.label));
        const input = numberInput('ability', { className: 'abil__score', min: 1, max: 30 });
        input.dataset.ability = ability.key;
        input.addEventListener('input', () => this.refresh());
        card.appendChild(input);
        const mod = el('div', 'abil__mod', '+0');
        card.appendChild(mod);
        // Проверка характеристики нажатием на кубик: за столом это самый
        // частый бросок, и искать модификатор в уме незачем.
        const rollButton = this.rollButton(ability.label, () => {
          this.rollCheck('Проверка ' + ability.label, DnD.formatModifier(this.derived.modifiers[ability.key]));
        });
        card.appendChild(rollButton);
        this.abilityNodes[ability.key] = { input, mod, rollButton };
        abilityGrid.appendChild(card);
      }
      abilities.appendChild(abilityGrid);
      col1.appendChild(abilities);

      const saves = el('div', 'box');
      saves.appendChild(el('div', 'box__title', 'Спасброски'));
      const profNote = el('div', 'box__note', 'Отметьте владение — добавится бонус мастерства');
      saves.appendChild(profNote);
      this.saveNodes = {};
      for (const ability of DnD.ABILITIES) {
        const row = el('label', 'prof-row');
        const check = el('input');
        check.type = 'checkbox';
        check.dataset.save = ability.key;
        check.addEventListener('change', () => this.refresh());
        row.appendChild(check);
        const value = el('span', 'prof-row__value', '+0');
        row.appendChild(value);
        row.appendChild(el('span', 'prof-row__label', ability.label));
        const rollButton = this.rollButton('Спасбросок ' + ability.label, () => {
          this.rollCheck('Спасбросок ' + ability.label, DnD.formatModifier(this.derived.saves[ability.key].total));
        });
        row.appendChild(rollButton);
        this.saveNodes[ability.key] = { check, value, rollButton };
        saves.appendChild(row);
      }
      col1.appendChild(saves);

      const combat = el('div', 'box');
      combat.appendChild(el('div', 'box__title', 'Бой'));
      const levelRow = el('div', 'inline-row');
      levelRow.appendChild(this.field('level', 'Уровень *', { number: true, min: 1, max: 20 }));
      levelRow.appendChild(this.field('experience', 'Опыт', { number: true, min: 0, max: 9999999 }));
      combat.appendChild(levelRow);

      const profRow = el('div', 'inline-row');
      profRow.appendChild(this.readonlyField('Бонус мастерства', 'profBonus'));
      combat.appendChild(profRow);
        const manualRow = el('label', 'prof-row prof-row--manual');
        const manualCheck = el('input');
        manualCheck.type = 'checkbox';
        manualCheck.addEventListener('change', () => {
        if (manualCheck.checked && !manualInput.value.trim()) {
          const levelInput = this.root.querySelector('[data-field="level"]');
          manualInput.value = String(DnD.proficiencyBonus(levelInput ? Number(levelInput.value) : 1));
        }
        manualInput.hidden = !manualCheck.checked;
        this.refresh();
      });
      manualRow.appendChild(manualCheck);
      manualRow.appendChild(el('span', 'prof-row__label', 'Задать бонус мастерства вручную'));
      this.manualProfCheck = manualCheck;
      combat.appendChild(manualRow);
      const manualInput = numberInput('proficiencyBonusManual', { className: 'field__input', min: 0, max: 12 });
      manualInput.hidden = true;
      manualInput.addEventListener('input', () => this.refresh());
      combat.appendChild(manualInput);
      this.manualProfInput = manualInput;

      const combatGrid = el('div', 'mini-grid');
      combatGrid.appendChild(this.field('armorClass', 'Класс брони', { number: true, min: 0, max: 99 }));
      combatGrid.appendChild(this.readonlyField('Инициатива', 'initiative'));
      combatGrid.appendChild(this.field('initiativeMisc', 'Прочий бонус к инициативе', { number: true, min: -20, max: 20 }));
      combatGrid.appendChild(this.field('speed', 'Скорость, футы', { number: true, min: 0, max: 999 }));
      combatGrid.appendChild(this.field('hp', 'Хиты', { number: true, min: -999, max: 9999 }));
      combatGrid.appendChild(this.field('maxHp', 'Максимальные хиты', { number: true, min: 0, max: 9999 }));
      combatGrid.appendChild(this.field('tempHp', 'Временные хиты', { number: true, min: 0, max: 9999 }));
      combatGrid.appendChild(this.field('hitDice', 'Кость хитов', { list: DnD.HIT_DICE }));
      combatGrid.appendChild(this.readonlyField('Пассивное восприятие', 'passivePerception'));
      combat.appendChild(combatGrid);

      // Спасброски смерти. Показываются, когда хиты на нуле: раньше этого они
      // не значат ничего, а три неудачи рядом со здоровым героем выглядят как
      // ошибка. Бросок отправляется серверу и считается там же: клиент не решает,
      // успех это или нет, иначе игрок подкрутил бы и число, и счётчик.
      const death = el('div', 'death-saves');
      death.hidden = true;
      const deathTitle = el('div', 'box__title', 'Спасброски смерти');
      death.appendChild(deathTitle);
      const deathNote = el('div', 'box__note',
        'Бросок d20: десятка и выше — успех, единица — две неудачи, двадцатка поднимает с одного хита');
      death.appendChild(deathNote);

      const deathRows = el('div', 'death-saves__rows');
      this.deathNodes = {};
      for (const kind of ['Successes', 'Failures']) {
        const isSuccess = kind === 'Successes';
        const row = el('div', 'death-saves__row');
        row.appendChild(el('span', 'death-saves__label', isSuccess ? 'Успехи' : 'Неудачи'));
        const minus = el('button', 'btn btn--ghost btn--tiny', '−');
        minus.type = 'button';
        minus.title = isSuccess ? 'Снять успех' : 'Снять неудачу';
        minus.addEventListener('click', () => this.bumpDeathSave(kind, -1));
        row.appendChild(minus);
        const value = el('span', 'death-saves__value', '0');
        row.appendChild(value);
        const plus = el('button', 'btn btn--ghost btn--tiny', '+');
        plus.type = 'button';
        plus.title = isSuccess ? 'Добавить успех' : 'Добавить неудачу';
        plus.addEventListener('click', () => this.bumpDeathSave(kind, 1));
        row.appendChild(plus);
        this.deathNodes[kind] = { value, minus, plus };
        deathRows.appendChild(row);
      }
      death.appendChild(deathRows);

      const deathState = el('div', 'death-saves__state', '');
      this.deathState = deathState;
      death.appendChild(deathState);

      const deathActions = el('div', 'death-saves__actions');
      const deathRoll = el('button', 'btn btn--accent btn--tiny', '🎲 Бросить спасбросок');
      deathRoll.type = 'button';
      deathRoll.title = 'Бросить d20 от имени персонажа';
      deathRoll.addEventListener('click', () => {
        // Проверка и в обработчике, а не только скрытием кнопки: скрытый
        // элемент не исчезает из DOM, и вызвать его всё равно можно.
        if (this.readOnly || !this.handlers.onDeathSave) return;
        if (this.handlers.onDeathSave) this.handlers.onDeathSave();
      });
      deathActions.appendChild(deathRoll);
      this.deathRollButton = deathRoll;
      const deathReset = el('button', 'btn btn--ghost btn--tiny', 'Сбросить счётчики');
      deathReset.type = 'button';
      deathReset.title = 'Счётчики обнуляются, когда герой пришёл в себя';
      deathReset.addEventListener('click', () => {
        if (this.readOnly || !this.handlers.onResetDeathSaves) return;
        this.handlers.onResetDeathSaves();
      });
      deathActions.appendChild(deathReset);
      this.deathResetButton = deathReset;
      this.deathNode = death;
      death.appendChild(deathActions);
      combat.appendChild(death);

      // Ячейки заклинаний. По умолчанию их нет ни у кого: класс без
      // заклинательной силы должен показывать честное «ячеек нет», а не пустые
      // ряды.
      const slots = el('div', 'spell-slots');
      slots.appendChild(el('div', 'box__title', 'Ячейки заклинаний'));
      const slotNote = el('div', 'box__note',
        'Ячейки восстанавливаются на длинном отдыхе, на коротком не восстанавливаются');
      slots.appendChild(slotNote);
      this.slotRows = [];
      const slotList = el('div', 'spell-slots__rows');
      for (const level of DnD.SPELL_SLOT_LEVELS) {
        const row = el('div', 'spell-slots__row');
        row.appendChild(el('span', 'spell-slots__level', `${level}`));
        const minus = el('button', 'btn btn--ghost btn--tiny', '−');
        minus.type = 'button';
        minus.title = `Вернуть ячейку ${level} уровня`;
        minus.addEventListener('click', () => this.bumpSpellSlot(level, -1));
        row.appendChild(minus);
        const used = el('span', 'spell-slots__used', '0');
        row.appendChild(used);
        const plus = el('button', 'btn btn--ghost btn--tiny', '+');
        plus.type = 'button';
        plus.title = `Потратить ячейку ${level} уровня`;
        plus.addEventListener('click', () => this.bumpSpellSlot(level, 1));
        row.appendChild(plus);
        const max = el('input', 'spell-slots__max');
        max.type = 'number';
        max.min = '0';
        max.max = String(DnD.LIMITS.maxSpellSlotsPerLevel);
        max.placeholder = '—';
        max.title = 'Сколько ячеек всего: подставляется по классу, но можно вписать своё';
        max.addEventListener('change', () => {
          if (this.readOnly || !this.handlers.onChange) {
            this.paintSpellSlots();
            return;
          }
          const sheet = this.collect();
          const values = DnD.SPELL_SLOT_LEVELS.map((item, index) => (
            item === level
              ? DnD.clampNumber(max.value, 0, DnD.LIMITS.maxSpellSlotsPerLevel, 0)
              : DnD.clampNumber(sheet.spellSlotsMax[index], 0, DnD.LIMITS.maxSpellSlotsPerLevel, 0)
          ));
          sheet.spellSlotsMax = values;
          this.setSheet(sheet);
          this.refresh();
        });
        row.appendChild(max);
        this.slotRows.push({ level, minus, plus, used, max, row });
        slotList.appendChild(row);
      }
      slots.appendChild(slotList);

      const slotActions = el('div', 'spell-slots__actions');
      const restore = el('button', 'btn btn--ghost btn--tiny', 'Восстановить все');
      restore.type = 'button';
      restore.title = 'Длинный отдых: ячейки восстанавливаются полностью';
      restore.addEventListener('click', () => {
        if (this.readOnly || !this.handlers.onChange) return;
        const sheet = this.collect();
        sheet.spellSlotsUsed = DnD.SPELL_SLOT_LEVELS.map(() => 0);
        this.setSheet(sheet);
        this.refresh();
      });
      this.slotRestore = restore;
      slotActions.appendChild(restore);
      slots.appendChild(slotActions);
      this.slotNode = slots;
      combat.appendChild(slots);

      col1.appendChild(combat);
      grid.appendChild(col1);

      // --- Колонка 2: навыки ---
      const col2 = el('section', 'sheet__col');
      const skills = el('div', 'box box--skills');
      skills.appendChild(el('div', 'box__title', 'Навыки'));
      const legend = el('div', 'box__note', 'Владение / компетентность (двойной бонус мастерства)');
      skills.appendChild(legend);
      this.skillNodes = {};
      for (const skill of DnD.SKILLS) {
        const row = el('div', 'prof-row prof-row--skill');
        const check = el('input');
        check.type = 'checkbox';
        check.dataset.skill = skill.key;
        check.title = 'Владение';
        check.addEventListener('change', () => this.refresh());
        row.appendChild(check);

        const expert = el('input');
        expert.type = 'checkbox';
        expert.className = 'prof-row__expert';
        expert.dataset.expertise = skill.key;
        expert.title = 'Компетентность';
        expert.addEventListener('change', () => this.refresh());
        row.appendChild(expert);

        const value = el('span', 'prof-row__value', '+0');
        row.appendChild(value);
        row.appendChild(el('span', 'prof-row__label', skill.label));
        row.appendChild(el('span', 'prof-row__ability', DnD.ABILITY_LABELS[skill.ability]));
        const rollButton = this.rollButton('Навык: ' + skill.label, () => {
          this.rollCheck('Навык: ' + skill.label, DnD.formatModifier(this.derived.skills[skill.key].total));
        });
        row.appendChild(rollButton);
        this.skillNodes[skill.key] = { check, expert, value, rollButton };
        skills.appendChild(row);
      }
      col2.appendChild(skills);
      grid.appendChild(col2);

      // --- Колонка 3: атаки, снаряжение, особенности, заметки ---
      const col3 = el('section', 'sheet__col');
      col3.appendChild(this.textarea('attacks', 'Атаки и заклинания'));
      col3.appendChild(this.textarea('equipment', 'Снаряжение'));
      col3.appendChild(this.textarea('features', 'Особенности и черты'));
      col3.appendChild(this.textarea('notes', 'Заметки'));
      grid.appendChild(col3);

      this.inputs = Array.from(this.root.querySelectorAll('[data-field]'));
      this.checkboxes = Array.from(this.root.querySelectorAll('input[type="checkbox"][data-save], input[type="checkbox"][data-skill], input[type="checkbox"][data-expertise]'));
      // Кубики и переключатель появляются только там, где бросать можно.
      // Считаем здесь, а не по клику: лист без обработчика броска — это
      // список игроков, экран подготовки и чужой лист у мастера.
      this.updateRollAvailability();
    }

    field(name, label, options = {}) {
      const wrap = el('label', 'field');
      wrap.appendChild(el('span', 'field__label', label));
      let input;
      if (options.list) {
        input = textInput(name);
        input.setAttribute('list', `list-${name}`);
        const datalist = el('datalist');
        datalist.id = `list-${name}`;
        for (const item of options.list) {
          const option = el('option');
          option.value = item;
          datalist.appendChild(option);
        }
        wrap.appendChild(input);
        wrap.appendChild(datalist);
      } else if (options.number) {
        input = numberInput(name, { min: options.min, max: options.max });
        wrap.appendChild(input);
      } else {
        input = textInput(name);
        wrap.appendChild(input);
      }
      input.addEventListener('input', () => this.refresh());
      return wrap;
    }

    readonlyField(label, key) {
      const wrap = el('div', 'field field--readonly');
      wrap.appendChild(el('span', 'field__label', label));
      const value = el('span', 'field__value', '—');
      value.dataset.derived = key;
      wrap.appendChild(value);
      return wrap;
    }

    textarea(name, label) {
      const wrap = el('div', 'box');
      wrap.appendChild(el('div', 'box__title', label));
      const area = el('textarea', 'textarea');
      area.dataset.field = name;
      area.rows = 5;
      area.addEventListener('input', () => this.refresh());
      wrap.appendChild(area);
      return wrap;
    }

    /** Читает текущие значения формы в объект листа. */
    /**
     * Собирает лист из полей формы.
     *
     * Числа приводятся к тем же пределам, что и на сервере. Раньше форма их не
     * ограничивала вовсе, и игрок видел одно значение, пока в кампанию
     * записывалось другое: сила 90 показывала модификатор +40, на сервере
     * оставалось 30, и исправления он не видел никогда.
     */
    collect() {
      // Пустой лист создаётся один раз на представление, а не на каждый
      // символ в текстовом поле.
      const sheet = this.emptySheet || (this.emptySheet = DnD.createEmptySheet());

// Счётчики спасбросков смерти не сидят в полях ввода: их двигают кнопки в листе
// и присылает сервер после броска. Без переноса любой ввод в соседнее поле
// обнулял бы их, и правка имени стирала бы весь бой.
const current = this.sheet && typeof this.sheet === 'object' ? this.sheet : {};
sheet.deathSavesSuccesses = DnD.clampNumber(
  current.deathSavesSuccesses, 0, DnD.LIMITS.maxDeathSaves, 0
);
sheet.deathSavesFailures = DnD.clampNumber(
  current.deathSavesFailures, 0, DnD.LIMITS.maxDeathSaves, 0
);

// Ячейки заклинаний тоже живут на кнопках и в поле без data-field. Переносим
// оба ряда целиком: девять ступеней, длина задана правилами.
const slotLevel = (value, fallback) => DnD.clampNumber(value, 0, DnD.LIMITS.maxSpellSlotsPerLevel, fallback);
sheet.spellSlotsUsed = DnD.SPELL_SLOT_LEVELS.map((level, index) => slotLevel(
  current.spellSlotsUsed ? current.spellSlotsUsed[index] : 0, 0
));
sheet.spellSlotsMax = DnD.SPELL_SLOT_LEVELS.map((level, index) => slotLevel(
  current.spellSlotsMax ? current.spellSlotsMax[index] : 0, 0
));

      for (const input of this.inputs) {
        const name = input.dataset.field;
        if (!name) continue;
        if (input.dataset.ability) {
          sheet.abilities[input.dataset.ability] = DnD.clampNumber(
            input.value, DnD.LIMITS.minAbility, DnD.LIMITS.maxAbility, 10
          );
          continue;
        }
        if (name === 'proficiencyBonusManual') {
          sheet.proficiencyBonusManual = this.manualProfCheck && this.manualProfCheck.checked
            ? DnD.clampNumber(
              input.value, DnD.LIMITS.minProficiencyBonus, DnD.LIMITS.maxProficiencyBonus, 2
            )
            : null;
          continue;
        }
        if (name === 'level') {
          sheet.level = DnD.clampNumber(input.value, DnD.LIMITS.minLevel, DnD.LIMITS.maxLevel, 1);
          continue;
        }
        if (name === 'experience') {
          sheet.experience = DnD.clampNumber(input.value, 0, DnD.LIMITS.maxExperience, 0);
          continue;
        }
        if (name === 'hp') {
          sheet.hp = DnD.clampNumber(input.value, DnD.LIMITS.minHp, DnD.LIMITS.maxHp, 0);
          continue;
        }
        if (name === 'maxHp' || name === 'tempHp') {
          sheet[name] = DnD.clampNumber(input.value, 0, DnD.LIMITS.maxHp, 0);
          continue;
        }
        if (name === 'armorClass') {
          sheet.armorClass = DnD.clampNumber(
            input.value, DnD.LIMITS.minArmorClass, DnD.LIMITS.maxArmorClass, 10
          );
          continue;
        }
        if (name === 'initiativeMisc') {
          sheet.initiativeMisc = DnD.clampNumber(
            input.value, DnD.LIMITS.minInitiativeMisc, DnD.LIMITS.maxInitiativeMisc, 0
          );
          continue;
        }
        if (name === 'speed') {
          sheet.speed = DnD.clampNumber(input.value, DnD.LIMITS.minSpeed, DnD.LIMITS.maxSpeed, 0);
          continue;
        }
        if (input.type === 'number') {
          sheet[name] = DnD.clampNumber(input.value, -1000000, 1000000, 0);
        } else {
          sheet[name] = input.value;
        }
      }

      for (const ability of DnD.ABILITY_KEYS) {
        sheet.saveProficiencies[ability] = Boolean(this.saveNodes[ability].check.checked);
      }
      for (const skill of DnD.SKILLS) {
        const node = this.skillNodes[skill.key];
        sheet.skillProficiencies[skill.key] = node.check.checked;
        // Компетентность без владения бессмысленна: правило 5e даёт её только
        // за владение. Раньше галка оставалась включённой, а сервер всё равно
        // обнулял значение, и игрок об этом не узнавал.
        sheet.skillExpertise[skill.key] = Boolean(node.expert && node.expert.checked) && node.check.checked;
      }
      return sheet;
    }

    /** Пересчитывает производные значения и обновляет подписи. */
    refresh() {
      const sheet = this.collect();
      this.sheet = sheet;
      this.derived = DnD.computeDerived(sheet);
      this.paintDerived();
      if (this.handlers.onChange && !this.readOnly) this.handlers.onChange(sheet);
    }

    paintDerived() {
      const d = this.derived;
      for (const ability of DnD.ABILITIES) {
        this.abilityNodes[ability.key].mod.textContent = DnD.formatModifier(d.modifiers[ability.key]);
      }
      for (const ability of DnD.ABILITIES) {
        const node = this.saveNodes[ability.key];
        node.value.textContent = DnD.formatModifier(d.saves[ability.key].total);
        node.value.classList.toggle('is-proficient', node.check.checked);
      }
      for (const skill of DnD.SKILLS) {
        const node = this.skillNodes[skill.key];
        const info = d.skills[skill.key];
        node.value.textContent = DnD.formatModifier(info.total);
        node.value.classList.toggle('is-proficient', info.proficient);
        node.value.classList.toggle('is-expertise', info.expertise);
        node.expert.disabled = !node.check.checked || this.readOnly;
      }
      this.setDerived('profBonus', DnD.formatModifier(d.profBonus));
      this.setDerived('initiative', DnD.formatModifier(d.initiative));
      this.setDerived('passivePerception', String(d.passivePerception));
      this.paintVitalState();
      this.paintSpellSlots();
    }

    /**
     * Показывает и обновляет блок спасбросков смерти.
     *
     * Блок появляется на нулевых хитах и прячет счётчики у живого персонажа:
     * иначе три неудачи рядом со здоровым героем выглядят как ошибка. Сами
     * счётчики при этом не трогаем: лечение может быть впереди, а обнулять их
     * молча нельзя, об этом человек решит кнопкой сброса.
     */
    paintVitalState() {
      if (!this.deathNode) return;
      const vital = DnD.computeVitalState(this.sheet);
      this.deathNode.hidden = !vital.down;
      if (!vital.down) return;
      this.deathNodes.Successes.value.textContent = String(vital.success);
      this.deathNodes.Failures.value.textContent = String(vital.failure);
      this.deathState.textContent = vital.label;
      this.deathNode.classList.toggle('is-dead', vital.label === 'Мёртв');
      this.deathNode.classList.toggle('is-stable', vital.label === 'Стабилизирован');
      const max = DnD.LIMITS.maxDeathSaves;
      // Счётчик дошёл до трёх: растить дальше незачем, по правилам бой окончен.
      this.deathNodes.Failures.plus.disabled = vital.failure >= max;
      this.deathNodes.Successes.plus.disabled = vital.success >= max;
      const canRoll = Boolean(this.handlers.onDeathSave) && !this.readOnly;
      this.deathRollButton.hidden = !canRoll;
      this.deathResetButton.hidden = !canRoll;
    }

    /**
     * Тратит или возвращает одну ячейку.
     *
     * Занятых ячеек не может быть больше, чем всего: иначе персонаж «тратит»
     * ячейки, которых у него нет, и счётчик уезжает в отрицательные.
     * @param {number} level Ступень заклинания.
     * @param {number} delta
     */
    bumpSpellSlot(level, delta) {
      if (this.readOnly || !this.handlers.onChange) return;
      const sheet = this.collect();
      const index = DnD.SPELL_SLOT_LEVELS.indexOf(level);
      if (index < 0) return;
      const { rows } = DnD.computeSpellSlots(sheet);
      const row = rows[index];
      const ceiling = Math.max(0, row.max || 0);
      const next = Math.max(0, Math.min(ceiling || DnD.LIMITS.maxSpellSlotsPerLevel, (row.used || 0) + delta));
      sheet.spellSlotsUsed[index] = next;
      this.setSheet(sheet);
      this.refresh();
    }

    /**
     * Рисует ячейки: занято, всего и доступность кнопок.
     *
     * Прячется весь блок, если ячеек нет: у воина пустые девять рядов выглядели
     * бы как девять долгов.
     */
    paintSpellSlots() {
      if (!this.slotNode) return;
      const slots = DnD.computeSpellSlots(this.sheet);
      const anySlots = slots.rows.some((row) => (row.max || 0) > 0 || row.used > 0);
      this.slotNode.hidden = !anySlots;
      if (!anySlots) return;
      for (const node of this.slotRows) {
        const row = slots.rows[node.level - 1];
        node.used.textContent = String(row.used);
        // Поле «всего» заполняется только когда человек его не трогал: иначе
        // приложение затирало бы его число своим.
        // Ноль ячеек этой ступени показываем пустым полем, а не цифрой: у жреца
        // пятого уровня нет ячеек пятой ступени, и девять нулей в листе
        // выглядели бы как долг.
        if (document.activeElement !== node.max) node.max.value = row.max ? String(row.max) : '';
node.max.disabled = this.readOnly;
      // Плюс и минус ячеек гасятся не только заморозкой, но и пределом: на
      // потраченном последнем плюс не нужен.
      node.minus.disabled = this.readOnly || row.used === 0;
      node.plus.disabled = this.readOnly || (row.max !== null && row.used >= row.max);
    }
    const spent = slots.rows.some((row) => row.used > 0);
    this.slotRestore.disabled = this.readOnly || !spent;
    this.slotRestore.dataset.empty = spent ? '0' : '1';
    }

    /**
     * Двигает счётчик спасбросков вручную.
     *
     * Ручной плюс нужен не всегда: бросает сервер, но ибуты можно править
     * таблицей, и иногда счётчик считают сами.
     * @param {'Successes'|'Failures'} kind
     * @param {number} delta
     */
    bumpDeathSave(kind, delta) {
      if (this.readOnly || !this.handlers.onChange) return;
      const sheet = this.collect();
      const field = kind === 'Failures' ? 'deathSavesFailures' : 'deathSavesSuccesses';
      const next = Math.max(0, Math.min(DnD.LIMITS.maxDeathSaves,
        (Number(sheet[field]) || 0) + delta));
      sheet[field] = next;
      this.setSheet(sheet);
      this.refresh();
    }

    setDerived(key, text) {
      const node = this.root.querySelector(`[data-derived="${key}"]`);
      if (node) node.textContent = text;
    }

    /**
     * Заполняет форму листом.
     * @param {object} sheet
     */
    setSheet(sheet) {
      const data = sheet && typeof sheet === 'object' ? sheet : DnD.createEmptySheet();
      this.sheet = data;
      for (const input of this.inputs) {
        const name = input.dataset.field;
        if (!name) continue;
        if (input.dataset.ability) {
          input.value = String(data.abilities ? data.abilities[input.dataset.ability] : 10);
          continue;
        }
        if (name === 'proficiencyBonusManual') {
          const manual = data.proficiencyBonusManual;
          this.manualProfCheck.checked = manual !== null && manual !== undefined;
          input.value = manual === null || manual === undefined ? '' : String(manual);
          input.hidden = !this.manualProfCheck.checked;
          continue;
        }
        const value = data[name];
        input.value = value === null || value === undefined ? '' : String(value);
      }
      for (const ability of DnD.ABILITY_KEYS) {
        this.saveNodes[ability].check.checked = Boolean(data.saveProficiencies && data.saveProficiencies[ability]);
      }
      for (const skill of DnD.SKILLS) {
        this.skillNodes[skill.key].check.checked = Boolean(data.skillProficiencies && data.skillProficiencies[skill.key]);
        this.skillNodes[skill.key].expert.checked = Boolean(data.skillExpertise && data.skillExpertise[skill.key]);
      }
      this.derived = DnD.computeDerived(data);
      this.paintDerived();
    }

    /** @param {boolean} value */
    setReadOnly(value) {
      this.readOnly = Boolean(value);
      this.root.classList.toggle('is-readonly', this.readOnly);
      for (const input of this.inputs) input.disabled = this.readOnly;
      for (const box of this.checkboxes) box.disabled = this.readOnly;
if (this.manualProfCheck) this.manualProfCheck.disabled = this.readOnly;
    if (this.manualProfCheck && !this.manualProfCheck.checked) this.manualProfInput.hidden = true;
    // Кнопки ячеек и счётчиков собраны мимо this.inputs, поэтому гасим их
    // отдельно: мастер в чужом листе не должен ни тратить ячейки, ни считать
    // спасброски за игрока.
    for (const node of (this.slotRows || [])) {
      node.max.disabled = this.readOnly;
    }
    if (this.slotRestore) this.slotRestore.disabled = this.readOnly || this.slotRestore.dataset.empty === '1';
    for (const node of Object.values(this.deathNodes || {})) {
      node.minus.disabled = this.readOnly;
      node.plus.disabled = this.readOnly;
    }
    if (this.deathRollButton) this.deathRollButton.disabled = this.readOnly;
    if (this.deathResetButton) this.deathResetButton.disabled = this.readOnly;
    // Замороженный лист бросать нельзя: мастер смотрит чужой лист и не должен
    // в неё вносить боевые броски от лица игрока.
    this.updateRollAvailability();
    this.paintDerived();
    }

    /**
     * Аватар: круглая картинка, загрузка и сброс.
     *
     * Портрет хранится не в листе, а у игрока: им пользуются ещё и список
     * участников, и сообщения о бросках, а лист у мастера вообще чужой.
     * @returns {HTMLElement}
     */
    buildAvatarBlock() {
      const wrap = el('div', 'avatar-pick');

      this.avatarNode = el('div', 'avatar-pick__preview');
      // Пока картинки нет, показываем первую букву имени: пустой кружок
      // выглядит как ошибка загрузки.
      this.avatarFallback = el('span', 'avatar-pick__fallback', '?');
      this.avatarNode.appendChild(this.avatarFallback);
      wrap.appendChild(this.avatarNode);

      const side = el('div', 'avatar-pick__side');
      // Поле выбора файла спрятано под кнопку: в `<label>` оно не сработает,
      // потому что рядом с надписью, а не внутри неё, и без `for` браузер
      // не знает, что на неё нажимать.
      this.avatarInput = document.createElement('input');
      this.avatarInput.type = 'file';
      this.avatarInput.accept = 'image/png,image/jpeg,image/webp';
      this.avatarInput.className = 'avatar-pick__file';
      this.avatarInput.addEventListener('change', () => {
        const file = this.avatarInput.files && this.avatarInput.files[0];
        // Сбрасываем значение: повторный выбор того же файла иначе не даст
        // события change, и картинку не получится переставить.
        this.avatarInput.value = '';
        if (!file) return;
        if (this.handlers.onAvatarPick) this.handlers.onAvatarPick(file);
      });
      side.appendChild(this.avatarInput);

      this.avatarLabel = el('button', 'avatar-pick__label', 'Аватар');
      this.avatarLabel.type = 'button';
      this.avatarLabel.addEventListener('click', () => this.avatarInput.click());
      side.appendChild(this.avatarLabel);

      this.avatarClear = el('button', 'btn btn--ghost btn--tiny', 'Убрать');
      this.avatarClear.type = 'button';
      this.avatarClear.hidden = true;
      this.avatarClear.addEventListener('click', () => {
        if (this.handlers.onAvatarClear) this.handlers.onAvatarClear();
      });
      side.appendChild(this.avatarClear);
      wrap.appendChild(side);
      return wrap;
    }

    /**
     * Рисует портрет в кружке, а пока его нет — первую букву имени.
     * @param {HTMLElement} preview
     * @param {string|null} url
     * @param {string} name
     */
    paintAvatar(preview, url, name) {
      if (!preview) return;
      const paint = (hasImage) => {
        preview.innerHTML = '';
        if (hasImage) {
          const img = document.createElement('img');
          img.className = 'avatar-pick__img';
          img.alt = '';
          img.src = url;
          // Битая картинка не должна молча оставлять пустой кружок.
          img.addEventListener('error', () => paint(false));
          preview.appendChild(img);
          return;
        }
        const fallback = document.createElement('span');
        fallback.className = 'avatar-pick__fallback';
        fallback.textContent = initials(name || '');
        preview.appendChild(fallback);
      };
      paint(Boolean(url));
    }

    /**
     * Показывает аватар игрока в его листе, а пока его нет — первую букву имени.
     * @param {string|null} url
     * @param {string} [name] имя, из которого берётся буква-заглушка
     */
    setAvatar(url, name = '') {
      this.avatarUrl = url || null;
      const fallbackName = name || (this.sheet && this.sheet.characterName) || '';
      this.paintAvatar(this.avatarNode, this.avatarUrl, fallbackName);
      if (this.avatarClear) this.avatarClear.hidden = !this.avatarUrl;
    }

/**
   * Можно ли менять аватар. У мастера, открывшего чужой лист, — нельзя:
   * портрет игрока он не редактирует.
   * @param {boolean} editable
   */
    setAvatarEditable(editable) {
      if (this.avatarInput) this.avatarInput.disabled = !editable;
      // Кнопку гасим по-настоящему, а не классом: у disabled не бывает
      // наведения и клика, и мастер случайно не откроет выбор файла.
      if (this.avatarLabel) this.avatarLabel.disabled = !editable;
      if (this.avatarClear) this.avatarClear.disabled = !editable;
    }

    /** @param {string} text */
    setStatus(text) {
      if (this.statusNode) this.statusNode.textContent = text || '';
    }

/**
   * Режим панели: список игроков («list») или открытый лист («sheet»).
   * Кнопка возврата нужна только там, где есть откуда возвращаться — то есть
   * у ДМ, который попал в лист из списка игроков.
    /**
     * Кнопка проверки в карточке или строке.
     *
     * Модификатор не вписывается в подпись заранее: он меняется вместе с
     * характеристикой, и надпись успела бы соврать. В заголовке кнопки его
     * честно показать можно — браузер покажет при наведении.
     * @param {string} title
     * @param {() => void} handler
     * @returns {HTMLElement}
     */
    rollButton(title, handler) {
      const button = el('button', 'roll-check', '🎲');
      button.type = 'button';
      button.title = title;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!this.handlers.onRollCheck || this.readOnly) return;
        handler();
      });
      return button;
    }

    /**
     * Отправляет проверку на стол.
     *
     * Формулу собирает тот же разбор, что и панель кубиков: преимущество это
     * две кости и лучшая из них, помеха две и худшая. Модификатор подставляется
     * как есть, со знаком, поэтому «-1» превращается в «-1», а не в «--1».
     * @param {string} label
     * @param {string} modifier
     */
    rollCheck(label, modifier) {
      if (!this.handlers.onRollCheck || this.readOnly) return;
      const dice = this.rollMode === 'advantage' ? '2d20kh1'
        : (this.rollMode === 'disadvantage' ? '2d20kl1' : 'd20');
      // Модуль приходит уже со знаком: formatModifier даёт «+2» и «-1».
      // Дописывать знак ещё раз нельзя, вышло бы «d20++2», такой формулы нет.
      this.handlers.onRollCheck(dice + String(modifier || '+0'), label);
    }

    /**
     * Переключает режим проверки и обновляет подписи на кнопках.
     * @param {'normal'|'advantage'|'disadvantage'} mode
     */
    setRollMode(mode) {
      const next = mode === 'advantage' || mode === 'disadvantage' ? mode : 'normal';
      this.rollMode = next;
      if (!this.rollModeNodes) return;
      for (const [id, node] of Object.entries(this.rollModeNodes)) {
        node.classList.toggle('is-active', id === next);
      }
      this.paintRollTitles();
    }

    /** Скрывает броски там, где бросать нельзя: список игроков, замороженный лист. */
    updateRollAvailability() {
      const canRoll = Boolean(this.handlers.onRollCheck) && !this.readOnly;
      const visible = canRoll && this.mode === 'sheet';
      // Прячем всю строку с переключателем, а не сам переключатель: одна
      // подпись «Проверка» без кнопок выглядит как ошибка вёрстки.
      if (this.rollRow) this.rollRow.hidden = !visible;
      for (const node of this.root.querySelectorAll('.roll-check')) node.hidden = !visible;
    }

    /**
     * Держит заголовки кнопок в порядке: при смене режима или правки
     * характеристики модификатор в подписи обязан поменяться.
     */
    paintRollTitles() {
      const suffix = this.rollMode === 'advantage' ? ' (преимущество)'
        : (this.rollMode === 'disadvantage' ? ' (помеха)' : '');
      for (const node of this.root.querySelectorAll('.roll-check')) {
        node.title = node.title.replace(/ \(преимущество\)| \(помеха\)$/, '') + suffix;
      }
    }

   /**
   * Режим панели: подсказка выбора игрока («pick») или открытый лист («sheet»).
   *
   * Списка игроков в панели больше нет: игрок выбирается в списке участников
   * слева, а кнопка возврата закрывает открытый лист обратно.
   * @param {'pick'|'sheet'} mode
   * @param {{canGoBack?: boolean, canDetach?: boolean}} [options]
   */
  setMode(mode, options = {}) {
    this.mode = mode === 'pick' ? 'pick' : 'sheet';
    const isPick = this.mode === 'pick';
    this.pickNode.hidden = !isPick;
    this.gridNode.hidden = isPick;
    this.backButton.hidden = isPick || !options.canGoBack;
    // Отдельное окно нужно там, где лист открыт поверх стола. На экране
    // подготовки лист и есть всё окно, и кнопка только мешает.
    this.detachButton.hidden = isPick || options.canDetach === false;
    // Печатать лист из подсказки нечего: печатают открытый лист.
    if (this.printButton) this.printButton.hidden = isPick;
    this.updateRollAvailability();
    this.titleNode.textContent = isPick ? 'Листы игроков' : 'Лист персонажа';
  }
  }

  global.SheetView = SheetView;
})(window);
