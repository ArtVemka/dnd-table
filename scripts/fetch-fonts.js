'use strict';

/**
 * Скачивание веб-шрифта для приложения.
 *
 * Шрифт лежит рядом с интерфейсом, а не тянется из сети: игра работает
 * офлайн, и без интернета заголовки не должны превращаться в закорки.
 *
 * Google отдаёт шрифт по подмножествам (latin, cyrillic и прочие), и каждое
 * весит двадцать килобайт вместо полумегабайтного целого. Забираем нужные
 * подмножества и переписываем адреса на локальные.
 *
 * Запуск: node scripts/fetch-fonts.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'renderer', 'fonts');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Семейство: какие подмножества и начертания забираем. */
const FAMILIES = [
  { css: 'Cormorant:wght@500;600;700', label: 'cormorant' }
];

/** Подмножества, которые берём. Вьетнамский не нужен: этих букв в игре нет. */
const WANTED_SUBSETS = ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext'];

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA, ...headers } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolve(get(response.headers.location, headers));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`${url} -> ${response.statusCode}`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

/**
 * Разбирает @font-face от Google: подмножество определяется по комментарию
 * перед блоком, начертание и диапазон — по содержимому блока.
 */
function parseFaces(css) {
  const faces = [];
  const pattern = /\/\*\s*([a-z-]+)\s*\*\/\s*@font-face\s*\{([^}]+)\}/g;
  let match = pattern.exec(css);
  while (match) {
    const [, subset, body] = match;
    const weight = (body.match(/font-weight:\s*(\d+)/) || [])[1];
    const range = (body.match(/unicode-range:\s*([^;]+);/) || [])[1];
    const url = (body.match(/url\((https:[^)]+)\)/) || [])[1];
    if (weight && url && range) faces.push({ subset, weight, range, url });
    match = pattern.exec(css);
  }
  return faces;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rules = [];

  for (const family of FAMILIES) {
    const css = (await get(`https://fonts.googleapis.com/css2?family=${family.css}&display=swap`)).toString('utf8');
    const faces = parseFaces(css);
    for (const face of faces) {
      if (!WANTED_SUBSETS.includes(face.subset)) continue;
      const name = `${family.label}-${face.subset}-${face.weight}.woff2`;
      const file = path.join(OUT_DIR, name);
      if (!fs.existsSync(file)) {
        const data = await get(face.url);
        fs.writeFileSync(file, data);
        console.log(`  ${name} — ${Math.round(data.length / 1024)} КБ`);
      }
      rules.push(
        '@font-face {',
        `  font-family: '${family.label}';`,
        '  font-style: normal;',
        `  font-weight: ${face.weight};`,
        '  font-display: swap;',
        // Ссылка относительно самого fonts.css, который лежит рядом со шрифтами.
        `  src: url('${name}') format('woff2');`,
        `  unicode-range: ${face.range.trim()};`,
        '}'
      );
    }
  }

  const cssFile = path.join(OUT_DIR, 'fonts.css');
  const header = [
    '/*',
    ' * Шрифты приложения.',
    ' *',
    ' * Лежат рядом с интерфейсом, а не тянутся из сети: игра работает офлайн.',
    ' * Подмножества (latin, cyrillic и прочие) разложены по файлам, браузер',
    ' * подгружает только нужный — кириллица весит отдельно от латиницы.',
    ' *',
    ' * Файл собирается scripts/fetch-fonts.js, вручную его править не нужно.',
    ' */',
    ''
  ].join('\n');
  fs.writeFileSync(cssFile, `${header}${rules.join('\n')}\n`, 'utf8');
  console.log(`правил @font-face: ${rules.length / 8}`);
  console.log(`файл: ${path.relative(ROOT, cssFile)}`);
}

main().catch((error) => {
  console.error('не получилось:', error.message);
  process.exit(1);
});
