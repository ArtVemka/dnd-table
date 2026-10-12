'use strict';

/**
 * Мост отдельного окна листа персонажа.
 *
 * Окно получает не сам секрет стола, а только ссылку на него: контекст
 * (адрес стола, hostKey, чей лист показывать) лежит в main-процессе, а окно
 * забирает его по своему случайному идентификатору. Так hostKey не попадает
 * ни в командную строку процесса, ни в файлы.
 */

const { contextBridge, ipcRenderer } = require('electron');

function contextId() {
  const argument = process.argv.find((item) => item.startsWith('--sheet-context-id='));
  return argument ? argument.slice('--sheet-context-id='.length) : '';
}

contextBridge.exposeInMainWorld('sheetWindow', {
  isElectron: true,
  getContext: () => ipcRenderer.invoke('sheet:context', contextId())
});
