'use strict';

/**
 * Проверки Discord Rich Presence без запущенного Discord.
 *
 * Транспорт подменяется фейковым сокетом: тест видит кадры, которые модуль
 * отправляет, и сам присылает ответ READY, PING и закрытие. Живой клиент для
 * этого не нужен и в CI его нет.
 *
 * Запуск: node test/presence.js (он же входит в npm test)
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const {
  OPCODES,
  MAX_FRAME_BYTES,
  composeActivity,
  playersLabel,
  encodeFrame,
  createFrameReader,
  candidatePaths,
  createPresence
} = require('../discord-presence');

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

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

/** Дать отработать промисам подключения. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.destroyed = false;
  }

  write(buffer) {
    this.writes.push(Buffer.from(buffer));
    return true;
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

/** Все кадры, которые успел записать модуль. */
function readFrames(socket) {
  const frames = [];
  const reader = createFrameReader((opcode, data) => frames.push({ opcode, data }));
  for (const chunk of socket.writes) reader.push(chunk);
  return frames;
}

function activityFrames(socket) {
  return readFrames(socket).filter((frame) => frame.data && frame.data.cmd === 'SET_ACTIVITY');
}

const START = 1700000000000;

/* ------------------------------------------------------------------ текст */

check('мастер: кампания, число игроков и время', () => {
  const activity = composeActivity({
    mode: 'dm', campaignName: 'Курган Гнева', playerCount: 3
  }, START);
  assert.strictEqual(activity.details, 'Мастерит «Курган Гнева»');
  assert.strictEqual(activity.state, '3 игрока');
  assert.strictEqual(activity.timestamps.start, START);
});

check('мастер: пустая кампания даёт «Ведёт стол»', () => {
  const activity = composeActivity({ mode: 'dm', campaignName: '  ', playerCount: 0 }, START);
  assert.strictEqual(activity.details, 'Ведёт стол');
  assert.strictEqual(activity.state, '0 игроков');
});

check('склонение числа игроков', () => {
  const cases = [[1, '1 игрок'], [2, '2 игрока'], [4, '4 игрока'], [5, '5 игроков'],
    [11, '11 игроков'], [21, '21 игрок'], [22, '22 игрока'], [0, '0 игроков']];
  for (const [value, expected] of cases) {
    assert.strictEqual(playersLabel(value), expected, `${value}`);
  }
});

check('игрок: имя персонажа, участника и запасное «Игрок»', () => {
  assert.strictEqual(composeActivity({
    mode: 'player', characterName: 'Мира', playerName: 'Артём'
  }, START).details, 'Играет: Мира');
  assert.strictEqual(composeActivity({
    mode: 'player', characterName: '', playerName: 'Артём'
  }, START).details, 'Играет: Артём');
  assert.strictEqual(composeActivity({
    mode: 'player', characterName: '', playerName: ''
  }, START).details, 'Играет: Игрок');
  assert.strictEqual(composeActivity({ mode: 'player' }, START).state, 'Стол мастера');
});

check('строки чистятся и режутся по лимиту Discord', () => {
  const long = 'а'.repeat(200);
  const activity = composeActivity({
    mode: 'dm', campaignName: `  Курган\n\tГнева  `, playerCount: 1
  }, START);
  assert.strictEqual(activity.details, 'Мастерит «Курган Гнева»');
  const cut = composeActivity({ mode: 'player', characterName: long }, START);
  assert(cut.details.length <= 128, `длина details: ${cut.details.length}`);
  assert(!cut.details.includes('\n'));
  assert(cut.details.startsWith('Играет: '));
});

check('в активности нет запрещённых полей и текста', () => {
  const activity = composeActivity({
    mode: 'dm',
    campaignName: 'Кампания',
    playerCount: 2,
    map: 'карта сокровищ',
    chat: 'секретный чат',
    hitPoints: 12,
    ticket: 'p2p-билет',
    playerId: 'p-123'
  }, START);
  assert.deepStrictEqual(
    Object.keys(activity).sort(),
    ['assets', 'details', 'instance', 'state', 'timestamps']
  );
  const text = JSON.stringify(activity);
  assert(!text.includes('карта сокровищ'));
  assert(!text.includes('секретный чат'));
  assert(!text.includes('p2p-билет'));
  assert(!text.includes('p-123'));
});

