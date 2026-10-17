'use strict';

/**
 * Снимки экранов в каждой теме. Нужен, чтобы оценить оформление глазами:
 * цифры в CSS ничего не говорят о том, как это выглядит.
 *
 * Запуск: npx electron scripts/make-shots.js [папка]
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const outDir = process.argv[2] || path.join(root, 'shots');
const THEMES = ['standart', 'les', 'magiya', 'okean', 'traktir'];

/** Данные для показа стола: слева участники, справа чат, в центре карта. */
const TABLE_FIXTURE = `
  (() => {
    document.querySelectorAll('.screen').forEach((node) => node.classList.remove('is-active'));
    document.querySelector('#screen-table').classList.add('is-active');

    const players = [
      { playerId: 'dm', name: 'Мастер', role: 'dm', online: true, hasSheet: false, tokenId: null, avatar: 'avatar-dm.png' },
      { playerId: 'p-1', name: 'Артём', role: 'player', online: true, hasSheet: true, tokenId: 't2', avatar: null },
      { playerId: 'p-2', name: 'Борис', role: 'player', online: true, hasSheet: true, tokenId: 't3', avatar: null },
      { playerId: 'p-3', name: 'Вера', role: 'player', online: false, hasSheet: true, tokenId: null, avatar: null }
    ];
    const tokens = [
      { id: 't1', name: 'Гоблин', mapType: 'world', x: 0.28, y: 0.68, imageUrl: null, assignedPlayerId: null, color: '#c96f4a', hidden: true },
      { id: 't2', name: 'Тордин', mapType: 'world', x: 0.38, y: 0.42, imageUrl: null, assignedPlayerId: 'p-1', color: '#4a8fc9', hidden: false },
      { id: 't3', name: 'Мира', mapType: 'world', x: 0.58, y: 0.52, imageUrl: null, assignedPlayerId: 'p-2', color: '#6fb45f', hidden: false },
      { id: 't4', name: 'Кобольд', mapType: 'world', x: 0.7, y: 0.3, imageUrl: null, assignedPlayerId: null, color: '#b08fc9', hidden: false }
    ];
    const history = [
      { from: 'Артём', playerId: 'p-1', role: 'player', text: 'бросил d20: 17', isRoll: true, time: new Date().toISOString() },
      { from: 'Мастер', playerId: 'dm', role: 'dm', text: 'Гоблин замечает вас. В бой!', time: new Date().toISOString() },
      { from: 'Борис', playerId: 'p-2', role: 'player', text: 'Кастую щит', time: new Date().toISOString() }
    ];

    const ui = window.TableUI;
    const rootPlayers = document.querySelector('#players-root');
    const list = new ui.PlayersList(rootPlayers, { resolveUrl: (url) => url || '' });
    list.render(players, { role: 'dm', playerId: 'dm' });

    const chat = new ui.ChatPanel(document.querySelector('#tab-chat'), { resolveUrl: (url) => url || '' });
    chat.renderAll(history);

    const tokensPanel = new ui.TokenPanel(document.querySelector('#tab-tokens'), {});
    tokensPanel.render(tokens, players, { role: 'dm', playerId: 'dm' });

    const dice = new ui.DicePanel(document.querySelector('#tab-dice'), {});
    dice.renderAll([{ playerName: 'Артём', sides: 20, result: 17, time: new Date().toISOString() }]);

    const map = new ui.MapView(document.querySelector('#map-root'), { resolveUrl: (url) => url || '' });
    map.render({
      maps: { world: { items: [], activeId: null }, battle: { items: [], activeId: null }, sketch: { items: [], activeId: null } },
      activeMap: 'world',
      grid: { enabled: true, cell: 46, columns: 0 },
      tokens,
      players
    }, { role: 'dm', playerId: 'dm' });

    return true;
  })()
`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    frame: false,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      // Заглушка preload: без неё приложение откажется открываться.
      preload: path.join(__dirname, 'shot-preload.js')
    }
  });
  await win.loadFile(path.join(root, 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 1000));

  for (const theme of THEMES) {
    await win.webContents.executeJavaScript(
      `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; true`
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `home-${theme}.png`), image.toPNG());
  }

  // Стол: он и есть рабочее место, главный экран виден мельком.
  await win.webContents.executeJavaScript(TABLE_FIXTURE);
  await new Promise((resolve) => setTimeout(resolve, 700));
  for (const theme of THEMES) {
    await win.webContents.executeJavaScript(
      `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; true`
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `table-${theme}.png`), image.toPNG());
  }

  // Вкладка кубиков: крупный результат и кольцо броска.
  await win.webContents.executeJavaScript(
    "document.querySelector('.tabs__btn[data-tab=\"dice\"]').click(); true"
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  let image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'table-dice.png'), image.toPNG());

  // Лист персонажа: самая плотная страница приложения.
  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelector('.tabs__btn[data-tab="sheet"]').click();
      const host = document.querySelector('#tab-sheet');
      host.innerHTML = '';
      const view = new window.SheetView(host, { resolveUrl: (url) => url || '' });
      const sheet = window.DnD5e.createEmptySheet();
      sheet.characterName = 'Тордин';
      sheet.playerName = 'Артём';
      sheet.charClass = 'Волшебник';
      sheet.race = 'Эльф';
      sheet.level = 5;
      sheet.abilities = { str: 10, dex: 14, con: 13, int: 18, wis: 12, cha: 9 };
      sheet.skillProficiencies = { arcana: true, history: true, insight: true };
      sheet.skillExpertise = { investigation: true };
      sheet.ac = 15;
      sheet.hp = 27;
      sheet.hitDice = '1d6';
      view.setMode('sheet');
      view.setSheet(sheet);
      view.setStatus('Имя игрока: Артём');
      return true;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 600));
  image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'sheet.png'), image.toPNG());

  // Экран подключения: первое, что видит игрок.
  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelectorAll('.screen').forEach((node) => node.classList.remove('is-active'));
      document.querySelector('#screen-join').classList.add('is-active');
      return true;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 500));
  image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'join.png'), image.toPNG());

  // Узкое окно: окно можно ужать, и главный экран не должен разъезжаться.
  await win.webContents.executeJavaScript(
    "document.querySelectorAll('.screen').forEach((node) => node.classList.remove('is-active'));"
    + "document.querySelector('#screen-home').classList.add('is-active');"
    + "document.querySelectorAll('.screen').forEach((node) => { node.scrollTop = 0; }); true"
  );
  win.setContentSize(520, 700);
  await new Promise((resolve) => setTimeout(resolve, 700));
  image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'home-narrow.png'), image.toPNG());
  win.setContentSize(1440, 900);
  await new Promise((resolve) => setTimeout(resolve, 500));

  console.log('снимки готовы');
  app.exit(0);
});
