'use strict';

/**
 * Собирает указатель предметов dnd.su: название → ссылка на статью.
 *
 * Почему так, а не поиск при импорте:
 *   поиск на dnd.su не их собственный, это виджет Яндекса — страница
 *   /search/?q=… отдаёт пустую оболочку, и разбирать в ней нечего;
 *   свой каталог /piece/items/index-list/ отдаёт весь список статикой, без
 *   JavaScript, и в каждой строке есть и ссылка, и названия на двух языках.
 *
 * Указатель собирается один раз и едет вместе с игрой: мастер кликает по
 * названию предмета и попадает на статью мгновенно, без сети и без битых
 * ссылок. Предмета в указателе нет — значит и ссылки не будет.
 *
 * Запуск: npm run dnd-index
 */

const fs = require('fs');
const path = require('path');

const LIST_URL = 'https://dnd.su/piece/items/index-list/';
const OUT = path.join(__dirname, '..', 'renderer', 'dnd-items.json');

/**
 * Достаёт из строки каталога предмет: ссылку, русское и английское названия.
 * Разметка устойчивая: всё нужное лежит в href и в data-search.
 * @param {string} chunk кусок html с одним предметом
 * @returns {{url: string, names: string[]}|null}
 */
function parseItem(chunk) {
  const href = /href='(\/items\/[^']+)'/.exec(chunk) || /href="(\/items\/[^"]+)"/.exec(chunk);
  if (!href) return null;
  const search = /data-search='([^']*)'/i.exec(chunk);
  const title = /<div class='list-item-title'>\s*([^<]+?)\s*<\/div>/.exec(chunk);
  const names = [];
  if (title) names.push(title[1]);
  // data-search: «Русское название,English name,» — запятая в конце.
  if (search) {
    for (const part of search[1].split(',')) {
      const value = part.trim();
      if (value) names.push(value);
    }
  }
  return names.length ? { url: 'https://dnd.su' + href[1], names } : null;
}

/** Приводит название к виду, по которому ищем: без регистра и лишних пробелов. */
function key(name) {
  return String(name).replace(/\s+/g, ' ').trim().toLowerCase();
}

async function main() {
  console.log(`Забираю каталог: ${LIST_URL}`);
  const response = await fetch(LIST_URL, {
    headers: { 'user-agent': 'dnd-table-index-builder (one-off build step)' }
  });
  if (!response.ok) throw new Error(`Сайт ответил ${response.status}`);
  const html = await response.text();

  // Режем html по границам карточек: так не нужен полноценный парсер.
  const chunks = html.split("<div class='col list-item__spell").slice(1);
  const index = {};
  let duplicates = 0;
  for (const chunk of chunks) {
    const item = parseItem(chunk);
    if (!item) continue;
    for (const name of item.names) {
      const id = key(name);
      // Первое совпадение побеждает: порядок каталога примерно алфавитный,
      // а повторяются в основном англоязычные синонимы.
      if (index[id] && index[id] !== item.url) duplicates += 1;
      else index[id] = item.url;
    }
  }

  const count = Object.keys(index).length;
  if (count < 100) throw new Error(`подозрительно мало предметов: ${count}, разбор сломался`);
  fs.writeFileSync(OUT, `${JSON.stringify(index, null, 0)}\n`, 'utf8');
  console.log(`Готово: ${count} названий, ${chunks.length} предметов, расхождений по дубликатам: ${duplicates}`);
  console.log(`Файл: ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} КБ)`);
  for (const probe of ['Ключ', 'Волшебная палочка', 'Доспех', 'Кинжал']) {
    const found = index[key(probe)];
    console.log(`  ${found ? 'найдено' : 'нет'}  ${probe} → ${found || '—'}`);
  }
}

main().catch((error) => {
  console.error(`Не получилось: ${error.message}`);
  process.exit(1);
});
