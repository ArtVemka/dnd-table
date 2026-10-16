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
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');

const { CampaignStore } = require('../server/campaign');
const { createTableServer } = require('../server/socket');
const { RoomState } = require('../server/state');

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
  'tokenCreated', 'tokenUpdated', 'tokenMoved', 'tokenDeleted', 'gridUpdated',
  'tokensUpdated',
  'mapRevealed',
  'diceRollResult', 'chatMessage', 'errorMessage'
];

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
  check('слушает 0.0.0.0, а не только 127.0.0.1', () => {
    assert.strictEqual(server.httpServer.address().address, '0.0.0.0');
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

  /* ------------------------------------------------------------- кубики */

  console.log('\nКубики');
  const results = [];
  const collect = (roll) => results.push(roll);
  p2.on('diceRollResult', collect);
  for (let i = 0; i < 120; i += 1) emit(p1, 'rollDice', { sides: 20 });
  await waitFor(() => results.length === 120, '120 бросков d20');
  check('d20 всегда даёт 1..20 и результат варьируется', () => {
    assert.ok(results.every((roll) => roll.result >= 1 && roll.result <= 20));
    assert.ok(new Set(results.map((roll) => roll.result)).size > 5, 'результаты не варьируются');
  });
  check('бросок обрабатывает сервер, в событии есть имя, кость и время', () => {
    assert.strictEqual(results[0].playerName, 'Артём');
    assert.strictEqual(results[0].sides, 20);
    assert.ok(!Number.isNaN(Date.parse(results[0].time)));
  });
  results.length = 0;
  for (let i = 0; i < 5; i += 1) emit(p1, 'rollDice', { sides: 1 });
  await waitFor(() => results.length === 5, 'броски d1');
  check('d1 всегда даёт ровно 1', () => {
    assert.ok(results.every((roll) => roll.result === 1));
  });
  results.length = 0;
  emit(p1, 'rollDice', { sides: 12 });
  await waitFor(() => results.length === 1, 'бросок d12');
  check('все кости от d1 до d20 поддерживаются', () => {
    assert.strictEqual(results[0].sides, 12);
    assert.ok(results[0].result >= 1 && results[0].result <= 12);
  });
  p2.off('diceRollResult', collect);

  p1.log.errorMessage.length = 0;
  emit(p1, 'rollDice', { sides: 21 });
  emit(p1, 'rollDice', { sides: 0 });
  emit(dm, 'rollDice', { sides: 20 });
  await waitFor(() => p1.log.errorMessage.length >= 2, 'отказ по костям вне d1..d20');
  check('кости вне диапазона d1..d20 отклоняются', () => {
    assert.strictEqual(p1.log.errorMessage.length, 2);
  });
  check('ДМ тоже может бросать кубики', () => {
    assert.ok(p2.log.diceRollResult.some((roll) => roll.playerName === 'Мастер'));
  });
  check('бросок объявляется в общем чате (виден и тем, кто подключится позже)', () => {
    const announcement = p1.log.chatMessage.filter((message) => message.isRoll && message.text.startsWith('бросил d12')).pop();
    assert.ok(announcement, 'нет объявления броска d12 в чате');
    assert.strictEqual(announcement.from, 'Артём');
    assert.match(announcement.text, /^бросил d12: \d+$/, `текст: ${announcement.text}`);
    assert.ok(room.chatHistory.some((message) => message.isRoll), 'броска нет в истории чата на сервере');
  });

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
// Показ карты игрокам: мастер переключает карту, игроки остаются на
  // показанной и переходят только по кнопке «Показать игрокам».
  const worldSlot = room.maps.world;
  if (!worldSlot.items[1]) {
    // Нужны две карты: первая уже лежит, до��авляем вторую тем же png.
    emit(dm, 'uploadMap', { type: 'world', image: PNG_1PX, name: 'base' });
    await waitFor(() => worldSlot.items.length >= 2, 'вторая карта во вкладке');
  }
  const firstId = worldSlot.items[0].id;
  const secondId = worldSlot.items[1].id;

  emit(dm, 'selectMap', { type: 'world', mapId: firstId });
  await waitFor(() => worldSlot.activeId === firstId, 'мастер смотрит первую карту');
  emit(dm, 'revealMap', { type: 'world', mapId: firstId });
  await waitFor(() => worldSlot.revealedId === firstId, 'первая карта показана игрокам');

  emit(dm, 'selectMap', { type: 'world', mapId: secondId });
  await waitFor(() => worldSlot.activeId === secondId, 'мастер переключился на вторую');
  check('переключение у мастера не двигает карту у игроков', () => {
    assert.strictEqual(worldSlot.revealedId, firstId, 'показанная карта должна остаться прежней');
    assert.notStrictEqual(worldSlot.revealedId, worldSlot.activeId, 'мастер смотрит другую карту');
  });

  dm.log.mapRevealed.length = 0;
  emit(dm, 'revealMap', { type: 'world', mapId: secondId });
  const revealed = await waitFor(() => dm.log.mapRevealed[0], 'событие показа карты');
  check('кнопка «Показать игрокам» переводит всех на текущую карту мастера', () => {
    assert.strictEqual(revealed.mapId, secondId);
    assert.strictEqual(revealed.type, 'world');
    assert.strictEqual(worldSlot.revealedId, secondId, 'после показа совпадает с мастерской');
  });

  // В снимке игрок получает revealedId, иначе с перезагрузкой всё поедет.
  check('в снимке игрока видна именно показанная карта', () => {
    const snapshot = room.snapshotFor({ playerId: 'p-1', role: 'player' });
    assert.strictEqual(snapshot.maps.world.revealedId, secondId);
  });
  const worldMapsAfterReveal = worldSlot.items.length;


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
    assert.strictEqual(restored.maps.world.items.length, worldMapsAfterReveal);
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
