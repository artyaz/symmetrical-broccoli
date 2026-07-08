<script>
  // Lobby.svelte — Pre-game room. Host configures packs + target score;
  // players see who's joined. Real-time updates via game store.
  import { onMount, onDestroy } from 'svelte';
  import { navigate } from '../router.js';
  import { game, actions, amHost } from '../stores/game.js';
  import { session } from '../stores/session.js';
  import { PACKS, loadPack } from '../data/packs/index.js';

  let { params = [] } = $props();
  let roomCode = $derived(params[0] || '');
  let packsLoading = $state(false);
  let showPackList = $state(false);
  let unsubGame;

  onMount(() => {
    // If the game store ever transitions out of lobby, jump to /game.
    unsubGame = game.subscribe((s) => {
      if (s.phase && s.phase !== 'lobby' && s.roomCode === roomCode) {
        navigate(`/game/${roomCode}`, { withTransition: true });
      }
    });
  });
  onDestroy(() => unsubGame?.());

  const me = $derived($session?.peerId);
  const isHost = $derived(amHost());
  const players = $derived($game.players);

  async function addPack(slug) {
    packsLoading = true;
    try {
      const p = await loadPack(slug);
      actions.addPack(slug, p.name);
    } finally {
      packsLoading = false;
    }
  }
  function removePack(slug) { actions.removePack(slug); }
  function start() { actions.startGame(); }
  function leave() { navigate('/'); }

  // Compute selected pack names for display.
  const selectedPacks = $derived(
    $game.packs.map((slug, i) => ({ slug, name: $game.packNames[i] || slug }))
  );

  // Available packs: official first, then unofficial. Excluded already-selected.
  const availablePacks = $derived(
    PACKS
      .filter((p) => !$game.packs.includes(p.slug))
      .filter((p) => p.official)
      .slice(0, 50)
  );
</script>

