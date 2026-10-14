'use strict';
/**
 * Проверки импорта внешнего приключения.
 *
 * Тест работает с ядром импорта напрямую, без Electron: так видна именно та
 * логика, которая переживёт любые изменения интерфейса.
 */

const assert = require('node:assert');
const zlib = require('node:zlib');
const { inspect, runImport } = require('../server/importer');
const { emptyMaps, normalizeAdventure } = require('../server/state');

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

/** Минимальный настоящий PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

/** Данные, которые картинкой не являются: ни одна сигнатура не совпадает. */
const FAKE_DATA_URL = `data:image/png;base64,${
  Buffer.from('<html>это не картинка</html>').toString('base64')
}`;

/** Свежая кампания: три вкладки карт, все свободны. */
function freshContext() {
  return { campaignMaps: emptyMaps() };
}

/**
 * Приключение в том виде, в каком его отдаёт выгрузка Foundry.
 * @param {object} [patch]
 * @returns {object}
 */
function makeAdventure(patch = {}) {
  return Object.assign(
    {
      _id: 'adventure-test',
      type: 'Adventure',
      name: 'Пещера Кобольда',
      images: {},
      scenes: [
        {
          _id: 'scene-1',
          type: 'Scene',
          name: 'Вход в пещеру',
          img: PNG_DATA_URL,
          width: 4000,
          height: 2000,
          tokens: [
            { _id: 'token-1', name: 'Кобольд', x: 500, y: 250, width: 100, height: 100 },
            { _id: 'token-2', name: 'Факел', x: 1000, y: 250, width: 60, height: 60 }
          ]
        },
        {
          _id: 'scene-2',
          type: 'Scene',
          name: 'Зал сокровищ',
          img: PNG_DATA_URL,
          width: 3000,
          height: 3000
        },
        { _id: 'scene-no-image', type: 'Scene', name: 'Пустая комната' }
      ],
      journal: [
        { _id: 'journal-1', type: 'JournalEntry', name: 'Записка хранителя', text: { html: '<p>Не открывай дверь</p>' } },
        { _id: 'journal-2', type: 'JournalEntry', name: 'Схема', text: { html: '<p>Слева — выход</p>' } }
      ],
      actors: [
        { _id: 'actor-1', type: 'Actor', name: 'Вор Рамза', img: PNG_DATA_URL },
        { _id: 'actor-2', type: 'Actor', name: 'Знахарка' }
      ],
      items: [{ _id: 'item-1', type: 'Item', name: 'Ключ от двери' }],
      macro: [{ _id: 'macro-1', type: 'Macro', name: 'Взрыв', command: 'boom()' }],
      // Неизвестный тип: должен быть пропущен, а не сломать импорт.
      _somethingElse: [{ _id: 'x-1', type: 'Mystery' }]
    },
    patch
  );
}

/**
 * Оборачивает приключение так, как его ждёт импортёр: файл, а не объект.
 * @param {object} adventure
 * @param {string} [name]
 * @returns {{data: Buffer, path: string}}
 */
function asFile(adventure, name = 'приключение.json') {
  return { data: Buffer.from(JSON.stringify(adventure), 'utf8'), path: name };
}

/**
 * Считает CRC32: без него файл не считается архивом.
 * @param {Buffer} buffer
 * @returns {number}
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Собирает корректный ZIP из нескольких файлов.
 * Своя сборка нужна, чтобы тест не зависел от внешних архиваторов.
 * @param {Record<string, string|Buffer>} entries
 * @returns {Buffer}
 */
function makeZipEntries(entries) {
  const u16 = (value) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(value, 0);
    return b;
  };
  const u32 = (value) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value >>> 0, 0);
    return b;
  };
  const deflate = (content) => {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const deflated = zlib.deflateRawSync(raw);
    return { raw, deflated, crc: crc32(raw) };
  };

  const chunks = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const { raw, deflated, crc } = deflate(content);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16(20), u16(0), u16(8), u16(0), u16(0),
      u32(crc), u32(deflated.length), u32(raw.length),
      u16(nameBuf.length), u16(0), nameBuf, deflated
    ]);
    centrals.push(Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      u16(20), u16(20), u16(0), u16(8), u16(0), u16(0),
      u32(crc), u32(deflated.length), u32(raw.length),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf
    ]));
    chunks.push(local);
    offset += local.length;
  }

  const central = Buffer.concat(centrals);
  const end = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0), u16(0),
    u16(centrals.length), u16(centrals.length),
    u32(central.length), u32(offset), u16(0)
  ]);
  return Buffer.concat([...chunks, central, end]);
}

