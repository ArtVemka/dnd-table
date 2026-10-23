/*
 * Набор проверок, который выполняется ВНУТРИ renderer-процесса Electron.
 *
 * Файл читается как строка и передаётся в webContents.executeJavaScript,
 * поэтому он написан как IIFE-выражение и возвращает объект с результатами.
 * Проверяются: загрузка скриптов при текущем CSP, мост preload, правила
 * D&D 5e, все компоненты интерфейса и полный сценарий «создать кампанию →
 * запустить стол → фишка/кубик/чат → сохранить кампанию → остановить стол».
 */

(async () => {
  const checks = [];
  const check = (name, fn) => {
    console.log(`ШАГ: ${name}`);
    try {
      fn();
      checks.push({ name, ok: true });
    } catch (error) {
      checks.push({ name, ok: false, error: error.message });
    }
  };
  const assert = (condition, message) => {
    if (!condition) throw new Error(message || 'утверждение не выполнено');
  };
  // Строгое сравнение, как в test/sheet.js: без него «0» и «false» считались бы
  // равными, а проверки портретов и фишек на этом ломались бы тихо.
  assert.strictEqual = (actual, expected, message) => {
    if (actual !== expected) {
      throw new Error(message
        ? `${message} (получено ${JSON.stringify(actual)}, ждали ${JSON.stringify(expected)})`
        : `получено ${JSON.stringify(actual)}, ждали ${JSON.stringify(expected)}`);
    }
  };
  // Сравнение структур: порядок ключей в разметке и в данных одинаковый, а
  // сообщение об ошибке должно показывать, что именно разошлось.
  assert.deepStrictEqual = (actual, expected, message) => {
    const left = JSON.stringify(actual);
    const right = JSON.stringify(expected);
    if (left !== right) {
      throw new Error(message ? `${message} (получено ${left}, ждали ${right})` : `получено ${left}, ждали ${right}`);
    }
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Кнопка по тексту внутри узла: искать по классу нельзя, у кнопок он общий. */
  const byText = (root, text) => [...root.querySelectorAll('button')]
    .find((node) => node.textContent.trim() === text);
  /**
   * Окно настроек стола.
   *
   * Именно последнее: тренировочный стол открывает своё, и по первому попаданию
   * в список настроек настраивался бы не тот стол.
   * @returns {Element}
   */
  const settingsOverlay = () => {
    const overlays = document.querySelectorAll('.modal-overlay');
    return overlays[overlays.length - 1];
  };
  const waitFor = async (fn, label, timeout = 20000) => {
    const start = Date.now();
    for (;;) {
      let value = null;
      try {
        value = fn();
      } catch { /* элемент ещё не готов */ }
      if (value) return value;
      if (Date.now() - start > timeout) throw new Error(`Таймаут: ${label}`);
      await wait(50);
    }
  };
  /** То же, но без исключения: неудача попадает в отчёт, а не обрывает прогон. */
  const softWait = async (fn, label, timeout = 10000) => {
    try {
      await waitFor(fn, label, timeout);
      return true;
    } catch {
      return false;
    }
  };

  const PNG_1PX =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

  /**
   * Настоящая карта 400x300 из четырёх однотонных квадратов: красный, синий,
   * зелёный, жёлтый. Нужна там, где важно не «картинка вообще есть», а что
   * именно попало в картинку — например, при рисовании поверх карты.
   */
  const MAP_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAZAAAAEsCAIAAABi1XKVAAAEhUlEQVR42u3UMRHAIAAEQfwQA6kYiuhBSkzggiY24gYTX1DszFq4K99dIe4aC+KKtDAsDAvDAsPCsDAsMCwMC8MCw8KwMCwwLAwLwwLDwrAwLDAsDAvDAsPCsDAsMCwMC8MCw8KwMCwwLAwLwwLDwrAwLDAsDAvDAsPCsDAsMCwMC8MCw8KwMCwwLAwLwwLDwrAwLDAsDAvDwrDUhWFhWBgWGBaGhWGBYWFYGBYYFoaFYYFhYVgYFhgWhoVhgWFhWBgWGBaGhWGBYWFYGBYYFoaFYYFhYVgYFhgWhoVhgWFhWBgWGBaGhWGBYWFYGBYYFoaFYYFhYVgYFhgWhoVhgWFhWBgWhqUuDAvDwrDAsDAsDAsMC8PCsMCwMCwMCwwLw8KwwLAwLAwLDAvDwrDAsDAsDAsMC8PCsMCwMCwMCwwLw8KwwLAwLAwLDAvDwrDAsDAsDAsMC8PCsMCwMCwMCwwLw8KwwLAwLAwLDAvDwrAwLDAsDAvDAsPCsDAsMCwMC8MCw8KwMCwwLAwLwwLDwrAwLDAsDAvDAsPCsDAsMCwMC8MCw8KwMCwwLAwLwwLDwrAwLDAsDAvDAsPCsDAsMCwMC8MCw8KwMCwwLAwLwwLDwrAwLJAWhoVhYVhgWBgWhgWGhWFhWGBYGBaGBYaFYWFYYFgYFoYFhoVhYVhgWBgWhgWGhWFhWGBYGBaGBYaFYWFYYFgYFoYFhoVhYVhgWBgWhgWGhWFhWGBYGBaGBYaFYWFYYFgYFoYFhoVhYVgYlrowLAwLwwLDwrAwLDAsDAvDAsPi4GG194G4f3aIMywMC8PCsMCwMCwMCwwLw8KwwLAwLAwLDAvDwrDAsDAsDAsMC8PCsMCwMCwMCwwLw8KwwLAwLAwLDAvDwrDAsDAsDAsMC8PCsMCwMCwMCwwLw8KwwLAwLAwLDAvDwrDAsDAsDAsMC8PCsDAsaWFYGBaGBYaFYWFYYFgYFoYFhoVhYVhgWBgWhgWGhWFhWGBYGBaGBYaFYWFYYFgYFoYFhoVhYVhgWBgWhgWGhWFhWGBYGBaGBYaFYWFYYFgYFoYFhoVhYVhgWBgWhgWGhWFhWGBYGBaGhWGpC8PCsDAsMCwMC8MCw8KwMCwwLAwLwwLDwrAwLDAsDAvDAsPCsDAsMCwMC8MCw8KwMCwwLAwLwwLDwrAwLDAsDAvDAsPCsDAsMCwMC8MCw8KwMCwwLAwLwwLDwrAwLDAsDAvDAsPCsDAsDEtdGBaGhWGBYWFYGBYYFoaFYYFhYVgYFhgWhoVhgWFhWBgWGBaGhWGBYWFYGBYYFoaFYYFhYVgYFhgWhoVhgWFhWBgWGBaGhWGBYWFYGBYYFoaFYYFhYVgYFhgWhoVhgWFhWBgWGBaGhWFhWGBYGBaGBYaFYWFYYFgYFoYFhoVhYVhgWBgWhgWGhWFhWGBYGBaGBYaFYWFYYFgYFoYFhoVhYVhgWBgWhgWGhWFhWGBYGBaGBYaFYWFYYFgYFoYFhoVhYVhgWBgWhgWGhWFhWCAtDAvDwrDAsDAsDAsMC8PCsMCwONgGOHppZadPWUYAAAAASUVORK5CYII=';

  /** Цвета квадратов тестовой карты: как их видно в сохранённой картинке. */
  const MAP_COLORS = {
    topLeft: '192,57,43',
    topRight: '44,111,187',
    bottomLeft: '63,143,69',
    bottomRight: '217,164,65'
  };
  /** Размер тестовой карты в пикселях. */
  const MAP_WIDTH = 400;
  const MAP_HEIGHT = 300;

  const sandbox = document.createElement('div');
  sandbox.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:900px;overflow:hidden;z-index:-1;opacity:0.01;';
  document.body.appendChild(sandbox);

  /**
   * Заголовочный шрифт с кириллицей. Грузим заранее: проверка синхронная,
   * а подгрузка шрифта асинхронна. Если файл шрифта потерялся при сборке,
   * браузер молча возьмёт подстановочный шрифт, и русские заголовки поедут в
   * другую гарнитуру — на латинице это незаметно.
   */
  const cormorantFaces = await document.fonts.load('16px cormorant', 'Абвгдё');
  check('заголовочный шрифт загрузился вместе с кириллицей', () => {
    assert(cormorantFaces.length > 0, 'шрифт не найден среди загруженных');
    assert(cormorantFaces.every((face) => face.status === 'loaded'), 'подмножество не загрузилось');
  });
  check('русские заголовки набираются заголовочным шрифтом, а не подстановкой', () => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const width = (font) => {
      context.font = font;
      return Math.round(context.measureText('Абвгд').width * 100) / 100;
    };
    // Ширина кириллицы в заголовке и в основном шрифте разная: значит, глифы
    // берутся из гарнитуры, а не из подстановки.
    const heading = width('16px cormorant');
    const body = width('16px "Segoe UI"');
    assert(heading !== body, `ширины совпали (${heading}): кириллица ушла в подстановку`);
  });

  const SAMPLE_SHEET = {
    playerName: 'Артём', characterName: 'Тордин', charClass: 'Воин', race: 'Дварф',
    background: 'Солдат', alignment: 'Законно-добрый',
    level: 5, experience: 6500,
    abilities: { str: 17, dex: 14, con: 16, int: 10, wis: 12, cha: 8 },
    saveProficiencies: { str: true, con: true },
    skillProficiencies: { athletics: true, perception: false },
    skillExpertise: { athletics: true },
    hp: 44, maxHp: 44, tempHp: 0, hitDice: '1d10',
    armorClass: 18, initiativeMisc: 0, speed: 25,
    attacks: 'Боевой топор +7', equipment: 'Кольчуга', features: 'Второе дыхание', notes: 'Ищет брата'
  };

  return (async () => {
    let campaignId = null;

    /* ------------------------------------------------ загрузка и изоляция */

    check('preload-мост доступен в renderer', () => {
      assert(window.desktop, 'нет window.desktop');
      assert(window.desktop.isElectron === true, 'нет флага isElectron');
      for (const fn of ['createCampaign', 'loadCampaign', 'saveCampaign', 'listCampaigns', 'startHost', 'stopHost', 'hostStatus']) {
        assert(typeof window.desktop[fn] === 'function', `нет window.desktop.${fn}`);
      }
    });

    check('скрипты renderer загрузились (CSP не блокирует)', () => {
      assert(window.DnD5e, 'нет DnD5e');
      assert(window.SheetView, 'нет SheetView');
      assert(window.TableUI, 'нет TableUI');
      assert(window.TableUI.MapView && window.TableUI.PlayersList && window.TableUI.ChatPanel
        && window.TableUI.DicePanel && window.TableUI.TokenPanel, 'не все компоненты стола загружены');
      assert(window.io, 'нет socket.io-client');
    });

    check('nodeIntegration выключен: require недоступен в renderer', () => {
      assert(typeof window.require === 'undefined', 'window.require доступен');
    });

    /* ------------------------------------------------ правила D&D 5e 2014 */

    const DnD = window.DnD5e;

    check('модификатор характеристики = floor((значение - 10) / 2)', () => {
      assert(DnD.abilityModifier(1) === -5, '1 -> -5');
      assert(DnD.abilityModifier(8) === -1, '8 -> -1');
      assert(DnD.abilityModifier(9) === -1, '9 -> -1');
      assert(DnD.abilityModifier(10) === 0, '10 -> 0');
      assert(DnD.abilityModifier(11) === 0, '11 -> 0');
      assert(DnD.abilityModifier(12) === 1, '12 -> 1');
      assert(DnD.abilityModifier(17) === 3, '17 -> 3');
      assert(DnD.abilityModifier(20) === 5, '20 -> 5');
      assert(DnD.abilityModifier(30) === 10, '30 -> 10');
    });

    check('бонус мастерства зависит от уровня (2014)', () => {
      const expected = { 1: 2, 4: 2, 5: 3, 8: 3, 9: 4, 12: 4, 13: 5, 16: 5, 17: 6, 20: 6 };
      for (const [level, bonus] of Object.entries(expected)) {
        assert(DnD.proficiencyBonus(Number(level)) === bonus, `уровень ${level} -> +${bonus}`);
      }
    });

    check('навыки и спасброски: владение добавляет бонус мастерства', () => {
      const derived = DnD.computeDerived(SAMPLE_SHEET);
      assert(derived.profBonus === 3, '+3 на 5 уровне');
      assert(derived.modifiers.str === 3 && derived.modifiers.cha === -1, 'модификаторы характеристик');
      assert(derived.saves.str.total === 6, 'спасбросок Силы с владением: 3 + 3 = 6');
      assert(derived.saves.dex.total === 2, 'спасбросок Ловкости без владения: +2');
      assert(derived.skills.athletics.total === 9, 'Атлетика с компетентностью: 3 + 2*3 = 9');
      assert(derived.skills.perception.total === 1, 'Внимательность без владения: +1');
      assert(derived.initiative === 2, 'инициатива = модификатор Ловкости');
      assert(derived.passivePerception === 11, 'пассивная Внимательность = 10 + 1');
    });

    check('18 навыков D&D 5e 2014 объявлены', () => {
      assert(DnD.SKILLS.length === 18, `навыков: ${DnD.SKILLS.length}`);
      assert(DnD.SKILLS.some((skill) => skill.key === 'perception' && skill.ability === 'wis'), 'Внимательность/Мудрость');
      assert(DnD.SKILLS.some((skill) => skill.key === 'athletics' && skill.ability === 'str'), 'Атлетика/Сила');
    });

    check('перечислены все 6 характеристик с русскими названиями', () => {
      assert(DnD.ABILITIES.length === 6);
      assert(DnD.ABILITY_LABELS.str === 'Сила' && DnD.ABILITY_LABELS.cha === 'Харизма');
    });

    /* ------------------------------------------------ стол без сервера */

    check('скрипт тренировочного стола загрузился (CSP не блокирует)', () => {
      assert(window.LocalTable, 'нет LocalTable');
      for (const fn of ['createLocalTable', 'readDraft', 'saveDraft', 'sheetHasContent', 'shouldOfferDraft']) {
        assert(typeof window.LocalTable[fn] === 'function', `нет LocalTable.${fn}`);
      }
    });

    check('черновик листа переживает закрытие приложения', () => {
      const LT = window.LocalTable;
      const id = 'p-train-draft';
      assert(LT.readDraft(id) === null, 'черновика быть не должно');
      LT.saveDraft(id, { ...DnD.createEmptySheet('Артём'), characterName: 'Тордин', level: 3 });
      const back = LT.readDraft(id);
      assert(back && back.characterName === 'Тордин' && back.level === 3,
        `черновик не вернулся: ${JSON.stringify(back)}`);
    });

    check('пустой лист отличается от заполненного', () => {
      const { sheetHasContent } = window.LocalTable;
      assert(sheetHasContent(DnD.createEmptySheet('Артём')) === false, 'пустой лист считается заполненным');
      assert(sheetHasContent(null) === false, 'null считается заполненным');
      assert(sheetHasContent({ ...DnD.createEmptySheet('Артём'), characterName: 'Тордин' }) === true,
        'имя персонажа не заметили');
      assert(sheetHasContent({ ...DnD.createEmptySheet('Артём'), abilities: { str: 15 } }) === true,
        'характеристики не заметили');
      assert(sheetHasContent({ ...DnD.createEmptySheet('Артём'), skillProficiencies: { stealth: true } }) === true,
        'владение навыком не заметили');
      assert(sheetHasContent({ ...DnD.createEmptySheet('Артём'), notes: 'ищу брата' }) === true,
        'заметки не заметили');
    });

    check('заготовку предлагают только когда на столе лист ещё пуст', () => {
      const { shouldOfferDraft } = window.LocalTable;
      const draft = { ...DnD.createEmptySheet('Артём'), characterName: 'Тордин' };
      assert(shouldOfferDraft({ draft, serverSheet: DnD.createEmptySheet('Артём') }) === true,
        'заготовку не предложили');
      assert(shouldOfferDraft({ draft, serverSheet: draft }) === false,
        'предложили перезаписать уже заполненный лист');
      assert(shouldOfferDraft({ draft: DnD.createEmptySheet('Артём'), serverSheet: null }) === false,
        'предложили пустую заготовку');
      assert(shouldOfferDraft({ draft: null, serverSheet: null }) === false, 'предложили без черновика');
    });

    check('черновик приводится к допустимым значениям', () => {
      const sheet = window.LocalTable.normalizeSheet(
        { level: 99, abilities: { str: 99, dex: -5 }, hp: 'abc', skillExpertise: { athletics: true } },
        'Артём'
      );
      assert(sheet.level === 20, `уровень: ${sheet.level}`);
      assert(sheet.abilities.str === 30, `характеристика: ${sheet.abilities.str}`);
      assert(sheet.abilities.dex === 1, `характеристика: ${sheet.abilities.dex}`);
      assert(sheet.hp === 10, `хиты при мусоре в поле: ${sheet.hp}`);
      assert(sheet.playerName === 'Артём', 'имя игрока');
      assert(sheet.skillExpertise.athletics === false, 'компетентность без владения должна сбрасываться');
    });

    // Лист тренировочного стола можно открыть в двух окнах. Своего сервера у
    // него нет, поэтому окна сходятся через общий черновик: правка в одном окне
    // приходит второму событием storage (событие приходит только чужому окну,
    // поэтому здесь оно создаётся вручную).
    const linkedWindow = { sheets: [] };
    const linkedTable = window.LocalTable.createLocalTable({ playerId: 'p-linked', name: 'Артём' });
    linkedTable.on('characterSheetData', (payload) => linkedWindow.sheets.push(payload));
    linkedTable.emit('joinRoom', { name: 'Артём', playerId: 'p-linked' });
    window.dispatchEvent(new StorageEvent('storage', {
      key: window.LocalTable.draftKey('p-linked'),
      newValue: JSON.stringify({ ...DnD.createEmptySheet('Артём'), characterName: 'Мира', level: 4 })
    }));
    check('правки в отдельном окне листа доходят до тренировочного стола', () => {
      const last = linkedWindow.sheets[linkedWindow.sheets.length - 1];
      assert(last && last.playerId === 'p-linked', 'лист из другого окна не дошёл');
      assert(last.sheet.characterName === 'Мира' && last.sheet.level === 4,
        `лист из другого окна: ${last.sheet.characterName}, уровень ${last.sheet.level}`);
    });

    // Локальный стол проверяем напрямую: события у него те же, что у сервера.
    const train = { joined: null, maps: [], grid: null, tokens: [], rolls: [], chat: [], errors: [] };
    const trainTable = window.LocalTable.createLocalTable({ playerId: 'p-train', name: 'Артём' });
    trainTable.on('joined', (payload) => { train.joined = payload; });
    trainTable.on('mapUpdated', (update) => train.maps.push(update));
    trainTable.on('gridUpdated', (grid) => { train.grid = grid; });
    trainTable.on('tokenCreated', (token) => train.tokens.push(token));
    trainTable.on('tokenUpdated', (token) => train.tokens.push(token));
    trainTable.on('diceRollResult', (roll) => train.rolls.push(roll));
    trainTable.on('chatMessage', (message) => train.chat.push(message));
    trainTable.on('errorMessage', ({ message }) => train.errors.push(message));
    trainTable.emit('joinRoom', { name: 'Артём', playerId: 'p-train' });

    check('тренировочный стол подключает игрока без сервера', () => {
      assert(train.joined, 'событие joined не пришло');
      assert(train.joined.you.role === 'player' && train.joined.you.playerId === 'p-train', 'роль не игрок');
      assert(train.joined.state.campaign.name.includes('Проверка'), 'нет пометки, что это проверка');
      assert(train.joined.state.sheets['p-train'], 'нет листа персонажа');
    });

    trainTable.emit('saveCharacterSheet', { sheet: { ...DnD.createEmptySheet('Артём'), characterName: 'Тордин' } });
    check('лист персонажа сохраняется в тренировочном столе', () => {
      // Снимок, отданный при входе, меняться задним числом не должен: именно
      // его хранит приложение.
      assert(train.joined.state.sheets['p-train'].characterName === '', 'снимок изменился задним числом');
      const draft = window.LocalTable.readDraft('p-train');
      assert(draft && draft.characterName === 'Тордин', `черновик: ${JSON.stringify(draft).slice(0, 60)}`);
    });

    trainTable.emit('uploadMap', { type: 'world', image: MAP_PNG, name: 'train.png' });
    trainTable.emit('setGrid', { enabled: true, cell: 56 });
    trainTable.emit('createToken', { name: 'Мой герой', mapType: 'world' });
    check('карты, сетка и фишки работают в тренировочном столе', () => {
      assert(train.maps.length === 1 && train.maps[0].items.length === 1, 'карта не добавилась');
      assert(train.maps[0].items[0].url.startsWith('data:image/png'), 'карта должна оставаться в окне, без файлов');
      assert(train.grid && train.grid.enabled === true && train.grid.cell === 56, 'сетка не включилась');
      assert(train.tokens.length === 1, 'фишка не создалась');
      assert(train.tokens[0].assignedPlayerId === 'p-train', 'фишка не назначена игроку');
    });

    const trainTokenId = train.tokens.length ? train.tokens[0].id : 't-none';
    trainTable.emit('moveToken', { tokenId: trainTokenId, x: 0.25, y: 0.75 });
    trainTable.emit('renameToken', { tokenId: trainTokenId, name: 'Тордин' });
    trainTable.emit('setTokenImage', { tokenId: trainTokenId, image: PNG_1PX });
    trainTable.emit('rollDice', { sides: 20 });
    trainTable.emit('rollDice', { formula: '2d6+3' });
    trainTable.emit('chatMessage', { text: 'Проверка связи' });
    trainTable.emit('nonExistentAction', {});
    check('фишку можно двигать, переименовывать и наряжать без сервера', () => {
      const token = train.tokens[train.tokens.length - 1];
      assert(token.name === 'Тордин', `имя фишки: ${token.name}`);
      assert(token.imageUrl === PNG_1PX, 'картинка фишки не применилась');
      assert(train.rolls.length === 2 && train.rolls[0].sides === 20, 'кубик не бросился');
      const roll = train.rolls[0];
      assert(roll.result >= 1 && roll.result <= 20, `результат броска: ${roll.result}`);
      assert(roll.playerName === 'Артём', 'в броске нет имени игрока');
      assert(train.chat.some((message) => message.text === 'Проверка связи'), 'сообщение чата не прошло');
      assert(train.chat.some((message) => message.isRoll), 'бросок не попал в чат');
      assert(train.errors.length === 1, `неизвестное действие должно ругаться: ${train.errors.join(' | ')}`);
    });
    check('тренировочный стол считает формулы тем же модулем, что и сервер', () => {
      const formula = train.rolls[1];
      assert(formula.formula === '2d6+3', `формула: ${formula.formula}`);
      assert(formula.values.length === 2, `бросков: ${formula.values.length}`);
      const sum = formula.values.reduce((acc, value) => acc + value, 0);
      assert(formula.result === sum + 3, `итог ${formula.result} не равен сумме костей и модулю`);
      assert(train.chat.some((message) => message.isRoll && message.text.includes('2d6+3')),
        'формульный бросок не попал в чат');
    });
    trainTable.disconnect();

    /* ------------------------------------------------ панель листа */

    const sheetHost = document.createElement('div');
    sandbox.appendChild(sheetHost);
    const sheetView = new window.SheetView(sheetHost, {});
    sheetView.setSheet(SAMPLE_SHEET);

    check('лист можно унести на бумагу, а из списка игроков печатать нечего', () => {
      const print = [...sheetHost.querySelectorAll('.btn')].find((button) => button.textContent.includes('Печать'));
      assert(print, 'в листе нет кнопки печати');
      assert(!print.hidden, 'кнопка печати скрыта в открытом листе');
      // Само окно печати в проверке открывать нельзя: оно блокирует процесс.
      // Поэтому подменяем его и смотрим, что кнопка туда обращается.
      const original = window.print;
      let printed = 0;
      window.print = () => { printed += 1; };
      try {
        print.click();
      } finally {
        window.print = original;
      }
      assert.strictEqual(printed, 1, 'кнопка печати не вызвала печать листа');
      sheetView.setMode('pick');
      assert(print.hidden, 'печатать предложено там, где листа нет');
      sheetView.setMode('sheet');
      assert(!print.hidden, 'кнопка печати не вернулась в открытом листе');
    });

    /* ------------------------------------------------ проверка из листа */

    const rolledChecks = [];
    const rollHost = document.createElement('div');
    sandbox.appendChild(rollHost);
    const rollView = new window.SheetView(rollHost, {
      onRollCheck: (formula, label) => rolledChecks.push({ formula, label })
    });
    // Ловкость 14 -> +2, Восприятие 12 -> +1, без владения.
    rollView.setSheet({ ...SAMPLE_SHEET, abilities: { ...SAMPLE_SHEET.abilities, dex: 14, wis: 12 } });

    check('у характеристик, спасбросков и навыков есть кубик проверки', () => {
      assert.strictEqual(rollHost.querySelectorAll('.abil .roll-check').length, 6, 'не у всех характеристик есть кубик');
      assert.strictEqual(rollHost.querySelectorAll('[data-save]').length, 6);
      assert.strictEqual(rollHost.querySelectorAll('.prof-row--skill .roll-check').length,
        window.DnD5e.SKILLS.length, 'не у всех навыков есть кубик');
      assert(!rollView.rollRow.hidden, 'переключатель режима проверки скрыт');
      assert.strictEqual(rollView.rollModeNodes.advantage.textContent, 'преимущ.',
        'подписи режимов не помещаются в узкую колонку');
    });

    check('кубик характеристики бросает d20 с её модификатором', () => {
      const dexCard = [...rollHost.querySelectorAll('.abil')]
        .find((card) => card.querySelector('.abil__name').textContent.includes('Ловкость'));
      dexCard.querySelector('.roll-check').click();
      const last = rolledChecks[rolledChecks.length - 1];
      // Модификатор берётся из листа в момент броска, а не из надписи, которая
      // успела бы устареть после правки характеристики.
      assert.strictEqual(last.formula, 'd20+2', `формула: ${last.formula}`);
      assert(last.label.includes('Ловкость'), `подпись: ${last.label}`);
    });

    check('кубик навыка бросает с его полным модификатором', () => {
      const stealth = [...rollHost.querySelectorAll('.prof-row--skill')]
        .find((row) => row.querySelector('.prof-row__label').textContent === 'Скрытность');
      stealth.querySelector('.roll-check').click();
      const last = rolledChecks[rolledChecks.length - 1];
      // Ловкость +2, без владения и компетентности.
      assert.strictEqual(last.formula, 'd20+2', `формула: ${last.formula}`);
      assert(last.label.includes('Скрытность'), `подпись: ${last.label}`);
    });

    check('преимущество и помеха меняют саму формулу броска', () => {
      const dexCard = [...rollHost.querySelectorAll('.abil')]
        .find((card) => card.querySelector('.abil__name').textContent.includes('Ловкость'));
      const button = dexCard.querySelector('.roll-check');
      rollView.setRollMode('advantage');
      button.click();
      assert.strictEqual(rolledChecks[rolledChecks.length - 1].formula, '2d20kh1+2',
        `преимущество: ${rolledChecks[rolledChecks.length - 1].formula}`);
      rollView.setRollMode('disadvantage');
      button.click();
      assert.strictEqual(rolledChecks[rolledChecks.length - 1].formula, '2d20kl1+2',
        `помеха: ${rolledChecks[rolledChecks.length - 1].formula}`);
      assert(button.title.includes('помеха'), `в заголовке не сказано о режиме: ${button.title}`);
      rollView.setRollMode('normal');
      button.click();
      assert.strictEqual(rolledChecks[rolledChecks.length - 1].formula, 'd20+2', 'обычный бросок не вернулся');
    });

    check('правка характеристики меняет бросок, а не только надпись', () => {
      const dexCard = [...rollHost.querySelectorAll('.abil')]
        .find((card) => card.querySelector('.abil__name').textContent.includes('Ловкость'));
      const input = dexCard.querySelector('[data-ability="dex"]');
      input.value = '20';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      dexCard.querySelector('.roll-check').click();
      // Ловкость 20 -> +5.
      assert.strictEqual(rolledChecks[rolledChecks.length - 1].formula, 'd20+5',
        `после правки: ${rolledChecks[rolledChecks.length - 1].formula}`);
    });

    check('из замороженного листа бросать нельзя', () => {
      const before = rolledChecks.length;
      rollView.setReadOnly(true);
      const button = rollHost.querySelector('.roll-check');
      assert(button.hidden, 'у чужого листа мастера кубик остался видимым');
      button.click();
      assert.strictEqual(rolledChecks.length, before, 'из чужого листа бросили проверку');
      assert(rollView.rollRow.hidden, 'строка переключателя видна на чужом листе');
      rollView.setReadOnly(false);
      assert(!rollHost.querySelector('.roll-check').hidden, 'своё право броска не вернулось');
      assert(!rollView.rollRow.hidden, 'переключатель режима не вернулся');
    });

    check('без открытого листа бросков нет: проверять нечего', () => {
      rollView.setMode('pick');
      assert.strictEqual([...rollHost.querySelectorAll('.roll-check')].filter((node) => !node.hidden).length, 0,
        'без открытого листа видны кубики проверки');
      rollView.setMode('sheet');
    });

    /* ------------------------------------------------- спасброски смерти */

    const deathSaves = [];
    const savedSheets = [];
    const deathHost = document.createElement('div');
    sandbox.appendChild(deathHost);
    const deathView = new window.SheetView(deathHost, {
      // Кнопки счётчика сохраняют лист тем же путём, что и любое поле ввода,
      // поэтому без onChange им некуда деваться.
      onChange: (sheet) => savedSheets.push(sheet),
      onDeathSave: () => deathSaves.push('roll'),
      onResetDeathSaves: () => deathSaves.push('reset')
    });
    const aliveSheet = { ...SAMPLE_SHEET, hp: 12, maxHp: 20 };
    deathView.setSheet(aliveSheet);

    check('счётчики спасбросков спрятаны, пока персонаж жив', () => {
      assert(deathView.deathNode.hidden, 'блок спасбросков виден у живого героя');
    });

    check('на нуле хитов появляются счётчики и кнопка броска', () => {
      deathView.setSheet({ ...aliveSheet, hp: 0 });
      assert(!deathView.deathNode.hidden, 'блок не появился на нуле хитов');
      assert.strictEqual(deathView.deathNodes.Successes.value.textContent, '0');
      assert.strictEqual(deathView.deathNodes.Failures.value.textContent, '0');
      assert(deathView.deathState.textContent.includes('При смерти'), `подпись: ${deathView.deathState.textContent}`);
      deathView.deathRollButton.click();
      assert.strictEqual(deathSaves[deathSaves.length - 1], 'roll', 'бросок не отправлен');
    });

    check('кнопки счётчика двигают его в границах трёх', () => {
      const plus = deathView.deathNodes.Failures.plus;
      const minus = deathView.deathNodes.Failures.minus;
      plus.click();
      plus.click();
      assert.strictEqual(deathView.deathNodes.Failures.value.textContent, '2');
      // Дальше трёх по правилам не идёт, и кнопка гаснет.
      plus.click();
      assert.strictEqual(deathView.deathNodes.Failures.value.textContent, '3');
      assert(plus.disabled, 'счётчик пошёл дальше трёх');
      minus.click();
      assert.strictEqual(deathView.deathNodes.Failures.value.textContent, '2');
      minus.click();
      minus.click();
      minus.click();
      assert.strictEqual(deathView.deathNodes.Failures.value.textContent, '0', 'счётчик ушёл в минус');
      // Счётчик должен доезжать до сервера, а не жить в кнопках.
      assert(savedSheets.length > 0, 'правка счётчика никуда не отправлена');
      assert.strictEqual(savedSheets[savedSheets.length - 1].deathSavesFailures, 0,
        'в отправленном листе счётчик не тот');
    });

    check('три неудачи значат смерть, три успеха — стабилизацию', () => {
      deathView.setSheet({ ...aliveSheet, hp: 0, deathSavesFailures: 3 });
      assert(deathView.deathNode.classList.contains('is-dead'), 'три неудачи не значат смерть');
      assert.strictEqual(deathView.deathState.textContent, 'Мёртв');
      deathView.setSheet({ ...aliveSheet, hp: 0, deathSavesSuccesses: 3 });
      assert(deathView.deathNode.classList.contains('is-stable'), 'три успеха не значат стабилизацию');
      assert.strictEqual(deathView.deathState.textContent, 'Стабилизирован');
    });

    check('правка соседнего поля не стирает счётчики', () => {
      // Счётчики не сидят в полях ввода, а collect() собирает лист только из
      // них. Без переноса любая правка обнуляла бы весь бой.
      deathView.setSheet({ ...aliveSheet, hp: 0, deathSavesSuccesses: 2, deathSavesFailures: 1 });
      const nameInput = deathHost.querySelector('[data-field="characterName"]');
      nameInput.value = 'Другой';
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      assert.strictEqual(deathView.deathNodes.Successes.value.textContent, '2',
        'счётчик успехов стёрся при правке имени');
      assert.strictEqual(deathView.deathNodes.Failures.value.textContent, '1',
        'счётчик неудач стёрся при правке имени');
    });

    check('лечение прячет блок, но не трогает счётчики молча', () => {
      deathView.setSheet({ ...aliveSheet, hp: 1, deathSavesSuccesses: 1 });
      assert(deathView.deathNode.hidden, 'блок виден у ожившего героя');
      deathView.setSheet({ ...aliveSheet, hp: 5, deathSavesSuccesses: 1 });
      assert.strictEqual(deathView.sheet.deathSavesSuccesses, 1,
        'лечение обнулило счётчик само: человек должен решить это кнопкой');
      deathView.deathResetButton.click();
      assert.strictEqual(deathSaves[deathSaves.length - 1], 'reset', 'сброс счётчиков не отправлен');
    });

    check('из чужого листа спасбросок не бросить', () => {
      const frozen = new window.SheetView(document.createElement('div'), {
        onDeathSave: () => deathSaves.push('чужой')
      });
      sandbox.appendChild(frozen.root);
      frozen.setSheet({ ...aliveSheet, hp: 0 });
      frozen.setReadOnly(true);
      assert(frozen.deathRollButton.hidden, 'у чужого листа мастера видна кнопка спасброска');
      frozen.deathRollButton.click();
      assert(!deathSaves.includes('чужой'), 'из чужого листа бросили спасбросок');
    });

    /* -------------------------------------------------- ячейки заклинаний */

    const slotSheets = [];
    const slotHost = document.createElement('div');
    sandbox.appendChild(slotHost);
    const slotView = new window.SheetView(slotHost, {
      onChange: (sheet) => slotSheets.push(sheet)
    });
    slotView.setSheet({ ...SAMPLE_SHEET, charClass: 'жрец', level: 5 });

    check('ячейки считаются по классу, а у незнакомого класса блока нет', () => {
      assert(!slotView.slotNode.hidden, 'у жреца пятого уровня ячейки не показаны');
      // Жрец пятого уровня: четыре ячейки первой ступени, три второй и три
      // третьей, а четвёртой и дальше у него ещё нет.
      assert.strictEqual(slotView.slotRows[0].max.value, '4', `в первой ступени: ${slotView.slotRows[0].max.value}`);
      assert.strictEqual(slotView.slotRows[1].max.value, '3');
      assert.strictEqual(slotView.slotRows[3].max.value, '', 'у пятого уровня нет ячеек четвёртой ступени');
      assert.strictEqual(slotView.slotRows[0].used.textContent, '0');

      const fighterHost = document.createElement('div');
      sandbox.appendChild(fighterHost);
      const fighterView = new window.SheetView(fighterHost, {});
      fighterView.setSheet({ ...SAMPLE_SHEET, charClass: 'воин', level: 12 });
      // У воина девять пустых рядов выглядели бы как девять долгов.
      assert(fighterView.slotNode.hidden, 'у воина показаны ячейки');
    });

    check('ячейки тратятся и возвращаются, не выходя за пределы', () => {
      const first = slotView.slotRows[0];
      first.plus.click();
      first.plus.click();
      assert.strictEqual(first.used.textContent, '2', `занято: ${first.used.textContent}`);
      first.minus.click();
      assert.strictEqual(first.used.textContent, '1');
      // Больше четырёх жрец пятого уровня не потратит, даже если Very Much click.
      for (let i = 0; i < 8; i += 1) first.plus.click();
      assert.strictEqual(first.used.textContent, '4', `занято больше, чем есть: ${first.used.textContent}`);
      assert(first.plus.disabled, 'кнопка траты не гаснет на пределе');
      assert.strictEqual(slotSheets[slotSheets.length - 1].spellSlotsUsed[0], 4,
        'в отправленном листе счётчик не тот');
      for (let i = 0; i < 6; i += 1) first.minus.click();
      assert.strictEqual(first.used.textContent, '0', 'счётчик ушёл в минус');
    });

    check('своё число ячеек вписывается руками', () => {
      const ninth = slotView.slotRows[8];
      // У жреца пятого уровня девятой ступени нет: поле остаётся пустым, и
      // приложение не придумывает число за игрока.
      assert.strictEqual(ninth.max.value, '', `у девятой ступени: ${ninth.max.value}`);
      ninth.max.value = '1';
      ninth.max.dispatchEvent(new Event('change', { bubbles: true }));
      assert.strictEqual(slotSheets[slotSheets.length - 1].spellSlotsMax[8], 1,
        'своё число не ушло в лист');
      assert.strictEqual(ninth.plus.disabled, false, 'ячейку нельзя тратить при нуле занятых');
    });

    check('длинный отдых восстанавливает все ячейки разом', () => {
      slotView.slotRows[1].plus.click();
      slotView.slotRows[2].plus.click();
      slotView.slotRestore.click();
      const after = slotSheets[slotSheets.length - 1];
      assert(after.spellSlotsUsed.every((value) => value === 0), `после отдыха: ${after.spellSlotsUsed.join(',')}`);
      assert(slotView.slotRestore.disabled, 'кнопка отдыха не гаснет, когда тратить нечего');
    });

    check('правка соседнего поля не стирает ячейки', () => {
      slotView.slotRows[0].plus.click();
      const before = slotView.slotRows[0].used.textContent;
      const nameInput = slotHost.querySelector('[data-field="characterName"]');
      nameInput.value = 'Переименованный';
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      // Ячейки живут на кнопках, а collect() собирает лист только из полей
      // ввода: без переноса правка имени обнуляла бы весь день.
      assert.strictEqual(slotView.slotRows[0].used.textContent, before,
        'правка имени стёрла ячейки');
    });

    check('из чужого листа ячейками не управляют', () => {
      const frozenHost = document.createElement('div');
      sandbox.appendChild(frozenHost);
      const frozenSlots = new window.SheetView(frozenHost, {});
      frozenSlots.setSheet({ ...SAMPLE_SHEET, charClass: 'жрец', level: 5 });
      frozenSlots.setReadOnly(true);
      const node = frozenSlots.slotRows[0];
      assert(node.max.disabled || node.plus.disabled, 'у чужого листа ячейки можно тратить');
      assert(frozenSlots.slotRestore.disabled, 'у чужого листа можно восстановить ячейки');
    });

    /* ------------------------------------------------------------- отдых */

    const restSheets = [];
    const restHost = document.createElement('div');
    sandbox.appendChild(restHost);
    const restView = new window.SheetView(restHost, {
      onChange: (sheet) => restSheets.push(sheet)
    });
    const restSheet = {
      ...SAMPLE_SHEET,
      charClass: 'воин',
      level: 5,
      hitDice: '1d10',
      hp: 20,
      maxHp: 44,
      tempHp: 5,
      deathSavesSuccesses: 1,
      deathSavesFailures: 2,
      hitDiceSpent: 2,
      spellSlotsMax: [4, 3, 3, 0, 0, 0, 0, 0, 0],
      spellSlotsUsed: [2, 1, 1, 0, 0, 0, 0, 0, 0]
    };
    restView.setSheet(restSheet);

    check('короткий отдых тратит кость и лечит', () => {
      restView.hitDieSpend.click();
      const after = restSheets[restSheets.length - 1];
      assert(after.hp > 20, `короткий отдых не вылечил: ${after.hp}`);
      assert.strictEqual(after.hitDiceSpent, 3, `потрачено костей: ${after.hitDiceSpent}`);
      assert(restView.hitDiePool.textContent.includes('2 из 5'),
        `счётчик костей: ${restView.hitDiePool.textContent}`);
    });

    check('долгий отдых возвращает хиты, ячейки и половину костей', () => {
      restView.takeLongRest();
      const after = restSheets[restSheets.length - 1];
      assert.strictEqual(after.hp, 44, `хиты после отдыха: ${after.hp}`);
      assert.strictEqual(after.tempHp, 0, 'временные хиты не сброшены');
      assert.strictEqual(after.deathSavesSuccesses, 0, 'успехи смерти не сброшены');
      assert.strictEqual(after.deathSavesFailures, 0, 'неудачи смерти не сброшены');
      assert(after.spellSlotsUsed.every((value) => value === 0), 'ячейки не восстановлены');
      // Потрачено три, отдых возвращает половину от пяти с округлением вниз:
      // одна кость остаётся потраченной.
      assert.strictEqual(after.hitDiceSpent, 1, `костей после отдыха: ${after.hitDiceSpent}`);
      assert(restView.hitDiePool.textContent.includes('4 из 5'),
        `счётчик после отдыха: ${restView.hitDiePool.textContent}`);
    });

    check('лист персонажа заполняется всеми полями 5e', () => {
      const value = (field) => {
        const node = sheetHost.querySelector(`[data-field="${field}"]`);
        assert(node, `на листе нет поля «${field}»`);
        return node.value;
      };
      assert(value('characterName') === 'Тордин', 'имя персонажа');
      assert(value('playerName') === 'Артём', 'имя игрока');
      assert(value('charClass') === 'Воин', 'класс');
      assert(value('race') === 'Дварф', 'раса');
      assert(value('background') === 'Солдат', 'предыстория');
      assert(value('alignment') === 'Законно-добрый', 'мировоззрение');
      assert(value('level') === '5', 'уровень');
      assert(value('experience') === '6500', 'опыт');
      assert(value('hp') === '44', 'хиты');
      assert(value('maxHp') === '44', 'максимальные хиты');
      assert(value('tempHp') === '0', 'временные хиты');
      assert(value('hitDice') === '1d10', 'кость хитов');
      assert(value('armorClass') === '18', 'класс брони');
      assert(value('speed') === '25', 'скорость');
      const area = (name) => {
        const node = sheetHost.querySelector(`textarea[data-field="${name}"]`);
        assert(node, `на листе нет текстового блока «${name}»`);
        return node.value;
      };
      assert(area('attacks') === 'Боевой топор +7', 'атаки');
      assert(area('equipment') === 'Кольчуга', 'снаряжение');
      assert(area('features') === 'Второе дыхание', 'особенности');
      assert(area('notes') === 'Ищет брата', 'заметки');
    });

    check('на листе есть 6 характеристик, 6 спасбросков и 18 навыков', () => {
      assert(sheetHost.querySelectorAll('.abil').length === 6, 'характеристик');
      assert(sheetHost.querySelectorAll('[data-save]').length === 6, 'спасбросков');
      assert(sheetHost.querySelectorAll('[data-skill]').length === 18, 'навыков');
    });

    check('класс выбирают списком, а подкласс вписывают руками', () => {
      const cls = sheetHost.querySelector('[data-field="charClass"]');
      assert(cls && cls.tagName === 'SELECT', 'класс не выпадающий список');
      const labels = [...cls.options].map((option) => option.value);
      for (const item of window.DnD5e.CLASSES) {
        assert(labels.includes(item.label), `в списке нет класса «${item.label}»`);
      }
      const sub = sheetHost.querySelector('[data-field="subclass"]');
      assert(sub && sub.tagName === 'INPUT', 'подкласс не свободное поле ввода');
    });

    check('выбор класса подставляет его кость хитов', () => {
      const cls = sheetHost.querySelector('[data-field="charClass"]');
      const dice = sheetHost.querySelector('[data-field="hitDice"]');
      const pick = (label) => {
        cls.value = label;
        cls.dispatchEvent(new Event('input', { bubbles: true }));
      };
      pick('Волшебник');
      assert(dice.value === '1d6', `кость волшебника: ${dice.value}`);
      pick('Варвар');
      assert(dice.value === '1d12', `кость варвара: ${dice.value}`);
      // Возвращаем воина: следующие проверки ждут его лист.
      pick('Воин');
      assert(dice.value === '1d10', `кость воина: ${dice.value}`);
    });

    check('кость хитов бросается прямо в листе и результат читается', () => {
      const die = sheetHost.querySelector('.hit-die__die');
      assert(die.textContent === 'd10', `на листе кость «${die.textContent}», а не d10`);
      const roll = sheetHost.querySelector('.hit-die__roll');
      assert(roll && !roll.disabled, 'бросок кости хитов недоступен');
      roll.click();
      const out = sheetHost.querySelector('.hit-die__out');
      assert(out && !out.hidden, 'результат броска кости хитов не показан');
      const total = Number(sheetHost.querySelector('.hit-die__value').textContent);
      const detail = sheetHost.querySelector('.hit-die__detail').textContent;
      const match = detail.match(/d10:\s*(\d+)\s*([+-]\d+)\s*Тел/);
      assert(match, `результат не разбирается: ${detail}`);
      assert.strictEqual(total, Number(match[1]) + Number(match[2]),
        `итог не сходится с разбором «${detail}»: ${total}`);
      assert(total >= 1 + Number(match[2]) && total <= 10 + Number(match[2]),
        `итог вне диапазона кости: ${total}`);
    });

    check('мультикласс: строки классов, общий уровень и несколько костей хитов', () => {
      sheetView.setSheet({
        ...SAMPLE_SHEET,
        charClass: 'Воин',
        level: 5,
        classes: [{ name: 'Воин', level: 5 }, { name: 'Волшебник', level: 3 }]
      });
      const rows = sheetHost.querySelectorAll('.class-row');
      assert.strictEqual(rows.length, 2, `строк классов: ${rows.length}`);
      assert(sheetHost.querySelector('.class-editor__sum').textContent.includes('8'),
        'общий уровень мультикласса не показан');
      assert(sheetHost.querySelector('[data-derived="profBonus"]').textContent === '+3',
        'бонус мастерства не посчитан от общего уровня 8');
      const pick = sheetHost.querySelector('.hit-die__pick');
      assert(pick && !pick.hidden, 'нет выбора кости для мультикласса');
      const options = [...pick.options].map((option) => option.value);
      assert(options.includes('d10') && options.includes('d6'), `кости: ${options.join(', ')}`);
      // Бросаем d6: разбор должен начинаться с неё, а не с d10.
      pick.value = 'd6';
      pick.dispatchEvent(new Event('change', { bubbles: true }));
      sheetHost.querySelector('.hit-die__roll').click();
      const detail = sheetHost.querySelector('.hit-die__detail').textContent;
      assert(detail.startsWith('d6:'), `бросок выбрал не ту кость: ${detail}`);
      // Возвращаем одноклассовый лист: дальше проверки ждут воина 5 уровня.
      sheetView.setSheet(SAMPLE_SHEET);
    });

    check('производные значения на листе считаются автоматически', () => {
      const derived = (key) => {
        const node = sheetHost.querySelector(`[data-derived="${key}"]`);
        assert(node, `нет вычисляемого поля «${key}»`);
        return node.textContent;
      };
      const rowValue = (selector) => {
        const row = sheetHost.querySelector(selector);
        assert(row, `нет строки ${selector}`);
        const value = row.parentElement.querySelector('.prof-row__value');
        assert(value, `нет значения у ${selector}`);
        return value.textContent;
      };
      assert(derived('profBonus') === '+3', `бонус мастерства: ${derived('profBonus')}`);
      assert(derived('initiative') === '+2', `инициатива: ${derived('initiative')}`);
      assert(derived('passivePerception') === '11', `пассивное восприятие: ${derived('passivePerception')}`);
      const strCard = sheetHost.querySelector('[data-ability="str"]').parentElement;
      assert(strCard.querySelector('.abil__mod').textContent === '+3', 'модификатор Силы 17 -> +3');
      assert(rowValue('[data-skill="athletics"]') === '+9', 'Атлетика с компетентностью -> +9');
      assert(rowValue('[data-skill="perception"]') === '+1', 'Внимательность без владения -> +1');
      assert(rowValue('[data-save="str"]') === '+6', 'спасбросок Силы -> +6');
      assert(rowValue('[data-save="dex"]') === '+2', 'спасбросок Ловкости без владения -> +2');
    });

    check('владельца навыка можно отметить мышью', () => {
      const perception = sheetHost.querySelector('[data-skill="perception"]');
      perception.checked = true;
      perception.dispatchEvent(new Event('change', { bubbles: true }));
      const row = perception.parentElement;
      assert(row.querySelector('.prof-row__value').textContent === '+4',
        'владение Внимательностью на 5 уровне: 1 + 3 = 4');
      perception.checked = false;
      perception.dispatchEvent(new Event('change', { bubbles: true }));
    });

    check('изменение уровня пересчитывает бонус мастерства', () => {
      const level = sheetHost.querySelector('[data-field="level"]');
      level.value = '9';
      level.dispatchEvent(new Event('input', { bubbles: true }));
      assert(sheetHost.querySelector('[data-derived="profBonus"]').textContent === '+4', 'на 9 уровне +4');
      level.value = '5';
      level.dispatchEvent(new Event('input', { bubbles: true }));
      assert(sheetHost.querySelector('[data-derived="profBonus"]').textContent === '+3', 'обратно на 5 уровне +3');
    });

    check('режим просмотра для ДМ отключает все поля', () => {
      sheetView.setReadOnly(true);
      assert(sheetHost.querySelector('[data-field="characterName"]').disabled, 'текстовое поле активно');
      assert(sheetHost.querySelector('[data-ability="str"]').disabled, 'характеристика активна');
      assert(sheetHost.querySelector('[data-save="str"]').disabled, 'спасбросок активен');
      assert(sheetHost.querySelector('textarea[data-field="notes"]').disabled, 'заметки активны');
      sheetView.setReadOnly(false);
      assert(!sheetHost.querySelector('[data-field="characterName"]').disabled, 'поле не вернулось в редактируемое');
    });

    check('вкладка листа у ДМ отправляет к панели участников, а не дублирует список', () => {
      sheetView.setMode('pick');
      const pick = sheetHost.querySelector('.sheet__pick');
      assert(pick, 'нет подсказки выбора игрока');
      assert(!pick.hidden, 'подсказка скрыта в режиме выбора игрока');
      assert(pick.textContent.includes('Участники'),
        `подсказка не зовёт в панель участников: ${pick.textContent.slice(0, 80)}`);
      assert(sheetHost.querySelector('.sheet__grid').hidden, 'форма листа показана без выбранного игрока');
      assert(!sheetHost.querySelector('.sheet__players'), 'список игроков остался во вкладке листа');
      sheetView.setMode('sheet', { canGoBack: true });
      assert(pick.hidden, 'подсказка осталась поверх открытого листа');
      assert(!sheetHost.querySelector('.sheet__grid').hidden, 'открытый лист не показан');
    });
    check('у мастера портрет ставится в панели участников, а не во вкладке листа', () => {
      const host = document.createElement('div');
      const picked = [];
      let cleared = 0;
      const list = new window.TableUI.PlayersList(host, {
        onAvatarPick: (file) => picked.push(file),
        onAvatarClear: () => { cleared += 1; },
        resolveUrl: (url) => (url && url.startsWith('/') ? `http://стол${url}` : (url || ''))
      });
      list.render([{ playerId: 'dm', name: 'Мастер', role: 'dm', online: true, avatar: 'avatar-dm.png' }], {
        role: 'dm',
        playerId: 'dm'
      });
      // Блока портрета у игрока нет: блок только у мастера, и только когда
      // интерфейс умеет его менять.
      assert(host.querySelector('.players-self').hidden, 'блок портрета показан не у мастера');

      list.renderSelfAvatar({ avatarUrl: null, name: 'Мастер' });
      const block = host.querySelector('.players-self');
      assert(!block.hidden, 'мастеру не показан блок портрета');
      assert(block.textContent.includes('Ваш портрет'), 'нет заголовка блока');
      const preview = block.querySelector('.avatar-pick__preview');
      assert.strictEqual(preview.textContent, 'М', `буква-заглушка мастера: ${preview.textContent}`);
      assert(!byText(block, 'Убрать'), 'кнопка «Убрать» видна без аватара');

      list.renderSelfAvatar({ avatarUrl: 'http://стол/files/dm.png', name: 'Мастер' });
      // Блок пересоздаётся целиком, поэтому кружок и кнопки ищем заново.
      const blockAfter = host.querySelector('.players-self');
      const previewAfter = blockAfter.querySelector('.avatar-pick__preview');
      assert.strictEqual(previewAfter.querySelector('img').getAttribute('src'), 'http://стол/files/dm.png',
        'портрет мастера не показан');
      const clear = byText(blockAfter, 'Убрать');
      assert(clear, 'нет кнопки сброса портрета');
      clear.click();
      assert(cleared === 1, `сброс портрета мастера: ${cleared}`);

      const pick = byText(blockAfter, 'Заменить');
      assert(pick, 'нет кнопки замены портрета');
      let opened = 0;
      const input = blockAfter.querySelector('input[type=file]');
      input.click = () => { opened += 1; };
      pick.click();
      assert.strictEqual(opened, 1, `выбор файла не открылся (нажатий: ${opened})`);

      const file = new File([PNG_1PX], 'dm.png', { type: 'image/png' });
      Object.defineProperty(input, 'files', { value: [file] });
      input.dispatchEvent(new Event('change'));
      assert(picked.length === 1 && picked[0].name === 'dm.png', `выбранные файлы: ${picked.length}`);

      // Игроку блок не нужен: портрет он ставит в своём листе.
      const playerHost = document.createElement('div');
      const playerList = new window.TableUI.PlayersList(playerHost, { onAvatarPick: () => {} });
      playerList.render([], { role: 'player', playerId: 'p-1' });
      playerList.renderSelfAvatar({ avatarUrl: 'avatar.png', name: 'Игрок' });
      assert(playerHost.querySelector('.players-self').hidden, 'игроку показали блок портрета мастера');
    });
    check('в листе есть блок аватарки: круг, загрузка и сброс', () => {
      const host = document.createElement('div');
      let picked = null;
      let cleared = 0;
      const view = new window.SheetView(host, {
        onAvatarPick: (file) => { picked = file; },
        onAvatarClear: () => { cleared += 1; }
      });
      const preview = host.querySelector('.avatar-pick__preview');
      const input = host.querySelector('.avatar-pick__file');
      assert(preview, 'нет круга с портретом');
      assert(input && input.type === 'file', 'нет выбора файла');
      assert(input.accept.includes('image/png'), 'фильтр файлов не задан');
      // Без аватара показываем букву имени персонажа, а не пустой кружок.
      view.setSheet({ ...window.DnD5e.createEmptySheet('Артём'), characterName: 'Тордин' });
      view.setAvatar(null, 'Тордин');
      assert.strictEqual(preview.textContent, 'Т', `буква-заглушка: ${preview.textContent}`);
      const clear = host.querySelector('.avatar-pick__side .btn');
      assert(clear.hidden, 'кнопка «Убрать» видна без аватара');

      view.setAvatar('http://стол/files/arthur.png', 'Тордин');
      assert.strictEqual(preview.querySelector('img').getAttribute('src'), 'http://стол/files/arthur.png',
        'картинка не показана');
      assert(!clear.hidden, 'кнопка «Убрать» спрятана при наличии аватара');
      clear.click();
      assert(cleared === 1, `сброс аватара: ${cleared}`);

      const file = new File([PNG_1PX], 'portrait.png', { type: 'image/png' });
      Object.defineProperty(input, 'files', { value: [file] });
      input.dispatchEvent(new Event('change'));
      assert(picked && picked.name === 'portrait.png', `выбранный файл: ${picked && picked.name}`);
    });
    check('клик по кнопке «Аватар» открывает выбор файла', () => {
      // Раньше здесь стояла надпись рядом со спрятанным полем: <label> без `for`
      // и без вложенного поля на клик не реагирует, и кнопка была мёртвой.
      const host = document.createElement('div');
      const view = new window.SheetView(host, {});
      const button = host.querySelector('.avatar-pick__label');
      assert(button, 'нет кнопки выбора аватара');
      assert.strictEqual(button.tagName, 'BUTTON', `надпись вместо кнопки: ${button.tagName}`);
      assert.strictEqual(button.type, 'button', 'кнопка отправит форму вместо выбора файла');

      let opened = 0;
      view.avatarInput.click = () => { opened += 1; };
      button.click();
      assert.strictEqual(opened, 1, `выбор файла не открылся (нажатий: ${opened})`);

      // И у отключённой кнопки нажатия не происходит вовсе.
      view.setAvatarEditable(false);
      button.click();
      assert.strictEqual(opened, 1, 'отключённая кнопка всё равно открыла выбор файла');
    });
    check('аватар в листе мастер не правит, но видит', () => {
      const host = document.createElement('div');
      const view = new window.SheetView(host, {});
      view.setAvatarEditable(false);
      assert(view.avatarInput.disabled, 'мастер может выбрать файл');
      assert(view.avatarLabel.disabled, 'мастер может нажать кнопку аватара');
      assert(view.avatarClear.disabled, 'мастер может сбросить чужой аватар');
      view.setAvatarEditable(true);
      assert(!view.avatarInput.disabled, 'игрок не может выбрать файл');
      assert(!view.avatarLabel.disabled, 'игрок не может нажать кнопку аватара');
    });
    check('в листе есть быстрые броски атак с бонусом и уроном', () => {
      const host = document.createElement('div');
      const rolls = [];
      const view = new window.SheetView(host, {
        onRollCheck: (formula, label) => rolls.push({ formula, label })
      });
      view.setSheet({
        ...window.DnD5e.createEmptySheet('Артём'),
        characterName: 'Тордин',
        attackList: [{ name: 'Длинный меч', bonus: 5, damage: '1d8+3' }]
      });
      const row = host.querySelector('.attack-row');
      assert(row, 'в листе нет строки атаки');
      assert.strictEqual(row.querySelector('.attack-row__name').value, 'Длинный меч');
      assert.strictEqual(row.querySelector('.attack-row__bonus').value, '5');
      row.querySelectorAll('.attack-row__roll')[0].click();
      assert.strictEqual(rolls[0].formula, 'd20+5', `атака: ${rolls[0].formula}`);
      row.querySelectorAll('.attack-row__roll')[1].click();
      assert.strictEqual(rolls[1].formula, '1d8+3', `урон: ${rolls[1].formula}`);

      host.querySelector('.attack-list__add').click();
      const rows = [...host.querySelectorAll('.attack-row')];
      assert.strictEqual(rows.length, 2, 'вторая атака не добавилась');
      const second = rows[1];
      second.querySelector('.attack-row__name').value = 'Лук';
      second.querySelector('.attack-row__name').dispatchEvent(new Event('input'));
      const sheet = view.collect();
      assert.deepStrictEqual(sheet.attackList[1], { name: 'Лук', bonus: 0, damage: '' });
    });

    check('лист открывается из панели участников и оттуда же закрывается', () => {
      let requested = null;
      // Отдельные узлы: список участников и лист строятся в одном контейнере
      // только в настоящем окне, и build листа чистит узел целиком.
      const listHost = document.createElement('div');
      const sheetHostLocal = document.createElement('div');
      const list = new window.TableUI.PlayersList(listHost, {
        onOpenSheet: (playerId) => { requested = playerId; }
      });
      const view = new window.SheetView(sheetHostLocal, { onBack: () => view.setMode('pick') });
      view.setMode('pick');
      list.render([{ playerId: 'p-9', name: 'Борис', role: 'player', online: true, hasSheet: true }], {
        role: 'dm',
        playerId: 'dm'
      });
      const row = [...listHost.querySelectorAll('.player-row')]
        .find((node) => node.textContent.includes('Борис'));
      assert(row, 'игрока нет в панели участников');
      const open = [...row.querySelectorAll('button')].find((node) => node.textContent === 'Открыть лист');
      assert(open, 'у игрока в панели участников нет кнопки «Открыть лист»');
      open.click();
      assert(requested === 'p-9', `открыт лист игрока: ${requested}`);

      view.setMode('sheet', { canGoBack: true });
      assert(!sheetHostLocal.querySelector('.sheet__grid').hidden, 'форма листа не показана');
      const back = [...sheetHostLocal.querySelectorAll('.sheet__head-tools button')]
        .find((node) => node.textContent.includes('К списку игроков'));
      assert(back && !back.hidden, 'нет кнопки возврата к списку');
    });
    check('у игрока нет подсказки выбора игрока и кнопки возврата, но есть вынос в отдельное окно', () => {
      const host = document.createElement('div');
      const view = new window.SheetView(host, {});
      view.setMode('sheet');
      assert(host.querySelector('.sheet__pick').hidden, 'игроку показана подсказка выбора игрока');
      const back = [...host.querySelectorAll('.sheet__head-tools button')]
        .find((node) => node.textContent.includes('К списку игроков'));
      assert(back && back.hidden, 'игроку показана кнопка «К списку игроков»');
      assert(!host.querySelector('.sheet__grid').hidden, 'форма листа не показана игроку');
      const detach = [...host.querySelectorAll('.sheet__head-tools button')]
        .find((node) => node.textContent.includes('Отдельным окном'));
      assert(detach && !detach.hidden, 'нет кнопки выноса листа в отдельное окно');
    });

    /* ------------------------------------------------ карта и фишки */

    const mapHost = document.createElement('div');
    sandbox.appendChild(mapHost);
    /**
     * Событие указателя в середине подложки карты.
     *
     * Настоящий PointerEvent без координат бесполезен: туман считается от
     * позиции указателя, а ноль по умолчанию открыл бы угол карты.
     */
    class MapViewEvent {
      /**
       * @param {DOMRect} rect размеры подложки карты.
       * @param {number} [clientX] точка нажатия; по умолчанию — середина.
       * @param {number} [clientY]
       */
      constructor(rect, clientX, clientY) {
        this.rect = rect;
        this.x = clientX === undefined ? rect.left + rect.width / 2 : clientX;
        this.y = clientY === undefined ? rect.top + rect.height / 2 : clientY;
      }

      payload() {
        return {
          clientX: this.x,
          clientY: this.y,
          buttons: 1,
          bubbles: true,
          cancelable: true
        };
      }
    }

    const mapView = new window.TableUI.MapView(mapHost, {});

    mapView.render(
      { maps: { world: null, battle: null }, activeMap: null, tokens: [], players: [] },
      { role: 'dm', playerId: 'dm' }
    );
    check('три вкладки карт присутствуют, включая холст ДМа', () => {
      // Вкладка «Свет» не карта и не считается: она показывает настройки той
      // карты, что уже открыта, поэтому отбираем по наличию точки-метки.
      const labels = [...mapHost.querySelectorAll('.map-tab:has(.map-tab__dot) .map-tab__label')]
        .map((node) => node.textContent);
      assert(labels.length === 3, `должно быть три вкладки карт, а есть ${labels.length}`);
      assert(labels[0].includes('Общая'), `первая вкладка: ${labels[0]}`);
      assert(labels[1].includes('локации'), `вторая вкладка: ${labels[1]}`);
      assert(labels[2].includes('Рисунок'), `третья вкладка: ${labels[2]}`);
    });
    check('без загруженной карты показывается заглушка', () => {
      const empty = mapHost.querySelector('.map-empty__text');
      assert(empty.textContent.includes('Карта ещё не загружена ДМ'), `текст заглушки: ${empty.textContent}`);
      assert(!mapHost.querySelector('.map-empty').hidden, 'заглушка скрыта');
      assert(mapHost.querySelector('.map-surface').hidden, 'поверхность карты видна');
    });
    check('орнамент карты висит и реагирует на курсор', () => {
      const stage = mapHost.querySelector('.map-stage');
      const decor = mapHost.querySelector('.map-decor');
      assert(stage && decor, 'нет подвесного орнамента у карты');
      const rect = stage.getBoundingClientRect();
      assert(rect.width > 0, 'сцена карты без размеров');
      stage.dispatchEvent(new PointerEvent('pointermove', {
        clientX: rect.left + rect.width * 0.8,
        clientY: rect.top + 20,
        bubbles: true
      }));
      const x = Number(decor.style.getPropertyValue('--pointer-x'));
      assert(Math.abs(x - 0.8) < 0.05, `курсор не учтён: ${x}`);
      const strand = mapHost.querySelector('.map-decor__strand');
      const transform = getComputedStyle(strand).transform;
      assert(transform && transform !== 'none', 'лоза не отзывается на курсор');
      stage.dispatchEvent(new PointerEvent('pointerleave'));
      assert(decor.style.getPropertyValue('--pointer-x') === '0.5', 'курсор не отпущен');
    });

    const TOKENS = [
      { id: 't1', name: 'Гоблин', mapType: 'world', x: 0.25, y: 0.75, imageUrl: null, assignedPlayerId: null, color: '#c96f4a' },
      { id: 't2', name: 'Мира', mapType: 'world', x: 0.5, y: 0.5, imageUrl: null, assignedPlayerId: 'p-1', color: '#4a8fc9' },
      { id: 't3', name: 'Дракон', mapType: 'battle', x: 0.1, y: 0.1, imageUrl: null, assignedPlayerId: null, color: '#6fb45f' }
    ];
    const PLAYERS = [
      { playerId: 'dm', name: 'Мастер', role: 'dm', online: true, hasSheet: false, tokenId: null, avatar: 'avatar-dm.png' },
      { playerId: 'p-1', name: 'Артём', role: 'player', online: true, hasSheet: true, tokenId: 't2', avatar: null }
    ];
    const MAP_STATE = {
      maps: {
        world: { items: [{ id: 'm-world', url: PNG_1PX, name: 'world.png' }], activeId: 'm-world' },
        battle: { items: [{ id: 'm-battle', url: PNG_1PX, name: 'battle.png' }], activeId: 'm-battle' },
        sketch: { items: [], activeId: null }
      },
      activeMap: 'world',
      activeMapId: 'm-world',
      grid: { enabled: false, cell: DnD.GRID.defaultCell },
      tokens: TOKENS,
      players: PLAYERS
    };

    mapView.render(MAP_STATE, { role: 'player', playerId: 'p-1' });
    await wait(400);

    check('скрытая от игроков фишка мастеру видна, игроку нет', () => {
      const withHidden = {
        ...MAP_STATE,
        tokens: MAP_STATE.tokens.map((token) => ({ ...token, hidden: token.id !== 't2' }))
      };
      mapView.render(withHidden, { role: 'dm', playerId: 'dm' });
      const dmTokens = [...mapHost.querySelectorAll('.token')];
      assert(dmTokens.length === 2, `у мастера фишек на карте: ${dmTokens.length}`);
      const hiddenNode = dmTokens.find((node) => node.dataset.tokenId === 't1');
      assert(hiddenNode.classList.contains('token--hidden'), 'скрытая фишка не помечена у мастера');

      mapView.render(withHidden, { role: 'player', playerId: 'p-1' });
      const playerTokens = [...mapHost.querySelectorAll('.token')];
      assert(playerTokens.length === 1, `игрок видит фишек: ${playerTokens.length}`);
      assert(playerTokens[0].dataset.tokenId === 't2', 'игрок видит не ту фишку');
      mapView.render(MAP_STATE, { role: 'player', playerId: 'p-1' });
    });

    check('карта отображается, фишки рисуются поверх неё', () => {
      assert(!mapHost.querySelector('.map-empty').getAttribute('hidden'), 'заглушка должна быть скрыта');
      assert(!mapHost.querySelector('.map-surface').hidden, 'поверхность карты скрыта');
      assert(mapHost.querySelector('.map-image').src.startsWith('data:image/png'), 'картинка не подставлена');
      assert(mapHost.querySelectorAll('.token').length === 2, 'на карте мира должно быть 2 фишки');
    });

    check('позиции фишек хранятся в долях от карты (0..1)', () => {
      const first = mapHost.querySelector('[data-token-id="t1"]');
      assert(first.style.left === '25%', `left: ${first.style.left}`);
      assert(first.style.top === '75%', `top: ${first.style.top}`);
    });

    check('пинг рисует метку на карте и убирается', () => {
      assert(!mapView.pingButton.disabled, 'пинг выключен на карте, которую видят игроки');
      mapView.showPing({
        mapType: 'world',
        mapId: 'm-world',
        x: 0.4,
        y: 0.6,
        name: 'Мастер',
        role: 'dm'
      });
      const ping = mapHost.querySelector('.map-ping');
      assert(ping, 'метка пинга не появилась');
      assert(ping.style.left === '40%', `left пинга: ${ping.style.left}`);
      assert(ping.style.top === '60%', `top пинга: ${ping.style.top}`);
      assert(ping.textContent.includes('Мастер'), 'в метке нет имени');
      mapView.clearPings();
      assert(!mapHost.querySelector('.map-ping'), 'пинг не убрался');
    });

    check('состояние фишки показывает длительность в раундах', () => {
      const withConditions = {
        ...MAP_STATE,
        tokens: [
          { ...TOKENS[0], conditions: ['restrained'], conditionDurations: { restrained: 3 } },
          TOKENS[1]
        ]
      };
      mapView.render(withConditions, { role: 'dm', playerId: 'dm' });
      const token = mapHost.querySelector('[data-token-id="t1"]');
      const badge = token.querySelector('.token__condition');
      assert(badge, 'у состояния нет подписи');
      assert(badge.textContent.includes('3'), `подпись состояния: ${badge.textContent}`);
      assert(token.title.includes('3'), `подсказка состояния: ${token.title}`);
      mapView.render(MAP_STATE, { role: 'player', playerId: 'p-1' });
    });

    check('на карте локации свои фишки, на общей — свои', () => {
      const battle = mapView.maps.battle;
      assert(battle, 'карта битвы не загружена в представление');
      assert(TOKENS.filter((token) => token.mapType === 'battle').length === 1, 'фильтрация по типу карты');
    });

    check('игрок может двигать только свою фишку', () => {
      assert(mapHost.querySelector('[data-token-id="t2"]').classList.contains('token--movable'), 'своя фишка не двигается');
      assert(mapHost.querySelector('[data-token-id="t2"]').classList.contains('token--mine'), 'своя фишка не помечена');
      assert(!mapHost.querySelector('[data-token-id="t1"]').classList.contains('token--movable'), 'чужую фишку можно двигать');
    });

    mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    check('ДМ может двигать любую фишку и управляет картами', () => {
      assert(mapHost.querySelectorAll('.token--movable').length === 2, 'ДМ должен двигать все фишки на карте');
      const buttons = [...mapHost.querySelectorAll('.map-toolbar button, .map-toolbar label')].map((n) => n.textContent);
      assert(buttons.some((text) => text.includes('Загрузить карту') || text.includes('Загрузить ещё карту')),
        `нет кнопки загрузки карты: ${buttons.join(' | ')}`);
      assert(buttons.some((text) => text.includes('Удалить карту')), 'нет кнопки удаления карты');
    });
    check('у игрока нет панели управления картами', () => {
      mapView.render(MAP_STATE, { role: 'player', playerId: 'p-1' });
      assert(mapHost.querySelector('.map-toolbar').hidden, 'панель управления картами видна игроку');
    });
    check('в тренировочном столе карта для проверки доступна игроку', () => {
      mapView.render(MAP_STATE, { role: 'player', playerId: 'p-1', training: true });
      const toolbar = mapHost.querySelector('.map-toolbar');
      assert(!toolbar.hidden, 'панель карты скрыта в тренировочном столе');
      const texts = [...toolbar.querySelectorAll('button, label')].map((node) => node.textContent);
      assert(texts.some((text) => text.includes('Загрузить')), `нет кнопки загрузки карты: ${texts.join(' | ')}`);
      assert(texts.some((text) => text.includes('Сетка')), `нет кнопки сетки: ${texts.join(' | ')}`);
      assert(!texts.some((text) => text.includes('Нарисовать') || text.includes('Рисовать')),
        'рисование карты должно остаться за ДМом');
      assert(!texts.some((text) => text.includes('Показать игрокам')), 'показывать карту игрокам в тренировке некому');
      assert(mapHost.querySelector('.map-toolbar__note').textContent.includes('Проверка без сети'),
        'нет пометки, что панель — для проверки');
    });
    check('в тренировочном столе игрок сам выбирает вкладку карты', () => {
      mapView.render(MAP_STATE, { role: 'player', playerId: 'p-1', training: true });
      mapView.onTabClick('battle');
      assert(mapView.viewedMap === 'battle', `открыта вкладка: ${mapView.viewedMap}`);
      const badge = mapHost.querySelector('.map-badge');
      assert(badge.hidden, 'в тренировке нет ДМа — пометки «ДМ показывает другую карту» быть не должно');
      assert(mapHost.querySelectorAll('.token').length === 1, 'должны показываться фишки карты битвы');
      mapView.onTabClick('world');
    });
    check('игрок видит пометку, когда сам смотрит не ту карту, что показывает ДМ', () => {
      mapView.render(MAP_STATE, { role: 'player', playerId: 'p-1' });
      mapView.onTabClick('battle');
      const badge = mapHost.querySelector('.map-badge');
      assert(!badge.hidden, 'нет пометки о другой карте');
      assert(badge.textContent.includes('Общая карта'), `текст пометки: ${badge.textContent}`);
      assert(mapHost.querySelectorAll('.token').length === 1, 'должны показываться фишки карты битвы');
    });
    check('игрок автоматически возвращается к карте, которую показывает ДМ', () => {
      mapView.render({ ...MAP_STATE, activeMap: 'battle', activeMapId: 'm-battle' }, { role: 'player', playerId: 'p-1' });
      assert(mapHost.querySelector('.map-badge').hidden, 'пометка осталась, хотя игрок следует за ДМ');
      assert(mapHost.querySelectorAll('.token').length === 1, 'должны показываться фишки карты битвы');
    });
    mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    // Возвращаем ДМ на общую карту: предыдущие проверки увели его на карту локации.
    mapView.onTabClick('world');

    /* ------------------------------------------------------ туман войны */

    const fogEvents = [];
    const fogView = new window.TableUI.MapView(document.createElement('div'), {
      onOpenMapFog: (type, mapId, x, y, radius) => fogEvents.push({ kind: 'open', type, mapId, x, y, radius }),
      onSetMapFog: (type, mapId, open) => fogEvents.push({ kind: 'whole', type, mapId, open })
    });
    sandbox.appendChild(fogView.root);
    const fogMap = { ...MAP_STATE.maps.world.items[0], fogMask: window.DnD5e.newFogMask() };
    const fogState = { ...MAP_STATE, maps: { ...MAP_STATE.maps, world: { items: [fogMap], activeId: fogMap.id } } };

    check('у мастера есть панель тумана, а у игрока нет', () => {
      fogView.render(fogState, { role: 'dm', playerId: 'dm' });
      assert(fogView.toolbar.querySelector('.fog-bar'), 'у мастера нет панели тумана');
      assert(fogView.toolbar.textContent.includes('Туман'), 'нет переключателя режима');
      fogView.render(fogState, { role: 'player', playerId: 'p-1' });
      assert(!fogView.toolbar.querySelector('.fog-bar'), 'игрок видит панель тумана');
      fogView.render(fogState, { role: 'dm', playerId: 'dm' });
    });

    check('карта без открытых участков тумана не рисует', () => {
      assert(fogView.fogCanvas.hidden, 'на карте без тумана всё равно рисуется слой');
      assert(!window.DnD5e.fogHasOpenArea(fogMap.fogMask), 'у новой карты что-то открыто');
    });

    check('кисть открывает участок и уходит на сервер', () => {
      fogView.setFogMode(true);
      assert(fogView.surface.classList.contains('is-fogging'), 'режим кисти не включился');
      const rect = fogView.surface.getBoundingClientRect();
      assert(rect.width > 0, 'поверхность карты нулевой ширины, точку не посчитать');
      const opened = new MapViewEvent(rect);
      fogView.openFogAt(opened);
      assert(!fogView.fogCanvas.hidden, 'слой тумана не показался после кисти');
      assert(window.DnD5e.fogHasOpenArea(fogMap.fogMask), 'кисть ничего не открыла');
      const sent = fogEvents[fogEvents.length - 1];
      assert.strictEqual(sent.kind, 'open');
      assert.strictEqual(sent.mapId, fogMap.id);
      assert(sent.radius > 0 && sent.radius <= 0.5, `радиус: ${sent.radius}`);
      fogView.setFogMode(false);
    });

    check('у игрока карта с открытыми участками затенена, и он ими не управляет', () => {
      const withFog = { ...fogMap, fogMask: window.DnD5e.openFogAt(fogMap.fogMask, 0.5, 0.5, 0.15) };
      const state = { ...MAP_STATE, maps: { ...MAP_STATE.maps, world: { items: [withFog], activeId: withFog.id } } };
      fogView.render(state, { role: 'player', playerId: 'p-1' });
      assert(!fogView.fogCanvas.hidden, 'игрок не видит туман на карте');
      // Игрок в режиме кисти не входит даже принудительно: проверка стоит в
      // обработчике, а не только в панели.
      const before = fogEvents.length;
      fogView.setFogMode(true);
      const rect = fogView.surface.getBoundingClientRect();
      fogView.surface.dispatchEvent(new PointerEvent('pointerdown', new MapViewEvent(rect).payload()));
      assert.strictEqual(fogEvents.length, before, 'игрок открыл туман');
      fogView.setFogMode(false);
      fogView.render(fogState, { role: 'dm', playerId: 'dm' });
    });

    check('кнопки открывают и закрывают карту целиком', () => {
      const box = fogView.toolbar.querySelector('.fog-bar');
      const buttons = [...box.querySelectorAll('button')];
      const openAll = buttons.find((button) => button.textContent === 'Открыть всё');
      const coverAll = buttons.find((button) => button.textContent === 'Закрыть всё');
      openAll.click();
      assert.strictEqual(fogEvents[fogEvents.length - 1].kind, 'whole');
      assert.strictEqual(fogEvents[fogEvents.length - 1].open, true, 'не отправлено «открыть всё»');
      coverAll.click();
      assert.strictEqual(fogEvents[fogEvents.length - 1].open, false, 'не отправлено «закрыть всё»');
    });

    check('имя фишки видно под фишкой, а не обрезано', () => {
      const label = mapHost.querySelector('[data-token-id="t1"] .token__label');
      assert(label, 'у фишки нет подписи с именем');
      assert(label.textContent === 'Гоблин', `текст подписи: ${label.textContent}`);
      // Карта сбрасывает line-height в ноль, поэтому подпись задаёт свой:
      // иначе её высота равна только отступам и overflow: hidden срезает текст.
      const style = getComputedStyle(label);
      assert(parseFloat(style.lineHeight) > 10, `line-height подписи: ${style.lineHeight}`);
      const height = label.getBoundingClientRect().height;
      assert(height > 10, `высота подписи ${height}px — текст обрезан`);
    });

    check('у фишки со скрытым именем на карте нет ни подписи, ни имени хозяина', () => {
      const nameless = MAP_STATE.tokens.map((token) => (token.id === 't1'
        ? { ...token, hideName: true, nameHidden: true, name: '', assignedPlayerId: 'p-1' }
        : token));
      mapView.render({ ...MAP_STATE, tokens: nameless }, { role: 'dm', playerId: 'dm' });
      const node = mapHost.querySelector('[data-token-id="t1"]');
      assert(node, 'фишка не отрисовалась');
      assert(!node.querySelector('.token__label'), 'подпись со скрытым именем осталась на карте');
      assert(!node.querySelector('.token__owner'), 'имя хозяина осталось при скрытом имени фишки');
      // Буквы в кружке тоже нет: брать её неоткуда, поэтому рисуется «?».
      assert(node.querySelector('.token__initial').textContent === '?',
        `в кружке: ${node.querySelector('.token__initial').textContent}`);
      assert(!mapHost.textContent.includes('Гоблин'), 'имя фишки осталось на карте текстом');
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
      assert(mapHost.querySelector('[data-token-id="t1"] .token__label'), 'подпись не вернулась');
    });

    check('подписи под фишкой убираются у всех сразу, а рисунок состояния остаётся', () => {
      // Отличие от скрытого имени: там тайна от игроков и мастер подпись видит,
      // здесь подписи просто не нужны никому, включая мастера.
      const plain = MAP_STATE.tokens.map((token) => (token.id === 't2'
        ? { ...token, hideLabels: true, conditions: ['restrained'] }
        : token));
      mapView.render({ ...MAP_STATE, tokens: plain }, { role: 'dm', playerId: 'dm' });
      const node = mapHost.querySelector('[data-token-id="t2"]');
      assert(node, 'фишка с убранными подписями не отрисовалась');
      assert(!node.querySelector('.token__label'), 'подпись с именем осталась');
      assert(!node.querySelector('.token__owner'), 'имя хозяина осталось');
      assert(!node.querySelector('.token__conditions'), 'подписи состояний остались');
      assert(node.querySelector('.token__label') === null, 'подпись не должна возвращаться');
      // Состояние читается по рисунку на карте, а не по подписи: лоза остаётся.
      assert(node.querySelector('.token__fx--vines'), 'лоза пропала вместе с подписями');
      assert(!mapHost.textContent.includes('Мира'), 'имя фишки осталось на карте текстом');
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
      assert(mapHost.querySelector('[data-token-id="t2"] .token__label'), 'подпись не вернулась');
    });

    check('состояния рисуются на карте, а не только пишутся подписями', () => {
      const withState = MAP_STATE.tokens.map((token) => (token.id === 't1'
        ? { ...token, conditions: ['restrained', 'prone'] }
        : token));
      mapView.render({ ...MAP_STATE, tokens: withState }, { role: 'dm', playerId: 'dm' });
      const node = mapHost.querySelector('[data-token-id="t1"]');
      assert(node.querySelector('.token__fx--vines'), 'у «опутан» нет лозы');
      assert(node.querySelector('.token__fx--prone'), 'у «сбит с ног» нет рисунка');
      assert(node.classList.contains('token--cond-restrained'), 'нет класса состояния');
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    });

    check('у каждого состояния из правил есть свой рисунок', () => {
      const all = MAP_STATE.tokens.map((token) => (token.id === 't1'
        ? { ...token, conditions: window.DnD5e.CONDITIONS.map((item) => item.id) }
        : token));
      mapView.render({ ...MAP_STATE, tokens: all }, { role: 'dm', playerId: 'dm' });
      const node = mapHost.querySelector('[data-token-id="t1"]');
      const drawn = new Set([...node.querySelectorAll('.token__fx')]
        .map((fx) => [...fx.classList].find((name) => name.startsWith('token__fx--'))));
      for (const item of window.DnD5e.CONDITIONS) {
        assert(drawn.has(`token__fx--${item.effect}`), `состояние «${item.label}» ничего не рисует`);
      }
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    });

    check('игрок не двигает фишку, у которой отняли скорость', () => {
      const bound = MAP_STATE.tokens.map((token) => (token.id === 't2'
        ? { ...token, conditions: ['restrained'] }
        : token));
      mapView.render({ ...MAP_STATE, tokens: bound }, { role: 'player', playerId: 'p-1' });
      const node = mapHost.querySelector('[data-token-id="t2"]');
      assert(!node.classList.contains('token--movable'), 'фишка осталась перетаскиваемой');
      assert(node.classList.contains('token--bound'), 'на фишке не видно, что она связана');
      const notices = [];
      mapView.handlers.onNotice = (message) => notices.push(message);
      node.click();
      delete mapView.handlers.onNotice;
      assert(notices.length === 1, `игроку не объяснили отказ: ${notices.join('; ')}`);
      assert(/опутан/i.test(notices[0]), `отказ без названия состояния: ${notices[0]}`);
      mapView.render(MAP_STATE, { role: 'player', playerId: 'p-1' });
    });

    check('мастер связанную фишку двигает и без состояния на ней', () => {
      const bound = MAP_STATE.tokens.map((token) => (token.id === 't1'
        ? { ...token, conditions: ['restrained'] }
        : token));
      mapView.render({ ...MAP_STATE, tokens: bound }, { role: 'dm', playerId: 'dm' });
      const node = mapHost.querySelector('[data-token-id="t1"]');
      assert(node.classList.contains('token--movable'), 'мастер не может перетащить связанную фишку');
      assert(!node.classList.contains('token--bound'), 'мастеру показали запрет, которого для него нет');
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    });

    /* ------------------------------------------------- ход по клеткам в бою */

    const COMBAT_STATE = {
      ...MAP_STATE,
      grid: { enabled: true, cell: 46, columns: 0, feetPerCell: 5, offsetX: 0, offsetY: 0 },
      combat: { enabled: true }
    };

    /**
     * Состояние с картинкой 400x300.
     *
     * Клетки считаются от ширины подложки, а тестовая картинка в одну точку не
     * даёт ни одной клетки: ход и кисть по ней не проверить. Размеры задаются
     * прямо на картинке на время проверки: ждать загрузки нельзя, ожидания в
     * этой части выполняются параллельно следующим проверкам.
     * @param {object} state
     * @returns {object}
     */
    const bigMapState = (state) => ({
      ...state,
      activeMap: 'world',
      activeMapId: 'm-world',
      maps: {
        ...state.maps,
        world: { items: [{ id: 'm-world', url: MAP_PNG, name: 'world.png' }], activeId: 'm-world' }
      }
    });

    /**
     * Выполняет проверку с подменёнными размерами картинки и убирает подмену.
     *
     * Свойство ставится на саму картинку и потом удаляется: следующие проверки
     * считают сетку по настоящей карте.
     * @param {() => void} fn
     */
    const withRealMapSize = (fn) => {
      Object.defineProperty(mapView.image, 'naturalWidth', { value: 400, configurable: true });
      Object.defineProperty(mapView.image, 'naturalHeight', { value: 300, configurable: true });
      // Размер подложки задаём руками: в проверочной песочнице у неё нет
      // высоты, а без неё указатель не попадает ни в одну клетку.
      mapView.surface.style.width = '800px';
      mapView.surface.style.height = '600px';
      try {
        fn();
      } finally {
        delete mapView.image.naturalWidth;
        delete mapView.image.naturalHeight;
      }
    };

    check('расстояние по клеткам считается по сторонам клеток, без диагонали', () => {
      mapView.render(COMBAT_STATE, { role: 'dm', playerId: 'dm' });
      const straight = mapView.combatMeasure({ col: 0, row: 0 }, { col: 3, row: 0 });
      assert.strictEqual(straight.steps, 3, 'прямая в три клетки посчитана неверно');
      assert.strictEqual(straight.feet, 15, 'в три клетки по пять футов');
      // Диагонали в маршруте нет, поэтому до клетки по диагонали столько же
      // шагов, сколько по сторонам: четыре на четыре — восемь, а не четыре.
      const diagonal = mapView.combatMeasure({ col: 0, row: 0 }, { col: 4, row: 4 });
      assert.strictEqual(diagonal.steps, 8, `по диагонали на 4 клетки: ${diagonal.steps}`);
      assert.strictEqual(diagonal.feet, 40, 'футы по диагонали считаются неверно');
      const mixed = mapView.combatMeasure({ col: 0, row: 0 }, { col: 3, row: 1 });
      assert.strictEqual(mixed.steps, 4, `смешанный ход: ${mixed.steps}`);
    });

    check('маршрут идёт по клеткам с одним поворотом, а не по диагонали', () => {
      mapView.render(COMBAT_STATE, { role: 'dm', playerId: 'dm' });
      const path = mapView.combatPath({ col: 1, row: 3 }, { col: 3, row: 1 });
      assert.deepStrictEqual(path, [
        { col: 1, row: 2 }, { col: 1, row: 1 },
        { col: 2, row: 1 }, { col: 3, row: 1 }
      ], `путь строится неверно: ${JSON.stringify(path)}`);
      // Поворот всегда в строке цели: иначе рисунок скакал бы от клетки к клетке.
      for (const point of path) {
        assert(point.col === 1 || point.row === 1,
          `точка ${JSON.stringify(point)} не лежит на одной из сторон пути`);
      }
      const down = mapView.combatPath({ col: 0, row: 0 }, { col: 0, row: 2 });
      assert.deepStrictEqual(down, [{ col: 0, row: 1 }, { col: 0, row: 2 }], 'ход вниз собран неверно');
      const same = mapView.combatPath({ col: 2, row: 2 }, { col: 2, row: 2 });
      assert.deepStrictEqual(same, [{ col: 2, row: 2 }], 'ход в ту же клетку должен быть пустым');
    });

    check('подпись расстояния называет шаги, клетки и футы', () => {
      const text = mapView.combatDistanceText(mapView.combatMeasure({ col: 0, row: 0 }, { col: 3, row: 0 }));
      assert(/3 шага/.test(text), `подпись расстояния: ${text}`);
      assert(/15 футов/.test(text), `в подписи нет футов: ${text}`);
      assert(/клетк/.test(text), `в подписи нет клеток: ${text}`);
      assert.strictEqual(mapView.combatDistanceText(mapView.combatMeasure({ col: 1, row: 1 }, { col: 1, row: 1 })), 'здесь же');
    });

    check('линейка измеряет расстояние и подписывает футы', () => {
      mapView.render(COMBAT_STATE, { role: 'dm', playerId: 'dm' });
      withRealMapSize(() => {
        mapView.toggleMeasure();
        assert(mapView.measureMode, 'линейка не включилась');
        const rect = mapView.surface.getBoundingClientRect();
        // Две клетки: 46 px картинки на клетку, подложка растянута вдвое.
        const step = (rect.width / 400) * 46;
        const x1 = rect.left + 40;
        const y1 = rect.top + 40;
        const x2 = x1 + step * 2;
        mapView.surface.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, clientX: x1, clientY: y1
        }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: x2, clientY: y1 }));
        window.dispatchEvent(new PointerEvent('pointerup', {}));
        assert(!mapView.measureLayer.hidden, 'линия линейки не показана');
        const label = mapView.measureLabel.textContent;
        assert(/10 фут/.test(label), `в подписи нет футов: ${label}`);
        assert(/2 кл/.test(label), `в подписи нет клеток: ${label}`);
        mapView.toggleMeasure();
        assert(mapView.measureLayer.hidden, 'линейка не убралась');
      });
    });

    check('мастер ставит шаблон сферы, и он остаётся на карте', () => {
      mapView.render(bigMapState(MAP_STATE), { role: 'dm', playerId: 'dm' });
      withRealMapSize(() => {
        const sent = [];
        mapView.handlers.onAddMapTemplate = (type, mapId, template) => sent.push({ type, mapId, template });
        mapView.templateDraft = { kind: 'sphere', size: 20 };
        const rect = mapView.surface.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        mapView.surface.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, clientX: x, clientY: y
        }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: x + 80, clientY: y }));
        window.dispatchEvent(new PointerEvent('pointerup', {}));
        assert.strictEqual(sent.length, 1, `шаблон не ушёл на стол: ${sent.length}`);
        assert.strictEqual(sent[0].template.kind, 'sphere');
        assert.strictEqual(sent[0].template.size, 20);
        assert(mapView.templateLayer.querySelector('.map-template--sphere'), 'сфера не нарисована');
        mapView.templateDraft = { kind: 'square', size: 20, color: '#66ccff' };
        mapView.surface.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, clientX: x, clientY: y
        }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: x + 80, clientY: y }));
        window.dispatchEvent(new PointerEvent('pointerup', {}));
        assert.strictEqual(sent.length, 2, `квадрат не ушёл на стол: ${sent.length}`);
        const square = mapView.templateLayer.querySelector('.map-template--square');
        assert(square, 'квадрат не нарисован');
        assert.strictEqual(square.getAttribute('stroke'), '#66ccff');
        delete mapView.handlers.onAddMapTemplate;
      });
    });

    check('в бою фишку выбирают нажатием и она перестаёт таскаться', () => {
      mapView.render(COMBAT_STATE, { role: 'dm', playerId: 'dm' });
      const node = mapHost.querySelector('[data-token-id="t1"]');
      assert(node.classList.contains('token--selectable'), 'фишка в бою не выбирается нажатием');
      node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
      assert.strictEqual(mapView.combat.tokenId, 't1', 'фишка не выбралась');
      // Фишки перерисовываются целиком, поэтому проверяем свежий узел.
      const marked = mapHost.querySelector('[data-token-id="t1"]');
      assert(marked.classList.contains('token--combat'), 'выбранная фишка не помечена');
      // Повторное нажатие снимает выбор: иначе пришлось бы искать кнопку отмены.
      marked.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
      assert.strictEqual(mapView.combat.tokenId, null, 'выбор не снялся');
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    });

    check('объявление стола в чате выглядит не как реплика игрока', () => {
      const chatHost = document.createElement('div');
      const chat = new window.TableUI.ChatPanel(chatHost, {});
      chat.append({
        from: 'Мастер', role: 'dm', system: true, text: 'Режим боя включён: нажмите на фишку'
      });
      const system = chatHost.querySelector('.chat__msg--system');
      assert(system, 'объявление стола нарисовано репликой с автором');
      assert(system.querySelector('.chat__author') === null, 'у объявления стола есть автор');
      assert(system.textContent.includes('Режим боя включён'), `текст объявления: ${system.textContent}`);
      chat.append({ from: 'Борис', role: 'player', text: 'Готов' });
      assert(chatHost.querySelectorAll('.chat__msg--system').length === 1,
        'реплика игрока нарисована объявлением стола');
      assert(chatHost.textContent.includes('Готов'), 'реплика игрока пропала');
    });

    check('шёпот мастеру отправляется с флагом и помечен в ленте', () => {
      const host = document.createElement('div');
      let sent = null;
      const chat = new window.TableUI.ChatPanel(host, {
        canWhisper: () => true,
        onSend: (text, whisper) => { sent = { text, whisper }; }
      });
      chat.renderAll([]);
      const button = host.querySelector('.chat__whisper');
      assert(button && !button.hidden, 'у игрока нет кнопки шёпота');
      button.click();
      assert(button.getAttribute('aria-pressed') === 'true', 'шёпот не включился');
      const input = host.querySelector('.chat__form input');
      input.value = 'Сундук с ловушкой';
      host.querySelector('.chat__form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      assert.deepStrictEqual(sent, { text: 'Сундук с ловушкой', whisper: true });
      assert(button.getAttribute('aria-pressed') === 'false', 'шёпот остался включённым после отправки');
      chat.append({ from: 'Артём', role: 'player', whisper: true, text: 'Тайна' });
      assert(host.querySelector('.chat__msg--whisper'), 'шёпот в ленте не помечен');
      assert(host.textContent.includes('мастеру'), 'у шёпота нет подписи адресата');

      const dmHost = document.createElement('div');
      const dmChat = new window.TableUI.ChatPanel(dmHost, { canWhisper: () => false });
      dmChat.renderAll([]);
      assert(dmHost.querySelector('.chat__whisper').hidden, 'у мастера осталась кнопка шёпота');
    });

    check('наведение показывает клетку назначения и расстояние', () => {
      withRealMapSize(() => {
        mapView.render(bigMapState(COMBAT_STATE), { role: 'dm', playerId: 'dm' });
        mapView.selectCombatToken('t1');
        const surface = mapView.surface;
        const rect = surface.getBoundingClientRect();
        assert(rect.width > 0, 'подложка карты без размера');
        // Проверка обязана быть синхронной: ждать нельзя, все ожидания здесь
        // выполняются параллельно следующим проверкам.
        surface.dispatchEvent(new PointerEvent('pointermove', new MapViewEvent(
          rect, rect.left + ((5.5 * 46) / 400) * rect.width, rect.top + rect.height / 2
        ).payload()));
        assert(!mapView.routeLabel.hidden, `подпись расстояния не показана: ${JSON.stringify({
          enabled: mapView.combat.enabled,
          token: mapView.combat.tokenId,
          route: mapView.route,
          rect: [rect.width, rect.height]
        })}`);
        assert(/\d+ шаг/.test(mapView.routeLabel.textContent), `подпись: ${mapView.routeLabel.textContent}`);
        assert(!mapView.cellMark.hidden, 'клетка назначения не подсвечена');
        // Линию маршрута убрали: она уезжала от фишки. Клетка и число шагов
        // остаются, а линии на карте быть не должно.
        assert(!mapView.routeLine, 'у карты всё ещё есть линия маршрута');
        assert(!mapHost.querySelector('.map-route'), 'линия маршрута всё ещё рисуется');
        mapView.selectCombatToken(null);
      });
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    });

    check('кружок фишки стоит ровно на её координатах, а не смещён подписями', () => {
      // Подписи и прочность лежат отдельным слоем и якорь не сдвигают. Иначе
      // фишка встаёт не в ту клетку, куда её поставили, и клетка считается
      // не под кружком.
      withRealMapSize(() => {
        const off = {
          ...COMBAT_STATE,
          activeMap: 'world',
          maps: {
            world: { items: [{ id: 'm-world', url: MAP_PNG, name: 'world.png' }], activeId: 'm-world' }
          },
          tokens: [{ ...MAP_STATE.tokens[0], x: 0.25, y: 0.45, conditions: [] }]
        };
        mapView.render(off, { role: 'dm', playerId: 'dm' });
        mapView.selectCombatToken(off.tokens[0].id);
        const tokenNode = mapHost.querySelector(`[data-token-id="${off.tokens[0].id}"]`);
        const circleRect = tokenNode.querySelector('.token__circle').getBoundingClientRect();
        const boxRect = mapView.surface.getBoundingClientRect();
        const circleX = (circleRect.left + circleRect.width / 2 - boxRect.left) / boxRect.width;
        const circleY = (circleRect.top + circleRect.height / 2 - boxRect.top) / boxRect.height;
        assert(Math.abs(circleX - 0.25) < 0.02, `кружок фишки смещён по x: ${circleX}`);
        assert(Math.abs(circleY - 0.45) < 0.02, `кружок фишки смещён по y: ${circleY}`);
        mapView.selectCombatToken(null);
      });
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    });

    check('клетка фишки считается по нарисованному узлу, даже если координаты в снимке старые', () => {
      // Во время хода по клеткам узел уже стоит в новой клетке, а token.x/y
      // приходят с ответом стола позже. Шаги обязаны считаться от того места,
      // где фишку видит человек.
      withRealMapSize(() => {
        const off = {
          ...COMBAT_STATE,
          activeMap: 'world',
          maps: {
            world: { items: [{ id: 'm-world', url: MAP_PNG, name: 'world.png' }], activeId: 'm-world' }
          },
          tokens: [{ ...MAP_STATE.tokens[0], x: 0.25, y: 0.45, conditions: [] }]
        };
        mapView.render(off, { role: 'dm', playerId: 'dm' });
        mapView.selectCombatToken(off.tokens[0].id);
        const node = mapHost.querySelector(`[data-token-id="${off.tokens[0].id}"]`);
        node.style.left = '50%';
        node.style.top = '60%';
        const cell = mapView.tokenCell(off.tokens[0]);
        assert.deepStrictEqual(cell, { col: 4, row: 3 },
          `клетка взята не от узла: ${JSON.stringify(cell)}`);
        mapView.selectCombatToken(null);
      });
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    });

    check('нажатие по клетке в бою отправляет фишку в эту клетку одним ходом', () => {
      withRealMapSize(() => {
        mapView.render(bigMapState(COMBAT_STATE), { role: 'dm', playerId: 'dm' });
        mapView.selectCombatToken('t1');
        const rect = mapView.surface.getBoundingClientRect();
        // Клетка номер 4 по столбцу и номер 1 по строке: от фишки в клетке
        // (2, 4) это четыре шага вправо и три вверх, семь клеток пути.
        mapView.surface.dispatchEvent(new PointerEvent('pointerdown', new MapViewEvent(
          rect, rect.left + ((4.5 * 46) / 400) * rect.width, rect.top + ((1.5 * 46) / 300) * rect.height
        ).payload()));
        assert(mapView.walkTimer, 'фишка не пошла по клеткам');
        assert(mapView.dragState && mapView.dragState.walk, 'слой не защищён на время хода');
        const node = mapView.tokenLayer.querySelector('[data-token-id="t1"]');
        assert(node.classList.contains('token--walking'), 'фишка не помечена как идущая');
        // Ход дожидается своей очереди: оставлять таймер нельзя, он перерисовал
        // бы общую карту стола в следующих проверках.
        clearInterval(mapView.walkTimer);
        mapView.walkTimer = null;
        mapView.dragState = null;
        mapView.selectCombatToken(null);
      });
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    });

    check('в бою без выбранной фишки нажатие объясняет, что делать', () => {
      const notices = [];
      mapView.handlers.onNotice = (message) => notices.push(message);
      withRealMapSize(() => {
        mapView.render(bigMapState(COMBAT_STATE), { role: 'dm', playerId: 'dm' });
        const rect = mapView.surface.getBoundingClientRect();
        mapView.surface.dispatchEvent(new PointerEvent('pointerdown', new MapViewEvent(
          rect, rect.left + rect.width / 2, rect.top + rect.height / 2
        ).payload()));
      });
      delete mapView.handlers.onNotice;
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
      assert(notices.length === 1, `молчание вместо объяснения: ${notices.join('; ')}`);
      assert(/фишк/i.test(notices[0]), `не сказано, что делать: ${notices[0]}`);
    });

        check('игроку вместо строки карты показывают подсказку', () => {
      // У игрока строка карты скрыта целиком: там только мастерские инструменты,
      // и выключенный переключатель выглядел бы сломанной кнопкой.
      mapView.render({ ...COMBAT_STATE, combat: { enabled: false } }, { role: 'player', playerId: 'p-1' });
      mapView.renderToolbar();
      assert(mapView.toolbar.hidden, 'строка карты показана игроку');
      assert.strictEqual(mapView.toolbar.childNodes.length, 0, 'игроку показаны мастерские кнопки');
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
      mapView.renderToolbar();
      assert(!mapView.toolbar.hidden, 'строка карты не вернулась мастеру');
    });

    /* --------------------------------------------------- поверхность карта */

    const surfaceHost = document.createElement('div');
    sandbox.appendChild(surfaceHost);
    const surfaceCalls = [];
    const surfacePanel = new window.TableUI.SurfacePanel(surfaceHost, {
      onPick: (type) => surfaceCalls.push(['pick', type]),
      onBrush: (brush) => surfaceCalls.push(['brush', brush]),
      onErase: () => surfaceCalls.push(['erase']),
      onClear: () => surfaceCalls.push(['clear'])
    });
    surfacePanel.render({ tool: null, brush: 1, painted: 0 });

    check('в панели поверхности есть все состояния из правил', () => {
      const chips = [...surfaceHost.querySelectorAll('.surface-chip')];
      assert.strictEqual(chips.length, window.DnD5e.SURFACE_TYPES.length, `кнопок типов: ${chips.length}`);
      const labels = chips.map((chip) => chip.textContent);
      for (const item of window.DnD5e.SURFACE_TYPES) {
        assert(labels.includes(item.label), `в панели нет «${item.label}»: ${labels.join(', ')}`);
      }
      // У каждого типа свой цвет: иначе «дым» и «лёд» пришлось бы различать
      // только по словам.
      const dots = chips.map((chip) => chip.querySelector('.surface-chip__dot').style.background);
      assert.strictEqual(new Set(dots).size, dots.length, 'цвета поверхностей совпали');
    });

    check('выбор поверхности, ластик, ширина и очистка доходят до обработчиков', () => {
      const chip = byText(surfaceHost, 'Огонь');
      assert(chip, 'в панели нет кнопки «Огонь»');
      chip.click();
      assert.deepStrictEqual(surfaceCalls.pop(), ['pick', 'fire'], 'тип не отправлен');
      surfacePanel.render({ tool: 'fire', brush: 1, painted: 4 });
      const fire = byText(surfaceHost, 'Огонь');
      assert(fire.classList.contains('is-on'), 'выбранный тип не подсвечен');
      const brushInput = surfaceHost.querySelector('.surface-panel__brush input');
      brushInput.value = '3';
      brushInput.dispatchEvent(new Event('input', { bubbles: true }));
      assert.deepStrictEqual(surfaceCalls.pop(), ['brush', 3], 'ширина кисти не отправлена');
      byText(surfaceHost, 'Ластик').click();
      assert.deepStrictEqual(surfaceCalls.pop(), ['erase'], 'ластик не отправлен');
      surfacePanel.render({ tool: null, brush: 3, painted: 7 });
      byText(surfaceHost, 'Очистить карту').click();
      assert.deepStrictEqual(surfaceCalls.pop(), ['clear'], 'очистка карты не отправлена');
      // Пустая карта очищать нечего, и кнопка гаснет сама.
      surfacePanel.render({ tool: null, brush: 3, painted: 0 });
      assert(surfaceHost.querySelector('.surface-panel__row .btn:last-child').disabled,
        'очистка доступна на пустой карте');
      assert.strictEqual(surfaceHost.querySelectorAll('.surface-panel__row .btn').length, 2,
        'в строке не хватает кнопок');
    });

    check('поверхность рисуется по клеткам и уходит на сервер пачкой', () => {
      const painted = [];
      mapView.handlers.onPaintSurface = (type, mapId, cells) => painted.push({ type, mapId, cells });
      withRealMapSize(() => {
        mapView.render(bigMapState(COMBAT_STATE), { role: 'dm', playerId: 'dm' });
        mapView.setSurfaceTool('acid');
        const rect = mapView.surface.getBoundingClientRect();
        const at = (col, row) => new PointerEvent('pointerdown', new MapViewEvent(
          rect,
          rect.left + ((col * 46) / 400) * rect.width,
          rect.top + ((row * 46) / 300) * rect.height
        ).payload());
        mapView.surface.dispatchEvent(at(2.5, 1.5));
        mapView.surface.dispatchEvent(at(3.5, 1.5));
        mapView.surface.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        assert.strictEqual(painted.length, 1, `мазок ушёл ${painted.length} раз, а не одним пачкой`);
        const kinds = new Set(painted[0].cells.map((entry) => entry[2]));
        assert.deepStrictEqual([...kinds], ['acid'], `в мазке посторонние типы: ${[...kinds]}`);
        const cols = painted[0].cells.map((entry) => entry[0]).sort();
        assert.deepStrictEqual(cols, [2, 3], `кисть легла не в те клетки: ${cols}`);
        const map = mapView.mapOf('world');
        assert(Object.keys(map.surface.cells).length === painted[0].cells.length,
          'на карте столько же клеток, сколько ушло на сервер');
        assert(!mapView.surfaceCanvas.hidden, 'слой поверхности не показан');
        // Ластик — это пустая строка, а не null: проверка на falsy съедала его,
        // и ластик молча ничего не делал.
        mapView.setSurfaceTool('');
        mapView.surface.dispatchEvent(at(2.5, 1.5));
        mapView.surface.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        assert.strictEqual(painted.length, 2, 'стирание не ушло на сервер');
        assert.deepStrictEqual(painted[1].cells, [[2, 1, '']], `стирание: ${JSON.stringify(painted[1].cells)}`);
        assert(!map.surface.cells['2,1'], 'ластик не стёр клетку с карты');
        mapView.setSurfaceTool(null);
      });
      delete mapView.handlers.onPaintSurface;
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    });

    check('прочность видна прямо на фишке на карте', () => {
      // Фишка t1 получает прочность здесь же: за боком мастер смотрит на
      // карту, а не в правую колонку.
      const withHp = MAP_STATE.tokens.map((token) => (token.id === 't1'
        ? { ...token, maxHp: 9, hp: 3 }
        : token));
      mapView.render({ ...MAP_STATE, tokens: withHp }, { role: 'dm', playerId: 'dm' });
      const token = mapHost.querySelector('[data-token-id="t1"]');
      assert(token, 'фишка с прочностью не отрисовалась на карте');
      const bar = token.querySelector('.token__hp');
      assert(bar, 'у фишки с прочностью нет полосы на карте');
      assert(bar.querySelector('.token__hp-value').textContent === '3/9',
        `прочность на карте: ${bar.querySelector('.token__hp-value').textContent}`);
      assert(token.classList.contains('token--hurt'), 'треть прочности не отмечено как ранение');
      // Фишка без прочности остаётся чистой меткой.
      assert(!mapHost.querySelector('[data-token-id="t2"] .token__hp'), 'у фишки без прочности полоса появилась');

      const downed = withHp.map((item) => (item.id === 't1' ? { ...item, hp: 0 } : item));
      mapView.render({ ...MAP_STATE, tokens: downed }, { role: 'dm', playerId: 'dm' });
      const dead = mapHost.querySelector('[data-token-id="t1"]');
      assert(dead.classList.contains('token--down'), 'павший не отмечен на карте');
      assert(dead.querySelector('.token__hp-value').textContent === '0/9', 'у павшего неверная прочность');
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    });

    check('прочность монстра игроку на карте не показывается', () => {
      // Правило стола: прость ведёт мастер у себя, игроки видят только
      // прочность фишек игроков. Проверяем именно то, что пришло клиенту:
      // сервер присылает фишку без maxHp, и полосы на карте не появляется.
      const state = MAP_STATE.tokens.map((token) => ({ ...token, maxHp: 9, hp: 6 }));
      mapView.render({ ...MAP_STATE, tokens: state }, { role: 'dm', playerId: 'dm' });
      assert(mapHost.querySelectorAll('.token__hp').length === 2, 'у мастера должны быть полосы на обеих фишках');

      // То же состояние, но так, как его видит игрок: сервер убрал прочность с
      // ничьих фишек, а у фишки игрока оставил.
      const playerTokens = MAP_STATE.tokens.map((token) => (token.assignedPlayerId
        ? { ...token, maxHp: 9, hp: 6 }
        : { ...token, maxHp: null, hp: null }));
      mapView.render({ ...MAP_STATE, tokens: playerTokens }, { role: 'player', playerId: 'p-1' });
      const withHp = [...mapHost.querySelectorAll('.token')].filter((node) => node.querySelector('.token__hp'));
      assert.strictEqual(withHp.length, 1, `полос у игрока: ${withHp.length}`);
      assert.strictEqual(withHp[0].dataset.tokenId, 't2', 'полоса показана не на той фишке');

      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    });

    const menuHost = document.createElement('div');
    sandbox.appendChild(menuHost);
    const menuActions = [];
    const menuView = new window.TableUI.MapView(menuHost, {
      onDeleteToken: (id) => menuActions.push(`delete:${id}`),
      onRenameToken: (token) => menuActions.push(`rename:${token.name}`),
      onSetTokenImage: (id) => menuActions.push(`image:${id}`),
      onAssignToken: (id, playerId) => menuActions.push(`assign:${id}:${playerId}`),
      onMoveTokenToActive: (id) => menuActions.push(`transfer:${id}`)
    });
    menuView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    const menuToken = menuHost.querySelector('[data-token-id="t1"]');
    const openMenu = async () => {
      menuToken.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 420, clientY: 320 }));
      // Слушатели закрытия меню навешиваются в следующем такте — как в жизни.
      await wait(30);
    };

    await openMenu();
    check('правый клик по фишке открывает меню', () => {
      assert(document.querySelector('.token-menu'), 'меню не открылось');
      assert(document.querySelector('.token-menu select'), 'в меню нет выбора игрока');
    });
    check('в меню фишки есть переименование, изображение и удаление', () => {
      const items = [...document.querySelectorAll('.token-menu__item')].map((node) => node.textContent);
      assert(items.some((text) => text.includes('Переименовать')), `пункты: ${items.join(' | ')}`);
      assert(items.some((text) => text.includes('Изображение')), `пункты: ${items.join(' | ')}`);
      assert(items.some((text) => text.includes('Удалить фишку')), `пункты: ${items.join(' | ')}`);
    });
    check('фишку с показанной карты нельзя перенести на неё же', () => {
      const transfer = [...document.querySelectorAll('.token-menu__item')]
        .find((node) => node.textContent.includes('На карту игроков'));
      assert(transfer, 'нет пункта переноса на карту игроков');
      assert(transfer.disabled, 'перенос с этой же карты должен быть выключен');
    });

    // Нажимаем пункт так, как это делает человек: сначала pointerdown, потом click.
    const removeItem = [...document.querySelectorAll('.token-menu__item')]
      .find((node) => node.textContent.includes('Удалить'));
    const removeRect = removeItem.getBoundingClientRect();
    removeItem.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: removeRect.x + 5, clientY: removeRect.y + 5
    }));
    check('нажатие внутри меню не закрывает его раньше времени', () => {
      assert(document.querySelector('.token-menu'), 'меню закрылось на pointerdown — пункты не успеют сработать');
    });
    removeItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    check('пункт «Удалить фишку» действительно удаляет фишку', () => {
      assert(menuActions.includes('delete:t1'), `действия: ${menuActions.join(', ')}`);
      assert(!document.querySelector('.token-menu'), 'меню осталось открытым');
    });

    await openMenu();
    const imageItem = [...document.querySelectorAll('.token-menu__item')]
      .find((node) => node.textContent.includes('Изображение'));
    check('в меню есть выбор изображения фишки', () => {
      assert(imageItem, 'нет пункта с изображением');
      assert(imageItem.querySelector('input[type="file"]'), 'нет поля выбора файла');
    });
    imageItem.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    check('меню не мешает выбрать файл изображения', () => {
      assert(document.querySelector('.token-menu'), 'меню закрылось на pointerdown — диалог выбора не откроется');
      assert(imageItem.querySelector('input[type="file"]').isConnected, 'поле выбора файла пропало из документа');
    });
    const menuFile = imageItem.querySelector('input[type="file"]');
    const menuTransfer = new DataTransfer();
    menuTransfer.items.add(new File(
      [Uint8Array.from(atob(PNG_1PX.split(',')[1]), (character) => character.charCodeAt(0))],
      'goblin.png',
      { type: 'image/png' }
    ));
    menuFile.files = menuTransfer.files;
    menuFile.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(60);
    check('выбранное изображение фишки доходит до обработчика', () => {
      assert(menuActions.includes('image:t1'), `действия: ${menuActions.join(', ')}`);
      assert(!document.querySelector('.token-menu'), 'меню не закрылось после выбора изображения');
    });

    await openMenu();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    check('нажатие вне меню закрывает меню', () => {
      assert(!document.querySelector('.token-menu'), 'меню не закрылось');
    });

    // Фишка на другой карте: её можно перевести на ту, которую видят игроки.
    const preparedTokens = MAP_STATE.tokens.map((token) => (token.id === 't1'
      ? { ...token, mapType: 'battle', mapId: 'm-battle' }
      : token));
    menuView.render({ ...MAP_STATE, tokens: preparedTokens }, { role: 'dm', playerId: 'dm' });
    menuView.onTabClick('battle');
    await wait(30);
    const battleToken = menuHost.querySelector('[data-token-id="t1"]');
    battleToken.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 420, clientY: 320 }));
    await wait(30);
    const transferItem = [...document.querySelectorAll('.token-menu__item')]
      .find((node) => node.textContent.includes('На карту игроков'));
    check('фишку с другой карты можно перенести на карту игроков', () => {
      assert(transferItem, 'нет пункта переноса на карту игроков');
      assert(!transferItem.disabled, 'перенос с другой карты выключен');
      menuActions.length = 0;
      transferItem.click();
      assert(menuActions.includes('transfer:t1'), `действия: ${menuActions.join(', ')}`);
      assert(!document.querySelector('.token-menu'), 'меню не закрылось после переноса');
    });

    const gridHost = document.createElement('div');
    sandbox.appendChild(gridHost);
    let gridRequest = null;
    const gridView = new window.TableUI.MapView(gridHost, {
      onToggleGrid: (enabled) => { gridRequest = enabled; }
    });
    gridView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    check('сетка выключена, пока ДМ её не включил', () => {
      assert(gridHost.querySelector('.map-grid').hidden, 'сетка показана без запроса ДМ');
      const gridButton = [...gridHost.querySelectorAll('.map-toolbar button')]
        .find((node) => node.textContent.startsWith('Сетка'));
      assert(gridButton, 'в панели карты нет кнопки сетки');
      assert(gridButton.textContent.includes('выкл'), `надпись на кнопке: ${gridButton.textContent}`);
      gridButton.click();
      assert(gridRequest === true, `запрошено включение сетки: ${gridRequest}`);
    });
    check('клетка сетки равна размеру фишки', () => {
      gridView.render({ ...MAP_STATE, grid: { enabled: true, cell: 72 } }, { role: 'dm', playerId: 'dm' });
      const grid = gridHost.querySelector('.map-grid');
      assert(!grid.hidden, 'сетка не показана после включения');
      assert(gridHost.querySelector('.map-surface').style.getPropertyValue('--cell') === '72px',
        'размер клетки не передан на карту');
      const circle = gridHost.querySelector('.token__circle');
      assert(getComputedStyle(circle).width === '72px',
        `фишка ${getComputedStyle(circle).width} при клетке 72px`);
      assert(getComputedStyle(grid).backgroundImage.includes('72px'),
        `шаг сетки: ${getComputedStyle(grid).backgroundImage}`);
    });
    check('сетку можно выключить обратно', () => {
      gridView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
      assert(gridHost.querySelector('.map-grid').hidden, 'сетка осталась включённой');
    });

    check('сетку можно настроить прямо за столом', () => {
      const host = document.createElement('div');
      sandbox.appendChild(host);
      let sent = null;
      const view = new window.TableUI.MapView(host, { onSetGrid: (grid) => { sent = grid; } });
      view.render({
        ...MAP_STATE,
        grid: { enabled: true, cell: 46, columns: 0, feetPerCell: 5, offsetX: 0, offsetY: 0 }
      }, { role: 'dm', playerId: 'dm' });
      const toggle = host.querySelector('.map-grid-menu__toggle');
      assert(toggle, 'в тулбаре нет кнопки настройки сетки');
      const menu = host.querySelector('.map-grid-menu');
      assert(menu.hidden, 'меню сетки открыто без нажатия');
      toggle.click();
      assert(!menu.hidden, 'меню сетки не открылось по кнопке');
      // Поля стоят на текущих значениях сетки, а не на пустых.
      assert(menu.querySelector('[data-field="cell"]').value === '46', 'размер клетки не подставлен');
      assert(menu.querySelector('[data-field="feetPerCell"]').value === '5', 'футы не подставлены');
      // Правка числа клеток по ширине уходит на стол тем же полем, что и настройки.
      const columns = menu.querySelector('[data-field="columns"]');
      columns.value = '37.5';
      columns.dispatchEvent(new Event('change', { bubbles: true }));
      assert(sent && sent.columns === 37.5, `на стол ушло: ${JSON.stringify(sent)}`);
      assert(sent.enabled === true, 'видимость сетки потерялась при правке');
      toggle.click();
      assert(menu.hidden, 'меню сетки не закрылось повторным нажатием');
    });

    check('кнопка боя показывает режим из состояния стола', () => {
      const host = document.createElement('div');
      sandbox.appendChild(host);
      let requested = null;
      const view = new window.TableUI.MapView(host, { onSetCombatMode: (value) => { requested = value; } });
      view.render({ ...MAP_STATE, combat: { enabled: true } }, { role: 'dm', playerId: 'dm' });
      const button = [...host.querySelectorAll('.map-toolbar button')]
        .find((node) => node.textContent.startsWith('Бой'));
      assert(button, 'в тулбаре нет кнопки боя');
      assert(button.textContent.includes('вкл'), `бой идёт, а кнопка: ${button.textContent}`);
      button.click();
      assert(requested === false, `кнопка выключения боя запросила: ${requested}`);
    });

    check('клетка и сдвиг сетки масштабируются вместе с картой', () => {
      // Картинка 400x300 показана как 800x600: клетка 46 px картинки должна
      // занять 92 px экрана. Без множителя сетка рисовалась бы вдвое мельче
      // карты, и шаги маршрута не совпадали бы с её клетками.
      withRealMapSize(() => {
        mapView.render({
          ...bigMapState(MAP_STATE),
          grid: { enabled: true, cell: 46, columns: 0, feetPerCell: 5, offsetX: 10, offsetY: 0 }
        }, { role: 'dm', playerId: 'dm' });
        const surface = mapView.surface;
        assert.strictEqual(surface.style.getPropertyValue('--cell'), '92px',
          `клетка на экране: ${surface.style.getPropertyValue('--cell')}`);
        assert.strictEqual(surface.style.getPropertyValue('--grid-shift-x'), '20px',
          `сдвиг на экране: ${surface.style.getPropertyValue('--grid-shift-x')}`);
        const circle = mapHost.querySelector('[data-token-id="t1"] .token__circle');
        assert.strictEqual(getComputedStyle(circle).width, '92px',
          `фишка ${getComputedStyle(circle).width} при клетке 92px`);
        const grid = mapHost.querySelector('.map-grid');
        assert(getComputedStyle(grid).backgroundImage.includes('92px'),
          `шаг сетки: ${getComputedStyle(grid).backgroundImage}`);
      });
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    });

    /* ------------------------ несколько карт в одной вкладке */

    const multiHost = document.createElement('div');
    sandbox.appendChild(multiHost);
    const multiCalls = [];
    const multiView = new window.TableUI.MapView(multiHost, {
      resolveUrl: (url) => url,
      onSelectMap: (type, mapId) => multiCalls.push(`select:${type}:${mapId}`),
      onSetActive: (type, mapId) => multiCalls.push(`setActive:${type}:${mapId}`),
      onDelete: (type, mapId) => multiCalls.push(`delete:${type}:${mapId}`),
      onUpload: () => {}
    });
    const MULTI_STATE = {
      maps: {
        world: {
          items: [
            { id: 'm1', url: PNG_1PX, name: 'первая.png' },
            { id: 'm2', url: PNG_1PX, name: 'вторая.png' },
            { id: 'm3', url: PNG_1PX, name: 'третья.png' }
          ],
          activeId: 'm2'
        },
        battle: { items: [], activeId: null },
        sketch: { items: [], activeId: null }
      },
      activeMap: 'world',
      activeMapId: 'm2',
      grid: { enabled: false, cell: DnD.GRID.defaultCell },
      tokens: [],
      players: PLAYERS
    };
    multiView.render(MULTI_STATE, { role: 'dm', playerId: 'dm' });

    check('во вкладке можно держать несколько карт и переключаться между ними', () => {
      const list = multiHost.querySelector('.map-toolbar__list');
      assert(list, 'нет списка карт вкладки');
      const names = [...list.options].map((option) => option.textContent);
      assert(names.length === 3, `карт в списке: ${names.length} (${names.join(', ')})`);
      assert(list.value === 'm2', `в списке выбрана не та карта: ${list.value}`);
      const shown = multiHost.querySelector('.map-toolbar__name').textContent;
      assert(shown.includes('вторая.png') && shown.includes('2 из 3'), `подпись карты: ${shown}`);
    });
    check('карты вкладки листаются стрелками ◀ ▶', () => {
      const button = (label) => [...multiHost.querySelectorAll('.map-toolbar button')]
        .find((node) => node.textContent === label);
      button('▶').click();
      assert(multiCalls.includes('select:world:m3'), `вперёд: ${multiCalls.join(', ')}`);
      button('◀').click();
      assert(multiCalls.includes('select:world:m1'), `назад: ${multiCalls.join(', ')}`);
      const list = multiHost.querySelector('.map-toolbar__list');
      list.value = 'm3';
      list.dispatchEvent(new Event('change', { bubbles: true }));
      assert(multiCalls.includes('select:world:m3'), `выбор из списка: ${multiCalls.join(', ')}`);
    });
    check('подготовленную карту можно показать отдельной кнопкой', () => {
      // Мастер выбрал третью карту, но игроки всё ещё видят вторую.
      const prepared = {
        ...MULTI_STATE,
        maps: {
          ...MULTI_STATE.maps,
          world: { ...MULTI_STATE.maps.world, activeId: 'm3' }
        }
      };
      multiView.render(prepared, { role: 'dm', playerId: 'dm' });
      const list = multiHost.querySelector('.map-toolbar__list');
      assert([...list.options].some((option) => option.textContent.includes('вторая.png · показана')),
        `в списке не отмечена показанная карта: ${[...list.options].map((option) => option.textContent).join(', ')}`);
      multiCalls.length = 0;
      const show = [...multiHost.querySelectorAll('.map-toolbar button')]
        .find((node) => node.textContent.includes('Показать игрокам'));
      assert(show, 'нет кнопки «Показать игрокам» для заготовки');
      assert(!show.disabled, 'кнопка показа заготовки выключена');
      show.click();
      assert.deepStrictEqual(multiCalls, ['setActive:world:m3'],
        `показ вызвал: ${multiCalls.join(', ')}`);

      multiView.render(MULTI_STATE, { role: 'dm', playerId: 'dm' });
      const shown = [...multiHost.querySelectorAll('.map-toolbar button')]
        .find((node) => node.textContent.includes('Показана игрокам'));
      assert(shown && shown.disabled, 'кнопка не отмечает уже показанную карту');
    });
    check('кнопка загрузки добавляет карту в вкладку, а не заменяет текущую', () => {
      const texts = [...multiHost.querySelectorAll('.map-toolbar button, .map-toolbar label')]
        .map((node) => node.textContent);
      assert(texts.some((text) => text.includes('Загрузить ещё карту')), `надписи кнопок: ${texts.join(' | ')}`);
      const remove = [...multiHost.querySelectorAll('.map-toolbar button')]
        .find((node) => node.textContent.includes('Удалить'));
      assert(remove, 'нет кнопки удаления карты');
      remove.click();
      assert(multiCalls.includes('delete:world:m2'), `удаление должно называть карту: ${multiCalls.join(', ')}`);
    });

    check('верхние меню карты сворачиваются, оставляя название карты', () => {
      const toggle = multiHost.querySelector('.map-menus__toggle');
      assert(toggle, 'нет кнопки сворачивания меню');
      const toolbar = multiHost.querySelector('.map-toolbar');
      const menusName = multiHost.querySelector('.map-menus__name');
      assert(!multiHost.classList.contains('is-menus-collapsed'), 'меню свёрнуты ещё до нажатия');
      assert(menusName.textContent.length > 0, 'в полосе не видно названия карты');
      toggle.click();
      assert(multiHost.classList.contains('is-menus-collapsed'), 'меню не свернулись');
      assert(toggle.textContent.includes('Меню'), `надпись после сворачивания: ${toggle.textContent}`);
      toggle.click();
      assert(!multiHost.classList.contains('is-menus-collapsed'), 'меню не развернулись обратно');
      assert(!toolbar.hidden, 'тулбар не вернулся после разворота');
    });

    /* ------------------------- приближение карты (личное для каждого) */

    const zoomHost = document.createElement('div');
    sandbox.appendChild(zoomHost);
    const zoomCalls = [];
    const zoomView = new window.TableUI.MapView(zoomHost, {
      onSetActive: () => zoomCalls.push('setActiveMap'),
      onUpload: () => zoomCalls.push('uploadMap'),
      onMoveToken: () => zoomCalls.push('moveToken'),
      onToggleGrid: () => zoomCalls.push('toggleGrid')
    });
    zoomView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    const zoomSurface = zoomHost.querySelector('.map-surface');
    const zoomValue = zoomHost.querySelector('.map-zoom__value');
    const zoomButton = (label) => [...zoomHost.querySelectorAll('.map-zoom__btn')]
      .find((node) => node.textContent === label);

    check('у карты есть кнопки приближения и сброса', () => {
      assert(zoomValue && zoomValue.textContent === '100%', `подпись: ${zoomValue && zoomValue.textContent}`);
      for (const label of ['−', '+', '⤢']) {
        assert(zoomButton(label), `нет кнопки «${label}»`);
      }
      zoomButton('+').click();
      assert(zoomView.zoom === 1.25, `приближение после «+»: ${zoomView.zoom}`);
      assert(zoomValue.textContent === '125%', `подпись после «+»: ${zoomValue.textContent}`);
      assert(zoomSurface.style.transform.includes('scale(1.25)'), `преобразование: ${zoomSurface.style.transform}`);
      zoomButton('⤢').click();
      assert(zoomView.zoom === 1, `после сброса: ${zoomView.zoom}`);
      assert(zoomValue.textContent === '100%', `подпись после сброса: ${zoomValue.textContent}`);
    });
    check('карта приближается колесом мыши', () => {
      zoomHost.querySelector('.map-stage').dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaY: -120, clientX: 200, clientY: 200
      }));
      assert(zoomView.zoom > 1, `приближение колесом: ${zoomView.zoom}`);
      zoomView.resetView();
    });
    check('приближённую карту можно таскать мышью', () => {
      const stage = zoomHost.querySelector('.map-stage');
      const pointer = (type, x, y) => new PointerEvent(type, {
        bubbles: true, pointerType: 'mouse', button: 0, clientX: x, clientY: y
      });
      stage.dispatchEvent(pointer('pointerdown', 100, 100));
      stage.dispatchEvent(pointer('pointermove', 160, 130));
      stage.dispatchEvent(pointer('pointerup', 160, 130));
      assert(zoomView.pan.x === 60 && zoomView.pan.y === 30, `сдвиг: ${zoomView.pan.x}/${zoomView.pan.y}`);
      assert(zoomSurface.style.transform.includes('translate(60px, 30px)'), `преобразование: ${zoomSurface.style.transform}`);
      zoomView.resetView();
    });
    check('приближение не меняет размер фишек и клетки — они растут вместе с картой', () => {
      const token = zoomHost.querySelector('.token');
      const grid = zoomHost.querySelector('.map-grid');
      assert(zoomSurface.contains(token), 'фишка вне поверхности карты — не увеличится вместе с ней');
      assert(zoomSurface.contains(grid), 'сетка вне поверхности карты');
      zoomView.setZoom(2);
      assert(zoomSurface.style.getPropertyValue('--cell') === '46px',
        `размер клетки изменился: ${zoomSurface.style.getPropertyValue('--cell')}`);
      assert(getComputedStyle(token.querySelector('.token__circle')).width === '46px',
        `размер фишки изменился: ${getComputedStyle(token.querySelector('.token__circle')).width}`);
      zoomView.resetView();
    });
    check('приближение — личное дело каждого: на сервер ничего не уходит', () => {
      zoomView.setZoom(3);
      zoomButton('+').click();
      assert(zoomCalls.length === 0, `приближение отправило на сервер: ${zoomCalls.join(', ')}`);
      zoomView.resetView();
    });

    /* ------------------------------ холст: подложка и ровная сетка */

    const editorHost = document.createElement('div');
    sandbox.appendChild(editorHost);
    const editorNotices = [];
    const editorView = new window.TableUI.MapView(editorHost, {
      resolveUrl: (url) => url,
      onNotice: (message) => editorNotices.push(message),
      onUpload: () => {}
    });
    editorView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    editorView.onTabClick('sketch');
    const editorOpenButton = [...editorHost.querySelectorAll('.map-toolbar button')]
      .find((node) => node.textContent.includes('Нарисовать карту'));
    editorOpenButton.click();
    await wait(120);

    check('на пустой вкладке холст сам берёт подложкой карту со стола', () => {
      const editor = editorView.editor;
      assert(editor && editor.background, 'подложка не подставилась — холст пустой');
      assert(editor.backgroundType === 'world', `подложка: ${editor.backgroundType}`);
      assert(editorNotices.some((text) => text.includes('Подложка взята')), `подсказки: ${editorNotices.join(' | ')}`);
    });
    check('подложку можно выбрать любой картой, файлом или чистым листом', () => {
      const select = editorHost.querySelector('.sketch__background');
      assert(select, 'нет выбора подложки');
      const values = [...select.options].map((option) => option.value);
      for (const value of ['', 'world', 'battle', 'sketch', 'file']) {
        assert(values.includes(value), `нет варианта «${value}»: ${values.join(', ')}`);
      }
      assert(select.value === 'world', `выбран не тот вариант: ${select.value}`);
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      assert(!editorView.editor.background, 'чистый лист не убрал подложку');
      select.value = 'battle';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      assert(editorView.editor.backgroundType === 'battle', 'подложка не переключилась на другую карту');
    });
    check('размер холста кратен клетке — сетка ложится ровно', () => {
      const editor = editorView.editor;
      assert(editor.width % editor.cell === 0, `ширина ${editor.width} не кратна клетке ${editor.cell}`);
      assert(editor.height % editor.cell === 0, `высота ${editor.height} не кратна клетке ${editor.cell}`);
      assert(editorHost.querySelector('.sketch__board').style.width === `${editor.width}px`,
        `размер холста: ${editorHost.querySelector('.sketch__board').style.width}`);
    });
    check('сетка холста тусклее игровой, чтобы её не путали с сеткой стола', () => {
      const editorGrid = getComputedStyle(editorHost.querySelector('.sketch__grid')).backgroundImage;
      assert(editorGrid.includes('85, 105, 135'), `сетка холста не приглушена: ${editorGrid.slice(0, 70)}`);
      const gameGrid = getComputedStyle(gridHost.querySelector('.map-grid')).backgroundImage;
      assert(!gameGrid.includes('85, 105, 135'), 'игровая сетка стала того же цвета, что разметка холста');
    });
    editorView.closeEditor();

    /* ------------------------------------------------ список игроков */

    const playersHost = document.createElement('div');
    sandbox.appendChild(playersHost);
    const dmNotesSent = [];
    const renamesSent = [];
    const playersList = new window.TableUI.PlayersList(playersHost, {
      onSetDmNote: (playerId, note) => dmNotesSent.push({ playerId, note }),
      onRenameSelf: (player) => renamesSent.push(player.playerId),
      resolveUrl: (url) => (url && url.startsWith('/') ? `http://стол${url}` : (url || ''))
    });
    playersList.render(PLAYERS.concat([
      { playerId: 'p-2', name: 'Борис', role: 'player', online: false, hasSheet: true, tokenId: null, avatar: '/files/boris.png', dmNote: 'свой человек гильдии' }
    ]), { role: 'dm', playerId: 'dm' });

    check('своё имя меняется из своей строки, а чужое — нет', () => {
      const rows = [...playersHost.querySelectorAll('.player-row')];
      const ownRow = rows.find((row) => row.textContent.includes('это вы'));
      assert(ownRow, 'в списке нет своей строки');
      const ownButton = [...ownRow.querySelectorAll('button')].find((button) => button.textContent === 'Имя');
      assert(ownButton, 'у своей строки нет кнопки смены имени');
      const borisRow = rows.find((row) => row.textContent.includes('Борис'));
      assert(![...borisRow.querySelectorAll('button')].some((button) => button.textContent === 'Имя'),
        'у чужой строки появилась кнопка смены имени');
      ownButton.click();
      assert.strictEqual(renamesSent.length, 1, `переименовали не себя: ${JSON.stringify(renamesSent)}`);
      assert.strictEqual(renamesSent[0], 'dm');
    });

    check('мастер видит пометку «заметка есть» и подсказку под строкой', () => {
      const rows = [...playersHost.querySelectorAll('.player-row')];
      const boris = rows.find((row) => row.textContent.includes('Борис'));
      const noteLine = boris.querySelector('.player-row__note');
      assert(noteLine, 'под строкой игрока нет заметки');
      assert.strictEqual(noteLine.textContent, 'свой человек гильдии');
      const artem = rows.find((row) => row.textContent.includes('Артём'));
      assert(!artem.querySelector('.player-row__note'), 'у игрока без заметки показана пустая');
      assert(!artem.querySelector('.btn.has-note'), 'пустая заметка помечена как заполненная');
      assert(boris.querySelector('.btn.has-note'), 'заполненная заметка не помечена');
    });

    check('заметка открывается формой с уже написанным текстом', () => {
      const borisRow = [...playersHost.querySelectorAll('.player-row')]
        .find((row) => row.textContent.includes('Борис'));
      const noteButton = [...borisRow.querySelectorAll('button')]
        .find((button) => button.textContent === 'Заметка');
      assert(noteButton, 'в строке игрока нет кнопки заметки');
      noteButton.click();
      const form = playersHost.querySelector('.dm-note');
      assert(form, 'форма заметки не открылась');
      assert.strictEqual(form.querySelector('.dm-note__area').value, 'свой человек гильдии',
        'в форме не та заметка, что в списке');
      // Форма переживает перерисовку списка: несохранённый текст не должен
      // пропасть из-за чужого изменения участников, а обрыв ссылки на форму
      // оставил бы её на экране навсегда.
      playersList.render(PLAYERS.concat([
        { playerId: 'p-2', name: 'Борис', role: 'player', online: false, hasSheet: true, tokenId: null, avatar: null, dmNote: 'свой человек гильдии' }
      ]), { role: 'dm', playerId: 'dm' });
      assert(playersHost.querySelector('.dm-note'), 'форма заметки пропала при перерисовке списка');
      assert.strictEqual(playersHost.querySelector('.dm-note__area').value, 'свой человек гильдии',
        'текст в форме потерялся при перерисовке списка');
      playersHost.querySelector('.dm-note .btn--ghost').click();
      assert(!playersHost.querySelector('.dm-note'), 'кнопка «Закрыть» не убирает форму');
    });

    check('заметка уходит на лету, без кнопки «Сохранить»', () => {
      const borisRow = [...playersHost.querySelectorAll('.player-row')]
        .find((row) => row.textContent.includes('Борис'));
      [...borisRow.querySelectorAll('button')]
        .find((button) => button.textContent === 'Заметка').click();
      const area = playersHost.querySelector('.dm-note__area');
      area.value = 'свой человек, но брать на испытание';
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Отправка отложена: мастер пишет быстро, а ждать сервер на каждый
    // ввод незачем.
    await wait(600);
    check('правка заметки уехала на сервер', () => {
      assert.strictEqual(dmNotesSent.length, 1, `отправлено ${dmNotesSent.length} раз`);
      assert.strictEqual(dmNotesSent[0].playerId, 'p-2');
      assert(dmNotesSent[0].note.includes('испытание'), `отправлено: ${dmNotesSent[0].note}`);
    });

    check('игроку кнопки заметки нет', () => {
      playersList.render(PLAYERS.concat([
        { playerId: 'p-2', name: 'Борис', role: 'player', online: false, hasSheet: true, tokenId: null, avatar: null, dmNote: '' }
      ]), { role: 'player', playerId: 'p-1' });
      const borisRow = [...playersHost.querySelectorAll('.player-row')]
        .find((row) => row.textContent.includes('Борис'));
      const buttons = [...borisRow.querySelectorAll('button')].map((button) => button.textContent);
      assert(!buttons.includes('Заметка'), `игроку видна заметка: ${buttons.join(', ')}`);
      assert(!borisRow.querySelector('.player-row__note'), 'игрок видит подсказку о чужой заметке');
      playersList.render(PLAYERS.concat([
        { playerId: 'p-2', name: 'Борис', role: 'player', online: false, hasSheet: true, tokenId: null, avatar: '/files/boris.png', dmNote: 'свой человек гильдии' }
      ]), { role: 'dm', playerId: 'dm' });
    });

    check('список участников: имя, роль и статус онлайн/офлайн', () => {
      assert(playersHost.querySelectorAll('.player-row').length === 3, 'строк в списке');
      assert(playersHost.querySelectorAll('.badge--dm').length === 1, 'бейдж ДМ');
      assert(playersHost.querySelectorAll('.dot--on').length === 2, 'онлайн-метки');
      assert(playersHost.querySelectorAll('.dot--off').length === 1, 'офлайн-метка');
      assert(playersHost.querySelectorAll('.badge--me').length === 1, 'метка «это вы»');
    });
    check('у ДМ есть кнопка «Открыть лист» напротив каждого игрока', () => {
      const buttons = [...playersHost.querySelectorAll('.player-row button')]
        .filter((button) => button.textContent === 'Открыть лист');
      assert(buttons.length === 2, `кнопок «Открыть лист»: ${buttons.length}`);
    });
    check('у ДМ есть кнопка вывода фишки только у игроков без фишки', () => {
      const buttons = [...playersHost.querySelectorAll('.player-row button')]
        .filter((button) => button.textContent === 'Вывести');
      assert(buttons.length === 1, `кнопок «Вывести»: ${buttons.length}`);
      // У Артёма фишка уже есть — вторую ему не выводят, кнопки быть не должно.
      const withToken = [...playersHost.querySelectorAll('.player-row')]
        .find((row) => row.textContent.includes('Артём'));
      assert(!withToken.textContent.includes('Вывести'), 'кнопка есть у игрока с фишкой');
      // И у мастера такой кнопки нет вовсе: фишка из листа ему не полагается.
      const dmRow = [...playersHost.querySelectorAll('.player-row')]
        .find((row) => row.textContent.includes('Мастер'));
      assert(!dmRow.textContent.includes('Вывести'), 'у мастера есть кнопка вывода фишки');
    });
    check('в списке участников портреты, а у кого портрета нет — буква имени', () => {
      const rows = [...playersHost.querySelectorAll('.player-row')];
      const dmAvatar = rows.find((row) => row.textContent.includes('Мастер')).querySelector('.player-row__avatar');
      const dmImg = dmAvatar.querySelector('img');
      assert(dmImg, 'у мастера нет картинки');
      // Путь из поставки resolveUrl не трогает — иначе вышло бы http://столavatar-dm.png.
      assert.strictEqual(dmImg.getAttribute('src'), 'avatar-dm.png');

      const borisAvatar = rows.find((row) => row.textContent.includes('Борис')).querySelector('.player-row__avatar');
      const borisImg = borisAvatar.querySelector('img');
      assert(borisImg, 'у Бориса нет картинки');
      assert.strictEqual(borisImg.getAttribute('src'), 'http://стол/files/boris.png');

      const arthurAvatar = rows.find((row) => row.textContent.includes('Артём')).querySelector('.player-row__avatar');
      assert(!arthurAvatar.querySelector('img'), 'у Артёма картинка без аватара');
      assert.strictEqual(arthurAvatar.textContent, 'А', `буква-заглушка: ${arthurAvatar.textContent}`);
    });
    playersList.render(PLAYERS, { role: 'player', playerId: 'p-1' });
    check('у игрока нет кнопок «Открыть лист» и «Вывести»', () => {
      assert(!playersHost.textContent.includes('Открыть лист'), 'игрок видит кнопку просмотра листов');
      assert(!playersHost.textContent.includes('Вывести'), 'игрок видит кнопку вывода фишки');
    });

    /* ------------------------------------------------ чат и кубики */

    const chatHost = document.createElement('div');
    sandbox.appendChild(chatHost);
    let sentText = null;
    const chatPanel = new window.TableUI.ChatPanel(chatHost, {
      onSend: (text) => { sentText = text; },
      resolveUrl: (url) => (url && url.startsWith('/') ? `http://стол${url}` : (url || ''))
    });
    chatPanel.renderAll([
      { from: 'Артём', role: 'player', text: 'Привет, стол!', time: new Date().toISOString() },
      { from: 'Мира', playerId: 'p-9', role: 'player', avatar: '/files/mira.png', text: 'бросил d20: 17', isRoll: true, time: new Date().toISOString() }
    ]);
    check('чат: имя автора, время и текст сообщения', () => {
      assert(chatHost.querySelector('.chat__author').textContent === 'Артём', 'автор');
      assert(chatHost.querySelector('.chat__time').textContent.length >= 4, 'время');
      assert(chatHost.querySelector('.chat__text').textContent === 'Привет, стол!', 'текст');
    });

    /* --------------------------------------------------------- поиск по чату */

    const chatHistory = [
      { from: 'Артём', role: 'player', text: 'Привет, стол!', time: '2026-01-01T10:00:00Z' },
      { from: 'Мира', playerId: 'p-9', role: 'player', avatar: '/files/mira.png', text: 'бросил d20: 17', isRoll: true, time: '2026-01-01T10:01:00Z' },
      { from: 'Мастер', role: 'dm', text: 'Ловушка на двери: проверка Ловкости', time: '2026-01-01T10:02:00Z' },
      { from: 'Борис', role: 'player', text: 'Пробую тихо', time: '2026-01-01T10:03:00Z' }
    ];
    let chatQuerySeen = null;
    const searchPanel = new window.TableUI.ChatPanel(document.createElement('div'), {
      onQuery: (value) => { chatQuerySeen = value; }
    });
    sandbox.appendChild(searchPanel.root);
    searchPanel.renderAll(chatHistory);

    check('поиск находит сообщения и по тексту, и по имени автора', () => {
      searchPanel.setQuery('ловушка');
      let hits = [...searchPanel.root.querySelectorAll('.chat__msg.is-hit')];
      assert.strictEqual(hits.length, 1, `найдено по слову: ${hits.length}`);
      assert(hits[0].textContent.includes('Мастер'), 'нашлось не то сообщение');
      // Имя автора тоже ищется: за столом начинают с «что говорил Мастер».
      searchPanel.setQuery('мастер');
      hits = [...searchPanel.root.querySelectorAll('.chat__msg.is-hit')];
      assert.strictEqual(hits.length, 1, `найдено по имени: ${hits.length}`);
      assert.strictEqual(chatQuerySeen, 'мастер', 'контроллер не узнал о запросе');
    });

    check('поиск не прячет ленту, а приглушает несовпавшие строки', () => {
      searchPanel.setQuery('ловушка');
      const misses = [...searchPanel.root.querySelectorAll('.chat__msg.is-miss')];
      assert.strictEqual(misses.length, 3, `приглушено строк: ${misses.length}`);
      // Спрятать остальные можно было бы, но правило ищут в контексте разговора.
      assert.strictEqual(searchPanel.root.querySelectorAll('.chat__msg').length, 4, 'лента уменьшилась');
      const counter = searchPanel.root.querySelector('.chat__search-count');
      assert(counter.textContent.includes('1'), `счётчик: ${counter.textContent}`);
    });

    check('поиск не зависит от регистра и лишних пробелов', () => {
      searchPanel.setQuery('  ЛОВУШКА ');
      assert.strictEqual(searchPanel.root.querySelectorAll('.chat__msg.is-hit').length, 1, 'регистр помешал');
      searchPanel.setQuery('');
      assert.strictEqual(searchPanel.root.querySelectorAll('.chat__msg.is-hit').length, 0, 'подсветка осталась');
      assert.strictEqual(searchPanel.root.querySelectorAll('.chat__msg.is-miss').length, 0, 'лента осталась приглушённой');
      assert(searchPanel.root.querySelector('.chat__search-count').textContent === '', 'счётчик не очищен');
    });

    check('снимок стола восстанавливает поиск, а Escape его сбрасывает', () => {
      searchPanel.renderAll(chatHistory, 'тихо');
      const input = searchPanel.root.querySelector('.chat__search-input');
      assert.strictEqual(input.value, 'тихо', 'поле поиска не восстановило запрос');
      assert.strictEqual(searchPanel.root.querySelectorAll('.chat__msg.is-hit').length, 1, 'подсветка не восстановилась');
      input.value = 'ловушка';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert.strictEqual(input.value, '', 'Escape не очистил поле');
      assert.strictEqual(searchPanel.root.querySelectorAll('.chat__msg.is-hit').length, 0, 'подсветка не снята');
    });

    check('новое сообщение во время поиска попадает под тот же запрос', () => {
      searchPanel.renderAll(chatHistory, 'ловушка');
      searchPanel.append({
        from: 'Мастер', role: 'dm', text: 'Ещё одна ловушка у колодца', time: '2026-01-01T10:04:00Z'
      });
      assert.strictEqual(searchPanel.root.querySelectorAll('.chat__msg.is-hit').length, 2,
        'новое сообщение не попало под запрос');
    });
    check('аватар стоит у броска и не стоит у обычной реплики', () => {
      const rows = [...chatHost.querySelectorAll('.chat__msg')];
      assert(rows.length === 2, `сообщений в чате: ${rows.length}`);
      const plain = rows.find((row) => row.textContent.includes('Привет'));
      const roll = rows.find((row) => row.textContent.includes('бросил d20'));
      assert(!plain.querySelector('.chat__avatar'), 'у обычной реплики появился аватар');
      const avatar = roll.querySelector('.chat__avatar');
      assert(avatar, 'у броска нет аватара');
      assert.strictEqual(avatar.querySelector('img').getAttribute('src'), 'http://стол/files/mira.png');
      // Портрет должен стоять перед именем, а не после времени.
      const head = roll.querySelector('.chat__head');
      assert(head.firstElementChild.classList.contains('chat__avatar'), 'аватар не в начале шапки');
    });
    chatHost.querySelector('.chat__form input').value = 'Проверка связи';
    chatHost.querySelector('.chat__form').requestSubmit();
    check('чат отправляет введённый текст', () => {
      assert(sentText === 'Проверка связи', `отправлено: ${sentText}`);
      assert(chatHost.querySelector('.chat__form input').value === '', 'поле не очищено');
    });

    const imageHost = document.createElement('div');
    sandbox.appendChild(imageHost);
    const imagePanel = new window.TableUI.ChatPanel(imageHost, {
      canAttach: () => true,
      resolveUrl: (url) => (url && url.startsWith('/') ? `http://стол${url}` : (url || ''))
    });
    imagePanel.renderAll([{
      from: 'Мастер',
      role: 'dm',
      text: 'Письмо от барона',
      image: '/files/handout.png',
      time: '2026-01-01T10:05:00Z'
    }]);
    check('картинка-хендаут показывается в чате и открывается целиком', () => {
      const button = imageHost.querySelector('.chat__image-button');
      assert(button, 'нет кнопки-картинки');
      const thumb = button.querySelector('img');
      assert.strictEqual(thumb.getAttribute('src'), 'http://стол/files/handout.png');
      assert(!imageHost.querySelector('.chat__attach').hidden, 'у мастера нет кнопки прикрепления');
      button.click();
      const overlay = document.querySelector('.chat-lightbox');
      assert(overlay, 'лайтбокс не открылся');
      assert.strictEqual(overlay.querySelector('img').getAttribute('src'), 'http://стол/files/handout.png');
      overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert(!document.querySelector('.chat-lightbox'), 'Escape не закрыл лайтбокс');
    });

    const playerImageHost = document.createElement('div');
    const playerImagePanel = new window.TableUI.ChatPanel(playerImageHost, {
      canAttach: () => false
    });
    playerImagePanel.renderAll([]);
    check('у игрока нет кнопки прикрепления картинки', () => {
      assert(playerImageHost.querySelector('.chat__attach').hidden, 'кнопка видна игроку');
    });

    const diceHost = document.createElement('div');
    sandbox.appendChild(diceHost);
    const sentRolls = [];
    let dmMayRollHidden = true;
    const dicePanel = new window.TableUI.DicePanel(diceHost, {
      onRoll: (formula, options) => { sentRolls.push({ formula, options }); },
      canRollHidden: () => dmMayRollHidden
    });
    dicePanel.renderAll([]);
    const quickButtons = [...diceHost.querySelectorAll('.dice__quick-btn')];
    check('панель кубиков предлагает только настоящие кости', () => {
      const labels = quickButtons.map((button) => button.textContent);
      const expected = window.DnD5e.DICE_SIDES.map((sides) => `d${sides}`);
      // Сравниваем строками: в этом стенде assert знает только strictEqual,
      // а сравнение массивов через JSON не зависит от реализации.
      assert.strictEqual(labels.join(','), expected.join(','), 'список костей в панели');
      // Костей на три, пять или семь граней в игре нет: если такая появится,
      // её можно будет выбрать, но сервер бросок всё равно отклонит.
      assert(!labels.some((label) => label === 'd3' || label === 'd7' || label === 'd1'),
        `в списке есть несуществующие кости: ${labels.join(', ')}`);
    });
    check('клик по быстрой кости бросает её сразу', () => {
      const d8 = quickButtons.find((button) => button.textContent === 'd8');
      d8.click();
      assert(sentRolls.length === 1, `отправлено бросков: ${sentRolls.length}`);
      assert.strictEqual(sentRolls[0].formula, 'd8', 'отправлена не та кость');
    });
    check('на время броска кость крутится, а не просто ждёт', () => {
      const last = diceHost.querySelector('.dice__last');
      assert(last && last.classList.contains('is-tumbling'), 'плашка не в состоянии броска');
      assert(diceHost.querySelector('.dice__tumbler'), 'нет крутящейся кости');
      assert(last.textContent.includes('d8'), `в плашке нет формулы: ${last.textContent}`);
      // Тест не ждёт сервер: закрываем бросок вручную, чтобы таймеры не жили
      // дольше самого теста.
      dicePanel.finishRolling();
    });
    const formulaInput = diceHost.querySelector('.dice__formula');
    check('панель броска принимает формулу, а не только одну кость', () => {
      assert(formulaInput, 'нет поля формулы');
      assert.strictEqual(formulaInput.placeholder, '2d6+3', 'подсказка не показывает пример');
    });
    formulaInput.value = '4d6dl1 + 2';
    diceHost.querySelector('.dice__controls .btn--accent').click();
    check('кнопка «Бросить» отправляет разобранную формулу', () => {
      const last = sentRolls[sentRolls.length - 1];
      assert.strictEqual(last.formula, '4d6dl1+2', `отправлено: ${last.formula}`);
      assert.strictEqual(formulaInput.value, '', 'поле не очистилось после броска');
    });
    formulaInput.value = '2d20kh1';
    formulaInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    check('Enter в поле отправляет бросок', () => {
      assert.strictEqual(sentRolls[sentRolls.length - 1].formula, '2d20kh1');
    });
    check('переброс повторяет последний бросок', () => {
      const reroll = diceHost.querySelector('.dice__reroll');
      assert(!reroll.hidden, 'кнопка переброса не появилась после броска');
      const before = sentRolls.length;
      reroll.click();
      assert.strictEqual(sentRolls.length, before + 1, 'переброс ничего не отправил');
      assert.strictEqual(sentRolls[sentRolls.length - 1].formula, '2d20kh1', 'переброшена не та формула');
    });
    check('негодная формула не отправляется и объясняется под полем', () => {
      sentRolls.length = 0;
      formulaInput.value = 'привет';
      diceHost.querySelector('.dice__controls .btn--accent').click();
      assert.strictEqual(sentRolls.length, 0, 'негодная формула ушла на сервер');
      const hint = diceHost.querySelector('.dice__hint');
      assert(hint.classList.contains('is-error'), 'подсказка не помечена как ошибка');
      assert(hint.textContent.includes('Не понял'), `подсказка: ${hint.textContent}`);
    });
    check('мастеру доступен тайный бросок, игроку нет', () => {
      assert(!diceHost.querySelector('.dice__hidden').hidden, 'у мастера нет поля «тайно»');
      dmMayRollHidden = false;
      dicePanel.renderAll([]);
      assert(diceHost.querySelector('.dice__hidden').hidden, 'игроку показано поле «тайно»');
    });
    check('тайный бросок помечается в отправке', () => {
      dmMayRollHidden = true;
      dicePanel.renderAll([]);
      diceHost.querySelector('.dice__hidden input').checked = true;
      quickButtons.find((button) => button.textContent === 'd20').click();
      const last = sentRolls[sentRolls.length - 1];
      assert.strictEqual(last.formula, 'd20');
      assert.strictEqual(last.options.hidden, true, 'бросок ушёл не тайным');
      diceHost.querySelector('.dice__hidden input').checked = false;
      // Тест не ждёт ответа сервера: закрываем начатую анимацию, иначе
      // последующие проверки увидят крутящуюся кость вместо результата.
      dicePanel.finishRolling();
    });
    check('тайный бросок показывается без числа тому, кто его не видел', () => {
      // Глазами игрока: флаг стоит, числа нет.
      dicePanel.append({
        playerName: 'Мастер',
        formula: 'd20',
        count: 1,
        sides: 20,
        modifier: 0,
        result: null,
        hidden: true,
        time: new Date().toISOString()
      });
      const row = diceHost.querySelector('.dice__row:last-child');
      assert(row.textContent.includes('Мастер') && row.textContent.includes('d20'), `строка: ${row.textContent}`);
      assert(!/\d/.test(row.querySelector('.dice__row-result').textContent), 'число тайного броска показано');
      assert.strictEqual(diceHost.querySelector('.dice__last-value').textContent, '?', 'крупный результат не скрыт');
    });
    check('мастер видит число собственного тайного броска', () => {
      // Те же глаза мастера: флаг тот же, но число сервер прислал. Раньше
      // вопросительный знак ставился по флагу, и мастер не видел свой бросок.
      dicePanel.append({
        playerName: 'Мастер',
        formula: '2d6+3',
        count: 2,
        sides: 6,
        values: [4, 2],
        keptValues: [4, 2],
        droppedValues: [],
        modifier: 3,
        result: 9,
        hidden: true,
        time: new Date().toISOString()
      });
      const row = diceHost.querySelector('.dice__row:last-child');
      assert(row.querySelector('.dice__row-result').textContent === '9', `строка: ${row.textContent}`);
      assert.strictEqual(diceHost.querySelector('.dice__last-value').textContent, '9', 'крупный результат скрыт от мастера');
      assert(!row.querySelector('.dice__row-result').classList.contains('is-secret'), 'число показано серым');
    });
    dicePanel.append({
      playerName: 'Артём', formula: '2d6+3', count: 2, sides: 6,
      values: [4, 3], keptValues: [4, 3], droppedValues: [], modifier: 3, result: 10,
      hidden: false, time: new Date().toISOString()
    });
    check('бросок показывается как «имя бросил формулу: результат»', () => {
      const row = diceHost.querySelector('.dice__row:last-child');
      assert(row.textContent.includes('Артём') && row.textContent.includes('2d6+3') && row.textContent.includes('10'),
        `строка истории: ${row.textContent}`);
      assert(diceHost.querySelector('.dice__last').textContent.includes('Артём бросил 2d6+3:'), 'крупный результат');
    });
    dicePanel.append({ playerName: 'Артём', sides: 12, result: 7, time: new Date().toISOString() });
    check('старый бросок без формулы читается как одна кость', () => {
      const row = diceHost.querySelector('.dice__row:last-child');
      assert(row.textContent.includes('d12') && row.textContent.includes('7'),
        `строка истории: ${row.textContent}`);
      assert(diceHost.querySelector('.dice__last').textContent.includes('Артём бросил d12'), 'крупный результат');
    });

    /* ------------------------------------------------ панель порядка боя */

    const initiativeHost = document.createElement('div');
    sandbox.appendChild(initiativeHost);
    const initCalls = [];
    const initiativePanel = new window.TableUI.InitiativePanel(initiativeHost, {
      onAdd: (entry) => initCalls.push(['add', entry]),
      onAddPlayers: () => initCalls.push(['addPlayers']),
      onRemove: (id) => initCalls.push(['remove', id]),
      onRoll: () => initCalls.push(['roll']),
      onRollOne: (id) => initCalls.push(['rollOne', id]),
      onSetTurn: (id) => initCalls.push(['turn', id]),
      onStep: (dir) => initCalls.push(['step', dir]),
      onReset: () => initCalls.push(['reset'])
    });
    const initiativePlayers = [
      { playerId: 'p-1', name: 'Артём', role: 'player', online: true },
      { playerId: 'p-2', name: 'Борис', role: 'player', online: true }
    ];
    const initiativeTokens = [{ id: 't-1', name: 'Гоблин' }];
    // Инициатива Артёма считается из его листа: Dex 16 -> +3, прочий бонус 0.
    const initiativeSheets = { 'p-1': { abilities: { dex: 16 }, initiativeMisc: 0, level: 5 } };
    const emptyInitiative = { entries: [], turnId: null, round: 1 };
    initiativePanel.render(emptyInitiative, initiativePlayers, initiativeTokens, { role: 'dm', playerId: 'dm' }, initiativeSheets);

    check('пустой порядок боя объясняет, что делать', () => {
      assert(initiativeHost.textContent.includes('Список пуст'), 'нет подсказки о пустом списке');
      assert(initiativeHost.querySelectorAll('.initiative__row').length === 0);
    });

    check('в списке выбора есть игроки, фишки и своё имя', () => {
      const values = [...initiativeHost.querySelectorAll('.initiative__form .select option')]
        .map((option) => option.value);
      assert(values.includes('player:p-1'), `нет игрока: ${values.join(', ')}`);
      assert(values.includes('token:t-1'), `нет фишки: ${values.join(', ')}`);
      assert(values.includes('custom'), 'нет варианта «Другое имя»');
    });

    const initSelect = initiativeHost.querySelector('.initiative__form .select');
    initSelect.value = 'player:p-1';
    initSelect.dispatchEvent(new Event('change'));
    check('модификатор игрока подставляется из его листа', () => {
      assert.strictEqual(initiativeHost.querySelector('.initiative__modifier').value, '3');
    });
    initiativeHost.querySelector('.initiative__form').requestSubmit();
    check('игрок уходит в бой с модификатором из листа', () => {
      const call = initCalls.find((item) => item[0] === 'add');
      assert(call, 'добавление не отправлено');
      assert.strictEqual(call[1].kind, 'player');
      assert.strictEqual(call[1].refId, 'p-1');
      assert.strictEqual(call[1].name, 'Артём');
      assert.strictEqual(call[1].modifier, 3);
    });

    check('уже добавленный игрок исчезает из списка выбора', () => {
      const taken = { entries: [{ id: 'i-1', kind: 'player', refId: 'p-1', name: 'Артём', modifier: 3, total: 18 }], turnId: null, round: 1 };
      initiativePanel.render(taken, initiativePlayers, initiativeTokens, { role: 'dm', playerId: 'dm' }, initiativeSheets);
      const values = [...initiativeHost.querySelectorAll('.initiative__form .select option')]
        .map((option) => option.value);
      assert(!values.includes('player:p-1'), 'добавленный игрок снова в списке выбора');
      assert(values.includes('player:p-2'), 'второй игрок пропал из списка');
    });

    check('порядок боя показывает участников, итоги и чей ход', () => {
      const state = {
        entries: [
          { id: 'i-1', kind: 'player', refId: 'p-1', name: 'Артём', modifier: 3, total: 18 },
          { id: 'i-2', kind: 'token', refId: 't-1', name: 'Гоблин', modifier: 2, total: 9 },
          { id: 'i-3', kind: 'other', refId: '', name: 'Страж', modifier: 0, total: null }
        ],
        turnId: 'i-1',
        round: 2
      };
      initiativePanel.render(state, initiativePlayers, initiativeTokens, { role: 'dm', playerId: 'dm' }, initiativeSheets);
      const rows = [...initiativeHost.querySelectorAll('.initiative__row')];
      assert(rows.length === 3, `строк: ${rows.length}`);
      assert(rows[0].classList.contains('is-current'), 'текущий ход не выделен');
      assert(rows[1].classList.contains('is-current') === false, 'выделено несколько строк');
      assert(rows[0].textContent.includes('Артём') && rows[0].textContent.includes('18'), `строка: ${rows[0].textContent}`);
      assert(rows[1].textContent.includes('+2'), `модификатор: ${rows[1].textContent}`);
      assert(rows[2].textContent.includes('—'), 'неброшенному участнику показан итог');
      assert(initiativeHost.textContent.includes('Раунд 2'), 'раунд не показан');
      assert(initiativeHost.textContent.includes('Ходит: Артём'), 'чей ход не показан');
    });

    check('клик по строке объявляет ход, кнопки строки убирают и перебрасывают', () => {
      initiativeHost.querySelectorAll('.initiative__row')[1].click();
      const turn = initCalls.find((item) => item[0] === 'turn');
      assert(turn && turn[1] === 'i-2', `ход отправлен не туда: ${JSON.stringify(turn)}`);
      const row = initiativeHost.querySelectorAll('.initiative__row')[1];
      const buttons = [...row.querySelectorAll('.initiative__row-actions .btn')];
      assert.strictEqual(buttons.length, 2, `кнопок в строке: ${buttons.length}`);
      buttons[0].click();
      assert(initCalls.some((item) => item[0] === 'rollOne' && item[1] === 'i-2'), 'переброс не отправлен');
      buttons[1].click();
      assert(initCalls.some((item) => item[0] === 'remove' && item[1] === 'i-2'), 'удаление не отправлено');
      // Клик по кнопке не должен объявлять ход той же строки.
      assert(!initCalls.filter((item) => item[0] === 'turn').some((item) => item[1] === 'i-2' && item[2]),
        'клик по кнопке объявил ход');
    });

    check('игрок видит тот же порядок, но без кнопок мастера', () => {
      const state = {
        entries: [{ id: 'i-1', kind: 'player', refId: 'p-1', name: 'Артём', modifier: 3, total: 18 }],
        turnId: 'i-1',
        round: 1
      };
      initiativePanel.render(state, initiativePlayers, initiativeTokens, { role: 'player', playerId: 'p-2' }, {});
      assert(initiativeHost.querySelector('.initiative__row').classList.contains('is-current'), 'игрок не видит чей ход');
      assert.strictEqual(initiativeHost.querySelectorAll('.initiative__row-actions').length, 0, 'у игрока есть кнопки мастера');
      assert(initiativeHost.querySelector('.initiative__form').hidden, 'у игрока видна форма добавления');
      assert(initiativeHost.querySelector('.initiative__actions .btn--accent').hidden, 'игроку доступен бросок');
      assert(initiativeHost.querySelector('.initiative__stepper .btn--accent').hidden, 'игрок может листать ход');
    });

    check('мастер добавляет всех игроков и чистит бой', () => {
      initiativePanel.render(emptyInitiative, initiativePlayers, initiativeTokens, { role: 'dm', playerId: 'dm' }, initiativeSheets);
      initiativeHost.querySelector('.initiative__actions .btn').click();
      assert(initCalls.some((item) => item[0] === 'addPlayers'), 'добавление игроков не отправлено');
      initiativeHost.querySelector('.initiative__actions .btn--ghost').click();
      assert(initCalls.some((item) => item[0] === 'reset'), 'очистка боя не отправлена');
      initiativeHost.querySelector('.initiative__stepper .btn--accent').click();
      assert(initCalls.some((item) => item[0] === 'step' && item[1] === 1), 'переход вперёд не отправлен');
    });

    check('своё имя добавляется как отдельное существо', () => {
      initiativePanel.render(emptyInitiative, initiativePlayers, initiativeTokens, { role: 'dm', playerId: 'dm' }, initiativeSheets);
      const select = initiativeHost.querySelector('.initiative__form .select');
      select.value = 'custom';
      select.dispatchEvent(new Event('change'));
      const customInput = initiativeHost.querySelectorAll('.initiative__form .input')[0];
      assert(!customInput.hidden, 'поле своего имени не показалось');
      customInput.value = 'Солдат-нежить';
      initiativeHost.querySelector('.initiative__modifier').value = '4';
      initiativeHost.querySelector('.initiative__form').requestSubmit();
      const call = initCalls.filter((item) => item[0] === 'add').pop();
      assert.strictEqual(call[1].kind, 'other');
      assert.strictEqual(call[1].name, 'Солдат-нежить');
      assert.strictEqual(call[1].modifier, 4);
    });

    /* ------------------------------------------------ панель фишек */

    const tokensHost = document.createElement('div');
    sandbox.appendChild(tokensHost);
    let createdTokenName = null;
    let createdTokenHp = 'не вызвано';
    let createdTokenSize = null;
    let spawnedFrom = null;
    const hpChanges = [];
    const sizeChanges = [];
    const tokenPanel = new window.TableUI.TokenPanel(tokensHost, {
      onCreate: (name, maxHp, size) => {
        createdTokenName = name;
        createdTokenHp = maxHp;
        createdTokenSize = size;
      },
      onDeleteToken: () => {},
      onSetTokenHp: (tokenId, hp) => hpChanges.push({ tokenId, hp }),
      onSetTokenSize: (tokenId, size) => sizeChanges.push({ tokenId, size }),
      onSpawnFromSheet: (playerId) => { spawnedFrom = playerId; }
    });
    tokenPanel.render(TOKENS, PLAYERS, { role: 'dm', playerId: 'dm' });
    check('панель фишек ДМ: форма создания и список всех фишек', () => {
      assert(tokensHost.querySelector('.token-form'), 'нет формы создания');
      assert(tokensHost.textContent.includes('Гоблин') && tokensHost.textContent.includes('Мира'), 'нет списка фишек');
      assert(tokensHost.querySelectorAll('.token-row button').length >= 1, 'нет кнопки удаления');
    });

    check('размер фишки выбирается при создании и меняется в списке', () => {
      const form = tokensHost.querySelector('.token-form');
      form.querySelector('input').value = 'Огр';
      form.querySelector('.token-form__size').value = '3';
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      assert.strictEqual(createdTokenName, 'Огр');
      assert.strictEqual(createdTokenSize, 3, `при создании передан размер ${createdTokenSize}`);

      const row = tokensHost.querySelector('.token-row[data-token-id="t1"]');
      const select = row && row.querySelector('.token-row__size');
      assert(select, 'в строке фишки нет выбора размера');
      select.value = '2';
      select.dispatchEvent(new Event('change'));
      assert.deepStrictEqual(sizeChanges[0], { tokenId: 't1', size: 2 });
    });

    /* ------------------------------------------------------- прочность */

    const hpTokens = TOKENS.concat([
      { id: 't4', name: 'Гоблин-вепрь', mapType: 'world', x: 0.4, y: 0.4, imageUrl: null, assignedPlayerId: null, color: '#6fb45f', maxHp: 12, hp: 5 },
      { id: 't5', name: 'Монета', mapType: 'world', x: 0.6, y: 0.6, imageUrl: null, assignedPlayerId: null, color: '#c96f4a', maxHp: null, hp: null }
    ]);
    tokenPanel.render(hpTokens, PLAYERS, { role: 'dm', playerId: 'dm' });
    check('у фишки с прочностью есть полоса, число и кнопки урона', () => {
      const box = tokensHost.querySelector('.token-hp');
      assert(box, 'нет блока прочности');
      assert.strictEqual(box.querySelector('.token-hp__value').value, '5', `в поле: ${box.querySelector('.token-hp__value').value}`);
      // Половина или меньше — ранен, полоса должна это показывать.
      assert(box.classList.contains('is-low'), 'половина прочности не отмечена как ранение');
      const fillWidth = box.querySelector('.token-hp__fill').style.width;
      assert(fillWidth === '42%' || fillWidth === '41%', `полоса заполнена на ${fillWidth} вместо 42%`);
      assert.strictEqual(box.querySelectorAll('.token-hp__btn').length, 4, 'кнопок урона не четыре');
    });

    check('фишка без прочности остаётся меткой без полосы', () => {
      const rows = [...tokensHost.querySelectorAll('.token-row')];
      const coin = rows.find((row) => row.textContent.includes('Монета'));
      assert(!coin.querySelector('.token-hp'), 'у фишки без прочности появилась полоса');
    });

    check('кнопки урона и лечения отправляют новое значение', () => {
      const box = tokensHost.querySelector('.token-hp');
      const buttons = [...box.querySelectorAll('.token-hp__btn')];
      buttons[0].click();
      buttons[3].click();
      assert.strictEqual(hpChanges.length, 2, `отправлено ${hpChanges.length} вместо двух`);
      // Кнопки идут по порядку -5, -1, +1, +5 от текущих пяти.
      assert.strictEqual(hpChanges[0].tokenId, 't4');
      assert.strictEqual(hpChanges[0].hp, 0);
      assert.strictEqual(hpChanges[1].tokenId, 't4');
      assert.strictEqual(hpChanges[1].hp, 10);
    });

    check('точное значение прочности вводится руками', () => {
      const readout = tokensHost.querySelector('.token-hp__value');
      readout.value = '9';
      readout.dispatchEvent(new Event('change'));
      const last = hpChanges[hpChanges.length - 1];
      assert.strictEqual(last.tokenId, 't4');
      assert.strictEqual(last.hp, 9);
    });

    check('пустое поле прочности не уходит на сервер как ноль', () => {
      const readout = tokensHost.querySelector('.token-hp__value');
      const before = hpChanges.length;
      readout.value = '';
      readout.dispatchEvent(new Event('change'));
      assert.strictEqual(hpChanges.length, before, 'пустое значение ушло на сервер');
      assert.strictEqual(readout.value, '5', 'поле не вернуло прежнее число');
      readout.value = 'не число';
      readout.dispatchEvent(new Event('change'));
      assert.strictEqual(hpChanges.length, before, 'мусор в поле ушёл на сервер');
    });

    check('форма создания берёт прочность из поля', () => {
      const form = tokensHost.querySelector('.token-form');
      const nameInput = form.querySelector('input[type="text"]');
      const hpField = form.querySelector('.token-form__hp');
      assert(hpField, 'нет поля прочности в форме');
      nameInput.value = 'Гоблин';
      hpField.value = '15';
      form.requestSubmit();
      assert.strictEqual(createdTokenName, 'Гоблин', `имя: ${createdTokenName}`);
      assert.strictEqual(createdTokenHp, 15, 'прочность не взята из формы');
      // Пустое поле — фишка без здоровья, а не ноль.
      hpField.value = '';
      nameInput.value = 'Монета';
      form.requestSubmit();
      assert.strictEqual(createdTokenHp, null, `прочность без ввода: ${createdTokenHp}`);
    });

    check('игроку не показывают управление прочностью чужих фишек', () => {
      tokenPanel.render(hpTokens, PLAYERS, { role: 'player', playerId: 'p-1' });
      assert.strictEqual(tokensHost.querySelectorAll('.token-hp').length, 0, 'игрок видит полосы прочности монстров');
    });

    /* ------------------------------------------------------- состояния */

    const conditionChanges = [];
    const condTokens = TOKENS.concat([
      { id: 't6', name: 'Огр', mapType: 'world', x: 0.5, y: 0.5, imageUrl: null, assignedPlayerId: null, color: '#8fb04a', conditions: ['prone', 'poisoned'] },
      { id: 't7', name: 'Монета', mapType: 'world', x: 0.3, y: 0.3, imageUrl: null, assignedPlayerId: null, color: '#c9a34a', conditions: [] }
    ]);
    const condPanel = new window.TableUI.TokenPanel(document.createElement('div'), {
      onSetTokenConditions: (tokenId, conditions, conditionDurations) => (
        conditionChanges.push({ tokenId, conditions, conditionDurations })
      )
    });
    sandbox.appendChild(condPanel.root);
    condPanel.render(condTokens, PLAYERS, { role: 'dm', playerId: 'dm' });

    check('включённые состояния показаны именами, а не значками', () => {
      const rows = [...condPanel.root.querySelectorAll('.token-row')];
      const ogre = rows.find((row) => row.textContent.includes('Огр'));
      const head = ogre.querySelector('.token-conditions__head');
      // Список должен читаться без подсказки: три буквы ничего не говорят.
      assert(head.textContent === 'Сбит с ног, Отравлен', `подпись состояний: ${head.textContent}`);
      const coin = rows.find((row) => row.textContent.includes('Монета'));
      assert(coin.querySelector('.token-conditions__head').classList.contains('is-empty'),
        'у фишки без состояний подпись выглядит как заполненная');
    });

    check('список всех состояний раскрывается и отправляется целиком', () => {
      const rows = [...condPanel.root.querySelectorAll('.token-row')];
      const ogre = rows.find((row) => row.textContent.includes('Огр'));
      const box = ogre.querySelector('.token-conditions');
      const chips = [...box.querySelectorAll('.token-conditions__chip')];
      assert.strictEqual(chips.length, window.DnD5e.CONDITIONS.length, 'перечислены не все состояния');
      assert(!box.classList.contains('is-open'), 'список состояний открыт сразу');
      box.querySelector('.token-conditions__head').click();
      assert(box.classList.contains('is-open'), 'список состояний не раскрылся');
      assert(chips.filter((chip) => chip.classList.contains('is-on')).length === 2,
        'отмечено не два состояния');
      chips.find((chip) => chip.textContent === 'Слепой').click();
      const sent = conditionChanges[conditionChanges.length - 1];
      // Сервер ждёт перечень, а не «добавь одно»: снятие состояния пришлось бы
      // вторым событием.
      assert.strictEqual(sent.tokenId, 't6');
      assert.strictEqual(sent.conditions.length, 3, `отправлено ${sent.conditions.length} состояний`);
      assert(sent.conditions.includes('blinded') && sent.conditions.includes('prone'),
        `состояния: ${sent.conditions.join(', ')}`);
      const poisoned = chips.find((chip) => chip.textContent === 'Отравлен');
      poisoned.click();
      const after = conditionChanges[conditionChanges.length - 1];
      assert(!after.conditions.includes('poisoned'), 'состояние не сняли');
      assert.strictEqual(after.conditions.length, 2, 'после снятия осталось не два состояния');
    });

    check('длительность состояния задаётся в панели', () => {
      const rows = [...condPanel.root.querySelectorAll('.token-row')];
      const ogre = rows.find((row) => row.textContent.includes('Огр'));
      const roundRows = [...ogre.querySelectorAll('.token-conditions__rounds')];
      const proneRow = roundRows.find((row) => row.textContent.includes('Сбит с ног'));
      assert(proneRow, 'у включённого состояния нет поля длительности');
      const input = proneRow.querySelector('input');
      input.value = '2';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const sent = conditionChanges[conditionChanges.length - 1];
      assert.strictEqual(sent.conditionDurations.prone, 2,
        `длительность не ушла: ${JSON.stringify(sent.conditionDurations)}`);
    });

    check('подсказки состояний видны на карте всем, включая игрока', () => {
      const state = { ...MAP_STATE, tokens: MAP_STATE.tokens.map((token) => (
        token.id === 't1' ? { ...token, conditions: ['prone', 'poisoned'] } : token
      )) };
      mapView.render(state, { role: 'dm', playerId: 'dm' });
      const badges = [...mapHost.querySelectorAll('[data-token-id="t1"] .token__condition')]
        .map((node) => node.textContent);
      assert(badges.join(', ') === 'Лежит, Отравл.', `подсказки: ${badges.join(', ')}`);

      // Невидимую фишку видно только мастеру, и она полупрозрачна.
      const invisible = { ...MAP_STATE, tokens: [{ ...MAP_STATE.tokens[0], conditions: ['invisible'] }] };
      mapView.render(invisible, { role: 'dm', playerId: 'dm' });
      const seen = mapHost.querySelector('[data-token-id="t1"]');
      assert(seen.classList.contains('token--invisible'), 'невидимая фишка не выделена');
      mapView.render(state, { role: 'player', playerId: 'p-1' });
      assert.strictEqual([...mapHost.querySelectorAll('[data-token-id="t1"] .token__condition')].length, 2,
        'игрок не видит состояния фишки');
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    });

    // Возвращаем панель в обычное состояние: дальше идут проверки фишек.
    tokenPanel.render(TOKENS, PLAYERS, { role: 'dm', playerId: 'dm' });
    check('в панели фишек есть спавн из листа для игроков без фишки', () => {
      // В PLAYERS у обоих игроков уже есть фишка, поэтому для проверки списка
      // спавна нужен отдельный состав: без фишки только у Бориса.
      const withWaiting = PLAYERS.concat([
        { playerId: 'p-2', name: 'Борис', role: 'player', online: false, hasSheet: true, tokenId: null }
      ]);
      tokenPanel.render(TOKENS, withWaiting, { role: 'dm', playerId: 'dm' });
      const block = tokensHost.querySelector('.token-spawn');
      assert(block, 'нет блока спавна');
      assert(!block.hidden, 'блок спавна скрыт у мастера');
      // Заголовок стал заголовком сворачиваемой секции, а не подписью внутри
      // блока: длинный список спавна мастеру нужен не всегда.
      const spawnSection = block.closest('.section');
      assert(spawnSection, 'блок спавна не внутри секции');
      assert(
        spawnSection.querySelector('.section__title').textContent.includes('Вывести из листа'),
        `нет заголовка секции: ${spawnSection.textContent}`
      );
      // Артёму фишка уже назначена, поэтому его в списке спавна нет.
      assert(!block.textContent.includes('Артём'), 'игрок с фишкой попал в список спавна');
      const rows = [...block.querySelectorAll('.token-spawn__row')];
      assert(rows.length === 1, `строк спавна: ${rows.length}`);
      assert(rows[0].textContent.includes('Борис'), `в строке не Борис: ${rows[0].textContent}`);
      assert(rows[0].querySelector('.token-spawn__meta').textContent.includes('оффлайн'),
        `нет отметки о листе: ${rows[0].textContent}`);
    });
    check('кнопка «Вывести» в панели фишек отдаёт id игрока', () => {
      tokensHost.querySelector('.token-spawn__row button').click();
      assert(spawnedFrom === 'p-2', `передан игрок: ${spawnedFrom}`);
    });
    check('когда у всех игроков есть фишки, спавн говорит об этом', () => {
      // Бориса заменяем, а не добавляем второго: иначе старый без фишки остался бы
      // в списке, и проверка падала бы на своих же данных.
      const withAll = PLAYERS.map((player) => (
        player.playerId === 'p-2' ? { ...player, tokenId: 't9' } : player
      ));
      tokenPanel.render(TOKENS, withAll, { role: 'dm', playerId: 'dm' });
      const block = tokensHost.querySelector('.token-spawn');
      assert(block.querySelectorAll('.token-spawn__row').length === 0, 'список спавна не пуст');
      assert(block.textContent.includes('уже есть фишки'), `нет подскаски: ${block.textContent}`);
    });
    check('у игрока и в тренировочном столе блока спавна нет', () => {
      tokenPanel.render(TOKENS, PLAYERS, { role: 'player', playerId: 'p-9' });
      assert(tokensHost.querySelector('.token-spawn').hidden, 'игрок видит блок спавна');
      tokenPanel.render(TOKENS, PLAYERS, { role: 'player', playerId: 'p-9', training: true });
      assert(tokensHost.querySelector('.token-spawn').hidden, 'в тренировочном столе виден блок спавна');
      tokenPanel.render(TOKENS, PLAYERS, { role: 'dm', playerId: 'dm' });
    });
    check('в списке фишек видно, какие скрыты, и есть переключатель', () => {
      const hiddenTokens = TOKENS.map((token) => ({ ...token, hidden: token.id !== 't2' }));
      tokenPanel.render(hiddenTokens, PLAYERS, { role: 'dm', playerId: 'dm' });
      const rows = [...tokensHost.querySelectorAll('.token-row')];
      const hiddenRow = rows.find((row) => row.classList.contains('token-row--hidden'));
      assert(hiddenRow, 'скрытая фишка не помечена в списке');
      assert(hiddenRow.textContent.includes('Скрыта'), `нет подписи «Скрыта»: ${hiddenRow.textContent}`);
      const visibleRow = rows.find((row) => !row.classList.contains('token-row--hidden'));
      assert(visibleRow.textContent.includes('Видна'), `нет подписи «Видна»: ${visibleRow.textContent}`);
    });
    check('массовые кнопки «Показать все» и «Скрыть все» есть только у мастера', () => {
      const bulk = [...tokensHost.querySelectorAll('.token-bulk button')];
      assert(bulk.length === 2, `массовых кнопок: ${bulk.length}`);
      assert(bulk.some((node) => node.textContent.includes('Скрыть все')), 'нет кнопки «Скрыть все»');
      assert(bulk.some((node) => node.textContent.includes('Показать все')), 'нет кнопки «Показать все»');
      tokenPanel.render(TOKENS, PLAYERS, { role: 'player', playerId: 'p-9' });
      assert(!tokensHost.querySelector('.token-bulk'), 'игрок видит массовые кнопки');
      assert(!tokensHost.textContent.includes('Все фишки'), 'игрок видит список «Все фишки»');
      tokenPanel.render(TOKENS, PLAYERS, { role: 'dm', playerId: 'dm' });
    });
    check('переключатель скрытия у фишки отдаёт новое состояние', () => {
      const toggled = [];
      const host = document.createElement('div');
      sandbox.appendChild(host);
      const panel = new window.TableUI.TokenPanel(host, {
        onCreate: () => {},
        onDeleteToken: () => {},
        onToggleTokenHidden: (tokenId, hidden) => toggled.push([tokenId, hidden])
      });
      panel.render(
        [{ id: 't9', name: 'Гоблин', mapType: 'world', x: 0.5, y: 0.5, imageUrl: null, assignedPlayerId: null, color: '#c96f4a', hidden: true }],
        [],
        { role: 'dm', playerId: 'dm' }
      );
      const eye = [...host.querySelectorAll('.token-row button')]
        .find((node) => node.textContent === 'Скрыта');
      assert(eye, 'нет переключателя скрытости');
      eye.click();
      assert(toggled.length === 1 && toggled[0][0] === 't9' && toggled[0][1] === false,
        `обработчик получил: ${JSON.stringify(toggled)}`);
    });
    const tokenForm = tokensHost.querySelector('.token-form');
    tokenForm.querySelector('input').value = 'Новая фишка';
    tokenForm.requestSubmit();
    check('форма создания фишки отдаёт введённое имя', () => {
      assert(createdTokenName === 'Новая фишка', `создано: ${createdTokenName}`);
    });
    tokenPanel.render(TOKENS, PLAYERS, { role: 'player', playerId: 'p-9' });
    check('игрок без своей фишки видит подсказку', () => {
      assert(tokensHost.textContent.includes('не назначил вам фишку'), 'нет подсказки');
    });
    tokenPanel.render(TOKENS, PLAYERS, { role: 'player', playerId: 'p-1' });
    check('игрок видит свою фишку и может загрузить её изображение', () => {
      assert(tokensHost.textContent.includes('Моя фишка'), 'нет раздела «Моя фишка»');
      assert(tokensHost.querySelector('input[type="file"]'), 'нет поля загрузки изображения');
    });
    check('игроку не показывают форму создания фишек — это дело ДМ', () => {
      assert(tokensHost.querySelector('.token-form').hidden, 'игроку показана форма создания фишки');
    });
    tokenPanel.render(TOKENS, PLAYERS, { role: 'player', playerId: 'p-9', training: true });
    check('в тренировочном столе фишку можно создать себе', () => {
      const form = tokensHost.querySelector('.token-form');
      assert(form && !form.hidden, 'форма создания фишки скрыта');
      assert(tokensHost.textContent.includes('сразу станет вашей'), 'нет подсказки, что фишка станет своей');
    });

    /* ------------------------------------- скрытие имени и поиск фишек */

    const nameTokens = TOKENS.concat([
      { id: 't7', name: 'Король Виверн', mapType: 'world', x: 0.2, y: 0.2, imageUrl: null, assignedPlayerId: null, color: '#c96f4a', hidden: false, hideName: true }
    ]);
    const nameHost = document.createElement('div');
    sandbox.appendChild(nameHost);
    const nameToggles = [];
    const renamed = [];
    const namePanel = new window.TableUI.TokenPanel(nameHost, {
      onRenameToken: (token) => renamed.push(token.id),
      onToggleTokenNameHidden: (tokenId, hidden) => nameToggles.push([tokenId, hidden])
    });
    namePanel.render(nameTokens, PLAYERS, { role: 'dm', playerId: 'dm' });

    check('у фишки есть переключатель имени и он говорит, скрыто оно или нет', () => {
      const rows = [...nameHost.querySelectorAll('.token-row')];
      const hiddenRow = rows.find((row) => row.classList.contains('token-row--nameless'));
      assert(hiddenRow, 'строка фишки со скрытым именем не помечена');
      assert(hiddenRow.textContent.includes('Имя скрыто'), `в строке своё имя: ${hiddenRow.textContent}`);
      const namedRow = rows.find((row) => !row.classList.contains('token-row--nameless'));
      const toggle = [...namedRow.querySelectorAll('button')]
        .find((node) => node.textContent === 'С именем');
      assert(toggle, 'нет переключателя имени у фишки с именем');
      toggle.click();
      assert(nameToggles.length === 1 && nameToggles[0][1] === true,
        `обработчик получил: ${JSON.stringify(nameToggles)}`);
    });
    check('двойной клик по строке фишки переименовывает её', () => {
      const row = [...nameHost.querySelectorAll('.token-row')]
        .find((node) => node.textContent.includes('Мира'));
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      assert(renamed.length === 1 && renamed[0] === 't2', `переименовывают: ${JSON.stringify(renamed)}`);
    });
    check('правый клик по строке открывает то же меню, что и на карте', () => {
      const row = [...nameHost.querySelectorAll('.token-row')]
        .find((node) => node.textContent.includes('Гоблин'));
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
      const menu = document.querySelector('.token-menu');
      assert(menu, 'меню фишки не открылось');
      const items = [...menu.querySelectorAll('.token-menu__item')].map((node) => node.textContent);
      assert(items.some((text) => text.includes('Переименовать')), `нет переименования: ${items}`);
      assert(items.some((text) => text.includes('Скрыть имя')), `нет скрытия имени: ${items}`);
      assert(menu.querySelector('select'), 'в меню нет выбора игрока');
      menu.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      namePanel.closeMenu();
    });

    check('поиск по фишкам оставляет совпадения и пишет, когда ничего не нашлось', () => {
      const search = nameHost.querySelector('.token-search__input');
      assert(search, 'нет поля поиска по фишкам');
      try {
        search.value = 'виверн';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        const visible = [...nameHost.querySelectorAll('.token-row')].filter((row) => !row.hidden);
        assert(visible.length === 1 && visible[0].dataset.tokenId === 't7',
          `показано: ${visible.map((row) => row.textContent).join(' | ')}`);
        search.value = 'осьминог';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        assert(nameHost.querySelector('.token-list__empty').textContent.includes('Ничего не найдено'),
          `нет подсказки о пустом поиске: "${nameHost.querySelector('.token-list__empty').textContent}"`);
      } finally {
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
      }
      assert(nameHost.querySelectorAll('.token-row:not([hidden])').length === nameTokens.length,
        'поиск не сбросился');
    });
    check('фильтр оставляет только скрытые фишки и только фишки без имени', () => {
      const filters = [...nameHost.querySelectorAll('.token-filter')];
      const byLabel = (label) => filters.find((node) => node.textContent === label);
      byLabel('Без имени').click();
      const nameless = [...nameHost.querySelectorAll('.token-row')].filter((row) => !row.hidden);
      assert(nameless.length === 1 && nameless[0].textContent.includes('Имя скрыто'),
        `фильтр «Без имени» показал: ${nameless.length}`);
      byLabel('Все').click();
      assert(nameHost.querySelectorAll('.token-row:not([hidden])').length === nameTokens.length,
        'фильтр «Все» не вернул все фишки');
    });
    check('поиск и кнопки скрытия есть только у ДМ и только при нескольких фишках', () => {
      namePanel.render(TOKENS.slice(0, 2), PLAYERS, { role: 'dm', playerId: 'dm' });
      assert(nameHost.querySelector('.token-search').hidden, 'поиск показан ради двух фишек');
      namePanel.render(nameTokens, PLAYERS, { role: 'dm', playerId: 'dm' });
      assert(!nameHost.querySelector('.token-search').hidden, 'поиск спрятан при полной столе');
      namePanel.render(nameTokens, PLAYERS, { role: 'player', playerId: 'p-1' });
      assert(nameHost.querySelector('.token-search').hidden, 'игрок видит поиск по чужим фишкам');
      namePanel.render(TOKENS, PLAYERS, { role: 'dm', playerId: 'dm' });
    });
    check('секции панели фишек сворачиваются и помнят состояние', () => {
      const heads = [...nameHost.querySelectorAll('.section__head')];
      assert(heads.length >= 2, `секций: ${heads.length}`);
      const all = heads.find((node) => node.textContent.includes('Все фишки'));
      const body = all.nextElementSibling;
      assert(body && body.classList.contains('section__body'), 'под заголовком не тело секции');
      assert(!body.hidden, 'тело секции «Все фишки» свёрнуто по умолчанию');
      all.click();
      assert(body.hidden, 'секция не свернулась по клику');
      assert(all.getAttribute('aria-expanded') === 'false', 'состояние не отражено в aria');
      assert(localStorage.getItem('dnd-table.panel.tokensAll') === '1', 'состояние не записано');
      all.click();
      assert(!body.hidden, 'секция не развернулась обратно');
      all.click();
      // Свернутое состояние переживает пересборку панели: render() создаёт
      // секции заново на каждом событии фишки.
      namePanel.render(TOKENS, PLAYERS, { role: 'dm', playerId: 'dm' });
      const restored = [...nameHost.querySelectorAll('.section__head')]
        .find((node) => node.textContent.includes('Все фишки'));
      assert(restored.nextElementSibling.hidden, 'после перерисовки секция снова раскрылась');
      restored.click();
      assert(!restored.nextElementSibling.hidden, 'секция не раскрылась обратно');
      localStorage.removeItem('dnd-table.panel.tokensAll');
    });

    /* ------------------------------------------------ сквозной сценарий */

    await waitFor(() => document.querySelector('#home-datadir').textContent !== '…', 'инициализация главного экрана');

    check('главный экран предлагает три сценария', () => {
      const cards = [...document.querySelectorAll('#screen-home .card__title')].map((node) => node.textContent);
      assert(cards.some((text) => text.includes('Создать новую кампанию')), 'нет создания кампании');
      assert(cards.some((text) => text.includes('Загрузить кампанию')), 'нет загрузки кампании');
      assert(cards.some((text) => text.includes('Подключиться к столу')), 'нет подключения');
      // Персонажа заводят заранее, не дожидаясь стола: отдельная карточка.
      assert(cards.some((text) => text.includes('Создать лист персонажа')), 'нет создания листа персонажа');
    });
    check('на главном экране сказано, что общая сеть не нужна', () => {
      // С прошлых времён тут было «приложение не создаёт сеть». Теперь сети
      // нет вовсе, а игроки ходят к мастеру по P2P, и сказать надо именно об
      // этом: иначе игрок пойдёт искать Hamachi.
      const notice = document.querySelector('.home__notice').textContent;
      assert(notice.includes('Общей сети не нужно'), `нет пояснения про сеть: ${notice}`);
      assert(notice.includes('P2P-билет'), `нет упоминания билета: ${notice}`);
      assert(!notice.includes('Hamachi'), 'осталось упоминание виртуальных сетей');
    });

    /* ------------------------- стол без сервера: запуск из настроек */

    document.querySelector('#btn-settings-home').click();
    const trainingButton = await waitFor(
      () => document.querySelector('.modal-overlay [data-setting="training"]'),
      'кнопка запуска стола без сервера в настройках'
    );
    check('в настройках есть запуск стола без сервера', () => {
      assert(trainingButton.textContent.includes('без сервера'), `текст кнопки: ${trainingButton.textContent}`);
      const text = document.querySelector('.modal-overlay').textContent.replace(/\s+/g, ' ');
      assert(text.includes('без сервера и без сети'), `нет пояснения режима: ${text.slice(0, 140)}`);
      assert(text.includes('сохраняется на этом компьютере'), 'не сказано, где хранится лист');
    });

    trainingButton.click();
    await waitFor(() => document.querySelector('#screen-table').classList.contains('is-active'), 'экран тренировочного стола');
    await waitFor(() => document.querySelector('#conn-badge').textContent === 'без сети', 'подпись «без сети»');
    const hostInTraining = await window.desktop.hostStatus();

    check('тренировочный стол открывается без сервера и без сети', () => {
      assert(hostInTraining.running === false, 'сервер стола всё-таки поднялся');
      assert(document.querySelector('#role-badge').textContent === 'Игрок', 'роль не игрок');
      assert(document.querySelector('#conn-badge').textContent === 'без сети', 'нет пометки, что связи нет');
      assert(document.querySelector('#table-campaign').textContent.includes('Проверка'), 'нет пометки, что это проверка');
      assert(document.querySelector('#table-sub').textContent.includes('проверка без сети'), 'нет пометки в подзаголовке');
      assert(document.querySelector('#btn-save-campaign').hidden, 'у игрока видна кнопка сохранения кампании');
      assert(document.querySelector('#btn-stop-host').hidden, 'у игрока видна кнопка остановки стола');
      assert(document.querySelector('#addresses-panel').hidden, 'у игрока видны адреса для подключения');
      assert(document.querySelectorAll('#players-root .player-row').length === 1, 'в тренировке игрок должен быть один');
    });

    document.querySelector('.tabs__btn[data-tab="sheet"]').click();
    check('лист персонажа в тренировочном столе можно заполнять', () => {
      const nameField = document.querySelector('#tab-sheet [data-field="characterName"]');
      assert(nameField && !nameField.disabled, 'поле имени персонажа недоступно');
      assert(!document.querySelector('#tab-sheet .sheet__grid').hidden, 'форма листа не показана');
      const detach = [...document.querySelectorAll('#tab-sheet .sheet__head-tools button')]
        .find((node) => node.textContent.includes('Отдельным окном'));
      assert(detach && !detach.hidden, 'нет кнопки выноса листа в отдельное окно');
    });

    const fillTrainField = (selector, value) => {
      const field = document.querySelector(selector);
      assert(field, `нет поля ${selector}`);
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    fillTrainField('#tab-sheet [data-field="characterName"]', 'Тордин');
    fillTrainField('#tab-sheet [data-field="charClass"]', 'Воин');
    fillTrainField('#tab-sheet [data-field="level"]', '3');
    fillTrainField('#tab-sheet [data-ability="str"]', '17');
    const trainingPlayerId = localStorage.getItem('dnd-table.playerId');
    const draftSaved = await softWait(
      () => {
        const raw = localStorage.getItem(window.LocalTable.draftKey(trainingPlayerId));
        return raw && raw.includes('Тордин');
      },
      'черновик листа в localStorage',
      8000
    );
    check('лист, заполненный без стола, сохраняется на этом компьютере', () => {
      assert(trainingPlayerId, 'у игрока нет локального идентификатора');
      assert(draftSaved, 'черновик листа не сохранён');
      const draft = window.LocalTable.readDraft(trainingPlayerId);
      assert(draft.characterName === 'Тордин' && draft.charClass === 'Воин', `черновик: ${JSON.stringify(draft).slice(0, 80)}`);
      assert(draft.level === 3 && draft.abilities.str === 17, `значения черновика: ${draft.level}/${draft.abilities.str}`);
      const status = document.querySelector('#tab-sheet .sheet__status').textContent;
      assert(status.includes('на этом компьютере'), `подпись сохранения: ${status}`);
    });

    // Лист можно вынести и в тренировке: окно подключается не к серверу, а к
    // тому же черновику листа (см. проверки окна в test/smoke-main.js).
    const trainDetachButton = [...document.querySelectorAll('#tab-sheet .sheet__head-tools button')]
      .find((node) => node.textContent.includes('Отдельным окном'));
    check('лист тренировочного стола можно вынести в отдельное окно', () => {
      assert(!document.querySelector('.layout').classList.contains('is-right-collapsed'), 'панель уже свёрнута');
      trainDetachButton.click();
    });
    // Ждём именно сворачивания панели: тосты живут несколько секунд, и старый
    // тост от прошлого выноса листа мог бы выдать себя за новый.
    const trainSheetDetached = await softWait(
      () => document.querySelector('.layout').classList.contains('is-right-collapsed'),
      'панель свернулась после выноса листа в тренировочном столе',
      10000
    );
    check('после выноса листа панель тренировочного стола сворачивается до иконок', () => {
      assert(trainSheetDetached, 'панель не свернулась');
    });
    // Окно листа ещё загружается (под нагрузкой это занимает секунды), а начало
    // настоящего стола закрывает такие окна — поэтому даём ему время.
    await wait(4000);

    document.querySelector('.tabs__btn[data-tab="dice"]').click();
    // Пустое поле броском не считается: сначала набираем формулу.
    document.querySelector('#tab-dice .dice__controls .btn--accent').click();
    await waitFor(
      () => document.querySelector('#tab-dice .dice__hint').textContent.includes('Введите формулу'),
      'подсказка о пустом поле броска'
    );
    document.querySelector('#tab-dice .dice__formula').value = '2d6+3';
    document.querySelector('#tab-dice .dice__controls .btn--accent').click();
    await waitFor(() => document.querySelectorAll('#tab-dice .dice__row').length > 0, 'бросок в тренировочном столе');
    // И быстрая кость: её бросок тоже должен дойти до стола.
    [...document.querySelectorAll('#tab-dice .dice__quick-btn')]
      .find((button) => button.textContent === 'd20').click();
    await waitFor(() => document.querySelectorAll('#tab-dice .dice__row').length > 1, 'быстрый бросок d20');
    document.querySelector('.tabs__btn[data-tab="chat"]').click();
    const trainChatForm = document.querySelector('#tab-chat .chat__form');
    trainChatForm.querySelector('input').value = 'Проверка без сети';
    trainChatForm.requestSubmit();
    await waitFor(
      () => [...document.querySelectorAll('#tab-chat .chat__text')].some((node) => node.textContent === 'Проверка без сети'),
      'сообщение чата в тренировочном столе'
    );
    check('кубики и чат работают без сервера', () => {
      const diceRows = [...document.querySelectorAll('#tab-dice .dice__row')];
      assert(diceRows[0].textContent.includes('2d6+3'), `строка броска: ${diceRows[0].textContent}`);
      assert(diceRows[1].textContent.includes('d20'), `строка быстрой кости: ${diceRows[1].textContent}`);
      assert(diceRows[0].textContent.includes('Игрок'), `в броске нет имени: ${diceRows[0].textContent}`);
      assert(document.querySelector('#tab-chat').textContent.includes('бросил 2d6+3'), 'формула не попала в чат');
      assert(document.querySelector('#tab-chat').textContent.includes('бросил d20'), 'быстрый бросок не попал в чат');
    });

    // Карта, сетка и фишка: их в тренировочном столе выдаёт сам игрок.
    const trainFileInput = await waitFor(
      () => document.querySelector('#map-root .map-toolbar input[type="file"]'),
      'поле выбора карты в тренировочном столе'
    );
    check('в тренировочном столе карту для проверки можно загрузить', () => {
      const toolbar = document.querySelector('#map-root .map-toolbar');
      assert(!toolbar.hidden, 'панель карты скрыта');
      assert(toolbar.querySelector('.map-toolbar__note').textContent.includes('Проверка без сети'), 'нет пометки «проверка»');
      const texts = [...toolbar.querySelectorAll('button, label')].map((node) => node.textContent);
      assert(texts.some((text) => text.includes('Сетка')), `нет кнопки сетки: ${texts.join(' | ')}`);
      assert(!texts.some((text) => text.includes('Нарисовать')), 'рисование карты — дело ДМ, игроку его не показываем');
      assert(!texts.some((text) => text.includes('Показать игрокам')), 'показывать карту игрокам тут некому');
    });

    const trainBytes = Uint8Array.from(atob(MAP_PNG.split(',')[1]), (character) => character.charCodeAt(0));
    const trainTransfer = new DataTransfer();
    trainTransfer.items.add(new File([trainBytes], 'train.png', { type: 'image/png' }));
    trainFileInput.files = trainTransfer.files;
    trainFileInput.dispatchEvent(new Event('change', { bubbles: true }));
    const trainMapShown = await softWait(
      () => {
        const image = document.querySelector('#map-root .map-image');
        return image && image.src.startsWith('data:image/png') && !document.querySelector('#map-root .map-surface').hidden;
      },
      'карта для проверки на столе',
      10000
    );
    check('карта для проверки показывается сразу, без сервера', () => {
      assert(trainMapShown, 'карта не появилась на столе');
      assert(document.querySelector('#map-root .map-empty').hidden, 'заглушка «карта не загружена» осталась');
      const image = document.querySelector('#map-root .map-image');
      assert(!image.src.includes('/files/'), `в тренировке картинка не должна ходить на сервер: ${image.src.slice(0, 60)}`);
    });

    const trainGridButton = [...document.querySelectorAll('#map-root .map-toolbar button')]
      .find((node) => node.textContent.startsWith('Сетка'));
    trainGridButton.click();
    await waitFor(() => !document.querySelector('#map-root .map-grid').hidden, 'сетка в тренировочном столе');
    check('сетку в тренировочном столе можно включить', () => {
      assert(!document.querySelector('#map-root .map-grid').hidden, 'сетка не появилась');
      // Панель перерисовывается после ответа стола, поэтому кнопку ищем заново.
      const gridButton = [...document.querySelectorAll('#map-root .map-toolbar button')]
        .find((node) => node.textContent.startsWith('Сетка'));
      assert(gridButton.textContent.includes('вкл'), `подпись кнопки: ${gridButton.textContent}`);
    });

    document.querySelector('#btn-settings-table').click();
    const trainingSettingsGrid = await waitFor(
      () => document.querySelector('.modal-overlay [data-setting="grid"]'),
      'настройки сетки в тренировочном столе'
    );
    check('сетка настраивается и из окна настроек тренировочного стола', () => {
      assert(!trainingSettingsGrid.disabled, 'настройка сетки недоступна');
      assert(trainingSettingsGrid.checked, 'галочка не отражает состояние сетки на карте');
      const cell = document.querySelector('.modal-overlay [data-setting="cell"]');
      assert(cell && !cell.disabled, 'размер клетки недоступен');
      assert(!document.querySelector('.modal-overlay [data-setting="training"]'),
        'уже находясь за столом, предлагают открыть ещё один тренировочный стол');
    });

    // Выбор тем: карточки с превью, тон, акцент, минимализм, движение и звук.
    const themeGrid = document.querySelector('.modal-overlay [data-setting="theme"]');
    check('в настройках есть карточки тем с превью', () => {
      assert(themeGrid, 'нет выбора тем');
      const labels = Array.from(themeGrid.querySelectorAll('.theme-card__label'))
        .map((node) => node.textContent);
      for (const name of ['Стандартная', 'Лес', 'Магия', 'Океан', 'Трактир', 'Стимпанк']) {
        assert(labels.includes(name), `нет темы «${name}»: ${labels.join(', ')}`);
      }
      assert(themeGrid.querySelector('.theme-card__scene'), 'у карточек нет превью');
    });
    if (themeGrid) {
      const before = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      // Выбираем не ту тему, что уже стоит, иначе проверка ничего не заметит.
      const targetId = window.DnDTheme.current() === 'standart' ? 'les' : 'standart';
      document.querySelector(`.modal-overlay [data-theme-id="${targetId}"]`).click();
      check('смена темы меняет палитру и запоминается', () => {
        assert(
          document.documentElement.dataset.theme === targetId,
          `тема не применилась: ${document.documentElement.dataset.theme}`
        );
        const after = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
        assert(after && after !== before, `цвет акцента не изменился: ${before} → ${after}`);
        assert(
          localStorage.getItem(window.DnDTheme.STORAGE_KEY) === targetId,
          'выбор темы не сохранился'
        );
      });

      document.querySelector('.modal-overlay [data-setting="tone"][data-tone="light"]').click();
      check('светлый тон переключается и запоминается', () => {
        assert(document.documentElement.dataset.tone === 'light', 'тон не применился');
        assert(localStorage.getItem(window.DnDTheme.TONE_KEY) === 'light', 'тон не сохранился');
      });

      const swatch = document.querySelector('.modal-overlay [data-setting="accent"]');
      const accentColor = swatch && swatch.dataset.accent;
      if (swatch) swatch.click();
      check('акцент темы меняется и запоминается', () => {
        assert(swatch, 'нет акцентов темы');
        assert(
          document.documentElement.style.getPropertyValue('--accent').trim() === accentColor,
          'акцент не попал в переменную темы'
        );
        assert(window.DnDTheme.accentFor(window.DnDTheme.current()) === accentColor, 'акцент не сохранился');
      });

      const focusToggle = document.querySelector('.modal-overlay [data-setting="focus"]');
      focusToggle.click();
      check('минимализм убирает декор, но оставляет интерфейс', () => {
        assert(document.documentElement.dataset.focus === 'on', 'режим фокуса не включился');
        assert(
          getComputedStyle(document.body, '::before').display === 'none',
          'атмосфера осталась в режиме фокуса'
        );
        assert(document.querySelector('.modal-overlay'), 'окно настроек закрылось');
      });

      const motionToggle = document.querySelector('.modal-overlay [data-setting="motion"]');
      motionToggle.click();
      check('анимации отключаются и запоминаются', () => {
        assert(document.documentElement.dataset.motion === 'off', 'анимации не отключились');
        assert(localStorage.getItem(window.DnDTheme.MOTION_KEY) === 'off', 'настройка движения не сохранилась');
      });

      const soundToggle = document.querySelector('.modal-overlay [data-setting="sound"]');
      soundToggle.click();
      const soundSkin = document.querySelector('.modal-overlay [data-setting="sound-skin"]');
      soundSkin.value = 'les';
      soundSkin.dispatchEvent(new Event('change', { bubbles: true }));
      const soundVolume = document.querySelector('.modal-overlay [data-setting="sound-volume"]');
      soundVolume.value = '35';
      soundVolume.dispatchEvent(new Event('input', { bubbles: true }));
      check('звук включается отдельно от темы, скином и громкостью', () => {
        assert(localStorage.getItem(window.DnDSound.ENABLED_KEY) === 'on', 'звук не включился');
        assert(localStorage.getItem(window.DnDSound.SKIN_KEY) === 'les', 'звуковой скин не сохранился');
        assert(localStorage.getItem(window.DnDSound.VOLUME_KEY) === '35', 'громкость не сохранилась');
      });

      const ambientVolume = document.querySelector('.modal-overlay [data-setting="sound-ambient-volume"]');
      ambientVolume.value = '40';
      ambientVolume.dispatchEvent(new Event('input', { bubbles: true }));
      check('громкость атмосферы настраивается отдельно от щелчков', () => {
        assert(
          localStorage.getItem(window.DnDSound.AMBIENT_VOLUME_KEY) === '40',
          'громкость атмосферы не сохранилась'
        );
        assert(typeof window.DnDSound.previewAmbient === 'function', 'нет пробы атмосферы');
      });

      const ambientToggle = document.querySelector('.modal-overlay [data-setting="ambient"]');
      check('атмосфера темы включается отдельно от щелчков', () => {
        assert(ambientToggle, 'нет переключателя звуков темы');
        assert(ambientToggle.checked, 'атмосфера должна быть включена по умолчанию');
        assert(typeof window.DnDSound.setScene === 'function', 'нет управления сценой');
        ambientToggle.click();
        assert(
          localStorage.getItem(window.DnDSound.AMBIENT_KEY) === 'off',
          'атмосфера не выключилась'
        );
        assert(window.DnDSound.ambientEnabled() === false, 'выключение не применилось');
      });

      check('у главного экрана есть сцена темы и частицы', () => {
        const scene = document.querySelector('.home-scene');
        assert(scene, 'нет сцены главного экрана');
        assert(scene.querySelector('.home-scene__sky'), 'нет неба сцены');
        assert(scene.querySelectorAll('.home-scene__particles i').length === 6, 'нет частиц сцены');
        const sky = getComputedStyle(scene.querySelector('.home-scene__sky'));
        assert(
          sky.backgroundImage && sky.backgroundImage !== 'none',
          'небо сцены не получило оформление'
        );
      });

      // Возвращаем читаемый режим и проверяем, что тема не сломала орнамент карты.
      focusToggle.click();
      motionToggle.click();
      document.querySelector('.modal-overlay [data-theme-id="par"]').click();
      check('стимпанк включается и вешает свою цепь на карту', () => {
        assert(document.documentElement.dataset.theme === 'par', 'стимпанк не применился');
        const strand = document.querySelector('.map-decor__strand');
        assert(strand, 'у карты нет подвесного орнамента');
        const image = getComputedStyle(strand).backgroundImage;
        assert(image && image !== 'none', 'орнамент не получил оформление');
      });

      check('орнамент карты качается на ветру и живёт частицами', () => {
        const decor = document.querySelector('.map-decor');
        assert(decor.querySelector('.map-decor__wind'), 'нет слоя ветра');
        assert(decor.querySelectorAll('.map-decor__leaf').length === 3, 'нет листьев');
        assert(decor.querySelectorAll('.map-decor__mote').length === 6, 'нет частиц орнамента');
        assert(decor.querySelector('.map-decor__aside-mark'), 'нет второго подвеса');
        const wind = getComputedStyle(decor.querySelector('.map-decor__wind'));
        assert(wind.animationName && wind.animationName !== 'none', 'ветер не анимируется');
      });
    }
    document.querySelector('.modal-overlay .modal__actions button').click();

    document.querySelector('.tabs__btn[data-tab="tokens"]').click();
    const trainTokenForm = document.querySelector('#tab-tokens .token-form');
    check('в тренировочном столе фишку можно завести себе', () => {
      assert(trainTokenForm && !trainTokenForm.hidden, 'форма создания фишки скрыта');
      assert(document.querySelector('#tab-tokens').textContent.includes('Моя фишка'), 'нет раздела «Моя фишка»');
    });
    trainTokenForm.querySelector('input').value = 'Мой герой';
    trainTokenForm.requestSubmit();
    await waitFor(() => document.querySelectorAll('#map-root .token').length > 0, 'фишка на карте');
    check('созданная фишка сразу своя — её видно на карте', () => {
      const token = document.querySelector('#map-root .token');
      assert(token.classList.contains('token--mine'), 'фишка не помечена как своя');
      assert(token.classList.contains('token--movable'), 'свою фишку нельзя двигать');
      const label = token.querySelector('.token__label');
      assert(label && label.textContent === 'Мой герой', `имя под фишкой: ${label && label.textContent}`);
    });

    const liveTokenId = document.querySelector('#map-root .token').dataset.tokenId;
    const trainImageInput = document.querySelector('#tab-tokens input[type="file"]');
    const trainTokenTransfer = new DataTransfer();
    trainTokenTransfer.items.add(new File([trainBytes], 'hero.png', { type: 'image/png' }));
    trainImageInput.files = trainTokenTransfer.files;
    trainImageInput.dispatchEvent(new Event('change', { bubbles: true }));
    const trainTokenImageShown = await softWait(
      () => {
        const circle = document.querySelector(`#map-root [data-token-id="${liveTokenId}"] .token__circle`);
        return circle && circle.classList.contains('token__circle--image');
      },
      'картинка фишки в тренировочном столе',
      10000
    );
    check('картинку своей фишки можно загрузить без сервера', () => {
      assert(trainTokenImageShown, 'картинка фишки не применилась');
    });

    document.querySelector('#btn-leave').click();
    await waitFor(() => document.querySelector('#screen-home').classList.contains('is-active'), 'выход из тренировочного стола');
    check('из тренировочного стола можно выйти без остановки сервера', () => {
      assert(document.querySelector('#screen-home').classList.contains('is-active'), 'не вернулись на главный экран');
    });

    check('экран подключения содержит билет, имя и одну кнопку', () => {
      document.querySelector('#btn-go-join').click();
      assert(document.querySelector('#screen-join').classList.contains('is-active'), 'экран подключения не открылся');
      assert(document.querySelector('#join-p2p-ticket'), 'нет поля для P2P-билета');
      assert(document.querySelector('#join-name'), 'нет поля имени');
      assert(document.querySelector('#btn-join-p2p'), 'нет кнопки подключения по P2P');
      document.querySelector('[data-back]').click();
    });

    check('вход по сетевому адресу убран', () => {
      assert(!document.querySelector('#join-address'), 'осталось поле ввода адреса');
      assert(!document.querySelector('#btn-join'), 'осталась кнопка подключения по адресу');
    });

    /* --------------------------------------------- подготовка листа и выбор */

    // Библиотека листов проверяется на настоящем хранилище: важно, что лист
    // переживает перезапуск окна, а не держится в памяти контроллера.
    localStorage.removeItem('dnd-table.sheetLibrary');
    // Черновик на время проверок меняется, а дальше по файлу от него ждут
    // тренировочный лист: запоминаем и вернём в конце блока.
    const trainingPlayerIdEarly = localStorage.getItem('dnd-table.playerId');
    const draftBefore = window.LocalTable.readDraft(trainingPlayerIdEarly);

    document.querySelector('#btn-go-sheet').click();
    check('карточка «Создать лист персонажа» открывает редактор', () => {
      assert(document.querySelector('#screen-sheet').classList.contains('is-active'), 'экран редактора не открылся');
      assert(document.querySelector('#sheet-editor-root.sheet'), 'в редакторе нет листа');
      assert(document.querySelector('#btn-sheet-save'), 'нет кнопки сохранения');
    });

    check('у редактора нет кнопки «Отдельным окном»: лист и есть окно', () => {
      const detach = [...document.querySelectorAll('#sheet-editor-root .btn')]
        .find((button) => button.textContent.includes('Отдельным окном'));
      assert(detach, 'у редактора вообще нет такой кнопки');
      // Кнопка остаётся в разметке, скрыта атрибутом hidden: элемент с ним не
      // исчезает из DOM, и искать надо именно скрытость.
      assert(detach.hidden, 'кнопка отдельного окна показана на экране подготовки');
      assert(getComputedStyle(detach).display === 'none', 'скрытая кнопка всё равно видна');
    });

    // Заполняем лист как человек. Поле ищем по подписи, а не по порядку: он
    // меняется вместе с листом, и проверка посыпалась бы от первого же
    // переименования поля.
    const editor = document.querySelector('#sheet-editor-root');
    const fillField = (label, value) => {
      const field = [...editor.querySelectorAll('.field')]
        .find((node) => node.querySelector('.field__label')
          && node.querySelector('.field__label').textContent === label);
      assert(field, `в листе нет поля «${label}»`);
      const input = field.querySelector('input, select, textarea');
      input.value = value;
      // Лист слушает именно input: change на текстовом поле не срабатывает.
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input;
    };
    fillField('Имя персонажа', 'Тордин');
    // Класс теперь первый в блоке «Классы»: поле ищется по data-field, а не по
    // подписи, потому что строк класса может быть несколько.
    const classSelect = editor.querySelector('[data-field="charClass"]');
    assert(classSelect, 'в листе нет списка классов');
    classSelect.value = 'Волшебник';
    classSelect.dispatchEvent(new Event('input', { bubbles: true }));
    fillField('Раса', 'Дварф');

    check('правка листа сохраняет его на этом компьютере', () => {
      const sheets = window.LocalTable.listLocalSheets();
      assert(sheets.length === 1, `листов в библиотеке: ${sheets.length}`);
      assert(sheets[0].characterName === 'Тордин', `в библиотеке: ${sheets[0].characterName}`);
      const status = document.querySelector('#sheet-editor-status').textContent;
      assert(status.includes('Сохранено'), `подтверждение не показано: ${status}`);
    });

    document.querySelector('#btn-sheet-save').click();
    check('кнопка «Сохранить лист» подтверждает сохранение', () => {
      assert(document.querySelector('#sheet-editor-status').textContent.includes('сохранён'),
        document.querySelector('#sheet-editor-status').textContent);
    });

    document.querySelector('#btn-sheet-back').click();
    check('из редактора возвращаемся на главный экран', () => {
      assert(document.querySelector('#screen-home').classList.contains('is-active'), 'вернулись не туда');
    });

    // Второй лист: библиотека должна держать несколько, иначе выбору не из чего
    // выбирать.
    const firstId = window.LocalTable.listLocalSheets()[0].id;
    const mirror = JSON.parse(JSON.stringify(window.LocalTable.getLocalSheet(firstId).sheet));
    mirror.characterName = 'Мира';
    const secondId = window.LocalTable.upsertLocalSheet(mirror);
    check('библиотека держит несколько листов, а правка идёт на место', () => {
      assert(secondId !== firstId, 'второй лист получил тот же id');
      assert.strictEqual(window.LocalTable.listLocalSheets().length, 2);
      const same = window.LocalTable.upsertLocalSheet({ ...mirror, hp: 11 }, secondId);
      assert.strictEqual(same, secondId, 'правка создала новую запись вместо обновления');
      assert.strictEqual(window.LocalTable.listLocalSheets().length, 2, 'правка размножила лист');
      assert.strictEqual(window.LocalTable.getLocalSheet(secondId).sheet.hp, 11, 'правка не сохранена');
    });

    document.querySelector('#btn-go-join').click();
    check('на экране подключения виден выбор листа', () => {
      const rows = [...document.querySelectorAll('#join-sheets .sheet-choice__item')];
      assert(rows.length === 2, `строк в списке листов: ${rows.length}`);
      const text = document.querySelector('#join-sheets').textContent;
      assert(text.includes('Тордин') && text.includes('Мира'), `в списке: ${text}`);
      assert(document.querySelector('#btn-join-new-sheet'), 'нет кнопки «Создать новый лист»');
      // Лист, который только что правили, и есть выбранный: правка обновила
      // черновик, а черновик уезжает на стол.
      assert(rows.some((row) => row.classList.contains('is-selected')), 'ни один лист не выбран');
      assert(!document.querySelector('#btn-join-edit-sheet').hidden, 'правка выбранного листа не предложена');
    });

    check('взятый лист становится черновиком, который уедет на стол', () => {
      const miraRow = [...document.querySelectorAll('#join-sheets .sheet-choice__item')]
        .find((row) => row.textContent.includes('Мира'));
      miraRow.querySelector('.btn--accent').click();
      // Список перерисовывается целиком, поэтому старую строку смотреть
      // бесполезно: отмечена будет новая.
      const selected = [...document.querySelectorAll('#join-sheets .sheet-choice__item.is-selected')];
      assert(selected.length === 1, `выбранных листов: ${selected.length}`);
      assert(selected[0].textContent.includes('Мира'), `выбран не тот лист: ${selected[0].textContent}`);
      const draft = window.LocalTable.readDraft(localStorage.getItem('dnd-table.playerId'));
      assert(draft && draft.characterName === 'Мира', `в черновике: ${draft && draft.characterName}`);
    });

    check('удаление листа убирает его из выбора', () => {
      const miraRow = [...document.querySelectorAll('#join-sheets .sheet-choice__item')]
        .find((row) => row.textContent.includes('Мира'));
      [...miraRow.querySelectorAll('.btn')].find((button) => button.textContent.includes('Удалить')).click();
      const rows = [...document.querySelectorAll('#join-sheets .sheet-choice__item')];
      assert(rows.length === 1, `после удаления строк: ${rows.length}`);
      assert(!rows[0].textContent.includes('Мира'), 'удалённый лист остался в списке');
    });

    document.querySelector('[data-back]').click();

    // Возвращаем черновик, какой был до этих проверок: дальше по файлу идут
    // сценарии тренировочного стола, и им нужен именно он.
    window.LocalTable.saveDraft(trainingPlayerId, draftBefore);

    document.querySelector('#btn-go-create').click();
    check('кнопка «Создать новую кампанию» открывает экран создания', () => {
      assert(document.querySelector('#screen-create').classList.contains('is-active'), 'экран создания не открылся');
      assert(document.querySelector('#create-name'), 'нет поля названия кампании');
    });

    document.querySelector('#create-name').value = 'Смоук-кампания';
    document.querySelector('#btn-create-start').click();
    await waitFor(() => document.querySelector('#screen-table').classList.contains('is-active'), 'экран стола');
    await waitFor(() => document.querySelector('#addresses-root').textContent.trim().length > 0, 'панель приглашения');
    // Панель карты и участники заполняются, когда ДМ войдёт за стол: до этого
    // в окне ещё могут оставаться данные прошлого стола (например, тренировки).
    await waitFor(() => document.querySelector('#role-badge').textContent === 'ДМ', 'роль ДМ в окне');
    await waitFor(() => document.querySelector('#players-root .badge--dm'), 'ДМ в списке участников');
    await waitFor(() => {
      const empty = document.querySelector('#map-root .map-empty');
      return empty && !empty.hidden;
    }, 'новая кампания с пустой картой');

    check('ДМ попал на экран стола, сервер поднялся, роль определена', () => {
      assert(document.querySelector('#role-badge').textContent === 'ДМ', 'роль не ДМ');
      assert(document.querySelector('#conn-badge').textContent === 'на связи', 'нет связи с сервером');
      assert(document.querySelector('#table-campaign').textContent === 'Смоук-кампания', 'название кампании');
      assert(document.querySelector('#table-sub').textContent.includes('порт'), 'нет порта в подзаголовке');
    });
    check('кнопки управления кампанией видны только ДМ', () => {
      assert(!document.querySelector('#btn-save-campaign').hidden, 'нет кнопки сохранения кампании');
      assert(!document.querySelector('#btn-stop-host').hidden, 'нет кнопки остановки стола');
      assert(!document.querySelector('#addresses-panel').hidden, 'нет панели приглашения');
    });
    check('панель приглашения не показывает ни одного сетевого адреса', () => {
      const panel = document.querySelector('#addresses-panel');
      assert(!/https?:\/\/(127\.0\.0\.1|10\.|192\.168\.)/.test(panel.textContent),
        `в панели остался адрес: ${panel.textContent.slice(0, 160)}`);
      assert(!panel.querySelector('.addr-group--porthole'), 'остался блок Porthole');
      assert(!panel.textContent.includes('Porthole'), 'осталось упоминание Porthole');
      assert(!panel.textContent.includes('Hamachi') && !panel.textContent.includes('ZeroTier'),
        'остались упоминания виртуальных сетей');
    });
    check('панель приглашения показывает билет и способ подключения', () => {
      const panel = document.querySelector('#addresses-panel');
      const text = panel.textContent.replace(/\s+/g, ' ');
      const ticket = panel.querySelector('.addr__url--ticket');
      if (ticket) {
        // Заголовок блока есть только когда билет уже получен: без билета
        // панель говорит, что он готовится, и блока с ним нет.
        assert(panel.querySelector('.addr-group__title'), 'нет заголовка блока');
        // iroh поднялся: билет обязан быть на месте целиком и копироваться.
        assert(ticket.textContent.length > 20, `билет подозрительно короткий: ${ticket.textContent}`);
        assert(!ticket.textContent.includes('…'), 'билет показан обрезанным');
      } else {
        // iroh не поднялся (нет сети в проверке) — тогда панель обязана
        // честно сказать об этом, а не делать вид, что всё в порядке.
        assert(/Билет готовится|P2P недоступен/.test(text), `нет ни билета, ни сообщения: ${text}`);
      }
    });
    check('подсказка про P2P есть, требования общей сети нет', () => {
      const hint = document.querySelector('#addresses-panel .hint').textContent.replace(/\s+/g, ' ');
      assert(hint.includes('P2P-билет'), `нет упоминания билета: ${hint}`);
      assert(!hint.includes('виртуальной сети'), `осталось требование общей сети: ${hint}`);
    });
    check('панель приглашения сворачивается и разворачивается', () => {
      const toggle = document.querySelector('#addresses-toggle');
      assert(toggle, 'нет кнопки сворачивания');
      toggle.click();
      const panel = document.querySelector('#addresses-panel');
      assert(panel.classList.contains('is-collapsed'), 'панель не свернулась');
      const summary = document.querySelector('#addresses-summary');
      assert(!summary.hidden && summary.textContent.trim().length > 0, `пустая сводка при закрытой панели: ${summary.textContent}`);
      assert(!summary.textContent.includes('http://'), `в сводке остался адрес: ${summary.textContent}`);
      toggle.click();
      assert(!panel.classList.contains('is-collapsed'), 'панель не развернулась');
      assert(document.querySelector('#addresses-summary').hidden, 'сводка осталась при открытой панели');
    });
    check('карта стола показывает заглушку', () => {
      const empty = document.querySelector('#map-root .map-empty__text');
      assert(empty && empty.textContent.includes('Карта ещё не загружена ДМ'), 'нет заглушки карты');
      assert(!document.querySelector('#map-root .map-empty').hidden, 'заглушка скрыта');
    });
    check('карта занимает середину, а не трек разделителя', () => {
      // Порядок треков грида обязан совпадать с порядком детей: иначе карта
      // уезжает в шестипиксельный трек разделителя и схлопывается в столбик
      // кнопок. Проверяем геометрией, а не наличием элементов: сломанный
      // порядок даёт все элементы на месте.
      const width = (sel) => document.querySelector(sel).getBoundingClientRect().width;
      const left = document.querySelector('.col--left').getBoundingClientRect();
      const center = document.querySelector('.col--center').getBoundingClientRect();
      const resizer = document.querySelector('#resizer-right').getBoundingClientRect();
      const right = document.querySelector('.col--right').getBoundingClientRect();
      assert(width('.col--center') > 300, `карта схлопнулась: ${width('.col--center')}px`);
      assert(width('.col--right') > 300, `правая колонка схлопнулась: ${width('.col--right')}px`);
      assert(
        left.right <= center.left + 1
        && center.right <= resizer.left + 1
        && resizer.right <= right.left + 1,
        `колонки стоят не по порядку: ${[left.right, center.left, center.right, resizer.left, resizer.right, right.left].map(Math.round).join(' → ')}`
      );
    });
    check('панели стола сворачиваются, а иконки вкладок остаются', () => {
      const layout = document.querySelector('.layout');
      const leftButton = document.querySelector('#btn-panel-left');
      const rightButton = document.querySelector('#btn-panel-right');
      assert(leftButton && rightButton, 'нет кнопок сворачивания панелей');

      leftButton.click();
      assert(layout.classList.contains('is-left-collapsed'), 'левая панель не свернулась');
      // Левая панель сворачивается нулевой шириной, а не display:none:
      // так она остаётся в grid-треке и не вызывает переполнение (см. styles.css).
      const leftWidth = document.querySelector('.col--left').getBoundingClientRect().width;
      assert(leftWidth < 1, `левая панель осталась видна (ширина ${leftWidth}px)`);
      leftButton.click();
      assert(!layout.classList.contains('is-left-collapsed'), 'левая панель не вернулась');

      rightButton.click();
      assert(layout.classList.contains('is-right-collapsed'), 'правая панель не свернулась');
      // Подписи вкладок при свернутой узкой панели спрятаны, иконки остаются.
      // Вкладка справочника приключения появляется только после импорта, а
      // вкладок со временем станет больше: считаем по содержимому, а не
      // зашитым числом.
      const tabButtons = [...document.querySelectorAll('.tabs__btn:not([hidden])')];
      const labels = [...document.querySelectorAll('.tabs__btn:not([hidden]) .tabs__label')];
      assert(labels.length === tabButtons.length, `подписей ${labels.length} при вкладках ${tabButtons.length}`);
      assert(labels.every((node) => getComputedStyle(node).display === 'none'), 'подписи вкладок остались видны');
      assert(
        tabButtons.every((button) => button.querySelector('.tabs__icon')),
        'у вкладки нет иконки'
      );

      document.querySelector('.tabs__btn[data-tab="dice"]').click();
      assert(!layout.classList.contains('is-right-collapsed'), 'панель не развернулась по клику на иконку');
      assert(document.querySelector('#tab-dice').classList.contains('is-active'), 'вкладка кубиков не открылась');
    });
    check('вкладки переключаются цифрами, а последняя запоминается', () => {
      const press = (key, extra = {}) => document.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, ...extra })
      );
      press('3');
      assert(document.querySelector('#tab-sheet').classList.contains('is-active'), `цифра 3 не открыла вкладку: ${[...document.querySelectorAll('.panel--tab.is-active')].map((node) => node.id)}`);
      assert(localStorage.getItem('dnd-table.activeTab') === 'sheet', 'вкладка не записана в память');
      press('9');
      assert(document.querySelector('#tab-chat').classList.contains('is-active') === false, 'цифра вне диапазона что-то открыла');
      // В поле ввода цифра должна оставаться цифрой: иначе «2» в формуле броска
      // переключала бы вкладку вместо того, чтобы попасть в поле.
      const input = document.querySelector('#tab-dice .input');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
      assert(document.querySelector('#tab-sheet').classList.contains('is-active'), 'цифра в поле переключила вкладку');
    });
    check('Ctrl+F открывает поиск по чату', () => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'f', ctrlKey: true, bubbles: true, cancelable: true
      }));
      assert(document.querySelector('#tab-chat').classList.contains('is-active'), 'Ctrl+F не открыл чат');
      const search = document.querySelector('#tab-chat .chat__search-input');
      assert(search && document.activeElement === search, `фокус не в поиске: ${document.activeElement && document.activeElement.className}`);
    });
    check('правую колонку можно перетянуть мышью и она помнит ширину', () => {
      const layout = document.querySelector('.layout');
      const resizer = document.querySelector('#resizer-right');
      assert(resizer, 'нет разделителя правой колонки');
      const rightWidth = () => Math.round(document.querySelector('.col--right').getBoundingClientRect().width);
      const before = rightWidth();
      resizer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 1200 }));
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 1000 }));
      const width = layout.style.getPropertyValue('--right-user-width');
      assert(width.endsWith('px') && parseFloat(width) > 0, `ширина не задана: "${width}"`);
      assert(rightWidth() > before, `колонка не выросла: ${before} → ${rightWidth()}`);
      assert(localStorage.getItem('dnd-table.rightWidth') === String(Math.round(parseFloat(width))),
        `ширина не записана: ${localStorage.getItem('dnd-table.rightWidth')} против ${width}`);
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      assert(!document.body.classList.contains('is-resizing'), 'курсор перетаскивания не снят');
      // Ширина не должна съезжать при сворачивании панели: сворачивание меняет
      // --right-col, а выбранная мастером ширина живёт в отдельной переменной.
      document.querySelector('#btn-panel-right').click();
      assert(rightWidth() === 54, `свёрнутая колонка не сузилась до иконок: ${rightWidth()}`);
      document.querySelector('#btn-panel-right').click();
      assert(rightWidth() === Math.round(parseFloat(width)), 'разворачивание вернуло не ту ширину');
      // Стрелки с клавиатуры двигают разделитель без мыши.
      const beforeArrow = rightWidth();
      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
      const afterArrow = rightWidth();
      assert(afterArrow < beforeArrow, `стрелка влево не сузила панель: ${beforeArrow} → ${afterArrow}`);
      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }));
      assert(rightWidth() > afterArrow, 'стрелка вправо не расширила панель');
      localStorage.removeItem('dnd-table.rightWidth');
      layout.style.removeProperty('--right-user-width');
    });
    check('ДМ виден в списке участников с ролью', () => {
      assert(document.querySelector('#players-root .badge--dm'), 'нет бейджа ДМ');
      assert(document.querySelector('#players-root').textContent.includes('Мастер'), 'нет имени ДМ');
    });

    document.querySelector('.tabs__btn[data-tab="sheet"]').click();
    check('вкладка «Лист» у ДМ без игрока зовёт в панель участников, а не показывает пустой лист', () => {
      assert(document.querySelector('#tab-sheet').classList.contains('is-active'), 'вкладка не активна');
      const pick = document.querySelector('#tab-sheet .sheet__pick');
      assert(pick && !pick.hidden, 'нет подсказки выбора игрока');
      assert(pick.textContent.includes('Участники'),
        `подсказка не зовёт в панель участников: ${pick.textContent.slice(0, 80)}`);
      assert(document.querySelector('#tab-sheet .sheet__grid').hidden, 'лист показан, хотя игрок ещё не выбран');
    });

    /* ------------------------- второй участник: подключение игрока по сети */

    const hostInfo = await window.desktop.hostStatus();
    const playerSocket = window.io(hostInfo.localUrl, { transports: ['websocket'], forceNew: true });
    const playerInbox = { joined: null, errors: [], tokens: [], hidden: [], grid: null, maps: [] };
    playerSocket.on('joined', (payload) => { playerInbox.joined = payload; });
    playerSocket.on('errorMessage', (message) => playerInbox.errors.push(message.message));
    playerSocket.on('tokenCreated', (token) => playerInbox.tokens.push(token));
    playerSocket.on('tokenHidden', (event) => playerInbox.hidden.push(event));
    playerSocket.on('gridUpdated', (grid) => { playerInbox.grid = grid; });
    playerSocket.on('mapUpdated', (update) => playerInbox.maps.push(update));

    await new Promise((resolve, reject) => {
      playerSocket.on('connect', resolve);
      playerSocket.on('connect_error', (error) => reject(new Error(`игрок не подключился: ${error.message}`)));
    });
    const playerAck = await new Promise((resolve) => {
      playerSocket.emit('joinRoom', { name: 'Борис', playerId: 'p-smoke-1' }, resolve);
    });

    check('игрок подключается к столу по адресу и получает роль player', () => {
      assert(playerAck.ok === true, `отказ: ${playerAck.error}`);
      assert(playerAck.you.role === 'player', `роль: ${playerAck.you.role}`);
      assert(playerAck.you.playerId === 'p-smoke-1', 'playerId не совпадает с локальным');
    });
    check('игрок получил только свой лист персонажа', () => {
      const sheets = playerInbox.joined.state.sheets;
      assert(Object.keys(sheets).length === 1, `листов в снимке: ${Object.keys(sheets).length}`);
      assert(Object.keys(sheets)[0] === 'p-smoke-1', 'чужой лист в снимке');
    });

    playerSocket.emit('saveCharacterSheet', {
      sheet: {
        playerName: 'Борис', characterName: 'Мира', charClass: 'Волшебница', race: 'Полуэльф',
        level: 9,
        abilities: { str: 8, dex: 16, con: 12, int: 18, wis: 13, cha: 11 },
        skillProficiencies: { arcana: true },
        hitDice: '1d6', hp: 48, maxHp: 48, armorClass: 13, speed: 30
      }
    });

    const playerRow = await waitFor(
      () => [...document.querySelectorAll('#players-root .player-row')]
        .find((row) => row.textContent.includes('Борис')),
      'игрок в списке у ДМ'
    );
    check('подключившийся игрок появился в списке участников у ДМ', () => {
      assert(playerRow.querySelector('.dot--on'), 'игрок не помечен как в сети');
      assert(playerRow.querySelector('.badge--player'), 'нет роли «игрок»');
      // Кнопку ищем по тексту: в строке их может быть несколько, и «первая
      // кнопка в строке» перестала быть «Открыть лист», когда рядом появилась
      // кнопка вывода фишки.
      const openButton = [...playerRow.querySelectorAll('button')]
        .find((node) => node.textContent === 'Открыть лист');
      assert(openButton, 'нет кнопки открытия листа');
    });

    /*
     * Кнопка вывода фишки.
     *
     * Долгое время проверялось только, что кнопка есть, и этого хватало: рядом
     * с «Открыть лист» она стоит, нажимается и не выдаёт ошибки, а вот что по
     * нажатию на столе появляется фишка, не проверялось нигде. Проверяем теперь
     * само действие: клик по кнопке у живого стола с живым игроком.
     */
    const spawnButton = [...playerRow.querySelectorAll('button')]
      .find((node) => node.textContent === 'Вывести');
    check('у игрока без фишки есть кнопка вывода', () => {
      assert(spawnButton, `в строке игрока нет кнопки «Вывести»: ${
        [...playerRow.querySelectorAll('button')].map((node) => node.textContent).join(' | ')}`);
    });
    // Смотрим на тосты сразу после нажатия: сервер на отказ отвечает ошибкой,
    // и без неё кнопка выглядит просто мёртвой. И считаем фишки ДО нажатия:
    // в таблице уже есть фишка по имени «Мира», и сравнение с ней дало бы
    // ложное «сработало».
    const tokenRows = () => [...document.querySelectorAll('#tab-tokens .token-row')]
      .map((row) => row.textContent.replace(/\s+/g, ' ').trim());
    const tokensBefore = new Set(tokenRows());
    spawnButton.click();

    const spawned = await waitFor(
      () => tokenRows().find((text) => !tokensBefore.has(text) && text.includes('Мира')),
      'новая фишка из листа'
    ).catch(() => null);

    check('нажатие на «Вывести» создаёт фишку из листа', () => {
      const toasts = [...document.querySelectorAll('#toasts .toast')].map((node) => node.textContent);
      assert(spawned, `новая фишка не появилась. Строки фишек: ${JSON.stringify(tokenRows())}. `
        + `Тосты: ${JSON.stringify(toasts)}`);
      // Имя берётся из листа, а не из строки участника: у листа оно своё.
      assert(spawned.includes('Мира'), `имя фишки: ${spawned}`);
      assert(spawned.includes('Скрыта'), `выведенная фишка должна быть скрыта от игроков: ${spawned}`);
    });
    check('после вывода кнопка в строке игрока исчезает', async () => {
      const row = [...document.querySelectorAll('#players-root .player-row')]
        .find((node) => node.textContent.includes('Борис'));
      assert(row, 'строка игрока пропала');
      const still = [...row.querySelectorAll('button')]
        .some((node) => node.textContent === 'Вывести');
      assert(!still, 'кнопка «Вывести» осталась у игрока с фишкой');
    });

    // Убираем за собой: дальше идут проверки, где лишней фишки быть не должно.
    const spawnedRow = [...document.querySelectorAll('#tab-tokens .token-row')]
      .find((row) => spawned && row.textContent.includes('Мира') && !tokensBefore.has(row.textContent.replace(/\s+/g, ' ').trim()));
    check('выведенную фишку можно убрать со стола', () => {
      assert(spawnedRow, 'строка выведенной фишки не найдена');
    });
    if (spawnedRow) spawnedRow.querySelector('button.btn--danger').click();

    // Дальше идёт блок про лист игрока, и он кликает по кнопке, найденной в
    // строке участника. Если строка вдруг не нашлась, падать надо здесь и
    // сказать почему, а не через двадцать строк на «querySelector of
    // undefined», где причина уже не видна.
    const borisRow = [...document.querySelectorAll('#players-root .player-row')]
      .find((node) => node.textContent.includes('Борис'));
    check('строка игрока на месте после вывода фишки', () => {
      assert(borisRow, `строка «Борис» пропала: ${
        [...document.querySelectorAll('#players-root .player-row')].map((n) => n.textContent).join(' | ')}`);
    });

    const openSheetButton = [...playerRow.querySelectorAll('button')]
      .find((node) => node.textContent === 'Открыть лист');
    openSheetButton.click();
    await waitFor(
      () => document.querySelector('#tab-sheet .sheet__status').textContent.includes('Просмотр'),
      'лист игрока у ДМ'
    );
    check('ДМ открывает лист игрока и видит актуальные данные', () => {
      assert(document.querySelector('#tab-sheet').classList.contains('is-active'), 'вкладка листа не открылась');
      const name = document.querySelector('#tab-sheet [data-field="characterName"]');
      assert(name.value === 'Мира', `имя в листе: ${name.value}`);
      assert(document.querySelector('#tab-sheet [data-field="charClass"]').value === 'Волшебница', 'класс');
      assert(document.querySelector('#tab-sheet .sheet__pick').hidden, 'подсказка выбора игрока осталась поверх листа');
    });
    check('лист открыт ДМ только для просмотра и пересчитан по 5e', () => {
      assert(document.querySelector('#tab-sheet').classList.contains('is-readonly'), 'лист не в режиме просмотра');
      assert(document.querySelector('#tab-sheet [data-field="characterName"]').disabled, 'ДМ может печатать в листе');
      assert(document.querySelector('#tab-sheet [data-derived="profBonus"]').textContent === '+4',
        'бонус мастерства для 9 уровня');
      const arcana = document.querySelector('#tab-sheet [data-skill="arcana"]').parentElement;
      assert(arcana.querySelector('.prof-row__value').textContent === '+8',
        `Магия с владением: 4 + 4 = 8, получено ${arcana.querySelector('.prof-row__value').textContent}`);
    });

    // Из листа ДМ возвращается к списку игроков и открывает лист по имени.
    const backButton = [...document.querySelectorAll('#tab-sheet .sheet__head-tools button')]
      .find((node) => node.textContent.includes('К списку игроков'));
    check('из листа игрока можно вернуться к списку игроков', () => {
      assert(backButton && !backButton.hidden, 'нет кнопки возврата');
      backButton.click();
      assert(!document.querySelector('#tab-sheet .sheet__pick').hidden, 'подсказка выбора игрока не вернулась');
      assert(document.querySelector('#tab-sheet .sheet__grid').hidden, 'лист остался открытым');
    });
    check('список игроков с листами живёт в панели участников слева', () => {
      const row = [...document.querySelectorAll('#players-root .player-row')]
        .find((node) => node.textContent.includes('Борис'));
      assert(row, 'игрока нет в панели участников');
      assert(row.textContent.includes('в сети'), `нет статуса игрока в строке: ${row.textContent}`);
      const open = [...row.querySelectorAll('button')]
        .find((node) => node.textContent === 'Открыть лист');
      assert(open, 'в панели участников нет кнопки «Открыть лист»');
      open.click();
      assert(document.querySelector('#tab-sheet [data-field="characterName"]').value === 'Мира',
        'лист не открылся из панели участников');
      assert(!document.querySelector('#tab-sheet .sheet__grid').hidden, 'форма листа не показана');
    });

    // Лист можно вынести в отдельное окно — панель стола при этом убирается.
    const detachButton = [...document.querySelectorAll('#tab-sheet .sheet__head-tools button')]
      .find((node) => node.textContent.includes('Отдельным окном'));
    check('лист игрока можно вынести в отдельное окно', () => {
      assert(detachButton, 'нет кнопки «Отдельным окном»');
      assert(!document.querySelector('.layout').classList.contains('is-right-collapsed'), 'панель уже свёрнута');
      detachButton.click();
    });
    const sheetDetached = await softWait(
      () => document.querySelector('.layout').classList.contains('is-right-collapsed'),
      'панель свернулась после выноса листа',
      10000
    );
    check('после выноса листа панель стола сворачивается до иконок', () => {
      assert(sheetDetached, 'панель не свернулась после выноса листа');
      assert(getComputedStyle(document.querySelector('.tabs__label')).display === 'none', 'подписи вкладок остались видны');
    });

    // --- Настройки: сетка и размер клетки уходят всему столу ---
    document.querySelector('#btn-settings-table').click();
    check('кнопка «Настройки» открывает окно с данными приложения и настройками стола', () => {
      const overlay = document.querySelector('.modal-overlay');
      assert(overlay, 'окно настроек не открылось');
      const text = overlay.textContent;
      assert(text.includes('Версия'), 'нет версии приложения');
      // Версию ожидаемую подставляет packaged-smoke из package.json:
      // зашитая здесь строка ломалась бы при каждой смене версии.
      const expectedVersion = window.__EXPECTED_VERSION__;
      assert(expectedVersion, 'не передалась ожидаемая версия приложения');
      assert(text.includes(expectedVersion), `версия в настройках: ${text.replace(/\s+/g, ' ').slice(0, 90)}`);
      assert(text.includes('Папка данных'), 'нет папки данных');
      assert(text.includes('Язык интерфейса'), 'нет раздела языка');
      assert(text.includes('Сетка на карте'), 'нет настройки сетки');
      assert(overlay.querySelector('[data-setting="language"]'), 'нет выбора языка');
    });
    check('настройки стола доступны ДМ', () => {
      const grid = document.querySelector('.modal-overlay [data-setting="grid"]');
      const cell = document.querySelector('.modal-overlay [data-setting="cell"]');
      assert(grid && !grid.disabled, 'настройка сетки недоступна ДМ');
      assert(cell && !cell.disabled, 'настройка размера клетки недоступна ДМ');
    });
    check('в настройках есть журнал кампании и выгрузка сессии', () => {
      const overlay = settingsOverlay();
      assert(overlay.querySelector('.settings__textarea'), 'нет поля журнала');
      assert(overlay.textContent.includes('Журнал кампании'), 'нет раздела журнала');
      assert(byText(overlay, 'Экспорт сессии в Markdown'), 'нет кнопки выгрузки сессии');
    });

    document.querySelector('.modal-overlay [data-setting="grid"]').click();
    await waitFor(() => playerInbox.grid && playerInbox.grid.enabled === true, 'сетка у игрока');
    check('сетка, включённая ДМ, появляется на карте у всех участников', () => {
      const grid = document.querySelector('#map-root .map-grid');
      assert(grid && !grid.hidden, 'сетка не показана на карте у ДМ');
      assert(playerInbox.grid.enabled === true, 'игрок не получил состояние сетки');
    });

    check('положение панели вкладок выбирается и переносит её под карту', () => {
      const select = settingsOverlay().querySelector('[data-setting="panelPosition"]');
      assert(select, 'в настройках нет выбора положения панели');
      const labels = [...select.options].map((option) => option.textContent);
      assert(labels.some((text) => /Справа/.test(text)), `нет варианта «Справа»: ${labels.join(', ')}`);
      assert(labels.some((text) => /Снизу/.test(text)), `нет варианта «Снизу»: ${labels.join(', ')}`);
      const layout = document.querySelector('#screen-table .layout');
      assert(!layout.classList.contains('is-right-bottom'), 'панель снизу до выбора уже стоит внизу');
      select.value = 'bottom';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      assert(layout.classList.contains('is-right-bottom'), 'панель не уехала под карту');
      assert(window.localStorage.getItem('dnd-table.rightPanelPos') === 'bottom', 'выбор не сохранился');
      select.value = 'right';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      assert(!layout.classList.contains('is-right-bottom'), 'панель не вернулась вбок');
    });

    // Ожидания стоят между проверками, а не внутри них: check() вызывает
    // функцию и не ждёт её, и ожидание внутри проверки просто не отработало бы.
    const gridColumns = settingsOverlay().querySelector('[data-setting="columns"]');
    check('сетку кладут на карту с половиной клетки', () => {
      assert(gridColumns, 'нет поля «клеток по ширине карты»');
      assert.strictEqual(gridColumns.step, '0.5', `шаг у числа клеток: ${gridColumns.step}`);
    });
    gridColumns.value = '43.5';
    gridColumns.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => playerInbox.grid && playerInbox.grid.columns === 43.5, 'полклетки у игрока');
    check('полклетка доезжает до всех участников', () => {
      assert.strictEqual(playerInbox.grid.columns, 43.5, 'игрок получил другое число клеток');
    });

    const gridOffsetX = settingsOverlay().querySelector('[data-setting="offsetX"]');
    const gridOffsetY = settingsOverlay().querySelector('[data-setting="offsetY"]');
    check('у сетки есть сдвиг по обеим осям', () => {
      assert(gridOffsetX && gridOffsetY, 'нет сдвига сетки');
    });
    gridOffsetX.value = '12';
    gridOffsetY.value = '-7';
    gridOffsetX.dispatchEvent(new Event('change', { bubbles: true }));
    // Ждём и сокета мастера: окно настроек обновляется отдельным событием, и
    // без этого ожидания правка ниже ушла бы со старым числом клеток.
    await waitFor(() => gridOffsetX.value === '12' && gridOffsetY.value === '-7',
      'окно настроек показало сдвиг');
    await waitFor(() => playerInbox.grid && playerInbox.grid.offsetX === 12, 'сдвиг сетки у игрока');
    check('сдвиг сетки кладёт её на клетки самой карты', () => {
      assert.strictEqual(playerInbox.grid.offsetY, -7, 'вертикальный сдвиг не доехал');
      const surface = document.querySelector('#map-root .map-surface');
      assert.strictEqual(surface.style.getPropertyValue('--grid-shift-x'), '12px',
        `сдвиг на карте: ${surface.style.getPropertyValue('--grid-shift-x')}`);
    });

    // Возврат делаем повторяющимся: ответ сервера приходит отдельным событием,
    // и одна попытка успевает проиграть с той, что ушла раньше. Проверки ниже
    // меряют сетку, и оставшийся сдвиг или полклетки сбили бы их все.
    const gridFields = () => ({
      columns: settingsOverlay().querySelector('[data-setting="columns"]'),
      offsetX: settingsOverlay().querySelector('[data-setting="offsetX"]'),
      offsetY: settingsOverlay().querySelector('[data-setting="offsetY"]')
    });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const fields = gridFields();
      const dirty = [
        [fields.columns, '0'],
        [fields.offsetX, '0'],
        [fields.offsetY, '0']
      ].filter(([field, wanted]) => field.value !== wanted);
      if (!dirty.length) break;
      if (dirty.some(([field]) => field === fields.columns)) {
        fields.columns.value = '0';
        fields.columns.dispatchEvent(new Event('change', { bubbles: true }));
      }
      fields.offsetX.value = '0';
      fields.offsetY.value = '0';
      fields.offsetX.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(150);
    }
    check('после проверки точности сетки в окне не осталось её следов', () => {
      const fields = gridFields();
      assert.strictEqual(fields.columns.value, '0', `в окне число клеток: ${fields.columns.value}`);
      assert.deepStrictEqual([fields.offsetX.value, fields.offsetY.value], ['0', '0'],
        `в окне сдвиг: ${fields.offsetX.value}, ${fields.offsetY.value}`);
      assert.strictEqual(
        document.querySelector('#map-root .map-surface').style.getPropertyValue('--cell'), '46px',
        'после возврата сетки клетка снова задаётся вручную'
      );
    });

    const cellSelect = document.querySelector('.modal-overlay [data-setting="cell"]');
    cellSelect.value = '56';
    cellSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => playerInbox.grid && playerInbox.grid.cell === 56, 'новая клетка у игрока');
    check('размер клетки из настроек меняет и сетку, и размер фишки', () => {
      const surface = document.querySelector('#map-root .map-surface');
      assert(surface.style.getPropertyValue('--cell') === '56px',
        `клетка на карте: ${surface.style.getPropertyValue('--cell')}`);
      assert(playerInbox.grid.cell === 56, 'игрок не получил новый размер клетки');
    });

    document.querySelector('.modal-overlay .modal__actions button').click();
    check('окно настроек закрывается', () => {
      assert(!document.querySelector('.modal-overlay'), 'окно настроек осталось открытым');
    });

    const toolbarGridButton = [...document.querySelectorAll('#map-root .map-toolbar button')]
      .find((node) => node.textContent.startsWith('Сетка'));
    toolbarGridButton.click();
    await waitFor(() => playerInbox.grid && playerInbox.grid.enabled === false, 'сетка выключена у игрока');
    check('кнопка сетки в панели карты тоже управляет ею для всего стола', () => {
      assert(document.querySelector('#map-root .map-grid').hidden, 'сетка осталась на карте');
    });

    playerInbox.errors.length = 0;
    playerSocket.emit('requestCharacterSheet', { playerId: 'p-smoke-2' });
    await waitFor(() => playerInbox.errors.length > 0, 'отказ игроку в чужом листе');
    check('игрок не может запросить чужой лист персонажа', () => {
      assert(playerInbox.errors[0].includes('только свой лист'), `ответ: ${playerInbox.errors[0]}`);
    });

    /* ------------- загрузка карт через интерфейс ДМ (как это делает человек) */

    const mapFileInput = document.querySelector('#map-root .map-toolbar input[type="file"]');
    check('в панели карт ДМ есть поле выбора файла', () => {
      assert(mapFileInput, 'нет input[type=file] в панели карт');
      assert(mapFileInput.accept.includes('image/png'), `accept: ${mapFileInput.accept}`);
    });

    const toBytes = (dataUrl) => Uint8Array.from(atob(dataUrl.split(',')[1]), (character) => character.charCodeAt(0));
    const dropFile = (bytes, name, type) => {
      const input = document.querySelector('#map-root .map-toolbar input[type="file"]');
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name, { type }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    /** Диагностика на случай, если загрузка карты не дошла до стола. */
    const mapDiagnostics = () => {
      const image = document.querySelector('#map-root .map-image');
      const toasts = [...document.querySelectorAll('#toasts .toast')].map((node) => node.textContent);
      return `url=${image && image.dataset.url}, naturalWidth=${image && image.naturalWidth}, `
        + `surfaceHidden=${document.querySelector('#map-root .map-surface').hidden}, toasts=${JSON.stringify(toasts)}`;
    };

    dropFile(toBytes(MAP_PNG), 'world.png', 'image/png');
    let mapLoaded = true;
    try {
      await waitFor(() => {
        const image = document.querySelector('#map-root .map-image');
        return image && image.dataset.url && image.dataset.url.includes('/files/') && image.naturalWidth > 0;
      }, 'карта загрузилась и отобразилась', 10000);
    } catch {
      mapLoaded = false;
    }

    check('карта, выбранная ДМ, уходит на сервер и появляется на столе', () => {
      assert(mapLoaded, `карта не появилась на столе: ${mapDiagnostics()}`);
      assert(!document.querySelector('#map-root .map-surface').hidden, 'поверхность карты скрыта');
      assert(document.querySelector('#map-root .map-empty').hidden, 'заглушка «карта не загружена» осталась');
      const image = document.querySelector('#map-root .map-image');
      assert(image.src.startsWith('http://127.0.0.1:'), `картинку раздаёт не сервер: ${image.src.slice(0, 70)}`);
      const name = document.querySelector('#map-root .map-toolbar__name');
      assert(name && name.textContent.includes('world.png'), `имя карты не показано: ${name && name.textContent}`);
    });
    check('загруженная карта ещё не показана игрокам', () => {
      const tabs = [...document.querySelectorAll('#map-root .map-tab')];
      assert(tabs[0].classList.contains('is-active'), 'вкладка общей карты не активна');
      assert(!tabs[0].querySelector('.map-tab__dot').classList.contains('is-on'),
        'карта помечена показанной до нажатия кнопки');
      const show = [...document.querySelectorAll('#map-root .map-toolbar button')]
        .find((node) => node.textContent.includes('Показать игрокам'));
      assert(show && !show.disabled, 'нет кнопки «Показать игрокам» для заготовки');
    });
    playerInbox.maps.length = 0;
    [...document.querySelectorAll('#map-root .map-toolbar button')]
      .find((node) => node.textContent.includes('Показать игрокам')).click();
    const worldShown = await softWait(
      () => document.querySelectorAll('#map-root .map-tab')[0]
        .querySelector('.map-tab__dot').classList.contains('is-on'),
      'показ общей карты игрокам'
    );
    check('кнопка «Показать игрокам» открывает карту столу', () => {
      assert(worldShown, 'карта не помечена показанной после нажатия');
      assert(playerInbox.maps.some((update) => update.items && update.items.length === 1),
        'игрок не получил показанную карту');
    });

    /* ------------------------------- освещение: темнота, свет и стены */

    const lightHost = () => document.querySelector('#map-root');
    const openLightTab = () => {
      const tab = document.querySelector('#map-root .map-tab--light');
      assert(tab && !tab.hidden, 'нет вкладки «Свет» у мастера с картой');
      tab.click();
      return tab;
    };
    check('настройки света вынесены в отдельную вкладку', () => {
      const tab = document.querySelector('#map-root .map-tab--light');
      assert(tab, 'у карты нет вкладки «Свет»');
      assert(!tab.hidden, 'вкладка «Свет» спрятана у мастера с загруженной картой');
      assert(!document.querySelector('#map-root .fog-bar--light'), 'панель света осталась в тулбаре карты');
      openLightTab();
      const panel = document.querySelector('#map-root .map-lightbar');
      assert(panel && !panel.hidden, 'панель света не открылась на вкладке');
      assert(document.querySelector('#map-root .map-toolbar').hidden,
        'тулбар карты виден поверх вкладки света');
    });
    check('у игрока вкладки света нет', () => {
      // Проверяем на отдельной карте в песочнице: окно мастера сейчас в роли
      // мастера, и его вкладка света на месте так и должна быть.
      mapView.render(MAP_STATE, { role: 'player', playerId: 'p-1' });
      const tab = mapHost.querySelector('.map-tab--light');
      assert(tab, 'вкладки света нет вовсе');
      assert(tab.hidden, 'игрок видит вкладку света');
      assert(!mapHost.querySelector('.fog-bar--light'), 'панель света осталась в тулбаре карты');
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    });
    check('в панели света есть ползунки с подписями, инструменты и список', () => {
      const panel = document.querySelector('#map-root .map-lightbar');
      const labels = [...panel.querySelectorAll('.light-panel__label')].map((node) => node.textContent);
      assert(labels.some((text) => text.includes('Темнота')), `нет ползунка темноты: ${labels}`);
      assert(labels.some((text) => text.includes('Дальность')), `нет ползунка дальности: ${labels}`);
      assert(labels.some((text) => text.includes('Источник')), `нет выбора источника: ${labels}`);
      assert(panel.querySelector('[data-tool="light"]'), 'нет кнопки постановки света');
      assert(panel.querySelector('[data-tool="wall"]'), 'нет кнопки рисования стен');
      assert(panel.querySelector('.light-panel__title').textContent.includes('Источников'),
        'нет заголовка списка источников');
    });
    check('карта без темноты не рисует слой света', () => {
      const canvas = lightHost().querySelector('.map-light');
      assert(canvas.hidden, 'слой света виден на дневной карте');
    });
    check('ползунок темноты затемняет карту и уходит на сервер', () => {
      const slider = [...document.querySelectorAll('#map-root .map-lightbar input')]
        .find((node) => node.getAttribute('aria-label') === 'Темнота карты');
      slider.value = '70';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      const canvas = lightHost().querySelector('.map-light');
      assert(!canvas.hidden, 'слой света не появился при темноте 70%');
      assert(canvas.width > 0 && canvas.height > 0, `холст света пуст: ${canvas.width}x${canvas.height}`);
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const darknessApplied = await softWait(
      () => {
        const slider = [...document.querySelectorAll('#map-root .map-lightbar input')]
          .find((node) => node.getAttribute('aria-label') === 'Темнота карты');
        return slider && Math.round(Number(slider.value)) === 70;
      },
      'темнота доехала до стола'
    );
    check('сервер принял темноту карты', () => {
      assert(darknessApplied, 'темнота не доехала до стола');
    });
    check('поставленный факел вырезает пятно света и попадает в список', () => {
      const button = document.querySelector('#map-root [data-tool="light"]');
      assert(button, 'нет кнопки постановки света');
      button.click();
      const surface = document.querySelector('#map-root .map-surface');
      assert(surface.classList.contains('is-drawing-light'), 'режим постановки света не включился');
      const box = surface.getBoundingClientRect();
      surface.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0,
        clientX: box.left + box.width * 0.5, clientY: box.top + box.height * 0.5
      }));
      const chips = [...document.querySelectorAll('#map-root .light-row')];
      assert(chips.length >= 1, `источник света не появился в списке: ${chips.length}`);
      assert(chips[0].textContent.includes('фт'), `в строке нет дальности: ${chips[0].textContent}`);
    });
    check('сам источник на карте не виден: видно только свет', () => {
      // Точка на месте источника выдавала бы, где именно он стоит, и портила
      // бы карту. Управлять источником можно из списка, а не подсветкой.
      assert(!lightHost().querySelector('.map-light-source'), 'источник отмечен точкой на карте');
      const overlay = lightHost().querySelector('.map-walls');
      assert(overlay && !overlay.hidden, 'слой стен мастеру показан');
      assert(!overlay.querySelector('circle'), 'в слое стен появились кружки источников');
    });
    check('стена рисуется протяжкой и держит свет', () => {
      const wallButton = document.querySelector('#map-root [data-tool="wall"]');
      assert(wallButton, 'нет кнопки рисования стен');
      wallButton.click();
      const surface = document.querySelector('#map-root .map-surface');
      assert(surface.classList.contains('is-drawing-wall'), 'режим стен не включился');
      const box = surface.getBoundingClientRect();
      const at = (ratioX, ratioY) => ({
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        clientX: box.left + box.width * ratioX,
        clientY: box.top + box.height * ratioY
      });
      surface.dispatchEvent(new PointerEvent('pointerdown', at(0.5, 0.05)));
      surface.dispatchEvent(new PointerEvent('pointermove', at(0.5, 0.95)));
      const draft = surface.querySelector('.map-walls line.map-wall--draft');
      assert(draft, 'черновик стены не нарисован');
      surface.dispatchEvent(new PointerEvent('pointerup', at(0.5, 0.95)));
      assert(!surface.querySelector('.map-walls line.map-wall--draft'), 'черновик стены остался после отпускания мыши');
      assert(surface.querySelector('.map-walls line:not(.map-wall--draft)'), 'стена не осталась на карте');
    });
    const wallArrived = await softWait(
      () => document.querySelectorAll('#map-root .map-walls line:not(.map-wall--draft)').length >= 1,
      'стена доехала до стола'
    );
    check('стена сохранилась на сервере', () => {
      assert(wallArrived, 'стена не доехала до стола и не вернулась на карту');
    });
    check('правый клик по стене убирает её', () => {
      const surface = document.querySelector('#map-root .map-surface');
      const box = surface.getBoundingClientRect();
      surface.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: box.left + box.width * 0.5, clientY: box.top + box.height * 0.5
      }));
    });
    const wallGone = await softWait(
      () => document.querySelectorAll('#map-root .map-walls line').length === 0,
      'стена убрана на сервере'
    );
    check('снос стены дошёл до стола', () => {
      assert(wallGone, 'стена осталась на карте после удаления на сервере');
    });
    check('источник света пережил правку карты', () => {
      const chips = [...document.querySelectorAll('#map-root .light-row')];
      assert(chips.length >= 1, `источники света пропали: ${chips.length}`);
    });
    check('у игрока слоя темноты и стен не видно в интерфейсе', () => {
      // Игрок получает ту же карту со светом и стенами, но рисует их не может:
      // иначе он видел бы, где мастер поставил стену.
      const lit = JSON.parse(JSON.stringify(MAP_STATE));
      lit.maps.world.items[0].darkness = 0.8;
      lit.maps.world.items[0].walls = [{ id: 'w1', x1: 0.5, y1: 0, x2: 0.5, y2: 1 }];
      lit.maps.world.items[0].lights = [{ id: 'l1', x: 0.5, y: 0.5, radius: 20, color: '#ffb347' }];
      mapView.render(lit, { role: 'player', playerId: 'p-1' });
      const overlay = mapHost.querySelector('.map-walls');
      assert(overlay.hidden, 'игрок видит стены на карте');
      // А темноту он видит: иначе зачем она придумана.
      assert(!mapHost.querySelector('.map-light').hidden, 'игрок не видит темноту на карте');
      assert(!mapHost.querySelector('.map-lightbar') || mapHost.querySelector('.map-lightbar').hidden,
        'игроку показана панель освещения');
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    });
    check('погашенный источник перестаёт светить, но остаётся в списке', () => {
      const chips = [...document.querySelectorAll('#map-root .light-row')];
      const toggle = chips.map((chip) => [...chip.querySelectorAll('button')].map((node) => node.textContent));
      const found = chips.flatMap((chip) => [...chip.querySelectorAll('button')])
        .find((node) => node.textContent === 'Погасить');
      assert(found, `у источника света нет кнопки «Погасить»: ${JSON.stringify(toggle)}`);
      found.click();
    });
    const lightOff = await softWait(
      () => Boolean([...document.querySelectorAll('#map-root .light-row button')]
        .find((node) => node.textContent === 'Зажечь')),
      'источник погашен'
    );
    check('погашение источника дошло до стола', () => {
      assert(lightOff, 'источник не погасился');
    });
    check('бедный снимок темноты не оставляет карту чёрной', () => {
      // Карта без темноты и без огня не рисует слой вовсе: иначе дневная карта
      // выглядела бы пожелтевшей, а не дневной.
      const canvas = lightHost().querySelector('.map-light');
      assert(canvas.hidden || canvas.width > 0, 'слой света в негодном состоянии');
    });
    check('слой света лежит под туманом и над фишками', () => {
      // Порядок слоёв решает две вещи сразу: фишка в темноте должна быть видна,
      // а пятно света не должно высвечивать кусок карты, который мастер считает
      // закрытым туманом.
      const surface = document.querySelector('#map-root .map-surface');
      const z = (selector) => Number(getComputedStyle(surface.querySelector(selector)).zIndex);
      assert(z('.map-light') < z('.map-glow'), 'пятна оказались под ночной завесой');
      assert(z('.map-glow') < z('.map-walls'), 'стены оказались под пятнами света');
      assert(z('.map-walls') < z('.map-fog'), 'туман оказался под стенами');
      assert(z('.map-fog') === 7, `туман должен быть верхним слоем: ${z('.map-fog')}`);
      assert(getComputedStyle(surface.querySelector('.map-glow')).mixBlendMode === 'screen',
        'пятна света не смешиваются с картой экранированием');
    });
    check('свет считается по клеткам, а не по пикселям картинки', () => {
      // Дальность задана в футах, а правила держат клетку в пяти футах. Если бы
      // свет считали в пикселях картинки, факел на двадцать футов светил бы на
      // две сотни клеток ширины и выглядел бы точкой.
      const polygon = window.DnD5e.lightPolygon(
        { x: 0.5, y: 0.5, radius: 20 },
        [],
        { columns: 20, rows: 15, feetPerCell: 5 }
      );
      assert.strictEqual(polygon.radiusCells, 4, `радиус факела в клетках: ${polygon.radiusCells}`);
      assert(polygon.radiusCells / 20 < 0.25,
        `факел занял ${Math.round(polygon.radiusCells / 20 * 100)}% ширины карты вместо четверти`);
      assert(polygon.points.length >= 48, `по окружности идёт мало лучей: ${polygon.points.length}`);
      // С тем же расстоянием, но в десять футов на клетку, факел должен светить
      // вдвое дальше: масштаб карты действительно влияет на свет.
      const scaled = window.DnD5e.lightPolygon(
        { x: 0.5, y: 0.5, radius: 20 },
        [],
        { columns: 20, rows: 15, feetPerCell: 10 }
      );
      assert.strictEqual(scaled.radiusCells, 2, `при десяти футах в клетке: ${scaled.radiusCells}`);
    });
    check('стена задерживает свет, а без неё круг остаётся круглым', () => {
      const grid = { columns: 20, rows: 15, feetPerCell: 5 };
      const walls = window.DnD5e.wallsInCells(
        [{ id: 'w', x1: 0.45, y1: 0.2, x2: 0.45, y2: 0.8 }],
        grid
      );
      const shadowed = window.DnD5e.lightPolygon({ x: 0.5, y: 0.5, radius: 20 }, walls, grid);
      const left = shadowed.points.map((point) => point[0]);
      const right = shadowed.points.map((point) => point[0]);
      // Стена стоит в девятой клетке от источника (20-я минус 9-я): за ней света
      // быть не должно, а в сторону, где стены нет, — полный радиус.
      assert(Math.abs(Math.min(...left) - 9) < 0.5,
        `свет прошёл сквозь стену: ${Math.min(...left)} вместо 9`);
      assert(Math.abs(Math.max(...right) - 14) < 0.5,
        `свет не дошёл до полного радиуса: ${Math.max(...right)} вместо 14`);
    });
    check('без стен свет это круг, а не ромб', () => {
      // Четыре луча по сторонам света давали ромб, и пятно обрезалось им:
      // факел на карте без стен светил квадратом, повёрнутым на 45 градусов.
      const grid = { columns: 20, rows: 15, feetPerCell: 5 };
      const polygon = window.DnD5e.lightPolygon({ x: 0.5, y: 0.5, radius: 20 }, [], grid);
      assert(polygon.points.length >= 48,
        `по окружности должно идти много лучей, а их ${polygon.points.length}`);
      const radii = polygon.points.map(([x, y]) => Math.hypot(x - 10, y - 7.5));
      const spread = Math.max(...radii) - Math.min(...radii);
      assert(spread < 0.01, `контур не круглый, разброс радиуса ${spread.toFixed(3)} клетки`);
      // Угловые точки ромба стояли бы на диагонали заметно ближе центра.
      // Точка по диагонали должна лежать так же далеко, как и по осям: у ромба
      // она срезалась и не доходила до края.
      const diagonal = polygon.points
        .map(([x, y]) => ({ d: Math.hypot(x - 10, y - 7.5), a: Math.atan2(y - 7.5, x - 10) }))
        .filter((item) => Math.abs(Math.abs(item.a) - Math.PI / 4) < 0.05)
        .map((item) => item.d);
      assert(diagonal.length > 0, 'в многоугольнике нет точек по диагонали');
      assert(Math.min(...diagonal) > polygon.radiusCells * 0.95,
        `контур срезан по диагонали: ${Math.min(...diagonal).toFixed(2)} из ${polygon.radiusCells}`);
    });
    check('тусклый свет по правилам светит вдвое меньше', () => {
      const grid = { columns: 20, rows: 15, feetPerCell: 5 };
      const bright = window.DnD5e.lightPolygon({ x: 0.5, y: 0.5, radius: 20 }, [], grid);
      const dim = window.DnD5e.lightPolygon({ x: 0.5, y: 0.5, radius: 20, dim: true }, [], grid);
      assert.strictEqual(dim.radiusCells, bright.radiusCells / 2,
        `радиус тусклого: ${dim.radiusCells} вместо ${bright.radiusCells / 2}`);
    });
    check('цвет источника попадает на карту, а не остаётся в ночном тоне', () => {
      // Раньше пятна вырезались из темноты вычитанием, и цвет источника никуда
      // не попадал: лунный свет выглядел как факел. Теперь пятна рисуются
      // отдельным слоем своим цветом, поэтому в буфере ищется именно он.
      const sample = (color) => {
        const state = JSON.parse(JSON.stringify(MAP_STATE));
        state.maps.world.items[0].darkness = 0.9;
        state.maps.world.items[0].lights = [{ id: 'c', x: 0.5, y: 0.5, radius: 60, color }];
        mapView.render(state, { role: 'dm', playerId: 'dm' });
        const glow = mapView.glowSourceContext;
        const data = glow.getImageData(0, 0, glow.canvas.width, glow.canvas.height).data;
        // Ищем самый тёплый и самый холодный пиксель: у одного источника цвет
        // один, и сравнивать надо с ним, а не с серединой буфера.
        let warm = -999;
        let cold = -999;
        for (let i = 0; i < data.length; i += 4) {
          warm = Math.max(warm, data[i] - data[i + 2]);
          cold = Math.max(cold, data[i + 2] - data[i]);
        }
        return { warm, cold, size: glow.canvas.width * glow.canvas.height };
      };
      const torch = sample('#ffab4d');
      assert(torch.size > 0, `буфер пятен пуст: ${torch.size} пикселей`);
      assert(torch.warm > 40, `тёплый источник не тёплый: тепло ${torch.warm}`);
      assert(torch.cold <= 1, `тёплый источник оказался холодным: холод ${torch.cold}`);
      const moon = sample('#7d9cff');
      assert(moon.cold > 40, `холодный источник не холодный: холод ${moon.cold}`);
      assert(moon.warm <= 1, `холодный источник оказался тёплым: тепло ${moon.warm}`);
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    });
    check('тусклость источника переживает поездку до сервера и обратно', () => {
      const parsed = window.DnD5e.normalizeLights([
        { id: 'a', x: 0.5, y: 0.5, radius: 20, dim: true },
        { id: 'b', x: 0.5, y: 0.5, radius: 20 }
      ]);
      assert.strictEqual(parsed[0].dim, true, 'тусклость потерялась');
      assert.strictEqual(parsed[1].dim, false, 'яркий источник стал тусклым');
    });
    check('свет пересчитывается только когда что-то изменилось', () => {
      // Каждое движение мыши при протяжке стены перерисовывало все
      // многоугольники заново, и тяжёлая карта подтормаживала.
      const state = JSON.parse(JSON.stringify(MAP_STATE));
      state.maps.world.items[0].darkness = 0.8;
      state.maps.world.items[0].lights = [{ id: 'k', x: 0.4, y: 0.4, radius: 20, color: '#ffab4d' }];
      const map = state.maps.world.items[0];
      mapView.render(state, { role: 'dm', playerId: 'dm' });

      let builds = 0;
      const original = mapView.renderLightBuffers.bind(mapView);
      mapView.renderLightBuffers = (...args) => { builds += 1; return original(...args); };
      // Первый повтор обязан быть кэшем: карта только что отрисовалась.
      mapView.paintLight(map);
      assert.strictEqual(builds, 0, `повтор построил буферы заново: ${builds}`);
      mapView.paintLight(map);
      assert.strictEqual(builds, 0, 'третий повтор тоже перестраивает');

      // А вот с новой стеной буферы обязаны перестроиться.
      const withWall = { ...map, walls: [{ id: 'w', x1: 0.5, y1: 0, x2: 0.5, y2: 1 }] };
      mapView.paintLight(withWall);
      assert.strictEqual(builds, 1, 'новая стена не перестроила свет');

      // Свет сдвинутого источника тоже требует пересчёта.
      const moved = { ...map, lights: [{ id: 'k', x: 0.6, y: 0.6, radius: 20, color: '#ffab4d' }] };
      mapView.paintLight(moved);
      assert.strictEqual(builds, 2, 'сдвинутый источник не перестроил свет');

      mapView.renderLightBuffers = original;
      mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    });
    check('карту стола можно приблизить, не меняя размер фишек и клетки', () => {
      const surface = document.querySelector('#map-root .map-surface');
      const plus = [...document.querySelectorAll('#map-root .map-zoom__btn')]
        .find((node) => node.textContent === '+');
      assert(plus, 'на столе нет кнопки приближения');
      const cellBefore = surface.style.getPropertyValue('--cell');
      plus.click();
      assert(document.querySelector('#map-root .map-zoom__value').textContent === '125%',
        `подпись приближения: ${document.querySelector('#map-root .map-zoom__value').textContent}`);
      assert(surface.style.transform.includes('scale(1.25)'), `преобразование: ${surface.style.transform}`);
      assert(surface.style.getPropertyValue('--cell') === cellBefore,
        `размер клетки изменился: ${cellBefore} -> ${surface.style.getPropertyValue('--cell')}`);
      document.querySelector('#map-root .map-zoom__btn--reset').click();
      assert(document.querySelector('#map-root .map-zoom__value').textContent === '100%', 'сброс приближения не сработал');
    });

    // Вторая карта: вкладка ещё пустая — раньше её нельзя было даже выбрать,
    // и загрузить карту локации было нечем.
    document.querySelectorAll('#map-root .map-tab')[1].click();
    check('ДМ может выбрать ещё не загруженную карту', () => {
      const battleTab = document.querySelectorAll('#map-root .map-tab')[1];
      assert(battleTab.classList.contains('is-active'), 'вкладка карты битвы не выбралась');
      assert(!document.querySelector('#map-root .map-empty').hidden, 'для пустой карты должна быть заглушка');
    });
    dropFile(toBytes(PNG_1PX), 'battle.png', 'image/png');
    const battleLoaded = await softWait(() => {
      const name = document.querySelector('#map-root .map-toolbar__name');
      return name && name.textContent.includes('battle.png');
    }, 'карта битвы загрузилась');
    check('вторую карту тоже можно загрузить', () => {
      assert(battleLoaded, `карта битвы не загрузилась: ${mapDiagnostics()}`);
      assert(document.querySelector('#map-root .map-toolbar__name').textContent.includes('battle.png'), 'имя карты битвы');
      assert(!document.querySelector('#map-root .map-surface').hidden, 'карта битвы не отображается');
    });

    // Ещё одна карта в ту же вкладку: прежняя должна остаться на месте.
    playerInbox.maps.length = 0;
    dropFile(toBytes(PNG_1PX), 'пещера.png', 'image/png');
    const secondBattle = await softWait(() => {
      const list = document.querySelector('#map-root .map-toolbar__list');
      return list && list.options.length === 2;
    }, 'вторая карта в той же вкладке');
    check('во вкладку можно добавить вторую карту, не потеряв первую', () => {
      assert(secondBattle, `список карт вкладки не вырос: ${mapDiagnostics()}`);
      const list = document.querySelector('#map-root .map-toolbar__list');
      const names = [...list.options].map((option) => option.textContent);
      assert(names.some((name) => name.includes('battle.png')), `нет прежней карты: ${names.join(', ')}`);
      assert(names.some((name) => name.includes('пещера.png')), `нет новой карты: ${names.join(', ')}`);
      assert(list.value === list.options[1].value, 'новая карта должна открываться мастеру');
      assert(!playerInbox.maps.some((update) => (update.items || []).some((item) => item.name.includes('пещера.png'))),
        'игрок получил заготовку');
    });
    [...document.querySelectorAll('#map-root .map-toolbar button')]
      .find((node) => node.textContent === '◀').click();
    const switchedBack = await softWait(() => {
      const name = document.querySelector('#map-root .map-toolbar__name');
      return name && name.textContent.includes('battle.png');
    }, 'переключение на первую карту вкладки');
    check('переключение между картами вкладки видит только мастер', () => {
      assert(switchedBack, `не переключились на первую карту: ${mapDiagnostics()}`);
      assert(!playerInbox.maps.some((update) => (update.items || []).some((item) => item.name.includes('battle.png'))),
        'игрок увидел выбор мастера до показа');
    });
    playerInbox.maps.length = 0;
    const showBattleButton = [...document.querySelectorAll('#map-root .map-toolbar button')]
      .find((node) => node.textContent.includes('Показать игрокам'));
    if (showBattleButton) showBattleButton.click();
    const battleShown = await softWait(
      () => playerInbox.maps.some((update) => update.type === 'battle'
        && update.activeMap === 'battle' && update.items && update.items.length === 1),
      'показ карты битвы игрокам'
    );
    check('кнопка показа открывает игрокам выбранную карту', () => {
      assert(showBattleButton, 'нет кнопки показа карты битвы');
      assert(battleShown, 'игрок не получил показанную карту битвы');
      const last = playerInbox.maps.filter((update) => update.type === 'battle').pop();
      assert(last.items[0].name.includes('battle.png'),
        `игрок получил не ту карту: ${last.items.map((item) => item.name).join(', ')}`);
      assert(!last.items.some((item) => item.name.includes('пещера.png')), 'игрок получил заготовку');
    });

    // Возвращаемся к общей карте, чтобы дальше всё было предсказуемо.
    document.querySelectorAll('#map-root .map-tab')[0].click();
    await softWait(() => {
      const name = document.querySelector('#map-root .map-toolbar__name');
      return name && name.textContent.includes('world.png');
    }, 'возврат к общей карте');

    document.querySelector('#toasts').innerHTML = '';
    dropFile(new Uint8Array([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 'old-map.bmp', 'image/bmp');
    await waitFor(() => document.querySelector('#toasts .toast--error'), 'сообщение об ошибке для BMP');
    check('неподдерживаемый формат отклоняется с понятным сообщением', () => {
      const text = document.querySelector('#toasts .toast--error').textContent;
      assert(text.includes('old-map.bmp'), `в ошибке нет имени файла: ${text}`);
      assert(text.toLowerCase().includes('bmp'), `в ошибке нет формата: ${text}`);
      assert(text.includes('PNG, JPG'), `в ошибке нет подсказки о форматах: ${text}`);
    });

    document.querySelector('#toasts').innerHTML = '';
    dropFile(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0, 0, 0]),
      'screenshot.gif', 'image/png');
    await waitFor(() => document.querySelector('#toasts .toast--error'), 'сообщение об ошибке с сервера');
    check('сервер тоже проверяет формат и называет его в ошибке', () => {
      const text = document.querySelector('#toasts .toast--error').textContent;
      assert(text.includes('GIF'), `сервер не распознал формат: ${text}`);
      assert(text.includes('PNG, JPG или WEBP'), `нет подсказки о форматах: ${text}`);
    });

    /* --------------------------- холст: ДМ рисует карту сам */

    document.querySelectorAll('#map-root .map-tab')[2].click();
    check('третья вкладка карт — «Рисунок» — пустая, но с подсказкой', () => {
      const tab = document.querySelectorAll('#map-root .map-tab')[2];
      assert(tab.classList.contains('is-active'), 'вкладка «Рисунок» не выбралась');
      const empty = document.querySelector('#map-root .map-empty__text').textContent;
      assert(empty.includes('Рисунок пока пуст'), `текст заглушки: ${empty}`);
    });

    const sketchTools = () => document.querySelector('#map-root .sketch__tools');
    const toolButton = (label) => [...document.querySelectorAll('#map-root .sketch__tools button')]
      .find((node) => node.textContent.trim() === label);

    const drawButton = [...document.querySelectorAll('#map-root .map-toolbar button')]
      .find((node) => node.textContent.includes('Нарисовать карту'));
    check('кнопка «Нарисовать карту» открывает холст', () => {
      assert(drawButton, 'нет кнопки рисования');
      drawButton.click();
      const editor = document.querySelector('#map-root .sketch-editor');
      assert(editor && !editor.hidden, 'холст не появился');
      assert(document.querySelector('#map-root .sketch__canvas--draw'), 'нет холста для рисования');
    });
    check('у холста есть инструменты для рисования карты', () => {
      const tools = sketchTools().textContent;
      for (const label of ['Кисть', 'Линия', 'Прямоугольник', 'Ластик', 'Цвет', 'Толщина',
        'Отменить штрих', 'Очистить', 'Подложка', 'Сделать картой']) {
        assert(tools.includes(label), `нет инструмента «${label}»`);
      }
      const target = document.querySelector('#map-root .sketch__target');
      assert(target, 'нет выбора, куда сохранить карту');
      assert([...target.options].some((option) => option.textContent.includes('Рисунок')),
        'нельзя сохранить рисунок в отдельную карту');
    });

    const sketchCanvas = document.querySelector('#map-root .sketch__canvas--draw');
    const boardPoint = (fx, fy) => {
      const rect = document.querySelector('#map-root .sketch__board').getBoundingClientRect();
      return { clientX: rect.left + rect.width * fx, clientY: rect.top + rect.height * fy };
    };
    const boardPointer = (type, point) => new PointerEvent(type, {
      bubbles: true, pointerType: 'mouse', button: 0, clientX: point.clientX, clientY: point.clientY
    });
    /** Сколько штрихов на холсте: редактор пишет их число в data-атрибут. */
    const strokeCount = () => Number(document.querySelector('#map-root .sketch__board').dataset.strokes || '0');
    /** Отпечаток картинки холста: изменился — значит штрих действительно нарисован. */
    const canvasSignature = () => sketchCanvas.toDataURL('image/png').length;
    const drawStroke = () => {
      const start = boardPoint(0.2, 0.2);
      const end = boardPoint(0.6, 0.45);
      sketchCanvas.dispatchEvent(boardPointer('pointerdown', start));
      sketchCanvas.dispatchEvent(boardPointer('pointermove', end));
      sketchCanvas.dispatchEvent(boardPointer('pointerup', end));
    };

    const emptySignature = canvasSignature();
    drawStroke();
    check('по холсту можно рисовать мышью', () => {
      assert(strokeCount() === 1, `штрихов на холсте: ${strokeCount()}`);
      assert(canvasSignature() !== emptySignature, 'картинка холста не изменилась');
    });
    toolButton('Отменить штрих').click();
    check('штрих можно отменить', () => {
      assert(strokeCount() === 0, `после отмены штрихов: ${strokeCount()}`);
      assert(canvasSignature() === emptySignature, 'после отмены на холсте остались следы');
    });

    drawStroke();
    document.querySelector('#toasts').innerHTML = '';
    toolButton('Сделать картой').click();
    let sketchSaved = true;
    try {
      await waitFor(() => {
        const name = document.querySelector('#map-root .map-toolbar__name');
        return name && name.textContent.includes('Рисунок');
      }, 'рисунок стал картой', 15000);
    } catch {
      sketchSaved = false;
    }
    check('нарисованная карта уходит на стол отдельной картой', () => {
      assert(sketchSaved, `рисунок не стал картой: ${mapDiagnostics()}`);
      const editor = document.querySelector('#map-root .sketch-editor');
      assert(!editor || editor.hidden, 'холст остался открытым после сохранения');
      const image = document.querySelector('#map-root .map-image');
      assert(image.src.startsWith('http://127.0.0.1:'), `картинка не с сервера: ${image.src.slice(0, 60)}`);
      assert(!document.querySelectorAll('#map-root .map-tab')[2]
        .querySelector('.map-tab__dot').classList.contains('is-on'),
      'рисунок отмечен показанным до нажатия кнопки');
      const errors = [...document.querySelectorAll('#toasts .toast--error')].map((node) => node.textContent);
      assert(!errors.length, `при сохранении рисунка были ошибки: ${errors.join(' | ')}`);
    });
    const showSketch = [...document.querySelectorAll('#map-root .map-toolbar button')]
      .find((node) => node.textContent.includes('Показать игрокам'));
    if (showSketch) showSketch.click();
    const sketchShown = await softWait(
      () => document.querySelectorAll('#map-root .map-tab')[2].querySelector('.map-tab__dot').classList.contains('is-on'),
      'показ рисунка игрокам'
    );
    check('нарисованную карту можно показать игрокам', () => {
      assert(showSketch, 'нет кнопки показа рисунка');
      assert(sketchShown, 'рисунок не отмечен показанным');
    });
    const firstSketchSrc = document.querySelector('#map-root .map-image').src;

    // Теперь то же самое, но поверх уже загруженной карты: подложка приходит
    // с сервера стола, поэтому холст должен остаться «чистым» для сохранения.
    document.querySelectorAll('#map-root .map-tab')[0].click();
    const drawOverButton = [...document.querySelectorAll('#map-root .map-toolbar button')]
      .find((node) => node.textContent.includes('Рисовать поверх карты'));
    check('ДМ может рисовать поверх уже загруженной карты', () => {
      assert(drawOverButton, 'нет кнопки рисования поверх карты');
      drawOverButton.click();
      assert(document.querySelector('#map-root .sketch__canvas--bg'), 'нет слоя подложки');
    });
    /** Размер клетки, который сейчас у стола (его меняют в настройках). */
    const cellPx = () => {
      const raw = document.querySelector('#map-root .map-surface').style.getPropertyValue('--cell');
      return Number(String(raw).replace('px', '')) || 46;
    };
    // Холст по умолчанию — 24 клетки; после подложки он становится ровно по карте.
    const backgroundLoaded = await softWait(() => {
      const canvas = document.querySelector('#map-root .sketch__canvas--bg');
      if (!canvas) return false;
      const cell = cellPx();
      return canvas.width !== 24 * cell && canvas.width % cell === 0 && canvas.width >= 400;
    }, 'подложка из карты загрузилась');
    check('подложка из карты не «загрязняет» холст (иначе рисунок нельзя сохранить)', () => {
      assert(backgroundLoaded, 'подложка из текущей карты не пришла на холст');
      const bgCanvas = document.querySelector('#map-root .sketch__canvas--bg');
      let readable = true;
      try {
        bgCanvas.getContext('2d').getImageData(0, 0, 1, 1);
      } catch (error) {
        readable = false;
      }
      assert(readable, 'холст с подложкой нельзя прочитать — сохранение рисунка будет невозможно');
    });

    document.querySelector('#toasts').innerHTML = '';
    drawStroke();
    const targetSelect = document.querySelector('#map-root .sketch__target');
    targetSelect.value = 'sketch';
    targetSelect.dispatchEvent(new Event('change', { bubbles: true }));
    toolButton('Сделать картой').click();
    let overMapSaved = true;
    try {
      await waitFor(() => {
        const editor = document.querySelector('#map-root .sketch-editor');
        return editor && editor.hidden;
      }, 'рисунок поверх карты сохранился', 15000);
    } catch {
      overMapSaved = false;
    }
    // Рисунок сохранён в карту «Рисунок» — открываем её и смотрим на картинку.
    document.querySelectorAll('#map-root .map-tab')[2].click();
    const sketchUpdated = await softWait(
      () => document.querySelector('#map-root .map-image').src !== firstSketchSrc,
      'карта-рисунок обновилась',
      15000
    );
    check('рисунок поверх карты сохраняется в «Рисунок» новой картинкой', () => {
      assert(overMapSaved, `рисунок поверх карты не сохранился: ${mapDiagnostics()}`);
      assert(sketchUpdated, `картинка карты-рисунка не обновилась: ${document.querySelector('#map-root .map-image').src}`);
      const errors = [...document.querySelectorAll('#toasts .toast--error')].map((node) => node.textContent);
      assert(!errors.length, `при сохранении были ошибки: ${errors.join(' | ')}`);
    });

    /**
     * Скачивает сохранённую картинку и читает цвета в четырёх точках карты.
     * Так видно не «файл существует», а что именно в нём нарисовано: попала ли
     * на рисунок карта-подложка и не растянулась ли она.
     */
    const sampleSavedMap = async (url) => {
      const response = await fetch(url);
      const blob = await response.blob();
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(blob);
      });
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('сохранённая картинка не читается'));
        image.src = dataUrl;
      });
      const probe = document.createElement('canvas');
      probe.width = image.naturalWidth;
      probe.height = image.naturalHeight;
      if (probe.width < MAP_WIDTH || probe.height < MAP_HEIGHT) {
        throw new Error(`рисунок ${probe.width}x${probe.height} меньше карты ${MAP_WIDTH}x${MAP_HEIGHT} — карта обрезана`);
      }
      const context = probe.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      // Точки берём внутри самой карты: холст может быть чуть больше по клеткам.
      const at = (fx, fy) => {
        const dot = context.getImageData(
          Math.floor(MAP_WIDTH * fx), Math.floor(MAP_HEIGHT * fy), 1, 1
        ).data;
        return `${dot[0]},${dot[1]},${dot[2]}`;
      };
      return {
        size: `${probe.width}x${probe.height}`,
        topLeft: at(0.1, 0.1),
        topRight: at(0.9, 0.1),
        bottomLeft: at(0.1, 0.9),
        bottomRight: at(0.9, 0.9)
      };
    };

    const savedSketch = await sampleSavedMap(document.querySelector('#map-root .map-image').src);
    check('на рисунок поверх карты попадает сама карта, а не пустой фон', () => {
      const expected = [
        ['левый верхний угол', 'topLeft'],
        ['правый верхний угол', 'topRight'],
        ['левый нижний угол', 'bottomLeft'],
        ['правый нижний угол', 'bottomRight']
      ];
      for (const [label, key] of expected) {
        assert(savedSketch[key] === MAP_COLORS[key],
          `${label}: в рисунке цвет ${savedSketch[key]}, а на карте ${MAP_COLORS[key]} (размер рисунка ${savedSketch.size})`);
      }
    });

    // Дальше сценарий проверяет фишку на карте локации. Она уже показана
    // игрокам; кнопка нужна только если показ успели переключить.
    document.querySelectorAll('#map-root .map-tab')[1].click();
    const showBattle = [...document.querySelectorAll('#map-root .map-toolbar button')]
      .find((node) => node.textContent.includes('Показать игрокам'));
    if (showBattle) showBattle.click();
    const battleTabShown = await softWait(
      () => document.querySelectorAll('#map-root .map-tab')[1].querySelector('.map-tab__dot').classList.contains('is-on'),
      'показ карты локации игрокам'
    );
    check('карта локации остаётся показанной игрокам', () => {
      assert(battleTabShown, 'карта локации не показывается игрокам');
    });

    document.querySelector('.tabs__btn[data-tab="tokens"]').click();
    const liveTokenForm = document.querySelector('#tab-tokens .token-form');
    liveTokenForm.querySelector('input').value = 'Смоук-фишка';
    liveTokenForm.requestSubmit();
    await waitFor(
      () => document.querySelector('#tab-tokens').textContent.includes('Смоук-фишка'),
      'создание фишки через сервер'
    );
    check('фишка, созданная ДМ, вернулась с сервера', () => {
      assert(document.querySelectorAll('#tab-tokens .token-row').length >= 1, 'фишка не появилась');
    });
    check('новая фишка скрыта, и игрок о ней не знает', () => {
      assert(
        !playerInbox.tokens.some((token) => token.name === 'Смоук-фишка'),
        'игрок получил скрытую фишку'
      );
      const row = [...document.querySelectorAll('#tab-tokens .token-row')]
        .find((node) => node.textContent.includes('Смоук-фишка'));
      assert(row && row.classList.contains('token-row--hidden'), 'у мастера фишка не помечена как скрытая');
      assert(row.textContent.includes('Скрыта'), `нет подписи «Скрыта»: ${row.textContent}`);
    });

    // Мастер открывает фишку кнопкой в списке. Это ровно тот путь, которым
    // пользуется мастер за столом, и он же ловит дубль: показ приходит и как
    // tokenHidden, и как tokenCreated, и в списке могла бы появиться вторая
    // строка той же фишки.
    const rowsBeforeReveal = document.querySelectorAll('#tab-tokens .token-row').length;
    const revealButton = [...document.querySelectorAll('#tab-tokens .token-row button')]
      .find((node) => node.textContent === 'Скрыта');
    check('у скрытой фишки есть кнопка показа', () => {
      assert(revealButton, 'нет кнопки «Скрыта» у фишки');
    });
    revealButton.click();
    await waitFor(
      () => playerInbox.tokens.some((token) => token.name === 'Смоук-фишка'),
      'показ фишки игрокам'
    );
    const smokeToken = playerInbox.tokens.find((token) => token.name === 'Смоук-фишка');
    check('показанная фишка доехала до игрока', () => {
      assert(smokeToken, 'фишка не пришла игроку');
      assert(smokeToken.hidden === false, 'фишка осталась скрытой');
    });
    check('после показа в списке мастера не появилось дубля', () => {
      const rows = [...document.querySelectorAll('#tab-tokens .token-row')]
        .filter((node) => node.textContent.includes('Смоук-фишка'));
      assert(rows.length === 1, `строк с этой фишкой: ${rows.length}`);
      assert(rows[0].textContent.includes('Видна'), `подпись: ${rows[0].textContent}`);
      assert(
        document.querySelectorAll('#tab-tokens .token-row').length === rowsBeforeReveal,
        'в списке фишек изменилось число строк'
      );
    });
    const smokeTokenId = smokeToken.id;

    // И обратно: спрятать показанную фишку. Игрок должен получить уведомление,
    // чтобы убрать её у себя с карты.
    playerInbox.hidden.length = 0;
    const hideButton = [...document.querySelectorAll('#tab-tokens .token-row button')]
      .find((node) => node.textContent === 'Видна');
    check('у показанной фишки есть кнопка скрытия', () => {
      assert(hideButton, 'нет кнопки «Видна» у фишки');
    });
    hideButton.click();
    await waitFor(() => playerInbox.hidden.length === 1, 'скрытие фишки игрокам');
    check('игрок узнаёт, что фишку скрыли', () => {
      assert(playerInbox.hidden[0].tokenId === smokeTokenId, 'не та фишка');
      assert(playerInbox.hidden[0].hidden === true, 'пришло не о скрытии');
    });
    check('скрытая снова помечена в списке мастера', () => {
      const row = [...document.querySelectorAll('#tab-tokens .token-row')]
        .find((node) => node.textContent.includes('Смоук-фишка'));
      assert(row.classList.contains('token-row--hidden'), 'строка не помечена как скрытая');
      assert(row.textContent.includes('Скрыта'), `подпись: ${row.textContent}`);
    });
    playerInbox.errors.length = 0;
    playerSocket.emit('moveToken', { tokenId: smokeTokenId, x: 0.1, y: 0.1 });
    playerSocket.emit('deleteToken', { tokenId: smokeTokenId });
    playerSocket.emit('createToken', { name: 'Чужая фишка' });
    playerSocket.emit('uploadMap', { type: 'world', image: PNG_1PX });
    playerSocket.emit('setActiveMap', { type: 'world' });
    await waitFor(() => playerInbox.errors.length >= 5, 'отказы игроку в действиях ДМ');
    check('права игрока ограничены: чужие фишки, карты и создание фишек недоступны', () => {
      assert(playerInbox.errors.some((message) => message.includes('только свою фишку')), 'движение чужой фишки');
      assert(playerInbox.errors.some((message) => message.includes('только ДМ')), 'действия ДМ доступны игроку');
      assert(document.querySelectorAll('#tab-tokens .token-row').length === 1, 'на столе появилась лишняя фишка');
    });

    // Фишка создаётся на активной карте — открываем её, чтобы проверить отрисовку.
    document.querySelectorAll('#map-root .map-tab')[1].click();
    await softWait(() => document.querySelector('#map-root .token'), 'фишка на карте');
    check('фишка отображается на карте с координатами', () => {
      const node = document.querySelector('#map-root .token');
      assert(node, 'фишка не нарисована на карте');
      assert(node.style.left && node.style.top, `нет координат: ${node.style.left} / ${node.style.top}`);
    });

    // Назначаем фишку игроку тем же путём, что и ДМ, и просим игрока поставить картинку.
    const dmRaw = window.io(hostInfo.localUrl, { transports: ['websocket'], forceNew: true });
    await new Promise((resolve, reject) => {
      dmRaw.on('connect', resolve);
      dmRaw.on('connect_error', (error) => reject(new Error(`второй сокет ДМ: ${error.message}`)));
    });
    await new Promise((resolve) => {
      dmRaw.emit('joinRoom', { name: 'Мастер', playerId: 'dm', hostKey: hostInfo.hostKey }, resolve);
    });
    dmRaw.emit('assignTokenToPlayer', { tokenId: smokeTokenId, playerId: 'p-smoke-1' });
    await softWait(() => document.querySelector('#tab-tokens').textContent.includes('Борис'), 'фишка назначена игроку');

    playerInbox.errors.length = 0;
    playerSocket.emit('setTokenImage', { tokenId: smokeTokenId, image: PNG_1PX });
    const tokenImageShown = await softWait(
      () => document.querySelector('#map-root .token__circle--image'),
      'картинка фишки отрисовалась'
    );
    check('картинка фишки грузится с сервера, а не из корня диска', () => {
      assert(tokenImageShown, `картинка фишки не появилась: ${mapDiagnostics()}`);
      const background = document.querySelector('#map-root .token__circle--image').style.backgroundImage;
      assert(background.includes('http://127.0.0.1:'), `фон фишки не с сервера: ${background}`);
      assert(background.includes('/files/'), `фон фишки без пути к файлу: ${background}`);
    });
    dmRaw.disconnect();

    document.querySelector('.tabs__btn[data-tab="dice"]').click();
    // Настоящий стол: бросаем формулу и быструю кость, чтобы проверить оба пути.
    document.querySelector('#tab-dice .dice__formula').value = '2d6+3';
    document.querySelector('#tab-dice .dice__controls .btn--accent').click();
    [...document.querySelectorAll('#tab-dice .dice__quick-btn')]
      .find((button) => button.textContent === 'd20').click();
    await waitFor(() => document.querySelectorAll('#tab-dice .dice__row').length > 1, 'результаты бросков');
    check('бросок кубика обработан сервером и показан', () => {
      const rows = [...document.querySelectorAll('#tab-dice .dice__row')];
      assert(rows[0].textContent.includes('2d6+3'), `нет формулы в броске: ${rows[0].textContent}`);
      assert(rows[0].textContent.includes('Мастер'), `нет имени ДМ в броске: ${rows[0].textContent}`);
      assert(rows[1].textContent.includes('d20'), `нет типа кости: ${rows[1].textContent}`);
    });
    check('мастеру доступен тайный бросок на настоящем столе', () => {
      assert(!document.querySelector('#tab-dice .dice__hidden').hidden, 'у мастера нет поля «тайно»');
    });

    document.querySelector('.tabs__btn[data-tab="chat"]').click();
    const liveChatForm = document.querySelector('#tab-chat .chat__form');
    liveChatForm.querySelector('input').value = 'Смоук-сообщение';
    liveChatForm.requestSubmit();
    await waitFor(
      () => [...document.querySelectorAll('#tab-chat .chat__text')].some((node) => node.textContent === 'Смоук-сообщение'),
      'сообщение чата'
    );
    check('сообщение чата прошло через сервер и вернулось', () => {
      const texts = [...document.querySelectorAll('#tab-chat .chat__text')].map((node) => node.textContent);
      assert(texts.includes('Смоук-сообщение'), `сообщения нет: ${texts.join(' | ')}`);
    });
    check('бросок кубика продублирован в чат', () => {
      assert(document.querySelector('#tab-chat').textContent.includes('бросил d20'), 'нет строки о броске в чате');
    });

    const saveResult = await window.desktop.saveCampaign();
    check('кнопка «Сохранить кампанию» сохраняет состояние на диск', () => {
      assert(saveResult.ok === true, `сохранение не удалось: ${saveResult.error}`);
      assert(saveResult.campaign && saveResult.campaign.id, 'нет идентификатора кампании');
    });
    if (saveResult.ok) campaignId = saveResult.campaign.id;

    const campaignList = await window.desktop.listCampaigns();
    check('сохранённая кампания видна в списке кампаний', () => {
      const found = campaignList.campaigns.find((item) => item.name === 'Смоук-кампания');
      assert(found, 'кампании нет в списке');
      assert(found.tokens === 1, `фишек в кампании: ${found.tokens}`);
      assert(found.players >= 1, 'в кампании не сохранён ДМ');
    });

    const stopResult = await window.desktop.stopHost();
    check('сервер стола корректно останавливается', () => {
      assert(stopResult.ok === true, 'остановка не удалась');
    });
    const statusAfterStop = await window.desktop.hostStatus();
    check('после остановки стол не работает', () => {
      assert(statusAfterStop.running === false, 'сервер всё ещё работает');
    });

    /* ------------- заготовка листа переезжает на настоящий стол */

    document.querySelector('#btn-leave').click();
    await waitFor(() => document.querySelector('.modal-overlay'), 'подтверждение выхода из-за стола');
    const leaveConfirm = [...document.querySelectorAll('.modal-overlay .modal__actions button')]
      .find((node) => node.textContent.includes('Выйти'));
    check('ДМ выходит из-за стола с подтверждением', () => {
      assert(leaveConfirm, 'нет кнопки подтверждения выхода');
      leaveConfirm.click();
    });
    await waitFor(() => document.querySelector('#screen-home').classList.contains('is-active'), 'возврат на главный экран');

    const reloaded = await window.desktop.loadCampaign(campaignId);
    const hostAgain = reloaded.ok ? await window.desktop.startHost() : { ok: false, error: reloaded.error };
    check('для проверки переноса листа стол можно поднять заново', () => {
      assert(hostAgain.ok === true, `стол не поднялся: ${hostAgain.error}`);
    });

    // Игрок подключается напрямую сокетом, а не через экран входа: единственный
    // путь в приложении теперь P2P, и поднять второй endpoint iroh на той же
    // машине в проверке нельзя. Набор событий тот же, что и у игрока.
    const draft = window.LocalTable.readDraft(trainingPlayerId);
    check('заготовка листа без стола лежит в локальном хранилище', () => {
      assert(draft && draft.characterName === 'Тордин', `заготовка: ${draft && draft.characterName}`);
    });
    check('при пустом листе на столе заготовку предлагают перенести', () => {
      const offer = window.LocalTable.shouldOfferDraft({
        draft,
        serverSheet: null
      });
      assert(offer, 'заготовку не предложили бы при пустом листе на столе');
    });

    const draftSocket = window.io(hostAgain.localUrl, { transports: ['websocket'], forceNew: true });
    const playerJoined = await new Promise((resolve, reject) => {
      draftSocket.on('connect', () => {
        draftSocket.emit('joinRoom', { name: 'Артём', playerId: trainingPlayerId }, resolve);
      });
      draftSocket.on('connect_error', (error) => reject(new Error(`игрок не подключился: ${error.message}`)));
    });
    check('игрок видит на столе только свой лист', () => {
      assert(playerJoined.ok === true, `вход не удался: ${playerJoined.error}`);
      const sheet = playerJoined.you && playerJoined.you.sheet;
      assert(!sheet || sheet.characterName === '', `игрок получил чужой лист: ${sheet && sheet.characterName}`);
    });
    // Ровно то, что делает подтверждение в окне «Отправить лист на стол?».
    // Ждём эхо сервера, иначе снимок ДМ может сняться раньше, чем лист дойдёт.
    // Свой лист сервер возвращает игроку как characterSheetData, а
    // characterSheetUpdated уходит только мастеру.
    const savedEcho = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('сервер не подтвердил сохранение листа')), 10000);
      draftSocket.on('characterSheetData', (payload) => {
        if (!payload || payload.playerId !== trainingPlayerId) return;
        clearTimeout(timer);
        resolve(payload.sheet);
      });
      draftSocket.emit('saveCharacterSheet', { sheet: draft });
    });
    check('сервер принял лист и разослал его обратно участникам', () => {
      assert(savedEcho && savedEcho.characterName === 'Тордин', `в эхо: ${savedEcho && savedEcho.characterName}`);
    });

    const hostAfter = await window.desktop.hostStatus();
    const dmSocket = window.io(hostAfter.localUrl, { transports: ['websocket'], forceNew: true });
    const dmView = { joined: null };
    dmSocket.on('joined', (payload) => { dmView.joined = payload; });
    await new Promise((resolve, reject) => {
      dmSocket.on('connect', resolve);
      dmSocket.on('connect_error', (error) => reject(new Error(`ДМ не подключился: ${error.message}`)));
    });
    await new Promise((resolve) => {
      dmSocket.emit('joinRoom', { name: 'Мастер', playerId: 'dm', hostKey: hostAfter.hostKey }, resolve);
    });
    check('заготовка листа доехала до настоящего стола', () => {
      const sheet = dmView.joined && dmView.joined.state.sheets[trainingPlayerId];
      assert(sheet, `на столе нет листа игрока ${trainingPlayerId}`);
      assert(sheet.characterName === 'Тордин', `имя персонажа на столе: ${sheet.characterName}`);
      assert(sheet.charClass === 'Воин' && sheet.level === 3, `лист на столе: ${sheet.charClass}, уровень ${sheet.level}`);
      assert(sheet.abilities.str === 17, `характеристика на столе: ${sheet.abilities.str}`);
    });
    dmSocket.disconnect();
    await window.desktop.stopHost();

    draftSocket.disconnect();
    return { checks, campaignId };
  })();
})();
