'use strict';

/**
 * Мост между renderer и main-процессом.
 * contextIsolation включён, nodeIntegration выключен — renderer видит только
 * этот явный список функций, никакого прямого доступа к Node.js у него нет.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** @param {string} channel @param {(payload: any) => void} callback */
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('desktop', {
  isElectron: true,

  getConfig: () => ipcRenderer.invoke('app:config'),

  // Кампании
  listCampaigns: () => ipcRenderer.invoke('campaign:list'),
  createCampaign: (name) => ipcRenderer.invoke('campaign:create', name),
  loadCampaign: (id) => ipcRenderer.invoke('campaign:load', id),
  currentCampaign: () => ipcRenderer.invoke('campaign:current'),
  saveCampaign: () => ipcRenderer.invoke('campaign:save'),
  deleteCampaign: (id) => ipcRenderer.invoke('campaign:delete', id),

  // Стол (сервер в main-процессе)
  startHost: () => ipcRenderer.invoke('host:start'),
  stopHost: () => ipcRenderer.invoke('host:stop'),
  hostStatus: () => ipcRenderer.invoke('host:status'),

  // iroh — P2P-подключения между участниками стола
  irohStart: () => ipcRenderer.invoke('iroh:start'),
  irohStop: () => ipcRenderer.invoke('iroh:stop'),
  irohCreateTicket: () => ipcRenderer.invoke('iroh:create-ticket'),
  irohConnect: (ticketStr) => ipcRenderer.invoke('iroh:connect', ticketStr),
  irohListPeers: () => ipcRenderer.invoke('iroh:list-peers'),
  irohGetStatus: () => ipcRenderer.invoke('iroh:get-status'),
  irohId: () => ipcRenderer.invoke('iroh:id'),
  irohTunnelClient: (ticketStr) => ipcRenderer.invoke('iroh:tunnel-client', ticketStr),
  irohTunnelStop: () => ipcRenderer.invoke('iroh:tunnel-stop'),

  // Подписки на iroh-события
  onIrohPeerJoined: (callback) => subscribe('iroh:peer-joined', callback),
  onIrohPeerLeft: (callback) => subscribe('iroh:peer-left', callback),
  onIrohPeersUpdate: (callback) => subscribe('iroh:peers-update', callback),

  // Лист персонажа в отдельном окне
  openSheetWindow: (request) => ipcRenderer.invoke('sheet:openWindow', request),

  // Файлы
  openDataDir: () => ipcRenderer.invoke('shell:openDataDir'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Подписки
  onCampaignSaved: (callback) => subscribe('campaign:saved', callback),
  onCampaignError: (callback) => subscribe('campaign:error', callback),
  onHostLog: (callback) => subscribe('host:log', callback)
});