/**
 * Собирает минимальный корректный ZIP с одним сжатым файлом.
 * @param {string} name
 * @param {string} content
 * @returns {Buffer}
 */
function makeZip(name, content) {
  return makeZipEntries({ [name]: content });
}

check('предпросмотр находит документы всех поддерживаемых типов', async () => {
  const preview = await inspect(asFile(makeAdventure()), freshContext());
  const kinds = [...new Set(preview.plans.map((plan) => plan.kind))].sort();
  assert.deepStrictEqual(kinds, ['actor', 'item', 'journal', 'macro', 'scene']);
  assert.strictEqual(preview.sourceTitle, 'Пещера Кобольда');
  assert.strictEqual(preview.total, 9, 'ожидалось 9 документов: 3 сцены, 2 заметки, 2 актёра, 1 предмет, 1 макрос');
});

check('макрос виден в списке, но не выбирается', async () => {
  const preview = await inspect(asFile(makeAdventure()), freshContext());
  const macro = preview.plans.find((plan) => plan.kind === 'macro');
  assert.ok(macro, 'макрос должен показываться');
  assert.strictEqual(macro.selectable, false, 'макрос нельзя импортировать');
  assert.match(macro.note, /[Мм]акрос/, 'у макроса должно быть пояснение');
});

check('сцена без картинки не импортируется и объясняет почему', async () => {
  const preview = await inspect(asFile(makeAdventure()), freshContext());
  const empty = preview.plans.find((plan) => plan.sourceId === 'scene-no-image');
  assert.strictEqual(empty.selectable, false, 'пустая карта вряд ли кому нужна');
  assert.strictEqual(empty.selected, false, 'такую сцену нельзя и отмечать по умолчанию');
  assert.match(empty.note, /картинк/i, 'нужно объяснение, а не молчание');
});

check('сцена с испорченной картинкой не импортируется', async () => {
  const adventure = makeAdventure();
  adventure.scenes[0].img = FAKE_DATA_URL;
  const preview = await inspect(asFile(adventure), freshContext());
  const scene = preview.plans.find((plan) => plan.sourceId === 'scene-1');
  assert.strictEqual(scene.selectable, false, 'сцена с некартинкой не должна импортироваться');
  assert.ok(preview.warnings.some((text) => /картинк/i.test(text)), 'нужно предупреждение о картинке');
  // Если пользователь всё же отметит только её, импорт должен честно отказать,
  // а не рапортовать об успехе.
  await assert.rejects(
    () => runImport(asFile(adventure), { include: ['scene-1'] }, freshContext()),
    /Не выбрано ни одной сущности/
  );
});

check('документ незнакомого типа пропускается с объяснением', async () => {
  const file = asFile(
    [
      { _id: 'mystery-1', type: 'Mystery', name: 'Непонятно что' },
      { _id: 'item-1', type: 'Item', name: 'Ключ от двери' }
    ],
    'пакет.json'
  );
  const preview = await inspect(file, freshContext());
  assert.strictEqual(preview.plans.length, 1, 'в список выбора должен попасть только известный документ');
  assert.strictEqual(preview.plans[0].name, 'Ключ от двери');
  assert.ok(preview.skipped.length, 'незнакомый тип должен быть записан в пропущенные');
  assert.match(preview.skipped[0].reason, /неизвестн/i, 'и с понятной причиной');
});

check('файл, где нет ничего известного, отклоняется целиком', async () => {
  const file = asFile([{ _id: 'mystery-1', type: 'Mystery', name: 'Непонятно что' }], 'пакет.json');
  await assert.rejects(() => inspect(file, freshContext()), /нет документов/i);
});

check('сцена занимает свободную вкладку и объясняет, куда попала', async () => {
  const preview = await inspect(asFile(makeAdventure()), freshContext());
  const scene = preview.plans.find((plan) => plan.sourceId === 'scene-1');
  assert.strictEqual(scene.selectable, true);
  assert.strictEqual(scene.target, 'world');
  assert.match(scene.targetLabel, /Общая/);
});

check('занятые вкладки карт предлагают освободить', async () => {
  const context = freshContext();
  context.campaignMaps.world.items.push({ id: 'map-1', url: '/files/a.png', name: 'Уже есть' });
  const preview = await inspect(asFile(makeAdventure()), context);
  const scene = preview.plans.find((plan) => plan.sourceId === 'scene-1');
  assert.strictEqual(scene.selectable, true, 'свободная вкладка battle должна подойти');
  assert.strictEqual(scene.target, 'battle', 'сцена должна встать на battle, а не на занятую world');
});

