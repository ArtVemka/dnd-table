'use strict';

/**
 * Чтение ZIP без внешних зависимостей.
 *
 * Проект держится на минимуме пакетов, поэтому разбор архива сделан здесь, на
 * встроенном zlib. Понимаются два метода сжатия — «без сжатия» и deflate —
 * этого хватает для модулей Foundry. Остальное честно отвергается, а не
 * молча распаковывается как попало.
 *
 * Это НЕ защита от вредоносных архивов: «zip-бомба» (огромный размер при
 * маленьком файле) ограничена лимитом на суммарный распакованный объём.
 */

const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Сколько данных распаковываем суммарно — защита от zip-бомбы. */
const MAX_TOTAL_BYTES = 400 * 1024 * 1024;

/** Больше этого в архиве ищем end-of-central-directory. */
const MAX_COMMENT = 0xffff;

/**
 * Разбирает ZIP и возвращает список записей.
 * @param {Buffer} buffer
 * @returns {{name: string, size: number, method: number, read: () => Buffer}[]}
 */
function listEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return [];

  let eocd = -1;
  const from = Math.max(0, buffer.length - MAX_COMMENT - 22);
  for (let i = buffer.length - 22; i >= from; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return [];

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== SIG_CENTRAL) break;

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    entries.push({
      // Внутри архива пути всегда со слэшами — так их записывают упаковщики.
      // Windows-переменная отдаёт обратные, поэтому приводим к одному виду,
      // иначе поиск «packs/…» ломается на этой платформе.
      name: name.replace(/\\/g, '/'),
      size: compressedSize,
      method,
      read: () => readEntry(buffer, localOffset, compressedSize, method)
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Читает содержимое одной записи: находит локальный заголовок, пропускает
 * имя и доп. поля, распаковывает.
 */
function readEntry(buffer, localOffset, compressedSize, method) {
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
    throw new Error('Повреждён ZIP: не найден локальный заголовок');
  }
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + compressedSize);

  if (method === METHOD_STORE) return Buffer.from(raw);
  if (method === METHOD_DEFLATE) return zlib.inflateRawSync(raw);
  throw new Error(`Неподдерживаемый метод сжатия в архиве: ${method}`);
}

/**
 * Читает архив и отдаёт содержимое файлов по имени.
 * @param {Buffer} buffer
 * @param {(name: string) => boolean} [filter]
 * @returns {Map<string, Buffer>}
 */
function readZip(buffer, filter = () => true) {
  const result = new Map();
  let total = 0;
  for (const entry of listEntries(buffer)) {
    if (!filter(entry.name)) continue;
    const data = entry.read();
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('Архив распаковывается в слишком большой объём');
    result.set(entry.name, data);
  }
  return result;
}

/**
 * Расширения картинок, которые умеет наша игра. Остальное не берём: в
 * выгрузке Foundry рядом с картами лежат шрифты, звуки и json, и тащить их
 * в память незачем.
 */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif)$/i;

/**
 * Читает из архива картинки и возвращает их по пути внутри архива.
 *
 * Выгрузка приключения из Foundry — это папка: `adventure.json` плюс `assets/`
 * с картами. Картинки лежат рядом с json, а не внутри неё, поэтому одной
 * выгрузкой json импорт не обходится: сцены остаются без фона.
 *
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>}
 */
function readZipAssets(buffer) {
  return readZip(buffer, (name) => IMAGE_EXTENSIONS.test(name));
}

/**
 * Приводит путь внутри архива к виду, по которому его ищет документ.
 * Foundry пишет `assets/карта.webp`, но встречаются и `./assets/карта.webp`,
 * и обратные слэши из выгрузок с Windows.
 * @param {string} path
 * @returns {string}
 */
function normalizeAssetPath(path) {
  return String(path).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

module.exports = { listEntries, readZip, readZipAssets, normalizeAssetPath, MAX_TOTAL_BYTES };