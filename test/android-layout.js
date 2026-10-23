'use strict';

// Проверка мобильной раскладки на узком экране. Запускается после
// assembleDebug: нужен собранный assets/renderer с android-bridge.js.
const path = require('path');
const { app, BrowserWindow } = require('electron');

const page = path.join(
  __dirname,
  '..',
  'android',
  'app',
  'build',
  'intermediates',
  'assets',
  'debug',
  'mergeDebugAssets',
  'renderer',
  'index.html'
);
const preload = path.join(__dirname, 'android-layout-preload.js');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 412,
    height: 900,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const errors = [];
  win.webContents.on('console-message', (event, level, message) => {
    if (level >= 2) errors.push(message);
  });

  try {
    await win.loadFile(page);
    const result = await win.webContents.executeJavaScript(`(async function () {
      var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
      var staleHeight = localStorage.getItem('dnd-table.rightHeight');
      try {
        localStorage.removeItem('dnd-table.rightHeight');
        localStorage.removeItem('dnd-table.rightWidth');
        localStorage.setItem('dnd-table.leftPanelCollapsed', '1');
        localStorage.setItem('dnd-table.rightPanelPos', 'bottom');
      } catch (error) { /* приватный режим */ }
      var layoutNode = document.querySelector('.layout');
      if (layoutNode) layoutNode.style.removeProperty('--right-user-height');
      var settings = document.getElementById('btn-settings-home');
      if (settings) settings.click();
      await wait(80);
      var train = document.querySelector('[data-setting="training"]');
      if (train) train.click();
      await wait(400);
      var chatTab = document.querySelector('[data-tab="chat"]');
      if (chatTab) chatTab.click();
      await wait(120);

      function rect(sel) {
        var node = document.querySelector(sel);
        if (!node) return null;
        var box = node.getBoundingClientRect();
        var style = getComputedStyle(node);
        return {
          left: Math.round(box.left),
          right: Math.round(box.right),
          top: Math.round(box.top),
          bottom: Math.round(box.bottom),
          width: Math.round(box.width),
          height: Math.round(box.height),
          display: style.display,
          position: style.position,
          overflowX: style.overflowX
        };
      }

      var leftClosed = rect('.col--left');
      var leftButton = document.getElementById('btn-panel-left');
      // На чистом профиле панель уже свёрнута, но тренировочный стол может
      // открыть её сам. Тогда не щёлкаем: проверяем именно оверлей.
      if (leftClosed && leftClosed.display === 'none' && leftButton) {
        leftButton.click();
        await wait(120);
      }
      var leftOpen = rect('.col--left');

      var tabs = document.querySelector('.tabs');
      return {
        staleHeight: staleHeight,
        isAndroid: !!(window.desktop && window.desktop.isAndroid),
        mobileCss: Array.prototype.some.call(document.querySelectorAll('link'), function (link) {
          return /android-mobile\\.css$/.test(link.href);
        }),
        viewport: document.querySelector('meta[name="viewport"]') && document.querySelector('meta[name="viewport"]').content,
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
        scrollWidth: document.documentElement.scrollWidth,
        tableActive: document.getElementById('screen-table').classList.contains('is-active'),
        topbar: rect('.topbar'),
        layout: rect('.layout'),
        center: rect('.col--center'),
        left: leftClosed,
        leftOpen: leftOpen,
        leftStored: localStorage.getItem('dnd-table.leftPanelCollapsed'),
        layoutClass: document.querySelector('.layout').className,
        panelLeft: rect('#btn-panel-left'),
        right: rect('.col--right'),
        pasteButton: (function(){var b=document.getElementById('btn-paste-ticket');if(!b)return null;return {hidden:b.hidden,display:getComputedStyle(b).display};})(),
        tabs: rect('.tabs'),
        tabsScrollWidth: tabs ? tabs.scrollWidth : 0,
        tabsClientWidth: tabs ? tabs.clientWidth : 0,
        chatForm: rect('.chat__form'),
        send: rect('.chat__form .btn--accent'),
        tableSub: rect('#table-sub')
      };
    })()`);
    result.errors = errors;
    console.log(JSON.stringify(result, null, 2));

    const verticalOk = result.right && result.right.bottom <= result.height + 1
      && result.send && result.send.bottom <= result.height + 1;
    const ok = result.isAndroid
      && result.mobileCss
      && result.tableActive
      && result.scrollWidth <= result.width + 1
      && result.panelLeft && result.panelLeft.display !== 'none'
      && result.leftOpen && result.leftOpen.display === 'flex'
      && result.leftOpen.position === 'absolute'
      && result.leftOpen.width > 0 && result.leftOpen.right <= result.width + 1
      && result.right && result.right.right <= result.width + 1
      && result.right.width >= result.width - 20
      && result.center && result.right.top > result.center.top
      && result.chatForm && result.chatForm.width > 0
      && result.send && result.send.width > 0 && result.send.right <= result.width + 1
      && verticalOk
      && result.topbar && result.topbar.right <= result.width + 1
      && result.topbar.height < 200
      && result.tabs && result.tabs.overflowX === 'auto'
      && result.tableSub && result.tableSub.display === 'none'
      && result.pasteButton && !result.pasteButton.hidden && result.pasteButton.display !== 'none'
      && errors.length === 0;
    console.log(ok ? 'ANDROID_LAYOUT_OK' : 'ANDROID_LAYOUT_FAIL');
    app.exit(ok ? 0 : 1);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
