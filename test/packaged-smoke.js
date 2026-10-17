'use strict';

/**
 * Проверка СОБРАННОГО приложения: запускает готовый exe, подключается к его
 * DevTools-протоколу и выполняет внутри упакованного renderer те же проверки
 * интерфейса, что и `npm run smoke`. Дополнительно проверяет содержимое
 * app.asar и появление папки кампаний.
 *
 * Это ловит то, чего не видит сборка из исходников: забытые в пакете файлы,
 * неработающий preload внутри asar, отсутствующие production-зависимости.
 *
 * Запуск: node test/packaged-smoke.js [путь-к-exe]
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEBUG_PORT = 9333;

/** Папку сборки берём из package.json: жёстко прописанный dist однажды
 *  разошёлся с реальным output (dist-final) и проверка смотрела не туда. */
const BUILD_CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
).build || {};
/** Версия приложения в том виде, в каком её показывает окно настроек:
 *  из 0.10.0-b получается 0.10b. Проверки получают её отсюда, а не из
 *  зашитой строки — иначе каждая смена версии ломала бы их. */
/** Та же версия, что и в приложении: читаем из package.json, как и BUILD_CONFIG. */
const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
).version;
/** Подпись, которую покажет окно настроек: «0.12.0-b» → «0.12b». */
const EXPECTED_VERSION_LABEL = (() => {
  const [core] = String(PACKAGE_VERSION || '0.0.0').split('-');
  return `${core.replace(/\.0$/, '')}b`;
})();
const OUTPUT_DIR = (BUILD_CONFIG.directories && BUILD_CONFIG.directories.output) || 'dist';
const DIST_UNPACKED = path.join(__dirname, '..', OUTPUT_DIR, 'win-unpacked');

/** Файлы внутри app.asar должны лежать в пакете. */
const REQUIRED_FILES = [
  'main.js',
  'preload.js',
  'preload-sheet.js',
  'renderer/index.html',
  'renderer/styles.css',
  'renderer/theme.js',
  // Портрет мастера по умолчанию. Без него у стола не будет ведущего, а
  // заметить пропажу в пакете негде: страница грузится, просто пустая.
  'renderer/avatar-dm.png',
  'renderer/app.js',
  'renderer/dnd5e.js',
  'renderer/sheet.js',
  'renderer/sheet-window.html',
  'renderer/sheet-window.js',
  'renderer/table.js',
  'renderer/local-table.js',
  // Справочник предметов для ссылок на dnd.su. Без него панель импортированного
  // приключения открывается, но названия перестают быть кликабельными.
  'renderer/dnd-items.json',
  'renderer/vendor/socket.io.min.js',
  'server/socket.js',
  'server/state.js',
  'server/campaign.js',
  'server/net.js',
  'server/image.js',
  'server/iroh-manager.js',
  'server/importer/index.js',
  'scripts/copy-vendor.js'
];
/** Папки production-зависимостей — проверяем по префиксу. */
const REQUIRED_PREFIXES = ['node_modules/express/', 'node_modules/socket.io/'];
const FORBIDDEN_IN_ASAR = ['test/integration.js', 'test/smoke-main.js'];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Завершение процесса с гарантированной досылкой вывода: process.exit() может
 * обрезать буфер stdout, если тот пишется в пайп, и тогда отчёт теряется.
 */
function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 400);
}

function findExe() {
  if (!fs.existsSync(DIST_UNPACKED)) {
    throw new Error(`Нет папки ${DIST_UNPACKED}. Сначала выполните: npm run dist`);
  }
  const exe = fs.readdirSync(DIST_UNPACKED).find((name) => name.toLowerCase().endsWith('.exe'));
  if (!exe) throw new Error(`В ${DIST_UNPACKED} не найден exe`);
  return path.join(DIST_UNPACKED, exe);
}

/**
 * Читает оглавление app.asar.
 *
 * В начале файла лежит pickle-заголовок, внутри которого — JSON-оглавление,
 * дополненное до границы 4 байт. Точные смещения зависят от версии
 * инструментов, поэтому надёжнее найти границы JSON по фигурным скобкам,
 * чем угадывать отступы.
 */
