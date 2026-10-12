'use strict';

/**
 * Генерирует build/icon.ico для Windows без внешних зависимостей.
 *
 * Рисуется «вид d20 сверху»: диск, шестиугольник, вписанный треугольник
 * (центральная грань) и три боковые грани. Формат ICO — классический BMP
 * (BITMAPINFOHEADER + BGRA), такой понимают и rcedit, и NSIS.
 *
 * Запуск: node scripts/make-icon.js
 */

const fs = require('fs');
const path = require('path');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SUPERSAMPLE = 4;
const STROKE = 0.028;

const COLORS = {
  discTop: [59, 43, 29],
  discBottom: [25, 19, 16],
  ring: [200, 117, 80],
  stroke: [217, 164, 65],
  centerFill: [217, 164, 65, 0.24],
  sideFill: [217, 164, 65, 0.09]
};

const TAU = Math.PI * 2;

function deg(angle) {
  return (angle * Math.PI) / 180;
}

/** Вершины шестиугольника (угол ~30° -> верхняя вершина). */
function hexagon(radius) {
  return [0, 1, 2, 3, 4, 5].map((index) => {
    const angle = deg(-90 + 60 * index);
    return [0.5 + Math.cos(angle) * radius, 0.5 + Math.sin(angle) * radius];
  });
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function pointInPolygon(px, py, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function mix(base, over, alpha) {
  return [
    Math.round(base[0] + (over[0] - base[0]) * alpha),
    Math.round(base[1] + (over[1] - base[1]) * alpha),
    Math.round(base[2] + (over[2] - base[2]) * alpha)
  ];
}

/**
 * Цвет одной точки. Координаты и радиусы — в долях от размера иконки.
 * @returns {[number, number, number, number]} RGBA 0..255
 */
function sample(x, y) {
  const distance = Math.hypot(x - 0.5, y - 0.5);
  if (distance > 0.5) return [0, 0, 0, 0];

  // Диск с вертикальным градиентом и ободком.
  let rgb = mix(COLORS.discTop, COLORS.discBottom, y);
  if (distance > 0.452) rgb = COLORS.ring;

  const hex = hexagon(0.3);
  const centerTriangle = [hex[0], hex[2], hex[4]];
  const sideTriangles = [
    [hex[0], hex[1], hex[2]],
    [hex[2], hex[3], hex[4]],
    [hex[4], hex[5], hex[0]]
  ];

  if (pointInPolygon(x, y, centerTriangle)) {
    rgb = mix(rgb, COLORS.stroke, COLORS.centerFill[3]);
  } else if (sideTriangles.some((triangle) => pointInPolygon(x, y, triangle))) {
    rgb = mix(rgb, COLORS.stroke, COLORS.sideFill[3]);
  }

  // Рёбра: контур шестиугольника и центральная грань.
  const edges = [];
  for (let index = 0; index < 6; index += 1) {
    edges.push([hex[index], hex[(index + 1) % 6]]);
  }
  edges.push([centerTriangle[0], centerTriangle[1]]);
  edges.push([centerTriangle[1], centerTriangle[2]]);
  edges.push([centerTriangle[2], centerTriangle[0]]);

  for (const [a, b] of edges) {
    if (distanceToSegment(x, y, a[0], a[1], b[0], b[1]) <= STROKE / 2) {
      rgb = COLORS.stroke;
      break;
    }
  }

  return [rgb[0], rgb[1], rgb[2], 255];
}

/** Рисует квадрат size x size с 4x суперсэмплингом. */
function renderRgba(size) {
  const scale = size * SUPERSAMPLE;
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px * SUPERSAMPLE + sx + 0.5) / scale;
          const y = (py * SUPERSAMPLE + sy + 0.5) / scale;
          const [sr, sg, sb, sa] = sample(x, y);
          const weight = sa / 255;
          r += sr * weight;
          g += sg * weight;
          b += sb * weight;
          a += sa;
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const alphaSum = a / 255;
      const offset = (py * size + px) * 4;
      if (alphaSum > 0) {
        pixels[offset] = Math.round(r / alphaSum);
        pixels[offset + 1] = Math.round(g / alphaSum);
        pixels[offset + 2] = Math.round(b / alphaSum);
      }
      pixels[offset + 3] = Math.round(a / samples);
    }
  }
  return pixels;
}

/** Одна запись ICO в формате BMP: BITMAPINFOHEADER + BGRA + AND-маска. */
function bmpEntry(size) {
  const rgba = renderRgba(size);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight: XOR + AND
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  header.writeUInt32LE(size * size * 4, 20); // biSizeImage
  header.writeInt32LE(0, 24);
  header.writeInt32LE(0, 28);
  header.writeUInt32LE(0, 32);
  header.writeUInt32LE(0, 36);

  // Пиксели снизу вверх, порядок каналов BGRA.
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const srcRow = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x += 1) {
      const from = srcRow + x * 4;
      const to = (y * size + x) * 4;
      xor[to] = rgba[from + 2];
      xor[to + 1] = rgba[from + 1];
      xor[to + 2] = rgba[from];
      xor[to + 3] = rgba[from + 3];
    }
  }

  // AND-маска: 1 бит на пиксель, строки выровнены по 4 байта. Все нули —
  // прозрачность определяется альфа-каналом.
  const maskStride = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(maskStride * size);

  return Buffer.concat([header, xor, and]);
}

function buildIco() {
  const entries = SIZES.map((size) => ({ size, data: bmpEntry(size) }));

  const directory = Buffer.alloc(6);
  directory.writeUInt16LE(0, 0); // reserved
  directory.writeUInt16LE(1, 2); // type: icon
  directory.writeUInt16LE(entries.length, 4);

  const table = Buffer.alloc(16 * entries.length);
  let offset = 6 + table.length;
  entries.forEach((entry, index) => {
    const base = index * 16;
    table.writeUInt8(entry.size >= 256 ? 0 : entry.size, base); // width
    table.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1); // height
    table.writeUInt8(0, base + 2); // палитра не нужна
    table.writeUInt8(0, base + 3); // reserved
    table.writeUInt16LE(1, base + 4); // planes
    table.writeUInt16LE(32, base + 6); // bitCount
    table.writeUInt32LE(entry.data.length, base + 8);
    table.writeUInt32LE(offset, base + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([directory, table, ...entries.map((entry) => entry.data)]);
}

/**
 * Собирает PNG 512x512 из того же рисунка — Linux-цели electron-builder
 * принимают только PNG. Канал цвета 6 (RGBA), прозрачность сохраняется.
 */
function buildPng(size = 512) {
  const zlib = require('zlib');

  const crcTable = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();
  const crc32 = (buffer) => {
    let crc = -1;
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuffer = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
  };

  const rgba = renderRgba(size);
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0; // фильтр строки: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // глубина
  ihdr[9] = 6;  // 6 = RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function main() {
  const target = path.join(__dirname, '..', 'build');
  fs.mkdirSync(target, { recursive: true });
  const ico = buildIco();
  const file = path.join(target, 'icon.ico');
  fs.writeFileSync(file, ico);
  console.log(`Иконка: ${file} (${SIZES.join(', ')} px, ${ico.length} байт)`);

  const png = buildPng(512);
  const pngFile = path.join(target, 'icon.png');
  fs.writeFileSync(pngFile, png);
  console.log(`Иконка: ${pngFile} (512 px, ${png.length} байт)`);
}

if (require.main === module) main();

module.exports = { buildIco, buildPng };
