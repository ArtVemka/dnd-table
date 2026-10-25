'use strict';

/**
 * Discord Rich Presence через локальный IPC запущенного клиента Discord.
 *
 * Сетевого API у присутствия нет: на Windows это именованный канал
 * `\\?\pipe\discord-ipc-N`, на Linux unix-сокет в каталоге Discord. Протокол
 * простой: рукопожатие, кадры `opcode + uint32 length + JSON`, ответ на PING.
 *
 * Модуль намеренно ничего не знает про Electron и стол: ему на вход приходит
 * готовое состояние, он собирает безопасный текст и молча переживает, что
 * Discord не запущен.
 */

const crypto = require('crypto');
const net = require('net');
const path = require('path');

/**
 * Application ID приложения `D&D Table` в кабинете Discord.
 *
 * ID публичный, секрета в нём нет. Форку нужен свой ID и свои ассеты
 * `app_icon` и `d20`; с чужим ID Discord покажет чужое имя игры.
 */
const DISCORD_CLIENT_ID = '1563924074315513957';

const OPCODES = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4
};

/** Больше мегабайта Discord в ответ на SET_ACTIVITY не присылает. */
const MAX_FRAME_BYTES = 1024 * 1024;

const DETAILS_LIMIT = 128;
const NAME_LIMIT = 64;

/** Пауза перед повторным подключением: растёт до минуты и дальше не растёт. */
const RETRY_DELAYS = [5000, 10000, 20000, 40000, 60000];

/** Flatpak-клиенты Discord и Vesktop: у каждого свой каталог сокета. */
const FLATPAK_APPS = [
  'com.discordapp.Discord',
  'com.discordapp.DiscordCanary',
  'com.discordapp.DiscordPTB',
  'dev.vencord.Vesktop'
];

/**
 * Кандидаты на сокет Discord в порядке проверки.
 *
 * На Windows путь один. На Linux сокет бывает в обычном временном каталоге, в
 * snap и во flatpak, причём каталогов может быть несколько. Перебор дешёвый:
 * неудачное подключение закрывается сразу.
 *
 * @param {string} [platform]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function candidatePaths(platform = process.platform, env = process.env) {
  const ids = Array.from({ length: 10 }, (_, index) => index);
  if (platform === 'win32') {
    return ids.map((id) => `\\\\?\\pipe\\discord-ipc-${id}`);
  }
  const temps = [...new Set(
    [env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, '/tmp'].filter(Boolean)
  )];
  // На Linux пути всегда posix: тест на Windows не должен получать обратные слэши.
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const bases = [];
  for (const temp of temps) {
    bases.push(temp, join(temp, 'snap.discord'));
    for (const app of FLATPAK_APPS) bases.push(join(temp, 'app', app));
  }
  const seen = new Set();
  const paths = [];
  for (const base of bases) {
    for (const id of ids) {
      const target = join(base, `discord-ipc-${id}`);
      if (seen.has(target)) continue;
      seen.add(target);
      paths.push(target);
    }
  }
  return paths;
}

/**
 * Убирает переводы строк и управляющие символы, схлопывает пробелы и режет
 * строку до лимита Discord.
 *
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * «1 игрок», «3 игрока», «11 игроков».
 * @param {unknown} count
 * @returns {string}
 */
function playersLabel(count) {
  const total = Math.max(0, Math.min(9999, Math.floor(Number(count) || 0)));
  const mod10 = total % 10;
  const mod100 = total % 100;
  const word = mod10 === 1 && mod100 !== 11
    ? 'игрок'
    : (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20) ? 'игрока' : 'игроков');
  return `${total} ${word}`;
}

/**
 * Собирает объект активности из состояния стола. Возвращает `null`, если игра
 * не идёт.
 *
 * Вход проверяется по белому списку: renderer может прислать что угодно, а
 * наружу уходят только роль, название кампании, имя персонажа и счётчик.
 *
 * @param {{mode?: string, campaignName?: string, characterName?: string,
 *   playerName?: string, playerCount?: number}} input
 * @param {number} startedAt
 * @returns {object|null}
 */
