/**
 * easing.js — Centralised animation constants for the symmetrical-broccoli
 * Cards Against Humanity game.
 *
 * Design philosophy:
 *   - Minimal UI, maximal juice. Every easing curve here exists to make a
 *     card interaction feel heavier, snappier, or more alive than the static
 *     black/white card would suggest on its own.
 *   - All cubic-bezier arrays are [x1, y1, x2, y2] in the same format the CSS
 *     `cubic-bezier()` function and the Web Animations API `easing` option use.
 *   - All spring configs are `{ stiffness, damping, precision? }` objects that
 *     can be spread straight into Svelte's `spring()` initialiser.
 *
 * References (see docs/ANIMATION_GUIDE.md for the full theoretical write-up):
 *   - Jan Willem Nijman (Vlambeer), "The Art of Screenshake", INDIGO 2013
 *   - Disney's 12 principles of animation (Johnston & Thomas, "The Illusion of Life")
 *   - Nir Eyal, "Hooked: How to Build Habit-Forming Products"
 *   - Svelte `svelte/motion` spring docs: stiffness default 0.15, damping 0.8
 *   - easings.net and MDN cubic-bezier()
 *
 * Conventions:
 *   - Svelte's `spring()` and `tweened()` accept these objects/values directly.
 *   - For CSS `transition: ... cubic-bezier(x1, y1, x2, y2)` use the spread
 *     values, e.g. `transition: transform 220ms cubic-bezier(${easing.juicy.join(',')});`
 *   - For the Web Animations API pass the array joined as a string in the
 *     options object: `el.animate(kfs, { easing: easing.juicy.join(',') })`.
 */

// ---------------------------------------------------------------------------
// CUBIC-BEZIER EASING CURVES
// ---------------------------------------------------------------------------
// Format: [x1, y1, x2, y2]. Values outside [0,1] on Y produce overshoot /
// wind-back (the "juice"). X values must stay in [0,1] per the spec.
//
// Naming intent:
//   juicy        — the signature overshoot. Use for the "hero" moment of any
//                  interaction (card lands, score pops, button confirm).
//   snap         — ultra-fast settle with no overshoot. UI state changes,
//                  toggles, fast feedback that shouldn't feel springy.
//   settle       — smooth ease-out, no overshoot. Default for "things
//                  arriving" (cards dealt into hand, panels open).
//   anticipation — negative-Y curve that pulls backward first. Pair with a
//                  follow-up juicy/snap curve to get wind-up + release.
//   bounce       — double-sided overshoot. Bouncy reveals, "you won" pulses.
//   whip         — fast in, slow out with snap. Card "thrown" toward table.
//   drop         — ease-in, gravity feel. Card falling into discard pile.
//   lift         — gentle ease-out for hover-lift / un-hover.
//   easeInOutBack — overshoots at both ends; great for symmetric reveals.
//   reveal       — long ease-out tuned for 3D card flip so the back face
//                  already reads as "settling" by the time it's visible.
//   subtleshake  — not an easing curve per se but a quick punchy curve for
//                  micro screen-shake keyframes on card drops.
// ---------------------------------------------------------------------------
export const easing = {
  juicy:         [0.34, 1.56, 0.64, 1],   // back-out, signature overshoot
  snap:          [0.85, 0.0, 0.15, 1.0],  // fast both ways, no overshoot
  settle:        [0.22, 1.0, 0.36, 1.0],  // smooth expo-out
  anticipation:  [0.4, 0.0, 0.6, -1.0],   // wind-up (pulls back below 0)
  bounce:        [0.68, -0.55, 0.265, 1.55], // double-sided overshoot
  whip:          [0.55, 0.0, 0.10, 1.0],  // throw then snap
  drop:          [0.55, 0.085, 0.68, 0.53], // ease-in, gravity
  lift:          [0.25, 0.46, 0.45, 0.94], // gentle ease-out
  easeInOutBack: [0.68, -0.6, 0.32, 1.6], // overshoot both ends
  reveal:        [0.16, 1.0, 0.30, 1.0],  // card flip reveal
  subtleshake:   [0.36, 0.0, 0.66, -0.56], // micro impact for shake keyframes
};

// Pre-formatted CSS strings for convenience inside <style> blocks.
export const cssEasing = Object.fromEntries(
  Object.entries(easing).map(([k, v]) => [k, `cubic-bezier(${v.join(',')})`]),
);

