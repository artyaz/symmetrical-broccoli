// audio.js — Tiny WebAudio-based sound engine for symmetrical-broccoli.
//
// All sounds are SYNTHESISED at runtime from oscillators + noise buffers. No
// external audio files are loaded (keeps the bundle tiny and matches the
// "minimal UI, maximal juice" design philosophy — see docs/ANIMATION_GUIDE.md).
//
// Public API:
//   import { play, setMuted, isMuted, setVolume } from './audio.js';
//   play('cardFlip');          // fire-and-forget one-shot
//   setMuted(true);            // mute master
//   isMuted();                 // query
//   setVolume(0.5);            // master volume 0..1
//
// Behaviour notes:
//   - AudioContext is created LAZILY on first user gesture. Browsers block
//     autoplay until a user interacts with the page; we honour that by not
//     constructing the context until the first `play()` call (which is itself
//     triggered by a click/keypress elsewhere in the app).
//   - If the context is in 'suspended' state when play() is called, we attempt
//     to resume it. If the resume fails (no user gesture yet), the sound is
//     silently skipped — no error thrown.
//   - prefers-reduced-motion AND prefers-reduced-data both auto-mute. The
//     former because reduced-motion users typically want less sensory input;
//     the latter because synthesising audio is work the user has asked us not
//     to do.
//   - Mute preference is persisted in localStorage so it survives reloads.
//
// This module is imported lazily by Game.svelte / Table.svelte (via the views/
// ui chunks in vite.config.js's manualChunks), so it never lands in the entry
// chunk. The synth functions themselves are only constructed on first play(),
// so even within the audio chunk there's zero startup cost.

const STORAGE_KEY = 'broccoli.audio.muted';

// Master volume (linear gain, 0..1).
let _volume = 0.4;
let _muted = false;

// Lazily-created AudioContext + master gain.
let _ctx = null;
let _master = null;

// Cached white-noise buffer (2 seconds, reused across all noise-based sounds).
let _noiseBuffer = null;

// ---------------------------------------------------------------------------
// ENVIRONMENT DETECTION
// ---------------------------------------------------------------------------

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const prefersReducedData = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-data: reduce)').matches;

// SSR / non-DOM guard (this module may be imported during prerender).
const hasAudioContext = () =>
  typeof window !== 'undefined' &&
  typeof window.AudioContext === 'function';

// On module load: read persisted mute preference and apply environment auto-mute.
// We don't construct the context here — only flags.
(function init() {
  if (typeof window === 'undefined') return;
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    if (stored === '1') _muted = true;
  } catch {
    // localStorage may be disabled (privacy mode); ignore.
  }
  // If the user has expressed a reduced-motion OR reduced-data preference,
  // default to muted. We do this once at module init; if they explicitly
  // unmute later we respect that.
  if (prefersReducedMotion() || prefersReducedData()) {
    _muted = true;
  }
})();

// ---------------------------------------------------------------------------
// LAZY CONTEXT CONSTRUCTION
// ---------------------------------------------------------------------------

