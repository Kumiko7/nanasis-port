// Scenario playback engine. Every page in a script is a full snapshot of the scene
// (background, character slots, BGM, filter), so any page can be rendered directly.
'use strict';

const STAGE_W = 1136, STAGE_H = 640;
// Character slot centres, measured against the game: slots 0-6 sit 160px apart around the
// centre line; slots 7-12 are the in-between positions. Sprites are drawn 1:1, bottom-aligned.
const SLOT_X = [...Array(7)].map((_, i) => STAGE_W / 2 + (i - 3) * 160)
  .concat([...Array(6)].map((_, i) => STAGE_W / 2 + (i - 2.5) * 160));
// Timings below are the game's own (its AnimationClips, DOTween settings and Adv.Component code). Waits counted in
// game frames (AutoMoveFrame, DelayFrame, ...) run at the game's frame rate, which Boot sets to 30 (only lives
// and mini-games raise it to 60); animation clips are timed in seconds, keyed at 60 samples per second.
const FPS = 30;
const frames = (n) => n * 1000 / FPS;
const clipMs = (samples) => samples * 1000 / 60;
const FADE_CLIP = 40 / 60;   // seconds of the Chara FadeIn / FadeOut clips at speed 1 (FadeInSpeed scales them)
// Unity's two-key clips with flat tangents are a smoothstep: exactly this curve
const CLIP_EASE = 'cubic-bezier(.333, 0, .667, 1)';
const OUT_SINE = 'cubic-bezier(.61, 1, .88, 1)';
const IN_SINE = 'cubic-bezier(.12, 0, .39, 0)';
// milliseconds per character for the game's TextSpeed Slow / Normal / Fast / VeryFast (default Normal)
const TEXT_DELAY = [100, 50, 10, 0];
// auto mode: 40 frames after the line (and its voice); unvoiced lines add m_system_config (5, 20) =
// 1.5 / 2 / 3 s for 1 / 2 / 3 rows of text
const AUTO_FRAMES = 40, AUTO_EXTRA = [1.5, 2, 3].map((s) => s * FPS);
// The settings sliders (0-100) widen the game's choices. Text speed runs through the game's four steps at
// TEXT_MARKS (Normal, the default, at 50), interpolated in characters per second, from 5 per second to instant.
const TEXT_MARKS = [25, 50, 85, 100];
function textDelayFor(v) {
  const anchors = [[0, 200], ...TEXT_MARKS.slice(0, 3).map((m, i) => [m, TEXT_DELAY[i]])];
  if (v >= TEXT_MARKS[3]) return 0;
  if (v > anchors[3][0]) {   // Fast to instant
    const k = (v - anchors[3][0]) / (TEXT_MARKS[3] - anchors[3][0]);
    return anchors[3][1] * (1 - k);
  }
  let i = 0;
  while (v > anchors[i + 1][0]) i++;
  const [v0, d0] = anchors[i], [v1, d1] = anchors[i + 1];
  return 1000 / Math.exp(Math.log(1000 / d0) + (v - v0) / (v1 - v0) * (Math.log(1000 / d1) - Math.log(1000 / d0)));
}
// Auto speed scales the game's auto wait: 50 is the game's own timing, each 25 halves (faster) or doubles it.
const AUTO_DEFAULT = 50;
function autoScaleFor(v) { return 2 ** ((AUTO_DEFAULT - v) / 25); }
const TITLE_HOLD = 70;       // Title.DelayedFrameWhenNoVoice
const BOX_CLIP = 10 / 60;    // the text box Open / Close clips

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function asset(name) { return '/asset/' + encodeURIComponent(name); }
// ?k=1: decodes since the HCA key fix (browsers had cached some mis-keyed, noisy decodes for a day)
function audioUrl(cue) { return '/audio/' + encodeURIComponent(cue) + '.wav?k=1'; }
function seCue(name) { return /^\d+$/.test(name) ? 'se_' + name.padStart(3, '0') : name; }
function fadeSeconds(speed) { return speed > 0 ? FADE_CLIP / speed : 0; }
// Unity's Hermite keyframe segment from (t0, v0, slope s0) to (t1, v1, slope s1), sampled at time t
function hermite(t, t0, v0, s0, t1, v1, s1) {
  if (t <= t0) return v0;
  if (t >= t1) return v1;
  const d = t1 - t0, u = (t - t0) / d, u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * v0 + (u3 - 2 * u2 + u) * s0 * d + (-2 * u3 + 3 * u2) * v1 + (u3 - u2) * s1 * d;
}
// sample f(seconds) into Web Animations keyframes over `sec`
function sampled(sec, f, n = 30) {
  return [...Array(n + 1)].map((_, i) => ({ transform: `translateX(${f(sec * i / n)}px)`, offset: i / n }));
}
// DOTween InBounce as a CSS linear() easing
const IN_BOUNCE = 'linear(' + [...Array(41)].map((_, i) => {
  // InBounce(t) = 1 - OutBounce(1 - t)
  const x = 1 - i / 40, n = 7.5625, d = 2.75;
  const out = x < 1 / d ? n * x * x
    : x < 2 / d ? n * (x - 1.5 / d) ** 2 + .75
      : x < 2.5 / d ? n * (x - 2.25 / d) ** 2 + .9375
        : n * (x - 2.625 / d) ** 2 + .984375;
  return (1 - out).toFixed(4);
}).join(', ') + ')';