// ---------------------------------------------------------------------------
// DURATIONS (ms)
// ---------------------------------------------------------------------------
// Reference grid (Vlambeer / Nijman translate "1-3 frames for micro, 5-10 for
// large" into modern web timing). 60fps frame ≈ 16.7ms; we round to friendly
// numbers. Keep micro-interactions under 300ms — anything more feels sluggish.
//
// `hitStop` is the freeze-frame window applied on big card plays. It is a
// programmatic pause, not an easing curve; see ANIMATION_GUIDE.md §6.
// ---------------------------------------------------------------------------
export const duration = {
  micro:     120,  // hover state change, glow pulse
  short:     180,  // button press, small lift
  medium:    260,  // card lift into hand
  long:      380,  // card flip reveal
  hero:      520,  // winner fly-to, round-end celebration
  hitStop:   90,   // freeze frame on heavy card drop (090ms reads as "weight")
  screenShake: 240, // total envelope of a shake burst (inner keyframes faster)
};

// ---------------------------------------------------------------------------
// SVELTE SPRING / TWEENED CONFIGS
// ---------------------------------------------------------------------------
// Svelte `spring(initial, { stiffness, damping, precision })`:
//   - stiffness  (0..1, default 0.15): higher = tighter, faster snap.
//   - damping    (0..1, default 0.8):  higher = less oscillation/overshoot.
//   - precision  (default 0.01):       stop threshold; lower = smoother tail.
//
// Svelte `tweened(initial, { duration, easing })`:
//   - duration in ms (or function of from/to).
//   - easing as a t => number function. Use `cubicBezierArray()` below to
//     convert the [x1,y1,x2,y2] arrays into a usable easing function.
// ---------------------------------------------------------------------------
export const springs = {
  // Card hover in hand: responsive but slightly springy so the card
  // "pops up" toward the cursor with a tiny overshoot.
  cardHover:    { stiffness: 0.28, damping: 0.55, precision: 0.01 },

  // Card select pulse: stiffer so it locks in fast, low damping for one
  // visible bounce to communicate "selected!".
  cardSelect:   { stiffness: 0.40, damping: 0.45, precision: 0.01 },

  // Card play (thrown to centre): looser, longer travel, more oscillation
  // so the card feels like it has weight and momentum.
  cardPlay:     { stiffness: 0.12, damping: 0.35, precision: 0.01 },

  // Hand fan rearrangement when cards are added/removed: smooth and slow,
  // neighbours glide rather than snap.
  handFan:      { stiffness: 0.09, damping: 0.82, precision: 0.005 },

  // Deck shuffle jitter: high stiffness, low damping = tight erratic motion.
  deckShuffle:  { stiffness: 0.55, damping: 0.25, precision: 0.02 },

  // Card flip reveal: medium, slightly damped so the settle doesn't bounce.
  flipReveal:   { stiffness: 0.18, damping: 0.72, precision: 0.005 },

  // Winner fly-to: very loose, dramatic, slow — celebratory arc.
  winnerFlyTo:  { stiffness: 0.06, damping: 0.50, precision: 0.005 },

  // Camera/screen offset spring for screen shake on card drops. Stiff so
  // the shake returns to zero quickly between impulses.
  screenShake:  { stiffness: 0.50, damping: 0.30, precision: 0.05 },

  // General-purpose soft motion for ambient UI drift (score counters, etc.).
  ambient:      { stiffness: 0.10, damping: 0.85, precision: 0.01 },
};

// ---------------------------------------------------------------------------
// TWEENED CONFIGS
// ---------------------------------------------------------------------------
// Ready to spread into `tweened(initial, config)`. The `easing` value is a
// function (see `cubicBezierArray` below) so Svelte can apply it per-frame.
// ---------------------------------------------------------------------------
export const tweens = {
  cardDraw:    { duration: duration.medium, easing: null /* set at call site */ },
  cardFlip:    { duration: duration.long,   easing: null },
  panelOpen:   { duration: duration.medium, easing: null },
  panelClose:  { duration: duration.short,  easing: null },
  scoreCount:  { duration: duration.long,   easing: null },
};

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Convert a [x1, y1, x2, y2] cubic-bezier array into a `t => number` easing
 * function usable by Svelte's `tweened()` and the Web Animations API.
 *
 * Implements the canonical cubic-bezier solver used by browsers. Returns a
 * function that maps input progress t ∈ [0,1] to output progress ∈ ℝ (may
 * overshoot when control points are outside [0,1]).
 *
 * @param {[number,number,number,number]} bez
 * @returns {(t: number) => number}
 */
