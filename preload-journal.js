'use strict';

/**
 * Мост отдельного окна журнала.
 *
 * Как и окно листа, оно получает не сам секрет стола, а ссылку на контекст в
 * main-процессе. Так hostKey не попадает ни в командную строку, ни в файлы.
 */

const { contextBridge, ipcRenderer } = require('electron');

function contextId() {
  const argument = process.argv.find((item) => item.startsWith('--journal-context-id='));
  return argument ? argument.slice('--journal-context-id='.length) : '';
}

contextBridge.exposeInMainWorld('journalWindow', {
  isElectron: true,
  getContext: () => ipcRenderer.invoke('journal:context', contextId())
});