function composeActivity(input, startedAt) {
  if (!input || (input.mode !== 'dm' && input.mode !== 'player')) return null;
  const campaign = clean(input.campaignName, NAME_LIMIT);
  const character = clean(input.characterName, NAME_LIMIT);
  const player = clean(input.playerName, NAME_LIMIT);
  let details;
  let state;
  if (input.mode === 'dm') {
    details = campaign ? `Мастерит «${campaign}»` : 'Ведёт стол';
    state = playersLabel(input.playerCount);
  } else {
    details = `Играет: ${character || player || 'Игрок'}`;
    state = 'Стол мастера';
  }
  return {
    details: clean(details, DETAILS_LIMIT),
    state: clean(state, DETAILS_LIMIT),
    timestamps: { start: Math.max(0, Math.floor(Number(startedAt) || 0)) },
    assets: {
      large_image: 'app_icon',
      large_text: 'D&D Table',
      small_image: 'd20',
      small_text: 'D&D 5e'
    },
    instance: false
  };
}

/**
 * Собирает кадр Discord IPC.
 * @param {number} opcode
 * @param {object} payload
 * @returns {Buffer}
 */
function encodeFrame(opcode, payload) {
  const body = Buffer.from(JSON.stringify(payload == null ? {} : payload), 'utf8');
  const frame = Buffer.allocUnsafe(8 + body.length);
  frame.writeInt32LE(opcode, 0);
  frame.writeUInt32LE(body.length, 4);
  body.copy(frame, 8);
  return frame;
}

/**
 * Разбирает поток кадров. Один чанк может содержать половину кадра или сразу
 * несколько кадров, поэтому буфер копится до полного заголовка и тела.
 *
 * @param {(opcode: number, data: object) => void} onFrame
 * @returns {{push: (chunk: Buffer) => void}}
 */
function createFrameReader(onFrame) {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const opcode = buffer.readInt32LE(0);
        const length = buffer.readUInt32LE(4);
        if (length > MAX_FRAME_BYTES) {
          buffer = Buffer.alloc(0);
          throw new Error('Кадр Discord больше допустимого');
        }
        if (buffer.length < 8 + length) return;
        const body = buffer.subarray(8, 8 + length).toString('utf8');
        buffer = buffer.subarray(8 + length);
        let data = {};
        try {
          data = JSON.parse(body || '{}');
        } catch {
          data = {};
        }
        onFrame(opcode, data);
      }
    }
  };
}

/**
 * Подключение к одному сокету с коротким таймаутом: локальный канал отвечает
 * сразу, а зависший кандидат не должен задерживать перебор.
 *
 * @param {string} target
 * @returns {Promise<import('net').Socket>}
 */
function connectPath(target) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(target);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('Таймаут подключения к Discord'));
    }, 300);
    if (timer.unref) timer.unref();
    const onError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('error', onError);
      resolve(socket);
    });
  });
}

/**
 * Создаёт присутствие. Один экземпляр на процесс: main держит соединение и
 * время сессии, а renderer присылает только состояние.
 *
 * @param {{
 *   clientId?: string,
 *   paths?: string[],
 *   dial?: (target: string) => Promise<import('net').Socket>,
 *   log?: (message: string) => void,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (timer: any) => void,
 *   retryDelays?: number[],
 *   pid?: number
 * }} [options]
 */