export function cubicBezierArray([p1x, p1y, p2x, p2y]) {
  // Gauss-Legendre 4-point integration for the parametric x(t) lookup, then
  // a few Newton-Raphson iterations to refine. Lightweight and good enough
  // for visual work; error < 1e-4 which is invisible at 60fps.
  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;

  const sampleCurveX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleCurveY = (t) => ((ay * t + by) * t + cy) * t;
  const sampleCurveDerivativeX = (t) => (3 * ax * t + 2 * bx) * t + cx;

  const solveCurveX = (x) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const currentX = sampleCurveX(t) - x;
      if (Math.abs(currentX) < 1e-6) return t;
      const d = sampleCurveDerivativeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= currentX / d;
    }
    // Fallback: bisection
    let lo = 0, hi = 1;
    t = x;
    while (lo < hi) {
      const x2 = sampleCurveX(t);
      if (Math.abs(x2 - x) < 1e-6) return t;
      if (x > x2) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };

  return (t) => t <= 0 ? 0 : t >= 1 ? 1 : sampleCurveY(solveCurveX(t));
}

/**
 * Build a ready-to-use tweened() config for a named easing.
 *
 * @example
 *   import { tweened } from 'svelte/motion';
 *   import { tweenConfig, easing } from '$lib/anim/easing';
 *   const flip = tweened(0, tweenConfig('cardFlip', easing.reveal));
 */
export function tweenConfig(name, bez) {
  const base = tweens[name] ?? { duration: duration.medium };
  return { duration: base.duration, easing: cubicBezierArray(bez ?? easing.juicy) };
}

/**
 * CSS transition shorthand string for a given easing + duration.
 * Useful inside Svelte <style> blocks:
 *   transform: translateZ(0);
 *   transition: ${transition('transform', 'juicy', 'medium')};
 *
 * @param {string} prop     CSS property name (e.g. 'transform', 'opacity')
 * @param {keyof typeof easing} [curve='juicy']
 * @param {keyof typeof duration} [time='medium']
 */
export function transition(prop, curve = 'juicy', time = 'medium') {
  return `${prop} ${duration[time]}ms ${cssEasing[curve]}`;
}

// ---------------------------------------------------------------------------
// CSS 3D CARD TRANSFORM CONSTANTS
// ---------------------------------------------------------------------------
// Centralised so every card component uses the same perspective and face
// rotation. Keeping these in one file means a visual re-tune touches one place.
// ---------------------------------------------------------------------------
export const card3d = {
  // Perspective on the parent (hand / table) wrapper. Lower = more dramatic
  // foreshortening. 1200px reads as "cards have real depth but aren't a funhouse".
  perspective: 1200,
  // How far a hovered card lifts toward the camera (translateZ, px).
  hoverLiftZ: 60,
  // Card flip uses rotateY. Front face starts at 0deg, back at 180deg.
  flipBackRotation: 180,
  // Tilt (deg) applied to a hovered card based on cursor X/Y position.
  hoverTiltMax: 12,
  // Squash factor applied on card-land: scaleY 0.9 / scaleX 1.08 for ~80ms.
  landSquashY: 0.9,
  landSquashX: 1.08,
};

// ---------------------------------------------------------------------------
// SCREEN-SHAKE PRESETS
// ---------------------------------------------------------------------------
// Each preset = { intensity: px translate max, decay: 0..1, durationMs }.
// Apply by tweening a `{x, y}` spring and feeding random impulses within
// `intensity` until time elapses; `decay` shrinks each successive impulse.
// ---------------------------------------------------------------------------
export const shakePresets = {
  // Subtle: a single card lands on the table.
  cardDrop:    { intensity: 4,  decay: 0.6, durationMs: duration.screenShake },
  // Medium: czar selects the winning card.
  cardSelect:  { intensity: 7,  decay: 0.5, durationMs: 320 },
  // Big: round winner is revealed.
  winnerReveal:{ intensity: 12, decay: 0.45, durationMs: 480 },
};

export default {
  easing,
  cssEasing,
  duration,
  springs,
  tweens,
  card3d,
  shakePresets,
  cubicBezierArray,
  tweenConfig,
  transition,
};