function ensureContext() {
  if (!hasAudioContext()) return null;
  if (!_ctx) {
    _ctx = new AudioContext();
    _master = _ctx.createGain();
    _master.gain.value = _muted ? 0 : _volume;
    _master.connect(_ctx.destination);
    // Pre-render a 2s white-noise buffer that all noise-based sounds reuse.
    _noiseBuffer = _ctx.createBuffer(1, _ctx.sampleRate * 2, _ctx.sampleRate);
    const data = _noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  // Browsers may suspend the context until a user gesture. Attempt to resume.
  if (_ctx.state === 'suspended') {
    // Promise.reject is swallowed — caller can't do anything useful with it.
    _ctx.resume().catch(() => {});
  }
  return _ctx;
}

function applyMasterGain() {
  if (!_master) return;
  // Smooth ramp to the new value over 30ms to avoid clicks.
  const now = _ctx.currentTime;
  _master.gain.cancelScheduledValues(now);
  _master.gain.setValueAtTime(_master.gain.value, now);
  _master.gain.linearRampToValueAtTime(_muted ? 0 : _volume, now + 0.03);
}

// ---------------------------------------------------------------------------
// PRIMITIVE SYNTH BUILDERS
// ---------------------------------------------------------------------------
// Each builder returns an AudioNode connected to the master gain. The caller
// is responsible for stopping oscillators at the right time (we use ADSR-style
// gain envelopes on a separate GainNode).

function noiseSource() {
  const src = _ctx.createBufferSource();
  src.buffer = _noiseBuffer;
  src.loop = true;
  return src;
}

// Simple linear amplitude envelope. `gain` is the target peak.
function envelope(gainNode, { attack = 0.005, decay = 0.05, sustain = 0, peak = 1, startAt = 0, duration = 0.1 }) {
  const t = startAt;
  const sustainEnd = t + duration;
  gainNode.gain.setValueAtTime(0, t);
  gainNode.gain.linearRampToValueAtTime(peak, t + attack);
  gainNode.gain.linearRampToValueAtTime(sustain * peak, t + attack + decay);
  gainNode.gain.setValueAtTime(sustain * peak, sustainEnd);
  gainNode.gain.linearRampToValueAtTime(0, sustainEnd + 0.02);
}

// ---------------------------------------------------------------------------
// SOUND DEFINITIONS
// ---------------------------------------------------------------------------
// Each sound is a function that schedules nodes on the AudioContext timeline.
// We pass `when` (absolute ctx time) so sounds can be queued for arpeggios.

const sounds = {
  // soft "fwip" — filtered noise burst, 80ms, lowpass 800Hz.
  cardDraw(when) {
    const src = noiseSource();
    const filter = _ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1800, when);
    filter.frequency.exponentialRampToValueAtTime(500, when + 0.08);
    filter.Q.value = 1.2;
    const g = _ctx.createGain();
    src.connect(filter).connect(g).connect(_master);
    envelope(g, { attack: 0.004, decay: 0.05, peak: 0.5, startAt: when, duration: 0.08 });
    src.start(when);
    src.stop(when + 0.12);
  },

  // soft "thunk" — low sine 200Hz → 100Hz, 120ms.
  cardDrop(when) {
    const osc = _ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(200, when);
    osc.frequency.exponentialRampToValueAtTime(100, when + 0.12);
    const g = _ctx.createGain();
    osc.connect(g).connect(_master);
    envelope(g, { attack: 0.005, decay: 0.06, peak: 0.7, startAt: when, duration: 0.12 });
    osc.start(when);
    osc.stop(when + 0.16);
  },

  // crisp "snap" — white noise burst, 50ms, highpass 2kHz.
  cardFlip(when) {
    const src = noiseSource();
    const filter = _ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 2000;
    filter.Q.value = 0.7;
    const g = _ctx.createGain();
    src.connect(filter).connect(g).connect(_master);
    envelope(g, { attack: 0.002, decay: 0.02, peak: 0.65, startAt: when, duration: 0.05 });
    src.start(when);
    src.stop(when + 0.08);
  },

  // soft "click" — sine 800Hz, 40ms.
  cardSelect(when) {
    const osc = _ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 800;
    const g = _ctx.createGain();
    osc.connect(g).connect(_master);
    envelope(g, { attack: 0.002, decay: 0.02, peak: 0.4, startAt: when, duration: 0.04 });
    osc.start(when);
    osc.stop(when + 0.06);
  },

  // barely-audible "tick" — sine 1200Hz, 20ms.
  cardHover(when) {
    const osc = _ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 1200;
    const g = _ctx.createGain();
    osc.connect(g).connect(_master);
    envelope(g, { attack: 0.001, decay: 0.01, peak: 0.18, startAt: when, duration: 0.02 });
    osc.start(when);
    osc.stop(when + 0.04);
  },

  // triumphant arpeggio — 3 ascending sine tones C5-E5-G5, 80ms each.
  // C5 = 523.25, E5 = 659.25, G5 = 783.99 Hz.
  winnerReveal(when) {
    const freqs = [523.25, 659.25, 783.99];
    const step = 0.08;
    freqs.forEach((f, i) => {
      const t = when + i * step;
      const osc = _ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = _ctx.createGain();
      osc.connect(g).connect(_master);
      envelope(g, { attack: 0.005, decay: 0.04, peak: 0.55, startAt: t, duration: step });
      osc.start(t);
      osc.stop(t + step + 0.04);
    });
    // Add a soft low "thump" under the final note for weight.
    const bass = _ctx.createOscillator();
    bass.type = 'sine';
    bass.frequency.value = 130.81; // C3
    const bg = _ctx.createGain();
    bass.connect(bg).connect(_master);
    envelope(bg, { attack: 0.008, decay: 0.12, peak: 0.45, startAt: when + step * 2, duration: 0.18 });
    bass.start(when + step * 2);
    bass.stop(when + step * 2 + 0.22);
  },

  // soft "pop" — sine 400Hz, 60ms.
  voteCast(when) {
    const osc = _ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, when);
    osc.frequency.exponentialRampToValueAtTime(300, when + 0.06);
    const g = _ctx.createGain();
    osc.connect(g).connect(_master);
    envelope(g, { attack: 0.003, decay: 0.03, peak: 0.5, startAt: when, duration: 0.06 });
    osc.start(when);
    osc.stop(when + 0.09);
  },

  // soft "swoosh" — filtered noise 200ms, bandpass sweep.
  phaseChange(when) {
    const src = noiseSource();
    const filter = _ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 0.8;
    filter.frequency.setValueAtTime(400, when);
    filter.frequency.exponentialRampToValueAtTime(3500, when + 0.12);
    filter.frequency.exponentialRampToValueAtTime(800, when + 0.2);
    const g = _ctx.createGain();
    src.connect(filter).connect(g).connect(_master);
    envelope(g, { attack: 0.02, decay: 0.1, peak: 0.4, startAt: when, duration: 0.2 });
    src.start(when);
    src.stop(when + 0.24);
  },

  // soft "bonk" — sine 200Hz, 100ms, descending.
  error(when) {
    const osc = _ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(240, when);
    osc.frequency.exponentialRampToValueAtTime(120, when + 0.1);
    const g = _ctx.createGain();
    osc.connect(g).connect(_master);
    envelope(g, { attack: 0.005, decay: 0.06, peak: 0.5, startAt: when, duration: 0.1 });
    osc.start(when);
    osc.stop(when + 0.13);
  },
};

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