// ---------------------------------------------------------------- audio
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();   // cue -> Promise<AudioBuffer|null>
    this.loops = new Map();     // cue -> Promise<loop info>
    this.vol = { voice: 1, bgm: 0.45, se: 0.7 };
    this.bgm = null;
    this.loopSe = null;
    this.seLive = new Set();
    this.seToken = {};
    this.voice = null;
    this.onMissing = null;
  }
  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = { voice: this.ctx.createGain(), bgm: this.ctx.createGain(), se: this.ctx.createGain() };
      for (const k in this.master) { this.master[k].gain.value = this.vol[k]; this.master[k].connect(this.ctx.destination); }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  setVolume(kind, v) { this.vol[kind] = v; if (this.master) this.master[kind].gain.value = v; }
  load(cue) {
    if (!cue) return Promise.resolve(null);
    this.ensure();
    if (!this.buffers.has(cue)) {
      const p = fetch(audioUrl(cue))
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((b) => (b ? this.ctx.decodeAudioData(b) : null))
        .catch(() => null);
      this.buffers.set(cue, p);
      if (this.buffers.size > 400) this.buffers.delete(this.buffers.keys().next().value);
    }
    return this.buffers.get(cue);
  }
  loopInfo(cue) {
    if (!this.loops.has(cue)) {
      this.loops.set(cue, fetch('/audio/' + encodeURIComponent(cue) + '.json')
        .then((r) => (r.ok ? r.json() : {})).then((j) => j.loop).catch(() => null));
    }
    return this.loops.get(cue);
  }
  async play(cue, kind, { loop = false, loopInfo = null } = {}) {
    this.ensure();
    const buf = await this.load(cue);
    if (!buf) return null;
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    src.buffer = buf;
    if (loop) {
      src.loop = true;
      if (loopInfo && loopInfo.end > loopInfo.start) { src.loopStart = loopInfo.start; src.loopEnd = loopInfo.end; }
    }
    src.connect(gain).connect(this.master[kind]);
    src.start();
    return { cue, src, gain };
  }
  fadeStop(h, sec = 0.6) {
    if (!h || !h.src) return;
    const t = this.ctx.currentTime;
    h.gain.gain.setValueAtTime(h.gain.gain.value, t);
    h.gain.gain.linearRampToValueAtTime(0, t + sec);
    try { h.src.stop(t + sec + 0.05); } catch (e) { /* already stopped */ }
  }
  async setBgm(cue) {
    cue = cue || null;
    if ((this.bgm && this.bgm.cue) === cue) return;
    const old = this.bgm;
    this.bgm = cue ? { cue, pending: true } : null;
    // the game stops the old track and starts the new one with no fade (AdvBgm fade time 0);
    // the few milliseconds only avoid a click
    if (old) this.fadeStop(old, 0.02);
    if (!cue) return;
    const info = await this.loopInfo(cue);
    const h = await this.play(cue, 'bgm', { loop: true, loopInfo: info });
    if (this.bgm && this.bgm.cue === cue && this.bgm.pending) this.bgm = h || null;
    else if (h) this.fadeStop(h, 0.1);   // superseded while loading
  }
  async setLoopSe(cue) {
    cue = cue || null;
    if ((this.loopSe && this.loopSe.cue) === cue) return;
    if (this.loopSe) this.fadeStop(this.loopSe, 0.03);   // StopSE cuts it
    this.loopSe = cue ? { cue, pending: true } : null;
    if (!cue) return;
    const h = await this.play(cue, 'se', { loop: true });
    if (this.loopSe && this.loopSe.cue === cue && this.loopSe.pending) this.loopSe = h || null;
    else if (h) this.fadeStop(h, 0.1);
  }
  se(cue) { if (cue) this.play(cue, 'se'); }
  // a story SE, kept so that stopSe can cut it short
  async storySe(cue) {
    const token = this.seToken;
    const h = await this.play(cue, 'se');
    if (!h) return;
    if (token !== this.seToken) { try { h.src.stop(); } catch (e) { /* stopped */ } return; }
    this.seLive.add(h);
    h.src.onended = () => this.seLive.delete(h);
  }
  // SoundManager.StopSE: every story SE, the loop and any one-shot still sounding
  stopSe() {
    this.seToken = {};
    for (const h of this.seLive) { try { h.src.stop(); } catch (e) { /* stopped */ } }
    this.seLive.clear();
    this.setLoopSe(null);
  }

  // start a one-shot buffer at `offset` seconds into it, optionally after `delay` seconds
  async playFrom(cue, kind, offset, delay = 0) {
    this.ensure();
    const buf = await this.load(cue);
    if (!buf || offset >= buf.duration) return null;
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    src.buffer = buf;
    src.connect(gain).connect(this.master[kind]);
    src.start(this.ctx.currentTime + Math.max(0, delay), Math.max(0, offset));
    return { cue, src, gain };
  }
  async playVoice(cue) {
    this.stopVoice();
    if (!cue) return null;
    const token = {};
    this.voiceToken = token;
    const h = await this.play(cue, 'voice');
    if (this.voiceToken !== token) { if (h) h.src.stop(); return null; }
    this.voice = h;
    if (!h) return null;   // missing voices are silently skipped
    return new Promise((res) => { h.src.onended = () => res(true); });
  }
  stopVoice() {
    this.voiceToken = null;
    if (this.voice) { try { this.voice.src.stop(); } catch (e) { /* already stopped */ } this.voice = null; }
  }
  stopAll() {
    this.stopVoice();
    if (this.bgm) this.fadeStop(this.bgm, 0.4);
    if (this.loopSe) this.fadeStop(this.loopSe, 0.2);
    this.bgm = this.loopSe = null;
    this.seToken = {};
    for (const h of this.seLive) this.fadeStop(h, 0.2);
    this.seLive.clear();
  }
}

// ---------------------------------------------------------------- images
const imgCache = new Map();
function loadImage(name) {
  if (!name || !name.trim()) return Promise.resolve(null);
  if (!imgCache.has(name)) {
    imgCache.set(name, new Promise((res) => {
      const im = new Image();
      im.onload = () => (im.decode ? im.decode().catch(() => {}) : Promise.resolve()).then(() => res(im));
      im.onerror = () => res(null);
      im.src = asset(name);
    }));
    if (imgCache.size > 400) imgCache.delete(imgCache.keys().next().value);
  }
  return imgCache.get(name);
}

// adv_chara_CCC_OO_FF -> body adv_chara_CCC_OO + face patch adv_chara_CCC_OO_FF
function charaParts(fileName) {
  const m = /^adv_chara_(\d+)_(\d+)(?:_(\d+))?/.exec(fileName.trim());
  if (!m) return { body: fileName.trim() + '.png', face: null, key: null, base: fileName.trim() };
  const key = m[1] + '_' + m[2];
  return { body: 'adv_chara_' + key + '.png', face: m[3] ? 'adv_chara_' + key + '_' + m[3] + '.png' : null, key, base: 'adv_chara_' + key };
}

// ---------------------------------------------------------------- linear colour space
// The game renders in linear colour space (PlayerSettings m_ActiveColorSpace = 1), so anything translucent blends
// in linear light: 75% white over black comes out at 88% (225), not 75% (191). Browsers blend sRGB values, so
// translucent art and overlays get the alpha that makes an sRGB blend land where the game's linear blend does.
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
// for colour channel c (0..1, sRGB) at alpha a, averaged over a dark and a mid background (exact for black on
// any background bar the sRGB curve's linear toe)
function linearAlpha(a, c) {
  if (a <= 0 || a >= 1) return a;
  let sum = 0, n = 0;
  for (const bg of [0.15, 0.6]) {
    if (Math.abs(c - bg) < 0.05) continue;
    sum += (toSrgb(a * toLin(c) + (1 - a) * toLin(bg)) - bg) / (c - bg);
    n++;
  }
  return n ? Math.min(1, Math.max(0, sum / n)) : a;
}
const linearAlphaRgb = (a, [r, g, b]) => (linearAlpha(a, r) + linearAlpha(a, g) + linearAlpha(a, b)) / 3;
// the game's translucent story UI art, re-alphaed once and handed to the CSS as --ui-<name>
const LINEAR_SPRITES = ['frame_text_area', 'scenariotetitlebar01', 'scenariotetitlebar02', 'scenariotetitlebar03',
  'scenariotetitlebar04', 'eff_scenariotetitle', 'blur_left_black_mask_reduced', 'btn_choice', 'base_popup',
  'btn_blue_square', 'btn_white_rect_square_reduced', 'base_footer', 'base_scroll_list', 'movie_seek_bar_base'];
function prepareLinearSprites() {
  for (const name of LINEAR_SPRITES) {
    const im = new Image();
    im.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = im.width; cv.height = im.height;
      const g = cv.getContext('2d');
      g.drawImage(im, 0, 0);
      const img = g.getImageData(0, 0, cv.width, cv.height), d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0 || d[i + 3] === 255) continue;
        d[i + 3] = Math.round(255 * linearAlphaRgb(d[i + 3] / 255, [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255]));
      }
      g.putImageData(img, 0, 0);
      cv.toBlob((b) => { if (b) document.documentElement.style.setProperty('--ui-' + name, `url("${URL.createObjectURL(b)}")`); });
    };
    im.src = '/ui/' + name + '.png';
  }
}
// opacity keyframes for a solid overlay of `color` (r, g, b 0..1) running from alpha `from` to `to` on the game's
// smoothstep curve
function linearFade(from, to, color, n = 24) {
  return [...Array(n + 1)].map((_, i) => {
    const u = i / n, a = from + (to - from) * (3 * u * u - 2 * u * u * u);
    return { opacity: linearAlphaRgb(a, color), offset: u };
  });
}

