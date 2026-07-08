<script>
  // Table.svelte — The "table" in the middle of the screen.
  // Renders:
  //   - The black card (always visible during play)
  //   - Submitted white cards (face-down stack during PLAYING, then revealed
  //     one-by-one during REVEAL phase with a dramatic 3D flip)
  //   - Vote indicators during VOTING phase
  //   - Winner spotlight during SCORING phase
  //
  // All animations here are GPU-friendly (transform + opacity only) and use
  // the easing curves from easing-helpers.js.

  import { onMount } from 'svelte';
  import BlackCard from './BlackCard.svelte';
  import { cssEase } from '../anim/easing-helpers.js';

  let {
    blackCard = null,
    submissions = [],
    revealedIndex = -1,
    phase = 'prompt',
    votes = {},
    votingMode = 'czar',
    winnerId = null,
    players = [],
    czarId = null,
    myId = null,
    onrevealnext = () => {},
    onvote = () => {},
    onczarpick = () => {},
    onnextround = () => {},
  } = $props();

  // Player lookup by id.
  const playerById = $derived(Object.fromEntries(players.map((p) => [p.id, p])));
  const isCzar = $derived(myId === czarId);
  const allRevealed = $derived(revealedIndex >= submissions.length - 1 && phase === 'voting');
  const winner = $derived(winnerId ? playerById[winnerId] : null);

  // Count votes per submission index.
  const voteCounts = $derived.by(() => {
    const counts = new Array(submissions.length).fill(0);
    for (const idx of Object.values(votes)) {
      if (typeof idx === 'number' && idx >= 0 && idx < counts.length) counts[idx]++;
    }
    return counts;
  });
</script>

