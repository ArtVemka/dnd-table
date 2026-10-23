'use strict';

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('Android', {
  joinP2p() {},
  stopTunnel() {},
  openExternal() {}
});
