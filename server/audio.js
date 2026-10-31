'use strict';

/**
 * Приём и проверка звука для стола: саундборд и эмбиент карт.
 *
 * Вынесено из server/socket.js по образцу server/image.js, но картинки тот
 * принимать не должен: audio:// — не image://, и проверка идёт своя, по
 * сигнатуре файла, а не по расширению и не по тому, что написал клиент.
 */

const { LIMITS } = require('./state');

/**
 * Определяет формат аудио по сигнатуре файла.
 * Распознаём и неподдерживаемые форматы — чтобы в сообщении об ошибке назвать
 * пользователю именно то, что он выбрал, а не «неизвестный файл».
 * @param {Buffer} buffer
 * @returns {{ext: string|null, label: string|null, supported: boolean}}
 */
function sniffAudioFormat(buffer) {
  if (buffer.length >= 3 && buffer.toString('ascii', 0, 3) === 'ID3') {
    return { ext: 'mp3', label: 'MP3', supported: true };
  }
  // MPEG-кадр без тега: 11 установленных бит подряд на границе кадра.
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return { ext: 'mp3', label: 'MP3', supported: true };
  }
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS') {
    return { ext: 'ogg', label: 'OGG', supported: true };
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE'
  ) {
    return { ext: 'wav', label: 'WAV', supported: true };
  }
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'fLaC') {
    return { ext: 'flac', label: 'FLAC', supported: false };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    return { ext: 'm4a', label: 'MP4/M4A', supported: false };
  }
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return { ext: 'webm', label: 'WEBM', supported: false };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'FORM' && /^(AIFF|AIFC)$/.test(buffer.toString('ascii', 8, 12))) {
    return { ext: 'aiff', label: 'AIFF', supported: false };
  }
  return { ext: null, label: null, supported: false };
}

/**
 * Разбирает base64 data URL и проверяет его как аудио.
 * @param {unknown} dataUrl
 * @returns {{buffer: Buffer, ext: string}|{error: string}}
 */
function decodeAudio(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) return { error: 'Звук не передан' };
  const match = /^data:audio\/(mpeg|mp3|ogg|wav|x-wav);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl.trim());
  if (!match) return { error: 'Поддерживаются только аудио MP3, OGG и WAV' };
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) return { error: 'Файл пустой' };
  if (buffer.length > LIMITS.maxAudioBytes) {
    return { error: `Файл больше ${Math.round(LIMITS.maxAudioBytes / 1024 / 1024)} МБ` };
  }
  const format = sniffAudioFormat(buffer);
  if (!format.supported) {
    if (format.label) {
      return { error: `Формат ${format.label} не поддерживается. Сохраните звук как MP3, OGG или WAV.` };
    }
    return { error: 'Файл не является аудио MP3, OGG или WAV.' };
  }
  return { buffer, ext: format.ext };
}

module.exports = { decodeAudio, sniffAudioFormat };