function readAsarNames(asarPath) {
  const stat = fs.statSync(asarPath);
  const fd = fs.openSync(asarPath, 'r');
  try {
    const sizeBuf = Buffer.alloc(8);
    fs.readSync(fd, sizeBuf, 0, 8, 0);
    const headerSize = sizeBuf.readUInt32LE(4);
    if (!headerSize || headerSize > 128 * 1024 * 1024 || headerSize > stat.size) {
      throw new Error(`Некорректный размер оглавления asar: ${headerSize}`);
    }
    const headerBuf = Buffer.alloc(headerSize);
    fs.readSync(fd, headerBuf, 0, headerSize, 8);

    const text = headerBuf.toString('utf8');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Оглавление asar не найдено');
    const root = JSON.parse(text.slice(start, end + 1));

    const names = [];
    const walk = (node, prefix) => {
      for (const [name, value] of Object.entries(node.files || {})) {
        const full = prefix ? `${prefix}/${name}` : name;
        if (value && value.files) walk(value, full);
        else names.push(full);
      }
    };
    walk(root, '');
    return names;
  } finally {
    fs.closeSync(fd);
  }
}

async function fetchJson(url, timeout = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function waitForPage(port, timeoutMs = 60000) {
  const start = Date.now();
  for (;;) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((target) => target.type === 'page' && target.url.includes('index.html'));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {
      // Приложение ещё запускается.
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('Не дождались окна приложения через DevTools-протокол');
    }
    await wait(500);
  }
}

/** Выполняет выражение в renderer собранного приложения. */
function evaluate(webSocketUrl, expression, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const messageId = 1;
    const timer = setTimeout(() => {
      try { socket.close(); } catch { /* уже закрыт */ }
      reject(new Error('Таймаут CDP'));
    }, timeoutMs);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: messageId,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true, userGesture: true }
      }));
    });

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (message.id !== messageId) return;
      clearTimeout(timer);
      try { socket.close(); } catch { /* уже закрыт */ }
      if (message.error) return reject(new Error(message.error.message));
      const payload = message.result || {};
      if (payload.exceptionDetails) {
        const description = payload.exceptionDetails.exception && payload.exceptionDetails.exception.description;
        return reject(new Error(`${payload.exceptionDetails.text} ${description || ''}`.trim()));
      }
      resolve(payload.result ? payload.result.value : null);
    });

    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Не удалось открыть DevTools-соединение'));
    });
  });
}

function killTree(pid) {
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
  } catch {
    // Процесс уже завершился.
  }
}

/** Однофайловая portable-сборка (electron-builder, цель portable). */
function findPortableExe() {
  const dist = path.dirname(DIST_UNPACKED);
  if (!fs.existsSync(dist)) return null;
  const name = fs.readdirSync(dist).find((file) => /portable/i.test(file) && file.toLowerCase().endsWith('.exe'));
  return name ? path.join(dist, name) : null;
}

/** Папка, которую отдают друзьям: release/<productName>/<productName>.exe */
function findReleaseExe() {
  const release = path.join(path.dirname(DIST_UNPACKED), '..', 'release');
  if (!fs.existsSync(release)) return null;
  for (const folder of fs.readdirSync(release)) {
    const dir = path.join(release, folder);
    if (!fs.statSync(dir).isDirectory()) continue;
    const exe = fs.readdirSync(dir).find((file) => file.toLowerCase().endsWith('.exe'));
    if (exe) return path.join(dir, exe);
  }
  return null;
}

/**
 * Распаковывает архив из release/ во временную папку и возвращает путь к игре.
 *
 * Проверять нужно именно то, что получат друзья, и при этом не трогать рабочую
 * папку пользователя: в ней могут лежать его кампании.
 *
 * @returns {{exe: string, cleanup: () => void}|null}
 */
function extractReleaseZip() {
  const release = path.join(path.dirname(DIST_UNPACKED), '..', 'release');
  if (!fs.existsSync(release)) return null;
  const zip = fs.readdirSync(release).find((file) => file.toLowerCase().endsWith('.zip'));
  if (!zip) return null;

  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-release-zip-'));
  const cleanup = () => {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    } catch { /* временная папка */ }
  };
  try {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${path.join(release, zip)}' -DestinationPath '${target}' -Force`
    ], { stdio: 'ignore' });

    for (const folder of fs.readdirSync(target)) {
      const dir = path.join(target, folder);
      if (!fs.statSync(dir).isDirectory()) continue;
      const exe = fs.readdirSync(dir).find((file) => file.toLowerCase().endsWith('.exe'));
      if (exe) return { exe: path.join(dir, exe), cleanup };
    }
    cleanup();
    return null;
  } catch (error) {
    console.log(`  (не удалось распаковать архив для проверки: ${error.message})`);
    cleanup();
    return null;
  }
}

