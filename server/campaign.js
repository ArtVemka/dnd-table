'use strict';

/**
 * Хранилище кампаний на диске (у ДМ).
 *
 * Файловое хранение: JSON + папка с изображениями. База данных не нужна.
 *
 *   <dataDir>/campaigns/<campaignId>/campaign.json   — состояние кампании
 *   <dataDir>/campaigns/<campaignId>/files/<name>    — карты и изображения фишек
 *
 * dataDir задаётся из main.js: либо app.getPath('userData'), либо папка
 * ./data рядом с приложением (portable-режим).
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { CAMPAIGN_FORMAT_VERSION, emptyMaps, sanitizeText } = require('./state');

const IMAGE_EXTENSIONS = { png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp' };

/** Потолок на объём папки files одной кампании. Карты и портреты вместе. */
const MAX_FILES_BYTES = 512 * 1024 * 1024;

/** Файл моложе этого возраста свалка не трогает: его могли только что записать. */
const SWEEP_KEEP_MS = 2 * 60 * 1000;

/** Ошибка «место кончилось»: её показывают игроку, в отличие от сбоев диска. */
function quotaError(fileName) {
  const error = new Error(
    `В папке кампании больше ${Math.round(MAX_FILES_BYTES / 1024 / 1024)} МБ изображений. Удалите лишние карты или портреты.`
  );
  error.quota = true;
  error.fileName = fileName;
  return error;
}

/**
 * Собирает имена файлов, на которые ссылается состояние. Одно место, чтобы
 * свалка не удалила нужное, когда у игрока карта, портрет или картинка фишки.
 * @param {object} state
 * @returns {Set<string>}
 */
function collectFileRefs(state) {
  const refs = new Set();
  const add = (value) => {
    const match = /^\/files\/([A-Za-z0-9_.-]{1,80})$/.exec(String(value || ''));
    if (match) refs.add(match[1]);
  };
  const maps = state && state.maps ? state.maps : {};
  for (const slot of Object.values(maps)) {
    if (!slot || typeof slot !== 'object') continue;
    add(slot.url);
    for (const item of Array.isArray(slot.items) ? slot.items : []) add(item && item.url);
  }
  for (const token of Array.isArray(state && state.tokens) ? state.tokens : []) add(token && token.imageUrl);
  for (const player of Array.isArray(state && state.players) ? state.players : []) add(player && player.avatar);
  // Картинки-хендауты живут в истории чата, но файл у них тот же, что у карт
  // и портретов. Без этой строки свалка удалила бы отправленное мастером.
  for (const message of Array.isArray(state && state.chatHistory) ? state.chatHistory : []) {
    add(message && message.image);
  }
  const adventure = state && state.adventure ? state.adventure : {};
  for (const actor of Array.isArray(adventure.actors) ? adventure.actors : []) add(actor && actor.image);
  for (const item of Array.isArray(adventure.items) ? adventure.items : []) add(item && item.image);
  return refs;
}

/**
 * Есть ли в вкладке карт хоть одна картинка.
 * Понимает и старый формат кампании, где на вкладке была одна карта.
 * @param {unknown} slot
 */
function mapsHaveImages(slot) {
  if (!slot || typeof slot !== 'object') return false;
  const value = /** @type {any} */ (slot);
  if (Array.isArray(value.items)) return value.items.length > 0;
  return typeof value.url === 'string';
}

class CampaignStore {
  /**
   * @param {string} rootDir папка, внутри которой лежат папки кампаний
   * @param {{maxFilesBytes?: number}} [options]
   */
  constructor(rootDir, options = {}) {
    this.rootDir = rootDir;
    // Потолок выносим в поле: тесты проверяют квоту на маленьком числе.
    this.maxFilesBytes = Number.isFinite(options.maxFilesBytes)
      ? Number(options.maxFilesBytes)
      : MAX_FILES_BYTES;
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  /** Защита от выхода за пределы папки кампаний. */
  dirFor(campaignId) {
    const id = String(campaignId || '');
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) throw new Error('Некорректный идентификатор кампании');
    return path.join(this.rootDir, id);
  }

  /** @param {string} campaignId */
  filesDir(campaignId) {
    return path.join(this.dirFor(campaignId), 'files');
  }