// the adv_* effect prefabs: kind, length, curve and whether the page waits for them (EffectBase.isBlocking)
function effectSpec(name) {
  let m;
  const colors = { white: [1, 1, 1], black: [0, 0, 0], yellow: [1, 0.92, 0.016], red: [1, 0, 0] };
  if (name === 'adv_shake') return { kind: 'shake' };
  if ((m = /^adv_fade(in|out)_(white|black)(_2400)?$/.exec(name))) {
    const out = m[1] === 'out';
    return { kind: 'fade', out, holds: out, color: colors[m[2]], ms: clipMs(m[3] ? 160 : 80), blocking: out || name === 'adv_fadein_white_2400' };
  }
  if ((m = /^adv_flash_(white|yellow|red)$/.exec(name))) return { kind: 'fade', color: colors[m[1]], ms: clipMs(20) };
  if ((m = /^adv_slide(in|out)_(black|white)$/.exec(name))) {
    return { kind: 'wipe', out: m[1] === 'out', holds: m[1] === 'in', color: colors[m[2]], ms: clipMs(80), blocking: true };
  }
  if ((m = /^adv_slide(in|out)_blur_(left|right)$/.exec(name))) {
    // DOTween anchoredPosition tweens (1 s, OutSine) of the 2000px panel, as its left edge on the stage
    const [from, to] = { in_left: [1000, -800], out_left: [-800, 1200], in_right: [-1864, -64], out_right: [-864, -2864] }[m[1] + '_' + m[2]];
    return { kind: 'blur', from, to, flip: m[2] === 'right', holds: m[1] === 'in', ms: 1000, easing: OUT_SINE };
  }
  // AdvEffectSwoon / AdvEffectWaking: the Swoon shader's _Height eased from 0 to maxHeight
  if (name === 'adv_swoon') return { kind: 'eyes', holds: true, max: 2, ms: 2000, easing: IN_SINE };
  if (name === 'adv_swoon_fast') return { kind: 'eyes', holds: true, max: 1.4, ms: 1200, easing: OUT_SINE };
  if (name === 'adv_waking') return { kind: 'eyes', holds: true, max: 1.6, ms: 3000, easing: IN_BOUNCE };
  return null;
}

