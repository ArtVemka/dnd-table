'use strict';

/**
 * Сборка NSIS-установщика.
 *
 * electron-builder 26 запускает промежуточный uninstaller с окружением, где
 * остался только __COMPAT_LAYER. Без TEMP NSIS не может создать временные
 * файлы, и сборка падает с «Error writing temporary file». Подмешиваем
 * окружение всем дочерним процессам и даём сборке отдельный temp.
 */

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const cli = require.resolve('electron-builder/out/cli/cli.js');
const temp = path.join(__dirname, '..', 'dist-final', '.tmp');
fs.mkdirSync(temp, { recursive: true });
process.env.TEMP = temp;
process.env.TMP = temp;

const execFile = childProcess.execFile;
childProcess.execFile = function (file, args, options, callback) {
  if (options && typeof options === 'object' && options.env) {
    options = { ...options, env: { ...process.env, ...options.env } };
  }
  return execFile.call(this, file, args, options, callback);
};

process.argv = [process.argv[0], cli, '--win', 'nsis', '--publish', 'never'];
require(cli);
