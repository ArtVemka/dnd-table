'use strict';
/**
 * Монстр из Open5e: разбор карточки и русский запрос.
 *
 * Сеть здесь не нужна: проверяются чистые функции. Перевод и скачивание
 * картинки остаются в main-процессе, их проверяет ручной импорт.
 */
const open5e = require('../server/open5e');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const GOBLIN = {
  key: 'test_goblin',
  name: 'Goblin',
  size: { key: 'small', name: 'Small' },
  type: { key: 'humanoid', name: 'Humanoid' },
  challenge_rating: 0.25,
  armor_class: 15,
  hit_points: 7,
  speed: { walk: 30, fly: 10 },
  ability_scores: { strength: 8, dexterity: 14, constitution: 10, intelligence: 10, wisdom: 8, charisma: 8 },
  darkvision_range: 60,
  passive_perception: 9,
  languages: { as_string: 'Common, Goblin' },
  resistances_and_immunities: { damage_resistances_display: 'fire' },
  actions: [
    { name: 'Scimitar', desc: 'Melee Weapon Attack: +4 to hit.', action_type: 'ACTION', order_in_statblock: 0 },
    { name: 'Nimble Escape', desc: 'The goblin takes the Disengage or Hide action.', action_type: 'BONUS_ACTION', order_in_statblock: 1 }
  ],
  traits: [
    { name: 'Sneaky', desc: 'The goblin has advantage on Dexterity (Stealth) checks.' }
  ],
  document: { key: 'test', display_name: 'Test Bestiary', gamesystem: { name: '5th Edition 2014' } }
};

check('русское название ищется по словарю без переводчика', async () => {
  const result = await open5e.resolveEnglish('гоблин');
  if (result.english !== 'Goblin') throw new Error(`перевод: ${result.english}`);
  if (result.via !== 'dictionary') throw new Error(`источник перевода: ${result.via}`);
});

check('английский запрос уходит как есть', async () => {
  const result = await open5e.resolveEnglish('Adult Red Dragon');
  if (result.english !== 'Adult Red Dragon') throw new Error(`изменился запрос: ${result.english}`);
  if (result.translated) throw new Error('английский запрос не должен считаться переводом');
});

check('пустой запрос не превращается в поиск всего', async () => {
  const result = await open5e.resolveEnglish('   ');
  if (result.english !== '') throw new Error(`пустой запрос стал «${result.english}»`);
});

check('CR печатается долями, а не десятичной дробью', () => {
  const cases = [[0.125, '1/8'], [0.25, '1/4'], [0.5, '1/2'], [1, '1'], [11, '11']];
  for (const [value, expected] of cases) {
    if (open5e.formatCr(value) !== expected) {
      throw new Error(`CR ${value}: получили ${open5e.formatCr(value)}, ждали ${expected}`);
    }
  }
});

check('размер превращается в клетки', () => {
  const cases = [['tiny', 1], ['small', 1], ['medium', 1], ['large', 2], ['huge', 3], ['gargantuan', 4]];
  for (const [key, expected] of cases) {
    if (open5e.sizeToCells(key) !== expected) {
      throw new Error(`размер ${key}: ${open5e.sizeToCells(key)} клеток, ждали ${expected}`);
    }
  }
});

check('скорости собираются в одну строку', () => {
  const text = open5e.formatSpeed({ walk: 30, fly: 60, swim: 40 });
  if (text !== '30 фт, полёт 60 фт, плавание 40 фт') throw new Error(`скорость: ${text}`);
});

check('карточка переносит числа, способности и текст', () => {
  const result = open5e.buildActor(GOBLIN, {
    name: 'Гоблин',
    actions: [
      { name: 'Ятаган', desc: 'Рукопашная атака: +4 к попаданию.', action_type: 'ACTION', order_in_statblock: 0 },
      { name: 'Ловкий побег', desc: 'Гоблин совершает Отход или Прячется.', action_type: 'BONUS_ACTION', order_in_statblock: 1 }
    ],
    traits: [{ name: 'Скрытный', desc: 'Преимущество на проверки Скрытности.' }],
    languages: 'Обычный, Гоблин',
    resistances: 'огонь'
  });
  const block = result.actor.statblock;
  const fail = (message) => { throw new Error(message); };
  if (block.ac !== 15) fail(`КД: ${block.ac}`);
  if (block.hp !== 7) fail(`хиты: ${block.hp}`);
  if (block.speed !== '30 фт, полёт 10 фт') fail(`скорость: ${block.speed}`);
  if (block.size !== 1) fail(`размер: ${block.size}`);
  if (block.cr !== '1/4') fail(`CR: ${block.cr}`);
  if (block.abilities.dex !== 14) fail(`ловкость: ${block.abilities.dex}`);
  if (!block.attacks.includes('Действия:') || !block.attacks.includes('Ятаган')) {
    fail(`атаки: ${block.attacks}`);
  }
  if (!block.attacks.includes('Бонусные действия:')) fail(`бонусные действия: ${block.attacks}`);
  if (!block.notes.includes('Особенности:') || !block.notes.includes('Скрытный')) fail(`особенности: ${block.notes}`);
  if (!block.notes.includes('Языки: Обычный, Гоблин')) fail(`языки: ${block.notes}`);
  if (!block.notes.includes('Сопротивления: огонь')) fail(`сопротивления: ${block.notes}`);
  if (result.actor.name !== 'Гоблин') fail(`имя: ${result.actor.name}`);
  if (result.actor.type !== 'npc') fail(`тип актёра: ${result.actor.type}`);
  if (result.actor.sourceId !== 'open5e:test_goblin') fail(`источник: ${result.actor.sourceId}`);
  if (result.meta.type !== 'Гуманоид' || result.meta.size !== 'Маленький') {
    fail(`мета: ${JSON.stringify(result.meta)}`);
  }
});

