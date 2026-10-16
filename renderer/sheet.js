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
     * @param {{onChange?: (sheet: object) => void, onPlayerChange?: (playerId: string) => void, onBack?: () => void}} handlers
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

      this.statusNode = el('span', 'sheet__status', '');
      headTools.appendChild(this.statusNode);
      head.appendChild(headTools);
      this.root.appendChild(head);

      // --- Список игроков (ДМ): лист открывается по нажатию на имя ---
      this.listNode = el('div', 'sheet__players');
      this.listNode.hidden = true;
      this.root.appendChild(this.listNode);

      const grid = el('div', 'sheet__grid');
      this.gridNode = grid;
      this.root.appendChild(grid);

      // --- Колонка 1: характеристики, спасброски, бой ---
      const col1 = el('section', 'sheet__col');

      const identity = el('div', 'box');
      identity.appendChild(el('div', 'box__title', 'Персонаж'));

      // Фото персонажа. Загружается один раз и дальше работает как аватар
      // везде в сессии: в списке игроков и на фишке, если фишка закреплена
      // за этим игроком. Само фото в лист не входит числовым полем, поэтому
      // форма его не собирает и не перезаписывает при каждом вводе.
      const photoRow = el('div', 'photo-row');
      this.photoNode = el('img', 'photo-row__img');
      this.photoNode.alt = 'Фото персонажа';
      this.photoNode.hidden = true;
      photoRow.appendChild(this.photoNode);

      const photoTools = el('div', 'photo-row__tools');
      this.photoInput = el('input');
      this.photoInput.type = 'file';
      this.photoInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
      this.photoInput.hidden = true;
      this.photoInput.addEventListener('change', () => {
        const file = this.photoInput.files && this.photoInput.files[0];
        // Сбрасываем значение: иначе повторный выбор того же файла не даст
        // события change, и фото не обновится.
        this.photoInput.value = '';
        if (file && this.handlers.onPhoto) this.handlers.onPhoto(file);
      });
      photoTools.appendChild(this.photoInput);

      const photoButton = el('button', 'btn btn--ghost btn--tiny', '📷 Фото');
      photoButton.type = 'button';
      photoButton.title = 'Это фото станет аватаром на фишке и в списке игроков';
      photoButton.addEventListener('click', () => {
        if (!this.readOnly) this.photoInput.click();
      });
      this.photoButton = photoButton;
      photoTools.appendChild(photoButton);

      this.photoClearButton = el('button', 'btn btn--ghost btn--tiny', 'Убрать');
      this.photoClearButton.type = 'button';
      this.photoClearButton.addEventListener('click', () => {
        if (!this.readOnly && this.handlers.onPhotoClear) this.handlers.onPhotoClear();
      });
      photoTools.appendChild(this.photoClearButton);
      photoRow.appendChild(photoTools);
      identity.appendChild(photoRow);

      identity.appendChild(this.field('characterName', 'Имя персонажа'));
      identity.appendChild(this.field('playerName', 'Имя игрока'));
      identity.appendChild(this.field('charClass', 'Класс'));
      identity.appendChild(this.field('race', 'Раса'));
      identity.appendChild(this.field('background', 'Предыстория'));
      identity.appendChild(this.field('alignment', 'Мировоззрение'));
      col1.appendChild(identity);

      const abilities = el('div', 'box');
      abilities.appendChild(el('div', 'box__title', 'Характеристики'));
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
        this.abilityNodes[ability.key] = { input, mod };
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
        this.saveNodes[ability.key] = { check, value };
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
        this.skillNodes[skill.key] = { check, expert, value };
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
    /**
     * Показывает фото персонажа или пустое место.
     *
     * Вызывается и когда лист приходит с сервера, и сразу после загрузки
     * файла, чтобы не ждать кругового обмена с сервером.
     * @param {string|null} url
     */
    setPhoto(url) {
      if (!this.photoNode) return;
      const has = typeof url === 'string' && url;
      this.photoNode.hidden = !has;
      if (has) this.photoNode.src = url;
      else this.photoNode.removeAttribute('src');
      if (this.photoClearButton) this.photoClearButton.hidden = !has;
      if (this.photoButton) {
        this.photoButton.textContent = has ? '📷 Заменить' : '📷 Фото';
        this.photoButton.disabled = Boolean(this.readOnly);
      }
    }

    collect() {
      // Пустой лист создаётся один раз на представление, а не на каждый
      // символ в текстовом поле.
      const sheet = this.emptySheet || (this.emptySheet = DnD.createEmptySheet());

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
      // Фото живёт рядом с листом, но не часть его чисел, поэтому ставится
      // здесь, а не разбирается в цикле по полям формы.
      this.setPhoto(typeof data.photoUrl === 'string' ? data.photoUrl : null);
    }

    /** @param {boolean} value */
    setReadOnly(value) {
      this.readOnly = Boolean(value);
      this.root.classList.toggle('is-readonly', this.readOnly);
      for (const input of this.inputs) input.disabled = this.readOnly;
      for (const box of this.checkboxes) box.disabled = this.readOnly;
      if (this.manualProfCheck) this.manualProfCheck.disabled = this.readOnly;
      if (this.manualProfCheck && !this.manualProfCheck.checked) this.manualProfInput.hidden = true;
      // Кнопки фото при просмотре только убираются: фотографию ДМ смотрит,
      // но не меняет, а игрок при отключённом поле ввода тоже.
      if (this.photoButton) this.photoButton.disabled = this.readOnly;
      if (this.photoClearButton) this.photoClearButton.hidden = this.readOnly;
      this.paintDerived();
    }

    /** @param {string} text */
    setStatus(text) {
      if (this.statusNode) this.statusNode.textContent = text || '';
    }

    /**
     * Режим панели: список игроков («list») или открытый лист («sheet»).
     * Кнопка возврата нужна только там, где есть откуда возвращаться — то есть
     * у ДМ, который попал в лист из списка игроков.
     * @param {'list'|'sheet'} mode
     * @param {{canGoBack?: boolean}} [options]
     */
    setMode(mode, options = {}) {
      this.mode = mode === 'list' ? 'list' : 'sheet';
      const isList = this.mode === 'list';
      this.listNode.hidden = !isList;
      this.gridNode.hidden = isList;
      this.backButton.hidden = isList || !options.canGoBack;
      this.detachButton.hidden = isList;
      this.titleNode.textContent = isList ? 'Листы игроков' : 'Лист персонажа';
    }

    /**
     * Список игроков у ДМ: лист открывается нажатием на имя.
     * @param {Array<{playerId: string, name: string, online: boolean, role: string}>} players
     * @param {string|null} selectedId
     */
    setPlayerList(players, selectedId) {
      this.listNode.innerHTML = '';
      if (!players.length) {
        this.listNode.appendChild(el('div', 'sheet__players-empty',
          'В лобби сейчас никого нет. Как только игрок подключится к столу, его имя появится здесь.'));
        return;
      }
      this.listNode.appendChild(el('div', 'muted',
        'Нажмите на имя игрока — откроется его лист персонажа (для ДМ он только для чтения).'));

      for (const player of players) {
        const row = el('button', 'player-row player-row--button');
        row.type = 'button';
        row.dataset.playerId = player.playerId;
        row.classList.toggle('is-offline', !player.online);
        row.classList.toggle('is-selected', player.playerId === selectedId);

        row.appendChild(el('div', 'player-row__avatar', initials(player.name)));

        const main = el('div', 'player-row__main');
        const nameRow = el('div', 'player-row__name');
        nameRow.appendChild(el('span', null, player.name));
        main.appendChild(nameRow);
        const meta = el('div', 'player-row__meta');
        meta.appendChild(el('span', `dot ${player.online ? 'dot--on' : 'dot--off'}`));
        meta.appendChild(el('span', null, player.online ? 'в сети' : 'не в сети'));
        main.appendChild(meta);
        row.appendChild(main);

        row.appendChild(el('span', 'player-row__go', 'Открыть лист →'));

        row.addEventListener('click', () => {
          if (this.handlers.onPlayerChange) this.handlers.onPlayerChange(player.playerId);
        });
        this.listNode.appendChild(row);
      }
    }
  }

  global.SheetView = SheetView;
})(window);
