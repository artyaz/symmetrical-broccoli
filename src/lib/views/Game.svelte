<script>
  // Game.svelte — The main game screen. Orchestrates BlackCard, Table, Hand,
  // player roster, and round/phase state.
  //
  // Layout (3 layers):
  //   - Top bar: room code, round, players roster, leave button.
  //   - Center: Table (black card + submissions + reveal/voting controls).
  //   - Bottom: My hand of white cards + play button (when picking).
  //
  // The Game view is reactive to the `game` store. As the host broadcasts
  // state changes, this view updates automatically with animations driven
  // by CSS transitions on the inner components.

  import { onMount, onDestroy } from 'svelte';
  import { game, actions, myHand, myId, isCzar, amHost, PHASE } from '../stores/game.js';
  import { session } from '../stores/session.js';
  import { navigate } from '../router.js';
  import { disconnect, connState } from '../net/network.js';
  import { shake, burst, hitStop } from '../anim/juice.js';
  import { play, isMuted, setMuted } from '../anim/audio.js';
  import Table from '../components/Table.svelte';
  import Hand from '../components/Hand.svelte';

  let { params = [] } = $props();
  let roomCode = $derived(params[0] || '');

  let selected = $state([]);
  let unsubConn;

  onMount(() => {
    // If we don't have a session, send the user back to home.
    if (!$session?.roomCode) {
      navigate('/');
      return;
    }
    // Watch connection state — if disconnected, offer to return home.
    unsubConn = connState.subscribe((cs) => {
      if (cs.status === 'closed' && !$game.hostLeft) {
        // Show "host left" overlay rather than auto-navigating away.
      }
    });
  });
  onDestroy(() => unsubConn?.());

  // Derived state from the game store.
  const state = $derived($game);
  const me = $derived(myId());
  const czar = $derived(isCzar($game));
  const host = $derived(amHost());
  const hand = $derived(myHand($game));
  const phase = $derived($game.phase);
  const blackCard = $derived($game.blackCard);
  const submissions = $derived($game.submissions);
  const revealedIndex = $derived($game.revealedIndex);
  const votes = $derived($game.votes);
  const votingMode = $derived($game.votingMode);
  const players = $derived($game.players);
  const czarId = $derived($game.czarId);
  const round = $derived($game.round);
  const targetScore = $derived($game.targetScore);
  const winnerId = $derived(
    $game.phase === PHASE.SCORING || $game.phase === PHASE.ROUNDEND
      ? $game.history[$game.history.length - 1]?.winnerId
      : null
  );
  const gameOverWinner = $derived(
    $game.phase === PHASE.GAMEOVER
      ? $game.players.find((p) => p.score >= $game.targetScore)
      : null
  );

  // Reset selection on phase change away from PROMPT/PLAYING.
  // Use a plain variable + $effect; the read inside $effect is reactive.
  let lastPhase = null;
  $effect(() => {
    const p = phase;
    if (p !== lastPhase) {
      if (p !== PHASE.PROMPT && p !== PHASE.PLAYING) {
        selected = [];
      }
      // Phase-driven juice + audio pairing:
      //   - REVEAL: subtle shake when the first card flips + soft swoosh.
      //   - SCORING: bigger shake + particle burst on winner + triumphant arpeggio.
      if (p === PHASE.REVEAL && lastPhase === PHASE.PLAYING) {
        shake(4, 200);
        hitStop(80);
        play('phaseChange');
      }
      if (p === PHASE.SCORING && lastPhase === PHASE.VOTING) {
        shake(10, 360);
        hitStop(160);
        play('winnerReveal');
        // Burst from screen center — the winner card is rendered there.
        setTimeout(() => {
          burst(window.innerWidth / 2, window.innerHeight / 2, 32, { distancePx: 180, durationMs: 1100 });
        }, 80);
      }
      lastPhase = p;
    }
  });

  // Audio mute toggle state. Initialised from the persisted preference the
  // audio module loaded at import time (handles prefers-reduced-motion and
  // prefers-reduced-data auto-mute too).
  let muted = $state(isMuted());
  function toggleMute() {
    muted = !muted;
    setMuted(muted);
    // Tiny audible confirmation when un-muting so the user knows sound is on.
    if (!muted) play('cardSelect');
  }

  function handleSelect(next) { selected = next; }
  function handlePlay() {
    if (selected.length !== (blackCard?.pick || 1)) return;
    // Small "throw" feedback: brief shake on play + soft thunk.
    shake(3, 160);
    play('cardDrop');
    actions.pickCards(selected);
    selected = [];
  }
  function revealNext() {
    // Each reveal gets a tiny shake — feels like a card being slammed down.
    shake(2, 140);
    actions.revealNext();
  }
  function vote(idx) { actions.vote(idx); }
  function czarPick(idx) { actions.czarPick(idx); }
  function nextRound() { actions.nextRound(); }
  function returnToLobby() {
    actions.returnToLobby();
    navigate(`/lobby/${roomCode}`);
  }
  function leave() {
    disconnect();
    navigate('/');
  }

  // Czar doesn't pick cards; show their hand as informational only.
  const handDisabled = $derived(czar || phase !== PHASE.PROMPT && phase !== PHASE.PLAYING);
