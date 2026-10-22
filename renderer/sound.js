'use strict';

/**
 * Звуковые скины интерфейса.
 *
 * Звук не привязан к визуальной теме: мастер может оставить лесную палитру и
 * включить металлические щелчки. Всё синтезируется через Web Audio, поэтому в
 * сборке нет ни одного аудиофайла, а громкость и выключение работают сразу.
 */

(function initSound(global) {
  const ENABLED_KEY = 'dnd-table.sound.enabled';
  const VOLUME_KEY = 'dnd-table.sound.volume';
  const SKIN_KEY = 'dnd-table.sound.skin';
  const AMBIENT_KEY = 'dnd-table.sound.ambient';
  const AMBIENT_VOLUME_KEY = 'dnd-table.sound.ambientVolume';

  const SKINS = [
    { id: 'standart', label: 'Щелчок', note: 'сухой деревянный щелчок' },
    { id: 'les', label: 'Шелест', note: 'листва и мягкий удар' },
    { id: 'okean', label: 'Волна', note: 'прибой и пузырьки' },
    { id: 'magiya', label: 'Магический звон', note: 'стеклянный колокольчик' },
    { id: 'par', label: 'Шестерни', note: 'металлический щелчок' }
  ];

  const KNOWN = SKINS.map((skin) => skin.id);
  let context = null;
  let noise = null;
  let ambientNoise = null;
  let ambient = null;
  let ambientScene = '';
  let ambientUnlocked = false;
  let previewTimer = null;
  let previewScene = '';

  /** @param {string} key @param {string} fallback */
  function read(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  /** @param {string} key @param {string} value */
  function write(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Настройка не переживёт перезапуск, но звук не должен падать.
    }
  }

  function enabled() {
    return read(ENABLED_KEY, 'off') === 'on';
  }

  function volume() {
    const value = Number(read(VOLUME_KEY, '55'));
    return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) / 100 : 0.55;
  }

  /**
   * Громкость атмосферы отдельная: фон и щелчки подстраивают под разное.
   * Пока ползунок не трогали, атмосфера идёт за общей громкостью: у тех, кто
   * уже настроил звук, уровень после обновления не прыгнет.
   * @returns {number} 0..1
   */
  function ambientVolume() {
    const stored = read(AMBIENT_VOLUME_KEY, null);
    if (stored === null) return volume();
    const value = Number(stored);
    return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) / 100 : volume();
  }

  function skin() {
    const value = read(SKIN_KEY, 'standart');
    return KNOWN.includes(value) ? value : 'standart';
  }

  function ambientEnabled() {
    return read(AMBIENT_KEY, 'on') !== 'off';
  }

  function currentTheme() {
    return (global.DnDTheme && global.DnDTheme.current()) || 'standart';
  }

  /** @returns {AudioContext|null} */
  function ensure() {
    try {
      if (!context) {
        const Ctor = global.AudioContext || global.webkitAudioContext;
        if (!Ctor) return null;
        context = new Ctor();
      }
      if (context.state === 'suspended') context.resume().catch(() => {});
      return context;
    } catch {
      return null;
    }
  }

  /** @param {AudioContext} ctx */
  function noiseBuffer(ctx) {
    if (!noise) {
      const length = Math.floor(ctx.sampleRate * 0.5);
      noise = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    }
    return noise;
  }

  /**
   * Длинный шум для атмосферы. Края сшиты перекрёстным затуханием, иначе
   * на стыке петли каждые полсекунды слышался бы щелчок.
   * @param {AudioContext} ctx
   */
  function ambientNoiseBuffer(ctx) {
    if (!ambientNoise) {
      const length = Math.floor(ctx.sampleRate * 2);
      ambientNoise = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = ambientNoise.getChannelData(0);
      for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
      const fade = Math.floor(ctx.sampleRate * 0.12);
      for (let i = 0; i < fade; i += 1) {
        const edge = data[length - fade + i];
        const start = data[i];
        data[length - fade + i] = edge * (1 - i / fade) + start * (i / fade);
      }
    }
    return ambientNoise;
  }

  /**
   * Короткий тон с мягкой атакой и затуханием.
   * @param {AudioContext} ctx
   * @param {number} freq
   * @param {number} duration
   * @param {number} gain
   * @param {OscillatorType} [type]
   * @param {number} [endFreq]
   */
  function tone(ctx, freq, duration, gain, type = 'sine', endFreq = freq) {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (endFreq !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + duration);
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain * volume()), now + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(amp).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  /**
   * Шумовой всплеск: шелест, прибой, трение металла.
   * @param {AudioContext} ctx
   * @param {number} duration
   * @param {number} gain
   * @param {number} freq
   * @param {number} [q]
   * @param {'lowpass'|'highpass'|'bandpass'} [filterType]
   */
  function hiss(ctx, duration, gain, freq, q = 0.8, filterType = 'bandpass') {
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(freq, now);
    filter.Q.setValueAtTime(q, now);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain * volume()), now + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter).connect(amp).connect(ctx.destination);
    source.start(now);
    source.stop(now + duration + 0.02);
  }

  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} dest
   * @param {number} freq
   * @param {number} duration
   * @param {number} gain
   * @param {OscillatorType} [type]
   * @param {number} [endFreq]
   */
  function ambientTone(ctx, dest, freq, duration, gain, type = 'sine', endFreq = freq) {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (endFreq !== freq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + duration);
    }
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), now + 0.02);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(amp).connect(dest);
    osc.start(now);
    osc.stop(now + duration + 0.03);
  }

  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} dest
   * @param {number} duration
   * @param {number} gain
   * @param {number} freq
   * @param {number} [q]
   * @param {BiquadFilterType} [type]
   */
  function ambientHiss(ctx, dest, duration, gain, freq, q = 0.8, type = 'bandpass') {
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = ambientNoiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, now);
    filter.Q.setValueAtTime(q, now);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), now + 0.03);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter).connect(amp).connect(dest);
    source.start(now);
    source.stop(now + duration + 0.03);
  }

  /** @param {AudioContext} ctx */
  function ambientSource(ctx) {
    const source = ctx.createBufferSource();
    source.buffer = ambientNoiseBuffer(ctx);
    source.loop = true;
    return source;
  }

  /**
   * Медленное дыхание параметра. Глубина задаётся в единицах параметра,
   * поэтому для частоты это герцы, а для громкости — доля усиления.
   * @param {AudioContext} ctx
   * @param {number} rate
   * @param {number} depth
   * @param {AudioParam} target
   */
  function ambientLfo(ctx, rate, depth, target) {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.frequency.value = rate;
    amp.gain.value = depth;
    osc.connect(amp).connect(target);
    osc.start();
    return osc;
  }

  /** @param {object} bag @param {number} min @param {number} max @param {Function} run */
  function ambientLater(bag, min, max, run) {
    bag.timers.push(setTimeout(run, min + Math.random() * (max - min)));
  }

  /** @param {AudioContext} ctx @param {GainNode} master @param {object} bag */
  function buildLes(ctx, master, bag) {
    const wind = ambientSource(ctx);
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 420;
    windFilter.Q.value = 0.6;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.12;
    wind.connect(windFilter).connect(windGain).connect(master);
    wind.start();
    bag.sources.push(wind);
    bag.oscs.push(ambientLfo(ctx, 0.07, 0.045, windGain.gain));
    bag.oscs.push(ambientLfo(ctx, 0.05, 90, windFilter.frequency));

    const leaves = ambientSource(ctx);
    const leafFilter = ctx.createBiquadFilter();
    leafFilter.type = 'bandpass';
    leafFilter.frequency.value = 2600;
    leafFilter.Q.value = 0.55;
    const leafGain = ctx.createGain();
    leafGain.gain.value = 0.028;
    leaves.connect(leafFilter).connect(leafGain).connect(master);
    leaves.start();
    bag.sources.push(leaves);
    bag.oscs.push(ambientLfo(ctx, 0.17, 0.016, leafGain.gain));

    const bird = () => {
      if (!bag.alive) return;
      const base = 1900 + Math.random() * 1500;
      const notes = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < notes; i += 1) {
        setTimeout(() => {
          if (!bag.alive) return;
          ambientTone(
            ctx, master, base * (1 + i * 0.07), 0.075, 0.012, 'sine',
            base * (1.22 + i * 0.09)
          );
        }, i * 95);
      }
      ambientLater(bag, 2800, 8000, bird);
    };
    bird();
  }

  /** @param {AudioContext} ctx @param {GainNode} master @param {object} bag */
  function buildOkean(ctx, master, bag) {
    const surf = ambientSource(ctx);
    const surfFilter = ctx.createBiquadFilter();
    surfFilter.type = 'lowpass';
    surfFilter.frequency.value = 520;
    surfFilter.Q.value = 0.7;
    const surfGain = ctx.createGain();
    surfGain.gain.value = 0.13;
    surf.connect(surfFilter).connect(surfGain).connect(master);
    surf.start();
    bag.sources.push(surf);
    bag.oscs.push(ambientLfo(ctx, 0.08, 0.055, surfGain.gain));
    bag.oscs.push(ambientLfo(ctx, 0.05, 180, surfFilter.frequency));

    const spray = ambientSource(ctx);
    const sprayFilter = ctx.createBiquadFilter();
    sprayFilter.type = 'highpass';
    sprayFilter.frequency.value = 1800;
    const sprayGain = ctx.createGain();
    sprayGain.gain.value = 0.011;
    spray.connect(sprayFilter).connect(sprayGain).connect(master);
    spray.start();
    bag.sources.push(spray);
    bag.oscs.push(ambientLfo(ctx, 0.11, 0.006, sprayGain.gain));

    const swell = () => {
      if (!bag.alive) return;
      ambientTone(ctx, master, 74, 2.6, 0.011, 'sine', 54);
      ambientLater(bag, 6000, 13000, swell);
    };
    swell();
  }

  /** @param {AudioContext} ctx @param {GainNode} master @param {object} bag */
  function buildMagiya(ctx, master, bag) {
    [261.63, 329.63, 392.0, 523.25].forEach((freq, index) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.value = 0.012 / (index + 1);
      osc.connect(gain).connect(master);
      osc.start();
      bag.oscs.push(osc);
      bag.oscs.push(ambientLfo(ctx, 0.03 + index * 0.007, 0.0035, gain.gain));
    });

    const shimmer = ambientSource(ctx);
    const shimmerFilter = ctx.createBiquadFilter();
    shimmerFilter.type = 'bandpass';
    shimmerFilter.frequency.value = 5200;
    shimmerFilter.Q.value = 1.2;
    const shimmerGain = ctx.createGain();
    shimmerGain.gain.value = 0.005;
    shimmer.connect(shimmerFilter).connect(shimmerGain).connect(master);
    shimmer.start();
    bag.sources.push(shimmer);

    const chime = () => {
      if (!bag.alive) return;
      const scale = [1046.5, 1174.66, 1318.51, 1567.98, 2093.0];
      ambientTone(ctx, master, scale[Math.floor(Math.random() * scale.length)], 0.9, 0.011);
      ambientLater(bag, 3500, 9000, chime);
    };
    chime();
  }

  /** @param {AudioContext} ctx @param {GainNode} master @param {object} bag */
  function buildPar(ctx, master, bag) {
    const hum = ctx.createOscillator();
    hum.type = 'sawtooth';
    hum.frequency.value = 55;
    const humFilter = ctx.createBiquadFilter();
    humFilter.type = 'lowpass';
    humFilter.frequency.value = 180;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.014;
    hum.connect(humFilter).connect(humGain).connect(master);
    hum.start();
    bag.oscs.push(hum);

    const rumble = ambientSource(ctx);
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 320;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0.038;
    rumble.connect(rumbleFilter).connect(rumbleGain).connect(master);
    rumble.start();
    bag.sources.push(rumble);
    bag.oscs.push(ambientLfo(ctx, 0.9, 0.011, rumbleGain.gain));

    const steam = () => {
      if (!bag.alive) return;
      ambientHiss(ctx, master, 0.55, 0.017, 2400, 1.2, 'highpass');
      ambientLater(bag, 4200, 10000, steam);
    };
    steam();
  }

  /** @param {AudioContext} ctx @param {GainNode} master @param {object} bag */
  function buildTraktir(ctx, master, bag) {
    const murmur = ambientSource(ctx);
    const murmurFilter = ctx.createBiquadFilter();
    murmurFilter.type = 'lowpass';
    murmurFilter.frequency.value = 260;
    const murmurGain = ctx.createGain();
    murmurGain.gain.value = 0.045;
    murmur.connect(murmurFilter).connect(murmurGain).connect(master);
    murmur.start();
    bag.sources.push(murmur);
    bag.oscs.push(ambientLfo(ctx, 0.13, 0.016, murmurGain.gain));

    const crackle = () => {
      if (!bag.alive) return;
      ambientHiss(ctx, master, 0.04 + Math.random() * 0.06, 0.011, 1800, 1.4, 'highpass');
      ambientLater(bag, 450, 2100, crackle);
    };
    crackle();

    const clink = () => {
      if (!bag.alive) return;
      ambientTone(ctx, master, 1800 + Math.random() * 700, 0.18, 0.006);
      ambientLater(bag, 9000, 18000, clink);
    };
    clink();
  }

  /** @param {AudioContext} ctx @param {GainNode} master @param {object} bag */
  function buildStandart(ctx, master, bag) {
    const room = ambientSource(ctx);
    const roomFilter = ctx.createBiquadFilter();
    roomFilter.type = 'lowpass';
    roomFilter.frequency.value = 220;
    const roomGain = ctx.createGain();
    roomGain.gain.value = 0.024;
    room.connect(roomFilter).connect(roomGain).connect(master);
    room.start();
    bag.sources.push(room);
    bag.oscs.push(ambientLfo(ctx, 0.06, 0.007, roomGain.gain));
  }

  /** @returns {number} усиление атмосферы с запасом под пики сцены */
  function ambientLevel() {
    return Math.max(0.0001, ambientVolume() * 0.32);
  }

  /** Меняет уровень уже играющей сцены, не перезапуская её. */
  function applyAmbientVolume() {
    if (!ambient) return;
    const now = ambient.ctx.currentTime;
    ambient.master.gain.cancelScheduledValues(now);
    ambient.master.gain.setTargetAtTime(ambientLevel(), now, 0.15);
  }

  function stopAmbient() {
    if (!ambient) return;
    const old = ambient;
    ambient = null;
    old.alive = false;
    for (const timer of old.timers) clearTimeout(timer);
    const now = old.ctx.currentTime;
    old.master.gain.cancelScheduledValues(now);
    old.master.gain.setValueAtTime(old.master.gain.value, now);
    old.master.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    setTimeout(() => {
      for (const source of old.sources) {
        try { source.stop(); } catch { /* уже остановлен */ }
      }
      for (const osc of old.oscs) {
        try { osc.stop(); } catch { /* уже остановлен */ }
      }
      try { old.master.disconnect(); } catch { /* уже отключён */ }
    }, 750);
  }

  /** @param {boolean} [force] играть даже вне главного экрана: так работает проба */
  function startAmbient(force = false) {
    if (!force && (!ambientEnabled() || ambientScene !== 'home' || !ambientUnlocked)) return;
    if (ambientVolume() <= 0) return;
    const theme = currentTheme();
    if (!force && ambient && ambient.theme === theme) return;
    const ctx = ensure();
    if (!ctx) return;
    stopAmbient();
    try {
      const master = ctx.createGain();
      const level = ambientLevel();
      master.gain.setValueAtTime(0.0001, ctx.currentTime);
      master.gain.exponentialRampToValueAtTime(level, ctx.currentTime + 1.2);
      master.connect(ctx.destination);
      const bag = { ctx, theme, master, sources: [], oscs: [], timers: [], alive: true };
      ambient = bag;
      switch (theme) {
        case 'les': buildLes(ctx, master, bag); break;
        case 'okean': buildOkean(ctx, master, bag); break;
        case 'magiya': buildMagiya(ctx, master, bag); break;
        case 'traktir': buildTraktir(ctx, master, bag); break;
        case 'par': buildPar(ctx, master, bag); break;
        default: buildStandart(ctx, master, bag); break;
      }
    } catch {
      stopAmbient();
    }
  }

  function cancelPreview() {
    if (!previewTimer) return;
    clearTimeout(previewTimer);
    previewTimer = null;
    previewScene = '';
  }

  /**
   * Проба атмосферы из настроек: играет текущую сцену несколько секунд даже
   * на столе, где фон обычно выключен, и возвращает прежнюю сцену.
   */
  function previewAmbient() {
    if (!previewTimer) previewScene = ambientScene;
    else clearTimeout(previewTimer);
    ambientScene = 'preview';
    startAmbient(true);
    previewTimer = setTimeout(() => {
      previewTimer = null;
      const scene = previewScene;
      previewScene = '';
      ambientScene = scene;
      if (scene === 'home') startAmbient();
      else stopAmbient();
    }, 4000);
  }

  /** @param {string} scene */
  function setScene(scene) {
    cancelPreview();
    ambientScene = scene === 'home' ? 'home' : '';
    if (ambientScene === 'home') startAmbient();
    else stopAmbient();
  }

  /** @param {boolean} on */
  function setAmbient(on) {
    cancelPreview();
    write(AMBIENT_KEY, on ? 'on' : 'off');
    if (on) startAmbient();
    else stopAmbient();
  }

  /** @param {AudioContext} ctx */
  function playClick(ctx) {
    switch (skin()) {
      case 'les':
        hiss(ctx, 0.09, 0.05, 1500, 1.1);
        tone(ctx, 220, 0.06, 0.025, 'triangle');
        break;
      case 'okean':
        hiss(ctx, 0.18, 0.04, 700, 0.9, 'lowpass');
        tone(ctx, 520, 0.14, 0.02);
        break;
      case 'magiya':
        tone(ctx, 880, 0.42, 0.025);
        tone(ctx, 1320, 0.38, 0.012);
        break;
      case 'par':
        tone(ctx, 160, 0.05, 0.035, 'square');
        hiss(ctx, 0.04, 0.03, 3200, 1.8, 'highpass');
        break;
      default:
        hiss(ctx, 0.035, 0.04, 2600, 1.6, 'highpass');
        tone(ctx, 240, 0.035, 0.018, 'triangle');
        break;
    }
  }

  /** @param {AudioContext} ctx */
  function playDice(ctx) {
    switch (skin()) {
      case 'les':
        hiss(ctx, 0.08, 0.028, 1200, 0.7, 'lowpass');
        setTimeout(() => hiss(ctx, 0.07, 0.02, 900, 0.7, 'lowpass'), 70);
        setTimeout(() => tone(ctx, 180, 0.08, 0.02, 'triangle'), 130);
        break;
      case 'okean':
        tone(ctx, 320, 0.12, 0.018, 'sine', 240);
        setTimeout(() => tone(ctx, 480, 0.14, 0.015, 'sine', 360), 80);
        setTimeout(() => hiss(ctx, 0.16, 0.018, 800, 0.8, 'lowpass'), 120);
        break;
      case 'magiya':
        tone(ctx, 660, 0.2, 0.02, 'sine', 880);
        setTimeout(() => tone(ctx, 990, 0.22, 0.016, 'sine', 1320), 90);
        break;
      case 'par':
        tone(ctx, 180, 0.07, 0.03, 'square');
        setTimeout(() => tone(ctx, 240, 0.06, 0.025, 'square'), 60);
        setTimeout(() => hiss(ctx, 0.05, 0.025, 3000, 1.6, 'highpass'), 110);
        break;
      default:
        hiss(ctx, 0.04, 0.03, 2400, 1.2, 'highpass');
        setTimeout(() => hiss(ctx, 0.05, 0.025, 1800, 1.2, 'highpass'), 70);
        setTimeout(() => tone(ctx, 200, 0.07, 0.02, 'triangle'), 130);
        break;
    }
  }

  /**
   * @param {'click'|'dice'} kind
   * @param {boolean} [force] сыграть даже при выключенном звуке
   */
  function play(kind = 'click', force = false) {
    if (!force && !enabled()) return;
    const ctx = ensure();
    if (!ctx) return;
    if (kind === 'dice') playDice(ctx);
    else playClick(ctx);
  }

  /** Прослушать выбранный скин: щелчок, затем бросок. */
  function preview() {
    play('click', true);
    setTimeout(() => play('dice', true), 150);
  }

  // Звук нажатия: один делегированный обработчик на всё окно. Кнопки броска
  // пропускаем, у них свой звук в момент начала анимации.
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const target = event.target.closest('button, .card, .tabs__btn, [data-sound-skip]');
    if (!target || target.disabled) return;
    if (target.hasAttribute('data-sound-skip')) return;
    if (target.classList.contains('dice__quick-btn')) return;
    if (target.classList.contains('dice__reroll')) return;
    if (target.closest('.dice__form')) return;
    play('click');
  }, true);

  function setEnabled(on) {
    write(ENABLED_KEY, on ? 'on' : 'off');
    if (on) ensure();
  }

  /** @param {number} value 0..100 */
  function setVolume(value) {
    const next = Math.min(100, Math.max(0, Number(value) || 0));
    write(VOLUME_KEY, String(Math.round(next)));
    applyAmbientVolume();
    if (!ambient && ambientVolume() > 0) startAmbient();
  }

  /** @param {number} value 0..100 */
  function setAmbientVolume(value) {
    const next = Math.min(100, Math.max(0, Number(value) || 0));
    write(AMBIENT_VOLUME_KEY, String(Math.round(next)));
    applyAmbientVolume();
    if (next > 0) startAmbient();
    else stopAmbient();
  }

  /** @param {string} id */
  function setSkin(id) {
    write(SKIN_KEY, KNOWN.includes(id) ? id : 'standart');
  }

  // Атмосфера не должна включаться сама до жеста: браузер всё равно
  // заблокирует AudioContext. Первый клик или клавиша снимает запрет.
  const unlock = () => {
    if (ambientUnlocked) return;
    ambientUnlocked = true;
    startAmbient();
  };
  document.addEventListener('pointerdown', unlock, { once: true, capture: true });
  document.addEventListener('keydown', unlock, { once: true, capture: true });

  // Свёрнутое окно не должно шуметь фоном: сцена гаснет и возвращается вместе
  // с окном. Проба из настроек тоже прерывается и продолжается.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopAmbient();
      return;
    }
    if (previewTimer) startAmbient(true);
    else if (ambientScene === 'home') startAmbient();
  });

  // Тема сменилась на главном экране: старую атмосферу гасим, новую
  // поднимаем с плавным входом. Тон и акцент тему не меняют, поэтому звук
  // не перезапускается.
  global.addEventListener('dnd-theme-change', () => {
    if (!ambient) return;
    if (ambient.theme !== currentTheme()) startAmbient();
  });

  global.DnDSound = {
    ENABLED_KEY,
    VOLUME_KEY,
    SKIN_KEY,
    AMBIENT_KEY,
    AMBIENT_VOLUME_KEY,
    SKINS,
    enabled,
    ambientEnabled,
    volume,
    ambientVolume,
    skin,
    play,
    preview,
    previewAmbient,
    setEnabled,
    setAmbient,
    setScene,
    setVolume,
    setAmbientVolume,
    setSkin
  };
}(window));
