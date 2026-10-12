'use strict';

/*
 * Генератор тестовой карты для проверок интерфейса.
 *
 * Печатает готовую константу MAP_PNG (и размеры с цветами) — её нужно вставить
 * в `test/renderer-assertions.js`. Такая карта нужна там, где важно не «картинка
 * вообще есть», а что именно попало в картинку: проверка «на рисунок поверх
 * карты попадает сама карта, а не пустой фон» читает цвета четырёх квадратов из
 * сохранённого файла.
 *
 * Запуск: node scripts/make-test-png.js
 */

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function makePng(width, height, pixel) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const offset = y * stride + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const QUADRANTS = {
  topLeft: [0xc0, 0x39, 0x2b],
  topRight: [0x2c, 0x6f, 0xbb],
  bottomLeft: [0x3f, 0x8f, 0x45],
  bottomRight: [0xd9, 0xa4, 0x41]
};

const WIDTH = 400;
const HEIGHT = 300;
const png = makePng(WIDTH, HEIGHT, (x, y) => {
  const right = x >= WIDTH / 2;
  const bottom = y >= HEIGHT / 2;
  if (!right && !bottom) return QUADRANTS.topLeft;
  if (right && !bottom) return QUADRANTS.topRight;
  if (!right && bottom) return QUADRANTS.bottomLeft;
  return QUADRANTS.bottomRight;
});

const base64 = png.toString('base64');
console.log(`${WIDTH}x${HEIGHT}, ${png.length} байт, base64 ${base64.length} символов`);
console.log(`#${QUADRANTS.topLeft.join('')} #${QUADRANTS.topRight.join('')} #${QUADRANTS.bottomLeft.join('')} #${QUADRANTS.bottomRight.join('')}`);
console.log('');
console.log(`const MAP_PNG =\n  'data:image/png;base64,${base64}';`);