check('карта импортируется ссылкой на картинку и именем сцены', async () => {
  const { patch } = await runImport(asFile(makeAdventure()), { include: ['scene-1'] }, freshContext());
  const maps = patch.maps.world.items;
  assert.strictEqual(maps.length, 1, 'в мировой вкладке должна быть одна карта');
  assert.strictEqual(maps[0].url, PNG_DATA_URL, 'ядро отдаёт картинку как есть — в файлы её сохраняет main');
  assert.strictEqual(maps[0].name, 'Вход в пещеру');
});

check('фишки сцены становятся токенами с относительными координатами', async () => {
  const { patch } = await runImport(asFile(makeAdventure()), { include: ['scene-1'] }, freshContext());
  assert.strictEqual(patch.tokens.length, 2, 'должно быть две фишки');
  const kobold = patch.tokens.find((token) => token.name === 'Кобольд');
  assert.ok(kobold, 'фишка кобольда должна найтись');
  assert.strictEqual(kobold.mapType, 'world');
  // Координаты приводятся к долям: любое значение 0..1 годится,
  // пиксели Foundry попадать сюда не должны.
  assert.ok(kobold.x > 0 && kobold.x < 1, `x должен быть долей, получено ${kobold.x}`);
  assert.ok(kobold.y > 0 && kobold.y < 1, `y должен быть долей, получено ${kobold.y}`);
});

check('HTML из заметок очищается', async () => {
  const { patch } = await runImport(asFile(makeAdventure()), { include: ['journal-1'] }, freshContext());
  const note = patch.adventure.notes.find((item) => item.sourceId === 'journal-1');
  assert.strictEqual(note.text, 'Не открывай дверь');
  assert.strictEqual(/<[a-z]/i.test(note.text), false, 'теги не должны попасть в текст');
});

check('импортируются только выбранные документы', async () => {
  const { patch, report } = await runImport(
    asFile(makeAdventure()),
    { include: ['journal-1', 'item-1'] },
    freshContext()
  );
  assert.strictEqual(patch.adventure.notes.length, 1, 'только одна заметка');
  assert.strictEqual(patch.adventure.items.length, 1, 'только один предмет');
  assert.strictEqual(patch.adventure.actors.length, 0, 'актёры не выбирались');
  assert.strictEqual(patch.maps.world.items.length, 0, 'карты не выбирались');
  assert.strictEqual(patch.tokens.length, 0, 'фишек быть не должно');
  assert.strictEqual(report.applied.length, 2, 'в отчёте две применённые записи');
});

check('актёр попадает в справочник приключения, а не в лист', async () => {
  const { patch } = await runImport(asFile(makeAdventure()), { include: ['actor-1'] }, freshContext());
  const actor = patch.adventure.actors.find((item) => item.sourceId === 'actor-1');
  assert.ok(actor, 'актёр должен попасть в справочник');
  assert.strictEqual(actor.name, 'Вор Рамза');
  assert.strictEqual(actor.image, PNG_DATA_URL, 'картинка актёра не должна обрезаться по пути');
  assert.strictEqual(patch.tokens.length, 0, 'актёр не должен становиться фишкой сам по себе');
});

check('пустой выбор отклоняется с понятным объяснением', async () => {
  await assert.rejects(
    () => runImport(asFile(makeAdventure()), { include: [] }, freshContext()),
    /Не выбрано ни одной сущности/,
    'пустой выбор должен отклоняться, а не молча импортировать всё'
  );
});

check('импорт из ZIP работает так же, как из JSON', async () => {
  const zip = makeZip('adventure.json', JSON.stringify(makeAdventure()));
  const preview = await inspect({ data: zip, path: 'приключение.zip' }, freshContext());
  assert.strictEqual(preview.sourceTitle, 'Пещера Кобольда');
  assert.strictEqual(preview.plans.filter((plan) => plan.kind === 'scene').length, 3);
});

check('нормализация не пропускает мусор в справочник приключения', () => {
  const normalized = normalizeAdventure({
    name: '  <b>Название</b>  ',
    notes: 'не массив',
    actors: [{ name: 'A'.repeat(500) }, { image: 42 }],
    items: [{ name: null }]
  });
  assert.strictEqual(normalized.actors[0].name.length, 120, 'имя должно обрезаться до лимита');
  assert.strictEqual(normalized.actors[1].image, '', 'не строка не должна попасть в картинку');
  assert.ok(normalized.items.length, 'предмет без имени всё равно попадает в список');
});

