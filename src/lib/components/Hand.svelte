<script>
  // Hand.svelte — Player's hand of white cards, arranged in a gentle fan.
  // The fan recomputes whenever the hand size changes; cards glide to their
  // new positions using a Svelte spring.
  //
  // Interaction:
  //   - Hover lifts a card (handled inside WhiteCard.svelte).
  //   - This component reports hover index upward so neighbors can "make
  //     room" by spreading slightly.
  //   - Click selects. Selected cards lift higher and gain a ring.
  //   - When pick count is reached, "Play" button activates.

  import WhiteCard from './WhiteCard.svelte';

  let {
    cards = [],
    selected = [],         // array of card text strings
    pick = 1,
    disabled = false,
    onselect = () => {},
    onplay = () => {},
  } = $props();

  let hovered = $state(null);

  function handleSelect({ text }) {
    if (disabled) return;
    let next;
    if (selected.includes(text)) {
      next = selected.filter((t) => t !== text);
    } else {
      if (selected.length >= pick) {
        // Replace oldest selection.
        next = [...selected.slice(1), text];
      } else {
        next = [...selected, text];
      }
    }
    onselect(next);
  }

  // Computed: are we ready to play?
  const canPlay = $derived(selected.length === pick && !disabled);
</script>

<div class="hand" data-disabled={disabled}>
  <div class="fan">
    {#each cards as text, i (i + ':' + text)}
      <div
        class="slot"
        style="
          --i: {i};
          --n: {cards.length};
          --spread: {hovered === i ? 1.05 : 1};
        "
      >
        <WhiteCard
          {text}
          index={i}
          total={cards.length}
          selected={selected.includes(text)}
          {disabled}
          onselect={() => handleSelect({ text })}
          onhover={({ index }) => (hovered = index)}
        />
      </div>
    {/each}
  </div>

  {#if !disabled}
    <div class="play-row" class:show={canPlay}>
      <button class="play-btn" disabled={!canPlay} onclick={onplay}>
        Play {pick > 1 ? `${pick} cards` : 'card'}
      </button>
    </div>
  {/if}
</div>

<style>
  .hand {
    position: relative;
    padding-bottom: 14px;
  }
  .fan {
    position: relative;
    display: flex;
    justify-content: center;
    align-items: flex-end;
    gap: 4px;
    min-height: 200px;
    padding: 0 8px;
    /* `--fan-deg` controls the per-card rotation of the fan arc. Overridden
       on small screens so the fan lays flatter (1.5deg vs 3deg) — a tighter
       arc keeps 7-10 small cards from overlapping on a phone. */
    --fan-deg: 3deg;
  }
  .slot {
    transform-origin: 50% 130%;
    transition: transform 360ms cubic-bezier(0.22, 1, 0.36, 1), margin 360ms cubic-bezier(0.22, 1, 0.36, 1);
    will-change: transform;
  }
  /* Subtle fan: each card rotated by its position. */
  .slot[style*='--i:'] {
    /* The actual fan rotation is applied via CSS custom property below. */
  }
  /* We compute the rotation in CSS using the --i and --n custom properties.
     calc() can't do trigonometry, but a small linear rotation per index
     produces a believable arc for hands of 5-10 cards. */
  .slot {
    transform:
      rotateZ(calc((var(--i) - (var(--n) - 1) / 2) * var(--fan-deg)))
      translateY(calc((var(--i) - (var(--n) - 1) / 2) * (var(--i) - (var(--n) - 1) / 2) * -3px));
  }
  /* When a slot is hovered (via the parent state), nudge its neighbors. */
  .fan:hover .slot {
    margin: 0 calc((var(--spread) - 1) * 2px);
  }
  .play-row {
    position: absolute;
    bottom: -52px;
    left: 0;
    right: 0;
    display: flex;
    justify-content: center;
    opacity: 0;
    transform: translateY(8px);
    transition: opacity 240ms cubic-bezier(0.22, 1, 0.36, 1), transform 240ms cubic-bezier(0.22, 1, 0.36, 1);
    pointer-events: none;
  }
  .play-row.show {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
  }
  .play-btn {
    background: var(--ink);
    color: var(--bg);
    border: none;
    border-radius: 999px;
    padding: 10px 22px;
    font-family: var(--font);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
    transition: transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 180ms ease;
  }
  .play-btn:not(:disabled):hover {
    transform: scale(1.04);
    box-shadow: 0 8px 24px -4px rgba(250, 250, 250, 0.4);
  }
  .play-btn:not(:disabled):active {
    transform: scale(0.96);
  }
  .play-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }
  @media (prefers-reduced-motion: reduce) {
    .slot, .play-row, .play-btn { transition: none !important; }
  }
  /* Mobile — flatter fan arc, tighter gaps, shorter play row so the hand
     doesn't push the table out of view on a small portrait screen. */
  @media (max-width: 640px) {
    .fan {
      --fan-deg: 1.5deg;
      gap: 2px;
      min-height: 150px;
      padding: 0 4px;
    }
    .play-row {
      bottom: -46px;
    }
    .play-btn {
      padding: 9px 18px;
      font-size: 12px;
    }
  }
</style>