/**
 * Play a named sound. Safe to call before any user gesture: the AudioContext
 * is constructed lazily and silently no-ops if the browser refuses to start
 * it. Unknown sound names are ignored (logged once in dev).
 *
 * @param {string} name  one of: cardDraw, cardDrop, cardFlip, cardSelect,
 *                       cardHover, winnerReveal, voteCast, phaseChange, error
 */
export function play(name) {
  if (_muted) return;
  const fn = sounds[name];
  if (!fn) {
    if (import.meta.env?.DEV) console.warn('[audio] unknown sound:', name);
    return;
  }
  const ctx = ensureContext();
  if (!ctx) return;
  // If the context is still suspended after our resume attempt, skip — the
  // browser hasn't seen a user gesture yet. We don't queue the sound because
  // that would create a confusing delayed burst when the gesture finally lands.
  if (ctx.state === 'suspended') return;
  const when = ctx.currentTime + 0.001; // tiny lead to avoid scheduling edge cases
  try {
    fn(when);
  } catch (err) {
    if (import.meta.env?.DEV) console.warn('[audio] play failed:', err);
  }
}

/**
 * Mute / unmute the master gain. Persists to localStorage so the preference
 * survives reloads.
 *
 * @param {boolean} muted
 */
export function setMuted(muted) {
  _muted = !!muted;
  try {
    window.localStorage?.setItem(STORAGE_KEY, _muted ? '1' : '0');
  } catch {
    // ignore storage failures
  }
  applyMasterGain();
}

/**
 * @returns {boolean} current mute state
 */
export function isMuted() {
  return _muted;
}

/**
 * Set the master volume (0..1). Takes effect immediately with a tiny ramp to
 * avoid clicks.
 *
 * @param {number} v
 */
export function setVolume(v) {
  _volume = Math.max(0, Math.min(1, v));
  applyMasterGain();
}

export default { play, setMuted, isMuted, setVolume };
