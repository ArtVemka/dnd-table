/*
 * Набор проверок, который выполняется ВНУТРИ renderer-процесса Electron.
 *
 * Файл читается как строка и передаётся в webContents.executeJavaScript,
 * поэтому он написан как IIFE-выражение и возвращает объект с результатами.
 * Проверяются: загрузка скриптов при текущем CSP, мост preload, правила
 * D&D 5e, все компоненты интерфейса и полный сценарий «создать кампанию →
 * запустить стол → фишка/кубик/чат → сохранить кампанию → остановить стол».
 */

(() => {
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
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
    trainTable.emit('chatMessage', { text: 'Проверка связи' });
    trainTable.emit('nonExistentAction', {});
    check('фишку можно двигать, переименовывать и наряжать без сервера', () => {
      const token = train.tokens[train.tokens.length - 1];
      assert(token.name === 'Тордин', `имя фишки: ${token.name}`);
      assert(token.imageUrl === PNG_1PX, 'картинка фишки не применилась');
      assert(train.rolls.length === 1 && train.rolls[0].sides === 20, 'кубик не бросился');
      const roll = train.rolls[0];
      assert(roll.result >= 1 && roll.result <= 20, `результат броска: ${roll.result}`);
      assert(roll.playerName === 'Артём', 'в броске нет имени игрока');
      assert(train.chat.some((message) => message.text === 'Проверка связи'), 'сообщение чата не прошло');
      assert(train.chat.some((message) => message.isRoll), 'бросок не попал в чат');
      assert(train.errors.length === 1, `неизвестное действие должно ругаться: ${train.errors.join(' | ')}`);
    });
    trainTable.disconnect();

    /* ------------------------------------------------ панель листа */

    const sheetHost = document.createElement('div');
    sandbox.appendChild(sheetHost);
    const sheetView = new window.SheetView(sheetHost, {});
    sheetView.setSheet(SAMPLE_SHEET);

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

    check('список листов у ДМ подсказывает, как открыть чей-то лист', () => {
      sheetView.setMode('list');
      sheetView.setPlayerList([], null);
      assert(sheetHost.querySelector('.sheet__players-empty').textContent.includes('В лобби сейчас никого нет'),
        'нет подсказки про пустое лобби');
      assert(sheetHost.querySelector('.sheet__grid').hidden, 'форма листа показана без выбранного игрока');
      sheetView.setPlayerList([
        { playerId: 'p-1', name: 'Артём', role: 'player', online: true },
        { playerId: 'p-2', name: 'Борис', role: 'player', online: false }
      ], 'p-1');
      const rows = [...sheetHost.querySelectorAll('.sheet__players .player-row')];
      assert(rows.length === 2, `строк в списке: ${rows.length}`);
      assert(rows[0].classList.contains('is-selected'), 'выбранный игрок не подсвечен');
      assert(rows[1].classList.contains('is-offline'), 'отключённый игрок не помечен');
    });
    check('лист открывается нажатием на имя игрока в списке', () => {
      let requested = null;
      const host = document.createElement('div');
      const view = new window.SheetView(host, { onPlayerChange: (playerId) => { requested = playerId; } });
      view.setMode('list');
      view.setPlayerList([{ playerId: 'p-9', name: 'Борис', role: 'player', online: true }], null);
      host.querySelector('.sheet__players .player-row').click();
      assert(requested === 'p-9', `открыт лист игрока: ${requested}`);
      view.setMode('sheet', { canGoBack: true });
      assert(!host.querySelector('.sheet__grid').hidden, 'форма листа не показана');
      assert(host.querySelector('.sheet__players').hidden, 'список игроков не скрылся');
      const back = [...host.querySelectorAll('.sheet__head-tools button')]
        .find((node) => node.textContent.includes('К списку игроков'));
      assert(back && !back.hidden, 'нет кнопки возврата к списку');
    });
    check('у игрока нет списка игроков и кнопки возврата, но есть вынос в отдельное окно', () => {
      const host = document.createElement('div');
      const view = new window.SheetView(host, {});
      view.setMode('sheet');
      assert(host.querySelector('.sheet__players').hidden, 'игроку показан список игроков');
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
    const mapView = new window.TableUI.MapView(mapHost, {});

    mapView.render(
      { maps: { world: null, battle: null }, activeMap: null, tokens: [], players: [] },
      { role: 'dm', playerId: 'dm' }
    );
    check('три вкладки карт присутствуют, включая холст ДМа', () => {
      const labels = [...mapHost.querySelectorAll('.map-tab__label')].map((node) => node.textContent);
      assert(labels.length === 3, `должно быть три вкладки, а есть ${labels.length}`);
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

    const TOKENS = [
      { id: 't1', name: 'Гоблин', mapType: 'world', x: 0.25, y: 0.75, imageUrl: null, assignedPlayerId: null, color: '#c96f4a' },
      { id: 't2', name: 'Мира', mapType: 'world', x: 0.5, y: 0.5, imageUrl: null, assignedPlayerId: 'p-1', color: '#4a8fc9' },
      { id: 't3', name: 'Дракон', mapType: 'battle', x: 0.1, y: 0.1, imageUrl: null, assignedPlayerId: null, color: '#6fb45f' }
    ];
    const PLAYERS = [
      { playerId: 'dm', name: 'Мастер', role: 'dm', online: true, hasSheet: false, tokenId: null },
      { playerId: 'p-1', name: 'Артём', role: 'player', online: true, hasSheet: true, tokenId: 't2' }
    ];
    const MAP_STATE = {
      maps: {
        world: { items: [{ id: 'm-world', url: PNG_1PX, name: 'world.png' }], activeId: 'm-world' },
        battle: { items: [{ id: 'm-battle', url: PNG_1PX, name: 'battle.png' }], activeId: 'm-battle' },
        sketch: { items: [], activeId: null }
      },
      activeMap: 'world',
      grid: { enabled: false, cell: DnD.GRID.defaultCell },
      tokens: TOKENS,
      players: PLAYERS
    };

    mapView.render(MAP_STATE, { role: 'player', playerId: 'p-1' });
    await wait(400);

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
      mapView.render({ ...MAP_STATE, activeMap: 'battle' }, { role: 'player', playerId: 'p-1' });
      assert(mapHost.querySelector('.map-badge').hidden, 'пометка осталась, хотя игрок следует за ДМ');
      assert(mapHost.querySelectorAll('.token').length === 1, 'должны показываться фишки карты битвы');
    });
    mapView.render(MAP_STATE, { role: 'dm', playerId: 'dm' });
    // Возвращаем ДМ на общую карту: предыдущие проверки увели его на карту локации.
    mapView.onTabClick('world');

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

    const menuHost = document.createElement('div');
    sandbox.appendChild(menuHost);
    const menuActions = [];
    const menuView = new window.TableUI.MapView(menuHost, {
      onDeleteToken: (id) => menuActions.push(`delete:${id}`),
      onRenameToken: (token) => menuActions.push(`rename:${token.name}`),
      onSetTokenImage: (id) => menuActions.push(`image:${id}`),
      onAssignToken: (id, playerId) => menuActions.push(`assign:${id}:${playerId}`)
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

    /* ------------------------ несколько карт в одной вкладке */

    const multiHost = document.createElement('div');
    sandbox.appendChild(multiHost);
    const multiCalls = [];
    const multiView = new window.TableUI.MapView(multiHost, {
      resolveUrl: (url) => url,
      onSelectMap: (type, mapId) => multiCalls.push(`select:${type}:${mapId}`),
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
    const playersList = new window.TableUI.PlayersList(playersHost, {});
    playersList.render(PLAYERS.concat([
      { playerId: 'p-2', name: 'Борис', role: 'player', online: false, hasSheet: true, tokenId: null }
    ]), { role: 'dm', playerId: 'dm' });

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
    playersList.render(PLAYERS, { role: 'player', playerId: 'p-1' });
    check('у игрока нет кнопки «Открыть лист»', () => {
      assert(!playersHost.textContent.includes('Открыть лист'), 'игрок видит кнопку просмотра листов');
    });

    /* ------------------------------------------------ чат и кубики */

    const chatHost = document.createElement('div');
    sandbox.appendChild(chatHost);
    let sentText = null;
    const chatPanel = new window.TableUI.ChatPanel(chatHost, { onSend: (text) => { sentText = text; } });
    chatPanel.renderAll([
      { from: 'Артём', role: 'player', text: 'Привет, стол!', time: new Date().toISOString() }
    ]);
    check('чат: имя автора, время и текст сообщения', () => {
      assert(chatHost.querySelector('.chat__author').textContent === 'Артём', 'автор');
      assert(chatHost.querySelector('.chat__time').textContent.length >= 4, 'время');
      assert(chatHost.querySelector('.chat__text').textContent === 'Привет, стол!', 'текст');
    });
    chatHost.querySelector('.chat__form input').value = 'Проверка связи';
    chatHost.querySelector('.chat__form').requestSubmit();
    check('чат отправляет введённый текст', () => {
      assert(sentText === 'Проверка связи', `отправлено: ${sentText}`);
      assert(chatHost.querySelector('.chat__form input').value === '', 'поле не очищено');
    });

    const diceHost = document.createElement('div');
    sandbox.appendChild(diceHost);
    let rolledSides = null;
    const dicePanel = new window.TableUI.DicePanel(diceHost, { onRoll: (sides) => { rolledSides = sides; } });
    dicePanel.renderAll([]);
    check('панель кубиков предлагает кости от d1 до d20', () => {
      const values = [...diceHost.querySelector('select').options].map((option) => option.value);
      assert(values.length === 20, `костей: ${values.length}`);
      assert(values[0] === '1' && values[values.length - 1] === '20', 'диапазон должен быть 1..20');
    });
    diceHost.querySelector('select').value = '12';
    diceHost.querySelector('.dice__controls .btn--accent').click();
    check('кнопка «Бросить» отправляет выбранную кость', () => {
      assert(rolledSides === 12, `отправлено: ${rolledSides}`);
    });
    dicePanel.append({ playerName: 'Артём', sides: 12, result: 7, time: new Date().toISOString() });
    check('бросок показывается как «имя бросил dN: результат»', () => {
      const row = diceHost.querySelector('.dice__row');
      assert(row.textContent.includes('Артём') && row.textContent.includes('d12') && row.textContent.includes('7'),
        `строка истории: ${row.textContent}`);
      assert(diceHost.querySelector('.dice__last').textContent.includes('Артём бросил d12'), 'крупный результат');
    });

    /* ------------------------------------------------ панель фишек */

    const tokensHost = document.createElement('div');
    sandbox.appendChild(tokensHost);
    let createdTokenName = null;
    const tokenPanel = new window.TableUI.TokenPanel(tokensHost, {
      onCreate: (name) => { createdTokenName = name; },
      onDeleteToken: () => {}
    });
    tokenPanel.render(TOKENS, PLAYERS, { role: 'dm', playerId: 'dm' });
    check('панель фишек ДМ: форма создания и список всех фишек', () => {
      assert(tokensHost.querySelector('.token-form'), 'нет формы создания');
      assert(tokensHost.textContent.includes('Гоблин') && tokensHost.textContent.includes('Мира'), 'нет списка фишек');
      assert(tokensHost.querySelectorAll('.token-row button').length >= 1, 'нет кнопки удаления');
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

    /* ------------------------------------------------ сквозной сценарий */

    await waitFor(() => document.querySelector('#home-datadir').textContent !== '…', 'инициализация главного экрана');

    check('главный экран предлагает три сценария', () => {
      const cards = [...document.querySelectorAll('#screen-home .card__title')].map((node) => node.textContent);
      assert(cards.some((text) => text.includes('Создать новую кампанию')), 'нет создания кампании');
      assert(cards.some((text) => text.includes('Загрузить кампанию')), 'нет загрузки кампании');
      assert(cards.some((text) => text.includes('Подключиться к столу')), 'нет подключения');
    });
    check('на главном экране написано, что приложение не создаёт сеть', () => {
      const notice = document.querySelector('.home__notice').textContent;
      assert(notice.includes('не создаёт сеть'), 'нет предупреждения о сети');
      assert(notice.includes('Hamachi'), 'нет упоминания виртуальных сетей');
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
    document.querySelector('#tab-dice .dice__controls .btn--accent').click();
    await waitFor(() => document.querySelectorAll('#tab-dice .dice__row').length > 0, 'бросок в тренировочном столе');
    document.querySelector('.tabs__btn[data-tab="chat"]').click();
    const trainChatForm = document.querySelector('#tab-chat .chat__form');
    trainChatForm.querySelector('input').value = 'Проверка без сети';
    trainChatForm.requestSubmit();
    await waitFor(
      () => [...document.querySelectorAll('#tab-chat .chat__text')].some((node) => node.textContent === 'Проверка без сети'),
      'сообщение чата в тренировочном столе'
    );
    check('кубики и чат работают без сервера', () => {
      const diceRow = document.querySelector('#tab-dice .dice__row');
      assert(diceRow.textContent.includes('d20'), `строка броска: ${diceRow.textContent}`);
      assert(diceRow.textContent.includes('Игрок'), `в броске нет имени: ${diceRow.textContent}`);
      assert(document.querySelector('#tab-chat').textContent.includes('бросил d20'), 'бросок не попал в чат');
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

    check('экран подключения содержит адрес, имя и кнопку', () => {
      document.querySelector('#btn-go-join').click();
      assert(document.querySelector('#screen-join').classList.contains('is-active'), 'экран подключения не открылся');
      assert(document.querySelector('#join-address') && document.querySelector('#join-name'), 'нет полей ввода');
      assert(document.querySelector('#btn-join'), 'нет кнопки подключения');
      document.querySelector('[data-back]').click();
    });

    document.querySelector('#btn-go-create').click();
    check('кнопка «Создать новую кампанию» открывает экран создания', () => {
      assert(document.querySelector('#screen-create').classList.contains('is-active'), 'экран создания не открылся');
      assert(document.querySelector('#create-name'), 'нет поля названия кампании');
    });

    document.querySelector('#create-name').value = 'Смоук-кампания';
    document.querySelector('#btn-create-start').click();
    await waitFor(() => document.querySelector('#screen-table').classList.contains('is-active'), 'экран стола');
    await waitFor(() => document.querySelectorAll('#addresses-root .addr').length > 0, 'адреса подключения');
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
      assert(!document.querySelector('#addresses-panel').hidden, 'нет панели адресов');
    });
    check('показаны адреса для подключения с портом и кнопкой копирования', () => {
      const urls = [...document.querySelectorAll('#addresses-root .addr__url')].map((node) => node.textContent);
      assert(urls.length >= 1, 'нет ни одного адреса');
      assert(urls.some((url) => /^http:\/\/127\.0\.0\.1:\d+$/.test(url)), `нет локального адреса: ${urls.join(', ')}`);
      const copies = [...document.querySelectorAll('#addresses-root .addr button')]
        .filter((button) => button.textContent.includes('Скопировать адрес'));
      assert(copies.length === document.querySelectorAll('#addresses-root .addr').length, 'не у каждого адреса есть копирование');
    });
    check('адреса разложены по типам сети (локальная / виртуальная)', () => {
      assert(document.querySelector('#addresses-root .addr-group__title'), 'нет блоков группировки адресов');
      assert(document.querySelector('#addresses-root').textContent.includes('Локальная сеть'), 'нет блока локальной сети');
    });
    check('есть подсказка про брандмауэр и общую сеть', () => {
      const hint = document.querySelector('#addresses-panel .hint').textContent.replace(/\s+/g, ' ');
      assert(hint.includes('брандмауэр'), `нет упоминания брандмауэра: ${hint}`);
      assert(hint.includes('в одной локальной или виртуальной сети'), `нет требования общей сети: ${hint}`);
    });
    check('в панели адресов есть блок Porthole (проброс порта через Steam)', () => {
      const panel = document.querySelector('#addresses-panel');
      assert(panel.textContent.includes('Porthole'), 'нет блока Porthole');
      const porthole = panel.querySelector('.addr-group--porthole');
      assert(porthole, 'нет отдельного блока Porthole');
      const url = porthole.querySelector('.addr__url').textContent;
      assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(url), `адрес для Porthole: ${url}`);
      assert(porthole.textContent.includes('Порядок'), 'нет порядка действий для Porthole');
    });
    check('панель адресов сворачивается и разворачивается', () => {
      const toggle = document.querySelector('#addresses-toggle');
      assert(toggle, 'нет кнопки сворачивания');
      toggle.click();
      const panel = document.querySelector('#addresses-panel');
      assert(panel.classList.contains('is-collapsed'), 'панель не свернулась');
      const summary = document.querySelector('#addresses-summary');
      assert(!summary.hidden && summary.textContent.includes('http://'), `сводка при закрытой панели: ${summary.textContent}`);
      toggle.click();
      assert(!panel.classList.contains('is-collapsed'), 'панель не развернулась');
      assert(document.querySelector('#addresses-summary').hidden, 'сводка осталась при открытой панели');
    });
    check('карта стола показывает заглушку', () => {
      const empty = document.querySelector('#map-root .map-empty__text');
      assert(empty && empty.textContent.includes('Карта ещё не загружена ДМ'), 'нет заглушки карты');
      assert(!document.querySelector('#map-root .map-empty').hidden, 'заглушка скрыта');
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
      // Считаем видимые подписи: вкладка справочника приключения появляется
      // только после импорта, и проверка не должна ломаться на её отсутствии.
      const labels = [...document.querySelectorAll('.tabs__btn:not([hidden]) .tabs__label')];
      assert(labels.length === 4, `видимых подписей вкладок: ${labels.length}`);
      assert(labels.every((node) => getComputedStyle(node).display === 'none'), 'подписи вкладок остались видны');
      assert(document.querySelectorAll('.tabs__icon').length === 5, 'иконки вкладок пропали');

      document.querySelector('.tabs__btn[data-tab="dice"]').click();
      assert(!layout.classList.contains('is-right-collapsed'), 'панель не развернулась по клику на иконку');
      assert(document.querySelector('#tab-dice').classList.contains('is-active'), 'вкладка кубиков не открылась');
    });
    check('ДМ виден в списке участников с ролью', () => {
      assert(document.querySelector('#players-root .badge--dm'), 'нет бейджа ДМ');
      assert(document.querySelector('#players-root').textContent.includes('Мастер'), 'нет имени ДМ');
    });

    document.querySelector('.tabs__btn[data-tab="sheet"]').click();
    check('вкладка «Лист» у ДМ без игроков показывает список, а не пустой лист', () => {
      assert(document.querySelector('#tab-sheet').classList.contains('is-active'), 'вкладка не активна');
      assert(document.querySelector('#tab-sheet .sheet__players'), 'нет списка игроков');
      assert(document.querySelector('#tab-sheet .sheet__grid').hidden, 'лист показан, хотя игрок ещё не выбран');
      const empty = document.querySelector('#tab-sheet .sheet__players-empty');
      assert(empty && empty.textContent.includes('В лобби сейчас никого нет'), `текст: ${empty && empty.textContent}`);
    });

    /* ------------------------- второй участник: подключение игрока по сети */

    const hostInfo = await window.desktop.hostStatus();
    const playerSocket = window.io(hostInfo.localUrl, { transports: ['websocket'], forceNew: true });
    const playerInbox = { joined: null, errors: [], tokens: [], grid: null, maps: [] };
    playerSocket.on('joined', (payload) => { playerInbox.joined = payload; });
    playerSocket.on('errorMessage', (message) => playerInbox.errors.push(message.message));
    playerSocket.on('tokenCreated', (token) => playerInbox.tokens.push(token));
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
      assert(playerRow.querySelector('button').textContent === 'Открыть лист', 'нет кнопки открытия листа');
    });

    playerRow.querySelector('button').click();
    await waitFor(
      () => document.querySelector('#tab-sheet .sheet__status').textContent.includes('Просмотр'),
      'лист игрока у ДМ'
    );
    check('ДМ открывает лист игрока и видит актуальные данные', () => {
      assert(document.querySelector('#tab-sheet').classList.contains('is-active'), 'вкладка листа не открылась');
      const name = document.querySelector('#tab-sheet [data-field="characterName"]');
      assert(name.value === 'Мира', `имя в листе: ${name.value}`);
      assert(document.querySelector('#tab-sheet [data-field="charClass"]').value === 'Волшебница', 'класс');
      assert(document.querySelector('#tab-sheet .sheet__players').hidden, 'список игроков остался поверх листа');
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
      assert(!document.querySelector('#tab-sheet .sheet__players').hidden, 'список игроков не вернулся');
      assert(document.querySelector('#tab-sheet .sheet__grid').hidden, 'лист остался открытым');
    });
    check('во вкладке «Лист» ДМ видит игроков по именам', () => {
      const rows = [...document.querySelectorAll('#tab-sheet .sheet__players .player-row')];
      const row = rows.find((node) => node.textContent.includes('Борис'));
      assert(row, `в списке листов нет игрока: ${rows.map((node) => node.textContent).join(' | ')}`);
      assert(row.textContent.includes('в сети'), 'нет статуса игрока');
      row.click();
      assert(document.querySelector('#tab-sheet [data-field="characterName"]').value === 'Мира',
        'лист не открылся по нажатию на имя');
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

    document.querySelector('.modal-overlay [data-setting="grid"]').click();
    await waitFor(() => playerInbox.grid && playerInbox.grid.enabled === true, 'сетка у игрока');
    check('сетка, включённая ДМ, появляется на карте у всех участников', () => {
      const grid = document.querySelector('#map-root .map-grid');
      assert(grid && !grid.hidden, 'сетка не показана на карте у ДМ');
      assert(playerInbox.grid.enabled === true, 'игрок не получил состояние сетки');
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
    check('общая карта помечена как показанная игрокам', () => {
      const tabs = [...document.querySelectorAll('#map-root .map-tab')];
      assert(tabs[0].classList.contains('is-active'), 'вкладка общей карты не активна');
      assert(tabs[0].querySelector('.map-tab__dot').classList.contains('is-on'), 'нет отметки «показана игрокам»');
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
      assert(list.value === list.options[1].value, 'новая карта должна показываться сразу');
      assert(playerInbox.maps.some((update) => update.items && update.items.length === 2), 'игрок не получил список карт');
    });
    [...document.querySelectorAll('#map-root .map-toolbar button')]
      .find((node) => node.textContent === '◀').click();
    const switchedBack = await softWait(() => {
      const name = document.querySelector('#map-root .map-toolbar__name');
      return name && name.textContent.includes('battle.png');
    }, 'переключение на первую карту вкладки');
    check('переключение между картами вкладки доходит до стола', () => {
      assert(switchedBack, `не переключились на первую карту: ${mapDiagnostics()}`);
      assert(playerInbox.maps.some((update) => update.items && update.items[0].id === update.activeId),
        'игрок не увидел выбранную карту');
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
      assert(document.querySelectorAll('#map-root .map-tab')[2].querySelector('.map-tab__dot').classList.contains('is-on'),
        'нарисованная карта не отмечена как показанная игрокам');
      const errors = [...document.querySelectorAll('#toasts .toast--error')].map((node) => node.textContent);
      assert(!errors.length, `при сохранении рисунка были ошибки: ${errors.join(' | ')}`);
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

    // Дальше сценарий проверяет фишку на карте локации — возвращаем показ ей.
    document.querySelectorAll('#map-root .map-tab')[1].click();
    const showBattle = [...document.querySelectorAll('#map-root .map-toolbar button')]
      .find((node) => node.textContent.includes('Показать игрокам'));
    showBattle.click();
    const battleShown = await softWait(
      () => document.querySelectorAll('#map-root .map-tab')[1].querySelector('.map-tab__dot').classList.contains('is-on'),
      'показ карты локации игрокам'
    );
    check('ДМ возвращает показ игрокам на карту локации', () => {
      assert(battleShown, 'карта локации снова не показывается игрокам');
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
    check('игрок тоже получил событие о новой фишке', () => {
      assert(playerInbox.tokens.length === 1, `событий tokenCreated: ${playerInbox.tokens.length}`);
      assert(playerInbox.tokens[0].name === 'Смоук-фишка', 'имя фишки');
      assert(playerInbox.tokens[0].assignedPlayerId === null, 'фишка не назначена никому');
    });

    const smokeTokenId = playerInbox.tokens[0].id;
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
    document.querySelector('#tab-dice .dice__controls .btn--accent').click();
    await waitFor(() => document.querySelectorAll('#tab-dice .dice__row').length > 0, 'результат броска');
    check('бросок кубика обработан сервером и показан', () => {
      const row = document.querySelector('#tab-dice .dice__row');
      assert(row.textContent.includes('Мастер'), `нет имени ДМ в броске: ${row.textContent}`);
      assert(row.textContent.includes('d20'), `нет типа кости: ${row.textContent}`);
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

    document.querySelector('#btn-go-join').click();
    document.querySelector('#join-address').value = hostAgain.localUrl;
    document.querySelector('#join-name').value = 'Артём';
    document.querySelector('#btn-join').click();
    const draftPrompt = await softWait(
      () => {
        const overlay = document.querySelector('.modal-overlay');
        return overlay && overlay.textContent.includes('Отправить лист на стол');
      },
      'предложение отправить заготовку листа',
      10000
    );
    check('при подключении к столу предлагают перенести заготовку листа', () => {
      assert(draftPrompt, 'заготовку не предложили');
      const text = document.querySelector('.modal-overlay').textContent.replace(/\s+/g, ' ');
      assert(text.includes('пуст'), `не сказано, почему спрашивают: ${text.slice(0, 140)}`);
    });

    const sendDraft = [...document.querySelectorAll('.modal-overlay .modal__actions button')]
      .find((node) => node.textContent.includes('Отправить'));
    check('заготовку листа можно отправить на стол', () => {
      assert(sendDraft, 'нет кнопки «Отправить»');
      sendDraft.click();
    });
    await waitFor(
      () => [...document.querySelectorAll('#toasts .toast')].some((node) => node.textContent.includes('отправлен на стол')),
      'подтверждение отправки листа'
    );

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

    playerSocket.disconnect();
    return { checks, campaignId };
  })();
})();
