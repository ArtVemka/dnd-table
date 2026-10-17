'use strict';

/**
 * Собирает архив приключения из готовых картинок.
 *
 * Формат ровно тот, который уже понимает импорт: adventure.json со сценами и
 * персонажами плюс картинки внутри архива по путям из этих документов. Архив
 * пишется вручную тем же кодом, что и проверочный демо-архив, потому что
 * импорт читает zip сам и не полагается на сторонние библиотеки.
 *
 * Запуск: node scripts/make-adventure-pack.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DOWNLOADS = path.join(process.env.USERPROFILE, 'Downloads');
const OUT_DIR = path.join(__dirname, '..', 'release');
const OUT = path.join(OUT_DIR, 'Шепот часового сердца.zip');

/** Карты. Имена взяты с того, что нарисовано на картинке. */
const MAPS = [
  {
    file: 'Gemini_Generated_Image_ksrqmfksrqmfksrq(3).jpg',
    name: '1. Зал энергетического ядра',
    note: 'Круглый зал. В центре сфера в бронзовом кольце, от неё к четырём '
      + 'источникам по диагонали идут молнии. Выход — лестница вниз, в сторонах витражи.'
  },
  {
    file: 'Gemini_Generated_Image_ksrqmfksrqmfksrq(2).jpg',
    name: '2. Зал поршневых машин',
    note: 'Прямоугольный зал с мостками и четырьмя гигантскими поршнями. '
      + 'Справа у решётки скелет со свитком. Внизу два разряда между круглыми '
      + 'устройствами: через них выход.'
  },
  {
    file: 'Gemini_Generated_Image_ksrqmfksrqmfksrq(1).jpg',
    name: '3. Мастерская шестерён',
    note: 'Круглый зал. Посередине большое колесо с шестернями на цепях, внизу '
      + 'верстак с бумагами, по краям трубы с паром. Отсюда ведут коридоры к трём дверям.'
  },
  {
    file: 'Gemini_Generated_Image_ksrqmfksrqmfksrq.jpg',
    name: '4. Вестибюль механизма',
    note: 'Круглый зал с парадной дверью в глубине и лестницей вниз. На полу '
      + 'пять фиолетовых решёток, светящихся снизу, по краям трубы с паром и свечи.'
  }
];

/** Персонажи и их портреты. */
const ACTORS = [
  { file: 'Gemini_Generated_Image_xdbs47xdbs47xdbs(7).jpg', name: 'Часовой мастер' },
  { file: 'Gemini_Generated_Image_xdbs47xdbs47xdbs(1).jpg', name: 'Латник стражи' },
  { file: 'Gemini_Generated_Image_xdbs47xdbs47xdbs.jpg', name: 'Карабинщик в капюшоне' },
  { file: 'Gemini_Generated_Image_xdbs47xdbs47xdbs(2).jpg', name: 'Рой механических пчёл' },
  { file: 'Gemini_Generated_Image_xdbs47xdbs47xdbs(3).jpg', name: 'Крылатый автоматон' },
  { file: 'Gemini_Generated_Image_xdbs47xdbs47xdbs(4).jpg', name: 'Паровой автоматон' },
  { file: 'Gemini_Generated_Image_xdbs47xdbs47xdbs(5).jpg', name: 'Грозовой рыцарь' },
  { file: 'Gemini_Generated_Image_xdbs47xdbs47xdbs(6).jpg', name: 'Пламя в шестернях' }
];

const ADVENTURE_NAME = 'Шепот часового сердца';

/* ------------------------------------------------------------------ *
 * Минимальный zip: ровно тот, который уже читает импорт
 * ------------------------------------------------------------------ */

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const u16 = (value) => { const b = Buffer.alloc(2); b.writeUInt16LE(value, 0); return b; };
  const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0, 0); return b; };

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
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
    locals.push(local);
    offset += local.length;
  }

  const central = Buffer.concat(centrals);
  return Buffer.concat([
    ...locals,
    central,
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0), u16(0), u16(centrals.length), u16(centrals.length),
    u32(central.length), u32(offset), u16(0)
  ]);
}

/* ------------------------------------------------------------------ *
 * Сборка
 * ------------------------------------------------------------------ */

/** Размер картинки в пикселях: измеряем, чтобы сцена знала свою ширину. */
function imageSize(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(65536);
  const read = fs.readSync(fd, buf, 0, 65536, 0);
  fs.closeSync(fd);
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < read - 9) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return { width: 2048, height: 2048 };
}

function requireFile(name) {
  const full = path.join(DOWNLOADS, name);
  if (!fs.existsSync(full)) throw new Error(`Нет файла ${full}`);
  return full;
}

function main() {
  const entries = [];
  const missing = [];

  const scenes = MAPS.map((map, index) => {
    const asset = `assets/сцена-${index + 1}.jpg`;
    try {
      entries.push([asset, fs.readFileSync(requireFile(map.file))]);
    } catch (error) {
      missing.push(`${map.name}: ${error.message}`);
    }
    const size = imageSize(path.join(DOWNLOADS, map.file));
    return {
      _id: `scena${index + 1}`,
      name: map.name,
      // Сетка в клетках 5 футов: на таких картинках сетка ложится ровно.
      width: size.width,
      height: size.height,
      backgroundColor: '#000000',
      background: { src: asset },
      grid: {
        size: 100,
        distance: 5,
        units: 'ft',
        type: 1,
        color: '#000000',
        alpha: 0.25,
        style: 'solidLines',
        thickness: 1
      },
      tokens: []
    };
  });

  const actors = ACTORS.map((actor, index) => {
    const asset = `assets/портрет-${index + 1}.jpg`;
    try {
      entries.push([asset, fs.readFileSync(requireFile(actor.file))]);
    } catch (error) {
      missing.push(`${actor.name}: ${error.message}`);
    }
    return {
      _id: `akt${index + 1}`,
      name: actor.name,
      type: 'npc',
      img: asset
    };
  });

  const adventure = {
    name: ADVENTURE_NAME,
    description: 'Четыре зала механизма и восемь его обитателей. Имена и описания '
      + 'составлены по картинкам: текста приключения не было, только изображения.',
    scenes,
    actors,
    items: [],
    tables: [],
    journal: [{
      _id: 'zametka1',
      name: 'Как пользоваться архивом',
      pages: [{
        name: 'Что внутри',
        text: {
          content: [
            'Архив собран из картинок: текста приключения не было, поэтому описания '
              + 'ниже составлены по тому, что изображено на картах.',
            '',
            ...MAPS.map((map) => `${map.name}\n${map.note}`),
            '',
            'Персонажи лежат в справочнике приключения. Чтобы поставить фишку, '
              + 'создайте её на карте и назначьте картинку из справочника: так портрет '
              + 'не придётся искать по файлам.',
            '',
            'Карты уже разложены по вкладкам при импорте. Фишек на сценах нет: их '
              + 'расставляют по ходу игры.'
          ].join('\n')
        }
      }]
    }],
    macros: []
  };

  entries.push(['adventure.json', JSON.stringify(adventure, null, 1)]);

  if (missing.length) {
    console.error('Не хватает файлов:');
    for (const line of missing) console.error(`  - ${line}`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, makeZip(entries));

  console.log(`Готов архив приключения:\n  ${OUT}`);
  console.log(`  сцен: ${scenes.length}, персонажей: ${actors.length}`);
  console.log(`  размер: ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} МБ`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Ошибка: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { makeZip, crc32 };