'use strict';

/**
 * Ярлык версии для интерфейса.
 *
 * Раньше правило дописывало «b» всегда, и версии без хвоста сборки показывались
 * как «1.1.1b». Теперь хвост появляется только там, где он есть в самой записи:
 * «0.12.1-b» показывается как «0.12.1b», а «1.1.1» как «1.1.1».
 *
 * Правило живёт здесь, потому что его читают и приложение, и проверка собранной
 * программы: своя копия в каждом разъехалась бы при первом же выпуске.
 *
 * Ноль в конце номера отбрасывается, но только в конце: «1.0.0-b» должен
 * показаться как «1b», а «1.0.1-b» как «1.0.1b».
 * @param {string} version Версия из package.json.
 * @returns {string}
 */
function versionLabel(version) {
  const raw = String(version || '0.0.0');
  const dash = raw.indexOf('-');
  if (dash < 0) return raw;
  const core = raw.slice(0, dash);
  const tail = raw.slice(dash + 1).trim().toLowerCase();
  // Хвост вида «b», «beta», «rc1» — это сборка, и в ярлыке она читается как «b».
  const isPrerelease = /^(b|beta|rc|alpha)/.test(tail);
  return `${core.replace(/\.0$/, '')}${isPrerelease ? 'b' : ''}`;
}

module.exports = { versionLabel };