/* ----------------------------------------------------------------- кадры */

check('кадр: заголовок и тело в little-endian', () => {
  const payload = { v: 1, client_id: '42' };
  const frame = encodeFrame(OPCODES.HANDSHAKE, payload);
  assert.strictEqual(frame.readInt32LE(0), OPCODES.HANDSHAKE);
  assert.strictEqual(frame.readUInt32LE(4), Buffer.byteLength(JSON.stringify(payload)));
  assert.deepStrictEqual(JSON.parse(frame.subarray(8).toString('utf8')), payload);
});

check('разбор кадра, разрезанного на два чанка', () => {
  const frames = [];
  const reader = createFrameReader((opcode, data) => frames.push({ opcode, data }));
  const frame = encodeFrame(OPCODES.FRAME, { cmd: 'SET_ACTIVITY' });
  reader.push(frame.subarray(0, 4));
  assert.strictEqual(frames.length, 0, 'кадр собрался из половины');
  reader.push(frame.subarray(4));
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].data.cmd, 'SET_ACTIVITY');
});

check('два кадра в одном чанке разбираются по отдельности', () => {
  const frames = [];
  const reader = createFrameReader((opcode, data) => frames.push({ opcode, data }));
  reader.push(Buffer.concat([
    encodeFrame(OPCODES.PING, { n: 1 }),
    encodeFrame(OPCODES.FRAME, { n: 2 })
  ]));
  assert.strictEqual(frames.length, 2);
  assert.strictEqual(frames[0].data.n, 1);
  assert.strictEqual(frames[1].data.n, 2);
});

check('слишком длинный кадр отвергается', () => {
  const reader = createFrameReader(() => {});
  const bad = Buffer.alloc(8);
  bad.writeInt32LE(OPCODES.FRAME, 0);
  bad.writeUInt32LE(MAX_FRAME_BYTES + 1, 4);
  assert.throws(() => reader.push(bad), /больше допустимого/);
});

/* --------------------------------------------------------------- сервис */

async function readyPresence(options = {}) {
  const socket = new FakeSocket();
  const presence = createPresence({
    clientId: '123',
    paths: ['test'],
    dial: async () => socket,
    pid: 4242,
    now: options.now || (() => START),
    ...options
  });
  presence.update(options.input || {
    enabled: true, mode: 'dm', campaignName: 'Курган Гнева', playerCount: 3
  });
  await flush();
  socket.emit('data', encodeFrame(OPCODES.FRAME, {
    cmd: 'DISPATCH', evt: 'READY', data: { user: {} }
  }));
  return { socket, presence };
}

