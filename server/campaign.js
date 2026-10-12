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
   */
  constructor(rootDir) {
    this.rootDir = rootDir;
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
          id: data.id,
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
    // Гарантируем наличие папки для изображений.
    await fsp.mkdir(this.filesDir(data.id), { recursive: true });
    return {
      id: data.id,
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
    await fsp.rename(tmp, target);
    return campaign;
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
    await fsp.writeFile(this.filePath(campaignId, fileName), buffer);
    return fileName;
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

module.exports = { CampaignStore, IMAGE_EXTENSIONS };
