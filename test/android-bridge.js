'use strict';

/**
 * Проверка моста Android без эмулятора.
 *
 * android-bridge.js loaded in WebView defines window.desktop and talks to the
 * Kotlin object through window.Android. Здесь мы подменяем Android и проверяем
 * контракт: билет уходит в Kotlin, ответ возвращается в Promise, а мастерские
 * методы честно отказывают.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

const bridgePath = path.join(
  __dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'android-bridge.js'
);
const source = fs.readFileSync(bridgePath, 'utf8');

function createClassList() {
  const values = [];
  return {
    values,
    add(value) {
      if (!values.includes(value)) values.push(value);
    },
    contains(value) {
      return values.includes(value);
    }
  };
}

function createPage() {
  const calls = [];
  const pending = new Map();
  const links = [];
  const storage = new Map();
  const window = {
    innerWidth: 412,
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    Android: {
      joinP2p(id, ticket) {
        calls.push({ name: 'joinP2p', id, ticket });
        pending.set(id, (json) => window.__androidResult(id, json));
      },
      stopTunnel(id) {
        calls.push({ name: 'stopTunnel', id });
        pending.set(id, (json) => window.__androidResult(id, json));
      },
      openExternal(url) {
        calls.push({ name: 'openExternal', url });
      }
    }
  };
  const document = {
    readyState: 'complete',
    documentElement: { classList: createClassList() },
    body: { classList: createClassList() },
    head: { appendChild(node) { links.push(node); } },
    addEventListener() {},
    createElement(tag) {
      return { tagName: tag, rel: '', href: '', textContent: '' };
    },
    getElementById() { return null; }
  };
  const context = vm.createContext({
    window,
    document,
    console,
    Promise,
    JSON,
    String,
    Object,
    Error
  });
  vm.runInContext(source, context, { filename: bridgePath });
  return { window, document, calls, pending, links, storage };
}

async function main() {
  const page = createPage();

  await check('мост объявляет Android и грузит мобильные стили', () => {
    assert.strictEqual(page.window.desktop.isAndroid, true);
    assert.strictEqual(page.window.desktop.isElectron, false);
    assert(page.document.documentElement.classList.contains('is-android'));
    assert(page.document.body.classList.contains('is-android'));
    const css = page.links.find((node) => node.rel === 'stylesheet');
    assert(css, 'не подключены мобильные стили');
    assert.strictEqual(css.href, '../android-mobile.css');
  });

  await check('на телефоне панель вкладок уходит под карту', () => {
    assert.strictEqual(page.storage.get('dnd-table.rightPanelPos'), 'bottom');
    assert.strictEqual(page.storage.get('dnd-table.leftPanelCollapsed'), '1');
  });

  await check('конфигурация и статус стола не требуют нативных вызовов', async () => {
    const config = await page.window.desktop.getConfig();
    assert.strictEqual(config.portable, false);
    assert.ok(config.dataDir, 'нет папки данных');
    const status = await page.window.desktop.hostStatus();
    assert.strictEqual(status.running, false);
  });

  const join = page.window.desktop.irohTunnelClient('ticket-123');
  await check('билет уходит в Kotlin без изменений', () => {
    const call = page.calls.find((item) => item.name === 'joinP2p');
    assert(call, 'Kotlin не получил билет');
    assert.strictEqual(call.ticket, 'ticket-123');
  });

  for (const callback of page.pending.values()) {
    callback('{"ok":true,"localPort":41234}');
  }
  const joined = await join;
  await check('порт туннеля возвращается в renderer', () => {
    assert.strictEqual(joined.ok, true);
    assert.strictEqual(joined.localPort, 41234);
  });

  const stop = page.window.desktop.irohStop();
  for (const callback of page.pending.values()) {
    callback('{"ok":true}');
  }
  await check('остановка туннеля доходит до Kotlin', async () => {
    const call = page.calls.filter((item) => item.name === 'stopTunnel').pop();
    assert(call, 'Kotlin не получил остановку');
    assert.strictEqual((await stop).ok, true);
  });

  await check('мастерские действия на Android отклоняются понятной ошибкой', async () => {
    const created = await page.window.desktop.createCampaign('Тест');
    assert.strictEqual(created.ok, false);
    assert.match(created.error, /только вход за игрока/);
    const sheet = await page.window.desktop.openSheetWindow({});
    assert.strictEqual(sheet.ok, false);
  });

  await check('внешняя ссылка открывается без ожидания ответа', async () => {
    await page.window.desktop.openExternal('https://dnd.su/');
    const call = page.calls.find((item) => item.name === 'openExternal');
    assert(call, 'ссылка не ушла в Android');
    assert.strictEqual(call.url, 'https://dnd.su/');
  });

  await check('кнопка «назад» вне стола отдаёт управление Android', () => {
    assert.strictEqual(page.window.dndAndroidBack(), false);
  });

  console.log(`\nМост Android: проверок ${passed}, провалено ${failures.length}.`);
  if (failures.length) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
