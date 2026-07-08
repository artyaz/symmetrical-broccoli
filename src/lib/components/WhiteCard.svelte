<script>
  // WhiteCard.svelte — A single white answer card with full 3D hover, lift,
  // tilt-toward-cursor, select pulse, and play-fly animations.
  //
  // Design notes (see docs/ANIMATION_GUIDE.md):
  //   - Minimal surface: pure white card, single line of black text, tiny
  //     corner mark. No gradients, no borders, no shadows at rest.
  //   - On hover: card lifts along Z axis (translateZ), tilts toward cursor
  //     using rotateX/rotateY derived from pointer position. This is the
  //     "kinetic depth" trick that makes flat cards feel 3D.
  //   - On select: 1.06× scale + ring glow + brief shake (the "thunk").
  //   - On play: parent coordinates fly the card to the centre; this
  //     component just emits the event and lets the Game view choreograph.

  import { spring } from 'svelte/motion';
  import { cssEase, springs } from '../anim/easing-helpers.js';

  let {
    text = '',
    index = 0,           // position in hand
    total = 1,           // hand size (for fanning)
    selected = false,
    disabled = false,
    revealed = false,    // shown face-up to everyone (czar reveal)
    pick = 1,            // # of cards this submission needs (for display)
    onselect = () => {},
    onhover = () => {},
  } = $props();

  // Pointer-driven tilt. Two springs: one for X rotation (tilt up/down), one
  // for Y (tilt left/right). Springy so it feels alive.
  const tiltX = spring(0, springs.cardHover);
  const tiltY = spring(0, springs.cardHover);
  const liftZ = spring(0, springs.cardHover);
  const selPulse = spring(0, springs.cardSelect);

  let cardEl;

  function onMove(e) {
    if (disabled) return;
    const r = cardEl.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;   // 0..1
    const py = (e.clientY - r.top) / r.height;   // 0..1
    // Tilt range: ±8 degrees. Pointer-right → negative Y rotation (top tilts right).
    tiltY.set((px - 0.5) * -16);
    tiltX.set((py - 0.5) * 14);
    liftZ.set(36);
    onhover({ index, text });
  }

  function onLeave() {
    tiltX.set(0);
    tiltY.set(0);
    liftZ.set(0);
    onhover({ index: null });
  }

  function onTap() {
    if (disabled) return;
    // Selection pulse — a quick 1 → 0 spring that drives a scale pop.
    selPulse.set(1);
    setTimeout(() => selPulse.set(0), 60);
    onselect({ index, text });
  }

  // Compose the 3D transform. Order matters: scale first, then rotate, then
  // translate. translateZ must come AFTER rotate so the card pops forward.
  const transform = $derived(
    `perspective(1100px) rotateX(${$tiltX}deg) rotateY(${$tiltY}deg) translateZ(${$liftZ}px) scale(${1 + $selPulse * 0.06})`,
  );

  // Fan layout: cards in hand arc gently. Each card's rotation is derived
  // from its position in the hand. This is a hint; the parent Hand.svelte
  // also positions cards, but we apply a small extra Z rotation here for
  // the "fanned cards" feel.
  const fanAngle = $derived(
    total > 1 ? ((index - (total - 1) / 2) / Math.max(1, total - 1)) * 8 : 0,
  );
</script>

<div
  class="card-wrap"
  style="--fan: {fanAngle}deg;"
  role="button"
  tabindex="0"
  aria-label="White card: {text}"
  aria-pressed={selected}
  aria-disabled={disabled}
  bind:this={cardEl}
  onpointermove={onMove}
  onpointerleave={onLeave}
  onclick={onTap}
  onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && onTap()}
  data-selected={selected}
  data-disabled={disabled}
  data-revealed={revealed}
>
  <div class="card" style="transform: {transform};">
    <div class="face front">
      <p class="text">{text}</p>
      <span class="mark">broccoli.</span>
    </div>
  </div>
  {#if selected}
    <div class="ring" aria-hidden="true"></div>
  {/if}
</div>

<style>
  .card-wrap {
    position: relative;
    width: 130px;
    height: 184px;
    cursor: pointer;
    transform-style: preserve-3d;
    transform: rotateZ(var(--fan));
    transition: transform 320ms cubic-bezier(0.22, 1, 0.36, 1);
    will-change: transform;
    outline: none;
  }
  .card-wrap[data-disabled='true'] {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .card-wrap[data-selected='true'] {
    z-index: 10;
  }
  .card {
    position: absolute;
    inset: 0;
    background: var(--card-w);
    color: #0a0a0a;
    border-radius: 8px;
    transform-style: preserve-3d;
    backface-visibility: hidden;
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.4);
    transition: box-shadow 220ms cubic-bezier(0.22, 1, 0.36, 1);
    will-change: transform;
  }
  .card-wrap:hover .card {
    box-shadow:
      0 18px 40px -10px rgba(0, 0, 0, 0.7),
      0 0 0 1px rgba(255, 255, 255, 0.06);
  }
  .card-wrap[data-selected='true'] .card {
    box-shadow:
      0 22px 50px -8px rgba(0, 0, 0, 0.85),
      0 0 0 2px var(--ink);
  }
  .face {
    position: absolute;
    inset: 0;
    padding: 14px 14px 28px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    backface-visibility: hidden;
  }
  .text {
    margin: 0;
    font-size: 13px;
    line-height: 1.32;
    font-weight: 600;
    letter-spacing: -0.01em;
    word-break: break-word;
    hyphens: auto;
  }
  .mark {
    font-size: 8px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #888;
    align-self: flex-start;
  }
  /* Select ring — a soft halo that pulses in when selected. */
  .ring {
    position: absolute;
    inset: -4px;
    border-radius: 12px;
    pointer-events: none;
    box-shadow: 0 0 0 2px var(--ink), 0 0 28px 4px rgba(250, 250, 250, 0.22);
    animation: ringpulse 720ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  @keyframes ringpulse {
    0% { transform: scale(0.92); opacity: 0; }
    50% { opacity: 1; }
    100% { transform: scale(1); opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .card-wrap, .card, .ring { transition: none !important; animation: none !important; }
  }
</style>
