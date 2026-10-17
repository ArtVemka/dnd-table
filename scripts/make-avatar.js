'use strict';

/**
 * Растеризация портрета мастера: build/avatar-dm.svg -> renderer/avatar-dm.png.
 *
 * Зачем два файла: в игру попадает только PNG, а SVG остаётся исходником, по
 * которому картинку можно перерисовать. В репозитории хранится и то, и другое.
 *
 * Растеризует сам Electron: это Chromium, и поднимать ради одной картинки
 * отдельную зависимость не хочется.
 *
 * Запуск: npx electron scripts/make-avatar.js
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'avatar-dm.svg');
const OUT = path.join(ROOT, 'renderer', 'avatar-dm.png');
const SIZE = 512;

if (!fs.existsSync(SRC)) {
  console.error(`Нет исходника ${SRC}`);
  app.exit(2);
}

// Программная отрисовка без GPU: иначе на машинах без видеокарты скрипт падает.
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SRC, 'utf8');
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  });

  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;width:${SIZE}px;height:${SIZE}px;overflow:hidden}
img{display:block;width:${SIZE}px;height:${SIZE}px}</style>
<img src="data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}">`;

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  // Ждём, пока картинка реально разобралась: иначе capturePage снимет пустоту.
  const decoded = await win.webContents.executeJavaScript(
    `new Promise((resolve) => {
       const img = document.querySelector('img');
       if (!img) return resolve(false);
       if (img.complete && img.naturalWidth) return resolve(true);
       img.addEventListener('load', () => resolve(true), { once: true });
       img.addEventListener('error', () => resolve(false), { once: true });
       setTimeout(() => resolve(img.complete), 5000);
     })`
  );
  if (!decoded) {
    console.error('SVG не отрисовался, PNG не записан');
    app.exit(1);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 400));

  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, png);
  const size = image.getSize();
  console.log(`Готово: ${path.relative(ROOT, OUT)} — ${size.width}x${size.height}, ${png.length} байт`);
  app.exit(0);
});
