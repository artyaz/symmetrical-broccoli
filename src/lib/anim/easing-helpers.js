// easing-helpers.js — Svelte-usable easing functions generated from the
// cubic-bezier arrays in easing.js. Svelte's transitions accept `t => number`
// functions; we pre-compute those here.

import { easing } from './easing.js';

// Newton-Raphson + bisection cubic-bezier solver. Same algorithm as Chromium's
// internal implementation — accurate to ~1e-6. Returns an easing function.
function makeBezier([x1, y1, x2, y2]) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  const sampleDerivativeX = (t) => (3 * ax * t + 2 * bx) * t + cx;

  const SOLVE_EPS = 1e-6;
  return function ease(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    // Solve for t given x=t via Newton-Raphson, fallback to bisection.
    let x = t;
    for (let i = 0; i < 8; i++) {
      const cur = sampleX(x) - t;
      if (Math.abs(cur) < SOLVE_EPS) return sampleY(x);
      const dx = sampleDerivativeX(x);
      if (Math.abs(dx) < SOLVE_EPS) break;
      x -= cur / dx;
    }
    // Bisection fallback.
    let lo = 0;
    let hi = 1;
    x = t;
    for (let i = 0; i < 24; i++) {
      const xv = sampleX(x);
      if (Math.abs(xv - t) < SOLVE_EPS) return sampleY(x);
      if (t > xv) lo = x; else hi = x;
      x = (lo + hi) * 0.5;
    }
    return sampleY(x);
  };
}

export const bezier = {
  juicy: makeBezier(easing.juicy),
  snap: makeBezier(easing.snap),
  settle: makeBezier(easing.settle),
  anticipation: makeBezier(easing.anticipation),
  bounce: makeBezier(easing.bounce),
  whip: makeBezier(easing.whip),
  drop: makeBezier(easing.drop),
  lift: makeBezier(easing.lift),
  easeInOutBack: makeBezier(easing.easeInOutBack),
  reveal: makeBezier(easing.reveal),
  subtleshake: makeBezier(easing.subtleshake),
};

// CSS string versions for use in <style> blocks.
export const cssEase = {
  juicy: `cubic-bezier(${easing.juicy.join(',')})`,
  snap: `cubic-bezier(${easing.snap.join(',')})`,
  settle: `cubic-bezier(${easing.settle.join(',')})`,
  anticipation: `cubic-bezier(${easing.anticipation.join(',')})`,
  bounce: `cubic-bezier(${easing.bounce.join(',')})`,
  whip: `cubic-bezier(${easing.whip.join(',')})`,
  drop: `cubic-bezier(${easing.drop.join(',')})`,
  lift: `cubic-bezier(${easing.lift.join(',')})`,
  easeInOutBack: `cubic-bezier(${easing.easeInOutBack.join(',')})`,
  reveal: `cubic-bezier(${easing.reveal.join(',')})`,
  subtleshake: `cubic-bezier(${easing.subtleshake.join(',')})`,
};

// Svelte `spring()` config objects — spread directly into spring().
export { springs } from './easing.js';
