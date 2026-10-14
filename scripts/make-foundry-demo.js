'use strict';

/**
 * Собирает из настоящей выгрузки Foundry готовый архив для проверки импорта.
 *
 * Зачем это нужно. Настоящая выгрузка ссылается на картинки путями в файлах
 * Foundry (`modules/…/upper_level.webp`), поэтому сцены из неё импортировать
 * нельзя: самих картинок в json нет. А выгрузка через «Экспорт приключения»
 * кладёт картинки рядом с json — и вот такой случай мы и хотим проверять.
 *
 * Скрипт берёт настоящий документ приключения, переписывает ссылки на фон на
 * пути внутри архива и кладёт туда настоящую сгенерированную карту.
 *
 * Запуск: node scripts/make-foundry-demo.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'foundry');
const OUT = path.join(FIXTURES, 'демо-приключение-из-foundry.zip');
const SOURCE = process.argv[2] || 'Area_X__The_Amber_Temple_4L2FJjtLw6lDLgsA.json';

/* ------------------------------------------------------------------ *
 * Картинка: пишем PNG вручную, без зависимостей
 * ------------------------------------------------------------------ */

/**
 * Считает CRC32 — без него PNG не откроется.
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
 * Собирает один PNG из пикселей RGB.
 * @param {number} width
 * @param {number} height
 * @param {Buffer} pixels width*height*3 байт
 * @returns {Buffer}
 */
function encodePng(width, height, pixels) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };

  // Кажда�� строка префиксуется байтом фильтра: 0 — без фильтра.
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * width * 3, (y + 1) * width * 3);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // бит на канал
  header[9] = 2; // тип: truecolor RGB
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * Рисует подобие подземелья: каменный фон, клетки и коридоры.
 * Нужен не шедевр, а узнаваемая подложка, чтобы на карте было видно сетку.
 * @param {number} width
 * @param {number} height
 * @param {number} seed разные сцены должны отличаться
 * @returns {Buffer}
 */
function drawMap(width, height, seed) {
  const pixels = Buffer.alloc(width * height * 3);
  const cell = 50;
  const tint = [
    [74, 58, 44],
    [66, 54, 46],
    [82, 62, 44]
  ][seed % 3];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      // шум, чтобы фон не выглядел плоским
      const noise = ((x * 7919 + y * 104729 + seed * 31) % 17) - 8;
      // линии сетки
      const onGrid = x % cell === 0 || y % cell === 0;
      // «коридоры» — широкие полосы в обе стороны от центра
      const corridor = Math.abs(x - width / 2) < cell * 3 || Math.abs(y - height / 2) < cell * 2;
      const base = corridor ? 26 : 0;
      pixels[offset] = Math.min(255, Math.max(0, tint[0] + noise + base));
      pixels[offset + 1] = Math.min(255, Math.max(0, tint[1] + noise + base));
      pixels[offset + 2] = Math.min(255, Math.max(0, tint[2] + noise + base));
      if (onGrid) {
        pixels[offset] = Math.min(255, pixels[offset] + 22);
        pixels[offset + 1] = Math.min(255, pixels[offset + 1] + 20);
        pixels[offset + 2] = Math.min(255, pixels[offset + 2] + 16);
      }
    }
  }
  return encodePng(width, height, pixels);
}

/* ------------------------------------------------------------------ *
 * Архив
 * ------------------------------------------------------------------ */

/**
 * @param {Record<string, string|Buffer>} entries
 * @returns {Buffer}
 */
function makeZip(entries) {
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

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const deflated = zlib.deflateRawSync(raw);
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

function main() {
  const sourcePath = path.join(FIXTURES, SOURCE);
  if (!fs.existsSync(sourcePath)) {
    console.error(`Нет исходника ${sourcePath}`);
    console.error('Скачайте выгрузку Foundry: node scripts/fetch-foundry-sample.js');
    process.exit(1);
  }

  const adventure = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const entries = {};
  let index = 0;

  for (const scene of Array.isArray(adventure.scenes) ? adventure.scenes : []) {
    if (!scene || !scene.background || !scene.background.src) continue;
    const fileName = `assets/сцена-${index += 1}.png`;
    entries[fileName] = drawMap(900, 1000, index);
    scene.background.src = fileName;
  }

  for (const actor of Array.isArray(adventure.actors) ? adventure.actors : []) {
    if (!actor || !actor.img) continue;
    entries[`assets/портрет-${index += 1}.png`] = drawMap(128, 128, index);
    actor.img = `assets/портрет-${index}.png`;
  }

  entries['adventure.json'] = JSON.stringify(adventure, null, 1);

  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(OUT, makeZip(entries));

  console.log(`Готов архив для проверки импорта:\n  ${OUT}`);
  console.log(`  сцен с картинкой: ${Object.keys(entries).filter((n) => n.includes('сцена')).length}`);
  console.log(`  всего файлов в архиве: ${Object.keys(entries).length}`);
  console.log('\nКак проверить: запустите игру, поднимите стол мастером и нажмите');
  console.log('«Импортировать приключение…», выбрав этот zip.');
}

if (require.main === module) main();
