'use strict';

/**
 * Smoke-тест приложения в настоящем Electron.
 *
 * Запускает main.js как есть (то есть всё приложение целиком), открывает окно
 * с настоящим renderer, выполняет набор проверок интерфейса и печатает отчёт.
 *
 * Запуск: npx electron test/smoke-main.js
 * (отдельного скрипта npm run smoke нет; тот же набор проверок гоняет
 *  test/packaged-smoke.js, но уже на собранном приложении)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { versionLabel } = require('../scripts/version-label');
const { app, BrowserWindow } = require('electron');

// Изолированная папка данных, чтобы не трогать кампании пользователя.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-smoke-userdata-'));
app.setPath('userData', userData);

// Окно приложения во время проверки не показываем.
process.env.DND_HIDE_WINDOW = '1';

// Запускаем само приложение.
require(path.join(__dirname, '..', 'main.js'));

const consoleLogs = [];

// Проверки приходят в renderer событием console-log и печатаются только в
// конце прогона. При аварии их не видно, а падать тут почти всегда есть чем:
// список рендера, файл с данными или отказ сервера. Поэтому каждое сообщение
// пишется ещё и в журнал, который переживает падение.
// @type {(line: string) => void}
let journalLine = () => {};

function describeArg(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    if ('message' in value) {
      return { level: String(value.level || ''), text: String(value.message), source: value.sourceId, line: value.lineNumber };
    }
    return String(value);
  }
  return String(value);
}

function collectConsoleLogs(contents) {
  contents.on('console-message', (...args) => {
    const first = args[0];
    if (first && typeof first === 'object' && 'message' in first) {
      if (process.env.DND_PROGRESS) console.log(`  ${String(first.message)}`);
      consoleLogs.push({ level: String(first.level || ''), text: String(first.message) });
      journalLine(String(first.message || ''));
      return;
    }
    if (process.env.DND_PROGRESS) console.log(`  ${String(args[2] || '')}`);
    consoleLogs.push({ level: String(args[1] || ''), text: String(args[2] || '') });
    journalLine(String(args[2] || ''));
  });
  contents.on('preload-error', (event, preloadPath, error) => {
    consoleLogs.push({ level: 'error', text: `preload-error ${preloadPath}: ${error && error.message}` });
  });
  contents.on('did-fail-load', (event, code, description, url) => {
    consoleLogs.push({ level: 'error', text: `did-fail-load ${code} ${description} ${url}` });
  });
  contents.on('render-process-gone', (event, details) => {
    consoleLogs.push({ level: 'error', text: `render-process-gone ${JSON.stringify(details)}` });
  });
}

function getWindow() {
  return new Promise((resolve, reject) => {
    const existing = BrowserWindow.getAllWindows()[0];
    if (existing) return resolve(existing);
    const timeout = setTimeout(() => reject(new Error('Окно приложения не появилось')), 20000);
    app.on('browser-window-created', (event, win) => {
      clearTimeout(timeout);
      resolve(win);
    });
  });
}

async function main() {
  await app.whenReady();
  const win = await getWindow();
  collectConsoleLogs(win.webContents);

  if (win.webContents.isLoadingMainFrame()) {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  }
  // Дать renderer выполнить initHome().
  await new Promise((resolve) => setTimeout(resolve, 400));

  const source = fs.readFileSync(path.join(__dirname, 'renderer-assertions.js'), 'utf8');

  // Версию ожидаемую подставляем из package.json тем же правилом, что и
  // приложение: зашитая в проверку строка ломалась бы при каждой смене версии,
  // а проверка без неё молча ничего не проверяла бы.
  const expectedVersion = versionLabel(JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  ).version);
  const prepared = `window.__EXPECTED_VERSION__ = ${JSON.stringify(expectedVersion)};\n${source}`;

  // Отдельные окна листов живут недолго: в конце сценария стол останавливается,
  // и они закрываются. Поэтому следим за ними параллельно с проверками.
  // Окон может быть два: лист тренировочного стола (без сети) и лист игрока,
  // который открыл ДМ (на связи). Их нужно различать.
  const noWindow = () => ({ found: false, name: null, connection: null, status: null, error: null });
  const sheetWindows = { training: noWindow(), dm: noWindow() };
  let sheetPollBusy = false;
  // Окно читаем только после загрузки документа: вызов executeJavaScript по
  // загружающемуся окну может не вернуться вовсе (и подвесить весь опрос).
  // И не сразу после загрузки: лист окно подхватывает из черновика уже после
  // неё, и первый же опрос иначе прочитает пустую форму.
  const loadedSheetWindows = new Map();
  app.on('browser-window-created', (event, created) => {
    // Идентификатор запоминаем сразу: к моменту «closed» объект webContents
    // уже разрушен, и обращение к нему бросает «Object has been destroyed»
    // прямо в процессе main — Electron показывает на это отдельное окно и
    // весь прогон выглядит упавшим.
    const contentsId = created.webContents.id;
    created.webContents.on('did-finish-load', () => {
      if (created.webContents.getURL().includes('sheet-window.html')) {
        loadedSheetWindows.set(contentsId, Date.now());
      }
    });
    created.on('closed', () => {
      loadedSheetWindows.delete(contentsId);
    });
  });
  /** Читает состояние окна листа; страховочный таймаут на случай зависания. */
  const readSheetWindow = (win) => {
    const read = win.webContents.executeJavaScript(`({
      name: (document.querySelector('[data-field="characterName"]') || { value: '' }).value,
      connection: (document.querySelector('#sheet-conn') || { textContent: '' }).textContent,
      status: (document.querySelector('#sheet-sub') || { textContent: '' }).textContent
    })`);
    return Promise.race([
      read,
      new Promise((resolve) => setTimeout(() => resolve(null), 3000))
    ]);
  };
  const sheetPoll = setInterval(async () => {
    if (sheetPollBusy) return;
    sheetPollBusy = true;
    try {
      const windows = BrowserWindow.getAllWindows().filter((item) => {
        if (item.isDestroyed()) return false;
        if (!item.webContents.getURL().includes('sheet-window.html')) return false;
        const readyAt = loadedSheetWindows.get(item.webContents.id);
        return Boolean(readyAt) && Date.now() - readyAt > 800;
      });
      for (const win of windows) {
        const info = await readSheetWindow(win);
        if (!info) continue;
        const isTraining = /без сети|Проверка без сети/.test(`${info.connection} ${info.status}`);
        const bucket = isTraining ? sheetWindows.training : sheetWindows.dm;
        bucket.found = true;
        if (info.name) bucket.name = info.name;
        if (info.connection) bucket.connection = info.connection;
        if (info.status) bucket.status = info.status;
      }
      if (sheetWindows.dm.name === 'Мира' && sheetWindows.dm.connection === 'на связи'
        && sheetWindows.training.name === 'Тордин') {
        clearInterval(sheetPoll);
      }
    } catch (error) {
      if (!sheetWindows.dm.found) sheetWindows.dm.error = String(error && error.message ? error.message : error);
    } finally {
      sheetPollBusy = false;
    }
  }, 300);

  const response = await win.webContents.executeJavaScript(prepared, true);
  clearInterval(sheetPoll);

  if (!response || !Array.isArray(response.checks)) {
    throw new Error(`Неожиданный ответ из renderer: ${JSON.stringify(response)}`);
  }

  let failed = 0;
  console.log('\nПроверки интерфейса в Electron\n');
  for (const item of response.checks) {
    if (item.ok) {
      console.log(`  ok   ${item.name}`);
    } else {
      failed += 1;
      console.log(`  FAIL ${item.name}\n        ${item.error}`);
    }
  }

  // Проверка файла кампании на диске.
  const diskChecks = [];
  if (response.campaignId) {
    const campaignFile = path.join(userData, 'campaigns', response.campaignId, 'campaign.json');
    const exists = fs.existsSync(campaignFile);
    diskChecks.push({
      name: 'файл кампании записан в папку данных приложения',
      ok: exists,
      error: exists ? '' : `нет файла ${campaignFile}`
    });
    if (exists) {
      const raw = JSON.parse(fs.readFileSync(campaignFile, 'utf8'));
      const state = raw.state || {};
      const chats = Array.isArray(state.chatHistory) ? state.chatHistory : [];
      const rolls = Array.isArray(state.diceHistory) ? state.diceHistory : [];
      const good = state.tokens && state.tokens.length === 1
        && state.maps && 'world' in state.maps && 'battle' in state.maps
        && chats.some((message) => message.text === 'Смоук-сообщение')
        && chats.some((message) => message.isRoll)
        && rolls.length >= 1;
      diskChecks.push({
        name: 'сохранены фишки, история чата и бросков',
        ok: Boolean(good),
        error: good ? '' : `tokens=${state.tokens?.length}, chat=${chats.length}, rolls=${rolls.length}`
      });
      diskChecks.push({
        name: 'в кампании есть версия формата и даты',
        ok: Boolean(raw.version && raw.createdAt && raw.updatedAt),
        error: ''
      });
    }
  } else {
    diskChecks.push({ name: 'идентификатор кампании получен от renderer', ok: false, error: 'не получен' });
  }

  console.log('\nПроверки файлов кампании\n');
  for (const item of diskChecks) {
    if (item.ok) {
      console.log(`  ok   ${item.name}`);
    } else {
      failed += 1;
      console.log(`  FAIL ${item.name}\n        ${item.error}`);
    }
  }

  // Отдельное окно листа проверяем из main-процесса: из renderer его не видно.
  const windowChecks = [
    {
      name: 'лист персонажа открывается в отдельном окне',
      ok: sheetWindows.dm.found,
      error: sheetWindows.dm.found ? '' : `второе окно не появилось (${sheetWindows.dm.error || 'не найдено'})`
    },
    {
      name: 'в отдельном окне показаны данные персонажа игрока',
      ok: sheetWindows.dm.name === 'Мира',
      error: sheetWindows.dm.name === 'Мира' ? '' : `имя в окне листа: ${sheetWindows.dm.name}`
    },
    {
      name: 'отдельное окно листа подключено к столу',
      ok: sheetWindows.dm.connection === 'на связи',
      error: sheetWindows.dm.connection === 'на связи' ? '' : `состояние окна: ${sheetWindows.dm.connection}`
    },
    {
      name: 'лист тренировочного стола открывается отдельным окном без сети',
      ok: sheetWindows.training.found && sheetWindows.training.connection === 'без сети',
      error: `окно: ${JSON.stringify(sheetWindows.training)}`
    },
    {
      name: 'в отдельном окне тренировочного стола та же заготовка листа',
      ok: sheetWindows.training.name === 'Тордин',
      error: `окно: ${JSON.stringify(sheetWindows.training)}`
    }
  ];

  console.log('\nПроверки отдельного окна листа\n');
  for (const item of windowChecks) {
    if (item.ok) {
      console.log(`  ok   ${item.name}`);
    } else {
      failed += 1;
      console.log(`  FAIL ${item.name}\n        ${item.error}`);
    }
  }

  const errors = consoleLogs.filter((log) => log.level === 'error' || log.level === '3' || log.level === 'warning');
  if (errors.length) {
    console.log('\nСообщения renderer (error/warning)\n');
    for (const log of errors) console.log(`  [${log.level}] ${log.text}`);
  }

  const total = response.checks.length + diskChecks.length + windowChecks.length;
  console.log(`\n${'='.repeat(62)}`);
  console.log(`Проверок: ${total}, ошибок: ${failed}`);
  console.log(failed ? 'Есть ошибки.' : 'Все проверки пройдены.');

  cleanup();
  app.exit(failed ? 1 : 0);
}

