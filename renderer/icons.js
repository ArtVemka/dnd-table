'use strict';

/**
 * Фэнтезийные иконки интерфейса.
 *
 * Один спрайт на все окна: разметка ссылается на символы через <use>, а
 * скрипты создают тот же <use> из JS. Иконки наследуют currentColor, поэтому
 * сами не знают о теме и работают в шести палитрах.
 */

(function (global) {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const SYMBOLS = {
    tome: '<path d="M3 2.5h7.5A1.5 1.5 0 0 1 12 4v9.5H4.5A1.5 1.5 0 0 1 3 12z"/><path d="M3 4.5h9"/><path d="M5.5 7h4M5.5 9h4M5.5 11h2.5"/>',
    chest: '<path d="M2.5 8.5h11V13h-11z"/><path d="M2.5 8.5C2.5 5.9 5 4 8 4s5.5 1.9 5.5 4.5"/><path d="M7.1 8.5v2.3h1.8V8.5"/>',
    portal: '<path d="M3.5 13.2V7a4.5 4.5 0 0 1 9 0v6.2"/><path d="M2.5 13.2h11"/><path d="M8 5.6l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4L6 8.2l1.4-.6z"/>',
    quill: '<path d="M12.8 2.2C8.5 2.6 5 5 3.6 9L2.4 12.4l3.4-.6c3.6-1.5 5.8-4.6 7-9.6z"/><path d="M3.4 11.6C5 8.4 7.2 6 10 4.6"/>',
    scroll: '<path d="M4 3.5h8v9H4z"/><path d="M3 3.5a1 1 0 0 1 1-1h1v10H4a1 1 0 0 1-1-1z"/><path d="M13 12.5a1 1 0 0 1-1 1h-1v-10h1a1 1 0 0 1 1 1z"/><path d="M6 6h4M6 8h4M6 10h2.5"/>',
    d20: '<path d="M8 1.6 13.6 4.8v6.4L8 14.4 2.4 11.2V4.8z"/><path d="M8 4.2 10.8 9H5.2z"/><path d="M8 4.2v-2.6M10.8 9l3 2M5.2 9l-3 2"/>',
    chat: '<path d="M3 3.5h10v7H7.5L4.5 13v-2.5H3z"/><path d="M5.5 6h5M5.5 8h3.5"/>',
    helm: '<path d="M4 12V7a4 4 0 0 1 8 0v5"/><path d="M4 9h8"/><path d="M6 12v1.5M10 12v1.5"/><path d="M6.5 6.5h3"/>',
    swords: '<path d="M3.2 12.8 12.8 3.2M10.8 2.2l3 3M12.8 3.2 10 2.2M3.2 12.8 2.2 10"/><path d="M3.2 3.2 12.8 12.8M5.2 2.2l-3 3M2.2 5.2l3-3M12.8 12.8l1-2.8"/>',
    shield: '<path d="M8 1.8 13 3.6v4.6c0 3-2.1 5-5 6-2.9-1-5-3-5-6V3.6z"/><path d="M8 5v5M5.5 7.5h5"/>',
    pouch: '<path d="M5 5c-1 1-2 2.4-2 4.5C3 12 5 14 8 14s5-2 5-4.5C13 7.4 12 6 11 5z"/><path d="M5.5 4.5c0-1.2 1.1-2 2.5-2s2.5.8 2.5 2"/><path d="M6 5h4"/>',
    tankard: '<path d="M5 3h6v10H5z"/><path d="M11 5h2v5h-2"/><path d="M5 5.5h6M5 8h6"/><path d="M6 1.5h4"/>',
    horseshoe: '<path d="M4 13V8a4 4 0 0 1 8 0v5"/><path d="M4 13h2M10 13h2"/><path d="M5.5 7.5h5"/>',
    gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4"/>',
    candle: '<path d="M8 2c1.2 2 2 3 2 4.2A2 2 0 0 1 6 6.2C6 5 6.8 4 8 2z"/><path d="M6 8h4v6H6z"/><path d="M4.5 14h7"/>',
    key: '<circle cx="5" cy="6" r="2.5"/><path d="M6.8 7.8 13 14M10.5 11.5l1.5-1.5M12 13l1.5-1.5"/>',
    eye: '<path d="M1.8 8S4.1 4.2 8 4.2 14.2 8 14.2 8 11.9 11.8 8 11.8 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.7"/>',
    'eye-off': '<path d="M2 2l12 12"/><path d="M6.2 4.5A7.6 7.6 0 0 1 8 4.2c3.9 0 6.2 3.8 6.2 3.8a9 9 0 0 1-2 2.3"/><path d="M4 6.1A9.6 9.6 0 0 0 1.8 8S4.1 11.8 8 11.8c.7 0 1.3-.1 1.9-.3"/>',
    flame: '<path d="M8 1.8c2 2.6 3.4 4.2 3.4 6.4A3.4 3.4 0 0 1 4.6 8.2c0-1.2.5-2.2 1.4-3.3.3 1 .9 1.6 1.7 1.9.1-1.6.1-3 .3-5z"/>',
    leaf: '<path d="M13.2 2.8C8.4 3.2 4.7 5.7 3.3 9.8L2.6 12.9l3.4-.7c3.7-1.6 6-5 6.4-9.4z"/><path d="M3.6 11.9C5.1 8.7 7.7 6 11 4.8"/>',
    wave: '<path d="M1.8 6c1.4-1.6 2.8-1.6 4.2 0s2.8 1.6 4.2 0 2.8-1.6 4.2 0"/><path d="M1.8 10c1.4-1.6 2.8-1.6 4.2 0s2.8 1.6 4.2 0 2.8-1.6 4.2 0"/>',
    star: '<path d="M8 1.8l1.8 4 4.4.4-3.4 2.9 1 4.3L8 11.1l-3.8 2.3 1-4.3L1.8 6.2l4.4-.4z"/>',
    map: '<path d="M2.5 4.5 6 3l4 1.5 3.5-1.5v9L10 13.5 6 12 2.5 13.5z"/><path d="M6 3v9M10 4.5v9"/>',
    cloud: '<path d="M4.5 12h7a2.5 2.5 0 0 0 .3-5 3.5 3.5 0 0 0-6.7-.8A2.6 2.6 0 0 0 4.5 12z"/>',
    grid: '<path d="M2 6h12M2 10h12M6 2v12M10 2v12"/>',
    rune: '<circle cx="8" cy="8" r="5.5"/><path d="M8 3.5v9M4.5 6.5 8 9l3.5-2.5M5.5 11 8 8.5l2.5 2.5"/>',
    horn: '<path d="M3 6.5c3.5 0 6.5 1.5 8.5 4.5l1.5-1c-.8-3-3-5.2-6-6z"/><path d="M3 6.5v4c1.5 0 3 .5 4.2 1.5"/>',
    upload: '<path d="M8 11V3M5 6l3-3 3 3"/><path d="M3 12v1.5h10V12"/>',
    magnifier: '<circle cx="7" cy="7" r="4.2"/><path d="m10.4 10.4 3 3"/><path d="M5.2 7h3.6M7 5.2v3.6"/>',
    undo: '<path d="M5 4H2v3"/><path d="M2 7a6 6 0 1 1 2 4"/>',
    trash: '<path d="M4 5h8M6.5 5V3h3v2M5.5 5l.7 8h3.6l.7-8"/>'
  };

  /** Спрайт вставляется первым узлом body: <use> ссылается на него. */
  function buildSprite() {
    if (document.getElementById('dnd-icon-sprite')) return;
    const sprite = document.createElementNS(SVG_NS, 'svg');
    sprite.id = 'dnd-icon-sprite';
    sprite.setAttribute('class', 'icon-sprite');
    sprite.setAttribute('aria-hidden', 'true');
    sprite.setAttribute('focusable', 'false');
    for (const [name, body] of Object.entries(SYMBOLS)) {
      const symbol = document.createElementNS(SVG_NS, 'symbol');
      symbol.id = `i-${name}`;
      symbol.setAttribute('viewBox', '0 0 16 16');
      symbol.innerHTML = `<g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
      sprite.appendChild(symbol);
    }
    document.body.insertBefore(sprite, document.body.firstChild);
  }

  /**
   * SVG-иконка для динамических панелей.
   * @param {string} name имя символа без префикса
   * @param {string} [className]
   * @returns {SVGElement}
   */
  function use(name, className = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    const ref = document.createElementNS(SVG_NS, 'use');
    ref.setAttribute('href', `#i-${name}`);
    svg.appendChild(ref);
    return svg;
  }

  buildSprite();
  global.DnDIcons = { use, names: Object.keys(SYMBOLS) };
})(window);