</script>

<main class="game" data-phase={phase}>
  <header class="topbar">
    <button class="icon-btn" onclick={leave} aria-label="leave">←</button>
    <div class="room">{roomCode}</div>
    <div class="spacer"></div>
    <div class="round-pill">round {round} · to {targetScore}</div>
    <button
      class="icon-btn mute-btn"
      onclick={toggleMute}
      aria-label={muted ? 'unmute audio' : 'mute audio'}
      aria-pressed={muted}
      title={muted ? 'unmute audio' : 'mute audio'}
    >
      {#if muted}
        <!-- Speaker-off icon: speaker + X. -->
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M5 9v6h4l5 5V4L9 9H5zm12.5 3l2.5-2.5-1-1L16 11l-3-3-1 1 3 3-3 3 1 1 3-3 2.5 2.5 1-1L16.5 12z"/>
        </svg>
      {:else}
        <!-- Speaker-on icon: speaker + sound waves. -->
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M5 9v6h4l5 5V4L9 9H5zm11.5 1.5c1.5 1 1.5 3 0 4l-.7-.7c1-1 1-1.6 0-2.6l.7-.7zM18.5 9c2.5 1.8 2.5 6.2 0 8l-.7-.7c2-1.5 2-5 0-6.6l.7-.7z"/>
        </svg>
      {/if}
    </button>
  </header>

  <section class="roster">
    {#each players as p (p.id)}
      <div
        class="player"
        class:me={p.id === me}
        class:czar={p.id === czarId}
        class:disconnected={p.connected === false}
        data-score-tier={Math.min(3, Math.floor(p.score / Math.max(1, targetScore / 4)))}
      >
        <span class="pscore">{p.score}</span>
        <span class="pname">{p.name}{p.id === me ? ' (you)' : ''}</span>
        {#if p.id === czarId}<span class="czar-tag">czar</span>{/if}
        {#if p.isHost && p.id !== czarId}<span class="host-dot" title="host">•</span>{/if}
      </div>
    {/each}
  </section>

  <section class="center">
    {#if phase === PHASE.LOBBY}
      <div class="phase-msg">waiting in lobby…</div>
    {:else if phase === PHASE.DEALING}
      <div class="phase-msg">shuffling deck…</div>
    {:else if phase === PHASE.GAMEOVER}
      <div class="gameover">
        <h2>{gameOverWinner?.name || 'someone'} wins</h2>
        <p>first to {targetScore} awesome points.</p>
        {#if host}
          <button class="primary" onclick={returnToLobby}>back to lobby</button>
        {:else}
          <p class="muted">host controls the lobby</p>
        {/if}
        <button class="ghost" onclick={leave}>leave</button>
      </div>
    {:else if $game.hostLeft}
      <div class="gameover">
        <h2>host left</h2>
        <p>the room is closed.</p>
        <button class="primary" onclick={leave}>back home</button>
      </div>
    {:else}
      <Table
        {blackCard}
        {submissions}
        {revealedIndex}
        {phase}
        {votes}
        {votingMode}
        {winnerId}
        {players}
        {czarId}
        myId={me}
        onrevealnext={revealNext}
        onvote={vote}
        onczarpick={czarPick}
        onnextround={nextRound}
      />

      {#if phase === PHASE.PROMPT || phase === PHASE.PLAYING}
        <div class="phase-strip">
          {#if czar}
            <span>you are the czar — wait for {players.filter(p => p.id !== czarId).length} player(s) to play</span>
          {:else if selected.length === (blackCard?.pick || 1)}
            <span>ready to play</span>
          {:else}
            <span>pick {blackCard?.pick || 1} card{blackCard?.pick > 1 ? 's' : ''}</span>
          {/if}
        </div>
      {/if}
    {/if}
  </section>

  {#if phase === PHASE.PROMPT || phase === PHASE.PLAYING}
    <section class="hand-zone" class:disabled={handDisabled}>
      {#if !czar}
        <Hand
          cards={hand}
          {selected}
          pick={blackCard?.pick || 1}
          disabled={handDisabled}
          onselect={handleSelect}
          onplay={handlePlay}
        />
      {:else}
        <div class="czar-wait">
          <span>czar mode</span>
          <p>your hand is hidden this round</p>
        </div>
      {/if}
    </section>
  {/if}
</main>

<style>
  .game {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    min-height: 100dvh;
    overflow: hidden;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--line);
  }
  .icon-btn {
    background: transparent;
    border: none;
    color: var(--ink-dim);
    font-family: var(--font);
    font-size: 16px;
    cursor: pointer;
    padding: 4px 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: color 180ms cubic-bezier(0.85, 0, 0.15, 1), transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .icon-btn:hover { color: var(--ink); }
  .icon-btn:active { transform: scale(0.92); }
  .mute-btn {
    /* icon-only mute toggle in the top-right; sits flush against the round pill */
    width: 28px;
    height: 28px;
    border-radius: 999px;
    line-height: 0;
  }
  .mute-btn svg { display: block; }
  .room {
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 0.32em;
  }
  .spacer { flex: 1; }
  .round-pill {
    font-size: 11px;
    color: var(--ink-dim);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .roster {
    display: flex;
    gap: 6px;
    padding: 10px 18px;
    overflow-x: auto;
    border-bottom: 1px solid var(--line);
    scrollbar-width: none;
  }
  .roster::-webkit-scrollbar { display: none; }
  .player {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 12px;
    flex-shrink: 0;
    transition: all 240ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .player.me {
    border-color: var(--ink);
  }
  .player.czar {
    background: var(--ink);
    color: var(--bg);
    border-color: var(--ink);
    transform: scale(1.04);
  }
  .player.disconnected {
    opacity: 0.4;
    text-decoration: line-through;
  }
  .pscore {
    font-weight: 800;
    font-size: 13px;
    min-width: 14px;
    text-align: center;
  }
  .pname {
    font-weight: 500;
  }
  .czar-tag {
    font-size: 9px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    opacity: 0.7;
  }
  .host-dot { color: var(--ink-dim); }
  .center {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 12px;
    min-height: 0;
    overflow: hidden;
  }
  .phase-msg {
    color: var(--ink-dim);
    font-size: 14px;
    font-style: italic;
    animation: phasepulse 1.6s cubic-bezier(0.45, 0, 0.55, 1) infinite;
  }
  @keyframes phasepulse {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 1; }
  }
  .phase-strip {
    margin-top: 14px;
    color: var(--ink-dim);
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .gameover {
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 14px;
    align-items: center;
  }
  .gameover h2 {
    margin: 0;
    font-size: 40px;
    font-weight: 800;
    letter-spacing: -0.04em;
  }
  .gameover p { margin: 0; color: var(--ink-dim); font-size: 14px; }
  .muted { color: var(--ink-dim); font-size: 12px; }
  .primary {
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
  }
  .ghost {
    background: transparent;
    color: var(--ink-dim);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 12px 22px;
    font-family: var(--font);
    font-size: 13px;
    cursor: pointer;
  }
  .ghost:hover { color: var(--ink); border-color: var(--ink); }
  .hand-zone {
    border-top: 1px solid var(--line);
    padding: 22px 12px 36px;
    display: flex;
    justify-content: center;
    min-height: 240px;
    align-items: flex-end;
  }
  .hand-zone.disabled { opacity: 0.4; }
  .czar-wait {
    text-align: center;
    color: var(--ink-dim);
  }
  .czar-wait span {
    display: block;
    font-size: 11px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    margin-bottom: 6px;
  }
  .czar-wait p { margin: 0; font-size: 13px; }
</style>
