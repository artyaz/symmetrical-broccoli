// juice.js — Runtime helpers for "juicy" feedback: screen shake, hit-stop
// (freeze frame), and a tiny particle burst. These are imperative (not
// reactive) because they're one-shot effects triggered by game events.
//
// All effects respect prefers-reduced-motion.
//
// Usage from a Svelte component:
//   import { shake, hitStop, burst } from '../anim/juice.js';
//   shake(8);          // 8px screen shake for 240ms
//   hitStop(120);      // freeze game logic for 120ms
//   burst(x, y, 24);   // 24 white particles from (x,y)

import { cssEase } from './easing-helpers.js';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// SCREEN SHAKE
// ---------------------------------------------------------------------------
// We attach a fixed-positioned wrapper to the body and animate its transform.
// Only one shake runs at a time; the latest shake "wins" and replaces any
// in-flight one. This avoids shake-on-shake stacking which causes nausea.

let _shakeEl = null;
let _shakeAnim = null;

function ensureShakeEl() {
  if (_shakeEl && document.body.contains(_shakeEl)) return _shakeEl;
  _shakeEl = document.createElement('div');
  _shakeEl.className = 'broccoli-shake';
  _shakeEl.style.cssText = `
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 99999;
    will-change: transform;
  `;
  // The shake wrapper actually translates the *children* of <body>. But that
  // would break `position: fixed` children. Instead, we apply the shake to a
  // pseudo-layer that just contains a single visual "screen jitter" overlay.
  // For minimal-design apps, the cleanest approach is to translate the entire
  // <html> root via CSS variable, then have body's transform read it.
  document.documentElement.appendChild(_shakeEl);
  // Set up the global CSS that reads our variable.
  if (!document.getElementById('broccoli-shake-style')) {
    const s = document.createElement('style');
    s.id = 'broccoli-shake-style';
    s.textContent = `
      html.broccoli-shaking {
        animation: broccoli-shake-var 240ms cubic-bezier(${cssEase.subtleshake});
      }
      @keyframes broccoli-shake-var {
        0%, 100% { transform: translate(0, 0); }
        20%      { transform: translate(calc(var(--shake-x, 0px) * -1), calc(var(--shake-y, 0px) * 0.6)); }
        40%      { transform: translate(calc(var(--shake-x, 0px) * 0.8),  calc(var(--shake-y, 0px) * -0.8)); }
        60%      { transform: translate(calc(var(--shake-x, 0px) * -0.6), calc(var(--shake-y, 0px) * 0.4)); }
        80%      { transform: translate(calc(var(--shake-x, 0px) * 0.3),  calc(var(--shake-y, 0px) * -0.2)); }
      }
    `;
    document.head.appendChild(s);
  }
  return _shakeEl;
}

export function shake(intensityPx = 6, durationMs = 240) {
  if (prefersReducedMotion()) return;
  ensureShakeEl();
  document.documentElement.style.setProperty('--shake-x', `${intensityPx}px`);
  document.documentElement.style.setProperty('--shake-y', `${intensityPx}px`);
  document.documentElement.classList.add('broccoli-shaking');
  if (_shakeAnim) clearTimeout(_shakeAnim);
  _shakeAnim = setTimeout(() => {
    document.documentElement.classList.remove('broccoli-shaking');
  }, durationMs);
}

// ---------------------------------------------------------------------------
// HIT STOP
// ---------------------------------------------------------------------------
// A short freeze-frame that makes impacts feel heavier. Implemented by
// blocking the next rAF — anything scheduling state updates via rAF will
// pause for the duration. JS-setTimeout callbacks still fire, so use this
// sparingly and only around big moments (card play, winner reveal).
//
// Implementation note: we don't actually freeze the JS event loop (impossible
// without workers). We just delay any callbacks scheduled through our own
// `scheduled` queue. Svelte stores will continue to update; if you want a
// hard freeze, you need to gate your reducer on `isInHitStop()`.

