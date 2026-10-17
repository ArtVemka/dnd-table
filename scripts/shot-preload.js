'use strict';

/**
 * Заглушка preload для снимков экрана.
 *
 * Настоящий мост живёт в main-процессе, а снимки делаются в простом окне
 * Electron без него. Здесь нужен только минимум, чтобы главный экран
 * отрисовался: без заглушки приложение честно отказывается работать.
 */

const noop = () => {};
const listen = () => () => {};

// contextBridge обязателен: preload выполняется в изолированном контексте, и
// без проброса страница не увидит window.desktop (как и в настоящем preload).
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getConfig: async () => ({
    version: '0.12.1-b',
    dataDir: 'C:\\D&D Стол\\data',
    portable: true,
    theme: 'standart',
    grid: { enabled: false, cell: 46, columns: 0 }
  }),
  listCampaigns: async () => [],
  hostStatus: async () => ({ running: false }),
  irohStart: async () => ({ ok: false, error: 'снимок' }),
  irohStop: async () => ({ ok: true }),
  irohCreateTicket: async () => ({ ok: false, error: 'снимок' }),
  irohTunnelClient: async () => ({ ok: false, error: 'снимок' }),
  irohTunnelStop: async () => ({ ok: true }),
  openDataDir: noop,
  openExternal: noop,
  openSheetWindow: async () => ({ ok: true }),
  onCampaignError: listen,
  onCampaignSaved: listen
});
