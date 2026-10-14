'use strict';

/**
 * Скачивает настоящую выгрузку Foundry для проверки импорта.
 *
 * Файлы чужие, поэтому их не коммитят: скрипт кладёт их в
 * test/fixtures/foundry, откуда их читает scripts/make-foundry-demo.js.
 *
 * Запуск: node scripts/fetch-foundry-sample.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'foundry');

/**
 * Куда смотрим. Это открытая выгрузка приключения под открытой лицензией,
 * выложенная сообществом; нужна, чтобы проверять импорт на настоящей форме
 * документов, а не только на синтетике.
 */
const REPO = 'matthewbstroud/sdnd-strahd-adv';
const FILES = [
  'src/packs/snd-curse-of-strahd/Area_X__The_Amber_Temple_4L2FJjtLw6lDLgsA.json',
  'src/packs/snd-curse-of-strahd/All_Actors_ucjORqktRyLWWQKZ.json'
];

function fetchFile(repo, file, target) {
  // Забираем содержимое без base64: -H Accept: application/vnd.github.raw
  // отдаёт файл как есть, иначе пришлось бы разворачивать обёртку API.
  const content = execFileSync(
    'gh',
    ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${file}`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  fs.writeFileSync(target, content, 'utf8');
  console.log(`  ${path.basename(target)} — ${(Buffer.byteLength(content) / 1024 / 1024).toFixed(2)} МБ`);
}

function main() {
  if (!execFileSync('where', ['gh'], { stdio: 'ignore' }) && process.platform === 'win32') {
    // where без ошибки — gh есть в PATH
  }
  fs.mkdirSync(FIXTURES, { recursive: true });
  console.log(`Качаю выгрузку Foundry из ${REPO}:`);
  for (const file of FILES) {
    fetchFile(REPO, file, path.join(FIXTURES, path.basename(file)));
  }
  console.log('\nГотово. Теперь соберите архив для проверки:');
  console.log('  node scripts/make-foundry-demo.js');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Не получилось: ${error.message}`);
    console.error('Нужен gh (GitHub CLI) с авторизацией: https://cli.github.com');
    process.exit(1);
  }
}
