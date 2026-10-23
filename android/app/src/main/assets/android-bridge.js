(function initAndroidBridge(global) {
  'use strict';

  var pending = Object.create(null);
  var nextId = 1;

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
    try {
      if (global.innerWidth && global.innerWidth < 900) {
        // На телефоне вкладки живут под картой, а не справа: иначе колонка
        // шире экрана и правый край чата обрезан.
        global.localStorage.setItem('dnd-table.rightPanelPos', 'bottom');
        global.localStorage.setItem('dnd-table.leftPanelCollapsed', '1');
        // Высоту панели могли выставить на планшете. На маленьком экране
        // она вытолкнет поле чата вниз, поэтому слишком большую забываем.
        var storedHeight = Number(global.localStorage.getItem('dnd-table.rightHeight'));
        if (storedHeight && global.innerHeight && storedHeight > global.innerHeight * 0.7) {
          global.localStorage.removeItem('dnd-table.rightHeight');
        }
      }
    } catch (error) {
      // Приватный режим: настройки просто не сохранятся.
    }
  }

  setupMobileShell();

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
   * Длинный билет удобнее вставить кнопкой, чем целиком тащить через
   * долгое нажатие в поле.
   */
  function setupPasteTicket() {
    var button = document.getElementById('btn-paste-ticket');
    var input = document.getElementById('join-p2p-ticket');
    if (!button || !input) return;
    button.hidden = false;
    button.addEventListener('click', function onPasteTicket() {
      global.desktop.readClipboard().then(function (result) {
        if (!result || !result.ok || !result.text) {
          var status = document.getElementById('join-status');
          if (status) status.textContent = (result && result.error) || 'Буфер обмена пуст';
          return;
        }
        input.value = String(result.text).trim();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      });
    });
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