check('итог импорта склоняет слова по-русски', async () => {
  const one = await runImport(asFile(makeAdventure()), { include: ['journal-1'] }, freshContext());
  assert.match(one.report.summary, /1 заметка\./, 'одна заметка — «заметка», а не «заметок»');

  const file = asFile(makeAdventure());
  for (let i = 0; i < 4; i += 1) {
    file.data = Buffer.from(
      JSON.stringify(
        Object.assign(JSON.parse(file.data.toString('utf8')), {
          journal: [0, 1, 2, 3].map((n) => ({ _id: `j${n}`, type: 'JournalEntry', name: `Записка ${n}` }))
        })
      ),
      'utf8'
    );
  }
  const few = await runImport(file, { include: ['j0', 'j1', 'j2', 'j3'] }, freshContext());
  assert.match(few.report.summary, /4 заметки\./, 'четыре заметки — «заметки»');

  const five = await runImport(
    asFile(makeAdventure({ journal: [0, 1, 2, 3, 4].map((n) => ({ _id: `k${n}`, type: 'JournalEntry', name: `Записка ${n}` })) })),
    { include: ['k0', 'k1', 'k2', 'k3', 'k4'] },
    freshContext()
  );
  assert.match(five.report.summary, /5 заметок\./, 'пять заметок — «заметок»');
});

/**
 * Приключение в той форме, в какой его пишет настоящий Foundry.
 *
 * Форма взята с настоящей выгрузки, а не придумана: фон сцены лежит в
 * `background.src`, у токенов картинка в `texture`, текст заметки разложен по
 * `pages[].text.content`, а у документа приключения нет поля `type` вовсе.
 * На синтетике всё это выглядело исправным, а на живых файлах молча ломалось.
 * @param {object} [patch]
 * @returns {object}
 */
function makeRealAdventure(patch = {}) {
  return Object.assign(
    {
      _id: 'real-adventure',
      name: 'Янтарный храм',
      actors: [
        { _id: 'ra1', name: 'Берсерк', type: 'npc', img: 'systems/dnd5e/tokens/humanoid/Berserker.webp' }
      ],
      items: [{ _id: 'ri1', name: 'Том понимания', type: 'equipment' }],
      journal: [
        {
          _id: 'rj1',
          name: 'Янтарный храм',
          pages: [
            {
              _id: 'rp1',
              name: 'Обзор',
              type: 'text',
              text: { format: 1, content: '<p>Тайное общество волшебников построило храм.</p>' }
            },
            {
              _id: 'rp2',
              name: 'Цена',
              type: 'text',
              text: { format: 1, content: '<p>Вопрос стоит воспоминания.</p>' }
            }
          ]
        }
      ],
      scenes: [
        {
          _id: 'rs1',
          name: 'Янтарный храм, верхний уровень',
          width: 2700,
          height: 3000,
          backgroundColor: '#000000',
          background: { src: 'assets/upper_level.png', offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 },
          grid: { size: 50, type: 1, distance: 5, units: 'ft' },
          tokens: [
            {
              _id: 'rt1',
              name: 'Берсерк',
              x: 1350,
              y: 1500,
              width: 0.5,
              height: 0.5,
              texture: { src: 'assets/berserker.png' }
            },
            {
              _id: 'rt2',
              name: '',
              actorId: 'ra1',
              x: 2000,
              y: 2000,
              width: 0.5,
              height: 0.5,
              delta: { name: 'Берсерк-2' }
            }
          ]
        }
      ],
      tables: [],
      macros: []
    },
    patch
  );
}

check('настоящая выгрузка: фон сцены читается из background.src', async () => {
  const zip = makeZipEntries({
    'adventure.json': JSON.stringify(makeRealAdventure()),
    'assets/upper_level.png': Buffer.from(PNG_BASE64, 'base64'),
    'assets/berserker.png': Buffer.from(PNG_BASE64, 'base64')
  });
  const preview = await inspect({ data: zip, path: 'храм.zip' }, freshContext());
  const scene = preview.plans.find((plan) => plan.kind === 'scene');
  assert.strictEqual(scene.selectable, true, `сцена должна импортироваться: ${scene.note}`);

  const { patch } = await runImport(
    { data: zip, path: 'храм.zip' },
    { include: ['rs1'] },
    freshContext()
  );
  const map = patch.maps.world.items[0];
  assert.ok(map, 'карта должна появиться');
  assert.match(map.url, /^data:image\/png;base64,/, 'фон должен достаться из архива как картинка');
});

