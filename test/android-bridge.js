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

function createPage(options = {}) {
  const calls = [];
  const pending = new Map();
  const links = [];
  const storage = new Map(Object.entries(options.storage || {}));
  const button = {
    hidden: true,
    handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; }
  };
  const scanButton = {
    hidden: true,
    handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; }
  };
  const input = {
    value: '',
    focused: false,
    events: 0,
    focus() { this.focused = true; },
    dispatchEvent() { this.events += 1; }
  };
  const status = { textContent: '' };
  const window = {
    innerWidth: options.innerWidth || 412,
    innerHeight: options.innerHeight || 800,
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
      readClipboard(id) {
        calls.push({ name: 'readClipboard', id });
        pending.set(id, (json) => window.__androidResult(id, json));
      },
      scanQr(id) {
        calls.push({ name: 'scanQr', id });
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
    getElementById(id) {
      if (id === 'btn-paste-ticket') return button;
      if (id === 'btn-scan-ticket') return scanButton;
      if (id === 'join-p2p-ticket') return input;
      if (id === 'join-status') return status;
      return null;
    }
  };
  const context = vm.createContext({
    window,
    document,
    console,
    Promise,
    JSON,
    String,
    Object,
    Error,
    Event: class Event {
      constructor(type) { this.type = type; }
    },
    setTimeout
  });
  vm.runInContext(source, context, { filename: bridgePath });
  return { window, document, calls, pending, links, storage, button, scanButton, input, status };
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

  await check('слишком высокая панель с планшета не выталкивает чат', () => {
    const stale = createPage({
      innerWidth: 412,
      innerHeight: 800,
      storage: { 'dnd-table.rightHeight': '700' }
    });
    assert.strictEqual(stale.storage.has('dnd-table.rightHeight'), false);
  });

  await check('кнопка вставки берёт билет из буфера', async () => {
    assert.strictEqual(page.button.hidden, false, 'кнопка вставки осталась скрытой');
    const handler = page.button.handlers.click;
    assert(handler, 'у кнопки нет обработчика');
    handler();
    for (const callback of page.pending.values()) {
      callback('{"ok":true,"text":"  endpoint-abc  "}');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(page.input.value, 'endpoint-abc');
    assert.strictEqual(page.input.events, 1, 'поле не узнало о вставке');
    assert.strictEqual(page.input.focused, true, 'поле не получило фокус');
  });

  await check('пустой буфер объясняет, почему вставка не сработала', async () => {
    page.input.value = '';
    page.status.textContent = '';
    page.button.handlers.click();
    for (const callback of page.pending.values()) {
      callback('{"ok":false,"error":"Буфер обмена пуст"}');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(page.input.value, '');
    assert.match(page.status.textContent, /Буфер обмена пуст/);
  });

  await check('кнопка QR отдаёт распознанный билет', async () => {
    assert.strictEqual(page.scanButton.hidden, false, 'кнопка QR осталась скрытой');
    const handler = page.scanButton.handlers.click;
    assert(handler, 'у кнопки QR нет обработчика');
    page.input.value = '';
    page.input.events = 0;
    handler();
    for (const callback of page.pending.values()) {
      callback('{"ok":true,"text":"  endpoint-qr  "}');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    const call = page.calls.find((item) => item.name === 'scanQr');
    assert(call, 'Kotlin не получил запрос сканера');
    assert.strictEqual(page.input.value, 'endpoint-qr');
    assert.strictEqual(page.input.events, 1, 'поле не узнало о QR-билете');
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
