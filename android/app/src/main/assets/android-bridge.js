(function initAndroidBridge(global) {
  'use strict';

  var pending = Object.create(null);
  var nextId = 1;

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

  // На телефоне мастерских экранов нет: остаются вход за игрока, лист и настройки.
  function applyMobileLayout() {
    document.body.classList.add('is-android');
    var style = document.createElement('style');
    style.textContent =
      '.is-android .home__group:first-child,' +
      '.is-android #home-datadir,' +
      '.is-android #btn-open-datadir{display:none!important}';
    document.head.appendChild(style);
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