// The game's "Shader Graphs/Swoon" (decompiled from its GLES3 program), drawn into a small canvas. In uv -1..1 the
// clear area is an ellipse 1.6 wide and `height` tall; outside it is black, and 21 ellipses shrinking by 0.015 in
// height add 5% black each, feathering the edge inwards. Height 0 is fully black.
function drawEyes(cv, height) {
  const w = cv.width, h = cv.height;
  const g = cv.getContext('2d');
  const img = g.createImageData(w, h);
  const hs = [height];
  for (let k = 0, x = height; k <= 20; k++) { x -= 0.015; if (x < 0) x = 0.001; hs.push(x); }
  for (let px = 0; px < w; px++) {
    const u = (px + 0.5) / w * 2 - 1;
    const s = Math.sqrt(Math.max(0, 1 - (u / 1.6) ** 2));   // a point is outside ellipse H when |v| > H * s
    for (let py = 0; py < h; py++) {
      const v = Math.abs((py + 0.5) / h * 2 - 1);
      let a = v > hs[0] * s ? 1 : 0;
      for (let k = 1; k < hs.length; k++) if (v > hs[k] * s) a += 0.05;
      img.data[(py * w + px) * 4 + 3] = Math.round(255 * linearAlpha(Math.min(1, a), 0));
    }
  }
  g.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------- player
class Player {
  constructor(facepos) {
    this.facepos = facepos;
    this.audio = new AudioEngine();
    this.audio.onMissing = (what) => this.noteMissing(what);
    this.pages = [];
    this.history = [];
    this.choiceState = {};
    this.index = -1;
    this.mode = 'normal';   // normal | auto | fast
    this.textDelay = TEXT_DELAY[1];   // ms per character (the game's default, Normal)
    this.autoScale = 1;               // multiplies the game's auto-mode wait
    this.busy = false;
    this.typing = null;
    this.missingNoted = new Set();
    this.onChange = () => {};
    this.onEnd = () => {};
    this.adv = $('#adv');
    this.stage = $('#stage');
    this.bgLayers = [...document.querySelectorAll('#bg .bgimg')];
    prepareLinearSprites();
  }

  get auto() { return this.mode === 'auto'; }

  async load(script, meta, startPage = 0, history = null) {
    this.stop();
    this.rushing = false;
    this.meta = meta;
    this.pages = script.Pages || [];
    // when returning to a previous episode, its page history comes back with it
    this.history = history ? history.slice(0, -1) : [];
    this.choiceState = {};
    this.index = -1;
    this.missingNoted = new Set();
    this.setMode('normal');
    this.resetScene();
    this.audio.ensure();
    const first = startPage > 0 ? startPage : this.nextVisible(-1);
    await this.goto(first, { jump: startPage > 0 });
  }

  resetScene() {
    $('#charas').innerHTML = '';
    // the game's character layers (Chara.layers: Layer 1 = LayerFront, 2 = LayerMiddle, 3 = LayerBack);
    // every slot starts in LayerBack, in slot order
    this.charaLayers = { 1: [], 2: [], 3: [...Array(13).keys()] };
    this.charaEls = [];
    $('#item').innerHTML = '';
    $('#title').innerHTML = '';
    $('#choices').innerHTML = '';
    for (const l of this.bgLayers) { l.style.backgroundImage = 'none'; l.style.backgroundColor = '#000'; }
    this.clearEffects();
    $('#textbox').hidden = true;
  }

  stop() {
    this.gen = (this.gen || 0) + 1;
    this.loopSeName = null;
    if (this.skipMovie) this.skipMovie();
    this.audio.stopAll();
    clearTimeout(this.autoTimer);
    this.cancelTyping();
    this.waitingChoice = false;
    $('#choices').innerHTML = '';
    const mv = $('#movie'); mv.pause(); mv.removeAttribute('src'); mv.style.display = 'none'; mv.dataset.file = '';
  }

  visible(i) {
    const g = this.pages[i] && this.pages[i].ChoiceGroup;
    return !g || !(g.Group in this.choiceState) || this.choiceState[g.Group] === g.Number;
  }
  nextVisible(i) { for (let j = i + 1; j < this.pages.length; j++) if (this.visible(j)) return j; return -1; }

  setMode(m) {
    if (this.mode === m) m = 'normal';
    this.mode = m;
    clearTimeout(this.autoTimer);
    this.onChange('mode');
    if (m === 'fast') { this.finishTyping(); this.audio.stopVoice(); }
    if (this.index >= 0) this.scheduleAdvance();
  }

  // user: a click or key (the player's own auto-advance passes false)
  async next(user = true) {
    if (this.typing) { this.finishTyping(); return; }
    if (this.waitingChoice) return;
    // a click during a fade / wipe jumps it to its end; a click on a transition (a page with no line) also
    // rushes through the text-less pages after it without their animations, up to the next line, choice,
    // title card or full-screen movie
    if (user) {
      if (this.fxSkip) this.fxSkip();
      if (this.cardSkip) this.cardSkip();
      // (a page that waits for its tap, as the game's text-less pages without AutoMoveFrame do, is not one)
      const p = this.pages[this.index];
      if (p && !this.hasLine(p) && (this.busy || p.AutoMoveFrame > 0 || this.mode !== 'normal')) this.rushing = true;
    }
    // still loading this page: show its text instantly once it arrives instead of ignoring the key
    if (this.busy) { this.pendingSkip = true; return; }
    const j = this.nextVisible(this.index);
    if (j < 0) { this.finish(); return; }
    await this.goto(j);
  }

  hasLine(p) { return !!(p && ((p.TextArea && (p.TextArea.Dialogue || p.TextArea.Name)) || (p.Choices && p.Choices.length))); }

  // back to the previous *line*: pages without text (transitions, title cards, movie lead-ins) advance on
  // their own, so stepping back onto one would roll straight forward again
  // (fromEnd: from the episode-end dialog, where the last page itself is a candidate)
  async back(fromEnd = false) {
    let k = this.history.length - (fromEnd ? 1 : 2);
    while (k >= 0 && !this.hasLine(this.pages[this.history[k]])) k--;
    if (k < 0) { if (this.onBackAtStart) this.onBackAtStart(); return; }
    this.setMode('normal');
    const target = this.history[k];
    this.history.length = k;
    await this.goto(target, { jump: true });
  }

  // rewind to a page from the backlog
  async rewindTo(i) {
    const k = this.history.lastIndexOf(i);
    if (k < 0) return;
    this.history.length = k;
    this.setMode('normal');
    await this.goto(i, { jump: true });
  }

  finish(skipped = false) {
    // nothing advances once the episode has ended (until a goto, e.g. back from the end dialog)
    this.ended = true;
    this.stop();
    this.setMode('normal');
    this.onEnd({ skipped });
  }

  async goto(i, opts = {}) {
    if (i < 0 || i >= this.pages.length) return;
    this.ended = false;
    const gen = ++this.gen;
    clearTimeout(this.autoTimer);
    this.cancelTyping();
    // leaving a page that was waiting on a choice (e.g. via back/rewind) must not leave input blocked
    this.waitingChoice = false;
    this.pendingSkip = false;
    $('#choices').innerHTML = '';
    this.index = i;
    this.history.push(i);
    const page = this.pages[i];
    const fast = this.mode === 'fast';
    if (this.hasLine(page) || page.Title || page.SubTitle || page.SubTitleSingle || (page.InlineMovie && page.InlineMovie.IsBlocking)) {
      this.rushing = false;
    }
    this.busy = true;
    this.onChange('page');
    this.prefetch(i);
    const instant = opts.jump || fast || this.rushing;

    // TextArea.PrepareAsync: a page without a line closes the text box (and waits for its Close clip)
    // before the page's scene is shown
    if (!this.hasText(page)) await this.closeTextbox(instant);
    if (gen !== this.gen) return;
    await this.renderScene(page, { ...opts, instant });
    if (gen !== this.gen) return;
    this.renderAudio(page, fast);
    // AdvPlayer.playComponentsAsync: effect, then movie, then title, then voice and text
    await this.runEffect(page.Effect, { ...opts, instant });
    if (gen !== this.gen) return;

    const movieDone = this.renderMovie(page, fast);
    if (!fast && page.InlineMovie && page.InlineMovie.IsBlocking) await movieDone;
    if (gen !== this.gen) return;
    const voiceCue = page.Sound && page.Sound.VoiceFileName;
    await this.renderTitle(page, gen, instant, !!voiceCue);
    if (gen !== this.gen) return;

    this.voiceDone = fast ? Promise.resolve() : this.audio.playVoice(voiceCue);
    // whether the voice is still playing (or loading) - what the game checks once the text is typed out
    this.voicePending = !fast && !!voiceCue;
    this.voiceDone.then(() => { if (gen === this.gen) this.voicePending = false; });
    if (fast) this.audio.stopVoice();
    const ta = page.TextArea;
    const hasText = this.hasText(page);
    this.busy = false;
    this.rows = 0;

    if (page.Choices && page.Choices.length) {
      if (this.mode === 'fast') this.setMode('normal');
      if (hasText) await this.showText(ta, gen);
      await this.askChoice(page.Choices);
      if (gen === this.gen) this.next(false);
      return;
    }
    if (hasText) await this.showText(ta, gen);
    if (gen === this.gen) this.scheduleAdvance();
  }

  hasText(p) { return !!(p.TextArea && (p.TextArea.Dialogue || p.TextArea.Name)); }
  isCard(p) { return !!(p.Title || p.SubTitle || p.SubTitleSingle); }

  // the game's Screen.WaitAsync, which starts once the text is typed out. Fast-forward moves on after 4 frames.
  // Auto and AutoMoveFrame pages first wait for the voice: if it was still playing when the text finished, the
  // page moves on the moment it ends; otherwise auto waits 40 frames (plus 1.5 / 2 / 3 s for 1 / 2 / 3 rows of
  // text) and an AutoMoveFrame page that many frames. Any other page waits for a tap.
  scheduleAdvance() {
    clearTimeout(this.autoTimer);
    const page = this.pages[this.index];
    if (!page || this.ended || this.typing || this.busy || this.waitingChoice || (page.Choices && page.Choices.length)) return;
    const gen = this.gen, mode = this.mode;
    const go = (ms) => { this.autoTimer = setTimeout(() => { if (gen === this.gen && this.mode === mode) this.next(false); }, ms); };
    if (mode === 'fast') return go(frames(4));
    // after a click on a transition, the text-less pages up to the next line run straight through
    if (this.rushing && !this.hasText(page) && !this.isCard(page)) return go(60);
    const voiced = this.voicePending;
    let wait;
    if (mode === 'auto') {
      // (a slower オート速度 than the game's also pauses after voices, which the game never does)
      wait = voiced ? Math.max(0, this.autoScale - 1) * AUTO_FRAMES
        : (AUTO_FRAMES + (this.rows ? AUTO_EXTRA[Math.min(this.rows, AUTO_EXTRA.length) - 1] : 0)) * this.autoScale;
    } else if (page.AutoMoveFrame > 0) {
      wait = voiced ? 0 : page.AutoMoveFrame;
    } else {
      return;
    }
    Promise.resolve(this.voiceDone).then(() => { if (gen === this.gen && this.mode === mode) go(frames(wait)); });
  }

  // ---- scene snapshot
  async renderScene(page, opts) {
    const bg = page.BackGround || {};
    const charas = (page.Charas || []).map((c, slot) => (c && c.FileName && c.FileName.trim() ? { c, slot, parts: charaParts(c.FileName) } : null)).filter(Boolean);
    const loads = [loadImage(bg.FileName), loadImage(bg.CrossFadeToFileName)];
    for (const ch of charas) {
      loads.push(Promise.all([loadImage(ch.parts.body), loadImage(ch.parts.face)]).then(([b, f]) => { ch.body = b; ch.face = f; }));
    }
    let itemImg = null;
    if (page.Item && page.Item.FileName) loads.push(loadImage(page.Item.FileName + '.png').then((im) => { itemImg = im; }));
    await Promise.all(loads);

    // background (two layers for crossfades). As in the game's Screen.renderBackgroundColor, Color tints the
    // background image (RawImage.color multiplies it) and defaults to white; with no image the colour (or white)
    // fills the screen
    const [a, b] = this.bgLayers;
    const hex = (bg.Color || '').replace('#', '');
    const color = hex.length >= 6 ? '#' + hex.slice(0, 6) : '#fff';
    const bgName = bg.CrossFadeToFileName || bg.FileName;
    const setBg = (el, name, tint = color) => { el.style.backgroundImage = name ? `url("${asset(name)}")` : 'none'; el.style.backgroundColor = tint; };
    if (bg.CrossFadeToFileName && !opts.instant) {
      // the outgoing image is drawn untinted over the incoming one, which takes the page's colour
      setBg(a, bg.FileName, '#fff'); setBg(b, bg.CrossFadeToFileName);
      b.style.transition = 'none'; b.style.opacity = 0;
      void b.offsetWidth;
      b.style.transition = ''; b.style.opacity = 1;
    } else {
      setBg(a, bgName); b.style.transition = 'none'; b.style.opacity = 0;
    }

    // characters, as the game's CharaManager / Chara.Play do it: the 13 slots are fixed sprite objects whose
    // image is swapped in place, and a slot left empty is hidden at once. setLayer then moves a sprite with a
    // Layer (1 front, 2 middle, 3 back) to the top of that layer; with Layer 0 it stays in its layer and
    // IsFront brings it to the top. Last comes the fade (ifPlayFadeAnimation).
    const layer = $('#charas');
    const bySlot = new Map(charas.map((ch) => [ch.slot, ch]));
    for (let slot = 0; slot < 13; slot++) {
      const ch = bySlot.get(slot);
      let el = this.charaEls[slot];
      if (ch && !ch.body) this.noteMissing('キャラクター画像');
      if (!ch || !ch.body) {
        if (el) { el.hidden = true; for (const a of el.getAnimations()) a.cancel(); }
        continue;
      }
      const { c } = ch;
      if (!el) {
        el = this.charaEls[slot] = document.createElement('div');
        el.className = 'chara';
        layer.appendChild(el);
      }
      el.hidden = false;
      const sig = c.FileName.trim();
      if (el.dataset.sig !== sig) { this.fillChara(el, ch); el.dataset.sig = sig; }
      el.style.left = SLOT_X[slot] + 'px';
      el.classList.toggle('shadow', !!c.IsShadow);
      el.classList.toggle('noise', !!c.IsNoise);
      this.layerChara(slot, c);
      this.fadeChara(el, c, opts.instant);
    }
    // LayerBack, LayerMiddle, LayerFront, each in sibling order
    [3, 2, 1].forEach((L, rank) => this.charaLayers[L].forEach((slot, k) => {
      if (this.charaEls[slot]) this.charaEls[slot].style.zIndex = String(rank * 100 + k);
    }));

    // item popup
    const item = $('#item');
    item.innerHTML = '';
    if (itemImg) {
      const n = itemImg.cloneNode();
      n.style.left = (STAGE_W / 2 + (page.Item.PositionX || 0)) + 'px';
      item.appendChild(n);
    } else if (page.Item && page.Item.FileName) {
      this.noteMissing('アイテム画像');
    }

    // filter
    const f = (page.Filter && page.Filter.Name) || '';
    this.stage.classList.toggle('f-gray', /gray/.test(f));
    this.stage.classList.toggle('f-sepia', /sepia/.test(f));
  }

  // Chara.setLayer
  layerChara(slot, c) {
    const L = c.Layer | 0;
    const cur = [1, 2, 3].find((k) => this.charaLayers[k].includes(slot));
    const to = L >= 1 && L <= 3 ? L : c.IsFront ? cur : 0;
    if (!to) return;
    const list = this.charaLayers[cur];
    list.splice(list.indexOf(slot), 1);
    this.charaLayers[to].push(slot);
  }

  // Chara.ifPlayFadeAnimation: FadeInSpeed > 0 plays the 40-frame FadeIn clip at that speed (from transparent),
  // otherwise FadeOutSpeed > 0 plays FadeOut (from opaque), otherwise the alpha is set to 1 - but a clip still
  // playing from an earlier page keeps driving the alpha to its end. Instant shows where it ends up.
  fadeChara(el, c, instant) {
    const fadeIn = (c.FadeInSpeed || 0) > 0, fadeOut = !fadeIn && (c.FadeOutSpeed || 0) > 0;
    const running = el.getAnimations().filter((a) => a.playState === 'running');
    if (!fadeIn && !fadeOut) {
      if (running.length && !instant) return;
      // a clip cut short lands where it was heading (its end value is already the element's opacity)
      for (const a of running) a.cancel();
      if (!running.length) el.style.opacity = 1;
      return;
    }
    for (const a of running) a.cancel();
    el.style.opacity = fadeIn ? 1 : 0;
    const t = instant ? 0 : fadeSeconds(fadeIn ? c.FadeInSpeed : c.FadeOutSpeed);
    if (t) el.animate([{ opacity: fadeIn ? 0 : 1 }, { opacity: fadeIn ? 1 : 0 }], { duration: t * 1000, easing: CLIP_EASE });
  }

  // body image with its expression patch laid over it at the recorded face position
  fillChara(wrap, { parts, body, face }) {
    wrap.replaceChildren(body.cloneNode());
    const pos = parts.key && this.facepos[parts.key];
    if (face && pos) {
      const f = face.cloneNode();
      f.className = 'face';
      f.style.left = pos[0] + 'px';
      f.style.top = pos[1] + 'px';
      wrap.appendChild(f);
    } else if (parts.face) {
      this.noteMissing('表情画像');
    }
  }

  renderAudio(page, fast) {
    const s = page.Sound || {};
    this.audio.setBgm(s.BgmFileName || null);
    // Sound.PrepareAsync / Play: IsStopSe stops every SE, and so does any change of loop SE - a page without one
    // included - so a loop SE only carries on over pages that repeat it. Then the page's SEs, then a new loop.
    const se = s.Se || {};
    const loop = se.LoopSeFileName || null;
    if (se.IsStopSe) this.audio.stopSe();
    if (loop !== this.loopSeName) { this.loopSeName = null; this.audio.stopSe(); }
    if (!fast) {
      if (se.SeFileName) this.audio.storySe(seCue(se.SeFileName));
      if (se.Se2FileName) this.audio.storySe(seCue(se.Se2FileName));
    }
    if (loop && loop !== this.loopSeName) { this.loopSeName = loop; this.audio.setLoopSe(seCue(loop)); }
  }

  // ---- effects (the game's adv_* effect prefabs)
  clearEffects() {
    $('#fx').replaceChildren();
    for (const a of $('#scene').getAnimations()) a.cancel();
    this.heldOverlay = false;
    this.fxSkip = null;
    this.fxActive = null;
  }

  // Effect.PlayAsync: effects left over from earlier pages are switched off, then this page's effect plays.
  // Only the blocking ones (EffectBase.isBlocking: the fade-outs, the black / white wipes and
  // adv_fadein_white_2400) hold the page back; the rest play while the page carries on.
  // The same effect on consecutive pages is not played again unless SameEffectContinuousPlayMode is 1 (RePlay):
  // in the default mode (Once) it stays as it is, still running or finished. Shake is the exception: its object
  // never stays switched on, so it shakes every time.
  async runEffect(effect, opts) {
    const name = effect && !opts.jump ? effect.Name : null;
    if (name && name === this.fxActive && !effect.SameEffectContinuousPlayMode) return;
    this.clearEffects();
    if (!name) return;
    const spec = effectSpec(name);
    if (!spec) return;
    const anim = this.playEffect(spec);
    this.heldOverlay = !!spec.holds;
    if (spec.kind !== 'shake') this.fxActive = name;
    if (opts.instant) { anim.finish(); return; }
    if (!spec.blocking) return;
    // a click mid-way jumps the effect to its end
    this.fxSkip = () => anim.finish();
    await anim.finished.catch(() => {});
    this.fxSkip = null;
  }

  playEffect(spec) {
    const fx = $('#fx');
    const css = (rgb) => `rgb(${rgb.map((v) => Math.round(v * 255)).join(', ')})`;
    const panel = (cls, style) => {
      const d = document.createElement('div');
      d.className = 'fx-panel ' + cls;
      Object.assign(d.style, style);
      fx.appendChild(d);
      return d;
    };
    const timing = { duration: spec.ms, easing: spec.easing || CLIP_EASE, fill: 'forwards' };
    switch (spec.kind) {
      case 'shake': {
        // Shake: for 20 game frames the scene jumps to a random offset (x -20..0, y 0..20 up), then back
        const kf = [...Array(20)].map(() => ({ transform: `translate(${-20 * Math.random()}px, ${-20 * Math.random()}px)`, easing: 'step-end' }));
        return $('#scene').animate([...kf, { transform: 'none' }], { duration: frames(20) });
      }
      // (opacity follows the clip's smoothstep, re-alphaed for the game's linear-light blending)
      case 'fade':
        return panel('', { background: css(spec.color) }).animate(linearFade(spec.out ? 0 : 1, spec.out ? 1 : 0, spec.color), { ...timing, easing: 'linear' });
      // the wipes grow a 1138-wide panel from the right edge (in) or shrink it towards the left edge (out)
      case 'wipe':
        return panel('', spec.out ? { background: css(spec.color) } : { left: 'auto', right: '-1px', background: css(spec.color) })
          .animate([{ width: spec.out ? '1138px' : '0px' }, { width: spec.out ? '0px' : '1138px' }], timing);
      // a 2000px soft-edged black panel (the blur_left_black_mask 9-slice, mirrored for _right) slid by DOTween
      case 'blur':
        return panel('fx-blur' + (spec.flip ? ' flip' : ''), {}).animate([{ left: spec.from + 'px' }, { left: spec.to + 'px' }], timing);
      // swoon / waking: black eyelids opening (see drawEyes); the animation only carries the eased progress
      case 'eyes': {
        const cv = document.createElement('canvas');
        cv.className = 'fx-panel fx-eyes';
        cv.width = STAGE_W / 4;
        cv.height = STAGE_H / 4;
        fx.appendChild(cv);
        const anim = cv.animate([{ opacity: 1 }, { opacity: 1 }], timing);
        const tick = () => {
          if (!cv.isConnected) return;
          drawEyes(cv, spec.max * (anim.effect.getComputedTiming().progress ?? 1));
          if (anim.playState === 'running') requestAnimationFrame(tick);
        };
        tick();
        anim.finished.then(tick, () => {});
        return anim;
      }
    }
    return null;
  }

  // Title.PlayAsync: the title / subtitle card plays its animation, and without a voice holds another 70 frames.
  // Layout, art and curves are the game's Title prefab (UICanvas/NormalObjects/Title), in stage pixels.
  async renderTitle(page, gen, instant, voiced) {
    const t = $('#title');
    t.replaceChildren();
    const sub = page.SubTitle, single = page.SubTitleSingle;
    let imgs = [];
    if (page.Title) {
      imgs = await Promise.all([loadImage(page.Title.EpisodeNumberFileName), loadImage(page.Title.EpisodeNameFileName)]);
      if (gen !== this.gen) return;
    } else if (!(sub && (sub.EpisodeName || sub.EpisodeNumber)) && !(single && single.EpisodeName)) {
      return;
    }
    const anims = [];
    const el = (parent, cls, style = {}, text = null) => {
      const d = document.createElement('div');
      d.className = cls;
      Object.assign(d.style, style);
      if (text != null) d.textContent = text;
      parent.appendChild(d);
      return d;
    };
    const px = (v) => v + 'px';
    const play = (node, keyframes, sec, opts = {}) => {
      if (node && !instant) anims.push(node.animate(keyframes, { duration: sec * 1000, fill: 'backwards', ...opts }));
    };
    const slideX = (node, sec, f) => play(node, sampled(sec, f), sec);
    // a scale keyed at (time, value) points, Unity-style (flat tangents) and zero before the first key
    const scaleKeys = (node, total, keys) => play(node, [{ transform: 'scale(0)', offset: 0 }, ...keys.map(([time, v]) => (
      { transform: `scale(${v})`, offset: time / total, easing: CLIP_EASE }))], total, { fill: 'both' });
    // Unity UI Text with best fit: the string shrinks until it fits its box
    const fit = (node) => {
      for (let size = parseFloat(getComputedStyle(node).fontSize); size > 8 && (node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight); size -= 1) node.style.fontSize = size - 1 + 'px';
    };
    let length = 0.9;
    if (page.Title || sub) {
      const card = el(t, 'card');
      // EpisodeNameBG (the dotted name banner, under) and EpisodeNumberBG (the solid number banner, over)
      const nameBg = el(card, 'card-bg bar03', { left: px(216), top: px(300) });
      el(nameBg, 'card-line bar02', { left: px(724), top: px(2) });
      el(nameBg, 'card-line bar04', { left: px(-212.5), top: px(72.9) });
      const numBg = el(card, 'card-bg bar01', { left: px(159.9), top: px(255) });
      const eff1 = el(numBg, 'card-eff', { left: px(87.1 - 32), top: px(17.9 - 32) });
      const eff2 = el(numBg, 'card-eff', { left: px(51.1 - 32), top: px(38.1 - 32) });
      let name, num;
      if (page.Title) {
        const [numImg, nameImg] = imgs;
        // RawImages at native size: the name centred in its banner, the number left-aligned at 128.7
        if (nameImg) { name = nameBg.appendChild(nameImg.cloneNode()); name.className = 'card-img'; Object.assign(name.style, { left: px(370 - nameImg.width / 2), top: px(40.3 - nameImg.height / 2) }); }
        if (numImg) { num = numBg.appendChild(numImg.cloneNode()); num.className = 'card-img'; Object.assign(num.style, { left: px(128.7), top: px(29.4 - numImg.height / 2) }); }
        // the Title clip: banners in from the sides in 0.25 s, contents settling from 0.083 s to 0.417 s
        slideX(nameBg, 0.25, (x) => hermite(x, 0, -568, 2942.54, 0.25, -19, 0) + 19);
        slideX(numBg, 0.25, (x) => hermite(x, 0, 568, -4393.24, 0.25, 0, 0));
        slideX(name, 0.417, (x) => hermite(x, 0.083, -500, 0, 0.417, 0, 0));
        slideX(num, 0.417, (x) => hermite(x, 0.083, 300, -64.05, 0.417, -242.26, 0) + 242.26);
      } else {
        // UI Text (FOT-Rodin DB, #323232, best fit): the name centred in 560x42, the number left-aligned in 250x40
        name = el(nameBg, 'card-text', { left: px(90), top: px(45.3 - 21), width: px(560), height: px(42), justifyContent: 'center' }, sub.EpisodeName || '');
        num = el(numBg, 'card-text', { left: px(128.7), top: px(29.4 - 20), width: px(250), height: px(40) }, sub.EpisodeNumber || '');
        fit(name); fit(num);
        // the SubTitle clip: banners in 0.45 s, contents from 0.15 s to 0.75 s
        slideX(nameBg, 0.45, (x) => hermite(x, 0, -568, 0, 0.45, -19, 0) + 19);
        slideX(numBg, 0.45, (x) => hermite(x, 0, 568, 0, 0.45, 0, 0));
        slideX(name, 0.75, (x) => hermite(x, 0.15, -500, 0, 0.75, 0, 0));
        slideX(num, 0.75, (x) => hermite(x, 0.15, 426.616, -64.05, 0.75, -115.644, 0) + 115.644);
      }
      // the sparkles on the number banner pop in
      scaleKeys(eff1, 0.9, [[0.35, 0], [0.583, 1.3], [0.75, 1]]);
      scaleKeys(eff2, 0.9, [[0.5, 0], [0.733, 0.8], [0.9, 0.5]]);
      if (instant) { eff1.style.transform = 'scale(1)'; eff2.style.transform = 'scale(.5)'; }
    } else {
      // SubTitleSingleView: two name banners slide together (0.6 s InOutSine), the name follows (0.2 s delay,
      // 0.4 s) and two sparkles spin in
      const card = el(t, 'card');
      const right = el(card, 'card-bg bar03 tall', { left: px(216), top: px(260) });
      el(right, 'card-line bar04', { left: px(643.6), top: px(85.1), width: px(276.1), height: px(31) });
      const left = el(card, 'card-bg bar03 tall', { left: px(216), top: px(260) });
      el(left, 'card-line bar02', { left: px(-218.4), top: px(2.5), width: px(305.2), height: px(31.8) });
      const name = el(card, 'card-text', { left: px(580 - 280), top: px(316 - 21), width: px(560), height: px(42), justifyContent: 'center' }, single.EpisodeName);
      fit(name);
      const eff1 = el(card, 'card-eff', { left: px(318 - 32), top: px(276.8 - 32) });
      const eff2 = el(card, 'card-eff', { left: px(282 - 32), top: px(297 - 32) });
      const inOutSine = 'cubic-bezier(.37, 0, .63, 1)';
      play(right, [{ transform: 'translateX(445px)' }, { transform: 'none' }], 0.6, { easing: inOutSine });
      play(left, [{ transform: 'translateX(-549px)' }, { transform: 'none' }], 0.6, { easing: inOutSine });
      play(name, [{ transform: 'translateX(-762px)' }, { transform: 'none' }], 0.4, { delay: 200 });
      play(eff1, [{ transform: 'rotate(0) scale(0)' }, { transform: 'rotate(67.5deg) scale(1.3)', offset: 0.375 }, { transform: 'rotate(112.5deg) scale(1)', offset: 0.625 }, { transform: 'rotate(180deg) scale(1)' }], 0.4);
      play(eff2, [{ transform: 'rotate(0) scale(0)' }, { transform: 'rotate(65.5deg) scale(0)', offset: 0.364 }, { transform: 'rotate(114.5deg) scale(.8)', offset: 0.636 }, { transform: 'rotate(147.3deg) scale(.5)', offset: 0.818 }, { transform: 'rotate(180deg) scale(.5)' }], 0.55);
      // where the sparkles end up (the animations only fill backwards)
      eff1.style.transform = 'rotate(180deg)';
      eff2.style.transform = 'rotate(180deg) scale(.5)';
      length = 0.6;
    }
    if (instant) return;
    // a click ends the card early
    const wait = (ms) => Promise.race([sleep(ms).then(() => false), new Promise((r) => { this.cardSkip = () => r(true); })]);
    let skipped = await wait(length * 1000);
    if (!skipped && !voiced && gen === this.gen) skipped = await wait(frames(TITLE_HOLD));
    this.cardSkip = null;
    if (skipped) for (const a of anims) a.finish();
  }

  renderMovie(page, fast = false) {
    const mv = $('#movie');
    const m = page.InlineMovie || page.Movie;
    const blocking = !!(m && m.IsBlocking && !m.IsLoop);
    if (!m || !m.FileName || (fast && blocking)) { mv.pause(); mv.style.display = 'none'; mv.dataset.file = ''; return Promise.resolve(); }
    // Movie.PrepareAsync: a looping movie that is already playing the same file carries on
    if (!blocking && mv.dataset.file === m.FileName && mv.style.display !== 'none') return Promise.resolve();
    mv.dataset.file = m.FileName;
    return new Promise((res) => {
      const done = () => {
        this.adv.classList.remove('movie-playing');
        this.skipMovie = null;
        if (this.onMovie) this.onMovie(false);
        res();
      };
      if (blocking) {
        // full-screen movie: story UI is hidden; a tap brings up the game's SKIP / seek controls
        this.adv.classList.add('movie-playing');
        this.skipMovie = () => { mv.pause(); mv.style.display = 'none'; done(); };
        if (this.onMovie) this.onMovie(true);
      }
      // the movie files have no sound: its voice and music are separate cues that must
      // follow the video's clock (play / pause / seek)
      const tracks = [];
      if (m.VideoVoiceFileName) tracks.push({ cue: m.VideoVoiceFileName, kind: 'voice', at: 0 });
      for (const bi of m.BgmInfo || []) if (bi.BgmFileName) tracks.push({ cue: bi.BgmFileName, kind: 'bgm', at: (bi.StartTimeMilSec || 0) / 1000 });
      // `anchor` ties the running cues to the video: the video time and audio-clock time they were started at
      let live = [], anchor = null, gen = 0;
      const stopTracks = () => { gen++; anchor = null; for (const h of live) { try { h.src.stop(); } catch (e) { /* stopped */ } } live = []; };
      const syncTracks = async () => {
        stopTracks();
        const mine = gen;
        if (mv.paused || mv.ended) return;
        // decode first, then read the video's time, so the load time doesn't leave the audio behind the picture
        await Promise.all(tracks.map((tr) => this.audio.load(tr.cue)));
        if (mine !== gen || mv.paused || mv.ended) return;
        const t = mv.currentTime;
        const started = await Promise.all(tracks.map((tr) => this.audio.playFrom(tr.cue, tr.kind, Math.max(0, t - tr.at), Math.max(0, tr.at - t))));
        if (mine !== gen || mv.paused) { for (const h of started) if (h) h.src.stop(); return; }
        live = started.filter(Boolean);
        anchor = { t, at: this.audio.ctx.currentTime };
      };
      // the two clocks can drift apart (or the video can drop frames / wrap a loop): re-cue when they differ by 0.1 s
      const checkDrift = () => {
        if (!anchor || mv.paused || this.audio.ctx.state !== 'running') return;
        if (Math.abs(anchor.t + (this.audio.ctx.currentTime - anchor.at) - mv.currentTime) > 0.1) syncTracks();
      };
      const clear = () => { mv.onplaying = mv.onseeked = mv.onpause = mv.onwaiting = mv.ontimeupdate = null; };
      if (tracks.length) {
        if (tracks.some((tr) => tr.kind === 'bgm')) this.audio.setBgm(null);
        mv.onplaying = syncTracks;
        mv.onseeked = syncTracks;
        mv.onpause = stopTracks;
        // the video stalled to buffer: silence the cues until it plays again (onplaying re-cues them)
        mv.onwaiting = stopTracks;
        mv.ontimeupdate = checkDrift;
      } else {
        clear();
      }
      const prevDone = done;
      const finish = () => { stopTracks(); clear(); prevDone(); };
      this.skipMovie = blocking ? () => { mv.pause(); mv.style.display = 'none'; finish(); } : null;
      if (!blocking) this.loopMovieStop = stopTracks;
      mv.onended = () => { if (!m.IsLoop) mv.style.display = 'none'; finish(); };
      mv.onerror = () => { mv.style.display = 'none'; finish(); };
      mv.loop = !!m.IsLoop;
      mv.src = asset(m.FileName);
      mv.style.display = 'block';
      // the game's VideoPlayer has no audio output (AudioOutputMode None): a movie's sound is only the script's voice /
      // BGM cues above, even for the 38 story movies whose MP4 carries its own audio track
      mv.muted = true;
      mv.play().catch(() => done());
      if (m.IsLoop) res();
    });
  }

  // ---- text box: the game's Open / Close clips grow and shrink it from its centre line in 10 frames
  boxClip(open) {
    const shut = { clipPath: 'inset(50% 0 50% 0)' }, full = { clipPath: 'inset(0% 0 0% 0)' };
    return $('#textbox').animate(open ? [shut, full] : [full, shut], { duration: BOX_CLIP * 1000, easing: CLIP_EASE });
  }
  async closeTextbox(instant) {
    const box = $('#textbox');
    if (box.hidden) return;
    if (!instant) await this.boxClip(false).finished.catch(() => {});
    box.hidden = true;
  }

  // ---- text: the full line is laid out up front (untyped part hidden) so it never rewraps
  showText(ta, gen) {
    const box = $('#textbox');
    const opening = box.hidden;
    box.hidden = false;
    box.classList.remove('done');
    const name = this.subst((ta.Name || '').trim());
    $('#speaker').textContent = name;
    const full = this.subst((ta.Dialogue || '').replace(/\r/g, ''));
    this.currentText = full;
    const typed = $('#dialogue .typed'), rest = $('#dialogue .rest');
    const chars = Array.from(full);
    const skip = this.pendingSkip;
    this.pendingSkip = false;
    typed.textContent = ''; rest.textContent = full;
    // a line too long for the box's 3 rows: the game's Text (legacy uGUI, VerticalOverflow Truncate) breaks between
    // any two characters, with no rule keeping 。 off the start of a row, and drops the rows that don't fit. Only these
    // lines get that layout; the rest keep the strict line breaking
    const dlg = $('#dialogue');
    dlg.classList.remove('overflow');
    if (dlg.offsetHeight > 3 * 43.5 + 1) dlg.classList.add('overflow');
    // rows of text, for the auto-mode wait (TextArea.DialogueRow)
    this.rows = full ? Math.round(dlg.offsetHeight / 43.5) : 0;
    const fast = this.mode === 'fast';
    const delay = this.textDelay;
    if (!delay || fast || skip) {
      if (opening && !fast) this.boxClip(true);
      typed.textContent = full; rest.textContent = '';
      box.classList.add('done');
      return Promise.resolve();
    }
    // TextArea.PlayAsync: the box opens first, then one character every textDelay ms
    return new Promise((res) => {
      const typing = this.typing = { full, res, raf: 0 };
      const start = () => {
        if (this.typing !== typing || gen !== this.gen) return;
        let i = 0;
        const t0 = performance.now();
        const step = (now) => {
          if (gen !== this.gen || this.typing !== typing) return;
          const n = Math.min(chars.length, Math.floor((now - t0) / delay) + 1);
          if (n !== i) { i = n; typed.textContent = chars.slice(0, i).join(''); rest.textContent = chars.slice(i).join(''); }
          if (i >= chars.length) { this.typing = null; box.classList.add('done'); res(); return; }
          typing.raf = requestAnimationFrame(step);
        };
        typing.raf = requestAnimationFrame(step);
      };
      if (opening) this.boxClip(true).finished.then(start, start); else start();
    });
  }
  // scripts write the player's name as the placeholder PLAYER; the game shows the user's name
  subst(s) { return s.replace(/PLAYER/g, this.playerName || 'あなた'); }

  finishTyping() {
    if (!this.typing) return;
    cancelAnimationFrame(this.typing.raf);
    $('#dialogue .typed').textContent = this.typing.full;
    $('#dialogue .rest').textContent = '';
    $('#textbox').classList.add('done');
    const r = this.typing.res;
    this.typing = null;
    r();
  }
  cancelTyping() { if (this.typing) { cancelAnimationFrame(this.typing.raf); this.typing = null; } }

  askChoice(choices) {
    const box = $('#choices');
    box.innerHTML = '';
    this.waitingChoice = true;
    return new Promise((res) => {
      for (const ch of choices) {
        const b = document.createElement('button');
        b.textContent = ch.Label || ('選択肢 ' + ch.Number);
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          this.choiceState[ch.Group] = ch.Number;
          box.innerHTML = '';
          this.waitingChoice = false;
          res();
        });
        box.appendChild(b);
      }
      const first = box.querySelector('button');
      if (first) first.focus({ preventScroll: true });
    });
  }

  // warm caches for the next few pages so voices/images are ready
  prefetch(i) {
    let j = i;
    for (let k = 0; k < 3; k++) {
      j = this.nextVisible(j);
      if (j < 0) break;
      const p = this.pages[j];
      const bg = p.BackGround || {};
      loadImage(bg.FileName); loadImage(bg.CrossFadeToFileName);
      for (const c of p.Charas || []) if (c && c.FileName && c.FileName.trim()) { const pt = charaParts(c.FileName); loadImage(pt.body); loadImage(pt.face); }
      const s = p.Sound || {};
      if (s.VoiceFileName) this.audio.load(s.VoiceFileName);
      if (s.BgmFileName) { this.audio.load(s.BgmFileName); this.audio.loopInfo(s.BgmFileName); }
      // a movie's voice / music cues, so they are decoded before the video starts
      const mv = p.InlineMovie || p.Movie;
      if (mv && mv.VideoVoiceFileName) this.audio.load(mv.VideoVoiceFileName);
      for (const bi of (mv && mv.BgmInfo) || []) if (bi.BgmFileName) this.audio.load(bi.BgmFileName);
    }
  }

  // backlog face: the page's speaking character, body + expression composited and cropped around the head
  async speakerFace(page) {
    const ch = (page.Charas || []).find((c) => c && c.IsSpeaker && c.FileName && c.FileName.trim());
    if (!ch) return null;
    const parts = charaParts(ch.FileName);
    const [body, face] = await Promise.all([loadImage(parts.body), loadImage(parts.face)]);
    const pos = parts.key && this.facepos[parts.key];
    if (!body) return null;
    const W = 206, H = 202;   // 2x the 103x101 icon
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    // centre on the face patch (or the upper body when there is no face position)
    const cx = pos && face ? pos[0] + face.width / 2 : body.width / 2;
    const cy = pos && face ? pos[1] + face.height / 2 : body.height * 0.2;
    const crop = 230, sx = cx - crop / 2, sy = cy - crop * 0.5;
    const k = W / crop;
    g.drawImage(body, -sx * k, -sy * k, body.width * k, body.height * k);
    if (face && pos) g.drawImage(face, (pos[0] - sx) * k, (pos[1] - sy) * k, face.width * k, face.height * k);
    return c;
  }

  logEntries() {
    const seen = new Set();
    return this.history.filter((i) => !seen.has(i) && seen.add(i))
      .map((i) => ({ i, p: this.pages[i] }))
      .filter(({ p }) => p.TextArea && p.TextArea.Dialogue);
  }

  // the archive holds everything the game has; anything absent never existed, so stay quiet
  noteMissing() {}
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2600);
}

window.Player = Player;