check('порядок действий берётся из статблока, а не из ответа', () => {
  const text = open5e.formatActions([
    { name: 'Второе', desc: 'b', action_type: 'ACTION', order_in_statblock: 1 },
    { name: 'Первое', desc: 'a', action_type: 'ACTION', order_in_statblock: 0 },
    { name: 'Ответ', desc: 'r', action_type: 'REACTION', order_in_statblock: 0 }
  ]);
  if (text.indexOf('Первое') > text.indexOf('Второе')) throw new Error(`порядок действий: ${text}`);
  if (text.indexOf('Ответ') < text.indexOf('Действия:')) throw new Error(`реакция попала не в свой раздел: ${text}`);
});

check('длинный текст режется по пределу поля', () => {
  const long = 'очень длинное описание '.repeat(1000);
  const result = open5e.buildActor(GOBLIN, {
    name: 'Гоблин',
    actions: [{ name: 'Атака', desc: long }],
    traits: [{ name: 'Особенность', desc: long }]
  });
  if (result.actor.statblock.attacks.length > 4000) {
    throw new Error(`атаки длиннее предела: ${result.actor.statblock.attacks.length}`);
  }
  if (result.actor.statblock.notes.length > 4000) {
    throw new Error(`особенности длиннее предела: ${result.actor.statblock.notes.length}`);
  }
});

check('языки переводятся по одному, а не склеиваются', () => {
  const text = open5e.translateLanguages('Common, Goblin, telepathy 120 ft.');
  if (text !== 'Обычный, Гоблин, телепатия 120 фт') throw new Error(`языки: ${text}`);
});

check('поисковый адрес экранирует название', () => {
  const url = open5e.searchUrl('Adult Red Dragon');
  if (!url.includes('name__icontains=Adult%20Red%20Dragon')) throw new Error(`адрес: ${url}`);
});

check('запрос арта собирается из английского имени', () => {
  const query = open5e.artQuery('Bandit');
  if (query !== 'Bandit D&D art') throw new Error(`запрос арта: ${query}`);
});

check('ссылка на картинку пропускает только http(s), а не javascript', () => {
  if (open5e.normalizeImageUrl('javascript:alert(1)')) throw new Error('пропущен javascript');
  if (open5e.normalizeImageUrl('http://127.0.0.1/a.png')) throw new Error('пропущен localhost');
  if (open5e.normalizeImageUrl('/files/goblin.png') !== 'https://api.open5e.com/files/goblin.png') {
    throw new Error('относительный путь Open5e не стал абсолютным');
  }
  if (open5e.normalizeImageUrl('https://example.com/goblin.png') !== 'https://example.com/goblin.png') {
    throw new Error('обычный https-адрес не прошёл');
  }
});

check('Openverse отдаёт прямую ссылку и подпись', () => {
  const found = open5e.pickOpenverseImage({
    results: [
      { title: 'Goblin', creator: 'Artist', license: 'by', url: 'https://example.com/goblin.jpg' },
      { title: 'Broken', url: 'javascript:alert(1)' }
    ]
  });
  if (!found || found.url !== 'https://example.com/goblin.jpg') throw new Error('картинка не найдена');
  if (!found.credit.includes('Goblin') || !found.credit.includes('CC BY')) {
    throw new Error(`подпись: ${found.credit}`);
  }
});

check('Google и Bing дают прямые ссылки из своих ответов', () => {
  const google = open5e.pickGoogleImage({ items: [{ title: 'Goblin', link: 'https://example.com/g.jpg', displayLink: 'example.com' }] });
  if (!google || google.url !== 'https://example.com/g.jpg') throw new Error('Google не разобран');
  const bing = open5e.pickBingImage({ value: [{ name: 'Goblin', contentUrl: 'https://example.com/b.jpg', hostPageUrl: 'https://example.com/page' }] });
  if (!bing || bing.url !== 'https://example.com/b.jpg') throw new Error('Bing не разобран');
});

check('вики Забытых королевств отдаёт картинку страницы', () => {
  const found = open5e.pickFandomImage({
    query: {
      pages: {
        2: { index: 2, title: 'Dekanter goblin', thumbnail: { source: 'https://example.com/dekanter.jpg', width: 600 } },
        1: { index: 1, title: 'Goblin', thumbnail: { source: 'https://example.com/goblin.jpg', width: 601 } }
      }
    }
  });
  if (!found || found.url !== 'https://example.com/goblin.jpg') throw new Error('вики не разобрана');
  if (!found.credit.includes('Goblin')) throw new Error(`подпись вики: ${found.credit}`);
  const all = open5e.collectFandomImages({
    query: {
      pages: {
        2: { index: 2, title: 'Goblin', thumbnail: { source: 'https://example.com/goblin.jpg', width: 601 } },
        1: { index: 1, title: 'Goblin map', thumbnail: { source: 'https://example.com/map.jpg', width: 800 } },
        3: { index: 3, title: 'No image' }
      }
    }
  });
  if (all.length !== 2) throw new Error(`вариантов вики: ${all.length}, ждали 2`);
});

check('ключ запроса приводится к одному виду', () => {
  const value = open5e.normalizeRu('  Красный   ДРАКОН! ');
  if (value !== 'красный дракон') throw new Error(`ключ: «${value}»`);
});

(async () => {
  let failed = 0;
  for (const item of checks) {
    try {
      await item.fn();
      console.log(`  ok   ${item.name}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL ${item.name}: ${error.message}`);
    }
  }
  console.log(`\nOpen5e: проверок ${checks.length}, провалено ${failed}.`);
  if (failed) process.exitCode = 1;
})();
