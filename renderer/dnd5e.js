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
  const GRID = {
    minCell: 8,
    maxCell: 512,
    defaultCell: 46,
    minColumns: 2,
    maxColumns: 200
  };

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

  const LIMITS = {
    maxNameLength: 40,
    maxChatLength: 1000,
    maxImageBytes: 10 * 1024 * 1024,
    // Прочность фишки. Те же числа, что в LIMITS в server/state.js: поле
    // ввода показывает этот предел, и сервер обязан соглашаться.
    maxTokenHp: 9999,
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
    maxClassLength: 60
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
      hitDice: '1d8',
      armorClass: 10,
      initiativeMisc: 0,
      speed: 30,
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
    const level = Math.min(20, Math.max(1, Math.round(Number(safe.level) || 1)));
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
    DICE_SIDES,
    GRID,
    HIT_DICE,
    LIMITS,
    MAP_LABELS,
    MAP_TYPES,
    SKETCH,
    SKILLS,
    abilityModifier,
      clampNumber,
    computeDerived,
    computeVitalState,
    createEmptySheet,
    formatModifier,
    proficiencyBonus
  };
})(window);