let _hitStopUntil = 0;
export function hitStop(durationMs = 100) {
  if (prefersReducedMotion()) return;
  _hitStopUntil = Math.max(_hitStopUntil, performance.now() + durationMs);
}
export function isInHitStop() {
  return performance.now() < _hitStopUntil;
}

// ---------------------------------------------------------------------------
// PARTICLE BURST
// ---------------------------------------------------------------------------
// Spawn N tiny dots at (x, y) that fly outward with random angles and fade.
// Uses WAAPI for one-shot animation; elements are removed after the animation
// finishes. CSS-only — no canvas, no Three.js, no library.

const _particleColors = ['#fafafa', '#ffffff', '#e0e0e0', '#c0c0c0'];

export function burst(x, y, count = 18, opts = {}) {
  if (prefersReducedMotion()) return;
  const {
    durationMs = 720,
    distancePx = 90,
    sizePx = 4,
    colors = _particleColors,
  } = opts;
  const host = document.createElement('div');
  host.style.cssText = `
    position: fixed;
    left: ${x}px;
    top: ${y}px;
    width: 0;
    height: 0;
    pointer-events: none;
    z-index: 99998;
  `;
  document.body.appendChild(host);

  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.6;
    const dist = distancePx * (0.55 + Math.random() * 0.6);
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist - 20; // bias upward
    const sz = sizePx * (0.7 + Math.random() * 0.7);
    const color = colors[(Math.random() * colors.length) | 0];
    p.style.cssText = `
      position: absolute;
      left: ${-sz / 2}px;
      top: ${-sz / 2}px;
      width: ${sz}px;
      height: ${sz}px;
      background: ${color};
      border-radius: 50%;
      will-change: transform, opacity;
    `;
    host.appendChild(p);
    p.animate(
      [
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: `translate(${dx * 0.6}px, ${dy * 0.6}px) scale(1.05)`, opacity: 1, offset: 0.3 },
        { transform: `translate(${dx}px, ${dy + 30}px) scale(0.4)`, opacity: 0 },
      ],
      {
        duration: durationMs * (0.7 + Math.random() * 0.6),
        easing: cssEase.drop,
        fill: 'forwards',
      },
    );
  }

  setTimeout(() => host.remove(), durationMs * 1.6);
}

// ---------------------------------------------------------------------------
// CARD-PLAY FLY ANIMATION
// ---------------------------------------------------------------------------
// Imperative helper that flies a "ghost" of a card from one element to another.
// Used when a player picks a card from their hand: a duplicate of the card
// flies to the centre of the table while the original stays in hand (or
// disappears depending on context).
//
// `fromEl` is the source element (e.g. the card in hand).
// `toEl` is the destination (e.g. the black card slot).
// `textContent` is what to render on the ghost.

export function flyCard(fromEl, toEl, textContent) {
  if (prefersReducedMotion()) return Promise.resolve();
  const from = fromEl.getBoundingClientRect();
  const to = toEl.getBoundingClientRect();
  const ghost = document.createElement('div');
  ghost.textContent = textContent;
  ghost.style.cssText = `
    position: fixed;
    left: ${from.left}px;
    top: ${from.top}px;
    width: ${from.width}px;
    height: ${from.height}px;
    background: var(--card-w, #fafafa);
    color: #0a0a0a;
    padding: 14px;
    font-family: var(--font, sans-serif);
    font-size: 13px;
    font-weight: 600;
    line-height: 1.32;
    border-radius: 8px;
    box-shadow: 0 22px 50px -8px rgba(0,0,0,0.85);
    pointer-events: none;
    z-index: 99997;
    will-change: transform, opacity;
    backface-visibility: hidden;
  `;
  document.body.appendChild(ghost);

  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  // Mid-point arc: lift the card upward so the path curves.
  const midY = Math.min(dy, -80);

  return new Promise((resolve) => {
    const anim = ghost.animate(
      [
        { transform: 'translate(0, 0) rotate(0deg) scale(1)', opacity: 1 },
        {
          transform: `translate(${dx * 0.5}px, ${midY}px) rotate(${(Math.random() - 0.5) * 18}deg) scale(1.08)`,
          opacity: 1,
          offset: 0.55,
        },
        {
          transform: `translate(${dx}px, ${dy}px) rotate(${(Math.random() - 0.5) * 8}deg) scale(0.6)`,
          opacity: 0,
        },
      ],
      { duration: 720, easing: cssEase.whip, fill: 'forwards' },
    );
    anim.onfinish = () => {
      ghost.remove();
      resolve();
    };
  });
}

