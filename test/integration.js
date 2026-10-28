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
const FOG_COLUMNS = 64;
const FOG_ROWS = 40;
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
  'tokensUpdated', 'mapPing', 'reactionPrompt',
  'diceRollResult', 'chatMessage', 'chatDeleted', 'chatCleared', 'chatEdited', 'errorMessage', 'dmNoteUpdated', 'adventureUpdated',
  'calendarEventsUpdated', 'partyNotesUpdated',
  'journalUpdated', 'inventoryUpdated', 'inventoryCoinsUpdated', 'rollRequestUpdated', 'stateReload',
  'gameTimeUpdated', 'calendarMonthsUpdated'
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
/** Список состояний из клиентской модели, тот же, что берёт сервер. */
function windowlessConditionIds() {
  return require('../renderer/dnd5e.js').CONDITIONS.map((item) => item.id);
}

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

  const hijack = makeClient(server.port);
  clients.push(hijack);
  await once(hijack, 'connect');
  const hijackAck = await join(hijack, { name: 'Самозванец', playerId: 'p-test-0001' });
  check('чужой клиент не входит под кодом игрока без секрета', () => {
    assert.strictEqual(hijackAck.ok, false);
    assert.strictEqual(hijackAck.code, 'identity-denied');
  });
  check('самозванец не переименовал чужого игрока', () => {
    const entry = room.playerList().find((player) => player.playerId === 'p-test-0001');
    assert.strictEqual(entry.name, 'Артём');
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
    subclass: 'Мастер войны',
    classes: [{ name: 'Воин', level: 3 }, { name: 'Волшебник', level: 2 }],
    race: 'Дварф',
    background: 'Солдат',
    alignment: 'Законно-добрый',
    level: 5,
    experience: 6500,
    abilities: { str: 17, dex: 14, con: 16, int: 10, wis: 12, cha: 8 },
    saveProficiencies: { str: true, con: true },
    skillProficiencies: { athletics: true, perception: false },
    skillExpertise: { athletics: true, stealth: true },
    hp: 44, maxHp: 44, tempHp: 0, hitDice: '1d10', hitDiceSpent: 2,
    inspiration: 3, exhaustion: 2, concentration: 'Благословение',
    coins: { cp: 1, sp: 2, ep: 3, gp: 4, pp: 5 },
    armorClass: 18, initiativeMisc: 0, speed: 25,
    attacks: 'Боевой топор +7, 1d8+3',
    attackList: [
      { name: 'Боевой топор', bonus: 7, damage: '1d8+3' },
      { name: '', bonus: 0, damage: '' },
      { name: 'Лук', bonus: 99, damage: '1d8+3' }
    ],
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
    assert.strictEqual(saved.sheet.hitDiceSpent, 2);
    assert.strictEqual(saved.sheet.subclass, 'Мастер войны');
    assert.strictEqual(saved.sheet.armorClass, 18);
    assert.strictEqual(saved.sheet.inspiration, 3);
    assert.strictEqual(saved.sheet.exhaustion, 2);
    assert.strictEqual(saved.sheet.concentration, 'Благословение');
    assert.deepStrictEqual(saved.sheet.coins, { cp: 1, sp: 2, ep: 3, gp: 4, pp: 5 });
    assert.strictEqual(saved.sheet.proficiencyBonusManual, null);
    assert.strictEqual(saved.sheet.classes.length, 2, 'мультикласс должен сохраниться списком');
    assert.strictEqual(saved.sheet.classes[1].name, 'Волшебник');
    assert.strictEqual(saved.sheet.classes[1].level, 2);
  });
  check('строки атак сохраняются, пустая выбрасывается, бонус ограничен', () => {
    assert.strictEqual(saved.sheet.attackList.length, 2);
    assert.deepStrictEqual(saved.sheet.attackList[0], {
      name: 'Боевой топор', bonus: 7, damage: '1d8+3'
    });
    assert.strictEqual(saved.sheet.attackList[1].bonus, 30);
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

  const fakeDm = makeClient(server.port);
  clients.push(fakeDm);
  await once(fakeDm, 'connect');
  const fakeDmAck = await join(fakeDm, { name: 'Не ДМ', playerId: 'dm' });
  check('игрок не может занять код мастера', () => {
    assert.strictEqual(fakeDmAck.ok, false);
    assert.strictEqual(fakeDmAck.code, 'identity-denied');
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
  check('ДМ загружает карту как заготовку, игрок её пока не получает', () => {
    assert.strictEqual(worldMap.items.length, 1);
    assert.match(worldMap.items[0].url, /^\/files\/.+\.png$/);
    assert.strictEqual(worldMap.items[0].name, 'world.png');
    assert.strictEqual(worldMap.items[0].published, false, 'новая карта должна быть заготовкой');
    assert.strictEqual(worldMap.activeId, worldMap.items[0].id, 'мастер сразу видит новую карту');
    assert.strictEqual(worldMap.activeMap, null, 'загрузка не должна переключать показ');
    assert.strictEqual(worldMap.activeMapId, null);
  });
  const worldHiddenForPlayer = await waitFor(
    () => p1.log.mapUpdated.filter((item) => item.type === 'world').pop(),
    'вкладка карт у игрока после загрузки'
  );
  check('скрытая заготовка не уходит игроку даже ссылкой', () => {
    assert.strictEqual(worldHiddenForPlayer.items.length, 0);
    assert.strictEqual(worldHiddenForPlayer.activeMap, null);
  });

  p1.log.mapUpdated.length = 0;
  emit(dm, 'setActiveMap', { type: 'world', mapId: worldMap.items[0].id });
  const worldShown = await waitFor(
    () => p1.log.mapUpdated.find((item) => item.type === 'world'
      && item.activeMapId === worldMap.items[0].id && item.items.length),
    'показ общей карты игрокам'
  );
  check('кнопка «Показать игрокам» открывает карту всему столу', () => {
    assert.strictEqual(worldShown.items.length, 1);
    assert.strictEqual(worldShown.items[0].published, true);
    assert.strictEqual(worldShown.activeId, worldMap.items[0].id);
    assert.strictEqual(room.activeMap, 'world');
    assert.strictEqual(room.activeMapId, worldMap.items[0].id);
  });

  p1.log.mapPing.length = 0;
  emit(p1, 'mapPing', {
    mapType: 'world',
    mapId: worldMap.items[0].id,
    x: 0.25,
    y: 0.75
  });
  const ping = await waitFor(() => p1.log.mapPing[0], 'пинг по карте');
  check('пинг уходит всему столу и не сохраняется', () => {
    assert.strictEqual(ping.mapType, 'world');
    assert.strictEqual(ping.mapId, worldMap.items[0].id);
    assert.strictEqual(ping.x, 0.25);
    assert.strictEqual(ping.y, 0.75);
    assert.strictEqual(ping.role, 'player');
    assert.strictEqual(ping.name, 'Артём');
    assert.ok(!Object.prototype.hasOwnProperty.call(room.serialize(), 'ping'), 'пинг попал в кампанию');
  });

  p1.log.mapPing.length = 0;
  emit(p1, 'mapPing', {
    mapType: 'world',
    mapId: 'чужая-карта',
    x: 0.5,
    y: 0.5
  });
  await wait(80);
  check('пинг на карте, которой нет на столе, не рассылается', () => {
    assert.strictEqual(p1.log.mapPing.length, 0);
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
  check('вторая карта тоже загружается заготовкой и не переключает показ', () => {
    assert.strictEqual(battleMap.activeMap, 'world');
    assert.strictEqual(battleMap.activeMapId, worldMap.items[0].id);
    assert.strictEqual(battleMap.items[0].published, false);
  });
  // Дальше по сценарию карта битвы должна быть показана: жмём «Показать».
  emit(dm, 'setActiveMap', { type: 'battle', mapId: battleMap.items[0].id });
  await waitFor(
    () => room.activeMap === 'battle' && room.activeMapId === battleMap.items[0].id,
    'показ карты битвы'
  );

  /* ---------------------------- несколько карт в одной вкладке */

  p1.log.mapUpdated.length = 0;
  dm.log.mapUpdated.length = 0;
  emit(dm, 'uploadMap', { type: 'battle', image: PNG_1PX, name: 'пещера.png' });
  const secondBattle = await waitFor(
    () => dm.log.mapUpdated.filter((item) => item.type === 'battle' && item.items.length === 2).pop(),
    'вторая карта в той же вкладке'
  );
  check('во вкладку можно загрузить ещё одну карту, не потеряв прежнюю', () => {
    assert.strictEqual(secondBattle.items.length, 2, `карт во вкладке: ${secondBattle.items.length}`);
    assert.strictEqual(secondBattle.items[1].name, 'пещера.png');
    assert.strictEqual(secondBattle.items[1].published, false, 'новая карта — заготовка');
    assert.strictEqual(secondBattle.activeId, secondBattle.items[1].id, 'мастер сразу видит заготовку');
    assert.strictEqual(room.currentMap('battle').name, 'пещера.png');
    assert.strictEqual(room.activeMapId, battleMap.items[0].id, 'показ остался на прежней карте');
  });
  const caveHidden = await waitFor(
    () => p1.log.mapUpdated.filter((item) => item.type === 'battle').pop(),
    'вкладка битвы у игрока после заготовки'
  );
  check('заготовка не попадает в список карт игрока', () => {
    assert.strictEqual(caveHidden.items.length, 1, `игрок получил карт: ${caveHidden.items.length}`);
    assert.strictEqual(caveHidden.items[0].id, battleMap.items[0].id);
    assert.strictEqual(caveHidden.activeId, battleMap.items[0].id);
  });
  check('снимок состояния игрока не содержит заготовок карт', () => {
    const snapshot = room.snapshotFor({ playerId: 'p-test-0001', role: 'player' });
    assert.strictEqual(snapshot.maps.battle.items.length, 1, `в снимок попало карт: ${snapshot.maps.battle.items.length}`);
    assert.strictEqual(snapshot.maps.battle.items[0].published, true);
    assert(!snapshot.maps.battle.items.some((item) => item.name === 'пещера.png'), 'в снимок попала заготовка');
    assert.strictEqual(snapshot.maps.world.items.length, 1);
    assert.strictEqual(snapshot.activeMapId, battleMap.items[0].id);
  });

  // Мастер листает карты вкладки у себя: игроки остаются на показанной.
  p1.log.mapUpdated.length = 0;
  emit(dm, 'selectMap', { type: 'battle', mapId: secondBattle.items[0].id });
  await waitFor(() => room.currentMap('battle').name === 'battle.png', 'выбор первой карты вкладки');
  emit(dm, 'selectMap', { type: 'battle', mapId: secondBattle.items[1].id });
  await waitFor(() => room.currentMap('battle').name === 'пещера.png', 'выбор заготовки во вкладке');
  const browsing = await waitFor(
    () => p1.log.mapUpdated.filter((item) => item.type === 'battle').pop(),
    'обновление вкладки у игрока'
  );
  check('мастер листает карты вкладки, не показывая их игрокам', () => {
    assert.strictEqual(browsing.items.length, 1, `игрок получил заготовки: ${browsing.items.length}`);
    assert.strictEqual(browsing.activeId, battleMap.items[0].id, 'у игрока сменилась карта');
    assert.strictEqual(browsing.activeMapId, battleMap.items[0].id);
    assert.strictEqual(room.activeMapId, battleMap.items[0].id);
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'selectMap', { type: 'battle', mapId: secondBattle.items[1].id });
  await waitFor(() => p1.log.errorMessage.find((item) => item.message.includes('только ДМ')), 'отказ игроку в переключении карт');
  check('игрок не может переключать карты вкладки', () => {
    assert.strictEqual(room.currentMap('battle').name, 'пещера.png');
  });

  p1.log.mapUpdated.length = 0;
  emit(dm, 'setActiveMap', { type: 'battle', mapId: secondBattle.items[1].id });
  const caveShown = await waitFor(
    () => p1.log.mapUpdated.find((item) => item.type === 'battle'
      && item.activeMapId === secondBattle.items[1].id && item.items.length === 2),
    'показ заготовки игрокам'
  );
  check('показ заготовки открывает её игрокам вместе с соседней картой', () => {
    assert.strictEqual(caveShown.items[1].published, true);
    assert.strictEqual(caveShown.activeId, secondBattle.items[1].id);
    assert.strictEqual(room.activeMap, 'battle');
    assert.strictEqual(room.activeMapId, secondBattle.items[1].id);
  });

  dm.log.errorMessage.length = 0;
  dm.log.mapUpdated.length = 0;
  emit(dm, 'deleteMap', { type: 'battle', mapId: secondBattle.items[1].id });
  const afterDelete = await waitFor(
    () => dm.log.mapUpdated.filter((item) => item.type === 'battle' && item.items.length === 1).pop(),
    'удаление одной карты из вкладки'
  );
  check('удаление показанной карты возвращает стол к соседней', () => {
    assert.strictEqual(dm.log.errorMessage.length, 0, `ошибка при удалении: ${JSON.stringify(dm.log.errorMessage)}`);
    assert.strictEqual(afterDelete.items[0].name, 'battle.png');
    assert.strictEqual(afterDelete.items[0].published, true);
    assert.strictEqual(afterDelete.activeId, secondBattle.items[0].id);
    assert.strictEqual(room.maps.battle.items.length, 1);
    assert.strictEqual(room.activeMap, 'battle');
    assert.strictEqual(room.activeMapId, secondBattle.items[0].id);
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
    assert.strictEqual(room.activeMapId, secondBattle.items[0].id);
  });

  p1.log.mapUpdated.length = 0;
  emit(dm, 'setActiveMap', { type: 'world' });
  await waitFor(() => p1.log.mapUpdated.find((item) => item.activeMap === 'world'), 'смена активной карты');
  check('ДМ переключает активную карту для всех клиентов', () => {
    assert.strictEqual(room.activeMap, 'world');
    assert.strictEqual(room.activeMapId, worldMap.items[0].id);
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
    assert.strictEqual(room.activeMapId, worldMap.items[0].id);
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
    assert.strictEqual(sketchMap.items[0].published, false);
    assert.strictEqual(room.activeMap, 'world', 'рисунок пока не показан игрокам');
    assert.strictEqual(room.activeMapId, worldMap.items[0].id);
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
  emit(dm, 'setActiveMap', { type: 'sketch', mapId: sketchMap.items[0].id });
  await waitFor(() => room.activeMap === 'sketch' && room.activeMapId === sketchMap.items[0].id, 'показ рисунка');
  emit(dm, 'deleteMap', { type: 'sketch' });
  await waitFor(() => room.maps.sketch.items.length === 0, 'удаление карты-рисунка');
  check('удаление показанного рисунка возвращает показ к оставшейся карте', () => {
    assert.strictEqual(room.activeMap, 'world');
    assert.strictEqual(room.activeMapId, worldMap.items[0].id);
  });
  // Возвращаем рисунок: ниже проверим, что три карты вместе переживают
  // сохранение и загрузку кампании.
  emit(dm, 'uploadMap', { type: 'sketch', image: PNG_1PX, name: 'Рисунок.png' });
  await waitFor(() => room.maps.sketch.items.length > 0, 'повторная загрузка карты-рисунка');
  emit(dm, 'setActiveMap', { type: 'world' });
  await waitFor(() => room.activeMap === 'world', 'возврат к общей карте');

  /* ------------------------------------ перенос фишек на показанную карту */

  console.log('\nПеренос фишек на показанную карту');
  const preparedBattle = room.maps.battle.items[0];
  dm.log.tokenCreated.length = 0;
  emit(dm, 'createToken', { name: 'Готовый монстр', mapType: 'battle', mapId: preparedBattle.id });
  const preparedToken = await waitFor(
    () => dm.log.tokenCreated.find((token) => token.name === 'Готовый монстр'),
    'фишка на заготовке'
  );
  p1.log.tokenCreated.length = 0;
  emit(dm, 'setTokenHidden', { tokenId: preparedToken.id, hidden: false });
  await wait(120);
  check('фишка на непоказанной карте не уходит игрокам', () => {
    assert.strictEqual(
      p1.log.tokenCreated.filter((token) => token.id === preparedToken.id).length,
      0,
      'игрок получил фишку со скрытой карты'
    );
    assert.strictEqual(room.tokens.find((token) => token.id === preparedToken.id).hidden, false);
    const snapshot = room.snapshotFor({ playerId: 'p-test-0001', role: 'player' });
    assert.strictEqual(snapshot.tokens.some((token) => token.id === preparedToken.id), false,
      'фишка со скрытой карты попала в снимок состояния');
  });

  p1.log.tokenCreated.length = 0;
  emit(dm, 'moveTokenToActiveMap', { tokenId: preparedToken.id });
  const movedToken = await waitFor(
    () => p1.log.tokenCreated.find((token) => token.id === preparedToken.id),
    'перенос фишки на показанную карту'
  );
  check('мастер переносит фишку на карту, которую видят игроки', () => {
    assert.strictEqual(movedToken.mapType, 'world');
    assert.strictEqual(movedToken.mapId, room.activeMapId);
    assert.strictEqual(movedToken.x, 0.5);
    assert.strictEqual(movedToken.y, 0.5);
    assert.strictEqual(movedToken.hidden, false);
    const token = room.tokens.find((item) => item.id === preparedToken.id);
    assert.strictEqual(token.mapType, 'world');
    assert.strictEqual(token.mapId, room.activeMapId);
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'moveTokenToActiveMap', { tokenId: preparedToken.id });
  await waitFor(() => p1.log.errorMessage.find((item) => item.message.includes('только ДМ')), 'отказ игроку в переносе');
  dm.log.errorMessage.length = 0;
  emit(dm, 'moveTokenToActiveMap', { tokenId: preparedToken.id });
  await waitFor(() => dm.log.errorMessage.find((item) => item.message.includes('уже на этой карте')), 'повторный перенос');
  emit(dm, 'deleteToken', { tokenId: preparedToken.id });
  await waitFor(() => !room.tokens.some((token) => token.id === preparedToken.id), 'уборка перенесённой фишки');
  // Дальше сценарий читает первые события списков, поэтому чистим журналы.
  dm.log.tokenCreated.length = 0;
  p1.log.tokenCreated.length = 0;
  p1.log.tokenDeleted.length = 0;

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

  /* ------------------------------------------------------- время в игре */

  console.log('\nВремя в игре');
  p1.log.errorMessage.length = 0;
  emit(p1, 'setGameTime', { day: 3, hour: 12 });
  await waitFor(() => p1.log.errorMessage.find((item) => item.message.includes('только ДМ')), 'отказ игроку в часах');
  check('игрок не может перевести часы', () => {
    assert.deepStrictEqual(room.gameTime, { day: 1, hour: 8 });
  });

  p1.log.gameTimeUpdated.length = 0;
  emit(dm, 'setGameTime', { day: 3, hour: 25 });
  const timeEvent = await waitFor(() => p1.log.gameTimeUpdated[0], 'рассылка времени');
  check('мастер переводит часы, час режется сутками', () => {
    assert.deepStrictEqual(timeEvent, { day: 3, hour: 23 });
    assert.deepStrictEqual(room.gameTime, { day: 3, hour: 23 });
    const snapshot = room.snapshotFor({ playerId: 'p-test-0001', role: 'player' });
    assert.deepStrictEqual(snapshot.gameTime, { day: 3, hour: 23 }, 'время не попало в снимок игрока');
  });

  check('время переживает сохранение и загрузку кампании', () => {
    const saved = new RoomState({ state: room.serialize() });
    assert.deepStrictEqual(saved.gameTime, { day: 3, hour: 23 });
  });

  // Старая кампания без часов открывается утром первого дня.
  check('кампания без часов начинает утро первого дня', () => {
    const legacy = new RoomState({ state: { players: [], sheets: {} } });
    assert.deepStrictEqual(legacy.gameTime, { day: 1, hour: 8 });
  });

  emit(dm, 'setGameTime', { day: 1, hour: 8 });
  await waitFor(() => room.gameTime.hour === 8 && room.gameTime.day === 1, 'возврат часов');

  /* ----------------------------------------------------------- календарь */

  console.log('\nКалендарь');
  const defaultMonths = require('../renderer/dnd5e.js').CALENDAR.monthNames.slice();
  const customMonths = ['Снежень', 'Ветрень', 'Травень'];
  check('старая кампания получает стандартные названия месяцев', () => {
    const legacy = new RoomState({ state: { players: [], sheets: {} } });
    assert.deepStrictEqual(legacy.calendarMonths, defaultMonths);
  });

  p1.log.calendarMonthsUpdated.length = 0;
  const monthsAck = await new Promise((resolve) => {
    dm.emit('setCalendarMonths', { months: customMonths }, resolve);
  });
  const monthsEvent = await waitFor(() => p1.log.calendarMonthsUpdated[0], 'рассылка календаря');
  check('мастер задаёт свои названия месяцев, и их видят все', () => {
    assert.strictEqual(monthsAck.ok, true);
    assert.deepStrictEqual(monthsAck.months, customMonths);
    assert.deepStrictEqual(monthsEvent, customMonths);
    assert.deepStrictEqual(
      room.snapshotFor({ playerId: 'p-test-0001', role: ROLE_PLAYER }).calendarMonths,
      customMonths
    );
  });
  check('календарь переживает сохранение кампании', () => {
    const saved = new RoomState({ state: room.serialize() });
    assert.deepStrictEqual(saved.calendarMonths, customMonths);
  });

  p1.log.errorMessage.length = 0;
  const deniedMonths = await new Promise((resolve) => {
    p1.emit('setCalendarMonths', { months: ['Нельзя'] }, resolve);
  });
  check('игрок не может менять календарь', () => {
    assert.strictEqual(deniedMonths.ok, false);
    assert.match(deniedMonths.error, /только ДМ/);
    assert.deepStrictEqual(room.calendarMonths, customMonths);
  });

  await new Promise((resolve) => dm.emit('setCalendarMonths', { months: ['Один', 'Два'] }, resolve));
  await new Promise((resolve) => dm.emit('undoDmAction', {}, resolve));
  await waitFor(() => room.calendarMonths.length === customMonths.length, 'отмена календаря');
  check('смена названий месяцев отменяется через Ctrl+Z', () => {
    assert.deepStrictEqual(room.calendarMonths, customMonths);
  });

  await new Promise((resolve) => dm.emit('setCalendarMonths', { months: defaultMonths }, resolve));
  await waitFor(() => room.calendarMonths.length === defaultMonths.length, 'возврат календаря');

  /* ------------------------------------------------- события календаря */

  p1.log.calendarEventsUpdated.length = 0;
  const eventAck = await new Promise((resolve) => {
    dm.emit('addCalendarEvent', { title: 'Ярмарка', day: 5 }, resolve);
  });
  const eventBroadcast = await waitFor(() => p1.log.calendarEventsUpdated[0], 'рассылка события');
  check('мастер добавляет событие календаря, и его видят все', () => {
    assert.strictEqual(eventAck.ok, true);
    assert.strictEqual(eventBroadcast.length, 1);
    assert.strictEqual(eventBroadcast[0].title, 'Ярмарка');
    assert.strictEqual(eventBroadcast[0].day, 5);
    assert.ok(eventBroadcast[0].id, 'у события нет id');
    assert.strictEqual(
      room.snapshotFor({ playerId: 'p-test-0001', role: ROLE_PLAYER }).calendarEvents[0].title,
      'Ярмарка'
    );
  });
  check('событие календаря переживает сохранение кампании', () => {
    const saved = new RoomState({ state: room.serialize() });
    assert.strictEqual(saved.calendarEvents[0].title, 'Ярмарка');
  });

  p1.log.errorMessage.length = 0;
  const deniedEvent = await new Promise((resolve) => {
    p1.emit('addCalendarEvent', { title: 'Нельзя', day: 6 }, resolve);
  });
  check('событие календаря добавляет только мастер', () => {
    assert.strictEqual(deniedEvent.ok, false);
    assert.match(deniedEvent.error, /только ДМ/);
    assert.strictEqual(room.calendarEvents.length, 1);
  });

  const secondEvent = await new Promise((resolve) => {
    dm.emit('addCalendarEvent', { title: 'Полнолуние', day: 12 }, resolve);
  });
  await new Promise((resolve) => {
    dm.emit('deleteCalendarEvent', { id: eventAck.event.id }, resolve);
  });
  check('мастер удаляет событие календаря', () => {
    assert.strictEqual(room.calendarEvents.length, 1);
    assert.strictEqual(room.calendarEvents[0].id, secondEvent.event.id);
  });
  await new Promise((resolve) => dm.emit('undoDmAction', {}, resolve));
  check('удаление события календаря отменяется', () => {
    assert.strictEqual(room.calendarEvents.length, 2);
    assert.ok(room.calendarEvents.some((event) => event.title === 'Ярмарка'));
  });

  /* ----------------------------------------------------- заметки партии */

  console.log('\nЗаметки партии');
  p2.log.partyNotesUpdated.length = 0;
  const notesAck = await new Promise((resolve) => {
    p1.emit('setPartyNotes', { text: 'Партия идёт к башне.' }, resolve);
  });
  const notesBroadcast = await waitFor(() => p2.log.partyNotesUpdated[0], 'рассылка заметок');
  check('игрок пишет общие заметки, и их видит весь стол', () => {
    assert.strictEqual(notesAck.ok, true);
    assert.strictEqual(notesBroadcast, 'Партия идёт к башне.');
    assert.strictEqual(
      room.snapshotFor({ playerId: 'p-test-0002', role: ROLE_PLAYER }).partyNotes,
      'Партия идёт к башне.'
    );
  });
  const notesDmAck = await new Promise((resolve) => {
    dm.emit('setPartyNotes', { text: 'Мастер дописал: ключ у кузнеца.' }, resolve);
  });
  check('мастер тоже правит общие заметки', () => {
    assert.strictEqual(notesDmAck.ok, true);
    assert.strictEqual(room.partyNotes, 'Мастер дописал: ключ у кузнеца.');
  });
  check('заметки партии переживают сохранение кампании', () => {
    const saved = new RoomState({ state: room.serialize() });
    assert.strictEqual(saved.partyNotes, 'Мастер дописал: ключ у кузнеца.');
  });

  /* ------------------------------------------------ долгий отдых партии */

  console.log('\nДолгий отдых партии');
  const restBefore = { ...room.gameTime };
  const restSheet = room.sheets.get('p-test-0001');
  restSheet.hp = 1;
  restSheet.tempHp = 4;
  restSheet.spellSlotsUsed = restSheet.spellSlotsUsed.map((value, index) => (index === 0 ? 1 : value));
  restSheet.exhaustion = 2;
  restSheet.hitDiceSpent = 1;
  const restSheet2 = room.sheets.get('p-test-0002');
  restSheet2.hp = 2;

  p1.log.errorMessage.length = 0;
  emit(p1, 'partyLongRest', {});
  await waitFor(() => p1.log.errorMessage.length > 0, 'игрок пробовал устроить отдых');
  check('долгий отдых партии запускает только мастер', () => {
    assert.ok(p1.log.errorMessage.some((item) => /только ДМ/.test(item.message)));
    assert.deepStrictEqual(room.gameTime, restBefore, 'часы сдвинулись от игрока');
  });

  p2.log.characterSheetData.length = 0;
  emit(dm, 'partyLongRest', {});
  await waitFor(
    () => room.gameTime.day === restBefore.day && room.gameTime.hour === (restBefore.hour + 8) % 24,
    'часы после отдыха'
  );
  await waitFor(() => p2.log.characterSheetData.length > 0, 'лист игрока после отдыха');
  check('долгий отдых лечит всю партию и сдвигает часы на восемь', () => {
    const healed = room.sheets.get('p-test-0001');
    assert.strictEqual(healed.hp, require('../renderer/dnd5e.js').effectiveMaxHp(healed));
    assert.strictEqual(healed.tempHp, 0);
    assert.strictEqual(healed.exhaustion, 1);
    assert.strictEqual(healed.spellSlotsUsed[0], 0);
    assert.strictEqual(healed.hitDiceSpent, 0);
    const other = room.sheets.get('p-test-0002');
    assert.strictEqual(other.hp, require('../renderer/dnd5e.js').effectiveMaxHp(other));
    assert.strictEqual(p2.log.characterSheetData.at(-1).sheet.hp, other.hp);
  });

  emit(dm, 'setGameTime', { day: 1, hour: 8 });
  await waitFor(() => room.gameTime.hour === 8 && room.gameTime.day === 1, 'возврат часов после отдыха');

  /* --------------------------------------------------------- истощение */

  console.log('\nИстощение');
  check('помеха инициативе берёт худший из двух бросков', () => {
    const sample = new RoomState();
    const entry = sample.addInitiativeEntry({ kind: 'other', name: 'Тест' });
    // randomInt зовётся дважды: выпало 20 и 3, при помехе остаётся 3.
    const values = [20, 3];
    sample.rollInitiative(() => values.shift(), null, new Set([entry.id]));
    assert.strictEqual(entry.roll, 3);
    assert.strictEqual(entry.total, 3);
  });

  check('без помехи инициатива бросается один раз', () => {
    const sample = new RoomState();
    const entry = sample.addInitiativeEntry({ kind: 'other', name: 'Тест' });
    let calls = 0;
    sample.rollInitiative(() => {
      calls += 1;
      return 12;
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(entry.roll, 12);
  });

  /* -------------------------------------------------------------- фишки */

  console.log('\nФишки');
  // Перенос фишки на показанную карту выше оставил события в журналах;
  // этой секции нужен чистый список, иначе проверка «скрытая фишка» увидит
  // чужое событие.
  dm.log.tokenCreated.length = 0;
  p1.log.tokenCreated.length = 0;
  p2.log.tokenCreated.length = 0;
  p1.log.tokenDeleted.length = 0;
  p1.log.errorMessage.length = 0;
  emit(p1, 'createToken', { name: 'Гоблин' });
  await waitFor(() => p1.log.errorMessage.find((item) => item.message.includes('только ДМ')), 'отказ в создании фишки');
  check('игрок не может создавать фишки', () => {
    assert.strictEqual(room.tokens.length, 0);
  });

  emit(dm, 'createToken', { name: 'Гоблин', mapType: 'world', size: 2 });
  const token = await waitFor(() => dm.log.tokenCreated[0], 'создание фишки');
  check('ДМ создаёт фишку в центре выбранной карты', () => {
    assert.strictEqual(token.name, 'Гоблин');
    assert.strictEqual(token.mapType, 'world');
    assert.strictEqual(token.x, 0.5);
    assert.strictEqual(token.y, 0.5);
    assert.strictEqual(token.assignedPlayerId, null);
    assert.strictEqual(token.side, 'enemy', 'фишка из формы по умолчанию должна быть врагом');
    assert.strictEqual(token.size, 2);
    assert.ok(token.color);
  });
  check('новая фишка появляется скрытой от игроков', () => {
    assert.strictEqual(token.hidden, true);
    assert.strictEqual(p1.log.tokenCreated.length, 0,
      `игрок получил скрытую фишку: ${p1.log.tokenCreated.map((entry) => entry.name).join(', ')}`);
    assert.strictEqual(p2.log.tokenCreated.length, 0,
      `игрок получил скрытую фишку: ${p2.log.tokenCreated.map((entry) => entry.name).join(', ')}`);
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
    // Назначение делает фишку союзником: за ней стоит персонаж игрока.
    assert.strictEqual(assigned.side, 'ally', `сторона после назначения: ${assigned.side}`);
  });

  dm.log.tokenUpdated.length = 0;
  emit(dm, 'setTokenSize', { tokenId: token.id, size: 9 });
  const resized = await waitFor(
    () => dm.log.tokenUpdated.find((item) => item.id === token.id && item.size === 4),
    'размер фишки'
  );
  check('размер фишки задаёт мастер, лишнее обрезается до четырёх клеток', () => {
    assert.strictEqual(resized.size, 4);
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'setTokenSize', { tokenId: token.id, size: 1 });
  await waitFor(
    () => p1.log.errorMessage.find((item) => item.message.includes('только ДМ')),
    'отказ игроку в размере фишки'
  );
  check('игрок не меняет размер фишки', () => {
    assert.strictEqual(room.tokens[0].size, 4);
  });

  /* ------------------------------------------------- сторона фишки */

  console.log('\nСторона фишки');
  check('старая кампания делит фишки по игроку', () => {
    const withPlayer = room.normalizeToken({ id: 'old-1', name: 'Старый', assignedPlayerId: 'p-test-0001' });
    const withoutPlayer = room.normalizeToken({ id: 'old-2', name: 'Старый монстр' });
    assert.strictEqual(withPlayer.side, 'ally', 'фишка с игроком должна стать союзником');
    assert.strictEqual(withoutPlayer.side, 'enemy', 'фишка без игрока должна стать врагом');
  });

  dm.log.tokenCreated.length = 0;
  emit(dm, 'createToken', { name: 'Дружелюбный НПС', mapType: 'world', side: 'ally', attackBonus: 3 });
  const allyToken = await waitFor(
    () => dm.log.tokenCreated.find((item) => item.name === 'Дружелюбный НПС'),
    'фишка-союзник'
  );
  check('фишку можно создать сразу союзником', () => {
    assert.strictEqual(allyToken.side, 'ally');
    assert.strictEqual(allyToken.attackBonus, 3);
  });

  dm.log.tokenUpdated.length = 0;
  emit(dm, 'setTokenAttackBonus', { tokenId: allyToken.id, attackBonus: 99 });
  const bonusClamped = await waitFor(
    () => dm.log.tokenUpdated.find((item) => item.id === allyToken.id && item.attackBonus === 20),
    'бонус атаки'
  );
  check('бонус атаки сохраняется и обрезается до двадцати', () => {
    assert.strictEqual(bonusClamped.attackBonus, 20);
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'setTokenAttackBonus', { tokenId: allyToken.id, attackBonus: 5 });
  await waitFor(
    () => p1.log.errorMessage.find((item) => item.message.includes('только ДМ')),
    'отказ игроку в бонусе атаки'
  );
  check('игрок не меняет бонус атаки', () => {
    assert.strictEqual(room.tokens.find((item) => item.id === allyToken.id).attackBonus, 20);
  });

  dm.log.tokenUpdated.length = 0;
  emit(dm, 'setTokenArmorClass', { tokenId: allyToken.id, armorClass: 14 });
  const acSet = await waitFor(
    () => dm.log.tokenUpdated.find((item) => item.id === allyToken.id && item.armorClass === 14),
    'класс брони'
  );
  check('класс брони фишки сохраняется', () => {
    assert.strictEqual(acSet.armorClass, 14);
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'setTokenArmorClass', { tokenId: allyToken.id, armorClass: 9 });
  await waitFor(
    () => p1.log.errorMessage.find((item) => item.message.includes('только ДМ')),
    'отказ игроку в классе брони'
  );
  check('игрок не меняет класс брони', () => {
    assert.strictEqual(room.tokens.find((item) => item.id === allyToken.id).armorClass, 14);
  });

  dm.log.tokenUpdated.length = 0;
  emit(dm, 'setTokenArmorClass', { tokenId: allyToken.id, armorClass: null });
  await waitFor(
    () => dm.log.tokenUpdated.find((item) => item.id === allyToken.id && item.armorClass === null),
    'снятие класса брони'
  );
  check('класс брони можно снять', () => {
    assert.strictEqual(room.tokens.find((item) => item.id === allyToken.id).armorClass, null);
  });

  // У фишки игрока боевые числа живут в листе, и токен их не перебивает.
  const assignedToken = room.tokens.find((token) => token.assignedPlayerId);
  dm.log.errorMessage.length = 0;
  emit(dm, 'setTokenAttackBonus', { tokenId: assignedToken.id, attackBonus: 7 });
  await waitFor(
    () => dm.log.errorMessage.find((item) => item.message.includes('берётся из его листа')),
    'отказ бонусу атаки игрока'
  );
  dm.log.errorMessage.length = 0;
  emit(dm, 'setTokenArmorClass', { tokenId: assignedToken.id, armorClass: 20 });
  await waitFor(
    () => dm.log.errorMessage.find((item) => item.message.includes('берётся из его листа')),
    'отказ классу брони игрока'
  );
  check('боевые числа фишки игрока берутся из листа, а не из токена', () => {
    assert.strictEqual(dm.log.errorMessage.length, 1, 'второй отказ не пришёл');
  });

  dm.log.tokenUpdated.length = 0;
  emit(dm, 'setTokenSide', { tokenId: allyToken.id, side: 'enemy' });
  const flipped = await waitFor(
    () => dm.log.tokenUpdated.find((item) => item.id === allyToken.id && item.side === 'enemy'),
    'смена стороны'
  );
  check('мастер переключает сторону фишки', () => {
    assert.strictEqual(flipped.side, 'enemy');
  });

  dm.log.errorMessage.length = 0;
  emit(dm, 'setTokenSide', { tokenId: allyToken.id, side: 'neutral' });
  await waitFor(
    () => dm.log.errorMessage.find((item) => item.message.includes('Неизвестная сторона')),
    'отказ неизвестной стороне'
  );
  check('неизвестная сторона отклоняется', () => {
    assert.strictEqual(room.tokens.find((item) => item.id === allyToken.id).side, 'enemy');
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'setTokenSide', { tokenId: allyToken.id, side: 'ally' });
  await waitFor(
    () => p1.log.errorMessage.find((item) => item.message.includes('только ДМ')),
    'отказ игроку в смене стороны'
  );
  check('игрок не меняет сторону фишки', () => {
    assert.strictEqual(room.tokens.find((item) => item.id === allyToken.id).side, 'enemy');
  });

  // Массовое скрытие на вкладке не должно задевать другую сторону.
  emit(dm, 'setAllTokensHidden', { hidden: false });
  await waitFor(() => room.tokens.every((item) => item.hidden === false), 'показ всех фишек');
  emit(dm, 'setAllTokensHidden', { hidden: true, side: 'ally' });
  await waitFor(
    () => room.tokens.filter((item) => item.side === 'ally').every((item) => item.hidden),
    'скрытие союзников'
  );
  check('массовое скрытие на вкладке не трогает другую сторону', () => {
    assert.strictEqual(room.tokens.find((item) => item.id === allyToken.id).hidden, false,
      'враг скрылся вместе с союзниками');
  });
  // Возвращаем стол в видимое состояние: следующие проверки двигают фишку
  // игрока, а скрытую фишку игрок не видит и двигать не может.
  emit(dm, 'setAllTokensHidden', { hidden: false });
  await waitFor(() => room.tokens.every((item) => item.hidden === false), 'возврат видимости фишек');
  emit(dm, 'deleteToken', { tokenId: allyToken.id });
  await waitFor(() => !room.tokens.some((item) => item.id === allyToken.id), 'уборка фишки-союзника');

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

  /* --- статблоки --- */

  console.log('\nСтатблоки');
  room.adventure = null;
  emit(dm, 'setAdventureGroupStatblock', {
    name: 'Гоблин-вожак',
    create: true,
    statblock: {
      ac: 15, hp: 22, speed: '30 фт', cr: '1/2', size: 2,
      abilities: { str: 14, dex: 14, con: 12, int: 10, wis: 8, cha: 10 },
      attacks: 'Скимитар +4, 1d6+2',
      notes: 'Тактика стаи'
    }
  });
  await waitFor(
    () => dm.log.adventureUpdated.find((adventure) => adventure.actors
      && adventure.actors.some((actor) => actor.name === 'Гоблин-вожак')),
    'статблок в справочнике'
  );
  check('мастер создаёт NPC и заполняет статблок', () => {
    const actor = room.adventure.actors.find((entry) => entry.name === 'Гоблин-вожак');
    assert.ok(actor, 'NPC не появился в справочнике');
    assert.strictEqual(actor.statblock.ac, 15);
    assert.strictEqual(actor.statblock.hp, 22);
    assert.strictEqual(actor.statblock.size, 2);
    assert.strictEqual(actor.statblock.abilities.str, 14);
  });
  check('игрок не получает справочник приключения', () => {
    const snapshot = room.snapshotFor({ playerId: 'p-test-0001', role: 'player' });
    assert.strictEqual(snapshot.adventure, null);
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'setAdventureGroupStatblock', {
    name: 'Гоблин-вожак',
    statblock: { ac: 10, hp: 1 }
  });
  await waitFor(
    () => p1.log.errorMessage.find((item) => item.message.includes('только ДМ')),
    'отказ игроку в правке статблока'
  );
  check('статблок правит только мастер', () => {
    const actor = room.adventure.actors.find((entry) => entry.name === 'Гоблин-вожак');
    assert.strictEqual(actor.statblock.ac, 15);
  });

  dm.log.tokenCreated.length = 0;
  emit(dm, 'createTokenFromAdventureActor', { name: 'Гоблин-вожак', mapType: 'world' });
  const actorToken = await waitFor(
    () => dm.log.tokenCreated.find((item) => item.name === 'Гоблин-вожак'),
    'фишка из статблока'
  );
  check('фишка из статблока берёт прочность и размер', () => {
    assert.strictEqual(actorToken.maxHp, 22);
    assert.strictEqual(actorToken.hp, 22);
    assert.strictEqual(actorToken.size, 2);
    assert.strictEqual(actorToken.hidden, true);
  });
  emit(dm, 'deleteToken', { tokenId: actorToken.id });
  await waitFor(() => !room.tokens.some((item) => item.id === actorToken.id), 'удаление фишки из статблока');
  dm.log.tokenCreated.length = 0;
  const spawnAck = await new Promise((resolve) => {
    dm.emit('createTokenFromAdventureActor', {
      name: 'Гоблин-вожак', mapType: 'world', x: 0.3, y: 0.4, count: 3
    }, resolve);
  });
  await waitFor(
    () => dm.log.tokenCreated.filter((item) => item.name === 'Гоблин-вожак').length >= 3,
    'три фишки из статблока'
  );
  check('из статблока можно поставить несколько фишек сразу', () => {
    assert.strictEqual(spawnAck.ok, true);
    assert.strictEqual(spawnAck.tokens.length, 3, 'ответ не вернул созданные фишки');
    const copies = room.tokens.filter((item) => item.name === 'Гоблин-вожак');
    assert.strictEqual(copies.length, 3, `создано фишек: ${copies.length}`);
    assert.strictEqual(new Set(copies.map((item) => item.id)).size, 3, 'id повторились');
    assert(new Set(copies.map((item) => `${item.x}:${item.y}`)).size > 1,
      'все копии легли в одну точку');
    assert(copies.every((item) => item.maxHp === 22 && item.hp === 22 && item.side === 'enemy'),
      'у копий не тот статблок');
  });
  dm.log.adventureUpdated.length = 0;
  emit(dm, 'setAdventureActorFavorite', { name: 'Гоблин-вожак', favorite: true });
  await waitFor(
    () => dm.log.adventureUpdated.find((adventure) => adventure.actors
      && adventure.actors.some((actor) => actor.name === 'Гоблин-вожак' && actor.favorite)),
    'избранное в справочнике'
  );
  check('избранное сохраняется у всех записей группы', () => {
    assert.ok(room.adventure.actors
      .filter((actor) => actor.name === 'Гоблин-вожак')
      .every((actor) => actor.favorite), 'избранное не разошлось по группе');
  });

  // Копии убираем до проверки сохранённой кампании: иначе в метаданных
  // окажется четыре фишки вместо одной и следующий раздел упадёт.
  for (const copy of room.tokens.filter((item) => item.name === 'Гоблин-вожак')) {
    emit(dm, 'deleteToken', { tokenId: copy.id });
  }
  await waitFor(
    () => !room.tokens.some((item) => item.name === 'Гоблин-вожак'),
    'удаление копий из статблока'
  );

  emit(p1, 'deleteAdventureActor', { name: 'Гоблин-вожак' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  check('игрок не может удалить персонажа из справочника', () => {
    assert.ok(room.adventure.actors.some((entry) => entry.name === 'Гоблин-вожак'),
      'игрок удалил запись мастера');
  });

  dm.log.adventureUpdated.length = 0;
  emit(dm, 'deleteAdventureActor', { name: 'Гоблин-вожак' });
  await waitFor(
    () => !room.adventure.actors.some((entry) => entry.name === 'Гоблин-вожак'),
    'удаление персонажа из справочника'
  );
  check('мастер удаляет персонажа из справочника', () => {
    assert.ok(dm.log.adventureUpdated.some((adventure) => adventure.actors
      && !adventure.actors.some((entry) => entry.name === 'Гоблин-вожак')),
    'мастеру не пришёл обновлённый справочник');
  });

  /* --- скрытие фишек --- */

  console.log('\nСкрытие фишек');
  p1.log.tokenUpdated.length = 0;
  p1.log.tokenMoved.length = 0;
  // В журнале могли остаться события массового скрытия с проверок стороны:
  // без очистки waitFor ниже находит старое событие и обгоняет сервер.
  p1.log.tokenHidden.length = 0;
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
  check('показ скрытой фишки не выдаёт игроку прочность монстра', () => {
    const shown = p2.log.tokenCreated.find((item) => item.id === hpToken.id);
    // Показ идёт тем же путём, что и правка: иначе tokenCreated уносил бы
    // игрокам полные хиты и скрытое имя, которое сервер прячет в снимке.
    assert.strictEqual(shown.maxHp, null, `игрок увидел максимум при показе: ${shown.maxHp}`);
    assert.strictEqual(shown.hp, null, `игрок увидел хиты при показе: ${shown.hp}`);
  });

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
  const dmChatBeforeMonsterHp = dm.log.chatMessage.length;
  const p2ChatBeforeMonsterHp = p2.log.chatMessage.length;
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

  await wait(700);
  check('прочность монстра не попадает в чат', () => {
    assert.strictEqual(
      dm.log.chatMessage.length,
      dmChatBeforeMonsterHp,
      'мастеру пришло объявление о скрытой прочности'
    );
    assert.strictEqual(
      p2.log.chatMessage.length,
      p2ChatBeforeMonsterHp,
      'игроку пришло объявление о скрытой прочности'
    );
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
  dm.log.chatMessage.length = 0;
  p2.log.chatMessage.length = 0;
  emit(dm, 'setTokenHp', { tokenId: heroToken.id, hp: 4 });
  await waitFor(() => p2.log.tokenUpdated.find((item) => item.id === heroToken.id), 'игрок увидел урон своей фишке');
  check('прочность фишки игрока видна всем, в том числе его сопернику за столом', () => {
    assert.strictEqual(p2.log.tokenUpdated.find((item) => item.id === heroToken.id).hp, 4);
  });

  const hpNotice = await waitFor(
    () => p2.log.chatMessage.find((message) => message.system && /Кобра/.test(message.text)),
    'объявление об уроне фишке игрока'
  );
  check('изменение прочности фишки игрока объясняется в чате', () => {
    const sheet = room.sheets.get('p-test-0001');
    assert.match(hpNotice.text, new RegExp(`4/${sheet.maxHp}`), `в объявлении нет прочности: ${hpNotice.text}`);
    assert.match(hpNotice.text, new RegExp(`урон ${sheet.maxHp - 4}`), `в объявлении нет разницы: ${hpNotice.text}`);
    assert(
      dm.log.chatMessage.some((message) => message.text === hpNotice.text),
      'мастер не увидел объявление об уроне'
    );
  });
  check('урон по фишке игрока пишется в его лист, а не в отдельное число', () => {
    const sheet = room.sheets.get('p-test-0001');
    assert.strictEqual(sheet.hp, 4);
    const seen = room.tokenForViewer(room.tokens.find((item) => item.id === heroToken.id), false);
    assert.strictEqual(seen.hp, 4);
    assert.strictEqual(seen.maxHp, require('../renderer/dnd5e.js').effectiveMaxHp(sheet));
  });

  const restoredSheet = { ...room.sheets.get('p-test-0001') };
  restoredSheet.hp = require('../renderer/dnd5e.js').effectiveMaxHp(restoredSheet);
  p2.log.tokenUpdated.length = 0;
  emit(p1, 'saveCharacterSheet', { sheet: restoredSheet });
  await waitFor(
    () => p2.log.tokenUpdated.find((item) => item.id === heroToken.id && item.hp === restoredSheet.hp),
    'лечение в листе обновило фишку'
  );
  check('лечение в листе сразу видно на фишке', () => {
    const seen = p2.log.tokenUpdated.find((item) => item.id === heroToken.id && item.hp === restoredSheet.hp);
    assert(seen, 'фишка осталась со старым здоровьем');
    assert.strictEqual(room.sheets.get('p-test-0001').hp, restoredSheet.hp);
  });

  // Урон с временными хитами и проверкой концентрации.
  const damageSheet = room.sheets.get('p-test-0001');
  damageSheet.hp = 10;
  damageSheet.tempHp = 5;
  damageSheet.concentration = 'Щит веры';
  damageSheet.deathSavesSuccesses = 0;
  damageSheet.deathSavesFailures = 0;
  room.syncSheetTokens('p-test-0001');
  p1.log.characterSheetData.length = 0;
  p1.log.chatMessage.length = 0;
  dm.log.chatMessage.length = 0;
  p2.log.rollRequestUpdated.length = 0;
  emit(dm, 'applyTokenDamage', { tokenId: heroToken.id, amount: 12, type: 'огонь' });
  await waitFor(
    () => p1.log.characterSheetData.find((item) => item.sheet.hp === 3),
    'урон с временными хитами'
  );
  const damageNotice = await waitFor(
    () => p1.log.chatMessage.find((message) => message.system && /огонь/.test(message.text)),
    'объявление об уроне с типом'
  );
  check('урон сначала съедает временные хиты, остаток пишет в лист', () => {
    assert.strictEqual(damageSheet.tempHp, 0);
    assert.strictEqual(damageSheet.hp, 3);
    assert.strictEqual(room.tokens.find((item) => item.id === heroToken.id).hp, 3);
    assert.match(damageNotice.text, /урон 7, огонь/, damageNotice.text);
  });
  const concentration = room.rollRequests.find((item) => /Концентрация/.test(item.label));
  check('урон по концентрирующемуся персонажу просит спасбросок с готовой СЛ', () => {
    assert.ok(concentration, 'заявки на концентрацию нет');
    assert.strictEqual(concentration.dc, 10);
    assert.strictEqual(concentration.to, 'p-test-0001');
    assert.match(concentration.formula, /^1d20[+-]\d+$/);
    const owner = room.snapshotFor({ playerId: 'p-test-0001', role: ROLE_PLAYER });
    assert.ok(owner.rollRequests.some((item) => item.id === concentration.id));
    const other = room.snapshotFor({ playerId: 'p-test-0002', role: ROLE_PLAYER });
    assert.ok(!other.rollRequests.some((item) => item.id === concentration.id), 'проверка утекла');
  });
  await new Promise((resolve) => dm.emit('rollRequestClear', { id: concentration.id }, resolve));
  await waitFor(() => room.rollRequests.length === 0, 'снятие проверки концентрации');

  damageSheet.hp = 0;
  damageSheet.deathSavesFailures = 2;
  damageSheet.concentration = '';
  room.syncSheetTokens('p-test-0001');
  p1.log.characterSheetData.length = 0;
  emit(dm, 'applyTokenDamage', { tokenId: heroToken.id, amount: 5, healing: true });
  await waitFor(
    () => p1.log.characterSheetData.find((item) => item.sheet.hp === 5),
    'лечение с нуля'
  );
  check('лечение с нуля сбрасывает спасброски смерти', () => {
    assert.strictEqual(damageSheet.hp, 5);
    assert.strictEqual(damageSheet.deathSavesFailures, 0);
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'applyTokenDamage', { tokenId: heroToken.id, amount: 1 });
  const deniedDamage = await waitFor(
    () => p1.log.errorMessage.find((item) => /только ДМ/.test(item.message)),
    'игрок пробовал нанести урон'
  );
  check('урон по фишке наносит только мастер', () => {
    assert.match(deniedDamage.message, /только ДМ/);
  });

  // Защиты от урона и смерть от урона на нуле.
  const heroRoomToken = room.tokens.find((item) => item.id === heroToken.id);
  const originalMaxHp = damageSheet.maxHp;
  damageSheet.maxHp = 20;
  damageSheet.hp = 20;
  damageSheet.tempHp = 0;
  damageSheet.concentration = '';
  damageSheet.deathSavesFailures = 0;
  damageSheet.deathSavesSuccesses = 0;
  room.syncSheetTokens('p-test-0001');
  room.setTokenDefenses(heroRoomToken, {
    resistances: ['огонь'],
    vulnerabilities: ['холод'],
    immunities: ['яд']
  });
  const fireHit = room.applyTokenDamage(heroRoomToken, 10, 'огонь', false);
  check('сопротивление уменьшает урон вдвое', () => {
    assert.strictEqual(fireHit.damage, 5);
    assert.strictEqual(fireHit.defense, 'resistant');
    assert.strictEqual(damageSheet.hp, 15);
  });
  const coldHit = room.applyTokenDamage(heroRoomToken, 10, 'холод', false);
  check('уязвимость удваивает урон', () => {
    assert.strictEqual(coldHit.damage, 20);
    assert.strictEqual(coldHit.defense, 'vulnerable');
    assert.strictEqual(damageSheet.hp, 0);
  });
  damageSheet.hp = 20;
  damageSheet.deathSavesFailures = 0;
  damageSheet.deathSavesSuccesses = 0;
  room.syncSheetTokens('p-test-0001');
  const poisonHit = room.applyTokenDamage(heroRoomToken, 10, 'яд', false);
  check('иммунитет не пропускает урон и не просит концентрацию', () => {
    assert.strictEqual(poisonHit.damage, 0);
    assert.strictEqual(poisonHit.defense, 'immune');
    assert.strictEqual(damageSheet.hp, 20);
    assert.strictEqual(poisonHit.concentration, null);
  });
  damageSheet.hp = 0;
  damageSheet.deathSavesFailures = 0;
  damageSheet.deathSavesSuccesses = 2;
  room.syncSheetTokens('p-test-0001');
  room.applyTokenDamage(heroRoomToken, 5, 'кислота', false);
  check('урон по лежащему герою даёт провал спасброска смерти', () => {
    assert.strictEqual(damageSheet.hp, 0);
    assert.strictEqual(damageSheet.deathSavesFailures, 1);
    assert.strictEqual(damageSheet.deathSavesSuccesses, 0);
  });
  damageSheet.hp = 5;
  damageSheet.deathSavesFailures = 0;
  damageSheet.deathSavesSuccesses = 0;
  room.syncSheetTokens('p-test-0001');
  const massiveHit = room.applyTokenDamage(heroRoomToken, 25, 'кислота', false);
  check('урон не меньше максимума хитов убивает сразу', () => {
    assert.strictEqual(massiveHit.instantDeath, true);
    assert.strictEqual(damageSheet.deathSavesFailures, 3);
    assert.strictEqual(damageSheet.hp, 0);
  });

  p2.log.tokenUpdated.length = 0;
  emit(dm, 'setTokenDefenses', {
    tokenId: heroToken.id,
    resistances: ['Огонь', 'мусор'],
    vulnerabilities: 'холод',
    immunities: []
  });
  const defenseUpdate = await waitFor(
    () => p2.log.tokenUpdated.find((item) => item.id === heroToken.id && item.damageResistances
      && item.damageResistances.includes('огонь')),
    'защиты фишки дошли до игрока'
  );
  check('защиты фишки нормализуются и видны игроку', () => {
    assert.deepStrictEqual(defenseUpdate.damageResistances, ['огонь']);
    assert.deepStrictEqual(defenseUpdate.damageVulnerabilities, ['холод']);
  });
  p1.log.errorMessage.length = 0;
  emit(p1, 'setTokenDefenses', { tokenId: heroToken.id, resistances: ['огонь'] });
  const deniedDefenses = await waitFor(
    () => p1.log.errorMessage.find((item) => /только ДМ/.test(item.message)),
    'игрок пробовал править защиты'
  );
  check('защиты фишки правит только мастер', () => {
    assert.match(deniedDefenses.message, /только ДМ/);
  });

  // Возвращаем лист к полному здоровью: дальше идут проверки, которые
  // рассчитывают на целого персонажа.
  damageSheet.maxHp = originalMaxHp;
  damageSheet.hp = require('../renderer/dnd5e.js').effectiveMaxHp(damageSheet);
  damageSheet.tempHp = 0;
  damageSheet.concentration = '';
  damageSheet.deathSavesFailures = 0;
  damageSheet.deathSavesSuccesses = 0;
  room.setTokenDefenses(heroRoomToken, { resistances: [], vulnerabilities: [], immunities: [] });
  room.syncSheetTokens('p-test-0001');

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

  /* --- скрытое имя фишки --- */
  // Заводим фишку руками: так её имя точно известно и его нечего сравнивать с
  // именем персонажа.
  emit(dm, 'createToken', { name: 'Король Виверн', mapType: 'world' });
  const nameless = await waitFor(
    () => room.tokens.find((token) => token.name === 'Король Виверн'),
    'фишка для скрытия имени'
  );
  // Новая фишка скрыта, а скрытую игрокам вообще не рассылают. Показываем:
  // проверить скрытие имени на фишке, которой игрок и не видел бы, бессмысленно.
  emit(dm, 'setTokenHidden', { tokenId: nameless.id, hidden: false });
  await waitFor(() => room.tokens.find((token) => token.id === nameless.id).hidden === false, 'фишка показана');
  p1.log.tokenUpdated.length = 0;
  emit(dm, 'setTokenNameHidden', { tokenId: nameless.id, hidden: true });
  await waitFor(
    () => room.tokens.find((token) => token.id === nameless.id).hideName === true,
    'имя фишки скрыто'
  );
  check('мастер по-прежнему видит имя фишки со скрытым именем', () => {
    assert.strictEqual(
      room.tokenForViewer(room.tokens.find((token) => token.id === nameless.id), true).name,
      'Король Виверн'
    );
  });
  check('игроку имя фишки не достаётся: ни пустая строка не врёт, ни флага нет', () => {
    const forPlayer = room.tokenForViewer(room.tokens.find((token) => token.id === nameless.id), false);
    assert.strictEqual(forPlayer.name, '');
    assert.strictEqual(forPlayer.nameHidden, true);
    assert.ok(!JSON.stringify(room.snapshotFor({ playerId: P1, role: 'player' }))
      .includes('Король Виверн'), 'имя утекло в снимок состояния игрока');
  });
  check('событие фишки игроку уходит без имени', () => {
    const event = p1.log.tokenUpdated.find((item) => item && item.id === nameless.id);
    assert.ok(event, 'игрок не получил событие фишки');
    assert.strictEqual(event.name, '');
    assert.strictEqual(event.nameHidden, true);
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'setTokenNameHidden', { tokenId: nameless.id, hidden: false });
  await waitFor(() => p1.log.errorMessage.find((item) => /только ДМ/i.test(item.message)), 'скрытие имени игроком');
  check('игрок не может ни спрятать, ни вернуть имя фишки', () => {
    assert.strictEqual(room.tokens.find((token) => token.id === nameless.id).hideName, true);
  });

  emit(dm, 'setTokenNameHidden', { tokenId: nameless.id, hidden: false });
  await waitFor(
    () => room.tokens.find((token) => token.id === nameless.id).hideName === false,
    'имя фишки снова видно'
  );
  check('вернули имя — игрок снова видит его целиком', () => {
    const forPlayer = room.tokenForViewer(room.tokens.find((token) => token.id === nameless.id), false);
    assert.strictEqual(forPlayer.name, 'Король Виверн');
    assert.ok(!('nameHidden' in forPlayer));
  });
  check('скрытое имя не ломает прочность: у монстра её по-прежнему нет у игрока', () => {
    const monster = room.tokens.find((token) => token.id === nameless.id);
    monster.maxHp = 30;
    monster.hp = 30;
    const forPlayer = room.tokenForViewer(monster, false);
    assert.strictEqual(forPlayer.maxHp, null);
    assert.strictEqual(forPlayer.hp, null);
    monster.maxHp = null;
    monster.hp = null;
  });
  check('враг с назначенным игроком тоже не отдаёт прочность игроку', () => {
    const token = {
      ...room.tokens.find((entry) => entry.id === nameless.id),
      side: 'enemy',
      assignedPlayerId: 'p-no-sheet-0001',
      maxHp: 30,
      hp: 12
    };
    const forPlayer = room.tokenForViewer(token, false);
    assert.strictEqual(forPlayer.maxHp, null, 'игрок увидел прочность врага');
    assert.strictEqual(forPlayer.hp, null, 'игрок увидел текущие хиты врага');
    const ally = room.tokenForViewer({ ...token, side: 'ally' }, false);
    assert.strictEqual(ally.maxHp, 30, 'у союзника прочность пропала');
    assert.strictEqual(ally.hp, 12, 'у союзника пропали текущие хиты');
  });
  check('кадр портрета сохраняется в фишке и не выходит за пределы зума', () => {
    const cropped = room.normalizeToken({
      id: 'crop-1',
      name: 'Гоблин',
      x: 0.5,
      y: 0.5,
      imageUrl: '/files/goblin.png',
      imageZoom: 2,
      imageX: 25,
      imageY: -10
    });
    assert.strictEqual(cropped.imageZoom, 2);
    assert.strictEqual(cropped.imageX, 25);
    assert.strictEqual(cropped.imageY, -10);
    const extreme = room.normalizeToken({
      id: 'crop-2',
      name: 'Гоблин',
      x: 0.5,
      y: 0.5,
      imageUrl: '/files/goblin.png',
      imageZoom: 10,
      imageX: 999,
      imageY: -999
    });
    assert.strictEqual(extreme.imageZoom, 4, 'зум не обрезан');
    assert.strictEqual(extreme.imageX, 150, 'сдвиг вправо не обрезан');
    assert.strictEqual(extreme.imageY, -150, 'сдвиг влево не обрезан');
  });
  emit(dm, 'deleteToken', { tokenId: nameless.id });
  await waitFor(() => !room.tokens.some((token) => token.id === nameless.id), 'уборка фишки со скрытым именем');

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

  // Подпись броска нужна реакции: в ленте видно, что это d20 по конкретной
  // фишке, а не случайный бросок мастера.
  dm.log.chatMessage.length = 0;
  emit(dm, 'rollDice', { formula: 'd20', label: 'Атака по возможности: Волк → Артём' });
  const labeledRoll = await waitFor(
    () => dm.log.chatMessage.find((message) => message.isRoll && message.text.includes('Атака по возможности')),
    'подпись броска в чате'
  );
  check('подпись броска попадает в чат', () => {
    assert.match(labeledRoll.text, /^Атака по возможности: Волк → Артём — /);
    assert.match(labeledRoll.text, /d20/);
  });

  dm.log.chatMessage.length = 0;
  emit(dm, 'rollDice', { formula: 'd20', label: 'Атака по возможности: Волк → Артём', targetAc: 1 });
  const hitRoll = await waitFor(
    () => dm.log.chatMessage.find((message) => message.isRoll && message.text.includes('попадание по КД 1')),
    'попадание по КД'
  );
  emit(dm, 'rollDice', { formula: 'd20', label: 'Атака по возможности: Волк → Артём', targetAc: 60 });
  const missRoll = await waitFor(
    () => dm.log.chatMessage.find((message) => message.isRoll && message.text.includes('промах по КД 60')),
    'промах по КД'
  );
  check('сервер сравнивает бросок с КД и пишет исход', () => {
    assert.match(hitRoll.text, /попадание по КД 1$/);
    assert.match(missRoll.text, /промах по КД 60$/);
  });

  // Реакцию союзной фишки бросает её игрок, а не мастер: сервер передаёт
  // карточку адресату и не рассылает её всему столу.
  p1.log.errorMessage.length = 0;
  emit(p1, 'reactionPrompt', { playerId: 'p-test-0002' });
  await waitFor(
    () => p1.log.errorMessage.find((item) => item.message.includes('только ДМ')),
    'отказ игроку в карточке реакции'
  );
  p1.log.reactionPrompt.length = 0;
  p2.log.reactionPrompt.length = 0;
  emit(dm, 'reactionPrompt', {
    playerId: 'p-test-0001', attackerName: 'Волк', targetName: 'Артём', bonus: 3, targetAc: 15
  });
  const relayed = await waitFor(() => p1.log.reactionPrompt[0], 'карточка реакции игроку');
  check('игрок получает карточку реакции с бонусом и КД', () => {
    assert.strictEqual(relayed.playerId, 'p-test-0001');
    assert.strictEqual(relayed.attackerName, 'Волк');
    assert.strictEqual(relayed.targetName, 'Артём');
    assert.strictEqual(relayed.bonus, 3);
    assert.strictEqual(relayed.targetAc, 15);
    assert.strictEqual(p2.log.reactionPrompt.length, 0, 'карточка ушла чужому игроку');
  });

  // Карточка живёт в состоянии, а не только в событии: после переподключения
  // игрок получает её снимком.
  const playerSnap = room.snapshotFor({ playerId: 'p-test-0001', role: 'player' });
  const otherSnap = room.snapshotFor({ playerId: 'p-test-0002', role: 'player' });
  check('неподтверждённая реакция переживает переподключение', () => {
    assert.strictEqual(playerSnap.reactions.length, 1, 'в снимке игрока нет реакции');
    assert.strictEqual(playerSnap.reactions[0].id, relayed.id);
    assert.strictEqual(otherSnap.reactions.length, 0, 'чужая реакция утекла в снимок');
  });

  emit(p1, 'reactionResolved', { id: relayed.id });
  await waitFor(() => room.pendingReactions.length === 0, 'снятие реакции после броска');
  check('после ответа реакция снимается с сервера', () => {
    assert.strictEqual(room.pendingReactions.length, 0);
  });

  // Новый раунд закрывает прошлые поводы: отвечать на них уже поздно.
  const savedInitiative = room.initiative;
  room.initiative = { entries: [{ id: 'round-a' }, { id: 'round-b' }], turnId: 'round-a', round: 1 };
  room.addReaction({ playerId: 'p-test-0001', attackerName: 'Волк', targetName: 'Артём' });
  room.stepInitiativeTurn(1);
  room.stepInitiativeTurn(1);
  check('реакция прошлого раунда не переживает новый', () => {
    assert.strictEqual(room.initiative.round, 2);
    assert.strictEqual(room.pendingReactions.length, 0, 'карточка осталась на новый раунд');
  });
  room.initiative = savedInitiative;

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

  // Приватный бросок из статблока: мастеру крупная карточка, игрокам ничего.
  results.length = 0;
  const chatMark = p1.log.chatMessage.length;
  const privateRolls = [];
  const privateCollect = (roll) => privateRolls.push(roll);
  dm.on('dmRollResult', privateCollect);
  emit(dm, 'rollDice', {
    formula: '1d20+4',
    label: 'Гоблин: Кулак: атака',
    dmOnly: true
  });
  await waitFor(() => privateRolls.length === 1, 'приватный бросок мастера');
  await wait(200);
  check('приватный бросок из статблока видит только мастер', () => {
    const roll = privateRolls[0];
    assert.strictEqual(roll.hidden, true);
    assert.strictEqual(roll.formula, '1d20+4');
    assert.strictEqual(roll.label, 'Гоблин: Кулак: атака');
    assert.ok(roll.result >= 5 && roll.result <= 24, `результат: ${roll.result}`);
    assert.strictEqual(results.length, 0, 'игрок получил приватный бросок');
    assert.ok(!p1.log.chatMessage.slice(chatMark).some((message) => message.isRoll),
      'приватный бросок попал в чат игрока');
  });
  check('приватный бросок не оседает в истории кампании', () => {
    assert.ok(!room.diceHistory.some((roll) => roll.label === 'Гоблин: Кулак: атака'),
      'формула приватного броска осталась в истории');
    assert.ok(!room.chatHistory.some((message) => String(message.text || '').includes('1d20+4')),
      'формула приватного броска осталась в чате');
  });
  dm.off('dmRollResult', privateCollect);

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

  /* ------------------------------------------------- имя за столом */

  console.log('\nИмя за столом');
  const dmNameBefore = listHas('dm').name;
  const playerNameBefore = listHas(P1).name;

  emit(dm, 'setPlayerName', { name: '  Артём   Хозяин  ' });
  await waitFor(() => listHas('dm').name === 'Артём Хозяин', 'новое имя мастера');
  check('мастер задаёт себе имя, и оно сразу у всех', () => {
    assert.notStrictEqual(listHas('dm').name, dmNameBefore, 'имя мастера не изменилось');
    assert.strictEqual(listHas('dm').name, 'Артём Хозяин');
    // Двойные пробелы и края убраны: иначе в списке участников имя выехало бы
    // на полстроки и разъехалось бы с подписью под аватаром.
    assert.ok(!/\s{2}/.test(listHas('dm').name), 'в имени остались двойные пробелы');
    const seen = p1.log.playersUpdate[p1.log.playersUpdate.length - 1];
    assert.strictEqual(seen.find((entry) => entry.playerId === 'dm').name, 'Артём Хозяин',
      'игрок видит прежнее имя мастера');
  });

  dm.log.errorMessage.length = 0;
  emit(dm, 'setPlayerName', { name: '   ' });
  await waitFor(() => dm.log.errorMessage.length > 0, 'пустое имя');
  check('пустое имя не принимается, прежнее остаётся', () => {
    assert.ok(dm.log.errorMessage.some((item) => /не может быть пустым/.test(item.message)));
    assert.strictEqual(listHas('dm').name, 'Артём Хозяин', 'имя мастера стёрли пустым запросом');
  });

  const dmNameBeforeSpoof = listHas('dm').name;
  emit(p1, 'setPlayerName', { name: 'Я теперь мастер', playerId: 'dm' });
  await waitFor(() => listHas(P1).name === 'Я теперь мастер', 'игрок сменил своё имя');
  check('игрок переименовывает только себя, даже если подставит чужой playerId', () => {
    assert.strictEqual(listHas('dm').name, dmNameBeforeSpoof, 'игрок переименовал мастера');
    assert.notStrictEqual(listHas(P1).name, playerNameBefore, 'игрок не сменил своё имя');
  });

  // Лист создаётся с именем участника и служит запасным источником подписи в
  // чате. Если в нём было именно прежнее имя, оно обязано меняться вместе с
  // участником, иначе старые броски остались бы под чужим именем.
  check('имя, попавшее в лист по умолчанию, меняется вместе с участником', () => {
    assert.strictEqual(room.sheets.get(P1).playerName, 'Я теперь мастер',
      'имя участника не доехало до листа');
  });

  // Своё имя персонажа в листе важнее: его вписали руками, и смена имени
  // участника не должна его затирать.
  emit(p1, 'saveCharacterSheet', { sheet: { ...room.sheets.get(P1), playerName: 'Мира из листа' } });
  await wait(80);
  emit(p1, 'setPlayerName', { name: 'Артём' });
  await waitFor(() => listHas(P1).name === 'Артём', 'игрок сменил имя на Артёма');
  check('вписанное руками имя персонажа не затирается сменой имени игрока', () => {
    assert.strictEqual(room.sheets.get(P1).playerName, 'Мира из листа');
  });

  const nameSaved = new RoomState({ state: room.serialize() });
  check('новое имя мастера переживает сохранение кампании', () => {
    const saved = nameSaved.players.get('dm');
    assert(saved, 'мастер не сохранился');
    assert.strictEqual(saved.name, 'Артём Хозяин');
  });

  /* ----------------------------------------------------- туман войны */  /* ----------------------------------------------------- туман войны */

  console.log('\nТуман войны');
  const fogType = 'world';
  const fogSlot = room.maps[fogType];
  const fogMap = fogSlot.items.find((item) => item.id === fogSlot.activeId) || fogSlot.items[0];
  check('у карты есть своя маска тумана, и она пустая', () => {
    assert(fogMap, 'вкладка карт пуста');
    assert.strictEqual(typeof fogMap.fogMask, 'string', 'у карты нет маски тумана');
    assert.strictEqual(fogMap.fogMask.length, FOG_COLUMNS * FOG_ROWS, `длина маски: ${fogMap.fogMask.length}`);
    assert.strictEqual(fogMap.fogMask.indexOf('1'), -1, 'новая карта идёт с открытым туманом');
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'openMapFog', { type: fogType, mapId: fogMap.id, x: 0.5, y: 0.5, radius: 0.15 });
  emit(p1, 'setMapFog', { type: fogType, mapId: fogMap.id, open: true });
  await waitFor(() => p1.log.errorMessage.length >= 2, 'игрок пробовал открыть туман');
  check('туман открывает только мастер', () => {
    assert.strictEqual(p1.log.errorMessage.length, 2);
    assert.ok(p1.log.errorMessage.every((item) => /только ДМ/.test(item.message)));
    assert.strictEqual(room.maps[fogType].items.find((item) => item.id === fogMap.id).fogMask.indexOf('1'), -1,
      'игрок всё-таки открыл карту');
  });

  const playerMapsBefore = p2.log.mapUpdated.length;
  emit(dm, 'openMapFog', { type: fogType, mapId: fogMap.id, x: 0.5, y: 0.5, radius: 0.15 });
  await waitFor(() => p2.log.mapUpdated.length > playerMapsBefore, 'туман дошёл до игрока');
  check('открытый участок видят и игроки: у них та же карта', () => {
    const last = p2.log.mapUpdated[p2.log.mapUpdated.length - 1];
    const seen = last.items.find((item) => item.id === fogMap.id);
    assert(seen, 'игрок не увидел карту в обновлении');
    // Маска приходит игроку как есть: иначе карты у игроков и у мастера
    // разъедутся, и открытое у одного будет закрытым у другого.
    assert.strictEqual(seen.fogMask, room.maps[fogType].items.find((item) => item.id === fogMap.id).fogMask,
      'у игрока и мастера разные маски тумана');
    assert(seen.fogMask.indexOf('1') >= 0, 'у игрока карта осталась закрытой');
  });

  check('кисть открывает круг, а не квадрат', () => {
    const mask = room.maps[fogType].items.find((item) => item.id === fogMap.id).fogMask;
    const opened = (mask.match(/1/g) || []).length;
    assert(opened > 40 && opened < 400, `кисть открыла ${opened} клеток`);
    // Угол карты кисть не задела: открывать угол, которого никто не трогал,
    // мастер не ожидает.
    const firstRow = mask.slice(0, FOG_COLUMNS);
    assert.strictEqual(firstRow.indexOf('1'), -1, 'кисть накрыла верхний край карты');
  });

  emit(dm, 'openMapFog', { type: fogType, mapId: fogMap.id, x: 0.5, y: 0.5, radius: 0.15 });
  await wait(120);
  check('повтор по тому же месту не раздувает маску', () => {
    const before = room.maps[fogType].items.find((item) => item.id === fogMap.id).fogMask;
    emit(dm, 'openMapFog', { type: fogType, mapId: fogMap.id, x: 0.5, y: 0.5, radius: 0.15 });
    assert.strictEqual(
      room.maps[fogType].items.find((item) => item.id === fogMap.id).fogMask,
      before,
      'маска изменилась при повторной кисти'
    );
  });

  emit(dm, 'setMapFog', { type: fogType, mapId: fogMap.id, open: true });
  await waitFor(
    () => room.maps[fogType].items.find((item) => item.id === fogMap.id).fogMask.indexOf('0') < 0,
    'карта открыта целиком'
  );
  check('«Открыть всё» снимает туман с карты', () => {
    const mask = room.maps[fogType].items.find((item) => item.id === fogMap.id).fogMask;
    assert.strictEqual(mask.indexOf('0'), -1, 'на карте остались закрытые участки');
  });

  emit(dm, 'setMapFog', { type: fogType, mapId: fogMap.id, open: false });
  await waitFor(
    () => room.maps[fogType].items.find((item) => item.id === fogMap.id).fogMask.indexOf('1') < 0,
    'карта снова закрыта'
  );
  check('«Закрыть всё» возвращает карту в темноту', () => {
    const mask = room.maps[fogType].items.find((item) => item.id === fogMap.id).fogMask;
    assert.strictEqual(mask.indexOf('1'), -1);
    assert.strictEqual(mask.length, FOG_COLUMNS * FOG_ROWS);
  });

  // Автотуман: фишка игрока сама открывает участок, но только когда мастер
  // включил тумблер у карты.
  const followName = 'Разведчик автотумана';
  emit(dm, 'createToken', { name: followName, mapType: fogType, mapId: fogMap.id, x: 0.5, y: 0.5 });
  await waitFor(
    () => room.tokens.some((token) => token.name === followName),
    'фишка для автотумана'
  );
  const followToken = room.tokens.find((token) => token.name === followName);
  emit(dm, 'assignTokenToPlayer', { tokenId: followToken.id, playerId: 'p-test-0001' });
  await waitFor(() => followToken.assignedPlayerId === 'p-test-0001', 'фишка назначена игроку');
  emit(dm, 'setTokenHidden', { tokenId: followToken.id, hidden: false });
  await waitFor(() => followToken.hidden === false, 'фишка показана игрокам');
  emit(dm, 'setActiveMap', { type: fogType, mapId: fogMap.id });
  await waitFor(() => room.activeMapId === fogMap.id, 'карта показана игрокам');
  emit(dm, 'setMapFogFollow', { type: fogType, mapId: fogMap.id, follow: true });
  await waitFor(
    () => room.maps[fogType].items.find((item) => item.id === fogMap.id).fogFollow === true,
    'тумблер автотумана'
  );
  check('мастер включает автотуман у карты', () => {
    assert.strictEqual(
      room.maps[fogType].items.find((item) => item.id === fogMap.id).fogFollow, true);
  });

  emit(p1, 'moveToken', { tokenId: followToken.id, x: 0.3, y: 0.3, final: true });
  await waitFor(
    () => room.maps[fogType].items.find((item) => item.id === fogMap.id).fogMask.indexOf('1') >= 0,
    'автотуман открыл участок'
  );
  check('фишка игрока открывает туман вокруг себя', () => {
    assert.ok(
      room.maps[fogType].items.find((item) => item.id === fogMap.id).fogMask.indexOf('1') >= 0,
      'автотуман не открылся'
    );
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'setMapFogFollow', { type: fogType, mapId: fogMap.id, follow: false });
  await waitFor(() => p1.log.errorMessage.length > 0, 'игрок пробовал выключить автотуман');
  check('автотуман переключает только мастер', () => {
    assert.ok(p1.log.errorMessage.some((item) => /только ДМ/.test(item.message)));
    assert.strictEqual(
      room.maps[fogType].items.find((item) => item.id === fogMap.id).fogFollow, true);
  });

  // Фишка была только для проверки: дальше в тесте свои подсчёты фишек.
  emit(dm, 'deleteToken', { tokenId: followToken.id });
  await waitFor(() => !room.tokens.some((token) => token.id === followToken.id), 'удаление фишки автотумана');

  dm.log.errorMessage.length = 0;
  emit(dm, 'openMapFog', { type: fogType, mapId: 'no-such-map', x: 0.5, y: 0.5, radius: 0.1 });
  await waitFor(() => dm.log.errorMessage.length > 0, 'несуществующая карта');
  check('на несуществующей карте туман не открывается', () => {
    assert.ok(dm.log.errorMessage.some((item) => /Карта не найдена/.test(item.message)));
  });

  emit(dm, 'openMapFog', { type: fogType, mapId: fogMap.id, x: 0.5, y: 0.5, radius: 0.12 });
  await waitFor(
    () => room.maps[fogType].items.find((item) => item.id === fogMap.id).fogMask.indexOf('1') >= 0,
    'область открыта для проверки сохранения'
  );
  const fogSaved = new RoomState({ state: room.serialize() });
  check('открытые участки переживают сохранение кампании', () => {
    const saved = fogSaved.normalizeMapSlot(fogSaved.maps[fogType])
      .items.find((item) => item.id === fogMap.id);
    assert(saved.fogMask.indexOf('1') >= 0, 'маска тумана пропала из кампании');
    assert.strictEqual(saved.fogMask.length, FOG_COLUMNS * FOG_ROWS);
    assert.strictEqual(saved.fogFollow, true, 'тумблер автотумана пропал из кампании');
  });

  /* ------------------------------------------------ зрение по фишке */

  emit(dm, 'createToken', { name: 'Зрячий', maxHp: 10, size: 1, side: 'ally', mapType: fogType, mapId: fogMap.id });
  const visionToken = await waitFor(
    () => room.tokens.find((token) => token.name === 'Зрячий'),
    'фишка для зрения'
  );
  emit(dm, 'assignTokenToPlayer', { tokenId: visionToken.id, playerId: 'p-test-0001' });
  await waitFor(
    () => room.tokens.find((token) => token.id === visionToken.id).assignedPlayerId === 'p-test-0001',
    'фишка назначена игроку'
  );
  emit(dm, 'setTokenHidden', { tokenId: visionToken.id, hidden: false });
  await waitFor(
    () => room.tokens.find((token) => token.id === visionToken.id).hidden === false,
    'фишка зрения показана'
  );
  p1.log.errorMessage.length = 0;
  emit(p1, 'setTokenVision', { tokenId: visionToken.id, vision: 60 });
  await waitFor(() => p1.log.errorMessage.length > 0, 'игрок пробовал задать зрение');
  check('зрение фишки задаёт только мастер', () => {
    assert.ok(p1.log.errorMessage.some((item) => /только ДМ/.test(item.message)));
    assert.strictEqual(room.tokens.find((token) => token.id === visionToken.id).vision, 0);
  });

  emit(dm, 'setTokenVision', { tokenId: visionToken.id, vision: 60 });
  await waitFor(() => room.tokens.find((token) => token.id === visionToken.id).vision === 60, 'радиус зрения');
  check('мастер задаёт зрение фишки, и игрок его видит', () => {
    assert.strictEqual(room.tokens.find((token) => token.id === visionToken.id).vision, 60);
    const snapshot = room.snapshotFor({ playerId: 'p-test-0001', role: ROLE_PLAYER });
    assert.strictEqual(snapshot.tokens.find((token) => token.id === visionToken.id).vision, 60);
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'setMapVision', { type: fogType, mapId: fogMap.id, visionPerPlayer: true });
  await waitFor(() => p1.log.errorMessage.length > 0, 'игрок пробовал включить зрение карты');
  check('зрение по фишке включает только мастер', () => {
    assert.ok(p1.log.errorMessage.some((item) => /только ДМ/.test(item.message)));
    assert.notStrictEqual(
      room.maps[fogType].items.find((item) => item.id === fogMap.id).visionPerPlayer,
      true
    );
  });

  emit(dm, 'setMapVision', { type: fogType, mapId: fogMap.id, visionPerPlayer: true });
  await waitFor(
    () => room.maps[fogType].items.find((item) => item.id === fogMap.id).visionPerPlayer === true,
    'зрение карты включено'
  );
  check('зрение по фишке переживает сохранение кампании', () => {
    const saved = new RoomState({ state: room.serialize() });
    const savedMap = saved.normalizeMapSlot(saved.maps[fogType])
      .items.find((item) => item.id === fogMap.id);
    assert.strictEqual(savedMap.visionPerPlayer, true);
    assert.strictEqual(saved.tokens.find((token) => token.id === visionToken.id).vision, 60);
  });

  emit(dm, 'deleteToken', { tokenId: visionToken.id });
  await waitFor(() => !room.tokens.some((token) => token.id === visionToken.id), 'удаление фишки зрения');
  emit(dm, 'setMapVision', { type: fogType, mapId: fogMap.id, visionPerPlayer: false });
  await waitFor(
    () => room.maps[fogType].items.find((item) => item.id === fogMap.id).visionPerPlayer === false,
    'зрение карты выключено'
  );

  /* ------------------------------------------------------ поверхность */

  console.log('\nПоверхность карты');
  const litMap = () => room.maps[fogType].items.find((item) => item.id === fogMap.id);

  p1.log.errorMessage.length = 0;
  emit(p1, 'paintMapSurface', {
    type: fogType, mapId: fogMap.id, cells: [[1, 1, 'fire']]
  });
  await waitFor(() => p1.log.errorMessage.length > 0, 'игрок пробовал рисовать поверхность');
  check('поверхность рисует только мастер', () => {
    assert.ok(p1.log.errorMessage.every((item) => /только ДМ/.test(item.message)));
    assert.deepStrictEqual(litMap().surface.cells, {}, 'игрок нарисовал поверхность');
  });

  emit(dm, 'paintMapSurface', {
    type: fogType,
    mapId: fogMap.id,
    cells: [[2, 3, 'acid'], [3, 3, 'acid'], [4, 3, 'выдуманное'], [-1, 0, 'fire']]
  });
  await waitFor(() => litMap().surface.cells['2,3'] === 'acid', 'поверхность нарисована');
  check('сервер отбрасывает неизвестные типы поверхности и клетки вне карты', () => {
    assert.strictEqual(litMap().surface.cells['3,3'], 'acid', 'вторая клетка не нарисована');
    assert.ok(!('4,3' in litMap().surface.cells), 'несуществующий тип попал на карту');
    assert.ok(!('-1,0' in litMap().surface.cells), 'клетка с отрицательной координатой принята');
  });

  const playerSurface = () => {
    const snapshot = room.snapshotFor({ playerId: P1, role: 'player' });
    const map = snapshot.maps[fogType].items.find((item) => item.id === fogMap.id);
    return map.surface.cells;
  };
  check('поверхность видят игроки: по ней и судят, куда можно идти', () => {
    assert.strictEqual(playerSurface()['2,3'], 'acid');
  });

  emit(dm, 'paintMapSurface', {
    type: fogType, mapId: fogMap.id, cells: [[2, 3, null]]
  });
  await waitFor(() => !('2,3' in litMap().surface.cells), 'клетка стёрта');
  check('ластик убирает клетку, а не красит её заново', () => {
    assert.strictEqual(litMap().surface.cells['3,3'], 'acid');
  });

  const surfaceSaved = new RoomState({ state: room.serialize() });
  check('поверхность переживает сохранение кампании', () => {
    const saved = surfaceSaved.normalizeMapSlot(surfaceSaved.maps[fogType])
      .items.find((item) => item.id === fogMap.id);
    assert.strictEqual(saved.surface.cells['3,3'], 'acid');
  });

  emit(dm, 'clearMapSurface', { type: fogType, mapId: fogMap.id });
  await waitFor(() => !Object.keys(litMap().surface.cells).length, 'поверхность очищена');
  check('карту можно очистить от поверхности целиком', () => {
    assert.deepStrictEqual(Object.keys(litMap().surface.cells), []);
  });

  /* ------------------------------------------------------ освещение */

  console.log('\nОсвещение');

  check('у новой карты нет ни темноты, ни стен, ни источников', () => {
    const fresh = new RoomState().normalizeMapSlot({ url: '/files/a.png' }).items[0];
    assert.strictEqual(fresh.darkness, 0, 'новая карта не дневная');
    assert.deepStrictEqual(fresh.walls, [], 'у новой карты есть стены');
    assert.deepStrictEqual(fresh.lights, [], 'у новой карты есть источники света');
  });

  emit(dm, 'setMapDarkness', { type: fogType, mapId: fogMap.id, darkness: 5 });
  await waitFor(() => litMap().darkness === 1, 'темнота обрезана до единицы');
  emit(dm, 'setMapDarkness', { type: fogType, mapId: fogMap.id, darkness: 0.8 });
  await waitFor(() => litMap().darkness === 0.8, 'темнота вернулась к 0.8');
  check('темнота обрезается до 0..1', () => {
    assert.strictEqual(litMap().darkness, 0.8);
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'setMapDarkness', { type: fogType, mapId: fogMap.id, darkness: 0 });
  emit(p1, 'addMapWall', { type: fogType, mapId: fogMap.id, x1: 0.1, y1: 0, x2: 0.1, y2: 1 });
  emit(p1, 'addMapLight', { type: fogType, mapId: fogMap.id, x: 0.5, y: 0.5, radius: 20 });
  emit(p1, 'setTokenLight', { tokenId: 't-no-such', radius: 20 });
  await waitFor(() => p1.log.errorMessage.length >= 3, 'игрок пробовал править свет');
  check('свет, стены и темноту правит только мастер', () => {
    assert.ok(p1.log.errorMessage.every((item) => /только ДМ|не найдена/i.test(item.message)),
      `ответы игроку: ${JSON.stringify(p1.log.errorMessage.map((item) => item.message))}`);
    assert.strictEqual(litMap().darkness, 0.8, 'игрок изменил темноту');
    assert.strictEqual(litMap().walls.length, 0, 'игрок добавил стену');
    assert.strictEqual(litMap().lights.length, 0, 'игрок добавил источник света');
  });

  // Стена с идентификатором клиента: мастер рисует и сразу видит её на месте,
  // и вторая копия с серверным id осталась бы висеть вечно.
  const wallId = 'w-test-1';
  emit(dm, 'addMapWall', {
    type: fogType, mapId: fogMap.id, wallId, x1: 0.5, y1: 0, x2: 0.5, y2: 1
  });
  await waitFor(() => litMap().walls.length === 1, 'стена дошла до стола');
  check('стена сохраняет идентификатор клиента', () => {
    assert.strictEqual(litMap().walls[0].id, wallId);
  });

  const templateId = 'tpl-test-1';
  emit(dm, 'addMapTemplate', {
    type: fogType, mapId: fogMap.id, templateId,
    kind: 'square', x: 0.4, y: 0.5, size: 30, rotation: 90, color: '#66ccff'
  });
  await waitFor(() => litMap().templates && litMap().templates.length === 1, 'шаблон дошёл до стола');
  check('квадратный шаблон сохраняет вид, размер, поворот и цвет', () => {
    const template = litMap().templates[0];
    assert.strictEqual(template.id, templateId);
    assert.strictEqual(template.kind, 'square');
    assert.strictEqual(template.size, 30);
    assert.strictEqual(template.rotation, 90);
    assert.strictEqual(template.color, '#66ccff');
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'addMapTemplate', {
    type: fogType, mapId: fogMap.id, kind: 'sphere', x: 0.5, y: 0.5, size: 20
  });
  await waitFor(() => p1.log.errorMessage.length >= 1, 'игрок пробовал поставить шаблон');
  check('шаблон ставит только мастер', () => {
    assert.ok(p1.log.errorMessage.some((item) => /только ДМ/i.test(item.message)));
    assert.strictEqual(litMap().templates.length, 1, 'игрок добавил шаблон');
  });
  emit(dm, 'clearMapTemplates', { type: fogType, mapId: fogMap.id });
  await waitFor(() => litMap().templates.length === 0, 'шаблоны убраны');

  emit(dm, 'addMapWall', { type: fogType, mapId: fogMap.id, x1: 0.2, y1: 0.2, x2: 0.2, y2: 0.2 });
  await wait(60);
  check('точку стеной считать нельзя: карта не засоряется', () => {
    assert.strictEqual(litMap().walls.length, 1);
  });

  const lightId = 'l-test-1';
  emit(dm, 'addMapLight', {
    type: fogType, mapId: fogMap.id, lightId, x: 0.5, y: 0.5, radius: 20, color: '#ffb347'
  });
  await waitFor(() => litMap().lights.length === 1, 'источник света дошёл до стола');
  check('источник света приходит ко всем участникам стола', () => {
    const seen = p1.log.mapUpdated.slice(-1)[0];
    const item = seen.items.find((entry) => entry.id === fogMap.id);
    assert(item, 'карты нет в снимке вкладки');
    assert.strictEqual(item.lights.length, 1, 'игрок не получил источник света');
    assert.strictEqual(item.lights[0].radius, 20);
    assert.strictEqual(item.lights[0].hidden, false);
  });
  emit(dm, 'addMapLight', {
    type: fogType, mapId: fogMap.id, x: 0.4, y: 0.4, radius: -50, color: 'не цвет'
  });
  await waitFor(() => litMap().lights.length === 2, 'второй источник принят');
  check('мусор в источнике света не попадает на стол', () => {
    const second = litMap().lights[1];
    assert.ok(second.radius >= 1, `дальность обрезана в ноль: ${second.radius}`);
    assert.strictEqual(second.color, '#ffb347', `мусорный цвет дошёл до стола: ${second.color}`);
  });

  emit(dm, 'setMapLight', { type: fogType, mapId: fogMap.id, lightId, hidden: true });
  await waitFor(() => litMap().lights[0].hidden === true, 'источник погашен');
  check('погашенный источник остаётся на карте, но помечен', () => {
    assert.strictEqual(litMap().lights.length, 2);
    assert.strictEqual(litMap().lights[0].hidden, true);
  });

  emit(dm, 'deleteMapLight', { type: fogType, mapId: fogMap.id, lightId });
  await waitFor(() => litMap().lights.length === 1, 'источник убран');
  emit(dm, 'clearMapWalls', { type: fogType, mapId: fogMap.id });
  await waitFor(() => litMap().walls.length === 0, 'стены снесены');
  check('источник и стены снимаются поимённо', () => {
    assert.strictEqual(litMap().lights.length, 1);
    assert.strictEqual(litMap().walls.length, 0);
  });

  // Факел в руке: свет едет вместе с фишкой и виден игроку. Фишку заводим
  // здесь своей: та, что проверяла спавн из листа, к этому моменту удалена.
  emit(dm, 'createToken', { name: 'Факельщик', mapType: 'world' });
  await waitFor(() => room.tokens.some((token) => token.name === 'Факельщик'), 'фишка для света создана');
  const torchId = room.tokens.find((token) => token.name === 'Факельщик').id;
  // Спрятанной фишки игрок не получает вовсе, и свет её тоже не увидит.
  emit(dm, 'setTokenHidden', { tokenId: torchId, hidden: false });
  await waitFor(() => room.tokens.find((token) => token.id === torchId).hidden === false, 'фишка показана');
  emit(dm, 'setTokenLight', { tokenId: torchId, radius: 20, color: '#ffb347' });
  await waitFor(
    () => room.tokens.find((token) => token.id === torchId).light.radius === 20,
    'свет фишки принят'
  );
  check('свет фишки доходит до игрока вместе с ней', () => {
    const event = p1.log.tokenUpdated.filter((item) => item && item.id === torchId).slice(-1)[0];
    assert(event, 'игрок не получил обновление фишки');
    assert.strictEqual(event.light.radius, 20);
    assert.strictEqual(event.light.color, '#ffb347');
  });
  emit(dm, 'setTokenLight', { tokenId: torchId, radius: 0 });
  await waitFor(
    () => room.tokens.find((token) => token.id === torchId).light.radius === 0,
    'свет фишки погашен'
  );
  check('гасящий свет фишки убирает его совсем, а не оставляет по нулю', () => {
    const token = room.tokens.find((item) => item.id === torchId);
    assert.strictEqual(token.light.radius, 0);
  });
  emit(dm, 'deleteToken', { tokenId: torchId });
  await waitFor(() => !room.tokens.some((token) => token.id === torchId), 'фишка со светом убрана');

  // Масштаб карты проверяем последним делом в этом блоке и возвращаем ровно
  // то, что было: ниже по файлу сетка сверяется со своим прежним значением,
  // и подмена клетки сбила бы чужую проверку.
  const gridBefore = { ...room.grid };
  emit(dm, 'setGrid', { enabled: false, cell: 46, columns: 0, feetPerCell: 10 });
  await waitFor(() => room.grid.feetPerCell === 10, 'футов в клетке доехало');
  emit(dm, 'setGrid', { enabled: false, cell: 46, columns: 0, feetPerCell: 9999 });
  await waitFor(() => room.grid.feetPerCell === 50, 'футов в клетке обрезано');
  check('масштаб карты задаётся и обрезается сервером', () => {
    assert.strictEqual(room.grid.feetPerCell, 50);
  });
  emit(dm, 'setGrid', gridBefore);
  await waitFor(() => room.grid.feetPerCell === gridBefore.feetPerCell, 'масштаб возвращён');

  const lightSaved = new RoomState({ state: room.serialize() });
  check('стены, свет и темнота переживают сохранение кампании', () => {
    const saved = lightSaved.normalizeMapSlot(lightSaved.maps[fogType])
      .items.find((item) => item.id === fogMap.id);
    assert.strictEqual(saved.darkness, 0.8, 'темнота пропала из кампании');
    assert.strictEqual(saved.walls.length, 0);
    assert.strictEqual(saved.lights.length, 1);
    assert.strictEqual(saved.lights[0].x, 0.4);
  });

  /* ------------------------------------------------- заметки мастера */

  console.log('\nЗаметки мастера');
  dm.log.dmNoteUpdated.length = 0;
  p1.log.dmNoteUpdated.length = 0;
  emit(dm, 'setDmNote', { playerId: P1, note: 'на самом деле подслушивает для гильдии' });
  await waitFor(() => dm.log.dmNoteUpdated.length > 0, 'заметка мастера сохранена');
  check('заметка мастера доходит только до мастера', () => {
    assert.strictEqual(dm.log.dmNoteUpdated[0].note, 'на самом деле подслушивает для гильдии');
    assert.strictEqual(p1.log.dmNoteUpdated.length, 0, 'игрок получил заметку мастера');
  });

  emit(dm, 'setDmNote', { playerId: P1, note: 'вербовщик, своего не знает' });
  await wait(120);

  // Список участников не рассылается после заметки: она нужна только мастеру,
  // и он получает своё событие. Проверяем, что игрок увидит пустую заметку в
  // списке, если список у него запросят в следующий раз.
  const dmListForPlayer = room.playerList({ includeTokens: true, includeDmNotes: false });
  const dmListForDm = room.playerList({ includeTokens: true, includeDmNotes: true, includeHidden: true });
  check('список участников собирается отдельно для мастера и для игроков', () => {
    const playerSide = dmListForPlayer.find((item) => item.playerId === P1);
    const dmSide = dmListForDm.find((item) => item.playerId === P1);
    assert.strictEqual(playerSide.dmNote, '', `игроку отдан текст: ${playerSide.dmNote}`);
    assert.strictEqual(dmSide.dmNote, 'вербовщик, своего не знает');
  });

  /*
   * Фишка из листа появляется скрытой: мастер сначала расставляет партию и
   * только потом открывает её. Скрытые фишки игрокам не показываются, иначе они
   * догадались бы о заготовке, а мастеру показываются обязаны: иначе в его
   * списке участников кнопка «Вывести» горела бы у игрока вечно, и повторное
   * нажатие кончалось бы ошибкой «у игрока уже есть фишка».
   *
   * Игрок для проверки свой: к этому месту у P1 фишка уже есть, и искать её
   * в списке значило бы поймать чужую.
   */
  const hiddenPlayerId = 'p-hidden-token';
  room.addPlayer(hiddenPlayerId, 'Проверка фишки');
  emit(dm, 'createTokenFromSheet', { playerId: hiddenPlayerId });
  await waitFor(
    () => room.tokens.some((token) => token.assignedPlayerId === hiddenPlayerId),
    'фишка выведена из листа'
  );
  const hiddenToken = room.tokens.find((token) => token.assignedPlayerId === hiddenPlayerId);
  check('скрытая фишка игроку не видна, а мастеру видна', () => {
    assert.strictEqual(hiddenToken.hidden, true, 'фишка из листа должна быть скрыта');
    const playerSide = room.playerList({ includeTokens: true, includeDmNotes: false })
      .find((item) => item.playerId === hiddenPlayerId);
    const dmSide = room.playerList({ includeTokens: true, includeDmNotes: true, includeHidden: true })
      .find((item) => item.playerId === hiddenPlayerId);
    assert.strictEqual(playerSide.tokenId, null, 'игрок узнал о скрытой фишке из списка участников');
    assert.strictEqual(dmSide.tokenId, hiddenToken.id,
      'мастер не видит выведенную фишку, и кнопка «Вывести» не исчезнет');
  });
  check('выведенную из листа фишку нельзя вывести повторно', () => {
    // Отказ приходит тому, кто нажал, то есть мастеру.
    dm.log.errorMessage.length = 0;
    emit(dm, 'createTokenFromSheet', { playerId: hiddenPlayerId });
  });
  await waitFor(() => dm.log.errorMessage.length > 0, 'повторный вывод отклонён');
  check('повторный вывод фишки из листа отклонён с понятным ответом', () => {
    assert.ok(
      dm.log.errorMessage.some((item) => /уже есть фишка/i.test(item.message)),
      `ответ сервера: ${JSON.stringify(dm.log.errorMessage.map((item) => item.message))}`
    );
  });
  emit(dm, 'deleteToken', { tokenId: hiddenToken.id });
  await waitFor(
    () => !room.tokens.some((token) => token.id === hiddenToken.id),
    'выведенная фишка убрана'
  );
  room.players.delete(hiddenPlayerId);
  room.sheets.delete(hiddenPlayerId);

  const playerSnapshotNote = room.snapshotFor({ playerId: P1, role: ROLE_PLAYER });
  const dmSnapshotNote = room.snapshotFor({ playerId: P1, role: ROLE_DM });
  check('в снимке состояния заметка есть только у мастера', () => {
    assert.strictEqual(
      playerSnapshotNote.players.find((item) => item.playerId === P1).dmNote,
      '',
      'заметка утекла в снимок игрока'
    );
    assert.strictEqual(
      dmSnapshotNote.players.find((item) => item.playerId === P1).dmNote,
      'вербовщик, своего не знает'
    );
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'setDmNote', { playerId: P2, note: 'я тоже мастер' });
  await waitFor(() => p1.log.errorMessage.length > 0, 'игрок пишет заметку');
  check('заметку мастера пишет только мастер', () => {
    assert.ok(p1.log.errorMessage.some((item) => /только ДМ/.test(item.message)));
    assert.strictEqual(room.players.get(P2).dmNote || '', '');
  });

  const noteSaved = new RoomState({ state: room.serialize() });
  check('заметка переживает сохранение кампании', () => {
    assert.strictEqual(noteSaved.players.get(P1).dmNote, 'вербовщик, своего не знает');
  });
  emit(dm, 'setDmNote', { playerId: P1, note: '' });
  await wait(120);

  /* -------------------------------------------------------- состояния */  /* -------------------------------------------------------- состояния */

  console.log('\nСостояния фишки');
  dm.log.tokenCreated.length = 0;
  emit(dm, 'createToken', { name: 'Огр', mapType: 'world' });
  const condToken = await waitFor(
    () => dm.log.tokenCreated.find((item) => item.name === 'Огр'),
    'фишка для состояний'
  );
  emit(dm, 'setTokenHidden', { tokenId: condToken.id, hidden: false });
  await waitFor(() => p2.log.tokenCreated.find((item) => item.id === condToken.id), 'фишка видна игроку');

  p1.log.errorMessage.length = 0;
  emit(p1, 'setTokenConditions', { tokenId: condToken.id, conditions: ['prone'] });
  await waitFor(() => p1.log.errorMessage.length > 0, 'игрок пробовал задать состояние');
  check('состояния фишки задаёт только мастер', () => {
    assert.ok(p1.log.errorMessage.some((item) => /только ДМ/.test(item.message)));
    assert.deepStrictEqual(room.tokens.find((item) => item.id === condToken.id).conditions, []);
  });

  dm.log.tokenUpdated.length = 0;
  p2.log.tokenUpdated.length = 0;
  emit(dm, 'setTokenConditions', { tokenId: condToken.id, conditions: ['prone', 'poisoned', 'выдуманное'] });
  await waitFor(() => dm.log.tokenUpdated.find((item) => item.id === condToken.id), 'состояния заданы');
  check('мастер задаёт состояния, а сервер отбрасывает неизвестные', () => {
    const stored = room.tokens.find((item) => item.id === condToken.id);
    assert.deepStrictEqual(stored.conditions, ['prone', 'poisoned']);
  });
  check('состояния видны игроку: по ним и ориентируются, кого можно бить', () => {
    const seen = p2.log.tokenUpdated.find((item) => item.id === condToken.id);
    assert(seen, 'игрок не увидел обновление состояний');
    // В отличие от прочности, состояния прятать нечего, поэтому они уходят
    // игроку как есть.
    assert.deepStrictEqual(seen.conditions, ['prone', 'poisoned']);
  });

  emit(dm, 'setTokenConditions', { tokenId: condToken.id, conditions: ['prone', 'poisoned', 'prone'] });
  await waitFor(
    () => room.tokens.find((item) => item.id === condToken.id).conditions.length === 2,
    'повтор в списке состояний'
  );
  check('повтор состояния не двоится', () => {
    assert.deepStrictEqual(
      room.tokens.find((item) => item.id === condToken.id).conditions,
      ['prone', 'poisoned']
    );
  });

  dm.log.tokenUpdated.length = 0;
  p2.log.tokenUpdated.length = 0;
  emit(dm, 'setTokenConditions', {
    tokenId: condToken.id,
    conditions: ['prone', 'poisoned'],
    conditionDurations: { prone: 3, poisoned: 99, выдуманное: 4 }
  });
  await waitFor(
    () => (room.tokens.find((item) => item.id === condToken.id).conditionDurations || {}).prone === 3,
    'длительности состояний'
  );
  check('длительность состояния хранится и не выходит за предел', () => {
    const stored = room.tokens.find((item) => item.id === condToken.id);
    assert.deepStrictEqual(stored.conditionDurations, { prone: 3, poisoned: 99 });
  });
  const seenDurations = await waitFor(
    () => p2.log.tokenUpdated.find((item) => item.id === condToken.id
      && item.conditionDurations && item.conditionDurations.prone === 3),
    'длительности у игрока'
  );
  check('длительности видны игроку вместе с состояниями', () => {
    assert.deepStrictEqual(seenDurations.conditionDurations, { prone: 3, poisoned: 99 });
  });

  const condSaved = new RoomState({ state: room.serialize() });
  check('состояния переживают сохранение кампании', () => {
    const saved = condSaved.tokens.find((item) => item.name === 'Огр');
    assert.deepStrictEqual(saved.conditions, ['prone', 'poisoned']);
    assert.deepStrictEqual(saved.conditionDurations, { prone: 3, poisoned: 99 });
  });

  check('состояний ровно столько, сколько есть в правилах', () => {
    assert.ok(windowlessConditionIds().length >= 13, 'список состояний потерялся');
  });

  emit(dm, 'initiativeReset', {});
  await waitFor(() => room.initiative.entries.length === 0, 'сброс боя перед длительностями');
  emit(dm, 'initiativeAdd', { kind: 'token', refId: condToken.id, name: 'Огр', modifier: 0 });
  const condEntry = await waitFor(
    () => room.initiative.entries.find((entry) => entry.refId === condToken.id),
    'Огр в порядке боя'
  );
  p2.log.tokenUpdated.length = 0;
  emit(dm, 'initiativeTurn', { id: condEntry.id });
  await waitFor(
    () => (room.tokens.find((item) => item.id === condToken.id).conditionDurations || {}).prone === 2,
    'уменьшение длительности в начале хода'
  );
  check('длительность уменьшается в начале хода и уходит игроку', () => {
    const seen = p2.log.tokenUpdated.find((item) => item.id === condToken.id);
    assert(seen, 'игрок не получил новую длительность');
    assert.strictEqual(seen.conditionDurations.prone, 2);
    assert.strictEqual(seen.conditionDurations.poisoned, 98);
  });

  emit(dm, 'initiativeStep', { dir: 1 });
  await waitFor(
    () => (room.tokens.find((item) => item.id === condToken.id).conditionDurations || {}).prone === 1,
    'второй ход уменьшил длительность'
  );
  emit(dm, 'initiativeStep', { dir: 1 });
  await waitFor(
    () => !room.tokens.find((item) => item.id === condToken.id).conditions.includes('prone'),
    'истёкшее состояние снято'
  );
  check('состояние снимается, когда раунды кончились', () => {
    const stored = room.tokens.find((item) => item.id === condToken.id);
    assert.deepStrictEqual(stored.conditions, ['poisoned']);
    assert.strictEqual(stored.conditionDurations.poisoned, 96);
  });

  emit(dm, 'setTokenConditions', {
    tokenId: condToken.id,
    conditions: ['prone', 'poisoned'],
    conditionDurations: { prone: 1, poisoned: 1 }
  });
  await waitFor(
    () => room.tokens.find((item) => item.id === condToken.id).conditions.length === 2,
    'два состояния перед истечением'
  );
  emit(dm, 'initiativeStep', { dir: 1 });
  await waitFor(
    () => room.tokens.find((item) => item.id === condToken.id).conditions.length === 0,
    'оба состояния истекли'
  );
  check('два истёкших состояния снимаются вместе', () => {
    const stored = room.tokens.find((item) => item.id === condToken.id);
    assert.deepStrictEqual(stored.conditions, []);
    assert.deepStrictEqual(stored.conditionDurations, {});
  });

  emit(dm, 'initiativeReset', {});
  await waitFor(() => room.initiative.entries.length === 0, 'сброс боя после длительностей');
  emit(dm, 'setTokenConditions', { tokenId: condToken.id, conditions: [] });
  await waitFor(
    () => room.tokens.find((item) => item.id === condToken.id).conditions.length === 0,
    'состояния после проверки длительностей'
  );

  emit(dm, 'deleteToken', { tokenId: condToken.id });
  await waitFor(() => !room.tokens.some((item) => item.id === condToken.id), 'уборка фишки состояний');

  // Фишка под состояние назначена игроку: без этого проверка запрета была бы
  // проверкой владения фишкой, а не самого состояния.
  dm.log.tokenCreated.length = 0;
  p2.log.tokenCreated.length = 0;
  emit(dm, 'createToken', { name: 'Пленник', mapType: 'world' });
  const bound = await waitFor(
    () => dm.log.tokenCreated.find((item) => item.name === 'Пленник'),
    'фишка под состояние'
  );
  emit(dm, 'setTokenHidden', { tokenId: bound.id, hidden: false });
  emit(dm, 'assignTokenToPlayer', { tokenId: bound.id, playerId: P2 });
  await waitFor(() => p2.log.tokenCreated.find((item) => item.id === bound.id), 'фишка дошла до игрока');
  emit(dm, 'setTokenConditions', { tokenId: bound.id, conditions: ['restrained'] });
  await waitFor(
    () => (room.tokens.find((item) => item.id === bound.id) || {}).conditions.includes('restrained'),
    'состояние «опутан» задано'
  );

  p2.log.errorMessage.length = 0;
  p2.log.tokenMoved.length = 0;
  emit(p2, 'moveToken', { tokenId: bound.id, x: 0.2, y: 0.2 });
  await waitFor(() => p2.log.errorMessage.length > 0, 'отказ по состоянию');
  check('опутанного игрок не двигает сам', () => {
    const stored = room.tokens.find((item) => item.id === bound.id);
    assert.strictEqual(stored.x, 0.5);
    assert.strictEqual(stored.y, 0.5);
    assert.strictEqual(p2.log.tokenMoved.length, 0, 'движение всё же ушло');
    assert.ok(
      p2.log.errorMessage.some((item) => /опутан/.test(item.message)),
      p2.log.errorMessage.map((item) => item.message).join('; ')
    );
  });

  emit(dm, 'moveToken', { tokenId: bound.id, x: 0.3, y: 0.7 });
  await waitFor(() => room.tokens.find((item) => item.id === bound.id).x === 0.3, 'мастер двигает связанную фишку');
  check('мастер связанную фишку двигает: перетащить соперника можно и нужно', () => {
    assert.strictEqual(room.tokens.find((item) => item.id === bound.id).y, 0.7);
  });

  emit(dm, 'setTokenConditions', { tokenId: bound.id, conditions: [] });
  await waitFor(
    () => room.tokens.find((item) => item.id === bound.id).conditions.length === 0,
    'состояние снято'
  );
  p2.log.errorMessage.length = 0;
  p2.log.tokenMoved.length = 0;
  emit(p2, 'moveToken', { tokenId: bound.id, x: 0.6, y: 0.6 });
  await waitFor(() => p2.log.tokenMoved.length > 0, 'фишка снова едет');
  check('состояние сняли — фишка снова едет', () => {
    assert.strictEqual(p2.log.tokenMoved[0].x, 0.6);
  });

  dm.log.tokenUpdated.length = 0;
  emit(dm, 'setTokenLabelsHidden', { tokenId: bound.id, hidden: true });
  await waitFor(
    () => dm.log.tokenUpdated.find((item) => item.id === bound.id && item.hideLabels),
    'подписи скрыты'
  );
  check('подписи скрываются у всех сразу, а не как тайна от игроков', () => {
    const forDm = room.snapshotFor({ playerId: 'dm', role: ROLE_DM }).tokens
      .find((item) => item.id === bound.id);
    const forPlayer = room.snapshotFor({ playerId: P2, role: 'player' }).tokens
      .find((item) => item.id === bound.id);
    assert.strictEqual(forDm.hideLabels, true, 'у мастера подписи остались');
    assert.strictEqual(forPlayer.hideLabels, true, 'игрок подписи всё видит');
  });
  check('скрытые подписи переживают кампанию', () => {
    const saved = new RoomState({ state: room.serialize() }).tokens
      .find((item) => item.id === bound.id);
    assert.strictEqual(saved.hideLabels, true);
  });
  p2.log.errorMessage.length = 0;
  emit(p2, 'setTokenLabelsHidden', { tokenId: bound.id, hidden: false });
  await waitFor(() => p2.log.errorMessage.some((item) => /только ДМ/.test(item.message)), 'игрок не решает подписи');

  // Длительность в часах: часы стола двигает мастер, и «на час» должно
  // истечь вместе с ними, не дожидаясь раундов боя. Фишка отдельная: «Огр»
  // к этому месту уже убран.
  emit(dm, 'createToken', { name: 'Часовой', mapType: 'world' });
  const clockToken = await waitFor(
    () => dm.log.tokenCreated.find((item) => item.name === 'Часовой'),
    'фишка для часов'
  );
  emit(dm, 'setTokenHidden', { tokenId: clockToken.id, hidden: false });
  await waitFor(() => p2.log.tokenCreated.find((item) => item.id === clockToken.id), 'часовая фишка видна игроку');
  emit(dm, 'setTokenConditions', {
    tokenId: clockToken.id,
    conditions: ['poisoned', 'prone'],
    conditionDurations: { poisoned: 2, prone: 3 },
    conditionDurationUnits: { poisoned: 'hour', prone: 'round' }
  });
  await waitFor(
    () => {
      const item = room.tokens.find((entry) => entry.id === clockToken.id);
      return item && item.conditionDurationUnits && item.conditionDurationUnits.poisoned === 'hour';
    },
    'состояние на час'
  );
  const hourStart = { ...room.gameTime };
  emit(dm, 'setGameTime', { day: hourStart.day, hour: hourStart.hour + 1 });
  await waitFor(
    () => {
      const item = room.tokens.find((entry) => entry.id === clockToken.id);
      return item && item.conditionDurations && item.conditionDurations.poisoned === 1;
    },
    'час прошёл'
  );
  check('часы стола уменьшают длительность в часах, а раунды не трогают', () => {
    const stored = room.tokens.find((item) => item.id === clockToken.id);
    assert.strictEqual(stored.conditionDurations.poisoned, 1);
    assert.strictEqual(stored.conditionDurations.prone, 3, 'раунды сдвинулись от часов');
  });
  const secondHour = { ...room.gameTime };
  emit(dm, 'setGameTime', { day: secondHour.day, hour: secondHour.hour + 2 });
  await waitFor(
    () => !room.tokens.find((item) => item.id === clockToken.id).conditions.includes('poisoned'),
    'часовое состояние истекло'
  );
  check('состояние на час снимается, когда время ушло вперёд', () => {
    const stored = room.tokens.find((item) => item.id === clockToken.id);
    assert.ok(!stored.conditions.includes('poisoned'));
    assert.ok(stored.conditions.includes('prone'), 'раундовое состояние снялось вместе с часовым');
    assert.ok(!stored.conditionDurationUnits.poisoned);
  });

  // Аура: круг в футах, который едет вместе с фишкой.
  p2.log.errorMessage.length = 0;
  emit(p2, 'setTokenAura', { tokenId: clockToken.id, feet: 20, color: '#ff0000' });
  await waitFor(() => p2.log.errorMessage.length > 0, 'игрок пробовал задать ауру');
  check('ауру фишки задаёт только мастер', () => {
    assert.ok(p2.log.errorMessage.some((item) => /только ДМ/.test(item.message)));
    assert.ok(!room.tokens.find((item) => item.id === clockToken.id).aura);
  });
  dm.log.tokenUpdated.length = 0;
  emit(dm, 'setTokenAura', { tokenId: clockToken.id, feet: 20, color: '#ff0000' });
  await waitFor(
    () => dm.log.tokenUpdated.find((item) => item.id === clockToken.id && item.aura && item.aura.feet === 20),
    'аура задана'
  );
  check('аура видна всем и переживает сохранение', () => {
    const forPlayer = room.snapshotFor({ playerId: P2, role: 'player' }).tokens
      .find((item) => item.id === clockToken.id);
    assert.strictEqual(forPlayer.aura.feet, 20);
    assert.strictEqual(forPlayer.aura.color, '#ff0000');
    const saved = new RoomState({ state: room.serialize() }).tokens
      .find((item) => item.id === clockToken.id);
    assert.strictEqual(saved.aura.feet, 20);
  });
  emit(dm, 'setTokenAura', { tokenId: clockToken.id, feet: 0 });
  await waitFor(
    () => !room.tokens.find((item) => item.id === clockToken.id).aura,
    'аура снята'
  );
  check('нулевая аура снимается совсем, а не остаётся кругом', () => {
    assert.ok(!room.tokens.find((item) => item.id === clockToken.id).aura);
  });

  emit(dm, 'deleteToken', { tokenId: clockToken.id });
  await waitFor(() => !room.tokens.some((item) => item.id === clockToken.id), 'уборка часовой фишки');

  emit(dm, 'deleteToken', { tokenId: bound.id });
  await waitFor(() => !room.tokens.some((item) => item.id === bound.id), 'уборка фишки состояний');

  /* ------------------------------------------------------ порядок боя */  /* ------------------------------------------------------ порядок боя */  /* ------------------------------------------------------ порядок боя */

  console.log('\nПорядок боя');
  p2.log.errorMessage.length = 0;
  emit(dm, 'initiativeAdd', { kind: 'player', refId: 'p-test-0001', name: 'Артём', modifier: 3 });
  emit(dm, 'initiativeAdd', { kind: 'player', refId: P2, name: 'Борис', modifier: 1 });
  emit(dm, 'initiativeAdd', { kind: 'other', name: 'Гоблин', modifier: 2 });
  await waitFor(() => room.initiative.entries.length === 3, 'участники боя');

  // Режим боя проверяем до броска инициативы: включение при броске само по себе
  // отдельная проверка ниже.
  const combatEvents = [];
  const collectCombat = (state) => combatEvents.push(state);
  dm.on('combatMode', collectCombat);
  p2.on('combatMode', collectCombat);
  p1.log.errorMessage.length = 0;
  emit(p1, 'setCombatMode', { enabled: true });
  await waitFor(() => p1.log.errorMessage.some((item) => /только ДМ/.test(item.message)), 'игрок не включает бой');
  emit(dm, 'setCombatMode', { enabled: true });
  await waitFor(() => combatEvents.length >= 2, 'режим боя у участников');
  check('режим боя включает мастер, и видят его все', () => {
    assert.strictEqual(room.combat.enabled, true);
    assert.strictEqual(combatEvents[combatEvents.length - 1].enabled, true);
    assert.strictEqual(room.snapshotFor({ playerId: P1, role: 'player' }).combat.enabled, true);
  });
  const combatCount = combatEvents.length;
  const combatChatMark = room.chatHistory.length;
  emit(dm, 'setCombatMode', { enabled: false });
  await waitFor(() => combatEvents.length > combatCount, 'выключение режима боя');
  check('режим боя выключается тем же переключателем', () => {
    assert.strictEqual(room.combat.enabled, false);
    assert.strictEqual(combatEvents[combatEvents.length - 1].enabled, false);
  });
  check('переключение режима боя объявляется в чате', () => {
    // Режим боя меняет на экране только надпись на кнопке. Без объявления
    // нажатие выглядит так, будто ничего не произошло, и по нему же видно,
    // дошло ли нажатие до сервера.
    const notices = room.chatHistory.slice(combatChatMark).filter((item) => item.system);
    assert.strictEqual(notices.length, 1, `объявлений в чате: ${notices.length}`);
    assert(/выключен/.test(notices[0].text), `текст объявления: ${notices[0].text}`);
    assert(!notices[0].isRoll, 'объявление помечено как бросок');
  });

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
  check('бросок инициативы сам включает режим боя', () => {
    assert.strictEqual(room.combat.enabled, true, 'бой не включился после броска');
    assert.ok(combatEvents.length > combatCount, 'участники не узнали о начале боя');
  });
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

  p1.log.chatMessage.length = 0;
  p2.log.chatMessage.length = 0;
  dm.log.chatMessage.length = 0;
  emit(p1, 'chatMessage', { text: 'Сундук с ловушкой', whisper: true });
  const whisper = await waitFor(() => dm.log.chatMessage[0], 'шёпот мастеру');
  await wait(150);
  check('шёпот получает мастер и автор, но не другой игрок', () => {
    assert.strictEqual(whisper.text, 'Сундук с ловушкой');
    assert.strictEqual(whisper.whisper, true);
    assert.strictEqual(p1.log.chatMessage.length, 1);
    assert.strictEqual(p2.log.chatMessage.length, 0);
  });
  check('шёпот не попадает в снимок стола чужому игроку', () => {
    const mine = room.snapshotFor({ playerId: 'p-test-0001', role: ROLE_PLAYER });
    const other = room.snapshotFor({ playerId: 'p-test-0002', role: ROLE_PLAYER });
    assert.ok(mine.chatHistory.some((message) => message.whisper));
    assert.ok(!other.chatHistory.some((message) => message.whisper));
  });

  // Шёпот мастера игроку: раньше мастер не мог выбрать адресата.
  p1.log.chatMessage.length = 0;
  p2.log.chatMessage.length = 0;
  dm.log.chatMessage.length = 0;
  emit(dm, 'chatMessage', { text: 'Только для тебя', to: P2 });
  const dmWhisper = await waitFor(() => p2.log.chatMessage[0], 'шёпот мастера игроку');
  await wait(100);
  check('мастер шепчет выбранному игроку, а не всему столу', () => {
    assert.strictEqual(dmWhisper.text, 'Только для тебя');
    assert.strictEqual(dmWhisper.whisper, true);
    assert.strictEqual(dmWhisper.to, P2);
    assert.strictEqual(p1.log.chatMessage.length, 0, 'шёпот ушёл чужому игроку');
    assert.ok(dm.log.chatMessage.some((message) => message.text === 'Только для тебя'), 'автор не увидел свой шёпот');
  });
  check('шёпот мастера видит адресат после переподключения, а не сосед', () => {
    const mine = room.snapshotFor({ playerId: P2, role: ROLE_PLAYER });
    const other = room.snapshotFor({ playerId: P1, role: ROLE_PLAYER });
    assert.ok(mine.chatHistory.some((message) => message.text === 'Только для тебя'));
    assert.ok(!other.chatHistory.some((message) => message.text === 'Только для тебя'));
  });

  // Правка сообщения: опечатку исправляет мастер, игрок — нет.
  p1.log.chatMessage.length = 0;
  emit(dm, 'chatMessage', { text: 'Опечатка в тайне' });
  const editTarget = await waitFor(
    () => p1.log.chatMessage.find((message) => message.text === 'Опечатка в тайне'),
    'сообщение для правки'
  );
  p1.log.errorMessage.length = 0;
  const deniedEdit = await new Promise((resolve) => {
    p1.emit('editChatMessage', { id: editTarget.id, text: 'Игрок исправил' }, resolve);
  });
  check('сообщение чата правит только мастер', () => {
    assert.strictEqual(deniedEdit.ok, false);
    assert.match(deniedEdit.error, /только ДМ/);
    assert.strictEqual(
      room.chatHistory.find((message) => message.id === editTarget.id).text,
      'Опечатка в тайне'
    );
  });
  p1.log.chatEdited.length = 0;
  const editAck = await new Promise((resolve) => {
    dm.emit('editChatMessage', { id: editTarget.id, text: 'Исправленная тайна' }, resolve);
  });
  const editedEvent = await waitFor(
    () => p1.log.chatEdited.find((item) => item.id === editTarget.id),
    'правка сообщения дошла до игрока'
  );
  check('мастер исправляет сообщение, и пометка видна всем', () => {
    assert.strictEqual(editAck.ok, true);
    assert.strictEqual(editedEvent.text, 'Исправленная тайна');
    assert.ok(editedEvent.editedAt, 'нет времени правки');
    assert.strictEqual(
      room.chatHistory.find((message) => message.id === editTarget.id).text,
      'Исправленная тайна'
    );
  });

  // Шёпот после правки не должен утечь соседу.
  p2.log.chatMessage.length = 0;
  emit(dm, 'chatMessage', { text: 'Шёпот для правки', to: P2 });
  const whisperToEdit = await waitFor(
    () => p2.log.chatMessage.find((message) => message.text === 'Шёпот для правки'),
    'шёпот для правки'
  );
  p1.log.chatEdited.length = 0;
  p2.log.chatEdited.length = 0;
  await new Promise((resolve) => {
    dm.emit('editChatMessage', { id: whisperToEdit.id, text: 'Шёпот исправлен' }, resolve);
  });
  await waitFor(() => p2.log.chatEdited.some((item) => item.id === whisperToEdit.id), 'правка шёпота');
  await wait(100);
  check('правка шёпота не утекает чужому игроку', () => {
    assert.strictEqual(p1.log.chatEdited.length, 0, 'чужой игрок получил правку шёпота');
    assert.strictEqual(
      room.chatHistory.find((message) => message.id === whisperToEdit.id).text,
      'Шёпот исправлен'
    );
  });

  // Удаление сообщения: мастер чистит ленту, игрок — нет.
  p1.log.chatMessage.length = 0;
  emit(dm, 'chatMessage', { text: 'Случайно раскрытая тайна' });
  const secretMessage = await waitFor(
    () => p1.log.chatMessage.find((message) => message.text === 'Случайно раскрытая тайна'),
    'сообщение для удаления'
  );
  assert.ok(secretMessage.id, 'у нового сообщения нет id');
  p1.log.errorMessage.length = 0;
  emit(p1, 'deleteChatMessage', { id: secretMessage.id });
  await waitFor(() => p1.log.errorMessage.length > 0, 'игрок пробовал удалить сообщение');
  check('сообщение чата удаляет только мастер', () => {
    assert.ok(p1.log.errorMessage.some((item) => /только ДМ/.test(item.message)));
    assert.ok(room.chatHistory.some((message) => message.id === secretMessage.id));
  });

  p1.log.chatDeleted.length = 0;
  emit(dm, 'deleteChatMessage', { id: secretMessage.id });
  await waitFor(() => p1.log.chatDeleted.some((item) => item.id === secretMessage.id), 'удаление сообщения');
  check('мастер удаляет одно сообщение, и оно исчезает у всех', () => {
    assert.ok(!room.chatHistory.some((message) => message.id === secretMessage.id));
    assert.ok(!room.snapshotFor({ playerId: P1, role: ROLE_PLAYER }).chatHistory
      .some((message) => message.id === secretMessage.id));
  });

  p1.log.chatCleared.length = 0;
  emit(p1, 'clearChat', {});
  await wait(100);
  check('очистить чат может только мастер', () => {
    assert.ok(room.chatHistory.length > 0, 'игрок очистил историю');
    assert.strictEqual(p1.log.chatCleared.length, 0);
  });

  emit(dm, 'clearChat', {});
  await waitFor(() => p1.log.chatCleared.length === 1, 'очистка чата');
  check('мастер очищает ленту у всех', () => {
    assert.strictEqual(room.chatHistory.length, 0);
    assert.strictEqual(room.snapshotFor({ playerId: P1, role: ROLE_PLAYER }).chatHistory.length, 0);
  });
  // Оставляем в ленте все три вида сообщений: ниже проверяется, что история
  // переживает перезапуск, и пустая лента делала бы эту проверку бессмысленной.
  emit(dm, 'chatMessage', { text: 'Привет, стол!' });
  emit(dm, 'rollDice', { formula: 'd20' });
  emit(dm, 'chatImage', { image: PNG_1PX, text: 'Хендаут после очистки' });
  await waitFor(
    () => room.chatHistory.some((message) => message.isRoll)
      && room.chatHistory.some((message) => message.text === 'Привет, стол!')
      && room.chatHistory.some((message) => message.image),
    'сообщения после очистки'
  );

  p1.log.errorMessage.length = 0;
  p2.log.chatMessage.length = 0;
  emit(p1, 'chatImage', { image: PNG_1PX, text: 'Игроку нельзя' });
  const deniedImage = await waitFor(
    () => p1.log.errorMessage.find((item) => /только ДМ/.test(item.message)),
    'отказ игроку на картинку'
  );
  check('картинку в чат отправляет только мастер', () => {
    assert.match(deniedImage.message, /только ДМ/);
    assert.strictEqual(p2.log.chatMessage.length, 0);
  });

  p2.log.chatMessage.length = 0;
  dm.log.chatMessage.length = 0;
  emit(dm, 'chatImage', { image: PNG_1PX, text: 'Письмо от барона' });
  const handout = await waitFor(() => p2.log.chatMessage[0], 'картинка-хендаут в чате');
  const handoutFile = path.basename(handout.image || '');
  const handoutResponse = await httpGet(`${url}${handout.image}`);
  check('мастер отправляет картинку, файл лежит в кампании и раздаётся', () => {
    assert.strictEqual(handout.role, 'dm');
    assert.strictEqual(handout.text, 'Письмо от барона');
    assert.match(handout.image, /^\/files\/[A-Za-z0-9_.-]+$/);
    assert.ok(fs.existsSync(path.join(root, 'campaigns', campaign.id, 'files', handoutFile)), 'файла нет');
    assert.strictEqual(handoutResponse.status, 200);
    assert.ok(handoutResponse.body.length > 8, 'пустой ответ файла');
  });
  const dmHandout = await waitFor(
    () => dm.log.chatMessage.find((message) => message.image === handout.image),
    'картинка у мастера'
  );
  check('картинку-хендаут видит и сам мастер', () => {
    assert.ok(dmHandout);
  });

  p1.log.chatMessage.length = 0;
  p2.log.chatMessage.length = 0;
  dm.log.chatMessage.length = 0;
  emit(dm, 'chatImage', { image: PNG_1PX, text: 'Только тебе', to: P2 });
  const privateHandout = await waitFor(
    () => p2.log.chatMessage.find((message) => message.image && message.whisper),
    'картинка одному игроку'
  );
  await wait(100);
  check('картинку можно отдать одному игроку', () => {
    assert.strictEqual(privateHandout.to, P2);
    assert.strictEqual(privateHandout.toName, room.players.get(P2).name);
    assert.strictEqual(p1.log.chatMessage.filter((message) => message.image).length, 0,
      'картинка утекла второму игроку');
    assert.ok(dm.log.chatMessage.some((message) => message.image === privateHandout.image),
      'мастер не увидел свою картинку');
    const first = room.snapshotFor({ playerId: P1, role: ROLE_PLAYER });
    const second = room.snapshotFor({ playerId: P2, role: ROLE_PLAYER });
    assert.ok(!first.chatHistory.some((message) => message.id === privateHandout.id));
    assert.ok(second.chatHistory.some((message) => message.id === privateHandout.id));
  });

  const { ack: longJoin } = await open({ name: 'Я'.repeat(120), playerId: 'p-long' });
  check('слишком длинное имя обрезается до 40 символов', () => {
    assert.strictEqual(longJoin.you.name.length, 40);
  });

  const journalText = 'Журнал мастера: сожжённая мельница, долг барона и тайник под мостом.';
  p1.log.errorMessage.length = 0;
  emit(p1, 'saveJournal', { text: 'Игроку нельзя' });
  const deniedJournal = await waitFor(
    () => p1.log.errorMessage.find((item) => /только ДМ/.test(item.message)),
    'отказ игроку на журнал'
  );
  check('журнал кампании правит только мастер', () => {
    assert.match(deniedJournal.message, /только ДМ/);
    assert.strictEqual(room.journal, '');
  });

  emit(dm, 'saveJournal', { text: journalText });
  await waitFor(() => room.journal === journalText, 'сохранение журнала мастером');
  check('журнал виден мастеру и скрыт от игрока', () => {
    assert.strictEqual(room.snapshotFor({ playerId: 'dm', role: ROLE_DM }).journal, journalText);
    assert.strictEqual(room.snapshotFor({ playerId: 'p-test-0001', role: ROLE_PLAYER }).journal, '');
  });

  // Перезапись свободного журнала: отмена должна вернуть прежний текст.
  const dirtyBeforeJournalText = dirtyCount;
  emit(dm, 'saveJournal', { text: 'Черновик перед отменой' });
  await waitFor(() => room.journal === 'Черновик перед отменой', 'перезапись журнала');
  check('перезапись журнала помечает кампанию грязной', () => {
    assert.ok(dirtyCount > dirtyBeforeJournalText, `dirtyCount=${dirtyCount}`);
  });
  await new Promise((resolve) => dm.emit('undoDmAction', {}, resolve));
  await waitFor(() => room.journal === journalText, 'отмена перезаписи журнала');
  check('перезапись журнала отменяется', () => {
    assert.strictEqual(room.journal, journalText);
  });

  const dirtyBeforeJournalEntry = dirtyCount;
  const journalEntry = await new Promise((resolve) => {
    dm.emit('saveJournalEntry', {
      kind: 'location',
      title: 'Старый мост',
      text: 'Под мостом тайник с долговой распиской.',
      tags: ['мост', 'тайник', 'мост']
    }, resolve);
  });
  await waitFor(() => room.journalEntries.length === 1, 'запись журнала мастера');
  check('мастер создаёт структурированную запись журнала', () => {
    assert.strictEqual(journalEntry.ok, true);
    assert.strictEqual(journalEntry.entry.kind, 'location');
    assert.strictEqual(journalEntry.entry.title, 'Старый мост');
    assert.deepStrictEqual(journalEntry.entry.tags, ['мост', 'тайник']);
    assert.ok(journalEntry.entry.id.startsWith('j-'));
  });
  check('запись журнала помечает кампанию грязной для автосохранения', () => {
    assert.ok(dirtyCount > dirtyBeforeJournalEntry, `dirtyCount=${dirtyCount}`);
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'saveJournalEntry', { kind: 'quest', title: 'Игроку нельзя' });
  const deniedEntry = await waitFor(
    () => p1.log.errorMessage.find((item) => /только ДМ/.test(item.message)),
    'отказ игроку на запись журнала'
  );
  check('запись журнала создаёт только мастер', () => {
    assert.match(deniedEntry.message, /только ДМ/);
    assert.strictEqual(room.journalEntries.length, 1);
  });

  const requestedJournal = await new Promise((resolve) => {
    dm.once('journalUpdated', resolve);
    dm.emit('journalRequest');
  });
  check('journalRequest отдаёт мастеру записи журнала', () => {
    assert.strictEqual(requestedJournal.length, 1);
    assert.strictEqual(requestedJournal[0].title, 'Старый мост');
  });

  const playerJournalBefore = p1.log.journalUpdated.length;
  emit(p1, 'journalRequest');
  await wait(120);
  check('journalRequest игроку не отдаёт скрытую запись', () => {
    assert.strictEqual(p1.log.journalUpdated.length, playerJournalBefore + 1);
    assert.strictEqual(p1.log.journalUpdated[p1.log.journalUpdated.length - 1].length, 0);
  });

  check('скрытая запись не попадает в снимок игрока', () => {
    assert.strictEqual(
      room.snapshotFor({ playerId: 'dm', role: ROLE_DM }).journalEntries.length, 1);
    assert.strictEqual(
      room.snapshotFor({ playerId: 'p-test-0001', role: ROLE_PLAYER }).journalEntries.length, 0);
  });

  // Мастер отмечает запись «показать игрокам»: она уходит и в запрос, и в
  // снимок, а скрытые записи по-прежнему не утекают.
  await new Promise((resolve) => dm.emit('saveJournalEntry', {
    id: journalEntry.entry.id,
    kind: 'location',
    title: 'Старый мост',
    text: 'Под мостом тайник.',
    tags: ['мост'],
    visible: true
  }, resolve));
  await waitFor(() => room.journalEntries[0].visible === true, 'запись показана игрокам');
  const visibleJournal = await new Promise((resolve) => {
    p1.once('journalUpdated', resolve);
    p1.emit('journalRequest');
  });
  check('journalRequest игроку отдаёт показанную запись', () => {
    assert.strictEqual(visibleJournal.length, 1);
    assert.strictEqual(visibleJournal[0].title, 'Старый мост');
    assert.strictEqual(
      room.snapshotFor({ playerId: 'p-test-0001', role: ROLE_PLAYER }).journalEntries.length, 1);
    assert.strictEqual(
      room.snapshotFor({ playerId: 'dm', role: ROLE_DM }).journalEntries.length, 1);
  });

  await new Promise((resolve) => {
    dm.emit('deleteJournalEntry', { id: journalEntry.entry.id }, resolve);
  });
  await waitFor(() => room.journalEntries.length === 0, 'удаление записи журнала');
  check('мастер удаляет запись журнала', () => {
    assert.strictEqual(room.journalEntries.length, 0);
  });

  // Удаление записи — самое дорогое действие в журнале, и отмена должна
  // возвращать её целиком, а не только сдвинутые фишки.
  dm.log.stateReload.length = 0;
  await new Promise((resolve) => dm.emit('undoDmAction', {}, resolve));
  await waitFor(() => room.journalEntries.length === 1, 'возврат записи журнала отменой');
  check('удаление записи журнала отменяется', () => {
    assert.strictEqual(room.journalEntries[0].title, 'Старый мост');
    assert.strictEqual(
      room.snapshotFor({ playerId: 'dm', role: ROLE_DM }).journalEntries.length, 1,
      'мастер не получил запись обратно');
    assert.ok(dm.log.stateReload.length > 0, 'после отмены не пришёл снимок состояния');
  });

  /* ------------------------------------------ склад, проверки и отмена */

  console.log('\nОбщий склад, просьбы о бросках и отмена');

  p1.log.errorMessage.length = 0;
  const deniedItem = await new Promise((resolve) => {
    p1.emit('saveInventoryItem', { name: 'Игроку нельзя', qty: 1, weight: 0 }, resolve);
  });
  check('предмет на склад кладёт только мастер', () => {
    assert.strictEqual(deniedItem.ok, false);
    assert.match(deniedItem.error, /только ДМ/);
    assert.strictEqual(room.inventory.length, 0);
  });

  p2.log.inventoryUpdated.length = 0;
  const dirtyBeforeItem = dirtyCount;
  const itemAck = await new Promise((resolve) => {
    dm.emit('saveInventoryItem', {
      name: 'Верёвка',
      qty: 2,
      weight: 10,
      ownerId: 'p-test-0001',
      attunement: true,
      notes: 'Лежит в мешке у Артёма'
    }, resolve);
  });
  const itemBroadcast = await waitFor(
    () => p2.log.inventoryUpdated.find((list) => list.length === 1),
    'рассылка склада игрокам'
  );
  check('мастер добавляет предмет, и его видят все', () => {
    assert.strictEqual(itemAck.ok, true);
    assert.strictEqual(itemAck.item.name, 'Верёвка');
    assert.strictEqual(itemAck.item.qty, 2);
    assert.strictEqual(itemAck.item.ownerId, 'p-test-0001');
    assert.strictEqual(itemAck.item.attunement, true);
    assert.strictEqual(itemBroadcast[0].name, 'Верёвка');
    assert.strictEqual(
      room.snapshotFor({ playerId: 'p-test-0001', role: ROLE_PLAYER }).inventory.length, 1);
  });
  check('склад помечает кампанию грязной для автосохранения', () => {
    assert.ok(dirtyCount > dirtyBeforeItem, `dirtyCount=${dirtyCount}`);
  });

  const itemUpdateAck = await new Promise((resolve) => {
    dm.emit('saveInventoryItem', {
      id: itemAck.item.id, name: 'Верёвка', qty: 1, weight: 10, ownerId: '', attunement: false, notes: ''
    }, resolve);
  });
  await waitFor(
    () => room.inventory.length === 1 && room.inventory[0].qty === 1,
    'правка предмета'
  );
  check('предмет правится на месте, а не добавляется вторым', () => {
    assert.strictEqual(itemUpdateAck.ok, true);
    assert.strictEqual(room.inventory.length, 1);
    assert.strictEqual(room.inventory[0].qty, 1);
    assert.strictEqual(room.inventory[0].ownerId, '');
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'deleteInventoryItem', { id: itemAck.item.id });
  const deniedDelete = await waitFor(
    () => p1.log.errorMessage.find((item) => /только ДМ/.test(item.message)),
    'отказ игроку на удаление предмета'
  );
  check('предмет убирает только мастер', () => {
    assert.match(deniedDelete.message, /только ДМ/);
    assert.strictEqual(room.inventory.length, 1);
  });

  // Удаление предмета тоже отменяется: название, количество и владелец
  // возвращаются снимком, а не остаются в чате объявлением.
  await new Promise((resolve) => dm.emit('deleteInventoryItem', { id: itemAck.item.id }, resolve));
  await waitFor(() => room.inventory.length === 0, 'удаление предмета для отмены');
  await new Promise((resolve) => dm.emit('undoDmAction', {}, resolve));
  await waitFor(() => room.inventory.length === 1, 'возврат предмета отменой');
  check('удаление предмета склада отменяется', () => {
    assert.strictEqual(room.inventory[0].name, 'Верёвка');
    assert.strictEqual(room.inventory[0].qty, 1);
  });

  const deniedCoins = await new Promise((resolve) => {
    p1.emit('setInventoryCoins', { coins: { gp: 100 } }, resolve);
  });
  check('монеты склада меняет только мастер', () => {
    assert.strictEqual(deniedCoins.ok, false);
    assert.match(deniedCoins.error, /только ДМ/);
    assert.strictEqual(room.inventoryCoins.gp, 0);
  });

  p2.log.inventoryCoinsUpdated.length = 0;
  const coinsAck = await new Promise((resolve) => {
    dm.emit('setInventoryCoins', { coins: { cp: 5, sp: 7, ep: 1, gp: 42, pp: 2, лишнее: 9 } }, resolve);
  });
  const coinsBroadcast = await waitFor(
    () => p2.log.inventoryCoinsUpdated[0],
    'рассылка монет склада'
  );
  check('мастер задаёт монеты склада, и их видят все', () => {
    assert.strictEqual(coinsAck.ok, true);
    assert.deepStrictEqual(room.inventoryCoins, { cp: 5, sp: 7, ep: 1, gp: 42, pp: 2 });
    assert.deepStrictEqual(coinsBroadcast, { cp: 5, sp: 7, ep: 1, gp: 42, pp: 2 });
    assert.deepStrictEqual(
      room.snapshotFor({ playerId: 'p-test-0001', role: ROLE_PLAYER }).inventoryCoins,
      { cp: 5, sp: 7, ep: 1, gp: 42, pp: 2 });
  });

  const coinOwners = [...room.players.values()]
    .filter((player) => player.role === ROLE_PLAYER && room.sheets.has(player.playerId));
  const splitExpected = Math.floor(42 / coinOwners.length);
  const splitRemainder = 42 - splitExpected * coinOwners.length;
  for (const owner of coinOwners) room.sheets.get(owner.playerId).coins = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  p1.log.characterSheetData.length = 0;
  p2.log.characterSheetData.length = 0;
  p1.log.errorMessage.length = 0;
  const deniedSplit = await new Promise((resolve) => {
    p1.emit('splitInventoryCoins', {}, resolve);
  });
  check('делить монеты склада может только мастер', () => {
    assert.strictEqual(deniedSplit.ok, false);
    assert.match(deniedSplit.error, /только ДМ/);
    assert.strictEqual(room.inventoryCoins.gp, 42, 'игрок всё-таки разделил монеты');
  });

  const splitAck = await new Promise((resolve) => {
    dm.emit('splitInventoryCoins', {}, resolve);
  });
  await waitFor(
    () => p1.log.characterSheetData.some((item) => item.sheet.coins.gp === splitExpected)
      && p2.log.characterSheetData.some((item) => item.sheet.coins.gp === splitExpected),
    'листы после дележа монет'
  );
  check('монеты склада делятся поровну, а остаток остаётся в складе', () => {
    assert.strictEqual(splitAck.ok, true);
    assert.strictEqual(splitAck.shares.gp, splitExpected);
    assert.strictEqual(room.inventoryCoins.gp, splitRemainder);
    for (const owner of coinOwners) {
      assert.strictEqual(room.sheets.get(owner.playerId).coins.gp, splitExpected,
        `игрок ${owner.name} не получил долю`);
    }
    assert.ok(
      p1.log.characterSheetData.some((item) => item.playerId === 'p-test-0001'
        && item.sheet.coins.gp === splitExpected),
      `лист первого игрока не обновился: ожидали ${splitExpected}, события ${JSON.stringify(
        p1.log.characterSheetData.map((item) => [item.playerId, item.sheet.coins.gp]))}`
    );
    assert.ok(
      p2.log.characterSheetData.some((item) => item.playerId === 'p-test-0002'
        && item.sheet.coins.gp === splitExpected),
      'лист второго игрока не обновился'
    );
  });

  // Перевод монет со склада в один лист, а не деление поровну.
  room.setInventoryCoins({ gp: 10 });
  room.sheets.get('p-test-0001').coins.gp = 1;
  p1.log.characterSheetData.length = 0;
  const giveAck = await new Promise((resolve) => {
    dm.emit('giveInventoryCoins', { playerId: 'p-test-0001', coin: 'gp', amount: 5 }, resolve);
  });
  await waitFor(
    () => p1.log.characterSheetData.find((item) => item.playerId === 'p-test-0001'
      && item.sheet.coins.gp === 6),
    'лист после выдачи монет'
  );
  check('монеты со склада можно выдать одному игроку', () => {
    assert.strictEqual(giveAck.ok, true);
    assert.strictEqual(giveAck.moved, 5);
    assert.strictEqual(room.inventoryCoins.gp, 5);
    assert.strictEqual(room.sheets.get('p-test-0001').coins.gp, 6);
  });
  p1.log.errorMessage.length = 0;
  const deniedGive = await new Promise((resolve) => {
    p1.emit('giveInventoryCoins', { playerId: 'p-test-0001', coin: 'gp', amount: 1 }, resolve);
  });
  check('выдавать монеты может только мастер', () => {
    assert.strictEqual(deniedGive.ok, false);
    assert.match(deniedGive.error, /только ДМ/);
    assert.strictEqual(room.inventoryCoins.gp, 5);
  });

  p1.log.errorMessage.length = 0;
  const deniedRequest = await new Promise((resolve) => {
    p1.emit('rollRequest', { label: 'Игроку нельзя' }, resolve);
  });
  check('попросить бросок может только мастер', () => {
    assert.strictEqual(deniedRequest.ok, false);
    assert.match(deniedRequest.error, /только ДМ/);
    assert.strictEqual(room.rollRequests.length, 0);
  });

  p2.log.rollRequestUpdated.length = 0;
  const dirtyBeforeRequest = dirtyCount;
  const requestAck = await new Promise((resolve) => {
    dm.emit('rollRequest', { label: 'Скрытность', dc: 15, formula: '1d20+3' }, resolve);
  });
  const requestBroadcast = await waitFor(
    () => p2.log.rollRequestUpdated.find((list) => list.length === 1),
    'рассылка проверки игрокам'
  );
  check('мастер просит бросок, и просьбу видят все', () => {
    assert.strictEqual(requestAck.ok, true);
    assert.strictEqual(requestAck.request.label, 'Скрытность');
    assert.strictEqual(requestAck.request.dc, 15);
    assert.strictEqual(requestAck.request.formula, '1d20+3');
    assert.strictEqual(requestBroadcast[0].label, 'Скрытность');
  });
  check('просьба о броске помечает кампанию грязной', () => {
    assert.ok(dirtyCount > dirtyBeforeRequest, `dirtyCount=${dirtyCount}`);
  });

  const clearAck = await new Promise((resolve) => {
    dm.emit('rollRequestClear', { id: requestAck.request.id }, resolve);
  });
  await waitFor(() => room.rollRequests.length === 0, 'снятие проверки');
  check('мастер снимает проверку', () => {
    assert.strictEqual(clearAck.ok, true);
    assert.strictEqual(room.rollRequests.length, 0);
  });

  const badTarget = await new Promise((resolve) => {
    dm.emit('rollRequest', { label: 'Кому-то', to: 'p-no-such' }, resolve);
  });
  check('проверку нельзя адресовать несуществующему игроку', () => {
    assert.strictEqual(badTarget.ok, false);
    assert.match(badTarget.error, /не найден/);
    assert.strictEqual(room.rollRequests.length, 0);
  });

  p1.log.rollRequestUpdated.length = 0;
  p2.log.rollRequestUpdated.length = 0;
  const targetedAck = await new Promise((resolve) => {
    dm.emit('rollRequest', { label: 'Тайная Воля', dc: 13, formula: '1d20+2', to: P1 }, resolve);
  });
  await waitFor(
    () => p1.log.rollRequestUpdated.find((list) => list.some((item) => item.label === 'Тайная Воля')),
    'скрытая проверка у адресата'
  );
  await wait(100);
  check('скрытую проверку видит только мастер и адресат', () => {
    assert.strictEqual(targetedAck.ok, true);
    assert.strictEqual(targetedAck.request.to, P1);
    assert.strictEqual(targetedAck.request.toName, room.players.get(P1).name);
    assert.ok(
      !p2.log.rollRequestUpdated.some((list) => list.some((item) => item.label === 'Тайная Воля')),
      'заявка утекла второму игроку'
    );
    const first = room.snapshotFor({ playerId: P1, role: ROLE_PLAYER });
    const second = room.snapshotFor({ playerId: P2, role: ROLE_PLAYER });
    assert.ok(first.rollRequests.some((item) => item.label === 'Тайная Воля'), 'адресат не увидел заявку');
    assert.ok(!second.rollRequests.some((item) => item.label === 'Тайная Воля'), 'заявка утекла в снимок');
  });
  await new Promise((resolve) => dm.emit('rollRequestClear', { id: targetedAck.request.id }, resolve));
  await waitFor(() => room.rollRequests.length === 0, 'снятие скрытой проверки');

  // Отмена: двигаем фишку и возвращаем её на прежнее место.
  emit(dm, 'createToken', { name: 'Отменяемая', mapType: 'battle' });
  const undoToken = await waitFor(
    () => room.tokens.find((token) => token.name === 'Отменяемая'),
    'фишка для отмены'
  );
  const startX = undoToken.x;
  const startY = undoToken.y;
  emit(dm, 'moveToken', { tokenId: undoToken.id, x: 0.12, y: 0.34 });
  await waitFor(
    () => room.tokens.find((token) => token.id === undoToken.id).x === 0.12,
    'фишка сдвинута'
  );
  dm.log.stateReload.length = 0;
  const dirtyBeforeUndo = dirtyCount;
  const undoAck = await new Promise((resolve) => {
    dm.emit('undoDmAction', {}, resolve);
  });
  await waitFor(() => dm.log.stateReload.length > 0, 'снимок после отмены');
  check('мастер отменяет ход фишки', () => {
    assert.strictEqual(undoAck.ok, true);
    const restored = room.tokens.find((token) => token.id === undoToken.id);
    assert.strictEqual(restored.x, startX);
    assert.strictEqual(restored.y, startY);
    assert.strictEqual(dm.log.stateReload[dm.log.stateReload.length - 1].tokens
      .find((token) => token.id === undoToken.id).x, startX, 'игроки не получили снимок');
    assert.ok(dirtyCount > dirtyBeforeUndo, 'отмена не попала в автосохранение');
  });

  p1.log.errorMessage.length = 0;
  emit(p1, 'undoDmAction', {});
  const deniedUndo = await waitFor(
    () => p1.log.errorMessage.find((item) => /только ДМ/.test(item.message)),
    'отказ игроку на отмену'
  );
  check('отменять действия мастера может только мастер', () => {
    assert.match(deniedUndo.message, /только ДМ/);
  });

  // Конец хода помечается отдельно: по этому признаку окно мастера считает
  // реакцию, а промежуточные сообщения перетаскивания её не вызывают.
  dm.log.tokenMoved.length = 0;
  const movedBefore = Number(room.tokens.find((token) => token.id === undoToken.id).movedCells) || 0;
  emit(dm, 'moveToken', {
    tokenId: undoToken.id,
    x: 0.44,
    y: 0.55,
    final: true,
    from: { col: 2, row: 3 },
    path: [{ col: 2, row: 3 }, { col: 2, row: 4 }, { col: 3, row: 4 }]
  });
  const finalMove = await waitFor(
    () => dm.log.tokenMoved.find((move) => move.final),
    'конец хода с признаком'
  );
  check('конец хода приходит с признаком и нарисованным путём', () => {
    assert.strictEqual(finalMove.final, true);
    assert.deepStrictEqual(finalMove.from, { col: 2, row: 3 });
    assert.deepStrictEqual(finalMove.path, [
      { col: 2, row: 3 }, { col: 2, row: 4 }, { col: 3, row: 4 }
    ], `путь потерялся: ${JSON.stringify(finalMove.path)}`);
    assert.strictEqual(finalMove.spent, 2, 'пройденные клетки не посчитаны');
    assert.strictEqual(finalMove.movedCells, movedBefore + 2, 'счётчик движения не вырос');
  });

  room.tokens[0].movedCells = 7;
  room.resetMovement();
  check('счётчик движения сбрасывается на новом ходу', () => {
    assert.strictEqual(room.tokens[0].movedCells, 0);
  });

  emit(dm, 'deleteToken', { tokenId: undoToken.id });
  await waitFor(() => !room.tokens.some((token) => token.id === undoToken.id), 'уборка фишки отмены');
  await new Promise((resolve) => {
    dm.emit('deleteInventoryItem', { id: itemAck.item.id }, resolve);
  });
  await waitFor(() => room.inventory.length === 0, 'уборка склада');

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

  const previousName = campaign.name;
  campaign.name = 'Тестовая кампания, переименованная';
  await store.save(campaign);
  check('перед сохранением остаётся предыдущая версия кампании', () => {
    const backup = JSON.parse(fs.readFileSync(
      path.join(root, 'campaigns', campaign.id, 'campaign.json.bak'), 'utf8'
    ));
    assert.strictEqual(backup.name, previousName);
  });
  campaign.name = previousName;
  await store.save(campaign);

  const backupDir = await store.backup(campaign.id, 'Копия');
  check('копия кампании переносит JSON и папку с картинками', () => {
    assert.ok(fs.existsSync(path.join(backupDir, 'campaign.json')), 'в копии нет campaign.json');
    assert.ok(fs.existsSync(path.join(backupDir, 'files')), 'в копии нет папки files');
  });

  const namedBackup = await store.backup(campaign.id, campaign.name);
  const namedCopies = await store.listBackups(campaign.id, campaign.name);
  const namedLast = await store.lastBackupTime(campaign.id, campaign.name);
  check('копии кампании считаются по её имени и знают время последней', () => {
    assert.strictEqual(namedCopies.length, 1, `копий: ${namedCopies.length}`);
    assert.strictEqual(namedCopies[0].path, namedBackup);
    assert.ok(namedLast > 0, `время последней копии: ${namedLast}`);
  });

  // Ротация считается по кампании: шесть копий подряд оставляют пять, а
  // копия с другим именем не вытесняется.
  for (let index = 0; index < 6; index += 1) {
    await store.backup(campaign.id, campaign.name);
  }
  const rotated = await store.listBackups(campaign.id, campaign.name);
  check('у кампании остаются пять последних копий, чужие не трогаются', () => {
    assert.strictEqual(rotated.length, 5, `копий после ротации: ${rotated.length}`);
    assert.ok(fs.existsSync(backupDir), 'копия с другим именем исчезла при ротации');
  });

  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-export-'));
  const exportedDir = await store.exportTo(campaign.id, campaign.name, exportRoot);
  const imported = await store.importFrom(exportedDir);
  check('экспорт в папку и импорт переносят кампанию с картинками', () => {
    assert.ok(fs.existsSync(path.join(exportedDir, 'campaign.json')), 'в экспорте нет campaign.json');
    assert.ok(fs.existsSync(path.join(exportedDir, 'files')), 'в экспорте нет папки files');
    assert.notStrictEqual(imported.id, campaign.id, 'импорт занял чужой идентификатор');
    assert.strictEqual(imported.name, campaign.name);
    const saved = JSON.parse(fs.readFileSync(
      path.join(root, 'campaigns', imported.id, 'campaign.json'), 'utf8'
    ));
    assert.strictEqual(saved.id, imported.id, 'id в файле не совпал с папкой');
  });
  fs.rmSync(exportRoot, { recursive: true, force: true });
  await store.remove(imported.id);

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

  console.log('\nФайлы кампании');

  const foreignDir = path.join(root, 'campaigns', 'foreigncamp1234');
  fs.mkdirSync(path.join(foreignDir, 'files'), { recursive: true });
  fs.writeFileSync(path.join(foreignDir, 'campaign.json'), JSON.stringify({
    id: campaign.id,
    name: 'Чужая',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    state: {}
  }));
  const foreign = await store.load('foreigncamp1234');
  check('кампания с чужим id внутри файла берёт id из папки', () => {
    assert.strictEqual(foreign.id, 'foreigncamp1234');
  });

  const sweepId = 'sweeptest12345';
  fs.mkdirSync(path.join(root, 'campaigns', sweepId, 'files'), { recursive: true });
  const keepName = await store.saveImage(sweepId, Buffer.from('keep'), 'png');
  const dropName = await store.saveImage(sweepId, Buffer.from('drop'), 'png');
  const chatKeepName = await store.saveImage(sweepId, Buffer.from('chat'), 'png');
  const sweepRemoved = await store.sweepFiles(sweepId, {
    maps: { world: { items: [{ url: `/files/${keepName}` }] }, battle: { items: [] }, sketch: { items: [] } },
    tokens: [],
    players: [],
    chatHistory: [{ image: `/files/${chatKeepName}` }],
    adventure: null
  }, { keepMs: 0 });
  check('свалка удаляет файл без ссылок и оставляет нужный', () => {
    assert.strictEqual(sweepRemoved, 1);
    assert.ok(fs.existsSync(path.join(root, 'campaigns', sweepId, 'files', keepName)));
    assert.ok(fs.existsSync(path.join(root, 'campaigns', sweepId, 'files', chatKeepName)),
      'картинка из чата удалена как мусор');
    assert.ok(!fs.existsSync(path.join(root, 'campaigns', sweepId, 'files', dropName)));
  });

  const quotaStore = new CampaignStore(path.join(root, 'quota-campaigns'), { maxFilesBytes: 32 });
  const quotaCampaign = await quotaStore.create('Квота');
  await quotaStore.saveImage(quotaCampaign.id, Buffer.alloc(20), 'png');
  let quotaThrown = null;
  try {
    await quotaStore.saveImage(quotaCampaign.id, Buffer.alloc(20), 'png');
  } catch (error) {
    quotaThrown = error;
  }
  check('квота папки files не даёт кампании расти без предела', () => {
    assert.ok(quotaThrown && quotaThrown.quota === true, 'ожидалась ошибка квоты');
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
    assert.strictEqual(restored.activeMapId, worldMap.items[0].id);
    assert.strictEqual(
      restored.maps.battle.items.every((item) => item.published === false),
      true,
      'заготовки должны остаться заготовками'
    );
  });
  check('сетка стола восстанавливается вместе с кампанией', () => {
    assert.strictEqual(restored.grid.enabled, true);
    assert.strictEqual(restored.grid.cell, 56);
  });
  check('история бросков и чата сохраняется', () => {
    assert.ok(restored.diceHistory.length > 0, 'нет истории бросков');
    assert.ok(restored.chatHistory.some((message) => message.isRoll), 'нет объявления броска в чате');
    assert.ok(restored.chatHistory.some((message) => message.text === 'Привет, стол!'), 'нет обычного сообщения');
    assert.ok(
      restored.chatHistory.some((message) => message.image && /^\/files\//.test(message.image)),
      'нет картинки-хендаута в чате'
    );
    assert.strictEqual(restored.journal, journalText, 'журнал мастера не пережил загрузку');
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
    for (const field of ['players', 'sheets', 'maps', 'activeMap', 'activeMapId', 'tokens']) {
      assert.ok(raw.state[field] !== undefined, `нет state.${field}`);
    }
  });

  /* ------------------------------------------- восстановление из копии */

  console.log('\nВосстановление из копии');
  const restoreMarker = path.join(root, 'campaigns', campaign.id, 'restore-marker.txt');
  fs.writeFileSync(restoreMarker, 'это состояние должно исчезнуть');
  const restoreSource = rotated[0];
  await store.restoreBackup(campaign.id, restoreSource.name);
  check('копия возвращается на место кампании', () => {
    assert.ok(!fs.existsSync(restoreMarker), 'старое состояние осталось после восстановления');
    assert.ok(fs.existsSync(path.join(root, 'campaigns', campaign.id, 'campaign.json')),
      'в восстановленной кампании нет campaign.json');
  });
  const afterRestore = await store.load(campaign.id);
  check('восстановленная кампания читается', () => {
    assert.strictEqual(afterRestore.id, campaign.id);
    assert.ok(afterRestore.state && afterRestore.state.tokens, 'в копии нет состояния');
  });

  let restoreTraversal = null;
  try {
    await store.restoreBackup(campaign.id, '../campaigns/evil');
  } catch (error) {
    restoreTraversal = error;
  }
  check('восстановление не выходит за папку копий', () => {
    assert.ok(restoreTraversal && /Некорректное имя/.test(restoreTraversal.message), 'путь с .. не отклонён');
  });

  /* ------------------------------- переподключение и остановка сервера */

  console.log('\nПереподключение и остановка сервера');
  const { client: p1Again, ack: rejoin } = await open({
    name: 'Артём', playerId: 'p-test-0001', playerKey: p1Join.you.playerKey
  });
  const rejoinState = p1Again.log.joined[0].state;
  check('переподключение с тем же playerId и секретом возвращает тот же лист', () => {
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
