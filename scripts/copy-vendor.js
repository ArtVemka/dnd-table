'use strict';

/**
 * Копирует браузерную сборку socket.io-client из node_modules в renderer/vendor.
 * Нужно, чтобы renderer (он работает по file://) мог подключаться и к своему
 * локальному серверу, и к удалённому столу, не завися от внешних CDN.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js');
const targetDir = path.join(root, 'renderer', 'vendor');
const target = path.join(targetDir, 'socket.io.min.js');

function copyVendor() {
  if (!fs.existsSync(source)) {
    console.warn('[vendor] Не найден', source, '- выполните npm install');
    return false;
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(source, target);
  return true;
}

if (require.main === module) {
  copyVendor();
}

module.exports = { copyVendor };