// ---------------------------------------------------------------------------
// AMBIENT GLOW PULSE
// ---------------------------------------------------------------------------
// Adds a brief soft glow to an element. Used on the round-winning card before
// the winner tag appears.

export function glowPulse(el, color = 'rgba(255,255,255,0.35)', durationMs = 1200) {
  if (prefersReducedMotion() || !el) return;
  el.animate(
    [
      { boxShadow: `0 0 0 0 ${color}`, filter: 'brightness(1)' },
      { boxShadow: `0 0 60px 14px ${color}`, filter: 'brightness(1.15)', offset: 0.4 },
      { boxShadow: `0 0 0 0 ${color}`, filter: 'brightness(1)' },
    ],
    { duration: durationMs, easing: cssEase.juicy },
  );
}

// ---------------------------------------------------------------------------
// CARD REVEAL CEREMONY
// ---------------------------------------------------------------------------
// The full "czar reveals a submission" moment. Layered juice:
//   1. Soft halo glow pulse (glowPulse above).
//   2. A `revealing` CSS class on the element for 600ms that scales it
//      1.0 → 1.06 → 1.0 (signature overshoot for hero moments).
//   3. An 80ms hit-stop on the game loop so the reveal lands with weight.
//
// Returns a Promise that resolves when the ceremony is complete (600ms after
// start, or immediately under prefers-reduced-motion). The caller (Table.svelte)
// may await this before re-enabling the reveal-next button.
//
// `index` is currently unused but accepted for forward compatibility (e.g.
// staggering multiple simultaneous reveals or per-index pitch shift on the
// snap sound — the caller passes it through for clarity).

let _revealStyleInjected = false;
function ensureRevealStyle() {
  if (_revealStyleInjected) return;
  _revealStyleInjected = true;
  const s = document.createElement('style');
  s.id = 'broccoli-reveal-style';
  // The keyframe scales 1.0 → 1.06 → 1.0 using the signature `juicy`
  // cubic-bezier so the overshoot reads as deliberate, not janky. We don't
  // animate `box-shadow` here — glowPulse() handles the halo separately so the
  // two effects can run in parallel without fighting over the same property.
  s.textContent = `
    .broccoli-revealing {
      animation: broccoli-reveal-scale 600ms cubic-bezier(${cssEase.juicy}) !important;
      will-change: transform;
      z-index: 10;
    }
    @keyframes broccoli-reveal-scale {
      0%   { transform: scale(1); }
      45%  { transform: scale(1.06); }
      100% { transform: scale(1); }
    }
  `;
  document.head.appendChild(s);
}

export function revealCard(el, index = 0) {
  // Reduced motion: skip the visual ceremony but still resolve, so callers
  // can await unconditionally.
  if (prefersReducedMotion() || !el) return Promise.resolve();
  ensureRevealStyle();
  // Halo glow — runs in parallel with the scale animation below.
  glowPulse(el);
  // Add the scale class; remove it once the 600ms animation completes so the
  // class doesn't conflict with future hover/winner transforms on the same el.
  el.classList.add('broccoli-revealing');
  // Hit-stop the game loop for 80ms — this is the "weight" of the reveal.
  hitStop(80);
  return new Promise((resolve) => {
    setTimeout(() => {
      el.classList.remove('broccoli-revealing');
      resolve();
    }, 600);
  });
}