function createPresence(options = {}) {
  const clientId = String(options.clientId == null ? DISCORD_CLIENT_ID : options.clientId);
  const paths = Array.isArray(options.paths) ? options.paths : candidatePaths();
  const dial = typeof options.dial === 'function' ? options.dial : connectPath;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
  const retryDelays = Array.isArray(options.retryDelays) && options.retryDelays.length
    ? options.retryDelays
    : RETRY_DELAYS;
  const pid = Number.isInteger(options.pid) ? options.pid : process.pid;

  let enabled = false;
  let pending = null;
  let startedAt = 0;
  let socket = null;
  let reader = null;
  let ready = false;
  let lastSent = '';
  let attempt = 0;
  let retryTimer = null;
  let connecting = false;
  let destroyed = false;

  function sendActivity(activity) {
    if (!ready || !socket) return;
    const key = activity ? JSON.stringify(activity) : 'null';
    if (key === lastSent) return;
    const frame = encodeFrame(OPCODES.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid, activity: activity || null },
      nonce: crypto.randomUUID()
    });
    try {
      socket.write(frame);
      lastSent = key;
    } catch (error) {
      log(`не удалось отправить активность: ${error.message}`);
    }
  }

  function clearActivity() {
    if (lastSent === '' || lastSent === 'null') return;
    sendActivity(null);
  }

  function scheduleRetry() {
    if (destroyed || !enabled || retryTimer) return;
    const index = Math.min(attempt, retryDelays.length - 1);
    attempt += 1;
    retryTimer = setTimer(() => {
      retryTimer = null;
      ensureConnection();
    }, retryDelays[index]);
    if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
  }

  function cleanupSocket() {
    const current = socket;
    socket = null;
    reader = null;
    ready = false;
    lastSent = '';
    if (!current) return;
    current.removeListener('data', onData);
    current.removeListener('error', onSocketError);
    current.removeListener('close', onSocketClose);
    try {
      current.destroy();
    } catch {
      /* сокет уже закрыт */
    }
  }

  function onSocketClose() {
    cleanupSocket();
    if (!destroyed && enabled) scheduleRetry();
  }

  function onSocketError(error) {
    log(`Discord IPC: ${error.message}`);
  }

  function onData(chunk) {
    try {
      reader.push(chunk);
    } catch (error) {
      log(error.message);
      cleanupSocket();
      if (!destroyed && enabled) scheduleRetry();
    }
  }

  function handleFrame(opcode, data) {
    if (opcode === OPCODES.PING) {
      if (socket) socket.write(encodeFrame(OPCODES.PONG, data));
      return;
    }
    if (opcode === OPCODES.CLOSE) {
      log('Discord закрыл канал присутствия');
      cleanupSocket();
      if (!destroyed && enabled) scheduleRetry();
      return;
    }
    if (opcode === OPCODES.FRAME && data && data.evt === 'READY') {
      ready = true;
      attempt = 0;
      log('подключено к Discord');
      if (pending) sendActivity(pending);
    }
  }

  async function connect() {
    let next = null;
    for (const target of paths) {
      try {
        // eslint-disable-next-line no-await-in-loop
        next = await dial(target);
        break;
      } catch {
        /* следующий кандидат */
      }
    }
    if (!next) {
      log('канал Discord не найден');
      scheduleRetry();
      return;
    }
    if (destroyed || !enabled) {
      next.destroy();
      return;
    }
    socket = next;
    ready = false;
    lastSent = '';
    reader = createFrameReader(handleFrame);
    socket.on('data', onData);
    socket.on('error', onSocketError);
    socket.on('close', onSocketClose);
    socket.write(encodeFrame(OPCODES.HANDSHAKE, { v: 1, client_id: clientId }));
  }

  function ensureConnection() {
    if (destroyed || !enabled || connecting || socket || retryTimer) return;
    connecting = true;
    connect()
      .catch((error) => {
        log(`подключение: ${error.message}`);
        scheduleRetry();
      })
      .finally(() => {
        connecting = false;
      });
  }

  /**
   * Принимает состояние стола. `enabled: false` снимает активность, но сокет
   * оставляет открытым: включение обратно срабатывает мгновенно.
   *
   * @param {{enabled?: boolean, mode?: string, campaignName?: string,
   *   characterName?: string, playerName?: string, playerCount?: number}} input
   */
  function update(input) {
    if (destroyed || !clientId) return;
    const active = Boolean(input && input.enabled)
      && (input.mode === 'dm' || input.mode === 'player');
    if (!active) {
      enabled = false;
      pending = null;
      startedAt = 0;
      clearActivity();
      return;
    }
    enabled = true;
    if (!startedAt) startedAt = now();
    pending = composeActivity(input, startedAt);
    if (ready) sendActivity(pending);
    else ensureConnection();
  }

  function destroy() {
    destroyed = true;
    enabled = false;
    pending = null;
    if (retryTimer) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
    cleanupSocket();
  }

  return { update, destroy };
}

module.exports = {
  DISCORD_CLIENT_ID,
  OPCODES,
  DETAILS_LIMIT,
  NAME_LIMIT,
  MAX_FRAME_BYTES,
  candidatePaths,
  clean,
  playersLabel,
  composeActivity,
  encodeFrame,
  createFrameReader,
  connectPath,
  createPresence
};