<main class="lobby">
  <header>
    <button class="back" onclick={leave}>← leave</button>
    <div class="code-pill">
      <span class="label">room code</span>
      <span class="code">{roomCode}</span>
      <button class="copy" onclick={() => navigator.clipboard?.writeText(roomCode)}>copy</button>
    </div>
  </header>

  <section class="grid">
    <div class="players">
      <h3>players · {players.length}</h3>
      <ul>
        {#each players as p (p.id)}
          <li class:me={p.id === me} class:host={p.isHost}>
            <span class="dot" class:online={p.connected !== false}></span>
            <span class="name">{p.name}</span>
            {#if p.isHost}<span class="tag">host</span>{/if}
          </li>
        {/each}
        {#if players.length < 2}
          <li class="hint">need at least 2 players to start</li>
        {/if}
      </ul>
    </div>

    <div class="setup">
      <h3>setup</h3>
      <div class="row">
        <span class="row-label">play to</span>
        <div class="seg">
          {#each [3, 5, 8, 12] as n (n)}
            <button class:active={$game.targetScore === n} onclick={() => actions.setTargetScore(n)}>{n}</button>
          {/each}
        </div>
      </div>
      <div class="row">
        <span class="row-label">voting</span>
        <div class="seg">
          <button class:active={$game.votingMode === 'czar'} onclick={() => actions.setVotingMode('czar')}>czar picks</button>
          <button class:active={$game.votingMode === 'open'} onclick={() => actions.setVotingMode('open')}>everyone votes</button>
        </div>
      </div>

      <div class="packs">
        <div class="packs-head">
          <h4>packs · {$game.packs.length}</h4>
          <button class="toggle" onclick={() => (showPackList = !showPackList)}>
            {showPackList ? 'hide' : 'add packs'}
          </button>
        </div>
        <div class="selected-packs">
          {#each selectedPacks as p (p.slug)}
            <span class="chip">
              {p.name}
              {#if isHost}
                <button class="x" onclick={() => removePack(p.slug)} aria-label="remove">×</button>
              {/if}
            </span>
          {/each}
        </div>

        {#if showPackList && isHost}
          <ul class="pack-list">
            {#each availablePacks as p (p.slug)}
              <li>
                <button class="pack-item" onclick={() => addPack(p.slug)} disabled={packsLoading}>
                  <span class="pn">{p.name}</span>
                  <span class="pm">{p.white}w · {p.black}b{p.year ? ` · ${p.year}` : ''}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      {#if isHost}
        <button class="start" onclick={start} disabled={players.length < 2}>
          start game
        </button>
      {:else}
        <p class="wait">waiting for host to start…</p>
      {/if}
    </div>
  </section>
</main>

<style>
  .lobby {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 18px;
    gap: 24px;
    min-height: 100vh;
    min-height: 100dvh;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .back {
    background: transparent;
    border: none;
    color: var(--ink-dim);
    font-family: var(--font);
    font-size: 13px;
    cursor: pointer;
  }
  .back:hover { color: var(--ink); }
  .code-pill {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px 6px 14px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.04);
  }
  .label {
    font-size: 10px;
    color: var(--ink-dim);
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }
  .code {
    font-size: 16px;
    font-weight: 800;
    letter-spacing: 0.32em;
  }
  .copy {
    background: var(--ink);
    color: var(--bg);
    border: none;
    border-radius: 999px;
    padding: 4px 10px;
    font-family: var(--font);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    cursor: pointer;
  }
  .grid {
    flex: 1;
    display: grid;
    grid-template-columns: 1fr 1.4fr;
    gap: 18px;
    min-height: 0;
  }
  @media (max-width: 720px) {
    .grid { grid-template-columns: 1fr; }
  }
  .players, .setup {
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 18px;
    background: rgba(255, 255, 255, 0.02);
  }
  h3 {
    margin: 0 0 14px;
    font-size: 11px;
    color: var(--ink-dim);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    font-weight: 600;
  }
  ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 8px;
    font-size: 15px;
  }
  li.me { background: rgba(255, 255, 255, 0.04); }
  li.hint { color: var(--ink-dim); font-size: 12px; font-style: italic; }
  .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #4a4a4a;
    flex-shrink: 0;
  }
  .dot.online { background: #4ade80; }
  .name { flex: 1; }
  .tag {
    font-size: 9px;
    color: var(--ink-dim);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    border: 1px solid var(--line);
    padding: 2px 6px;
    border-radius: 4px;
  }
  .setup { display: flex; flex-direction: column; gap: 18px; }
  .row {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row > .row-label {
    font-size: 11px;
    color: var(--ink-dim);
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }
  .seg {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .seg button {
    background: transparent;
    border: 1px solid var(--line);
    color: var(--ink);
    font-family: var(--font);
    font-size: 12px;
    padding: 8px 12px;
    border-radius: 8px;
    cursor: pointer;
    transition: all 180ms ease;
  }
  .seg button.active {
    background: var(--ink);
    color: var(--bg);
    border-color: var(--ink);
  }
  .packs-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h4 {
    margin: 0;
    font-size: 11px;
    color: var(--ink-dim);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .toggle {
    background: transparent;
    border: none;
    color: var(--ink);
    font-family: var(--font);
    font-size: 12px;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .selected-packs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 4px 8px 4px 12px;
    font-size: 12px;
  }
  .x {
    background: transparent;
    border: none;
    color: var(--ink-dim);
    font-family: var(--font);
    font-size: 14px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }
  .x:hover { color: var(--ink); }
  .pack-list {
    margin-top: 10px;
    max-height: 220px;
    overflow-y: auto;
    border-top: 1px solid var(--line);
    padding-top: 10px;
  }
  .pack-item {
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    color: var(--ink);
    font-family: var(--font);
    padding: 8px 6px;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    border-radius: 6px;
    transition: background 160ms ease;
  }
  .pack-item:hover { background: rgba(255, 255, 255, 0.05); }
  .pn { font-size: 13px; }
  .pm { font-size: 11px; color: var(--ink-dim); }
  .start {
    margin-top: auto;
    padding: 14px;
    background: var(--ink);
    color: var(--bg);
    border: none;
    border-radius: 10px;
    font-family: var(--font);
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
    transition: transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .start:not(:disabled):hover { transform: scale(1.02); }
  .start:disabled { opacity: 0.4; cursor: not-allowed; }
  .wait {
    margin-top: auto;
    text-align: center;
    color: var(--ink-dim);
    font-size: 12px;
    font-style: italic;
  }
</style>