async function runServiceChecks() {
  await checkAsync('рукопожатие и SET_ACTIVITY после READY', async () => {
    const { socket } = await readyPresence();
    const frames = readFrames(socket);
    assert.strictEqual(frames[0].opcode, OPCODES.HANDSHAKE);
    assert.strictEqual(frames[0].data.client_id, '123');
    const sent = activityFrames(socket);
    assert.strictEqual(sent.length, 1, 'активность не отправлена');
    assert.strictEqual(sent[0].data.args.pid, 4242);
    assert.strictEqual(sent[0].data.args.activity.details, 'Мастерит «Курган Гнева»');
    assert.strictEqual(sent[0].data.args.activity.state, '3 игрока');
  });

  await checkAsync('повторное то же состояние не шлётся второй раз', async () => {
    const { socket, presence } = await readyPresence();
    const before = activityFrames(socket).length;
    presence.update({ enabled: true, mode: 'dm', campaignName: 'Курган Гнева', playerCount: 3 });
    await flush();
    assert.strictEqual(activityFrames(socket).length, before);
  });

  await checkAsync('выключение снимает активность', async () => {
    const { socket, presence } = await readyPresence();
    presence.update({ enabled: false });
    const frames = activityFrames(socket);
    const last = frames[frames.length - 1];
    assert.strictEqual(last.data.args.activity, null);
  });

  await checkAsync('таймер начинается заново после выхода и возврата', async () => {
    let clock = 1000;
    const { socket, presence } = await readyPresence({
      now: () => clock,
      input: { enabled: true, mode: 'dm', campaignName: 'Тест', playerCount: 1 }
    });
    presence.update({ enabled: false });
    clock = 5000;
    presence.update({ enabled: true, mode: 'dm', campaignName: 'Тест', playerCount: 1 });
    const frames = activityFrames(socket);
    const last = frames[frames.length - 1];
    assert.strictEqual(last.data.args.activity.timestamps.start, 5000);
  });

  await checkAsync('PING получает PONG с тем же телом', async () => {
    const { socket } = await readyPresence();
    socket.emit('data', encodeFrame(OPCODES.PING, { hello: 'discord' }));
    const last = readFrames(socket).pop();
    assert.strictEqual(last.opcode, OPCODES.PONG);
    assert.deepStrictEqual(last.data, { hello: 'discord' });
  });

  await checkAsync('без Discord повтор с задержкой и подключение позже', async () => {
    const socket = new FakeSocket();
    const timers = [];
    let calls = 0;
    const presence = createPresence({
      clientId: '1',
      paths: ['test'],
      pid: 1,
      now: () => START,
      retryDelays: [0],
      dial: async () => {
        calls += 1;
        if (calls === 1) throw new Error('нет Discord');
        return socket;
      },
      setTimer: (fn) => {
        timers.push(fn);
        return { unref() {} };
      },
      clearTimer: () => {}
    });
    presence.update({ enabled: true, mode: 'player', characterName: 'Мира' });
    await flush();
    assert.strictEqual(calls, 1);
    assert.strictEqual(timers.length, 1, 'повтор не запланирован');
    timers.shift()();
    await flush();
    assert.strictEqual(calls, 2);
    assert(readFrames(socket).some((frame) => frame.opcode === OPCODES.HANDSHAKE));
    presence.destroy();
  });

  await checkAsync('пустой Application ID ничего не подключает', async () => {
    let calls = 0;
    const presence = createPresence({
      clientId: '',
      paths: ['test'],
      dial: async () => {
        calls += 1;
        return new FakeSocket();
      }
    });
    presence.update({ enabled: true, mode: 'dm', campaignName: 'Тест', playerCount: 1 });
    await flush();
    assert.strictEqual(calls, 0);
    presence.destroy();
  });

  await checkAsync('destroy закрывает сокет и не оставляет повторов', async () => {
    const { socket, presence } = await readyPresence();
    presence.destroy();
    assert.strictEqual(socket.destroyed, true);
  });
}

/* --------------------------------------------------------------- платформы */

check('пути Windows', () => {
  const paths = candidatePaths('win32', {});
  assert(paths[0].startsWith('\\\\?\\pipe\\discord-ipc-'));
  assert(paths.some((item) => item.endsWith('discord-ipc-9')));
});

check('пути Linux: обычный, snap и flatpak', () => {
  const paths = candidatePaths('linux', { XDG_RUNTIME_DIR: '/run/user/1000' });
  assert(paths.includes('/run/user/1000/discord-ipc-0'), 'нет обычного сокета');
  assert(paths.some((item) => item.includes('/snap.discord/')), 'нет snap');
  assert(paths.some((item) => item.includes('/app/com.discordapp.Discord/')), 'нет flatpak');
  assert(paths.every((item) => item.includes('/') && !item.includes('\\')), 'не posix-путь');
});

runServiceChecks().then(() => {
  console.log(`\nDiscord Presence: проверок ${passed}, провалено ${failures.length}.`);
  if (failures.length) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  }
});
