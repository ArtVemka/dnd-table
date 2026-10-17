'use strict';

/**
 * Интеграционный тест сервера стола.
 *
 * Поднимает настоящий сервер (Express + Socket.IO) и подключает к нему
 * настоящих клиентов socket.io-client — так же, как это делают окна Electron.
 * Проверяются роли, права доступа и полный обмен событиями.
 *
 * Запуск: npm test
 */

const assert = require('assert');
// Тот же модуль, что требует сервер: список настоящих костей проверяем оттуда.
const diceModule = require('../renderer/dice.js');
const LIMITS_MAX_INITIATIVE = 40;
const LIMITS_MAX_DEATH_SAVES = 3;
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');

const { CampaignStore } = require('../server/campaign');
const { createTableServer } = require('../server/socket');
const { RoomState, ROLE_DM, ROLE_PLAYER } = require('../server/state');

const HOST_KEY = 'test-host-key-0123456789';
/** Настоящий PNG 1x1. */
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
/** JPEG-байты, выданные за PNG — должны отбраковаться по сигнатуре файла. */
const FAKE_PNG_JPEG =
  'data:image/png;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, label, timeout = 4000) {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Таймаут ожидания: ${label}`);
    // eslint-disable-next-line no-await-in-loop
    await wait(20);
  }
}

const TRACKED = [
  'joined', 'playersUpdate', 'characterSheetData', 'characterSheetUpdated', 'mapUpdated',
  'tokenCreated', 'tokenUpdated', 'tokenMoved', 'tokenDeleted', 'tokenHidden', 'gridUpdated',
  'tokensUpdated',
  'diceRollResult', 'chatMessage', 'errorMessage'
];

/**
 * Спасбросок смерти по правилам 5e — копия правил из server/socket.js.
 *
 * Нужна рядом с проверками, где бросает живой сервер: там исход выпадает
 * случайно, и проверить сразу двадцатку и единицу нельзя. Правила в одном
 * месте с сервером держать не получится, поэтому здесь они выписаны прямо и
 * завязаны проверкой ниже.
 * @param {{hp: number, deathSavesSuccesses: number, deathSavesFailures: number}} sheet
 * @param {number} die
 * @returns {{hp: number, deathSavesSuccesses: number, deathSavesFailures: number}}
 */
function reviveOnTwenty(sheet, die) {
  const max = LIMITS_MAX_DEATH_SAVES;
  const next = { ...sheet };
  if (die === 20) {
    next.hp = 1;
    next.deathSavesSuccesses = 0;
    next.deathSavesFailures = 0;
  } else if (die === 1) {
    next.deathSavesFailures = Math.min(max, next.deathSavesFailures + 2);
  } else if (die >= 10) {
    next.deathSavesSuccesses = Math.min(max, next.deathSavesSuccesses + 1);
  } else {
    next.deathSavesFailures = Math.min(max, next.deathSavesFailures + 1);
  }
  return next;
}

/**
 * Читает список костей из исходника, где он задан литералом массива.
 * Нужен, чтобы сверить копию списка в renderer с копией в server: они
 * продублированы, потому что renderer не может потребовать серверный файл.
 * @param {string} file
 * @returns {number[]}
 */
function readDiceSides(file) {
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/DICE_SIDES\s*=\s*\[([^\]]+)\]/);
  if (!match) throw new Error(`в ${file} нет списка костей`);
  return match[1].split(',').map((part) => Number(part.trim())).filter((n) => Number.isFinite(n));
}

function makeClient(port) {
  const socket = io(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true
  });
  socket.log = {};
  for (const event of TRACKED) {
    socket.log[event] = [];
    socket.on(event, (payload) => socket.log[event].push(payload));
  }
  return socket;
}

function join(client, payload) {
  return new Promise((resolve) => client.emit('joinRoom', payload, resolve));
}

const once = (client, event) => new Promise((resolve) => client.once(event, resolve));
const emit = (client, event, payload) => client.emit(event, payload);

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

