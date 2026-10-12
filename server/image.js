'use strict';

/**
 * Приём и проверка изображений.
 *
 * Вынесено из server/socket.js, чтобы импорт внешних приключений проверял
 * картинки ровно тем же кодом, что и загрузка карт в игре: по сигнатуре файла,
 * а не по расширению и не по тому, что написал клиент.
 */

const { LIMITS } = require('./state');
/**
 * Определяет формат изображения по сигнатуре файла.
 * Распознаём и неподдерживаемые форматы — чтобы в сообщении об ошибке назвать
 * пользователю именно то, что он выбрал, а не «неизвестный файл».
 * @param {Buffer} buffer
 * @returns {{ext: string|null, label: string|null, supported: boolean}}
 */
function sniffImageFormat(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { ext: 'png', label: 'PNG', supported: true };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: 'jpg', label: 'JPEG', supported: true };
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { ext: 'webp', label: 'WEBP', supported: true };
  }
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.toString('latin1', 0, 6))) {
    return { ext: 'gif', label: 'GIF', supported: false };
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { ext: 'bmp', label: 'BMP', supported: false };
  }
  if (buffer.length >= 4 && ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a) || (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00))) {
    return { ext: 'tiff', label: 'TIFF', supported: false };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12);
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) {
      return { ext: 'heic', label: 'HEIC (так фотографирует iPhone)', supported: false };
    }
    if (brand === 'avif' || brand === 'avis') {
      return { ext: 'avif', label: 'AVIF', supported: false };
    }
  }
  const head = buffer.toString('utf8', 0, Math.min(400, buffer.length)).trim().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) {
    return { ext: 'svg', label: 'SVG', supported: false };
  }
  if (head.startsWith('%pdf')) {
    return { ext: 'pdf', label: 'PDF', supported: false };
  }
  return { ext: null, label: null, supported: false };
}

/**
 * Разбирает base64 data URL и проверяет его как изображение.
 * @param {unknown} dataUrl
 * @returns {{buffer: Buffer, ext: string}|{error: string}}
 */
function decodeImage(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) return { error: 'Изображение не передано' };
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl.trim());
  if (!match) return { error: 'Поддерживаются только изображения PNG, JPG и WEBP' };
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) return { error: 'Файл пустой' };
  if (buffer.length > LIMITS.maxImageBytes) {
    return { error: `Файл больше ${Math.round(LIMITS.maxImageBytes / 1024 / 1024)} МБ` };
  }
  const format = sniffImageFormat(buffer);
  if (!format.supported) {
    if (format.label) {
      return { error: `Формат ${format.label} не поддерживается. Сохраните изображение как PNG, JPG или WEBP.` };
    }
    return { error: 'Файл не является изображением PNG, JPG или WEBP.' };
  }
  return { buffer, ext: format.ext };
}

module.exports = { decodeImage, sniffImageFormat };