/**
 * Окно может открыться раньше, чем renderer загрузит скрипты и получит
 * конфигурацию из main-процесса — особенно у однофайловой сборки, которая
 * сначала распаковывается во временную папку. Поэтому ждём готовности.
 */
async function waitForRendererReady(webSocketUrl, timeoutMs = 60000) {
  const start = Date.now();
  for (;;) {
    try {
      const ready = await evaluate(webSocketUrl, `Boolean(
        window.desktop && window.desktop.isElectron && window.DnD5e && window.TableUI && window.io
        && window.LocalTable
        && document.querySelector('#home-datadir')
        && document.querySelector('#home-datadir').textContent !== '…'
      )`, 15000);
      if (ready) return true;
    } catch {
      // Страница ещё грузится, соединение переоткроем.
    }
    if (Date.now() - start > timeoutMs) return false;
    await wait(500);
  }
}

/**
 * Проверяет портативный запуск: приложение должно держать данные рядом с exe,
 * а не в профиле Windows или во временной папке распаковки.
 *
 * @param {{exe: string, port: number, label: string, removeDataAfter: boolean}} options
 */
async function checkPortableRun(options) {
  const { exe, port, label, removeDataAfter } = options;
  const exeDir = path.dirname(exe);
  const dataDir = path.join(exeDir, 'data');
  const existedBefore = fs.existsSync(dataDir);
  const results = [];
  const logs = [];

  console.log(`\n${label}\n  ${exe}\n`);

  const child = spawn(exe, [`--remote-debugging-port=${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Проверки не должны мелькать окнами на экране.
    env: { ...process.env, DND_HIDE_WINDOW: '1' }
  });
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));

  try {
    const page = await waitForPage(port, 60000);
    results.push({ name: 'запускается и открывает окно', ok: true, error: '' });

    const ready = await waitForRendererReady(page.webSocketDebuggerUrl);
    results.push({
      name: 'preload-мост и все скрипты загружаются',
      ok: ready,
      error: ready ? '' : 'renderer не догрузился за 60 секунд'
    });

    const info = await evaluate(page.webSocketDebuggerUrl, `(async () => {
      const config = await window.desktop.getConfig();
      return {
        portable: config.portable,
        dataDir: config.dataDir,
        homeText: document.querySelector('#home-datadir').textContent
      };
    })()`, 30000);
    results.push({
      name: 'данные складываются рядом с игрой, а не в профиль Windows',
      ok: info.portable === true && info.dataDir === dataDir,
      error: `portable=${info.portable}, dataDir=${info.dataDir}, ожидали ${dataDir}`
    });
    results.push({
      name: 'главный экран сообщает о портативном режиме',
      ok: String(info.homeText).includes('портативный режим'),
      error: `текст: ${info.homeText}`
    });
  } catch (error) {
    const tail = logs.join('').trim().split(/\r?\n/).slice(-6).join(' | ');
    results.push({
      name: 'запускается и открывает окно',
      ok: false,
      error: `${error.message}${tail ? `\n        вывод приложения: ${tail}` : ''}`
    });
  } finally {
    killTree(child.pid);
    await wait(2500);
  }

  results.push({
    name: 'рядом с игрой создана папка data/campaigns',
    ok: fs.existsSync(path.join(dataDir, 'campaigns')),
    error: `нет ${path.join(dataDir, 'campaigns')}`
  });

  if (removeDataAfter && !existedBefore) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    } catch { /* папка в dist, создана проверкой */ }
  }
  return results;
}

async function main() {
  const exe = process.argv[2] ? path.resolve(process.argv[2]) : findExe();
  const asarPath = path.join(path.dirname(exe), 'resources', 'app.asar');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-packaged-'));
  let failed = 0;

  console.log('\nСодержимое пакета (app.asar)\n');
  if (!fs.existsSync(asarPath)) {
    console.log(`  FAIL нет файла ${asarPath}`);
    finish(1);
    return;
  }
  let names = [];
  try {
    names = readAsarNames(asarPath);
    const sizeMb = (fs.statSync(asarPath).size / 1024 / 1024).toFixed(1);
    console.log(`  ok   оглавление пакета прочитано: ${names.length} файлов, ${sizeMb} МБ\n`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL не удалось прочитать оглавление пакета: ${error.message}`);
  }

  // Пакет не должен вбирать результаты прошлых сборок: однажды папка release/
  // попала внутрь app.asar и раздула его с 4 МБ до 526 МБ.
  const asarSizeMb = fs.statSync(asarPath).size / 1024 / 1024;
  if (asarSizeMb < 80) {
    console.log(`  ok   размер пакета в норме (${asarSizeMb.toFixed(1)} МБ)`);
  } else {
    failed += 1;
    console.log(`  FAIL пакет раздут до ${asarSizeMb.toFixed(1)} МБ — в него попали лишние файлы`);
    const suspicious = names.filter((name) => /^(release|dist|build|\.qwen)\//.test(name));
    for (const name of suspicious.slice(0, 5)) console.log(`        лишнее: ${name}`);
  }

  for (const folder of ['release/', 'dist/', '.qwen/']) {
    if (names.some((name) => name.startsWith(folder))) {
      failed += 1;
      console.log(`  FAIL в пакет попали файлы из ${folder}`);
    } else {
      console.log(`  ok   папка ${folder} в пакет не попала`);
    }
  }

  for (const name of REQUIRED_FILES) {
    if (names.includes(name)) console.log(`  ok   в пакете есть ${name}`);
    else {
      failed += 1;
      console.log(`  FAIL в пакете нет ${name}`);
    }
  }
  for (const prefix of REQUIRED_PREFIXES) {
    if (names.some((name) => name.startsWith(prefix))) console.log(`  ok   в пакете есть ${prefix}*`);
    else {
      failed += 1;
      console.log(`  FAIL в пакете нет ${prefix}*`);
    }
  }
  for (const name of FORBIDDEN_IN_ASAR) {
    if (names.includes(name)) {
      failed += 1;
      console.log(`  FAIL в пакет попал тестовый файл ${name}`);
    } else {
      console.log(`  ok   тестовый файл ${name} не попал в пакет`);
    }
  }

  console.log(`\nЗапуск собранного приложения\n  ${exe}\n`);
  const child = spawn(exe, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userData}`
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Проверки не должны мелькать окнами на экране.
    env: { ...process.env, DND_HIDE_WINDOW: '1' }
  });

  const appLogs = [];
  child.stdout.on('data', (chunk) => appLogs.push(String(chunk)));
  child.stderr.on('data', (chunk) => appLogs.push(String(chunk)));
  let exited = null;
  child.on('exit', (code) => { exited = code; });

  try {
    const page = await waitForPage(DEBUG_PORT);
    console.log(`  ok   приложение запустилось, окно открыто (${page.url.replace(/^file:\/\//, '')})`);
    console.log(`  ok   процесс живёт (pid ${child.pid})\n`);

    // Цель появляется в DevTools ещё до того, как отработали скрипты в конце
    // index.html. Без этой проверки проверки падают на недогруженном renderer
    // (window.LocalTable и прочее ещё undefined).
    if (!(await waitForRendererReady(page.webSocketDebuggerUrl))) {
      throw new Error('renderer не догрузился: нет preload-моста или скриптов интерфейса');
    }
    console.log('  ok   preload-мост и скрипты интерфейса загрузились\n');

    const source = fs.readFileSync(path.join(__dirname, 'renderer-assertions.js'), 'utf8');
    // Передаём ожидаемую версию в страницу: проверки интерфейса не должны
    // знать про package.json, но и не должны содержать его версию в тексте.
    const prepared = `window.__EXPECTED_VERSION__ = ${JSON.stringify(EXPECTED_VERSION_LABEL)};\n${source}`;
    const response = await evaluate(page.webSocketDebuggerUrl, prepared);
    if (!response || !Array.isArray(response.checks)) {
      throw new Error(`Неожиданный ответ из renderer: ${JSON.stringify(response)}`);
    }

    console.log('Проверки интерфейса внутри собранного приложения\n');
    for (const item of response.checks) {
      if (item.ok) console.log(`  ok   ${item.name}`);
      else {
        failed += 1;
        console.log(`  FAIL ${item.name}\n        ${item.error}`);
      }
    }

    // В портативной сборке данные лежат рядом с игрой, а не в
    // --user-data-dir: рядом с exe лежит portable.txt. Проверка обязана
    // смотреть туда же, а не в профиль Windows, иначе она валится на любой
    // переносимой сборке.
    const portableMode = fs.existsSync(path.join(path.dirname(exe), 'portable.txt'));
    const campaignsDir = portableMode
      ? path.join(path.dirname(exe), 'data', 'campaigns')
      : path.join(userData, 'campaigns');
    const created = fs.existsSync(campaignsDir);
    const campaignCount = created ? fs.readdirSync(campaignsDir).length : 0;
    console.log('\nДанные собранного приложения\n');
    if (created && campaignCount > 0) {
      console.log(`  ok   кампания записана в папку данных приложения (${campaignCount} шт.)`);
    } else {
      failed += 1;
      console.log(`  FAIL папка кампаний пуста или не создана: ${campaignsDir}`);
    }
    if (response.campaignId) {
      const file = path.join(campaignsDir, response.campaignId, 'campaign.json');
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const good = raw.name === 'Смоук-кампания' && raw.state && raw.state.tokens.length === 1;
        if (good) console.log('  ok   содержимое кампании корректно (название, фишки)');
        else {
          failed += 1;
          console.log(`  FAIL содержимое кампании: ${JSON.stringify(raw).slice(0, 200)}`);
        }
      } else {
        failed += 1;
        console.log(`  FAIL нет файла кампании ${file}`);
      }
    } else {
      failed += 1;
      console.log('  FAIL renderer не вернул идентификатор кампании');
    }
  } finally {
    killTree(child.pid);
    await wait(1500);
    try {
      fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    } catch { /* временная папка */ }
  }

  if (exited !== null) {
    console.log(`\nПриложение завершилось с кодом ${exited} (ожидаемо: процесс убит после проверок).`);
  }

  const portableTargets = [];
  const portableExe = findPortableExe();
  if (portableExe) {
    portableTargets.push({
      exe: portableExe,
      port: DEBUG_PORT + 1,
      label: 'Однофайловая portable-сборка (данные распаковки живут во временной папке)',
      removeDataAfter: true
    });
  }
  const releaseExe = findReleaseExe();
  const archive = extractReleaseZip();
  if (archive) {
    // Именно этот комплект получат друзья — проверяем его из распакованного архива.
    portableTargets.push({
      exe: archive.exe,
      port: DEBUG_PORT + 2,
      label: 'Архив из release/, распакованный как у получателя',
      removeDataAfter: true,
      cleanup: archive.cleanup
    });
  } else if (releaseExe) {
    // Архива нет — проверяем саму папку, но только если её ещё не используют.
    const campaignsDir = path.join(path.dirname(releaseExe), 'data', 'campaigns');
    const used = fs.existsSync(campaignsDir) && fs.readdirSync(campaignsDir).length > 0;
    if (used) {
      console.log('\n  (в папке для отправки уже есть кампании игрока — её проверку пропускаем, чтобы не трогать данные)');
    } else {
      portableTargets.push({
        exe: releaseExe,
        port: DEBUG_PORT + 2,
        label: 'Папка, готовая к отправке друзьям',
        removeDataAfter: false
      });
    }
  }

  if (!portableTargets.length) {
    console.log('\n  (портативные сборки не найдены — проверка портативного режима пропущена)');
  }
  for (const target of portableTargets) {
    const results = await checkPortableRun(target);
    console.log('Результаты портативной проверки\n');
    for (const item of results) {
      if (item.ok) console.log(`  ok   ${item.name}`);
      else {
        failed += 1;
        console.log(`  FAIL ${item.name}\n        ${item.error}`);
      }
    }
    console.log('');
    if (target.cleanup) target.cleanup();
  }

  const errors = appLogs.join('').split(/\r?\n/).filter((line) => /error|failed|Cannot find/i.test(line));
  if (errors.length) {
    console.log('\nСообщения приложения (error/failed)\n');
    for (const line of errors.slice(0, 20)) console.log(`  ${line}`);
  }

  console.log(`\n${'='.repeat(62)}`);
  console.log(failed ? `Ошибок: ${failed}` : 'Собранное приложение работает, проверки пройдены.');
  finish(failed ? 1 : 0);
}

main().catch((error) => {
  console.error('\nПроверка собранного приложения упала:', error && error.stack ? error.stack : error);
  finish(1);
});

process.on('uncaughtException', (error) => {
  console.error('\nНепойманная ошибка:', error && error.stack ? error.stack : error);
  finish(1);
});

process.on('unhandledRejection', (error) => {
  console.error('\nНеобработанный отказ:', error && error.stack ? error.stack : error);
  finish(1);
});