function playerSheetData(client) {
  return client.log.characterSheetData;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-table-test-'));
  const store = new CampaignStore(path.join(root, 'campaigns'));
  const campaign = await store.create('Тестовая кампания');

  const room = new RoomState(campaign);
  let dirtyCount = 0;
  const server = await createTableServer({
    room,
    store,
    hostKey: HOST_KEY,
    preferredPort: 33210,
    onDirty: () => { dirtyCount += 1; },
    onLog: () => {}
  });

  const url = `http://127.0.0.1:${server.port}`;
  const clients = [];
  const open = async (payload) => {
    const client = makeClient(server.port);
    clients.push(client);
    await once(client, 'connect');
    // 'joined' приходит раньше ack, поэтому подписываемся заранее.
    const joined = once(client, 'joined');
    const ack = await join(client, payload);
    await joined;
    return { client, ack };
  };

  console.log(`\nСервер поднят на ${url}\n`);

  /* ------------------------------------------------------- сервер и сеть */

  console.log('Сервер и сеть');
  check('слушает только 127.0.0.1: наружу порт не выставлен', () => {
    assert.strictEqual(server.httpServer.address().address, '127.0.0.1');
  });
  check('список сетевых адресов больше не возвращается', () => {
    assert.strictEqual(server.addresses, undefined);
  });
  check('порт выбран автоматически', () => {
    assert.ok(Number.isInteger(server.port) && server.port > 0);
  });
  const info = await httpGet(`${url}/api/info`);
  check('/api/info отдаёт имя кампании', () => {
    assert.strictEqual(info.status, 200);
    assert.strictEqual(JSON.parse(info.body.toString()).campaign.name, 'Тестовая кампания');
  });

  /* -------------------------------------------------------- роли и вход */

  console.log('\nРоли и подключение');
  const guest = makeClient(server.port);
  clients.push(guest);
  await once(guest, 'connect');
  const emptyName = await join(guest, { name: '   ', playerId: null, hostKey: HOST_KEY });
  check('пустое имя отклоняется даже с ключом ДМ', () => {
    assert.strictEqual(emptyName.ok, false);
  });

  const { client: dm, ack: dmJoin } = await open({ name: 'Мастер', playerId: 'dm', hostKey: HOST_KEY });
  check('ДМ получает роль dm по hostKey с localhost', () => {
    assert.strictEqual(dmJoin.ok, true);
    assert.strictEqual(dmJoin.you.role, 'dm');
    assert.strictEqual(dmJoin.you.playerId, 'dm');
  });

  const { client: impostor, ack: impostorJoin } = await open({
    name: 'Не Мастер', playerId: 'p-impostor', hostKey: 'wrong-key-000000'
  });
  check('неверный hostKey не даёт роль ДМ', () => {
    assert.strictEqual(impostorJoin.you.role, 'player');
    assert.strictEqual(impostorJoin.you.playerId, 'p-impostor');
  });

  const { client: p1, ack: p1Join } = await open({ name: 'Артём', playerId: 'p-test-0001' });
  check('игрок подключается со своим локальным playerId', () => {
    assert.strictEqual(p1Join.you.role, 'player');
    assert.strictEqual(p1Join.you.playerId, 'p-test-0001');
  });

  const { client: p2, ack: p2Join } = await open({ name: 'Борис', playerId: 'p-test-0002' });
  check('второй игрок подключается', () => {
    assert.strictEqual(p2Join.you.playerId, 'p-test-0002');
  });

  const players = await waitFor(
    () => dm.log.playersUpdate.find((list) => list.length === 4) ? dm.log.playersUpdate[dm.log.playersUpdate.length - 1] : null,
    'playersUpdate со всеми участниками'
  );
  check('список игроков содержит ДМ и игроков с ролями и статусом', () => {
    const dmEntry = players.find((player) => player.playerId === 'dm');
    assert.ok(dmEntry, 'нет записи ДМ');
    assert.strictEqual(dmEntry.role, 'dm');
    assert.strictEqual(players.filter((player) => player.role === 'player').length, 3);
    assert.ok(players.every((player) => player.online));
  });
  check('в снимке игрока нет чужих листов персонажей', () => {
    const snapshot = room.snapshotFor({ playerId: 'p-test-0001', role: 'player' });
    assert.deepStrictEqual(Object.keys(snapshot.sheets), ['p-test-0001']);
  });

  /* --------------------------------------------------- лист персонажа */

  console.log('\nЛист персонажа D&D 5e 2014');
  const sheet = {
    playerName: 'Артём',
    characterName: 'Тордин',
    charClass: 'Воин',
    race: 'Дварф',
    background: 'Солдат',
    alignment: 'Законно-добрый',
    level: 5,
    experience: 6500,
    abilities: { str: 17, dex: 14, con: 16, int: 10, wis: 12, cha: 8 },
    saveProficiencies: { str: true, con: true },
    skillProficiencies: { athletics: true, perception: false },
    skillExpertise: { athletics: true, stealth: true },
    hp: 44, maxHp: 44, tempHp: 0, hitDice: '1d10',
    armorClass: 18, initiativeMisc: 0, speed: 25,
    attacks: 'Боевой топор +7, 1d8+3',
    equipment: 'Кольчуга, щит',
    features: 'Второе дыхание',
    notes: 'Ищет брата'
  };
  emit(p1, 'saveCharacterSheet', { sheet });
  const saved = await waitFor(() => playerSheetData(p1)[0], 'эхо сохранённого листа');
  check('лист 5e принимается целиком и возвращается автору', () => {
    assert.strictEqual(saved.playerId, 'p-test-0001');
    assert.strictEqual(saved.sheet.characterName, 'Тордин');
    assert.strictEqual(saved.sheet.level, 5);
    assert.strictEqual(saved.sheet.abilities.str, 17);
    assert.strictEqual(saved.sheet.hitDice, '1d10');
    assert.strictEqual(saved.sheet.armorClass, 18);
    assert.strictEqual(saved.sheet.proficiencyBonusManual, null);
  });
  check('компетентность без владения сбрасывается', () => {
    assert.strictEqual(saved.sheet.skillProficiencies.stealth, false);
    assert.strictEqual(saved.sheet.skillExpertise.stealth, false);
    assert.strictEqual(saved.sheet.skillExpertise.athletics, true);
  });
  check('ДМ получает уведомление об изменении листа игрока', () => {
    assert.strictEqual(dm.log.characterSheetUpdated[0].playerId, 'p-test-0001');
  });

  emit(p1, 'saveCharacterSheet', { sheet: { ...sheet, abilities: { str: 99, dex: -5 } } });
  const clamped = await waitFor(() => playerSheetData(p1)[1], 'лист с ограниченными характеристиками');
  check('значения характеристик ограничены диапазоном 1..30', () => {
    assert.strictEqual(clamped.sheet.abilities.str, 30);
    assert.strictEqual(clamped.sheet.abilities.dex, 1);
  });
  emit(p1, 'saveCharacterSheet', { sheet });
  await waitFor(() => playerSheetData(p1).length >= 3, 'восстановление листа');
  await wait(60);

  emit(p2, 'saveCharacterSheet', { sheet: { playerName: 'Борис', characterName: 'Мира', charClass: 'Волшебница' } });
  await waitFor(
    () => dm.log.characterSheetUpdated.find((item) => item.playerId === 'p-test-0002'),
    'второй лист у ДМ'
  );

  p1.log.errorMessage.length = 0;
  emit(p1, 'requestCharacterSheet', { playerId: 'p-test-0002' });
  await waitFor(
    () => p1.log.errorMessage.find((item) => item.message.includes('только свой лист')),
    'отказ в чужом листе'
  );
  check('игрок не может получить чужой лист персонажа', () => {
    assert.ok(!p1.log.characterSheetData.some((item) => item.playerId === 'p-test-0002'));
  });

  playerSheetData(p1).length = 0;
  emit(p1, 'saveCharacterSheet', { sheet: { playerName: 'Артём', characterName: 'Мира' } });
  const ownOnly = await waitFor(() => playerSheetData(p1)[0], 'сохранение под своим playerId');
  check('игрок не может сохранить лист под чужим playerId', () => {
    assert.strictEqual(ownOnly.playerId, 'p-test-0001');
    assert.strictEqual(room.sheets.get('p-test-0002').characterName, 'Мира');
  });
  emit(p1, 'saveCharacterSheet', { sheet });
  await wait(60);

  dm.log.characterSheetData.length = 0;
  emit(dm, 'requestCharacterSheet', { playerId: 'p-test-0001' });
  const dmSheet = await waitFor(() => dm.log.characterSheetData[0], 'лист для ДМ');
  check('ДМ запрашивает лист игрока и видит актуальные данные', () => {
    assert.strictEqual(dmSheet.playerId, 'p-test-0001');
    assert.strictEqual(dmSheet.sheet.characterName, 'Тордин');
  });
  check('в снимке ДМ есть листы всех игроков', () => {
    const snapshot = room.snapshotFor({ playerId: 'dm', role: 'dm' });
    assert.strictEqual(Object.keys(snapshot.sheets).length, 3);
  });

  /* --------------------------------------------------------------- карты */

  console.log('\nКарты');
  p1.log.errorMessage.length = 0;
  emit(p1, 'uploadMap', { type: 'world', image: PNG_1PX });
  await waitFor(() => p1.log.errorMessage.find((item) => item.message.includes('только ДМ')), 'отказ игроку в загрузке карты');
  check('игрок не может загружать карты', () => {
    assert.strictEqual(room.maps.world.items.length, 0);
  });

  emit(dm, 'uploadMap', { type: 'world', image: PNG_1PX, name: 'world.png' });
  const worldMap = await waitFor(
    () => dm.log.mapUpdated.find((item) => item.type === 'world' && item.items && item.items.length),
    'общая карта'
  );
  check('ДМ загружает общую карту, клиенты получают список карт вкладки', () => {
    assert.strictEqual(worldMap.items.length, 1);
    assert.match(worldMap.items[0].url, /^\/files\/.+\.png$/);
    assert.strictEqual(worldMap.items[0].name, 'world.png');
    assert.strictEqual(worldMap.activeId, worldMap.items[0].id);
    assert.strictEqual(worldMap.activeMap, 'world');
  });
  const imageResponse = await httpGet(`${url}${worldMap.items[0].url}`);
  check('изображение карты раздаётся клиентам по HTTP', () => {
    assert.strictEqual(imageResponse.status, 200);
    assert.strictEqual(imageResponse.body[0], 0x89);
    assert.strictEqual(imageResponse.body[1], 0x50);
  });

  const traversal = await httpGet(`${url}/files/..%2Fcampaign.json`);
  check('нельзя выйти за папку files и скачать файл кампании', () => {
    assert.notStrictEqual(traversal.status, 200);
  });

  dm.log.errorMessage.length = 0;
  emit(dm, 'uploadMap', { type: 'battle', image: `data:text/plain;base64,${Buffer.from('не картинка').toString('base64')}` });
  await waitFor(() => dm.log.errorMessage.find((item) => item.message.includes('PNG, JPG')), 'отказ по MIME');
  check('данные не-image MIME отклоняются', () => {
    assert.strictEqual(room.maps.battle.items.length, 0);
  });

  dm.log.errorMessage.length = 0;
  emit(dm, 'uploadMap', { type: 'battle', image: `data:image/png;base64,${Buffer.from('это просто текст').toString('base64')}` });
  await waitFor(() => dm.log.errorMessage.find((item) => item.message.includes('не является изображением')), 'отказ по сигнатуре');
  check('не-изображение под видом PNG отклоняется по сигнатуре файла', () => {
    assert.strictEqual(room.maps.battle.items.length, 0);
  });

  // Формат распознаётся по сигнатуре, поэтому в ошибке видно, что именно выбрал
  // пользователь: иначе он видит только «неподдерживаемый тип файла» и не знает,
  // что делать.
  const asDataUrl = (mime, bytes) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  const unsupported = [
    { name: 'GIF', mime: 'image/png', bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0, 0, 0] },
    { name: 'BMP', mime: 'image/bmp', bytes: [0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { name: 'TIFF', mime: 'image/tiff', bytes: [0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0, 0, 0, 0, 0] },
    { name: 'HEIC', mime: 'image/heic', bytes: [...'0000ftypheic'].map((c) => c.charCodeAt(0)) },
    { name: 'SVG', mime: 'image/svg+xml', bytes: [...'<svg xmlns="http://www.w3.org/2000/svg"></svg>'].map((c) => c.charCodeAt(0)) }
  ];
  for (const item of unsupported) {
    dm.log.errorMessage.length = 0;
    // MIME в data URL подделываем на image/png, чтобы проверка дошла до сигнатуры.
    const bytes = (item.name === 'BMP' || item.name === 'TIFF')
      ? Buffer.concat([Buffer.from(item.bytes), Buffer.alloc(16)])
      : Buffer.from(item.bytes);
    emit(dm, 'uploadMap', { type: 'battle', image: asDataUrl('image/png', bytes) });
    try {
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => dm.log.errorMessage.find((message) => message.message.includes(item.name)), `ошибка для ${item.name}`, 2000);
      check(`в ошибке для ${item.name} назван реальный формат файла`, () => {
        const message = dm.log.errorMessage[0].message;
        assert.ok(message.includes(item.name), message);
        assert.ok(message.includes('PNG, JPG или WEBP'), `нет подсказки: ${message}`);
      });
    } catch {
      check(`в ошибке для ${item.name} назван реальный формат файла`, () => {
        assert.fail(`сообщение не назвало формат: ${JSON.stringify(dm.log.errorMessage)}`);
      });
    }
  }
  check('неподдерживаемые форматы не попали в кампанию', () => {
    assert.strictEqual(room.maps.battle.items.length, 0);
  });

  dm.log.errorMessage.length = 0;
  emit(dm, 'uploadMap', { type: 'battle', image: FAKE_PNG_JPEG, name: 'fake.png' });
  const sniffed = await waitFor(
    () => dm.log.mapUpdated.filter((item) => item.type === 'battle' && item.items.length).pop(),
    'определение реального типа'
  );
  check('подлинный тип определяется по сигнатуре, а не по MIME клиента', () => {
    assert.match(sniffed.items[0].url, /\.jpg$/, 'JPEG-содержимое должно сохраниться как .jpg');
  });
  emit(dm, 'deleteMap', { type: 'battle' });
  await waitFor(() => room.maps.battle.items.length === 0, 'очистка карты битвы');

  dm.log.errorMessage.length = 0;
  emit(dm, 'uploadMap', { type: 'nope', image: PNG_1PX });
  await waitFor(() => dm.log.errorMessage.find((item) => item.message.includes('тип карты')), 'отказ по типу карты');
  check('неизвестный тип карты отклоняется', () => {
    assert.strictEqual(room.maps.battle.items.length, 0);
  });

  dm.log.errorMessage.length = 0;
  const huge = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(11 * 1024 * 1024)]).toString('base64')}`;
  emit(dm, 'uploadMap', { type: 'battle', image: huge });
  await waitFor(() => dm.log.errorMessage.find((item) => item.message.includes('больше')), 'отказ по размеру');
  check('изображение больше 10 МБ отклоняется', () => {
    assert.strictEqual(room.maps.battle.items.length, 0);
  });

  // Перед каждой загрузкой чистим журнал: иначе waitFor ниже может удовлетвориться
  // событием от предыдущей операции, и следующая проверка прочитает сервер слишком рано.
  dm.log.mapUpdated.length = 0;
  emit(dm, 'uploadMap', { type: 'battle', image: PNG_1PX, name: 'battle.png' });
  const battleMap = await waitFor(
    () => dm.log.mapUpdated.filter((item) => item.type === 'battle' && item.items.length).pop(),
    'карта битвы'
  );
  check('вторая карта загружается и становится активной', () => {
    assert.strictEqual(battleMap.activeMap, 'battle');
  });

  /* ---------------------------- несколько карт в одной вкладке */

  dm.log.mapUpdated.length = 0;
  emit(dm, 'uploadMap', { type: 'battle', image: PNG_1PX, name: 'пещера.png' });
  const secondBattle = await waitFor(
    () => dm.log.mapUpdated.filter((item) => item.type === 'battle' && item.items.length === 2).pop(),
    'вторая карта в той же вкладке'
  );
  check('во вкладку можно загрузить ещё одну карту, не потеряв прежнюю', () => {
    assert.strictEqual(secondBattle.items.length, 2, `карт во вкладке: ${secondBattle.items.length}`);
    assert.strictEqual(secondBattle.items[1].name, 'пещера.png');
    assert.strictEqual(secondBattle.activeId, secondBattle.items[1].id, 'новая карта должна показываться сразу');
    assert.strictEqual(room.currentMap('battle').name, 'пещера.png');
  });

  p1.log.mapUpdated.length = 0;
  emit(dm, 'selectMap', { type: 'battle', mapId: secondBattle.items[0].id });
  // Ждём именно события с activeId нужной карты. Если брать «последнее с
  // activeId», можно поймать ещё не долетевшее событие загрузки пещеры —
  // проверка прошла бы раньше, чем сервер применил selectMap, и упала бы.
  const switched = await waitFor(
    () => p1.log.mapUpdated.filter((item) => item.activeId === secondBattle.items[0].id).pop(),
    'переключение карты во вкладке'
  );
  check('ДМ переключается между картами вкладки, игроки видят выбранную', () => {
    assert.strictEqual(switched.activeId, secondBattle.items[0].id);
    assert.strictEqual(switched.activeMap, 'battle');
    assert.strictEqual(room.currentMap('battle').name, 'battle.png');
    assert.strictEqual(room.maps.battle.items.length, 2, 'переключение не должно терять карты');
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'selectMap', { type: 'battle', mapId: secondBattle.items[1].id });
  await waitFor(() => p1.log.errorMessage.find((item) => item.message.includes('только ДМ')), 'отказ игроку в переключении карт');
  check('игрок не может переключать карты вкладки', () => {
    assert.strictEqual(room.currentMap('battle').name, 'battle.png');
  });

  dm.log.errorMessage.length = 0;
  dm.log.mapUpdated.length = 0;
  emit(dm, 'deleteMap', { type: 'battle', mapId: secondBattle.items[1].id });
  const afterDelete = await waitFor(
    () => dm.log.mapUpdated.filter((item) => item.type === 'battle' && item.items.length === 1).pop(),
    'удаление одной карты из вкладки'
  );
  check('удаляется только выбранная карта, остальные остаются', () => {
    assert.strictEqual(dm.log.errorMessage.length, 0, `ошибка при удалении: ${JSON.stringify(dm.log.errorMessage)}`);
    assert.strictEqual(afterDelete.items[0].name, 'battle.png');
    assert.strictEqual(room.maps.battle.items.length, 1);
  });

  check('кампания старого формата (одна карта на вкладку) открывается', () => {
    const legacy = new RoomState({
      id: 'c-legacy',
      state: { maps: { world: { url: '/files/old.png', name: 'старая.png' } } }
    });
    assert.strictEqual(legacy.maps.world.items.length, 1, 'старая карта должна превратиться в список');
    assert.strictEqual(legacy.maps.world.items[0].url, '/files/old.png');
    assert.strictEqual(legacy.currentMap('world').name, 'старая.png');
    assert.strictEqual(legacy.maps.battle.items.length, 0);
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'setActiveMap', { type: 'world' });
  await waitFor(() => p1.log.errorMessage.find((item) => item.message.includes('только ДМ')), 'отказ в смене карты');
  check('игрок не может переключать активную карту', () => {
    assert.strictEqual(room.activeMap, 'battle');
  });

  p1.log.mapUpdated.length = 0;
  emit(dm, 'setActiveMap', { type: 'world' });
  await waitFor(() => p1.log.mapUpdated.find((item) => item.activeMap === 'world'), 'смена активной карты');
  check('ДМ переключает активную карту для всех клиентов', () => {
    assert.strictEqual(room.activeMap, 'world');
  });

  p1.log.mapUpdated.length = 0;
  emit(dm, 'deleteMap', { type: 'battle' });
  await waitFor(
    () => p1.log.mapUpdated.find((item) => item.type === 'battle' && item.items.length === 0),
    'удаление карты'
  );
  check('ДМ удаляет последнюю карту вкладки', () => {
    assert.strictEqual(room.maps.battle.items.length, 0);
    assert.strictEqual(room.activeMap, 'world', 'показ должен вернуться к оставшейся вкладке');
  });
  emit(dm, 'uploadMap', { type: 'battle', image: PNG_1PX, name: 'battle.png' });
  await waitFor(() => room.maps.battle.items.length > 0, 'повторная загрузка карты битвы');
  emit(dm, 'setActiveMap', { type: 'world' });
  await wait(80);

  // Третья карта — та, что ДМ нарисовал сам на холсте.
  dm.log.mapUpdated.length = 0;
  emit(dm, 'uploadMap', { type: 'sketch', image: PNG_1PX, name: 'Рисунок.png' });
  const sketchMap = await waitFor(
    () => dm.log.mapUpdated.find((item) => item.type === 'sketch' && item.items.length),
    'карта-рисунок'
  );
  check('нарисованная карта («Рисунок») хранится наравне с общей и локацией', () => {
    assert.match(sketchMap.items[0].url, /^\/files\/.+\.png$/);
    assert.strictEqual(sketchMap.items[0].name, 'Рисунок.png');
    assert.strictEqual(room.activeMap, 'sketch');
  });
  dm.log.errorMessage.length = 0;
  emit(dm, 'createToken', { name: 'Метка на рисунке', mapType: 'sketch' });
  const sketchToken = await waitFor(
    () => dm.log.tokenCreated.find((token) => token.mapType === 'sketch'),
    'фишка на карте-рисунке'
  );
  check('на карту-рисунок можно ставить фишки', () => {
    assert.strictEqual(sketchToken.mapType, 'sketch');
  });
  emit(dm, 'deleteToken', { tokenId: sketchToken.id });
  await waitFor(() => !room.tokens.some((token) => token.id === sketchToken.id), 'уборка фишки с рисунка');
  // Дальше по сценарию проверки читают первые события списка — чистим за собой.
  dm.log.tokenCreated.length = 0;
  emit(dm, 'deleteMap', { type: 'sketch' });
  await waitFor(() => room.maps.sketch.items.length === 0, 'удаление карты-рисунка');
  check('удаление карты-рисунка возвращает показ к оставшейся карте', () => {
    assert.strictEqual(room.activeMap, 'world');
  });
  // Возвращаем рисунок: ниже проверим, что три карты вместе переживают
  // сохранение и загрузку кампании.
  emit(dm, 'uploadMap', { type: 'sketch', image: PNG_1PX, name: 'Рисунок.png' });
  await waitFor(() => room.maps.sketch.items.length > 0, 'повторная загрузка карты-рисунка');
  emit(dm, 'setActiveMap', { type: 'world' });
  await waitFor(() => room.activeMap === 'world', 'возврат к общей карте');

  /* --------------------------------------------------------------- сетка */

  console.log('\nСетка на карте');
  p1.log.errorMessage.length = 0;
  emit(p1, 'setGrid', { enabled: true, cell: 46 });
  await waitFor(() => p1.log.errorMessage.find((item) => item.message.includes('только ДМ')), 'отказ игроку в сетке');
  check('игрок не может включать сетку', () => {
    assert.strictEqual(room.grid.enabled, false);
  });

  p1.log.gridUpdated.length = 0;
  emit(dm, 'setGrid', { enabled: true, cell: 60 });
  const gridEvent = await waitFor(() => p1.log.gridUpdated[0], 'рассылка сетки');
  check('ДМ включает сетку — её видят все участники', () => {
    assert.strictEqual(gridEvent.enabled, true);
    assert.strictEqual(gridEvent.cell, 60);
    assert.strictEqual(room.grid.enabled, true);
  });

  dm.log.gridUpdated.length = 0;
  emit(dm, 'setGrid', { enabled: true, cell: 2 });
  await waitFor(() => dm.log.gridUpdated[0], 'ограничение размера клетки снизу');
  dm.log.gridUpdated.length = 0;
  emit(dm, 'setGrid', { enabled: true, cell: 5000 });
  await waitFor(() => dm.log.gridUpdated[0], 'ограничение размера клетки сверху');
  check('размер клетки ограничен допустимым диапазоном', () => {
    assert.strictEqual(room.grid.cell, 512);
  });

  // Оставляем включённую сетку нестандартного размера: ниже проверим, что она
  // переживает сохранение и загрузку кампании.
  emit(dm, 'setGrid', { enabled: true, cell: 56 });
  await waitFor(() => room.grid.cell === 56, 'сетка 56 px');

  // Подгонка сетки под карту: мастер задаёт, сколько клеток по ширине, а
  // размер клетки каждый участник считает сам от ширины подложки. Проверяем,
  // что число доезжает до всех одинаково и не ломает ручной размер.
  emit(dm, 'setGrid', { enabled: true, cell: 56, columns: 20 });
  await waitFor(() => room.grid.columns === 20, 'подгонка сетки под карту');
  check('подгонка сетки по ширине карты доезжает до всех участников', () => {
    assert.strictEqual(room.grid.columns, 20);
    assert.strictEqual(dm.log.gridUpdated.at(-1).columns, 20, 'мастер должен увидеть новое число');
    assert.strictEqual(p1.log.gridUpdated.at(-1).columns, 20, 'игрок должен увидеть то же число');
  });
  // Ноль означает «размер клетки задаёт мастер» — возвращаем ручной режим.
  emit(dm, 'setGrid', { enabled: true, cell: 56, columns: 0 });
  await waitFor(() => room.grid.columns === 0, 'ручной размер клетки');
  check('ноль возвращает ручной размер клетки', () => {
    assert.strictEqual(room.grid.columns, 0);
    assert.strictEqual(room.grid.cell, 56, 'ручной размер клетки не должен слететь');
  });

  /* -------------------------------------------------------------- фишки */

  console.log('\nФишки');
  p1.log.errorMessage.length = 0;
  emit(p1, 'createToken', { name: 'Гоблин' });
  await waitFor(() => p1.log.errorMessage.find((item) => item.message.includes('только ДМ')), 'отказ в создании фишки');
  check('игрок не может создавать фишки', () => {
    assert.strictEqual(room.tokens.length, 0);
  });

  emit(dm, 'createToken', { name: 'Гоблин', mapType: 'world' });
  const token = await waitFor(() => dm.log.tokenCreated[0], 'создание фишки');
  check('ДМ создаёт фишку в центре выбранной карты', () => {
    assert.strictEqual(token.name, 'Гоблин');
    assert.strictEqual(token.mapType, 'world');
    assert.strictEqual(token.x, 0.5);
    assert.strictEqual(token.y, 0.5);
    assert.strictEqual(token.assignedPlayerId, null);
    assert.ok(token.color);
  });
  check('новая фишка появляется скрытой от игроков', () => {
    assert.strictEqual(token.hidden, true);
    assert.strictEqual(p1.log.tokenCreated.length, 0, 'игрок получил скрытую фишку');
    assert.strictEqual(p2.log.tokenCreated.length, 0, 'игрок получил скрытую фишку');
  });
  check('снимок состояния игрока не содержит скрытых фишек', () => {
    const snapshot = room.snapshotFor({ playerId: 'p-test-0001', role: 'player' });
    assert.strictEqual(snapshot.tokens.length, 0, `игрок увидел ${snapshot.tokens.length} фишек`);
  });
  check('скрытая фишка не выдаёт своё существование в списке участников', () => {
    const snapshot = room.snapshotFor({ playerId: 'p-test-0001', role: 'player' });
    const me = snapshot.players.find((entry) => entry.playerId === 'p-test-0001');
    assert.strictEqual(me.tokenId, null, 'игрок увидел отметку о фишке, которую не должен знать');
  });

  // Дальше идут проверки, где игрок двигает и красит свою фишку. Дальше по
  // логике сервера игрок получает фишку только после показа, поэтому мастер
  // открывает её здесь — один раз, явно.
  dm.log.tokenCreated.length = 0;
  p1.log.tokenCreated.length = 0;
  p2.log.tokenCreated.length = 0;
  emit(dm, 'setTokenHidden', { tokenId: token.id, hidden: false });
  await waitFor(() => p1.log.tokenCreated.length === 1, 'показ фишки игрокам');
  check('показанная фишка приходит игрокам как новая', () => {
    assert.strictEqual(p1.log.tokenCreated[0].id, token.id);
    assert.strictEqual(p1.log.tokenCreated[0].hidden, false);
    assert.strictEqual(p2.log.tokenCreated[0].id, token.id);
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'moveToken', { tokenId: token.id, x: 0.3, y: 0.3 });
  await waitFor(() => p1.log.errorMessage.find((item) => item.message.includes('только свою фишку')), 'отказ в чужой фишке');
  check('неназначенную фишку двигает только ДМ', () => {
    assert.strictEqual(room.tokens[0].x, 0.5);
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'deleteToken', { tokenId: token.id });
  await waitFor(() => p1.log.errorMessage.find((item) => item.message.includes('только ДМ')), 'отказ в удалении фишки');
  check('игрок не может удалить фишку', () => {
    assert.strictEqual(room.tokens.length, 1);
  });

  emit(dm, 'assignTokenToPlayer', { tokenId: token.id, playerId: 'p-test-0001' });
  const assigned = await waitFor(() => dm.log.tokenUpdated.find((item) => item.assignedPlayerId), 'назначение фишки');
  check('ДМ назначает фишку игроку', () => {
    assert.strictEqual(assigned.assignedPlayerId, 'p-test-0001');
  });

  dm.log.errorMessage.length = 0;
  emit(dm, 'assignTokenToPlayer', { tokenId: token.id, playerId: 'p-unknown' });
  await waitFor(() => dm.log.errorMessage.find((item) => item.message.includes('Игрок не найден')), 'отказ по несуществующему игроку');

  p2.log.errorMessage.length = 0;
  emit(p2, 'moveToken', { tokenId: token.id, x: 0.2, y: 0.2 });
  await waitFor(() => p2.log.errorMessage.find((item) => item.message.includes('только свою фишку')), 'отказ второму игроку');
  check('другой игрок не может двигать чужую фишку', () => {
    assert.strictEqual(room.tokens[0].x, 0.5);
  });

  emit(p1, 'moveToken', { tokenId: token.id, x: 0.25, y: 0.75 });
  const moved = await waitFor(() => p1.log.tokenMoved[0], 'движение своей фишки');
  check('владелец фишки может её двигать, позиция летит всем', () => {
    assert.strictEqual(moved.tokenId, token.id);
    assert.strictEqual(moved.x, 0.25);
    assert.strictEqual(moved.y, 0.75);
    assert.strictEqual(p2.log.tokenMoved[0].x, 0.25);
  });

  emit(p1, 'moveToken', { tokenId: token.id, x: 5, y: -3 });
  const clampedMove = await waitFor(() => p1.log.tokenMoved[1], 'ограничение координат');
  check('координаты фишки ограничены диапазоном 0..1', () => {
    assert.strictEqual(clampedMove.x, 1);
    assert.strictEqual(clampedMove.y, 0);
  });

  emit(dm, 'moveToken', { tokenId: token.id, x: 0.4, y: 0.4 });
  await waitFor(() => p2.log.tokenMoved.length >= 3, 'движение фишки ДМом');
  check('ДМ двигает любую фишку', () => {
    assert.strictEqual(room.tokens[0].x, 0.4);
  });

  p2.log.errorMessage.length = 0;
  emit(p2, 'setTokenImage', { tokenId: token.id, image: PNG_1PX });
  await waitFor(() => p2.log.errorMessage.find((item) => item.message.includes('только своей фишки')), 'отказ в чужом изображении');

  emit(p1, 'setTokenImage', { tokenId: token.id, image: PNG_1PX });
  const withImage = await waitFor(() => p1.log.tokenUpdated.find((item) => item.imageUrl), 'изображение фишки');
  check('игрок загружает изображение своей фишки', () => {
    assert.match(withImage.imageUrl, /^\/files\/.+\.png$/);
  });

  emit(dm, 'renameToken', { tokenId: token.id, name: 'Гоблин-вождь' });
  const renamed = await waitFor(() => dm.log.tokenUpdated.find((item) => item.name === 'Гоблин-вождь'), 'переименование');
  check('ДМ переименовывает фишку', () => {
    assert.strictEqual(renamed.name, 'Гоблин-вождь');
  });

  /* --- скрытие фишек --- */

  console.log('\nСкрытие фишек');
  p1.log.tokenUpdated.length = 0;
  p1.log.tokenMoved.length = 0;
  emit(dm, 'setTokenHidden', { tokenId: token.id, hidden: true });
  await waitFor(() => p1.log.tokenHidden.find((item) => item.tokenId === token.id && item.hidden), 'скрытие фишки');
  check('скрытие рассылается игрокам, чтобы убрать фишку с карты', () => {
    assert.ok(room.tokens.find((item) => item.id === token.id).hidden, 'на сервере не скрыта');
  });
  check('скрытая фишка не шлёт игрокам ни правок, ни перемещений', async () => {
    emit(dm, 'renameToken', { tokenId: token.id, name: 'Заготовка' });
    emit(dm, 'moveToken', { tokenId: token.id, x: 0.9, y: 0.9 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(p1.log.tokenUpdated.length, 0, 'игрок увидел правку скрытой фишки');
    assert.strictEqual(p1.log.tokenMoved.length, 0, 'игрок увидел перемещение скрытой фишки');
  });

  dm.log.errorMessage.length = 0;
  p1.log.errorMessage.length = 0;
  emit(p1, 'setTokenHidden', { tokenId: token.id, hidden: false });
  await new Promise((resolve) => setTimeout(resolve, 300));
  check('игрок не может открыть скрытую фишку', () => {
    assert.ok(room.tokens.find((item) => item.id === token.id).hidden, 'фишку открыли без мастера');
  });

  p1.log.tokenCreated.length = 0;
  emit(dm, 'setTokenHidden', { tokenId: token.id, hidden: false });
  await waitFor(() => room.tokens.find((item) => item.id === token.id).hidden === false, 'повторный показ');
  check('мастер возвращает фишку игрокам', () => {
    assert.strictEqual(room.tokens.find((item) => item.id === token.id).hidden, false);
    // Показ приходит игрокам как новая фишка: скрытой они её не видели.
    assert.ok(p1.log.tokenCreated.some((item) => item.id === token.id),
      'игрокам не пришла показанная фишка');
  });

  emit(dm, 'setAllTokensHidden', { hidden: true });
  await waitFor(() => room.tokens.every((item) => item.hidden), 'скрытие всех фишек');
  check('мастер скрывает все фишки разом', () => {
    const snapshot = room.snapshotFor({ playerId: 'p-test-0001', role: 'player' });
    assert.strictEqual(snapshot.tokens.length, 0, `у игрока осталось фишек: ${snapshot.tokens.length}`);
  });

  p1.log.tokenCreated.length = 0;
  emit(dm, 'setAllTokensHidden', { hidden: false });
  await waitFor(() => room.tokens.every((item) => !item.hidden), 'показ всех фишек');
  check('мастер показывает все фишки разом', () => {
    const snapshot = room.snapshotFor({ playerId: 'p-test-0001', role: 'player' });
    assert.strictEqual(snapshot.tokens.length, room.tokens.length);
    assert.ok(p1.log.tokenCreated.length > 0, 'показ не дошёл до игрока');
  });

  // Возвращаем вид, имя и позицию: дальше идут проверки, считающие фишки и
  // перезапускающие стол, а им нужен тот же стол, что и до проверок скрытия.
  emit(dm, 'renameToken', { tokenId: token.id, name: 'Гоблин-вождь' });
  emit(dm, 'moveToken', { tokenId: token.id, x: 0.4, y: 0.4 });
  await waitFor(
    () => {
      const restored = room.tokens.find((item) => item.id === token.id);
      return restored.name === 'Гоблин-вождь' && restored.x === 0.4 && restored.y === 0.4;
    },
    'возврат фишки в прежнее состояние'
  );


  // Группировка по названию и массовая картинка. Проверяем на каналах: важно,
  // что сервер положит картинку всем фишкам группы, а не только первой.
  // Вторая фишка создаётся с другим регистром и лишними пробелами: при
  // импорте из Foundry такое сплошь и рядом, и группа из-за этого не должна
  // распасться на две.
  emit(dm, 'createToken', { name: 'Кобольд', mapType: 'world' });
  emit(dm, 'createToken', { name: '  кобольд  ', mapType: 'world' });
  await waitFor(
    () => room.tokens.filter((item) => item.name.trim().toLowerCase() === 'кобольд').length === 2,
    'две фишки в группе'
  );

  dm.log.tokensUpdated.length = 0;
  emit(dm, 'setTokenGroupImage', { name: 'Кобольд', image: PNG_1PX });
  const batch = await waitFor(() => dm.log.tokensUpdated[0], 'пачка обновлённых фишек');
  check('массовая картинка приходит одним событием, а не по событию на фишку', () => {
    assert.strictEqual(dm.log.tokensUpdated.length, 1, `событий: ${dm.log.tokensUpdated.length}`);
    assert.strictEqual(batch.tokens.length, 2, `в пачке должно быть обе фишки, а не ${batch.tokens.length}`);
  });

  const groupImages = await waitFor(
    () => {
      const kobolds = room.tokens.filter((item) => item.name.trim().toLowerCase() === 'кобольд');
      return kobolds.length === 2 && kobolds.every((item) => item.imageUrl) ? kobolds : null;
    },
    'картинка на всей группе'
  );
  check('картинка встаёт сразу на всю группу фишек', () => {
    assert.strictEqual(groupImages.length, 2);
    for (const item of groupImages) assert.match(item.imageUrl, /^\/files\/.+\.png$/);
    // Обе фишки получают один и тот же файл: это один объект, а не две копии.
    assert.strictEqual(groupImages[0].imageUrl, groupImages[1].imageUrl);
  });

  dm.log.errorMessage.length = 0;
  emit(dm, 'setTokenGroupImage', { name: 'Кого-то нет', image: PNG_1PX });
  await waitFor(() => dm.log.errorMessage.length > 0, 'ответ про отсутствующую группу');
  check('группа без фишек отвергается с понятным объяснением', () => {
    assert.ok(dm.log.errorMessage.some((item) => /Фишек с таким названием нет/.test(item.message)));
  });

  // Убираем за собой: дальше по файлу идут проверки, которые считают, что в
  // кампании ровно одна фишка, а мы добавили ещё двух «Кобольдов».
  const koboldIds = room.tokens
    .filter((item) => item.name.trim().toLowerCase() === 'кобольд')
    .map((item) => item.id);
  for (const id of koboldIds) {
    emit(dm, 'deleteToken', { tokenId: id });
  }
  await waitFor(() => !room.tokens.some((item) => item.name.trim().toLowerCase() === 'кобольд'), 'уборка фишек группы');

  dm.log.errorMessage.length = 0;
  emit(dm, 'moveToken', { tokenId: 'no-such-token', x: 0.5, y: 0.5 });
  await waitFor(() => dm.log.errorMessage.find((item) => item.message.includes('Фишка не найдена')), 'несуществующая фишка');

  /* -------------------------------------------------------- прочность */

  console.log('\nПрочность');
  dm.log.tokenCreated.length = 0;
  emit(dm, 'createToken', { name: 'Гоблин', mapType: 'world', maxHp: 7 });
  const hpToken = await waitFor(
    () => dm.log.tokenCreated.filter((item) => item.name === 'Гоблин' && item.maxHp).pop(),
    'фишка с прочностью'
  );
  check('фишка создаётся сразу с полной прочностью', () => {
    assert.strictEqual(hpToken.maxHp, 7);
    assert.strictEqual(hpToken.hp, 7, 'новая фишка должна быть целой');
  });

  // Пока фишка скрыта, о ней знает только мастер: показываем её игрокам,
  // иначе проверка «игрок увидел прочность» проверяла бы не то. Показ скрытой
  // фишки игрокам приходит как tokenCreated: для них она просто новая.
  p2.log.tokenCreated.length = 0;
  emit(dm, 'setTokenHidden', { tokenId: hpToken.id, hidden: false });
  await waitFor(
    () => p2.log.tokenCreated.find((item) => item.id === hpToken.id),
    'фишка показана игрокам'
  );

  dm.log.tokenUpdated.length = 0;
  p2.log.tokenUpdated.length = 0;
  emit(dm, 'setTokenHp', { tokenId: hpToken.id, hp: 4 });
  await waitFor(() => dm.log.tokenUpdated.find((item) => item.id === hpToken.id), 'урон нанесён');
  check('урон уменьшает прочность, и событие о фишке доходит до всех', () => {
    const updated = dm.log.tokenUpdated.find((item) => item.id === hpToken.id);
    assert.strictEqual(updated.hp, 4);
    // Прочность самого монстра игроку не отдаётся, но событие о фишке он
    // получает: иначе карта у него застыла бы на месте.
    const seenByPlayer = p2.log.tokenUpdated.find((item) => item.id === hpToken.id);
    assert(seenByPlayer, 'игрок не получил событие о фишке вовсе');
    assert.strictEqual(seenByPlayer.maxHp, null, `игрок увидел максимум: ${seenByPlayer.maxHp}`);
  });

  emit(dm, 'setTokenHp', { tokenId: hpToken.id, hp: -5 });
  emit(dm, 'setTokenHp', { tokenId: hpToken.id, hp: 999 });
  await wait(150);
  const afterClamp = room.tokens.find((item) => item.id === hpToken.id);
  check('прочность не уходит ниже нуля и выше максимума', () => {
    assert.strictEqual(afterClamp.hp, 7, `прочность: ${afterClamp.hp}`);
  });

  emit(dm, 'setTokenHp', { tokenId: hpToken.id, hp: 0 });
  await waitFor(
    () => room.tokens.find((item) => item.id === hpToken.id).hp === 0,
    'фишка пала в ноль'
  );
  check('нулевая прочность означает павшего, а не ошибку', () => {
    assert.strictEqual(room.tokens.find((item) => item.id === hpToken.id).hp, 0);
  });

  dm.log.errorMessage.length = 0;
  emit(dm, 'createToken', { name: 'Монета', mapType: 'world' });
  const plainToken = await waitFor(
    () => dm.log.tokenCreated.filter((item) => item.name === 'Монета').pop(),
    'фишка без прочности'
  );
  check('фишка без прочности создаётся без неё', () => {
    assert.strictEqual(plainToken.maxHp, null);
    assert.strictEqual(plainToken.hp, null);
  });

  dm.log.errorMessage.length = 0;
  emit(dm, 'setTokenHp', { tokenId: plainToken.id, hp: 3 });
  await waitFor(() => dm.log.errorMessage.length > 0, 'урон по фишке без прочности');
  check('урон по фишке без прочности отвергается с объяснением', () => {
    assert.ok(dm.log.errorMessage.some((item) => /нет прочности/.test(item.message)), dm.log.errorMessage[0].message);
    assert.strictEqual(room.tokens.find((item) => item.id === plainToken.id).hp, null);
  });

  dm.log.errorMessage.length = 0;
  p1.log.errorMessage.length = 0;
  emit(p1, 'setTokenHp', { tokenId: hpToken.id, hp: 7 });
  await waitFor(() => p1.log.errorMessage.length > 0, 'игрок пробовал править прочность');
  check('прочность фишки меняет только мастер', () => {
    assert.ok(p1.log.errorMessage.some((item) => /только ДМ/.test(item.message)));
    assert.strictEqual(room.tokens.find((item) => item.id === hpToken.id).hp, 0, 'игрок всё-таки снял урон');
  });

  /* ---------------------------------------- прочность монстра не для игроков */

  // Гоблин выше не назначен ни одному игроку, то есть это монстр. Прочность
  // такого ведёт мастер у себя: игроку хватает знать, что монстр на поле есть.
  dm.log.tokenUpdated.length = 0;
  p2.log.tokenUpdated.length = 0;
  emit(dm, 'setTokenHp', { tokenId: hpToken.id, hp: 5 });
  await waitFor(() => dm.log.tokenUpdated.find((item) => item.id === hpToken.id), 'мастер снял урон монстру');
  check('игрок не получает прочность монстра ни при уроне, ни в живых событиях', () => {
    const seenByDm = dm.log.tokenUpdated.find((item) => item.id === hpToken.id);
    assert.strictEqual(seenByDm.hp, 5, 'мастер не видит прочность своего монстра');
    const seenByPlayer = p2.log.tokenUpdated.find((item) => item.id === hpToken.id);
    assert(seenByPlayer, 'игрок не получил событие о фишке вовсе');
    assert.strictEqual(seenByPlayer.maxHp, null, `игрок увидел максимум прочности: ${seenByPlayer.maxHp}`);
    assert.strictEqual(seenByPlayer.hp, null, `игрок увидел прочность: ${seenByPlayer.hp}`);
    // Название и положение фишки игроку по-прежнему нужны.
    assert.strictEqual(seenByPlayer.name, 'Гоблин');
  });

  const monsterView = room.snapshotFor({ playerId: 'p-test-0001', role: ROLE_PLAYER });
  const monsterForDm = room.snapshotFor({ playerId: 'p-test-0001', role: ROLE_DM });
  check('в снимке состояния игроку прочности монстра нет', () => {
    const seen = monsterView.tokens.find((item) => item.id === hpToken.id);
    assert(seen, 'монстра нет в снимке игрока вовсе');
    assert.strictEqual(seen.maxHp, null);
    assert.strictEqual(seen.hp, null);
    const dmSees = monsterForDm.tokens.find((item) => item.id === hpToken.id);
    assert.strictEqual(dmSees.hp, 5, 'у мастера в снимке тоже нет прочности');
  });

  // Фишка игрока — исключение: её прочность видят все. Назначение делается
  // отдельным действием: при создании фишка всегда ничья.
  dm.log.tokenUpdated.length = 0;
  p2.log.tokenUpdated.length = 0;
  emit(dm, 'createToken', { name: 'Кобра', mapType: 'world', maxHp: 11 });
  const heroToken = await waitFor(
    () => dm.log.tokenCreated.find((item) => item.name === 'Кобра'),
    'фишка игрока с прочностью'
  );
  emit(dm, 'assignTokenToPlayer', { tokenId: heroToken.id, playerId: 'p-test-0001' });
  // Новая фишка скрыта от игроков, пока её не покажут: без этого шага игрок о
  // ней и не узнает, а проверить тут нужно именно её прочность.
  p2.log.tokenCreated.length = 0;
  emit(dm, 'setTokenHidden', { tokenId: heroToken.id, hidden: false });
  await waitFor(() => p2.log.tokenCreated.find((item) => item.id === heroToken.id), 'игрок увидел свою фишку');
  dm.log.tokenUpdated.length = 0;
  p2.log.tokenUpdated.length = 0;
  emit(dm, 'setTokenHp', { tokenId: heroToken.id, hp: 4 });
  await waitFor(() => p2.log.tokenUpdated.find((item) => item.id === heroToken.id), 'игрок увидел урон своей фишке');
  check('прочность фишки игрока видна всем, в том числе его сопернику за столом', () => {
    assert.strictEqual(p2.log.tokenUpdated.find((item) => item.id === heroToken.id).hp, 4);
  });

  emit(dm, 'deleteToken', { tokenId: heroToken.id });
  await waitFor(() => !room.tokens.some((item) => item.id === heroToken.id), 'уборка фишки игрока');

  // Прочность переживает перезапуск кампании. RoomState ждёт состояние в
  // поле state — так устроена загрузка кампании из файла.
  const hpBefore = room.tokens.find((item) => item.id === hpToken.id).hp;
  const reloaded = new RoomState({ state: room.serialize() });
  check('прочность сохраняется с кампанией', () => {
    const saved = reloaded.tokens.find((item) => item.id === hpToken.id);
    assert(saved, 'фишка не пережила сохранение');
    assert.strictEqual(saved.maxHp, 7);
    assert.strictEqual(saved.hp, hpBefore, `после загрузки ${saved.hp}, было ${hpBefore}`);
  });

  for (const id of [hpToken.id, plainToken.id]) {
    emit(dm, 'deleteToken', { tokenId: id });
  }
  await waitFor(() => !room.tokens.some((item) => item.id === hpToken.id || item.id === plainToken.id), 'уборка фишек прочности');

  /* ------------------------------------------------------------- аватары */

  console.log('\nАватары');
  const P1 = 'p-test-0001';
  const P2 = 'p-test-0002';
  const listHas = (playerId) => room.playerList().find((player) => player.playerId === playerId);

  check('у мастера сразу есть портрет из поставки', () => {
    assert.strictEqual(listHas('dm').avatar, 'avatar-dm.png');
  });
  check('у игрока портрета нет, пока он его не поставил', () => {
    assert.strictEqual(listHas('p-test-0001').avatar, null);
  });

  emit(p1, 'setAvatar', { image: PNG_1PX });
  await waitFor(() => listHas('p-test-0001').avatar, 'аватар игрока');
  check('аватар игрока сохраняется как файл кампании', () => {
    assert.match(listHas('p-test-0001').avatar, /^\/files\/.+\.png$/);
  });
  check('аватар виден в рассылке участников, а не только владельцу листа', () => {
    const list = dm.log.playersUpdate[dm.log.playersUpdate.length - 1];
    const player = list.find((entry) => entry.playerId === 'p-test-0001');
    assert.ok(player && player.avatar, 'в рассылке участников аватара нет');
  });

  // Чужой playerId в теле сообщения игнорируется: сервер всегда берёт
  // playerId из сокета. Вместо попытки подменить чужой портрет игрок получает
  // свой собственный — и это тоже надо проверить.
  emit(p2, 'setAvatar', { image: PNG_1PX, playerId: 'p-test-0001' });
  const stolenFrom = listHas('p-test-0001').avatar;
  await waitFor(() => listHas(P2).avatar, 'аватар отправителя');
  check('подмена чужого playerId в аватаре не проходит', () => {
    assert.strictEqual(listHas('p-test-0001').avatar, stolenFrom, 'аватар другого игрока изменился');
    assert.match(listHas(P2).avatar, /^\/files\/.+\.png$/);
  });
  // Возвращаем второго игрока без портрета: дальше его фишка выводится из листа.
  emit(p2, 'setAvatar', { image: null });
  await waitFor(() => listHas(P2).avatar === null, 'аватар второго игрока убран');

  p1.log.errorMessage.length = 0;
  emit(p1, 'setAvatar', { image: 'data:image/png;base64,не-картинка' });
  await waitFor(
    () => p1.log.errorMessage.find((item) => /изображен|Поддерживаются|Формат/.test(item.message)),
    'отказ по битому аватару'
  );
  check('битый аватар отвергается, прошлый остаётся', () => {
    assert.strictEqual(listHas('p-test-0001').avatar, stolenFrom);
  });

  emit(dm, 'setAvatar', { image: PNG_1PX });
  await waitFor(
    () => listHas('dm').avatar && listHas('dm').avatar !== 'avatar-dm.png',
    'аватар мастера'
  );
  check('мастер может заменить свой портрет', () => {
    assert.match(listHas('dm').avatar, /^\/files\/.+\.png$/);
  });

  /* --- фишка из листа --- */
  // Фишку выводим игроку, у которого её ещё нет: у первого игрока она осталась
  // от проверок назначения выше, и «уже есть фишка» сработало бы не на том.
  const tokensBefore = new Set(room.tokens.map((token) => token.id));
  emit(p2, 'setAvatar', { image: PNG_1PX });
  await waitFor(() => listHas(P2).avatar, 'аватар второго игрока');
  emit(dm, 'createTokenFromSheet', { playerId: P2, mapType: 'world' });
  const spawned = await waitFor(
    () => room.tokens.find((token) => token.assignedPlayerId === P2 && !tokensBefore.has(token.id)),
    'фишка из листа игрока'
  );
  const characterName = (room.sheets.get(P2) || {}).characterName || 'Игрок';
  check('фишка выходит из листа с именем персонажа и аватаром игрока', () => {
    assert.strictEqual(spawned.name, characterName);
    assert.strictEqual(spawned.imageUrl, listHas(P2).avatar);
    assert.strictEqual(spawned.avatarFromSheet, true);
  });

  const avatarBeforeSync = spawned.imageUrl;
  emit(p2, 'setAvatar', { image: PNG_1PX });
  await waitFor(
    () => room.tokens.find((token) => token.id === spawned.id).imageUrl !== avatarBeforeSync,
    'аватар доехал до фишки'
  );
  check('смена аватара игрока сама обновляет его фишку', () => {
    const token = room.tokens.find((item) => item.id === spawned.id);
    assert.strictEqual(token.imageUrl, listHas(P2).avatar);
    assert.notStrictEqual(token.imageUrl, avatarBeforeSync);
  });

  emit(dm, 'setTokenImage', { tokenId: spawned.id, image: PNG_1PX });
  await waitFor(
    () => room.tokens.find((item) => item.id === spawned.id).avatarFromSheet === false,
    'фишка перестала быть аватаром игрока'
  );
  const manualUrl = room.tokens.find((item) => item.id === spawned.id).imageUrl;
  emit(p2, 'setAvatar', { image: PNG_1PX });
  await new Promise((resolve) => setTimeout(resolve, 300));
  check('картинка, поставленная руками, аватаром больше не затирается', () => {
    assert.strictEqual(room.tokens.find((item) => item.id === spawned.id).imageUrl, manualUrl);
  });

  dm.log.errorMessage.length = 0;
  emit(dm, 'createTokenFromSheet', { playerId: P2, mapType: 'world' });
  await waitFor(() => dm.log.errorMessage.find((item) => /уже есть фишка/i.test(item.message)), 'вторая фишка игроку');
  check('вторую фишку одному игроку вывести не дают', () => {
    assert.strictEqual(room.tokens.filter((token) => token.assignedPlayerId === P2).length, 1);
  });

  dm.log.errorMessage.length = 0;
  emit(dm, 'createTokenFromSheet', { playerId: 'dm', mapType: 'world' });
  await waitFor(() => dm.log.errorMessage.find((item) => /нет фишки/i.test(item.message)), 'попытка вывести фишку мастеру');
  check('фишку из листа мастеру не выводют', () => {
    assert.ok(!room.tokens.some((token) => token.assignedPlayerId === 'dm'));
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'createTokenFromSheet', { playerId: 'p-test-0001' });
  await waitFor(() => p1.log.errorMessage.find((item) => /только ДМ/i.test(item.message)), 'попытка игрока');
  check('игрок не может вывести фишку даже себе', () => {
    assert.strictEqual(room.tokens.filter((token) => token.assignedPlayerId === P2).length, 1);
  });

  /* --- аватар в сообщении о броске --- */
  const chatBefore = dm.log.chatMessage.length;
  emit(p1, 'rollDice', { sides: 20 });
  const rollMsg = await waitFor(() => dm.log.chatMessage[chatBefore], 'сообщение о броске');
  check('в сообщении о броске лежит аватар бросившего', () => {
    assert.strictEqual(rollMsg.isRoll, true);
    assert.strictEqual(rollMsg.avatar, listHas('p-test-0001').avatar);
  });

  // Возврат игроков к состоянию без портрета: дальше идут проверки перезапуска
  // и переподключения, которым лишние файлы в папке только мешают.
  emit(p1, 'setAvatar', { image: null });
  emit(p2, 'setAvatar', { image: null });
  await waitFor(() => listHas('p-test-0001').avatar === null && listHas(P2).avatar === null, 'аватары убраны');
  // И убираем только те фишки, что завели сами: фишка первого игрока осталась
  // от проверок назначения выше, и её удаление сломало бы счётчики дальше.
  emit(dm, 'deleteToken', { tokenId: spawned.id });
  await waitFor(() => !room.tokens.some((token) => token.id === spawned.id), 'уборка фишки из листа');

  /* ------------------------------------------------------------- кубики */

  console.log('\nКубики');
  const results = [];
  const collect = (roll) => results.push(roll);
  p2.on('diceRollResult', collect);
  for (let i = 0; i < 120; i += 1) emit(p1, 'rollDice', { formula: 'd20' });
  await waitFor(() => results.length === 120, '120 бросков d20');
  check('d20 всегда даёт 1..20 и результат варьируется', () => {
    assert.ok(results.every((roll) => roll.result >= 1 && roll.result <= 20));
    assert.ok(new Set(results.map((roll) => roll.result)).size > 5, 'результаты не варьируются');
  });
  check('бросок обрабатывает сервер, в событии есть имя, формула и время', () => {
    assert.strictEqual(results[0].playerName, 'Артём');
    assert.strictEqual(results[0].formula, 'd20');
    assert.ok(!Number.isNaN(Date.parse(results[0].time)));
  });
  results.length = 0;
  emit(p1, 'rollDice', { formula: '2d6+3' });
  await waitFor(() => results.length === 1, 'бросок 2d6+3');
  check('формула 2d6+3 считается как сумма двух костей и модуль', () => {
    const roll = results[0];
    assert.strictEqual(roll.count, 2);
    assert.strictEqual(roll.sides, 6);
    assert.strictEqual(roll.values.length, 2);
    assert.ok(roll.values.every((value) => value >= 1 && value <= 6), `значения: ${roll.values}`);
    const sum = roll.values.reduce((acc, value) => acc + value, 0);
    assert.strictEqual(roll.result, sum + 3, 'итог не равен сумме костей и модулю');
  });
  results.length = 0;
  emit(p1, 'rollDice', { formula: '4d6dl1' });
  await waitFor(() => results.length === 1, 'бросок 4d6dl1');
  check('«отбрось худшую» оставляет три крупнейших кости', () => {
    const roll = results[0];
    assert.strictEqual(roll.values.length, 4);
    assert.strictEqual(roll.droppedValues.length, 1);
    const top3 = roll.values.slice().sort((a, b) => b - a).slice(0, 3);
    assert.strictEqual(roll.result, top3.reduce((acc, value) => acc + value, 0));
    assert.ok(roll.values.includes(roll.droppedValues[0]), 'отброшена не одна из брошенных');
  });
  results.length = 0;
  emit(p1, 'rollDice', { formula: '2d20kh1' });
  await waitFor(() => results.length === 1, 'бросок 2d20kh1');
  check('преимущество 2d20kh1 даёт лучшую кость', () => {
    const roll = results[0];
    assert.strictEqual(roll.result, Math.max(...roll.values));
  });
  results.length = 0;
  emit(p1, 'rollDice', { formula: '2d20kl1' });
  await waitFor(() => results.length === 1, 'бросок 2d20kl1');
  check('помеха 2d20kl1 даёт худшую кость', () => {
    const roll = results[0];
    assert.strictEqual(roll.result, Math.min(...roll.values));
  });
  results.length = 0;
  emit(p1, 'rollDice', { formula: ' 2 D6 + 3 ' });
  await waitFor(() => results.length === 1, 'бросок с лишними пробелами');
  check('лишние пробелы и регистр в формуле не мешают', () => {
    assert.strictEqual(results[0].formula, '2d6+3');
  });
  results.length = 0;
  emit(p1, 'rollDice', { formula: 'd100' });
  await waitFor(() => results.length === 1, 'бросок d100');
  check('сотня бросается для процентных проверок', () => {
    assert.strictEqual(results[0].sides, 100);
    assert.ok(results[0].result >= 1 && results[0].result <= 100);
  });
  p2.off('diceRollResult', collect);

  p1.log.errorMessage.length = 0;
  emit(p1, 'rollDice', { formula: '3d7' });
  emit(p1, 'rollDice', { formula: 'привет' });
  emit(p1, 'rollDice', { formula: '' });
  emit(dm, 'rollDice', { formula: 'd20' });
  await waitFor(() => p1.log.errorMessage.length >= 3, 'отказ по негодной формуле');
  check('негодная формула не бросается, а игрок получает объяснение', () => {
    assert.strictEqual(p1.log.errorMessage.length, 3);
    assert.match(p1.log.errorMessage[0].message, /d7.*не бывает/s, p1.log.errorMessage[0].message);
    assert.match(p1.log.errorMessage[1].message, /Не понял формулу/, p1.log.errorMessage[1].message);
  });
  check('кость вне списка настоящих не принимается даже в формуле', () => {
    assert.ok(p1.log.errorMessage.every((item) => !item.message.includes('бросил')));
  });
  check(
    'список костей у клиента, сервера и разбора формул один и тот же',
    () => {
      // Списки продублированы: renderer не может потребовать серверный файл.
      // Если их разведут, панель предложит кость, которую сервер не примет.
      const expected = [4, 6, 8, 10, 12, 20, 100];
      const client = readDiceSides(path.join(__dirname, '..', 'renderer', 'dnd5e.js'));
      const server = readDiceSides(path.join(__dirname, '..', 'server', 'state.js'));
      assert.deepStrictEqual(client, expected, `в клиенте: ${client}`);
      assert.deepStrictEqual(client, server, `клиент ${client}, сервер ${server}`);
      assert.deepStrictEqual(diceModule.DICE_SIDES, expected, 'в разборе формул другой список');
    }
  );
  check('ДМ тоже может бросать кубики', () => {
    assert.ok(p2.log.diceRollResult.some((roll) => roll.playerName === 'Мастер'));
  });

  /* ------------------------------------------------- тайный бросок мастера */
  console.log('\nТайный бросок');
  const dmRolls = [];
  const dmCollect = (roll) => dmRolls.push(roll);
  dm.on('diceRollResult', dmCollect);
  results.length = 0;
  // Подписка игрока была снята выше: без неё тайный бросок некуда принять.
  p2.on('diceRollResult', collect);
  emit(dm, 'rollDice', { formula: 'd20', hidden: true });
  await waitFor(() => results.length === 1 && dmRolls.length === 1, 'тайный бросок мастера');
  check('мастер видит число своего тайного броска', () => {
    assert.strictEqual(dmRolls[0].hidden, true);
    assert.ok(dmRolls[0].result >= 1 && dmRolls[0].result <= 20);
  });
  check('игрок числа тайного броска не видит', () => {
    assert.strictEqual(results[0].hidden, true);
    assert.strictEqual(results[0].result, null);
    assert.strictEqual(results[0].values, undefined, 'игроку ушли сами броски');
  });
  const secretText = p1.log.chatMessage.filter((message) => message.isRoll && message.hidden).pop();
  check('в чате тайный бросок объявляется без числа', () => {
    assert.ok(secretText, 'нет объявления тайного броска');
    assert.strictEqual(secretText.from, 'Мастер');
    assert.match(secretText.text, /тайно$/, `текст: ` + secretText.text);
    assert.ok(!/\d/.test(secretText.text.replace(/d\d+/g, '')), `в тексте есть число: ${secretText.text}`);
  });
  check('в истории бросков сервера число тайного броска остаётся', () => {
    const stored = room.diceHistory.filter((roll) => roll.hidden).pop();
    assert.ok(stored && stored.result >= 1, 'число потерялось у мастера');
  });
  dm.off('diceRollResult', dmCollect);

  results.length = 0;
  emit(p1, 'rollDice', { formula: 'd20', hidden: true });
  await waitFor(() => results.length === 1, 'попытка игрока бросить тайно');
  check('игрок не может бросить тайно: его бросок виден всем', () => {
    assert.strictEqual(results[0].hidden, false);
    assert.ok(results[0].result >= 1 && results[0].result <= 20);
  });

  // Снимок состояния игроку не должен содержать чисел тайных бросков: иначе
  // игрок увидит их, переподключившись или обновив стол.
  const playerSnapshot = room.snapshotFor({ playerId: 'p-test-0001', role: 'player' });
  const dmSnapshot = room.snapshotFor({ playerId: 'p-test-0001', role: ROLE_DM });
  check('в снимке состояния игроку чисел тайных бросков нет', () => {
    const leaked = playerSnapshot.diceHistory.filter((roll) => roll.hidden && roll.result !== null);
    assert.deepStrictEqual(leaked.map((roll) => roll.formula), [], 'число тайного броска утекло');
  });
  check('мастер в своём снимке числа тайных бросков видит', () => {
    const hidden = dmSnapshot.diceHistory.filter((roll) => roll.hidden);
    assert.ok(hidden.length >= 1 && hidden.every((roll) => roll.result >= 1));
  });

  check('бросок объявляется в общем чате (виден и тем, кто подключится позже)', () => {
    const announcement = p1.log.chatMessage
      .filter((message) => message.isRoll && message.text.startsWith('бросил 2d6+3')).pop();
    assert.ok(announcement, 'нет объявления броска 2d6+3 в чате');
    assert.strictEqual(announcement.from, 'Артём');
    assert.match(announcement.text, /^бросил 2d6\+3: \d+$/, `текст: ${announcement.text}`);
    assert.ok(room.chatHistory.some((message) => message.isRoll), 'броска нет в истории чата на сервере');
  });
  check('отброшенные кости видны в тексте броска', () => {
    const withDrop = p1.log.chatMessage
      .filter((message) => message.isRoll && message.text.includes('отброшено')).pop();
    assert.ok(withDrop, 'бросок с отброшенными костями не объяснён в чате');
    assert.match(withDrop.text, /^бросил 4d6dl1: \d+ \(отброшено \d\)$/, `текст: ${withDrop.text}`);
  });

  /* ---------------------------------------------------- спасброски смерти */

  console.log('\nСпасброски смерти');
  // Лист игрока доводим до нуля хитов: спасброски идут только оттуда, и
  // сервер обязан отказать, если персонаж жив.
  const deathSheet = { ...(room.sheets.get(P1) || {}), hp: 0, maxHp: 20 };
  emit(p1, 'saveCharacterSheet', { sheet: deathSheet });
  await waitFor(() => room.sheets.get(P1).hp === 0, 'лист игрока на нуле хитов');

  dm.log.errorMessage.length = 0;
  emit(dm, 'rollDeathSave', {});
  await waitFor(() => dm.log.errorMessage.length > 0, 'мастер бросает спасбросок за игрока');
  check('спасбросок смерти бросает только игрок', () => {
    // Отказ приходит тому, кто нажал: это мастер.
    assert.ok(dm.log.errorMessage.some((item) => /бросает сам игрок/.test(item.message)),
      dm.log.errorMessage[0].message);
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'saveCharacterSheet', { sheet: { ...room.sheets.get(P1), hp: 7 } });
  await waitFor(() => room.sheets.get(P1).hp === 7, 'герой снова жив');
  emit(p1, 'rollDeathSave', {});
  await waitFor(() => p1.log.errorMessage.length > 0, 'спасбросок у живого героя');
  check('живому персонажу спасбросок не бросают', () => {
    assert.ok(p1.log.errorMessage.some((item) => /нулевом здоровье/.test(item.message)));
    assert.strictEqual(room.sheets.get(P1).deathSavesSuccesses, 0);
    assert.strictEqual(room.sheets.get(P1).deathSavesFailures, 0);
  });

  // Дальше проверяем саму механику. Бросает сервер, поэтому исход
  // выпадает случайно, а двадцатка по правилам поднимает героя и обнуляет
  // счётчики: ждать, пока счётчик дойдёт до трёх, нельзя, бой может
  // закончиться иначе. Крутим до любого исхода и проверяем, что при любом
  // ходе бросков счётчик остался в границах.
  emit(p1, 'saveCharacterSheet', { sheet: { ...room.sheets.get(P1), hp: 0 } });
  await waitFor(() => room.sheets.get(P1).hp === 0, 'герой снова при смерти');

  const rollCountBefore = dm.log.diceRollResult.length;
  let rolls = 0;
  for (let i = 0; i < 40; i += 1) {
    const sheet = room.sheets.get(P1);
    const finished = sheet.hp > 0
      || sheet.deathSavesSuccesses >= 3
      || sheet.deathSavesFailures >= 3;
    if (finished) break;
    emit(p1, 'rollDeathSave', {});
    await wait(40);
    rolls += 1;
  }
  const deathNow = room.sheets.get(P1);
  const deathRolls = dm.log.diceRollResult.slice(rollCountBefore).filter((roll) => roll.isDeathSave);
  check('спасбросок объявляется броском и виден мастеру', () => {
    assert(deathRolls.length > 0, 'ни одного спасброска не произошло');
    assert.strictEqual(deathRolls.length, rolls, `бросков на сервере ${deathRolls.length}, отправлено ${rolls}`);
    for (const roll of deathRolls) {
      assert.strictEqual(roll.formula, 'd20');
      assert(roll.result >= 1 && roll.result <= 20, `выпало ${roll.result}`);
    }
  });
  check('счётчик спасбросков всегда остаётся в границах', () => {
    assert(deathNow.deathSavesSuccesses >= 0 && deathNow.deathSavesSuccesses <= 3,
      `успехов: ${deathNow.deathSavesSuccesses}`);
    assert(deathNow.deathSavesFailures >= 0 && deathNow.deathSavesFailures <= 3,
      `неудач: ${deathNow.deathSavesFailures}`);
  });
  check('любой исход броска приводит к одному из состояний', () => {
    const revived = deathNow.hp > 0;
    const closed = deathNow.deathSavesSuccesses >= 3 || deathNow.deathSavesFailures >= 3;
    assert(revived || closed || rolls >= 40,
      `состояние: hp ${deathNow.hp}, ${deathNow.deathSavesSuccesses}/${deathNow.deathSavesFailures}`);
    // Подняться с нуля двадцаткой можно только с одним хпом: правило 5e.
    if (revived) {
      assert(deathNow.hp === 1, `после двадцатки хитов ${deathNow.hp}, а должен быть 1`);
      assert.strictEqual(deathNow.deathSavesSuccesses, 0, 'счётчики не обнулились');
    }
  });
  check('спасбросок попадает в чат с названием броска', () => {
    const note = dm.log.chatMessage.filter((message) => /спасбросок смерти/.test(message.text)).pop();
    assert(note, 'броска смерти нет в чате');
    assert(/спасбросок смерти: d20 \d+/.test(note.text), `текст: ${note.text}`);
    assert(note.text.length > 'спасбросок смерти: d20 '.length, 'в тексте нет исхода броска');
  });

  // Исходы, которые на живой столе выпадают случайно, проверяются по правилам
  // отдельно: ждать двадцатку в цикле бессмысленно.
  check('двадцатка поднимает героя с одного хита и обнуляет счётчики', () => {
    const twenty = reviveOnTwenty({ hp: 0, deathSavesSuccesses: 2, deathSavesFailures: 1 }, 20);
    assert.strictEqual(twenty.hp, 1);
    assert.strictEqual(twenty.deathSavesSuccesses, 0);
    assert.strictEqual(twenty.deathSavesFailures, 0);
  });
  check('единица считается за две неудачи, но счётчик не уходит за три', () => {
    const one = reviveOnTwenty({ hp: 0, deathSavesSuccesses: 0, deathSavesFailures: 0 }, 1);
    assert.strictEqual(one.deathSavesFailures, 2, `после единицы: ${one.deathSavesFailures}`);
    const capped = reviveOnTwenty({ hp: 0, deathSavesSuccesses: 0, deathSavesFailures: 2 }, 1);
    assert.strictEqual(capped.deathSavesFailures, 3, 'счётчик ушёл за три');
  });
  check('десятка и выше считаются успехом, а девятка и ниже неудачей', () => {
    const blank = () => ({ hp: 0, deathSavesSuccesses: 0, deathSavesFailures: 0 });
    assert.strictEqual(reviveOnTwenty(blank(), 10).deathSavesSuccesses, 1);
    assert.strictEqual(reviveOnTwenty(blank(), 19).deathSavesSuccesses, 1);
    assert.strictEqual(reviveOnTwenty(blank(), 9).deathSavesFailures, 1);
    assert.strictEqual(reviveOnTwenty(blank(), 2).deathSavesFailures, 1);
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'resetDeathSaves', {});
  await wait(120);
  check('счётчики обнуляются вручную, когда герой пришёл в себя', () => {
    assert.strictEqual(p1.log.errorMessage.length, 0);
    assert.strictEqual(room.sheets.get(P1).deathSavesSuccesses, 0);
    assert.strictEqual(room.sheets.get(P1).deathSavesFailures, 0);
  });
  emit(p1, 'saveCharacterSheet', { sheet: { ...room.sheets.get(P1), hp: 7 } });
  await wait(80);

  /* ------------------------------------------------------ порядок боя */  /* ------------------------------------------------------ порядок боя */

  console.log('\nПорядок боя');
  p2.log.errorMessage.length = 0;
  emit(dm, 'initiativeAdd', { kind: 'player', refId: 'p-test-0001', name: 'Артём', modifier: 3 });
  emit(dm, 'initiativeAdd', { kind: 'player', refId: P2, name: 'Борис', modifier: 1 });
  emit(dm, 'initiativeAdd', { kind: 'other', name: 'Гоблин', modifier: 2 });
  await waitFor(() => room.initiative.entries.length === 3, 'участники боя');
  check('мастер добавляет участников боя', () => {
    assert.strictEqual(room.initiative.entries.length, 3);
    assert.strictEqual(room.initiative.entries[0].name, 'Артём');
    assert.strictEqual(room.initiative.entries[0].modifier, 3);
    assert.strictEqual(room.initiative.turnId, null, 'до броска ход не объявлен');
  });

  emit(dm, 'initiativeAdd', { kind: 'player', refId: 'p-test-0001', name: 'Артём', modifier: 3 });
  await wait(150);
  check('один участник не попадает в список дважды', () => {
    assert.strictEqual(room.initiative.entries.length, 3);
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'initiativeAdd', { kind: 'other', name: 'Самозванец', modifier: 0 });
  emit(p1, 'initiativeRoll', {});
  emit(p1, 'initiativeStep', { dir: 1 });
  await waitFor(() => p1.log.errorMessage.length >= 3, 'игрок не управляет боем');
  check('игрок не может вести порядок боя', () => {
    assert.strictEqual(p1.log.errorMessage.length, 3);
    assert.ok(p1.log.errorMessage.every((item) => item.message.includes('только ДМ')));
    assert.strictEqual(room.initiative.entries.length, 3, 'в списке появился посторонний');
  });

  const initEvents = [];
  const collectInitiative = (state) => initEvents.push(state);
  p2.on('initiativeUpdated', collectInitiative);
  // Отказы от предыдущей проверки уже накопились, а рассылка порядка боя не
  // должна вызывать у игрока ни одной новой ошибки.
  p1.log.errorMessage.length = 0;
  emit(dm, 'initiativeRoll', {});
  await waitFor(() => initEvents.length >= 1, 'бросок инициативы игроку');
  check('бросок инициативы объявляет порядок всем, кроме игроков', () => {
    const announced = initEvents[initEvents.length - 1];
    assert.strictEqual(announced.entries.length, 3);
    // Больше итог — раньше: проверяем, что порядок действительно по сумме.
    const totals = announced.entries.map((entry) => entry.total);
    assert.deepStrictEqual(totals, totals.slice().sort((a, b) => b - a), `порядок: ${totals}`);
    assert.ok(announced.entries.every((entry) => entry.total >= entry.modifier + 1), 'итог меньше броска');
    assert.ok(announced.entries.every((entry) => entry.total <= entry.modifier + 20), 'итог больше броска');
    assert.strictEqual(announced.turnId, announced.entries[0].id, 'первым ходит лидер');
    assert.strictEqual(announced.round, 1, 'бой начался с первого раунда');
    assert.strictEqual(p1.log.errorMessage.length, 0, 'игрок не должен ругаться на рассылку');
  });

  initEvents.length = 0;
  emit(dm, 'initiativeStep', { dir: 1 });
  await waitFor(() => initEvents.length >= 1, 'переход к следующему');
  check('ход переходит к следующему участнику', () => {
    const state = initEvents[initEvents.length - 1];
    assert.strictEqual(state.turnId, state.entries[1].id);
    assert.strictEqual(state.round, 1);
  });

  emit(dm, 'initiativeStep', { dir: 1 });
  emit(dm, 'initiativeStep', { dir: 1 });
  await waitFor(
    () => initEvents.length >= 3 && initEvents[initEvents.length - 1].round === 2,
    'переход с последнего на первый'
  );
  check('переход с последнего на первый считается новым раундом', () => {
    const state = initEvents[initEvents.length - 1];
    assert.strictEqual(state.turnId, state.entries[0].id);
    assert.strictEqual(state.round, 2, `раунд: ${state.round}`);
  });

  initEvents.length = 0;
  emit(dm, 'initiativeTurn', { id: room.initiative.entries[2].id });
  await waitFor(() => initEvents.length >= 1, 'объявление хода кликом по строке');
  check('ход можно объявить кликом по строке', () => {
    assert.strictEqual(initEvents[initEvents.length - 1].turnId, room.initiative.entries[2].id);
  });

  initEvents.length = 0;
  emit(dm, 'initiativeRemove', { id: room.initiative.entries[2].id });
  await waitFor(() => initEvents.length >= 1, 'убираем участника боя');
  check('после удаления текущего ход переходит к следующему', () => {
    const state = initEvents[initEvents.length - 1];
    assert.strictEqual(state.entries.length, 2);
    assert.ok(state.turnId && state.entries.some((entry) => entry.id === state.turnId),
      `ход остался на удалённом: ${state.turnId}`);
  });

  initEvents.length = 0;
  const doomedToken = { id: 't-init-test', name: 'Зомби', x: 0.5, y: 0.5, color: '#888', image: null, hidden: false, assignedPlayerId: null };
  room.tokens.push(doomedToken);
  emit(dm, 'initiativeAdd', { kind: 'token', refId: doomedToken.id, name: 'Зомби', modifier: 0 });
  await waitFor(() => room.initiative.entries.some((entry) => entry.refId === doomedToken.id), 'фишка в бою');
  emit(dm, 'deleteToken', { tokenId: doomedToken.id });
  await waitFor(
    () => initEvents.some((state) => !state.entries.some((entry) => entry.refId === doomedToken.id)),
    'удаление фишки убирает её из боя'
  );
  check('удалённая фишка исчезает и из порядка боя', () => {
    const latest = initEvents[initEvents.length - 1];
    assert.ok(!latest.entries.some((entry) => entry.refId === doomedToken.id), 'в бою осталась удалённая фишка');
  });

  initEvents.length = 0;
  emit(dm, 'initiativeReset', {});
  await waitFor(() => initEvents.length >= 1, 'очистка боя');
  check('очистка боя сбрасывает и список, и раунд', () => {
    const state = initEvents[initEvents.length - 1];
    assert.strictEqual(state.entries.length, 0);
    assert.strictEqual(state.turnId, null);
    assert.strictEqual(state.round, 1);
  });
  p2.off('initiativeUpdated', collectInitiative);

  // Порядок боя переживает переподключение: он живёт в состоянии стола, а не
  // в памяти окна мастера.
  emit(dm, 'initiativeAdd', { kind: 'other', name: 'Страж', modifier: 0 });
  emit(dm, 'initiativeRoll', {});
  await waitFor(() => room.initiative.entries.length === 1, 'бой снова собран');
  const dmView = room.snapshotFor({ playerId: 'p-test-0001', role: ROLE_DM });
  const playerView = room.snapshotFor({ playerId: 'p-test-0001', role: ROLE_PLAYER });
  check('порядок боя одинаков у мастера и игрока', () => {
    assert.strictEqual(dmView.initiative.entries.length, 1);
    assert.deepStrictEqual(
      playerView.initiative.entries.map((entry) => entry.id),
      dmView.initiative.entries.map((entry) => entry.id)
    );
    assert.strictEqual(playerView.initiative.round, dmView.initiative.round);
  });

  // Предел списка боя: сорок существ — это уже не бой, а толпа. Лишние должны
  // отклоняться, иначе мастер мог бы набить список хоть тысячей записей.
  for (let i = 0; i < LIMITS_MAX_INITIATIVE + 5; i += 1) {
    emit(dm, 'initiativeAdd', { kind: 'other', name: `Гоблин ${i + 1}`, modifier: 0 });
  }
  await waitFor(() => room.initiative.entries.length === LIMITS_MAX_INITIATIVE, 'предел списка боя');
  check('список боя ограничен сорока участниками', () => {
    assert.strictEqual(room.initiative.entries.length, LIMITS_MAX_INITIATIVE);
    assert.ok(dm.log.errorMessage.length > 0, 'мастер не предупреждён о лишних участниках');
  });

  emit(dm, 'initiativeReset', {});
  await waitFor(() => room.initiative.entries.length === 0, 'бой очищен перед следующими проверками');

  /* --------------------------------------------------------------- чат */

  console.log('\nЧат');
  p2.log.chatMessage.length = 0;
  emit(p1, 'chatMessage', { text: '   ' });
  await wait(150);
  check('пустое сообщение не рассылается', () => {
    assert.strictEqual(p2.log.chatMessage.length, 0);
  });

  emit(p1, 'chatMessage', { text: 'Привет, стол!' });
  const chat = await waitFor(() => p2.log.chatMessage[0], 'сообщение чата');
  check('сообщение чата видят все, с именем и временем', () => {
    assert.strictEqual(chat.from, 'Артём');
    assert.strictEqual(chat.text, 'Привет, стол!');
    assert.strictEqual(chat.role, 'player');
    assert.ok(!Number.isNaN(Date.parse(chat.time)));
  });

  p2.log.chatMessage.length = 0;
  emit(p1, 'chatMessage', { text: 'x'.repeat(5000) });
  const longChat = await waitFor(() => p2.log.chatMessage[0], 'длинное сообщение');
  check('слишком длинное сообщение обрезается до 1000 символов', () => {
    assert.strictEqual(longChat.text.length, 1000);
  });

  const { ack: longJoin } = await open({ name: 'Я'.repeat(120), playerId: 'p-long' });
  check('слишком длинное имя обрезается до 40 символов', () => {
    assert.strictEqual(longJoin.you.name.length, 40);
  });

  /* -------------------------------------------- сохранение и загрузка */

  console.log('\nСохранение и загрузка кампании');
  // Вторая карта в ту же вкладку: проверим, что список карт переживает
  // сохранение и загрузку кампании, а не только первая картинка.
  emit(dm, 'uploadMap', { type: 'battle', image: PNG_1PX, name: 'вторая локация.png' });
  await waitFor(() => room.maps.battle.items.length === 2, 'вторая карта перед сохранением');
  emit(dm, 'selectMap', { type: 'battle', mapId: room.maps.battle.items[0].id });
  await waitFor(() => room.currentMap('battle').name === 'battle.png', 'выбор первой карты вкладки');
  emit(dm, 'setActiveMap', { type: 'world' });
  await waitFor(() => room.activeMap === 'world', 'возврат показа к общей карте');
  campaign.state = room.serialize();
  await store.save(campaign);
  check('файл кампании записан на диск', () => {
    assert.ok(fs.existsSync(path.join(root, 'campaigns', campaign.id, 'campaign.json')));
  });

  const list = await store.list();
  check('кампания видна в списке сохранённых с метаданными', () => {
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'Тестовая кампания');
    assert.strictEqual(list[0].players, 5);
    assert.strictEqual(list[0].tokens, 1);
    assert.strictEqual(list[0].maps.world, true);
    assert.strictEqual(list[0].maps.battle, true);
    assert.strictEqual(list[0].maps.sketch, true);
    assert.ok(list[0].version >= 1);
    assert.ok(list[0].createdAt && list[0].updatedAt);
  });

  const restoredCampaign = await store.load(campaign.id);
  const restored = new RoomState(restoredCampaign);
  check('листы персонажей восстановлены', () => {
    assert.strictEqual(restored.sheets.get('p-test-0001').characterName, 'Тордин');
    assert.strictEqual(restored.sheets.get('p-test-0002').characterName, 'Мира');
  });
  check('фишки, позиции и назначения восстановлены', () => {
    const restoredToken = restored.tokens[0];
    assert.strictEqual(restoredToken.name, 'Гоблин-вождь');
    assert.strictEqual(restoredToken.x, 0.4);
    assert.strictEqual(restoredToken.y, 0.4);
    assert.strictEqual(restoredToken.assignedPlayerId, 'p-test-0001');
    assert.match(restoredToken.imageUrl, /^\/files\//);
  });
  check('карты и активная карта восстановлены', () => {
    assert.strictEqual(restored.maps.world.items.length, 1);
    assert.strictEqual(restored.maps.battle.items.length, 2, 'во вкладке локации было две карты');
    assert.strictEqual(restored.maps.sketch.items.length, 1);
    assert.strictEqual(restored.currentMap('battle').name, 'battle.png', 'показываться должна выбранная карта');
    assert.strictEqual(restored.activeMap, 'world');
  });
  check('сетка стола восстанавливается вместе с кампанией', () => {
    assert.strictEqual(restored.grid.enabled, true);
    assert.strictEqual(restored.grid.cell, 56);
  });
  check('история бросков и чата сохраняется', () => {
    assert.ok(restored.diceHistory.length > 0, 'нет истории бросков');
    assert.ok(restored.chatHistory.some((message) => message.isRoll), 'нет объявления броска в чате');
    assert.ok(restored.chatHistory.some((message) => message.text === 'Привет, стол!'), 'нет обычного сообщения');
  });
  check('все игроки после перезапуска помечены офлайн', () => {
    assert.ok(restored.players.size >= 4);
    assert.ok([...restored.players.values()].every((player) => player.online === false));
  });
  check('в файле кампании есть все обязательные поля', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'campaigns', campaign.id, 'campaign.json'), 'utf8'));
    for (const field of ['id', 'name', 'createdAt', 'updatedAt', 'version', 'state']) {
      assert.ok(raw[field] !== undefined, `нет поля ${field}`);
    }
    for (const field of ['players', 'sheets', 'maps', 'activeMap', 'tokens']) {
      assert.ok(raw.state[field] !== undefined, `нет state.${field}`);
    }
  });

  /* ------------------------------- переподключение и остановка сервера */

  console.log('\nПереподключение и остановка сервера');
  const { client: p1Again, ack: rejoin } = await open({ name: 'Артём', playerId: 'p-test-0001' });
  const rejoinState = p1Again.log.joined[0].state;
  check('переподключение с тем же playerId возвращает тот же лист', () => {
    assert.strictEqual(rejoin.you.playerId, 'p-test-0001');
    assert.strictEqual(rejoinState.sheets['p-test-0001'].characterName, 'Тордин');
    assert.strictEqual(Object.keys(rejoinState.sheets).length, 1, 'игроку не должен уходить чужой лист');
  });

  p2.disconnect();
  await waitFor(() => room.isOnline('p-test-0002') === false, 'игрок помечен офлайн');
  check('после отключения лист и данные игрока остаются на сервере', () => {
    assert.ok(room.sheets.has('p-test-0002'));
    const entry = room.playerList().find((player) => player.playerId === 'p-test-0002');
    assert.strictEqual(entry.online, false);
  });
  check('изменения помечают кампанию «грязной» для автосохранения', () => {
    assert.ok(dirtyCount > 10, `dirtyCount=${dirtyCount}`);
  });

  await server.close();
  check('сервер корректно останавливается', () => {
    assert.strictEqual(server.httpServer.listening, false);
  });

  const instance = await createTableServer({
    room: new RoomState(restoredCampaign),
    store,
    hostKey: HOST_KEY,
    preferredPort: server.port,
    onDirty: () => {},
    onLog: () => {}
  });
  check('после остановки порт можно занять снова', () => {
    assert.ok(instance.port > 0);
  });
  await instance.close();

  for (const client of clients) client.disconnect();
  fs.rmSync(root, { recursive: true, force: true });

  console.log(`\n${'='.repeat(62)}`);
  console.log(`Пройдено проверок: ${passed}, ошибок: ${failures.length}`);
  if (failures.length) {
    console.log('\nНе прошли:');
    for (const item of failures) console.log(`  - ${item}`);
  } else {
    console.log('Все проверки пройдены.');
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error('\nТест упал:', error);
  process.exit(1);
});

// Страховка: тест не должен висеть бесконечно.
setTimeout(() => {
  console.error('\nТест не завершился за 90 секунд — принудительная остановка.');
  process.exit(1);
}, 90 * 1000).unref();
