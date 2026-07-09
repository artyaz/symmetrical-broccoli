<script>
  // BlackCard.svelte — The "prompt" card. Drives the round.
  // Animations:
  //   - On reveal: card flies in from above with rotation + settles with a
  //     "thunk" (overshoot on Y rotation = juicy).
  //   - On phase change (prompt → playing → reveal): subtle pulse to draw
  //     the eye back to it.
  //   - On winner reveal: card glows + lifts.

  import { onMount } from 'svelte';
  import { cssEase } from '../anim/easing-helpers.js';

  let {
    text = '',
    pick = 1,
    phase = 'prompt',
  } = $props();

  let entered = $state(false);

  onMount(() => {
    // Stagger the entry so the page can paint the empty table first, then
    // the card "drops in". 80ms feels like anticipation.
    const t = setTimeout(() => (entered = true), 80);
    return () => clearTimeout(t);
  });

  // Re-trigger entry animation whenever the text changes (new round).
  $effect(() => {
    if (entered) {
      // Trigger a re-drop when text changes.
      const _text = text;
      const el = document.querySelector('.black-card-inner');
      if (el) {
        el.classList.remove('reenter');
        void el.offsetWidth; // force reflow
        el.classList.add('reenter');
      }
    }
  });

  // Build the displayed text: CAH black cards use ___ as a single blank but
  // may have multiple blanks for pick > 1. Render as a uniform underscore
  // glyph so the prompt reads naturally.
  const display = $derived(text.replace(/___/g, '_____'));
</script>

<div class="black-card" class:entered data-phase={phase}>
  <div class="black-card-inner">
    <p class="text">{display}</p>
    <div class="footer">
      <span class="pick">Pick {pick}</span>
      <span class="mark">broccoli.</span>
    </div>
  </div>
  <div class="shadow" aria-hidden="true"></div>
</div>

<style>
  .black-card {
    position: relative;
    width: 200px;
    height: 280px;
    perspective: 1100px;
    transform-style: preserve-3d;
  }
  .black-card-inner {
    position: absolute;
    inset: 0;
    background: var(--card-b);
    color: var(--ink);
    border-radius: 10px;
    padding: 18px 18px 16px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    transform: translateY(-60vh) rotateZ(-12deg) scale(0.7);
    opacity: 0;
    will-change: transform, opacity;
    box-shadow: 0 30px 80px -20px rgba(0, 0, 0, 0.9);
  }
  .entered .black-card-inner {
    animation: dropin 760ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  @keyframes dropin {
    0%   { transform: translateY(-60vh) rotateZ(-12deg) scale(0.7); opacity: 0; }
    60%  { transform: translateY(8px)   rotateZ(2deg)   scale(1.04); opacity: 1; }
    78%  { transform: translateY(-4px)  rotateZ(-1deg)  scale(0.99); }
    100% { transform: translateY(0)     rotateZ(0)      scale(1); opacity: 1; }
  }
  .text {
    margin: 0;
    font-size: 19px;
    line-height: 1.3;
    font-weight: 600;
    letter-spacing: -0.01em;
    word-break: break-word;
  }
  .footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 9px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: #888;
  }
  .pick {
    color: var(--ink);
    font-weight: 700;
  }
  .mark {
    opacity: 0.7;
  }
  /* Soft floor shadow that follows the card. Scales independently so it
     looks like the card is closer to the table when it lands. */
  .shadow {
    position: absolute;
    left: 6%;
    right: 6%;
    bottom: -18px;
    height: 18px;
    background: radial-gradient(ellipse at center, rgba(0, 0, 0, 0.55), transparent 70%);
    border-radius: 50%;
    opacity: 0;
    filter: blur(4px);
    transform: scale(0.5);
  }
  .entered .shadow {
    animation: shadowdrop 760ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
  }
  @keyframes shadowdrop {
    0%   { opacity: 0; transform: scale(0.4); }
    60%  { opacity: 0.4; transform: scale(1.05); }
    100% { opacity: 0.7; transform: scale(1); }
  }
  /* Phase-driven subtle pulse. The black card is the focal point — give it a
     slow breath so the eye keeps coming back. */
  .black-card[data-phase='prompt'] .black-card-inner,
  .black-card[data-phase='playing'] .black-card-inner {
    animation: dropin 760ms cubic-bezier(0.16, 1, 0.3, 1) forwards,
               breath 5.5s cubic-bezier(0.45, 0, 0.55, 1) infinite 800ms;
  }
  @keyframes breath {
    0%, 100% { box-shadow: 0 30px 80px -20px rgba(0, 0, 0, 0.9); }
    50%      { box-shadow: 0 30px 100px -16px rgba(0, 0, 0, 1), 0 0 0 1px rgba(255,255,255,0.04); }
  }
  @media (prefers-reduced-motion: reduce) {
    .black-card-inner, .shadow { animation: none !important; transform: none !important; opacity: 1 !important; }
  }
  /* Mobile / portrait phone — shrink the black card so it doesn't dominate
     the table on a small screen. 140×196 keeps the same 5:7 aspect ratio as
     the desktop 200×280 and matches the visual weight of the (also shrunk)
     white submission cards. */
  @media (max-width: 640px) {
    .black-card {
      width: 140px;
      height: 196px;
    }
    .black-card-inner {
      padding: 12px 12px 12px;
    }
    .text {
      font-size: 14px;
      line-height: 1.28;
    }
    .footer {
      font-size: 8px;
      letter-spacing: 0.16em;
    }
  }
</style>
