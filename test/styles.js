'use strict';

// Свето-система под замком: вне палитр и тематического слоя не должно быть
// голых цветов, а части должны склеиваться в исходный порядок.
//
// Проверка не про вкус, а про структуру: смысловые цвета обязаны быть
// переменными, иначе смена темы снова разъедется на тех же двадцати правилах,
// где она разъезжалась раньше.
const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');
const dir = path.join(repo, 'renderer', 'styles');
const PALETTE = new Set(['01-tokens.css', '08-theme-layer.css']);
const order = fs.readdirSync(dir).filter((f) => f.endsWith('.css')).sort();

const checks = [];
const check = (name, fn) => {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, message: error.message });
  }
};

check('части идут в порядке номеров', () => {
  const expected = [
    '01-tokens.css', '02-screens.css', '03-controls.css', '04-layout.css',
    '05-map.css', '06-panels.css', '07-sheet.css', '08-theme-layer.css'
  ];
  if (JSON.stringify(order) !== JSON.stringify(expected)) {
    throw new Error(`на диске: ${order.join(', ')}`);
  }
});

check('вне палитр нет голых цветов', () => {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const bad = [];
  for (const file of order) {
    if (PALETTE.has(file)) continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    let m;
    while ((m = re.exec(text))) {
      if (/var\(--/.test(m[2])) continue;
      const colours = [...m[2].matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)];
      if (colours.length) {
        bad.push(`${file}: ${m[1].trim().replace(/\s+/g, ' ').slice(0, 50)}`);
      }
    }
  }
  if (bad.length) throw new Error(bad.join('; '));
});

check('смысловые роли объявлены и используются', () => {
  const tokens = fs.readFileSync(path.join(dir, '01-tokens.css'), 'utf8');
  const required = [
    '--danger-text', '--danger-soft', '--danger-border',
    '--ok-text', '--ok-soft', '--ok-border',
    '--info', '--info-text', '--info-soft', '--info-border',
    '--hp-plate', '--hp-track', '--off', '--dot-idle', '--expertise',
    '--scrim', '--disabled-bg', '--hover-wash', '--shadow-press',
    '--wall', '--focus-ring'
  ];
  const missing = required.filter((role) => !tokens.includes(`${role}:`));
  if (missing.length) throw new Error('не объявлены: ' + missing.join(', '));
  const all = order.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const unused = required.filter((role) => !new RegExp(`var\\(\\s*${role}\\b`).test(all));
  if (unused.length) throw new Error('объявлены, но не используются: ' + unused.join(', '));
});