  /** @param {string} campaignId */
  filePath(campaignId, fileName) {
    const safeName = path.basename(String(fileName || ''));
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(safeName)) throw new Error('Некорректное имя файла');
    return path.join(this.filesDir(campaignId), safeName);
  }

  /**
   * Список сохранённых кампаний (для экрана загрузки).
   * @returns {Promise<object[]>}
   */
  async list() {
    const entries = await fsp.readdir(this.rootDir, { withFileTypes: true });
    const campaigns = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const raw = await fsp.readFile(path.join(this.rootDir, entry.name, 'campaign.json'), 'utf8');
        const data = JSON.parse(raw);
        campaigns.push({
          // Идентификатор берём из имени папки: файл мог достаться от чужой
          // кампании, и тогда data.id увёл бы к чужой папке files.
          id: entry.name,
          name: data.name,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          version: data.version || CAMPAIGN_FORMAT_VERSION,
          players: Array.isArray(data.state?.players) ? data.state.players.length : 0,
          tokens: Array.isArray(data.state?.tokens) ? data.state.tokens.length : 0,
          maps: {
            world: mapsHaveImages(data.state?.maps?.world),
            battle: mapsHaveImages(data.state?.maps?.battle),
            sketch: mapsHaveImages(data.state?.maps?.sketch)
          }
        });
      } catch {
        // Повреждённую или чужую папку просто пропускаем.
      }
    }
    campaigns.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return campaigns;
  }

  /**
   * Создаёт новую кампанию на диске.
   * @param {string} name
   * @returns {Promise<object>}
   */
  async create(name) {
    const title = sanitizeText(name, 60).trim() || 'Новая кампания';
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const campaign = {
      id,
      name: title,
      createdAt: now,
      updatedAt: now,
      version: CAMPAIGN_FORMAT_VERSION,
      state: {
        players: [],
        sheets: {},
        maps: emptyMaps(),
        activeMap: null,
        grid: { enabled: false, cell: 46 },
        tokens: [],
        diceHistory: [],
        chatHistory: [],
        journal: '',
        savedAt: now
      }
    };
    await fsp.mkdir(this.filesDir(id), { recursive: true });
    await this.save(campaign);
    return campaign;
  }

  /**
   * Читает кампанию с диска.
   * @param {string} id
   * @returns {Promise<object>}
   */
  async load(id) {
    const file = path.join(this.dirFor(id), 'campaign.json');
    const raw = await fsp.readFile(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw new Error('Файл кампании повреждён');
    // Гарантируем наличие папки для изображений. Идентификатор берём из пути
    // (он уже проверен), а не из содержимого файла: чужой id увёл бы к чужой
    // папке files.
    await fsp.mkdir(this.filesDir(id), { recursive: true });
    return {
      id: String(id),
      name: sanitizeText(data.name, 60) || 'Кампания',
      createdAt: data.createdAt || new Date().toISOString(),
      updatedAt: data.updatedAt || new Date().toISOString(),
      version: data.version || CAMPAIGN_FORMAT_VERSION,
      state: data.state && typeof data.state === 'object' ? data.state : {}
    };
  }

  /**
   * Записывает кампанию на диск (обновляет updatedAt).
   * @param {object} campaign
   * @returns {Promise<object>} та же кампания с новым updatedAt
   */
  async save(campaign) {
    const dir = this.dirFor(campaign.id);
    await fsp.mkdir(this.filesDir(campaign.id), { recursive: true });
    campaign.updatedAt = new Date().toISOString();
    campaign.version = campaign.version || CAMPAIGN_FORMAT_VERSION;
    const payload = JSON.stringify(campaign, null, 2);
    const target = path.join(dir, 'campaign.json');
    // Атомарная запись: сначала во временный файл, потом подмена.
    const tmp = `${target}.tmp`;
    await fsp.writeFile(tmp, payload, 'utf8');
    // Предыдущая версия остаётся рядом: сбой записи или неудачная миграция не
    // должны оставлять единственный испорченный файл.
    try {
      await fsp.copyFile(target, `${target}.bak`);
    } catch {
      // Первое сохранение: копировать нечего.
    }
    await fsp.rename(tmp, target);
    return campaign;
  }

  /** Папка копий кампаний: рядом с папкой кампаний, а не внутри неё. */
  backupsDir() {
    return path.join(path.dirname(this.rootDir), 'backups');
  }

  /**
   * Копирует кампанию в выбранную папку для переноса на другой компьютер.
   *
   * Копируется вся папка, а не только campaign.json: карты и портреты лежат
   * рядом, и без files экспорт открылся бы пустым.
   * @param {string} campaignId
   * @param {string} label название кампании
   * @param {string} targetDir куда положить папку
   * @returns {Promise<string>} путь к копии
   */
  async exportTo(campaignId, label, targetDir) {
    const source = this.dirFor(campaignId);
    const base = this.backupLabel(campaignId, label);
    let target = path.join(targetDir, base);
    if (fs.existsSync(target)) target = path.join(targetDir, `${base}-${Date.now()}`);
    await fsp.cp(source, target, { recursive: true, errorOnExist: true, force: false });
    return target;
  }

  /**
   * Импортирует папку кампании под новым идентификатором.
   *
   * Идентификатор в campaign.json подменяется: папка кампании называется её
   * id, и копия с чужим id спорила бы с оригиналом за одну папку files.
   * @param {string} sourceDir
   * @returns {Promise<{id: string, name: string, createdAt: string, updatedAt: string}>}
   */
  async importFrom(sourceDir) {
    const raw = await fsp.readFile(path.join(sourceDir, 'campaign.json'), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw new Error('в папке нет campaign.json');
    const id = crypto.randomUUID();
    const dest = this.dirFor(id);
    await fsp.cp(sourceDir, dest, { recursive: true, errorOnExist: true, force: false });
    data.id = id;
    data.updatedAt = new Date().toISOString();
    await fsp.writeFile(path.join(dest, 'campaign.json'), JSON.stringify(data, null, 2), 'utf8');
    return {
      id,
      name: sanitizeText(data.name, 60) || 'Импортированная кампания',
      createdAt: data.createdAt || null,
      updatedAt: data.updatedAt
    };
  }

  /**
   * Имя копии: название кампании без запрещённых в имени папки символов.
   * @param {string} campaignId
   * @param {string} [label]
   * @returns {string}
   */
  backupLabel(campaignId, label = '') {
    return String(label || campaignId)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || campaignId;
  }

  /**
   * Копии этой кампании, свежие первыми.
   *
   * Копии наследуют префикс имени кампании, поэтому чужие не попадают в
   * список: у каждой кампании свои пять копий, а не общие на весь стол.
   * @param {string} campaignId
   * @param {string} [label]
   * @returns {Promise<{name: string, path: string, mtimeMs: number}[]>}
   */
  async listBackups(campaignId, label = '') {
    const root = this.backupsDir();
    const prefix = `${this.backupLabel(campaignId, label)}-`;
    try {
      const entries = await fsp.readdir(root, { withFileTypes: true });
      const result = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
        const fullPath = path.join(root, entry.name);
        const stat = await fsp.stat(fullPath);
        result.push({ name: entry.name, path: fullPath, mtimeMs: stat.mtimeMs });
      }
      return result.sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      // Папки копий ещё нет: считаем, что копий не было.
      return [];
    }
  }

  /**
   * Когда последний раз делали копию этой кампании.
   *
   * Нужен автокопии при старте стола: она смотрит, прошли ли сутки.
   * @param {string} campaignId
   * @param {string} [label]
   * @returns {Promise<number|null>} время в миллисекундах
   */
  async lastBackupTime(campaignId, label = '') {
    const list = await this.listBackups(campaignId, label);
    return list.length ? list[0].mtimeMs : null;
  }

  /**
   * Копия всей папки кампании: JSON и все картинки. Рядом с `campaigns`
   * появляется `backups`, чтобы копия не попала в список кампаний стола.
   * Держим пять последних копий каждой кампании: иначе папка данных растёт
   * без предела, а общий лимит вытеснял бы копии соседних кампаний.
   * @param {string} campaignId
   * @param {string} [label]
   * @returns {Promise<string>} путь к копии
   */
  async backup(campaignId, label = '') {
    const source = this.dirFor(campaignId);
    const root = this.backupsDir();
    await fsp.mkdir(root, { recursive: true });
    const safe = this.backupLabel(campaignId, label);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(root, `${safe}-${stamp}`);
    await fsp.cp(source, dest, { recursive: true });

    const entries = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${safe}-`))
      .map((entry) => entry.name)
      .sort();
    while (entries.length > 5) {
      await fsp.rm(path.join(root, entries.shift()), { recursive: true, force: true });
    }
    return dest;
  }

  /**
   * Восстанавливает кампанию из копии.
   *
   * Копия сначала копируется рядом, и только потом подменяет папку кампании:
   * сбой на полпути не должен оставить стол без данных. Источник при этом
   * остаётся на месте, поэтому повторная попытка возможна.
   * @param {string} campaignId
   * @param {string} backupName имя папки из listBackups
   * @returns {Promise<string>} путь к восстановленной кампании
   */
  async restoreBackup(campaignId, backupName) {
    const name = String(backupName || '');
    const root = this.backupsDir();
    // Имя приходит из интерфейса, поэтому проверяем его как путь: иначе
    // «../../» вывел бы восстановление за пределы папки копий.
    if (!name || name !== path.basename(name) || name.includes('..')) {
      throw new Error('Некорректное имя копии');
    }
    const source = path.join(root, name);
    if (path.dirname(path.resolve(source)) !== path.resolve(root)) {
      throw new Error('Копия вне папки копий');
    }
    const stat = await fsp.stat(source).catch(() => null);
    if (!stat || !stat.isDirectory()) throw new Error('Копия не найдена');

    const target = this.dirFor(campaignId);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const incoming = `${target}.restore-${stamp}`;
    await fsp.cp(source, incoming, { recursive: true });
    await fsp.rm(target, { recursive: true, force: true });
    try {
      await fsp.rename(incoming, target);
    } catch (error) {
      // Перенос не удался: возвращаем копию на место обычным копированием,
      // чтобы восстановление не потерялось из-за одного сбоя переименования.
      await fsp.cp(incoming, target, { recursive: true });
      await fsp.rm(incoming, { recursive: true, force: true }).catch(() => {});
    }
    return target;
  }

  /**
   * Удаляет кампанию целиком.
   * @param {string} id
   */
  async remove(id) {
    await fsp.rm(this.dirFor(id), { recursive: true, force: true });
  }

  /**
   * Сохраняет изображение в папку кампании и возвращает его имя файла.
   * @param {string} campaignId
   * @param {Buffer} buffer
   * @param {string} ext
   * @returns {Promise<string>}
   */
  async saveImage(campaignId, buffer, ext) {
    const safeExt = IMAGE_EXTENSIONS[String(ext).toLowerCase()] || 'png';
    const fileName = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}.${safeExt}`;
    await fsp.mkdir(this.filesDir(campaignId), { recursive: true });
    const used = await this.filesBytes(campaignId);
    if (used + (buffer ? buffer.length : 0) > this.maxFilesBytes) throw quotaError(fileName);
    await fsp.writeFile(this.filePath(campaignId, fileName), buffer);
    return fileName;
  }

  /**
   * Суммарный размер всех изображений кампании.
   * @param {string} campaignId
   * @returns {Promise<number>}
   */
  async filesBytes(campaignId) {
    let total = 0;
    let entries;
    try {
      entries = await fsp.readdir(this.filesDir(campaignId), { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const stat = await fsp.stat(path.join(this.filesDir(campaignId), entry.name));
        total += stat.size;
      } catch {
        // Файл исчез между чтением папки и stat: для суммы это ноль.
      }
    }
    return total;
  }

  /**
   * Удаляет файлы, на которые больше никто не ссылается. Вызывается после
   * сохранения: карту, фишку или портрет могли заменить или удалить, а файл
   * оставался лежать на диске навсегда.
   * @param {string} campaignId
   * @param {object} state сериализованное состояние кампании
   * @param {{keepMs?: number}} [options]
   * @returns {Promise<number>} сколько файлов удалено
   */
  async sweepFiles(campaignId, state, options = {}) {
    const keepMs = Number.isFinite(options.keepMs) ? options.keepMs : SWEEP_KEEP_MS;
    const keep = collectFileRefs(state);
    let entries;
    try {
      entries = await fsp.readdir(this.filesDir(campaignId), { withFileTypes: true });
    } catch {
      return 0;
    }
    const now = Date.now();
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile() || keep.has(entry.name)) continue;
      const full = path.join(this.filesDir(campaignId), entry.name);
      try {
        // eslint-disable-next-line no-await-in-loop
        const stat = await fsp.stat(full);
        // keepMs: 0 выключает окно защиты: только что записанный файл тоже
        // удаляется. Без этой ветки mtime, округлённый вперёд, оставлял его
        // навсегда, и свалка возвращала 0 вместо удаления.
        if (keepMs > 0 && now - stat.mtimeMs < keepMs) continue;
        // eslint-disable-next-line no-await-in-loop
        await fsp.unlink(full);
        removed += 1;
      } catch {
        // Уже удалён или занят: следующий проход подберёт.
      }
    }
    return removed;
  }

  /**
   * Определяет размер сохранённого файла (0, если файла нет).
   * @param {string} campaignId
   * @param {string} fileName
   * @returns {Promise<number>}
   */
  async fileSize(campaignId, fileName) {
    try {
      const stat = await fsp.stat(this.filePath(campaignId, fileName));
      return stat.size;
    } catch {
      return 0;
    }
  }
}

module.exports = { CampaignStore, IMAGE_EXTENSIONS, MAX_FILES_BYTES, collectFileRefs };
