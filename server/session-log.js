/**
 * Журнал сессии: JSONL рядом с campaign.json.
 *
 * Один файл на день (session-YYYY-MM-DD.jsonl), ротация по размеру в .1.
 * Лог не должен ломать стол: любые ошибки диска гасятся на месте.
 */

const fs = require('fs');
const path = require('path');

const MAX_LOG_BYTES = 5 * 1024 * 1024;

class SessionLog {
  constructor(dir) {
    this.dir = dir;
    this.date = '';
    this.file = '';
  }

  currentFile() {
    const date = new Date().toISOString().slice(0, 10);
    if (date !== this.date) {
      this.date = date;
      this.file = path.join(this.dir, `session-${date}.jsonl`);
      try {
        fs.mkdirSync(this.dir, { recursive: true });
      } catch (error) {
        // Папка могла заняться другим процессом: валидная ситуация.
      }
    }
    return this.file;
  }

  append(event) {
    const file = this.currentFile();
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
    } catch (error) {
      // Журнал полезен, но не критичен: стол продолжает работу без него.
    }
  }
}

const loggers = new Map();

/**
 * Логгер сессии для папки кампании: отдельный экземпляр на папку,
 * чтобы файлы разных кампаний не перемешивались.
 * @param {string} dir
 */
function sessionLogger(dir) {
  let logger = loggers.get(dir);
  if (!logger) {
    logger = new SessionLog(dir);
    loggers.set(dir, logger);
  }
  return logger;
}

/**
 * Собирает экспорт сессии в markdown из всех файлов дневника кампании.
 * Шёпоты не выгружаются: это приватный канал в паре.
 * @param {string} dir
 * @returns {{text: string, name: string}}
 */
function exportSessionMarkdown(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => /^session-\d{4}-\d{2}-\d{2}(\.jsonl(\.1)?)?$/.test(name)).sort();
  } catch (error) {
    return { text: '', name: 'session.md' };
  }
  if (!files.length) return { text: '', name: 'session.md' };
  const lines = [];
  for (const name of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch (bad) {
          continue;
        }
        // Шёпот экспортируется только по явной просьбе; экспорт не подглядывает.
        if (entry.event === 'chat' && entry.whisper) continue;
        const time = String(entry.time || '').slice(11, 19);
        if (entry.event === 'chat') {
          lines.push(`${time} ${entry.from || '?'}: ${entry.text || ''}`);
        } else if (entry.event === 'combat') {
          lines.push(`${time} Бой: ${entry.mode ? 'включён' : 'выключен'}`);
        } else {
          lines.push(`${time} ${JSON.stringify(entry)}`);
        }
      }
    } catch (readError) {
      // Битый файл пропускаем: остальная хронология читабельнее пустого экспорта.
    }
  }
  const header = `# Хронология сессии\n\nЭкспорт от ${new Date().toISOString().slice(0, 10)}\n\n`;
  return { text: header + lines.join('') + '\n', name: `session-${files[0]}.md` };
}

module.exports = {
  sessionLogger,
  exportSessionMarkdown
};
