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

  /** Бросок одной кости: crypto, если он есть, иначе обычный random. */
  function secureDie(sides) {
    const count = Math.max(2, Math.round(Number(sides) || 0));
    if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
      const buffer = new Uint32Array(1);
      global.crypto.getRandomValues(buffer);
      return (buffer[0] % count) + 1;
    }
    return Math.floor(Math.random() * count) + 1;
  }

  function numberInput(field, options = {}) {
    const input = el('input');
    input.type = 'number';
    input.className = options.className || 'field__input';
    if (field) input.dataset.field = field;
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
      identity.appendChild(this.buildClassesBlock());
      identity.appendChild(this.field('subclass', 'Подкласс'));
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
          this.rollCheck('Проверка ' + ability.label, DnD.formatModifier(this.derived.modifiers[ability.key]), 'check');
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
          this.rollCheck('Спасбросок ' + ability.label, DnD.formatModifier(this.derived.saves[ability.key].total), 'save', ability.key);
        });
        row.appendChild(rollButton);
        this.saveNodes[ability.key] = { check, value, rollButton };
        saves.appendChild(row);
      }
      col1.appendChild(saves);

      const combat = el('div', 'box');
      combat.appendChild(el('div', 'box__title', 'Бой'));
      const levelRow = el('div', 'inline-row');
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

      // Кость хитов: одна кость + модификатор Телосложения, как при повышении
      // уровня и на коротком отдыхе. Результат считается прямо в листе, чтобы
      // не искать его в ленте бросков.
      const hit = el('div', 'hit-die');
      const hitHead = el('div', 'hit-die__head');
      this.hitDieDie = el('span', 'hit-die__die', 'd8');
      hitHead.appendChild(this.hitDieDie);
      const hitCaption = el('span', 'hit-die__caption');
      hitCaption.appendChild(el('span', 'hit-die__name', 'Кость хитов'));
      hitCaption.appendChild(el('span', 'hit-die__hint', 'одна кость + модификатор Тел'));
      hitHead.appendChild(hitCaption);
      const hitRoll = el('button', 'btn btn--accent btn--tiny hit-die__roll', 'Бросить');
      hitRoll.type = 'button';
      hitRoll.addEventListener('click', () => this.rollHitDie());
      hitHead.appendChild(hitRoll);
      this.hitDieRoll = hitRoll;
      hit.appendChild(hitHead);
      // У мультикласса кости разного размера: выбираем, какую бросать.
      this.hitDiePick = el('select', 'select hit-die__pick');
      this.hitDiePick.hidden = true;
      this.hitDiePick.title = 'Какую кость хитов бросать';
      this.hitDiePick.addEventListener('change', () => {
        this.hitDieSelected = this.hitDiePick.value;
        this.syncHitDie();
      });
      hit.appendChild(this.hitDiePick);
      const hitOut = el('div', 'hit-die__out');
      hitOut.hidden = true;
      this.hitDieValue = el('span', 'hit-die__value', '0');
      this.hitDieDetail = el('span', 'hit-die__detail', '');
      hitOut.appendChild(this.hitDieValue);
      hitOut.appendChild(this.hitDieDetail);
      this.hitDieOut = hitOut;
      hit.appendChild(hitOut);

      // Отдых: короткий тратит одну кость хитов, долгий возвращает здоровье,
      // ячейки и половину костей. Считается в листе: это его же ресурсы, а не
      // общий бой. Счётчик костей хранится в кампании вместе с листом.
      const rest = el('div', 'hit-die__rest');
      this.hitDiePool = el('div', 'hit-die__pool', '');
      rest.appendChild(this.hitDiePool);
      const restActions = el('div', 'hit-die__rest-actions');
      const spendDie = el('button', 'btn btn--ghost btn--tiny hit-die__spend', 'Потратить кость');
      spendDie.type = 'button';
      spendDie.title = 'Короткий отдых: потратить кость хитов и восстановить здоровье';
      spendDie.addEventListener('click', () => this.spendHitDie());
      restActions.appendChild(spendDie);
      this.hitDieSpend = spendDie;
      const longRest = el('button', 'btn btn--accent btn--tiny hit-die__long-rest', 'Долгий отдых');
      longRest.type = 'button';
      longRest.title = 'Восстановить хиты, ячейки заклинаний и половину костей хитов';
      longRest.addEventListener('click', () => this.takeLongRest());
      restActions.appendChild(longRest);
      this.hitDieLongRest = longRest;
      rest.appendChild(restActions);
      rest.appendChild(el('div', 'hit-die__rest-note',
        'Короткий: одна кость. Долгий: хиты, ячейки и половина костей.'));
      hit.appendChild(rest);
      combat.appendChild(hit);

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
      col1.appendChild(this.buildStateBlock());
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
          this.rollCheck('Навык: ' + skill.label, DnD.formatModifier(this.derived.skills[skill.key].total), 'check');
        });
        row.appendChild(rollButton);
        this.skillNodes[skill.key] = { check, expert, value, rollButton };
        skills.appendChild(row);
      }
      col2.appendChild(skills);
      grid.appendChild(col2);

      // --- Колонка 3: атаки, снаряжение, особенности, заметки ---
      const col3 = el('section', 'sheet__col');
      col3.appendChild(this.buildAttacksBlock());
      col3.appendChild(this.textarea('attacks', 'Атаки и заклинания'));
      col3.appendChild(this.textarea('equipment', 'Снаряжение'));
      col3.appendChild(this.buildCoinsBlock());
      col3.appendChild(this.textarea('features', 'Особенности и черты'));
      col3.appendChild(this.textarea('notes', 'Заметки'));
      grid.appendChild(col3);

      this.inputs = Array.from(this.root.querySelectorAll('[data-field]'));
      this.checkboxes = Array.from(this.root.querySelectorAll('input[type="checkbox"][data-save], input[type="checkbox"][data-skill], input[type="checkbox"][data-expertise]'));
      // Кубики и переключатель появляются только там, где бросать можно.
      // Считаем здесь, а не по клику: лист без обработчика броска — это
      // список игроков, экран подготовки и чужой лист у мастера.
      this.updateRollAvailability();
      this.syncHitDie();
      this.updateClassSummary();
    }

    /**
     * Состояние: вдохновение, истощение и концентрация.
     *
     * Это не производные числа, а ресурсы, которые игрок отмечает сам.
     * Монеты живут отдельно, в колонке снаряжения: это имущество.
     * Истощение показываем уровнем и подсказкой, но скорость и броски
     * автоматически не правим: за столом мастер всё равно объявляет эффект.
     * @returns {HTMLElement}
     */
    buildStateBlock() {
      const box = el('div', 'box');
      box.appendChild(el('div', 'box__title', 'Состояние'));

      const inspRow = el('label', 'prof-row prof-row--manual');
      const insp = el('input', 'input sheet__inspiration');
      insp.type = 'number';
      insp.min = '0';
      insp.max = String(DnD.LIMITS.maxInspiration);
      insp.step = '1';
      insp.title = 'Вдохновение: можно перебросить проверку или бросок атаки';
      insp.addEventListener('input', () => this.refresh());
      inspRow.appendChild(insp);
      inspRow.appendChild(el('span', 'prof-row__label', 'Вдохновение'));
      box.appendChild(inspRow);

      const exhRow = el('label', 'field');
      exhRow.appendChild(el('span', 'field__label', 'Истощение, уровень'));
      const exh = el('select', 'select');
      exh.title = 'Уровень истощения 0–6';
      exh.addEventListener('change', () => this.refresh());
      const exhaustionLabels = [
        'нет',
        '1: помеха проверкам',
        '2: скорость вдвое меньше',
        '3: помеха атакам и спасброскам',
        '4: максимум хитов вдвое меньше',
        '5: скорость 0',
        '6: смерть'
      ];
      for (let level = 0; level <= DnD.LIMITS.maxExhaustion; level += 1) {
        const option = el('option', null, exhaustionLabels[level]);
        option.value = String(level);
        exh.appendChild(option);
      }
      exhRow.appendChild(exh);
      box.appendChild(exhRow);

      // Текущие последствия истощения словами: на уровне 3 их уже три, и
      // держать их в голове игрок не обязан.
      const exhNote = el('div', 'box__note');
      exhNote.hidden = true;
      box.appendChild(exhNote);
      this.exhaustionNote = exhNote;

      const concRow = el('label', 'field');
      concRow.appendChild(el('span', 'field__label', 'Концентрация на'));
      const conc = el('input', 'field__input');
      conc.type = 'text';
      conc.maxLength = DnD.LIMITS.maxConcentrationLength;
      conc.placeholder = 'Название заклинания';
      conc.title = 'Заклинание, на котором держится концентрация';
      conc.addEventListener('input', () => this.refresh());
      concRow.appendChild(conc);
      box.appendChild(concRow);

      const concActions = el('div', 'inline-row');
      const concRoll = this.rollButton('Проверка КОН при уроне', () => {
        const name = conc.value.trim();
        this.rollCheck(name ? `Концентрация: ${name}` : 'Концентрация',
          DnD.formatModifier(this.derived.saves.con.total), 'save', 'con');
      });
      concRoll.title = 'Спасбросок Телосложения: СЛ 10 или половина полученного урона';
      concActions.appendChild(concRoll);
      box.appendChild(concActions);

      box.appendChild(el('div', 'box__note',
        'Истощение: помеха проверкам, затем скорость, броски и максимум хитов. Уровень ведёт мастер.'));

      this.stateNodes = { insp, exh, conc, concRoll };
      return box;
    }

    /**
     * Монеты персонажа живут в колонке снаряжения: это имущество, а не
     * состояние. Отдельная коробка не смешивает кошелёк с вдохновением.
     * @returns {HTMLElement}
     */
    buildCoinsBlock() {
      const box = el('div', 'box');
      box.appendChild(el('div', 'box__title', 'Монеты'));
      const coins = el('div', 'mini-grid sheet__coins');
      const coinNodes = {};
      for (const [key, label] of [['cp', 'мм'], ['sp', 'см'], ['ep', 'эл.'], ['gp', 'зм'], ['pp', 'пл']]) {
        const row = el('label', 'field');
        row.appendChild(el('span', 'field__label', label));
        const input = numberInput(null, { min: 0, max: DnD.LIMITS.maxCoins });
        input.title = 'Монеты персонажа';
        input.addEventListener('input', () => this.refresh());
        coinNodes[key] = input;
        row.appendChild(input);
        coins.appendChild(row);
      }
      box.appendChild(coins);
      if (this.stateNodes) this.stateNodes.coins = coinNodes;
      return box;
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

    /**
     * Классы листа. Первый класс живёт в полях charClass/level, остальные
     * (мультикласс) — отдельными строками. Держать оба вида в одном списке
     * было бы красивее, но тогда пришлось бы переписать все старые листы;
     * а так одноклассовый герой и мультиклассовый читаются одним кодом.
     * @returns {HTMLElement}
     */
    buildClassesBlock() {
      const wrap = el('div', 'field field--classes');
      wrap.appendChild(el('span', 'field__label', 'Классы'));
      this.classListRows = el('div', 'class-editor');
      this.extraRows = [];
      this.classListRows.appendChild(this.buildPrimaryClassRow());
      wrap.appendChild(this.classListRows);
      const add = el('button', 'btn btn--tiny class-editor__add', '+ Ещё класс');
      add.type = 'button';
      add.addEventListener('click', () => this.addClassRow());
      this.addClassButton = add;
      wrap.appendChild(add);
      this.classListSummary = el('span', 'class-editor__sum');
      wrap.appendChild(this.classListSummary);
      return wrap;
    }

    /** Первый класс: список и его уровень. Остальные добавляются кнопкой. */
    buildPrimaryClassRow() {
      const row = el('div', 'class-row class-row--primary');
      const select = this.classSelect();
      select.dataset.field = 'charClass';
      const level = numberInput('level', { className: 'field__input class-row__level', min: 1, max: 20 });
      level.title = 'Уровень этого класса';
      select.addEventListener('input', () => this.onClassChange(select));
      level.addEventListener('input', () => this.onClassesChanged());
      row.appendChild(select);
      row.appendChild(level);
      row.appendChild(el('span', 'class-row__spacer'));
      row.select = select;
      row.level = level;
      return row;
    }

    /**
     * Список классов с пустым пунктом: пустая строка значит «класса нет», и
     * тогда лист считается одноклассовым по старым полям.
     * @param {string} [value]
     */
    classSelect(value = '') {
      const select = el('select', 'select class-row__name');
      const empty = el('option', null, '—');
      empty.value = '';
      select.appendChild(empty);
      for (const item of DnD.CLASSES) {
        const option = el('option', null, item.label);
        option.value = item.label;
        select.appendChild(option);
      }
      // Старый лист мог хранить класс свободным текстом: не теряем его.
      if (value && ![...select.options].some((option) => option.value === value)) {
        const extra = el('option', null, value);
        extra.value = value;
        select.appendChild(extra);
      }
      select.value = value || '';
      return select;
    }

    /**
     * Добавляет строку класса. Молча — при заполнении листа с сервера, чтобы
     * не отправить только что полученные данные обратно.
     * @param {{name?: string, level?: number}} [entry]
     * @param {{silent?: boolean}} [options]
     */
    addClassRow(entry = {}, options = {}) {
      if (!this.classListRows) return null;
      if (this.extraRows.length >= DnD.MAX_CLASS_ENTRIES - 1) return null;
      const row = el('div', 'class-row');
      const select = this.classSelect(entry.name);
      const level = numberInput(null, { className: 'field__input class-row__level', min: 1, max: 20 });
      level.value = String(DnD.clampNumber(entry.level, 1, 20, 1));
      level.title = 'Уровень этого класса';
      const remove = el('button', 'class-row__remove', '×');
      remove.type = 'button';
      remove.title = 'Убрать класс';
      select.addEventListener('input', () => this.onClassesChanged());
      level.addEventListener('input', () => this.onClassesChanged());
      remove.addEventListener('click', () => {
        row.remove();
        this.extraRows = this.extraRows.filter((item) => item !== row);
        this.onClassesChanged();
      });
      row.appendChild(select);
      row.appendChild(level);
      row.appendChild(remove);
      row.select = select;
      row.level = level;
      row.removeButton = remove;
      this.extraRows.push(row);
      this.classListRows.appendChild(row);
      if (this.readOnly) {
        select.disabled = true;
        level.disabled = true;
        remove.disabled = true;
      }
      if (!options.silent) this.onClassesChanged();
      return row;
    }

    /** Классы из формы: первый всегда, остальные — пока заполнены. */
    currentClasses() {
      const list = [];
      const primaryName = this.root.querySelector('[data-field="charClass"]');
      const primaryLevel = this.root.querySelector('[data-field="level"]');
      const name = primaryName ? String(primaryName.value).trim() : '';
      if (name) {
        list.push({
          name,
          level: DnD.clampNumber(primaryLevel ? primaryLevel.value : 1, 1, 20, 1)
        });
      }
      for (const row of this.extraRows || []) {
        const extraName = String(row.select.value || '').trim();
        if (!extraName) continue;
        list.push({ name: extraName, level: DnD.clampNumber(row.level.value, 1, 20, 1) });
      }
      return list;
    }

    /** Подпись «всего уровней» и доступность кнопки добавления. */
    updateClassSummary() {
      const classes = this.currentClasses();
      const total = classes.reduce((sum, item) => sum + item.level, 0);
      if (this.classListSummary) {
        this.classListSummary.textContent = this.extraRows.length
          ? `Всего уровней: ${Math.min(20, total)}`
          : '';
      }
      if (this.addClassButton) {
        this.addClassButton.disabled = this.readOnly
          || this.extraRows.length >= DnD.MAX_CLASS_ENTRIES - 1
          || total >= DnD.LIMITS.maxLevel;
      }
    }

    /** Правка классов: пересчитать лист и отправить его на стол. */
    onClassesChanged() {
      this.updateClassSummary();
      this.syncHitDie();
      this.refresh();
    }

    /**
     * Пересобирает строки мультикласса из листа, пришедшего с сервера.
     * @param {object} data
     */
    applyExtraClasses(data) {
      for (const row of this.extraRows || []) row.remove();
      this.extraRows = [];
      const classes = DnD.classLevels(data);
      for (const entry of classes.slice(1)) this.addClassRow(entry, { silent: true });
      this.updateClassSummary();
    }

    /**
     * Смена класса подставляет его кость хитов. Если человек уже правил
     * кость вручную, его число не трогаем: мультикласс и домашние классы
     * важнее автоматики.
     * @param {HTMLSelectElement} select
     */
    onClassChange(select) {
      const cls = DnD.CLASSES.find((item) => item.label === select.value);
      const field = this.root.querySelector('[data-field="hitDice"]');
      if (cls && field && (!field.value.trim() || !this.autoHitDie || field.value === this.autoHitDie)) {
        field.value = `1${cls.hitDie}`;
      }
      if (cls) this.autoHitDie = `1${cls.hitDie}`;
      this.onClassesChanged();
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

    /**
     * Атаки для быстрых бросков: имя, бонус к попаданию, формула урона.
     *
     * Текстовое поле «Атаки и заклинания» остаётся для описаний: в нём удобно
     * писать свойства оружия, но бросок из текста не собрать.
     * @returns {HTMLElement}
     */
    buildAttacksBlock() {
      const wrap = el('div', 'box box--attacks');
      wrap.appendChild(el('div', 'box__title', 'Быстрые броски'));
      wrap.appendChild(el('div', 'box__note',
        'Бонус к попаданию и урон. Бросок уходит всему столу.'));
      this.attackList = el('div', 'attack-list');
      this.attackRows = [];
      wrap.appendChild(this.attackList);
      const add = el('button', 'btn btn--tiny attack-list__add', '+ Атака');
      add.type = 'button';
      add.addEventListener('click', () => {
        if (this.readOnly || this.attackRows.length >= DnD.LIMITS.maxSheetAttacks) return;
        // Не зовём refresh(): пустая строка не должна сохраняться в кампанию
        // раньше, чем в неё что-то впишут.
        this.addAttackRow({});
      });
      this.attackAdd = add;
      wrap.appendChild(add);
      return wrap;
    }

    /** @param {{name?: string, bonus?: number, damage?: string}} attack */
    addAttackRow(attack = {}) {
      const row = el('div', 'attack-row');
      const name = el('input', 'input attack-row__name');
      name.type = 'text';
      name.placeholder = 'Название';
      name.maxLength = DnD.LIMITS.maxAttackName;
      name.value = attack.name || '';
      const bonus = el('input', 'input attack-row__bonus');
      bonus.type = 'number';
      bonus.min = '-20';
      bonus.max = '30';
      bonus.placeholder = '+0';
      bonus.title = 'Бонус к попаданию';
      bonus.value = attack.bonus === undefined ? '' : String(attack.bonus);
      const damage = el('input', 'input attack-row__damage');
      damage.type = 'text';
      damage.placeholder = '1d8+3';
      damage.maxLength = DnD.LIMITS.maxAttackDamage;
      damage.value = attack.damage || '';
      damage.title = 'Формула урона, например 1d8+3';

      const hit = el('button', 'btn btn--tiny attack-row__roll', 'd20');
      hit.type = 'button';
      hit.title = 'Бросок атаки';
      hit.addEventListener('click', () => {
        const label = name.value.trim() || 'Атака';
        this.rollCheck('Атака: ' + label, DnD.formatModifier(
          DnD.clampNumber(bonus.value, -20, 30, 0)
        ), 'attack');
      });

      const dmg = el('button', 'btn btn--tiny attack-row__roll', 'урон');
      dmg.type = 'button';
      dmg.title = 'Бросок урона';
      dmg.addEventListener('click', () => {
        const formula = damage.value.trim();
        if (!formula) return;
        if (!this.handlers.onRollCheck || this.readOnly) return;
        this.handlers.onRollCheck(formula, 'Урон: ' + (name.value.trim() || 'атака'));
      });

      const remove = el('button', 'btn btn--ghost btn--tiny attack-row__remove', '×');
      remove.type = 'button';
      remove.title = 'Убрать атаку';
      remove.addEventListener('click', () => {
        if (this.readOnly) return;
        const index = this.attackRows.findIndex((item) => item.node === row);
        if (index >= 0) this.attackRows.splice(index, 1);
        row.remove();
        this.refresh();
      });

      for (const input of [name, bonus, damage]) {
        input.addEventListener('input', () => this.refresh());
      }

      row.appendChild(name);
      row.appendChild(bonus);
      row.appendChild(damage);
      row.appendChild(hit);
      row.appendChild(dmg);
      row.appendChild(remove);
      this.attackList.appendChild(row);
      this.attackRows.push({ node: row, name, bonus, damage, hit, dmg, remove });
    }

    /**
     * Обновляет строки атак из листа. При смене персонажа пересобирает их
     * целиком, иначе правит значения на месте: иначе ответ сервера на каждую
     * букву пересоздавал бы поле и выбивал из него курсор.
     * @param {object[]} list
     * @param {boolean} sameCharacter
     */
    syncAttackRows(list, sameCharacter) {
      if (!this.attackList) return;
      const data = Array.isArray(list) ? list : [];
      if (!sameCharacter) {
        this.attackList.innerHTML = '';
        this.attackRows = [];
        for (const attack of data) this.addAttackRow(attack);
        return;
      }
      // Лишние пустые строки не трогаем: человек мог только что нажать
      // «+ Атака» и ещё не начать печатать.
      while (this.attackRows.length > data.length) {
        const last = this.attackRows[this.attackRows.length - 1];
        const empty = !last.name.value.trim() && !last.damage.value.trim()
          && !String(last.bonus.value).trim();
        if (!empty) break;
        this.attackRows.pop();
        last.node.remove();
      }
      for (let index = 0; index < data.length; index += 1) {
        if (!this.attackRows[index]) this.addAttackRow(data[index]);
      }
      data.forEach((attack, index) => {
        const row = this.attackRows[index];
        if (!row) return;
        // Не перебиваем то, что человек печатает прямо сейчас.
        if (document.activeElement !== row.name) row.name.value = attack.name || '';
        if (document.activeElement !== row.bonus) {
          row.bonus.value = attack.bonus === undefined ? '' : String(attack.bonus);
        }
        if (document.activeElement !== row.damage) row.damage.value = attack.damage || '';
      });
    }

    /** @returns {{name: string, bonus: number, damage: string}[]} */
    collectAttackList() {
      const list = [];
      for (const row of this.attackRows || []) {
        const name = row.name.value.trim().slice(0, DnD.LIMITS.maxAttackName);
        const damage = row.damage.value.trim().slice(0, DnD.LIMITS.maxAttackDamage);
        const bonus = DnD.clampNumber(row.bonus.value, -20, 30, 0);
        if (!name && !damage && bonus === 0) continue;
        list.push({ name, bonus, damage });
      }
      return list.slice(0, DnD.LIMITS.maxSheetAttacks);
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
sheet.hitDiceSpent = DnD.clampNumber(current.hitDiceSpent, 0, DnD.LIMITS.maxLevel, 0);
if (this.stateNodes) {
  sheet.inspiration = DnD.clampNumber(
    this.stateNodes.insp.value, 0, DnD.LIMITS.maxInspiration, 0
  );
  sheet.exhaustion = DnD.clampNumber(
    this.stateNodes.exh.value, 0, DnD.LIMITS.maxExhaustion, 0
  );
  sheet.concentration = String(this.stateNodes.conc.value || '')
    .slice(0, DnD.LIMITS.maxConcentrationLength)
    .trim();
  sheet.coins = {};
  for (const [key, input] of Object.entries(this.stateNodes.coins)) {
    sheet.coins[key] = DnD.clampNumber(input.value, 0, DnD.LIMITS.maxCoins, 0);
  }
}

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
      // Мультикласс хранится списком только когда он есть: у одноклассового
      // листа класс остаётся в старых полях, и кампании не нужно мигрировать.
      sheet.classes = this.extraRows.length ? this.currentClasses() : [];
      sheet.attackList = this.collectAttackList();
      return sheet;
    }

    /** Пересчитывает производные значения и обновляет подписи. */
    refresh() {
      const sheet = this.collect();
      this.sheet = sheet;
      this.derived = DnD.computeDerived(sheet);
      this.paintDerived();
      this.syncHitDie();
      if (this.handlers.onChange && !this.readOnly) this.handlers.onChange(sheet);
    }

    /** Обновляет подпись кости хитов и доступность броска. */
    syncHitDie() {
      if (!this.hitDieDie) return;
      const hitField = this.root.querySelector('[data-field="hitDice"]');
      const raw = hitField ? hitField.value : (this.sheet && this.sheet.hitDice);
      // Пул строится из классов в форме, а не из присланного листа: человек
      // мог только что добавить класс, и кость должна появиться сразу.
      const pool = DnD.hitDicePool({ classes: this.currentClasses(), hitDice: raw });
      if (this.hitDiePick) {
        this.hitDiePick.innerHTML = '';
        for (const item of pool) {
          const option = el('option', null, `${item.die} ×${item.count}`);
          option.value = item.die;
          this.hitDiePick.appendChild(option);
        }
        this.hitDiePick.hidden = pool.length <= 1;
      }
      const selected = pool.find((item) => item.die === this.hitDieSelected) || pool[0] || null;
      if (selected) {
        this.hitDieSelected = selected.die;
        this.hitDieDie.textContent = selected.die;
        if (this.hitDiePick) this.hitDiePick.value = selected.die;
      } else {
        this.hitDieDie.textContent = '—';
      }
      const sides = selected ? selected.sides : null;
      const total = pool.reduce((sum, item) => sum + item.count, 0);
      const spent = DnD.clampNumber(this.sheet && this.sheet.hitDiceSpent, 0, total, 0);
      const remaining = Math.max(0, total - spent);
      const hp = Number(this.sheet && this.sheet.hp) || 0;
      // Истощение 4 уровня уменьшает максимум: «полное здоровье» для кости
      // хитов и долгого отдыха считается от нового потолка.
      const maxHp = DnD.effectiveMaxHp(this.sheet);
      if (this.hitDiePool) {
        this.hitDiePool.textContent = total
          ? `Кости хитов: ${remaining} из ${total}`
          : 'Кости хитов: нет';
        this.hitDiePool.title = total ? `Потрачено: ${spent}` : 'Выберите класс с костью хитов';
      }
      if (this.hitDieSpend) {
        this.hitDieSpend.disabled = this.readOnly || !sides || remaining <= 0 || hp >= maxHp;
        this.hitDieSpend.title = remaining <= 0
          ? 'Костей хитов не осталось'
          : (hp >= maxHp
            ? 'Здоровье уже полное'
            : 'Короткий отдых: потратить кость хитов и восстановить здоровье');
      }
      if (this.hitDieLongRest) this.hitDieLongRest.disabled = this.readOnly;
      if (this.hitDieRoll) {
        this.hitDieRoll.disabled = this.readOnly || !sides;
        this.hitDieRoll.title = sides
          ? 'Бросить одну кость хитов и добавить модификатор Телосложения'
          : 'Выберите класс, чтобы появилась кость';
      }
      if (!sides) this.hitDieOut.hidden = true;
    }

    /** Бросает одну кость хитов; результат виден тут же, в листе. */
    rollHitDie() {
      const sides = DnD.hitDieSides(this.hitDieSelected || (this.sheet && this.sheet.hitDice));
      if (!sides || this.readOnly) return;
      const roll = secureDie(sides);
      const con = this.derived && Number.isFinite(this.derived.modifiers.con)
        ? this.derived.modifiers.con
        : 0;
      const total = roll + con;
      this.hitDieValue.textContent = String(total);
      this.hitDieDetail.textContent = `d${sides}: ${roll} ${DnD.formatModifier(con)} Тел`;
      this.hitDieOut.hidden = false;
      this.hitDieOut.classList.remove('is-pop');
      void this.hitDieOut.offsetWidth;
      this.hitDieOut.classList.add('is-pop');
    }

    /** Короткий отдых: тратит одну кость и лечит на её результат. */
    spendHitDie() {
      if (this.readOnly || !this.handlers.onChange) return;
      const sheet = this.collect();
      const pool = DnD.hitDicePool({ classes: this.currentClasses(), hitDice: sheet.hitDice });
      const total = pool.reduce((sum, item) => sum + item.count, 0);
      const spent = DnD.clampNumber(sheet.hitDiceSpent, 0, total, 0);
      const sides = DnD.hitDieSides(this.hitDieSelected || sheet.hitDice);
      const hp = Number(sheet.hp) || 0;
      const maxHp = DnD.effectiveMaxHp(sheet);
      if (!sides || spent >= total || hp >= maxHp) return;
      const roll = secureDie(sides);
      const con = this.derived && Number.isFinite(this.derived.modifiers.con)
        ? this.derived.modifiers.con
        : 0;
      const heal = Math.max(0, roll + con);
      sheet.hp = Math.min(maxHp, hp + heal);
      sheet.hitDiceSpent = spent + 1;
      this.setSheet(sheet);
      this.refresh();
      this.hitDieValue.textContent = String(heal);
      this.hitDieDetail.textContent = `d${sides}: ${roll} ${DnD.formatModifier(con)} Тел, кость ${spent + 1} из ${total}`;
      this.hitDieOut.hidden = false;
      this.hitDieOut.classList.remove('is-pop');
      void this.hitDieOut.offsetWidth;
      this.hitDieOut.classList.add('is-pop');
    }

    /** Долгий отдых: полное здоровье, ячейки и половина костей хитов. */
    takeLongRest() {
      if (this.readOnly || !this.handlers.onChange) return;
      const sheet = this.collect();
      const pool = DnD.hitDicePool({ classes: this.currentClasses(), hitDice: sheet.hitDice });
      const total = pool.reduce((sum, item) => sum + item.count, 0);
      const spent = DnD.clampNumber(sheet.hitDiceSpent, 0, total, 0);
      const restore = Math.min(spent, Math.max(1, Math.floor(total / 2)));
      sheet.hp = DnD.effectiveMaxHp(sheet);
      sheet.tempHp = 0;
      sheet.deathSavesSuccesses = 0;
      sheet.deathSavesFailures = 0;
      sheet.spellSlotsUsed = DnD.SPELL_SLOT_LEVELS.map(() => 0);
      sheet.hitDiceSpent = Math.max(0, spent - restore);
      // Долгий отдых снимает концентрацию и один уровень истощения.
      sheet.concentration = '';
      sheet.exhaustion = Math.max(0, (Number(sheet.exhaustion) || 0) - 1);
      this.setSheet(sheet);
      this.refresh();
      this.hitDieOut.hidden = true;
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
      this.paintExhaustion();
      this.paintVitalState();
      this.paintSpellSlots();
    }

    /** Последствия истощения словами: что именно сейчас действует. */
    paintExhaustion() {
      const node = this.exhaustionNote;
      if (!node) return;
      const effects = DnD.exhaustionEffects(this.sheet && this.sheet.exhaustion);
      const parts = [];
      if (effects.checkDisadvantage) parts.push('помеха проверкам');
      if (effects.attackDisadvantage) parts.push('помеха атакам');
      if (effects.saveDisadvantage) parts.push('помеха спасброскам');
      if (effects.speedMultiplier === 0) parts.push('скорость 0');
      else if (effects.speedMultiplier < 1) parts.push(`скорость ${DnD.effectiveSpeed(this.sheet)} фт`);
      if (effects.maxHpMultiplier < 1) parts.push(`максимум хитов ${DnD.effectiveMaxHp(this.sheet)}`);
      if (effects.dead) parts.push('смерть');
      node.hidden = !parts.length;
      node.textContent = parts.length ? `Истощение: ${parts.join(', ')}.` : '';
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
      const previous = this.sheet;
      this.sheet = data;
      const cls = DnD.CLASSES.find((item) => item.label === data.charClass);
      this.autoHitDie = cls ? `1${cls.hitDie}` : null;
      // Другой персонаж — другой бросок: результат прошлого героя на новом
      // листе выглядел бы как только что выпавший.
      if (previous && this.hitDieOut
        && (previous.playerName !== data.playerName || previous.characterName !== data.characterName)) {
        this.hitDieOut.hidden = true;
      }
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
        if (name === 'charClass' && input.tagName === 'SELECT') {
          const value = data[name] === null || data[name] === undefined ? '' : String(data[name]);
          // Старые листы хранят класс свободным текстом. Чтобы выбор не стёр
          // незнакомое название, добавляем его отдельным пунктом списка.
          if (value && ![...input.options].some((option) => option.value === value)) {
            const option = el('option', null, value);
            option.value = value;
            input.appendChild(option);
          }
          input.value = value;
          continue;
        }
        const value = data[name];
        input.value = value === null || value === undefined ? '' : String(value);
      }
      if (this.stateNodes) {
        this.stateNodes.insp.value = String(DnD.clampNumber(
          data.inspiration, 0, DnD.LIMITS.maxInspiration, 0
        ));
        this.stateNodes.exh.value = String(DnD.clampNumber(
          data.exhaustion, 0, DnD.LIMITS.maxExhaustion, 0
        ));
        this.stateNodes.conc.value = data.concentration || '';
        const coins = data.coins && typeof data.coins === 'object' ? data.coins : {};
        for (const [key, input] of Object.entries(this.stateNodes.coins)) {
          input.value = String(DnD.clampNumber(coins[key], 0, DnD.LIMITS.maxCoins, 0));
        }
      }
      for (const ability of DnD.ABILITY_KEYS) {
        this.saveNodes[ability].check.checked = Boolean(data.saveProficiencies && data.saveProficiencies[ability]);
      }
      for (const skill of DnD.SKILLS) {
        this.skillNodes[skill.key].check.checked = Boolean(data.skillProficiencies && data.skillProficiencies[skill.key]);
        this.skillNodes[skill.key].expert.checked = Boolean(data.skillExpertise && data.skillExpertise[skill.key]);
      }
      this.applyExtraClasses(data);
      const sameCharacter = Boolean(previous)
        && previous.playerName === data.playerName
        && previous.characterName === data.characterName;
      this.syncAttackRows(data.attackList, sameCharacter);
      this.derived = DnD.computeDerived(data);
      this.paintDerived();
      this.syncHitDie();
    }

    /** @param {boolean} value */
    setReadOnly(value) {
      this.readOnly = Boolean(value);
      this.root.classList.toggle('is-readonly', this.readOnly);
      for (const input of this.inputs) input.disabled = this.readOnly;
      for (const box of this.checkboxes) box.disabled = this.readOnly;
      for (const row of this.extraRows || []) {
        row.select.disabled = this.readOnly;
        row.level.disabled = this.readOnly;
        if (row.removeButton) row.removeButton.disabled = this.readOnly;
      }
      for (const row of this.attackRows || []) {
        for (const node of [row.name, row.bonus, row.damage, row.hit, row.dmg, row.remove]) {
          node.disabled = this.readOnly;
        }
      }
      if (this.attackAdd) this.attackAdd.disabled = this.readOnly;
      this.updateClassSummary();
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
    if (this.stateNodes) {
      this.stateNodes.insp.disabled = this.readOnly;
      this.stateNodes.exh.disabled = this.readOnly;
      this.stateNodes.conc.readOnly = this.readOnly;
      this.stateNodes.concRoll.disabled = this.readOnly;
      for (const input of Object.values(this.stateNodes.coins)) input.disabled = this.readOnly;
    }
    // Замороженный лист бросать нельзя: мастер смотрит чужой лист и не должен
    // в неё вносить боевые броски от лица игрока.
    this.updateRollAvailability();
    this.paintDerived();
    this.syncHitDie();
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
     *
     * Истощение накладывает помеху само: проверкам с 1 уровня, атакам и
     * спасброскам с 3. Помеха и преимущество друг друга гасят, как в правилах.
     * @param {string} label
     * @param {string} modifier
     * @param {'check'|'save'|'attack'} [kind]
     * @param {string} [ability] характеристика спасброска
     */
    rollCheck(label, modifier, kind = 'check', ability) {
      if (!this.handlers.onRollCheck || this.readOnly) return;
      const effects = DnD.exhaustionEffects(this.sheet && this.sheet.exhaustion);
      const conditions = this.handlers.getConditions ? this.handlers.getConditions() : [];
      const forced = (kind === 'attack'
        ? effects.attackDisadvantage
        : (kind === 'save' ? effects.saveDisadvantage : effects.checkDisadvantage))
        || DnD.conditionRollDisadvantage(conditions, kind, ability);
      let mode = this.rollMode;
      if (forced && mode === 'advantage') mode = 'normal';
      else if (forced) mode = 'disadvantage';
      const dice = mode === 'advantage' ? '2d20kh1'
        : (mode === 'disadvantage' ? '2d20kl1' : 'd20');
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