<div class="table" data-phase={phase}>
  {#if blackCard}
    <div class="black-slot">
      <BlackCard text={blackCard.text} pick={blackCard.pick} {phase} />
    </div>
  {:else}
    <div class="placeholder">waiting for first card…</div>
  {/if}

  {#if submissions.length > 0}
    <div class="submissions">
      {#each submissions as sub, i (i)}
        <div
          class="sub"
          data-revealed={i <= revealedIndex || phase === 'voting' || phase === 'scoring'}
          data-current={i === revealedIndex && phase === 'reveal'}
          data-winner={winnerId && sub.playerId === winnerId}
          style="--i: {i};"
        >
          {#if sub.cards.length === 1}
            <button
              class="sub-card single"
              onclick={() => phase === 'voting' && (isCzar ? onczarpick(i) : votingMode === 'open' && onvote(i))}
              disabled={phase !== 'voting'}
            >
              <div class="face front">{sub.cards[0]}</div>
              <div class="face back">
                <span class="back-mark">broccoli.</span>
                <span class="back-num">{i + 1}</span>
              </div>
            </button>
          {:else}
            <!-- Multi-card submission: stack with slight offset -->
            <div class="multi">
              {#each sub.cards as c, j (j)}
                <button
                  class="sub-card"
                  style="--j: {j};"
                  onclick={() => phase === 'voting' && (isCzar ? onczarpick(i) : votingMode === 'open' && onvote(i))}
                  disabled={phase !== 'voting'}
                >
                  <div class="face front">{c}</div>
                  <div class="face back">
                    <span class="back-mark">broccoli.</span>
                    <span class="back-num">{i + 1}</span>
                  </div>
                </button>
              {/each}
            </div>
          {/if}

          {#if phase === 'voting' && (i <= revealedIndex || phase === 'voting')}
            <div class="vote-count" aria-hidden="true">×{voteCounts[i]}</div>
          {/if}

          {#if winnerId && sub.playerId === winnerId}
            <div class="winner-glow" aria-hidden="true"></div>
            <div class="winner-tag">winner · {playerById[sub.playerId]?.name || '?'}</div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if phase === 'reveal' && isCzar}
    <button class="reveal-next" onclick={onrevealnext}>
      {revealedIndex < submissions.length - 1 ? 'reveal next' : 'open voting'}
    </button>
  {/if}

  {#if phase === 'scoring' && isCzar}
    <button class="reveal-next" onclick={onnextround}>next round →</button>
  {/if}

  {#if phase === 'voting'}
    <p class="hint">
      {#if isCzar}
        tap a card to pick the winner
      {:else if votingMode === 'open'}
        tap a card to vote
      {:else}
        czar is choosing…
      {/if}
    </p>
  {/if}
</div>

<style>
  .table {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 28px;
    padding: 24px;
    min-height: 0;
  }
  .black-slot {
    perspective: 1100px;
    transform-style: preserve-3d;
  }
  .placeholder {
    color: var(--ink-dim);
    font-size: 14px;
    font-style: italic;
  }
  .submissions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 14px;
    max-width: 90vw;
    perspective: 1400px;
    transform-style: preserve-3d;
  }
  .sub {
    position: relative;
    transform-style: preserve-3d;
    animation: subenter 540ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
    animation-delay: calc(var(--i) * 90ms);
  }
  @keyframes subenter {
    0%   { transform: translateY(80px) scale(0.6) rotateZ(-8deg); opacity: 0; }
    100% { transform: translateY(0) scale(1) rotateZ(0); opacity: 1; }
  }
  .sub-card {
    position: relative;
    width: 130px;
    height: 184px;
    background: transparent;
    border: none;
    padding: 0;
    cursor: default;
    transform-style: preserve-3d;
    transition: transform 460ms cubic-bezier(0.16, 1, 0.3, 1), filter 240ms ease;
    will-change: transform;
  }
  .sub-card:enabled {
    cursor: pointer;
  }
  .sub-card:enabled:hover {
    transform: translateY(-10px) scale(1.04);
    filter: drop-shadow(0 18px 30px rgba(0, 0, 0, 0.6));
  }
  .sub[data-current='true'] .sub-card {
    transform: translateY(-14px) scale(1.06);
    filter: drop-shadow(0 24px 40px rgba(0, 0, 0, 0.7));
  }
  .sub[data-winner='true'] .sub-card {
    transform: translateY(-20px) scale(1.12) rotateZ(0deg);
    filter: drop-shadow(0 28px 50px rgba(255, 255, 255, 0.25));
    animation: winnerpulse 1400ms cubic-bezier(0.34, 1.56, 0.64, 1) infinite alternate;
  }
  @keyframes winnerpulse {
    0%   { transform: translateY(-20px) scale(1.12) rotateZ(-1deg); }
    100% { transform: translateY(-26px) scale(1.16) rotateZ(1deg); }
  }
  .face {
    position: absolute;
    inset: 0;
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
    border-radius: 8px;
    padding: 14px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.32;
    word-break: break-word;
  }
  .face.front {
    background: var(--card-w);
    color: #0a0a0a;
    /* Cards start face-down. Flip on reveal. */
    transform: rotateY(180deg);
  }
  .face.back {
    background: #141414;
    color: var(--ink-dim);
    border: 1px solid var(--line);
    align-items: center;
    justify-content: center;
    text-align: center;
    transform: rotateY(0deg);
  }
  .back-mark {
    font-size: 9px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    opacity: 0.5;
  }
  .back-num {
    font-size: 48px;
    font-weight: 800;
    color: var(--ink);
    letter-spacing: -0.05em;
  }
  .sub[data-revealed='true'] .face.front {
    transform: rotateY(0deg);
  }
  .sub[data-revealed='true'] .face.back {
    transform: rotateY(180deg);
  }
  .sub-card {
    transition: transform 460ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .sub[data-revealed='true'] .sub-card {
    transition: transform 760ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  /* Multi-card submissions: stack with offset. */
  .multi {
    position: relative;
    width: 130px;
    height: 184px;
    transform-style: preserve-3d;
  }
  .multi .sub-card {
    position: absolute;
    inset: 0;
    transform: translateX(calc(var(--j) * 24px));
  }
  .multi .sub-card:enabled:hover {
    transform: translateX(calc(var(--j) * 24px)) translateY(-10px) scale(1.04);
  }
  .vote-count {
    position: absolute;
    top: -10px;
    right: -10px;
    background: var(--ink);
    color: var(--bg);
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 11px;
    font-weight: 800;
    z-index: 5;
    animation: votein 320ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  @keyframes votein {
    0% { transform: scale(0); opacity: 0; }
    100% { transform: scale(1); opacity: 1; }
  }
  .winner-glow {
    position: absolute;
    inset: -30px;
    background: radial-gradient(ellipse at center, rgba(255, 255, 255, 0.18), transparent 65%);
    pointer-events: none;
    animation: glowpulse 1.6s cubic-bezier(0.45, 0, 0.55, 1) infinite;
    z-index: -1;
  }
  @keyframes glowpulse {
    0%, 100% { opacity: 0.5; transform: scale(1); }
    50% { opacity: 1; transform: scale(1.1); }
  }
  .winner-tag {
    position: absolute;
    top: -36px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--ink);
    color: var(--bg);
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
    animation: tagin 480ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  @keyframes tagin {
    0% { transform: translateX(-50%) translateY(10px) scale(0.6); opacity: 0; }
    100% { transform: translateX(-50%) translateY(0) scale(1); opacity: 1; }
  }
  .reveal-next {
    background: var(--ink);
    color: var(--bg);
    border: none;
    border-radius: 999px;
    padding: 12px 22px;
    font-family: var(--font);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
    transition: transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .reveal-next:hover { transform: scale(1.04); }
  .reveal-next:active { transform: scale(0.96); }
  .hint {
    color: var(--ink-dim);
    font-size: 12px;
    margin: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .sub, .sub-card, .winner-glow, .winner-tag, .vote-count { animation: none !important; transition: none !important; }
  }
</style>
