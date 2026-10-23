(function initAndroidBridge(global) {
  'use strict';

  var pending = Object.create(null);
  var nextId = 1;

  var lastDeviceMode = '';

  /**
   * Телефон, планшет в портрете или планшет в альбоме.
   * Планшетом считаем экран от 761 px по ширине и 600 px по высоте:
   * телефон в альбомной ориентации сюда не попадает.
   * @returns {'phone'|'tablet-portrait'|'tablet-landscape'}
   */
  function deviceMode() {
    var width = Number(global.innerWidth) || 0;
    var height = Number(global.innerHeight) || 0;
    if (width >= 761 && height >= 600) {
      return width > height ? 'tablet-landscape' : 'tablet-portrait';
    }
    return 'phone';
  }

  /**
   * Раскладка по формату экрана. На планшете в альбоме панель вкладок
   * уходит вправо, чтобы карта получила всю высоту. В портрете и на
   * телефоне она остаётся снизу. Выбор панели запоминается в localStorage,
   * чтобы app.js применил его при построении стола.
   */
  function syncDeviceLayout(force) {
    var mode = deviceMode();
    if (!force && mode === lastDeviceMode) return;
    lastDeviceMode = mode;
    var bottom = mode !== 'tablet-landscape';
    try {
      global.localStorage.setItem('dnd-table.rightPanelPos', bottom ? 'bottom' : 'right');
      global.localStorage.setItem('dnd-table.leftPanelCollapsed', '1');
      // Высоту панели могли выставить на другом экране. Слишком большая
      // вытолкнет чат вниз, поэтому на телефоне и в портрете забываем её.
      var storedHeight = Number(global.localStorage.getItem('dnd-table.rightHeight'));
      var limit = mode === 'phone' ? 0.7 : (bottom ? 0.45 : 0.7);
      if (storedHeight && global.innerHeight && storedHeight > global.innerHeight * limit) {
        global.localStorage.removeItem('dnd-table.rightHeight');
      }
    } catch (error) {
      // Приватный режим: настройки просто не сохранятся.
    }
    // app.js выставит классы сам, но при повороте он этого не делает.
    // Поэтому сразу поправляем уже построенный стол, если он есть.
    if (typeof document.querySelector === 'function') {
      var layout = document.querySelector('.layout');
      if (layout) {
        layout.classList.toggle('is-right-bottom', bottom);
        layout.classList.add('is-left-collapsed');
      }
    }
  }

  /**
   * Мобильный слой грузится до app.js: иначе первый кадр рисуется настольной
   * сеткой, а потом прыгает в узкую.
   */
  function setupMobileShell() {
    try {
      document.documentElement.classList.add('is-android');
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '../android-mobile.css';
      document.head.appendChild(link);
    } catch (error) {
      // Без мобильных стилей приложение всё равно откроется.
    }
    syncDeviceLayout(true);
  }

  setupMobileShell();

  var resizeTimer = 0;
  if (typeof global.addEventListener === 'function') {
    global.addEventListener('resize', function onAndroidResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function afterAndroidResize() {
        syncDeviceLayout(false);
      }, 150);
    });
    global.addEventListener('orientationchange', function onAndroidOrientation() {
      syncDeviceLayout(false);
    });
  }

  /**
   * Ответ из Kotlin. Мост зовёт эту функцию, когда туннель поднят или упал.
   * @param {string} id
   * @param {string} json
   */
  global.__androidResult = function __androidResult(id, json) {
    var resolve = pending[id];
    if (!resolve) return;
    delete pending[id];
    try {
      resolve(JSON.parse(json));
    } catch (error) {
      resolve({ ok: false, error: 'Некорректный ответ Android' });
    }
  };

  /**
   * @param {string} name
   * @param {string} [arg]
   * @returns {Promise<object>}
   */
  function call(name, arg) {
    return new Promise(function executor(resolve) {
      if (!global.Android || typeof global.Android[name] !== 'function') {
        resolve({ ok: false, error: 'Мост Android недоступен' });
        return;
      }
      var id = String(nextId++);
      pending[id] = resolve;
      try {
        if (arg === undefined) global.Android[name](id);
        else global.Android[name](id, String(arg));
      } catch (error) {
        delete pending[id];
        resolve({ ok: false, error: String((error && error.message) || error) });
      }
    });
  }

  function desktopOnly() {
    return Promise.resolve({ ok: false, error: 'На Android доступен только вход за игрока' });
  }

  global.desktop = {
    isElectron: false,
    isAndroid: true,

    getConfig: function getConfig() {
      return Promise.resolve({
        dataDir: 'На устройстве',
        campaignsDir: '',
        portable: false,
        version: '1.7.0'
      });
    },

    listCampaigns: function listCampaigns() {
      return Promise.resolve({ campaigns: [] });
    },
    createCampaign: desktopOnly,
    loadCampaign: desktopOnly,
    saveCampaign: desktopOnly,
    backupCampaign: desktopOnly,
    deleteCampaign: desktopOnly,

    startHost: desktopOnly,
    stopHost: desktopOnly,
    hostStatus: function hostStatus() {
      return Promise.resolve({ running: false });
    },

    irohStart: desktopOnly,
    irohStop: function irohStop() {
      return call('stopTunnel');
    },
    irohCreateTicket: desktopOnly,
    irohConnect: desktopOnly,
    irohListPeers: function irohListPeers() {
      return Promise.resolve({ ok: true, peers: [] });
    },
    irohGetStatus: desktopOnly,
    irohId: function irohId() {
      return Promise.resolve({ ok: false, error: 'P2P доступен только на столе мастера' });
    },
    irohTunnelClient: function irohTunnelClient(ticket) {
      return call('joinP2p', ticket);
    },
    irohTunnelStop: function irohTunnelStop() {
      return call('stopTunnel');
    },

    pickAdventureFile: function pickAdventureFile() {
      return Promise.resolve({ canceled: true });
    },
    inspectAdventure: desktopOnly,
    importAdventure: desktopOnly,

    openSheetWindow: function openSheetWindow() {
      return Promise.resolve({ ok: false, error: 'Отдельное окно на Android не открывается' });
    },

    openDataDir: function openDataDir() {
      return Promise.resolve();
    },
    openExternal: function openExternal(url) {
      if (global.Android && typeof global.Android.openExternal === 'function') {
        global.Android.openExternal(String(url));
      }
      return Promise.resolve();
    },
    readClipboard: function readClipboard() {
      return call('readClipboard');
    },
    scanQr: function scanQr() {
      return call('scanQr');
    },

    onCampaignSaved: function onCampaignSaved() {
      return function unsubscribe() {};
    },
    onCampaignError: function onCampaignError() {
      return function unsubscribe() {};
    },
    onHostLog: function onHostLog() {
      return function unsubscribe() {};
    }
  };

  /**
   * Длинный билет удобнее вставить кнопкой или навести камеру на QR, чем
   * целиком тащить через долгое нажатие в поле.
   */
  function setupPasteTicket() {
    var paste = document.getElementById('btn-paste-ticket');
    var scan = document.getElementById('btn-scan-ticket');
    var input = document.getElementById('join-p2p-ticket');
    if (!input) return;

    function fillTicket(text) {
      input.value = String(text).trim();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    }

    function showError(result, fallback) {
      var status = document.getElementById('join-status');
      if (status) status.textContent = (result && result.error) || fallback;
    }

    if (paste) {
      paste.hidden = false;
      paste.addEventListener('click', function onPasteTicket() {
        global.desktop.readClipboard().then(function (result) {
          if (!result || !result.ok || !result.text) {
            showError(result, 'Буфер обмена пуст');
            return;
          }
          fillTicket(result.text);
        });
      });
    }

    if (scan) {
      scan.hidden = false;
      scan.addEventListener('click', function onScanTicket() {
        global.desktop.scanQr().then(function (result) {
          if (!result || !result.ok || !result.text) {
            showError(result, 'QR-код не распознан');
            return;
          }
          fillTicket(result.text);
        });
      });
    }
  }

  // На телефоне мастерских экранов нет: остаются вход за игрока, лист и настройки.
  function applyMobileLayout() {
    document.body.classList.add('is-android');
    setupPasteTicket();
  }

  window.dndAndroidBack = function dndAndroidBack() {
    var table = document.getElementById('screen-table');
    var leave = document.getElementById('btn-leave');
    if (table && table.classList.contains('is-active') && leave) {
      leave.click();
      return true;
    }
    return false;
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyMobileLayout);
  } else {
    applyMobileLayout();
  }
}(window));