check('настоящая выгрузка: текст заметки собирается из pages', async () => {
  const zip = makeZipEntries({
    'adventure.json': JSON.stringify(makeRealAdventure()),
    'assets/upper_level.png': Buffer.from(PNG_BASE64, 'base64')
  });
  const { patch } = await runImport(
    { data: zip, path: 'храм.zip' },
    { include: ['rj1'] },
    freshContext()
  );
  const note = patch.adventure.notes.find((item) => item.sourceId === 'rj1');
  assert.ok(note, 'заметка должна импортироваться');
  assert.match(note.text, /Тайное общество волшебников/, 'текст первой страницы');
  assert.match(note.text, /воспоминания/, 'текст второй страницы');
  assert.strictEqual(/<p>/.test(note.text), false, 'теги не должны попасть в текст');
});

check('настоящая выгрузка: фишки сцены становятся токенами с именем из delta', async () => {
  const zip = makeZipEntries({
    'adventure.json': JSON.stringify(makeRealAdventure()),
    'assets/upper_level.png': Buffer.from(PNG_BASE64, 'base64'),
    'assets/berserker.png': Buffer.from(PNG_BASE64, 'base64')
  });
  const { patch } = await runImport({ data: zip, path: 'храм.zip' }, { include: ['rs1'] }, freshContext());
  assert.strictEqual(patch.tokens.length, 2, 'две фишки');
  const named = patch.tokens.find((token) => token.name === 'Берсерк-2');
  assert.ok(named, 'безымянный токен должен взять имя из delta, а не потеряться');
  // Правило маппинга: центр фишки = x + половина размера, делённый на размер сцены.
  // 2000 + 0.25 = 2000.25 от ширины сцены 2700.
  assert.ok(Math.abs(named.x - 2000.25 / 2700) < 0.001, `x должен быть долей, получено ${named.x}`);
  assert.ok(Math.abs(named.y - 2000.25 / 3000) < 0.001, `y должен быть долей, получено ${named.y}`);
});

check('путь в файлы Foundry объясняется внятно, а не молча', async () => {
  // Так выглядит модуль, конвертированный в приключение: фон лежит в файлах
  // Foundry, а не в выгрузке. Сцену импортировать нельзя, и ДМ должен понимать почему.
  const adventure = makeRealAdventure();
  adventure.scenes[0].background = { src: 'modules/что-то/карта.webp' };
  const preview = await inspect(asFile(adventure), freshContext());
  const scene = preview.plans.find((plan) => plan.sourceId === 'rs1');
  assert.strictEqual(scene.selectable, false, 'сцена без картинки не импортируется');
  assert.match(scene.note, /Foundry/, 'в подсказке должно быть сказано про файлы Foundry');
  const warning = preview.warnings.find((text) => text.includes('Янтарный храм'));
  assert.ok(warning, 'должно быть предупреждение');
  assert.match(warning, /modules\/что-то\/карта\.webp/, 'предупреждение должно называть файл');
});

check('фишки сцены привязаны к своей карте, а не ко всей вкладке', async () => {
  const zip = makeZipEntries({
    'adventure.json': JSON.stringify(makeRealAdventure()),
    'assets/upper_level.png': Buffer.from(PNG_BASE64, 'base64'),
    'assets/berserker.png': Buffer.from(PNG_BASE64, 'base64')
  });
  const { patch } = await runImport({ data: zip, path: 'храм.zip' }, { include: ['rs1'] }, freshContext());
  const map = patch.maps.world.items[0];
  assert.ok(map, 'должна появиться карта');
  assert.strictEqual(patch.tokens.length, 2, 'две фишки');
  for (const token of patch.tokens) {
    // Вкладка умеет держать несколько карт. Без mapId фишки обеих сцен
    // рисовались на каждой карте вкладки и наезжали друг на друга.
    assert.strictEqual(token.mapId, map.id, `фишка ${token.name} должна принадлежать своей карте`);
  }
});

(async () => {
  let failed = 0;
  for (const item of checks) {
    try {
      await item.fn();
      console.log(`  ok   ${item.name}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL ${item.name}`);
      console.log(`       ${error.message}`);
    }
  }
  console.log('==============================================================');
  if (failed) {
    console.log(`Импорт: проверок ${checks.length}, провалено ${failed}.`);
    process.exit(1);
  }
  console.log(`Импорт: проверок ${checks.length}, провалено 0.`);
})();