/** Папку данных Electron может держать залоченной — это не повод падать. */
function cleanup() {
  try {
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    // Игнорируем: временная папка в системном temp.
  }
}

app.whenReady().then(() => {
  // При аварии терялся весь собранный отчёт о проверках, и первое, что видно,
  // это «Cannot read properties of undefined» через двадцать строк от причины.
  // Поэтому результаты каждой проверки дублируются в файл: он переживёт
  // падение, и по нему видно, где остановились.
  const journal = path.join(os.tmpdir(), `dnd-smoke-${process.pid}.log`);
  journalLine = (line) => {
    try {
      fs.appendFileSync(journal, `${line}\n`);
    } catch {
      // Отчёт без файла всё равно печатается в консоль.
    }
  };
  try {
    fs.rmSync(journal, { force: true });
  } catch {
    // Файла не было — и хорошо.
  }
  main()
    .then(() => {
      cleanup();
      try { fs.rmSync(journal, { force: true }); } catch { /* временный файл */ }
      app.exit(0);
    })
    .catch((error) => {
      console.error('\nSmoke-тест упал:', error && error.stack ? error.stack : error);
      let saved = '';
      try {
        saved = fs.readFileSync(journal, 'utf8');
      } catch {
        saved = '';
      }
      if (saved) {
        console.error('\nПроверки, выполненные до сбоя:');
        console.error(saved.trim());
      }
      cleanup();
      app.exit(1);
    });
});

setTimeout(() => {
  console.error('\nSmoke-тест не завершился за 180 секунд.');
  app.exit(1);
}, 180 * 1000).unref();