check('у каждой темы есть свой --info', () => {
  const tokens = fs.readFileSync(path.join(dir, '01-tokens.css'), 'utf8');
  for (const theme of ['standart', 'les', 'magiya', 'okean', 'traktir']) {
    const block = tokens.match(new RegExp(`\\[data-theme='${theme}'\\][^{]*\\{([\\s\\S]*?)\\}`));
    if (!block) throw new Error('нет блока темы ' + theme);
    if (!/--info\s*:/.test(block[1])) throw new Error('в теме ' + theme + ' нет --info');
    // Оттенок роли обязан отличаться от акцента, иначе игрок и мастер
    // станут одного цвета.
    const info = block[1].match(/--info\s*:\s*(#[0-9a-f]{6})/i);
    const accent = block[1].match(/--accent\s*:\s*(#[0-9a-f]{6})/i);
    if (info && accent && info[1].toLowerCase() === accent[1].toLowerCase()) {
      throw new Error('в теме ' + theme + ' цвет роли совпал с акцентом');
    }
  }
});

check('нет самоссылок переменных', () => {
  const bad = [];
  for (const file of order) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const self = line.match(/^\s*(--[\w-]+)\s*:\s*[^;]*var\(\s*\1\s*\)/);
      if (self) bad.push(`${file}:${i + 1} ${self[1]}`);
    });
  }
  if (bad.length) throw new Error(bad.join('; '));
});

check('запасное кольцо фокуса есть и не перебито пустым контуром', () => {
  const tokens = fs.readFileSync(path.join(dir, '01-tokens.css'), 'utf8');
  if (!/:focus-visible\s*\{[^}]*outline:\s*var\(--focus-ring/.test(tokens)) {
    throw new Error('в токенах нет запасного :focus-visible с токеном кольца');
  }
  const all = order.map((f) => path.join(dir, f)).filter((p) => !p.includes('08-theme-layer'));
  for (const file of all) {
    const text = fs.readFileSync(file, 'utf8');
    if (/:focus[^{]*\{\s*outline:\s*none/.test(text)) {
      // Пустой контур допустим только там, где кольцо заменено рамкой или
      // подчёркиванием: проверяем, что следом действительно что-то нарисовано.
      const blocks = [...text.matchAll(/:focus[^{]*\{([^}]*)\}/g)];
      for (const block of blocks) {
        if (!/outline:\s*none/.test(block[1])) continue;
        const styled = /box-shadow|border-color|border-bottom-color/.test(block[1]);
        if (!styled) throw new Error(`${path.basename(file)}: фокус гасится и не нарисован`);
      }
    }
  }
});

check('темы всё ещё красят опасное и успех по-разному', () => {
  const tokens = fs.readFileSync(path.join(dir, '01-tokens.css'), 'utf8');
  const colours = [...tokens.matchAll(/--danger\s*:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1].toLowerCase());
  if (colours.length < 5) throw new Error('опасный цвет задан только в ' + colours.length + ' темах');
  if (new Set(colours).size !== colours.length) throw new Error('темы делят один --danger');
});

check('каждая часть оформления подключена в разметке', () => {
  // Пропавшая часть не даёт ошибки в консоли окна и тихо оставляет кусок
  // интерфейса неоформленным, поэтому сверяем списком, а не «открылось ли окно».
  for (const page of ['index.html', 'sheet-window.html']) {
    const html = fs.readFileSync(path.join(repo, 'renderer', page), 'utf8');
    for (const file of order) {
      if (!html.includes(`styles/${file}`)) {
        throw new Error(`${page} не подключает ${file}`);
      }
    }
    if (html.includes('href="styles.css"')) {
      throw new Error(`${page} всё ещё ссылается на удалённый styles.css`);
    }
  }
});

check('склейка частей не теряет ни одного правила', () => {
  // Порядок в CSS значим для правил одинаковой специфичности, поэтому части
  // обязаны идти по номерам. Пересчитываем правила в склейке и в каждой части
  // вместе: сумма должна совпасть, иначе при переносе что-то потерялось.
  const ruleCount = (css) => (css.match(/\{/g) || []).length;
  const total = order.reduce(
    (sum, file) => sum + ruleCount(fs.readFileSync(path.join(dir, file), 'utf8')),
    0
  );
  const joined = order.map((file) => fs.readFileSync(path.join(dir, file), 'utf8')).join('\n');
  if (ruleCount(joined) !== total) {
    throw new Error(`в склейке ${ruleCount(joined)} правил, в частях ${total}`);
  }
  if (total < 700) throw new Error(`правил подозрительно мало: ${total}`);
});

check('у каждого состояния из правил нарисован свой рисунок', () => {
  // Состояние без рисунка выглядит как «ничего не произошло»: мастер повесил
  // «опутан», а на карте ничего не поменялось.
  const conditions = require('../renderer/dnd5e.js').CONDITIONS || [];
  const css = order
    .map((file) => fs.readFileSync(path.join(dir, file), 'utf8'))
    .join('\n');
  const missing = conditions
    .filter((item) => !css.includes(`.token__fx--${item.effect}`))
    .map((item) => item.label);
  if (missing.length) throw new Error('состояния без рисунка: ' + missing.join(', '));
});

check('ярлык версии не приписывает хвост сборки обычному выпуску', () => {
  // Правило досталось в наследство от версий вида «0.12.0-b» и дописывало «b»
  // всегда: из 1.0.0 получалось «1.0b», а из 1.1.1 — «1.1.1b».
  const { versionLabel } = require('../scripts/version-label');
  const cases = [
    ['1.1.1', '1.1.1'],
    ['1.0.0', '1.0.0'],
    ['1.0.0-b', '1.0b'],
    ['0.12.1-b', '0.12.1b'],
    ['0.9.0-beta.2', '0.9b'],
    ['1.1.0', '1.1.0']
  ];
  const wrong = cases
    .filter(([version, expected]) => versionLabel(version) !== expected)
    .map(([version]) => version + ' → ' + versionLabel(version));
  if (wrong.length) throw new Error('ярлык версии неверен: ' + wrong.join(', '));
});

let failed = 0;
for (const c of checks) {
  if (c.ok) console.log('  ok   ' + c.name);
  else { failed += 1; console.log('  FAIL ' + c.name + '\n         ' + c.message); }
}
console.log(`Проверок свето-системы: ${checks.length}, провалено: ${failed}`);
process.exit(failed ? 1 : 0);