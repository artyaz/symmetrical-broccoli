<script>
  // Game3D.svelte — The 3D game view. Mounts a Three.js canvas and wires the
  // game store to the scene: avatars for each player, 3D cards in your hand,
  // 3D cards on the table for submissions.
  //
  // Heavy modules (three, scene/avatar/cards) are dynamically imported on
  // mount so the entry chunk stays under 14kb.

  import { onMount, onDestroy } from 'svelte';
  import { game, actions, myHand, myId, isCzar, amHost, PHASE } from '../stores/game.js';
  import { session, setSession } from '../stores/session.js';
  import { navigate } from '../router.js';
  import { disconnect, connState } from '../net/network.js';
  import { play as playSound } from '../anim/audio.js';
  import { shake, burst } from '../anim/juice.js';

  let { params = [] } = $props();
  let roomCode = $derived(params[0] || '');

  let canvas;
  let sceneApi;
  let avatarApi; // module
  let cardsApi;  // module

  // State containers (Three.js objects — kept outside Svelte's reactivity).
  let avatars = new Map();      // playerId → avatar object
  let handCards = [];           // array of card objects
  let tableCards = [];          // array of submission piles (each = array of card objects)
  let blackCardObj = null;      // the standing black card

  // Reactivity mirrors (Svelte state — used to drive UI overlays).
  let hoveredIndex = $state(null);
  let selected = $state([]);
  let looking = $state(false);   // 'look closer' toggle
  let showHelp = $state(true);

  // Track phase transitions for animations.
  let lastPhase = null;
  let lastRevealedIndex = -1;
  let lastRound = 0;

  // Cleanup bookkeeping.
  let disposed = false;
  let unsubConn;

  async function setupScene() {
    // Lazy-load Three.js modules.
    const [{ createScene, SEAT_POSITIONS, TABLE_RADIUS }, avatarMod, cardsMod] = await Promise.all([
      import('../three/scene.js'),
      import('../three/avatar.js'),
      import('../three/cards.js'),
    ]);
    avatarApi = avatarMod;
    cardsApi = cardsMod;
    sceneApi = createScene(canvas);

    // Wire max anisotropy into the cards system (for crisp text at glancing angles).
    if (cardsApi.setMaxAnisotropy) {
      cardsApi.setMaxAnisotropy(sceneApi.renderer.capabilities.getMaxAnisotropy());
    }

    // Register a per-frame hook that updates all avatars + cards.
    sceneApi.registerUpdate((delta) => {
      for (const av of avatars.values()) av.update?.(delta);
      for (const c of handCards) c.update?.(delta);
      for (const pile of tableCards) for (const c of pile) c.update?.(delta);
      blackCardObj?.update?.(delta);
    });

    // Create avatars for players currently in the game.
    rebuildAvatars();

    // Build hand for local player.
    rebuildHand();

    // Build table state.
    rebuildTable();

    // Pointer move → raycast for hover.
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('click', onPointerClick);

    // Watch game state for changes.
    game.subscribe(onGameChange);
  }

  function rebuildAvatars() {
    if (!sceneApi || !avatarApi) return;
    const state = $game;
    const seenIds = new Set();
    let seatIdx = 0;
    // Local player (south) first.
    const me = myId();
    const myPlayer = state.players.find((p) => p.id === me);
    if (myPlayer) {
      seenIds.add(myPlayer.id);
      if (!avatars.has(myPlayer.id)) {
        // South seat — but we don't render our own avatar (first-person view).
        // Optionally render a "shadow" of ourselves; for now, skip.
      }
    }
    // Other players fill west/north/east.
    const others = state.players.filter((p) => p.id !== me);
    others.slice(0, 3).forEach((p, i) => {
      seenIds.add(p.id);
      const seatIndex = i + 1; // 1=west, 2=north, 3=east
      let av = avatars.get(p.id);
      if (!av) {
        av = avatarApi.createAvatar({
          id: p.id,
          name: p.name,
          seatIndex,
          photoImage: p.photo || null,
        });
        sceneApi.scene.add(av.group);
        avatars.set(p.id, av);
      } else {
        av.setName(p.name);
        if (p.photo && p.photo !== av._lastPhoto) {
          av.setPhoto(p.photo);
          av._lastPhoto = p.photo;
        }
      }
    });
    // Remove avatars for players no longer present.
    for (const [pid, av] of avatars.entries()) {
      if (!seenIds.has(pid)) {
        sceneApi.scene.remove(av.group);
        av.dispose?.();
        avatars.delete(pid);
      }
    }
  }

  function rebuildHand() {
    if (!sceneApi || !cardsApi) return;
    const state = $game;
    const me = myId();
    const hand = state.hands?.[me] || [];
    // If we're the czar or not in picking phase, hide the hand.
    const showHand = (state.phase === PHASE.PROMPT || state.phase === PHASE.PLAYING) && state.czarId !== me;
    if (!showHand) {
      // Remove all hand cards.
      for (const c of handCards) {
        sceneApi.scene.remove(c.mesh);
        c.dispose?.();
      }
      handCards = [];
      return;
    }
    // Match hand length: add or remove cards.
    while (handCards.length < hand.length) {
      const text = hand[handCards.length];
      const card = cardsApi.createCard({ text, isBlack: false });
      sceneApi.scene.add(card.mesh);
      handCards.push(card);
    }
    while (handCards.length > hand.length) {
      const c = handCards.pop();
      sceneApi.scene.remove(c.mesh);
      c.dispose?.();
    }
    // Update card text + layout.
    handCards.forEach((c, i) => {
      if (c.text !== hand[i]) {
        // Card text changed (rare — happens when refilling after a round).
        sceneApi.scene.remove(c.mesh);
        c.dispose?.();
        const newCard = cardsApi.createCard({ text: hand[i], isBlack: false });
        sceneApi.scene.add(newCard.mesh);
        handCards[i] = newCard;
      }
    });
    cardsApi.layoutHand(handCards, hoveredIndex, selected);
  }

  function rebuildTable() {
    if (!sceneApi || !cardsApi) return;
    const state = $game;

    // Black card: drop in at start of round.
    if (state.blackCard) {
      if (!blackCardObj || blackCardObj.text !== state.blackCard.text) {
        if (blackCardObj) {
          sceneApi.scene.remove(blackCardObj.mesh);
          blackCardObj.dispose?.();
        }
        blackCardObj = cardsApi.createCard({
          text: state.blackCard.text,
          isBlack: true,
          pick: state.blackCard.pick,
        });
        sceneApi.scene.add(blackCardObj.mesh);
        blackCardObj.dropInAsBlackCard();
      }
    } else if (blackCardObj) {
      sceneApi.scene.remove(blackCardObj.mesh);
      blackCardObj.dispose?.();
      blackCardObj = null;
    }

    // Submissions: rebuild if length changed.
    const subs = state.submissions || [];
    const revealedIdx = state.revealedIndex;

    // If the round changed or submission count changed, tear down + rebuild.
    if (state.round !== lastRound || subs.length !== tableCards.length) {
      for (const pile of tableCards) {
        for (const c of pile) {
          sceneApi.scene.remove(c.mesh);
          c.dispose?.();
        }
      }
      const tableY = cardsApi.TABLE_CARD_Y || 0.06;
      tableCards = subs.map((sub, i) => {
        const pile = sub.cards.map((text) => {
          const c = cardsApi.createCard({ text, isBlack: false });
          sceneApi.scene.add(c.mesh);
          // Position near table center, with jitter. Raised to tableY (0.06)
          // to prevent z-fighting with the table surface (research §6.1).
          const angle = (i / subs.length) * Math.PI * 2;
          const radius = 0.6;
          c.mesh.position.set(
            Math.cos(angle) * radius + (Math.random() - 0.5) * 0.08,
            tableY + i * 0.001,
            Math.sin(angle) * radius + (Math.random() - 0.5) * 0.08,
          );
          c.mesh.rotation.set(-Math.PI / 2, Math.random() * Math.PI * 2, 0);
          // Face down by default.
          c.setState?.('table-down');
          // Add a blob shadow under the pile for grounding (research §4.3).
          if (c.addBlobShadow) c.addBlobShadow(sceneApi.scene);
          return c;
        });
        return pile;
      });
    }

    // Update revealed state per pile.
    tableCards.forEach((pile, i) => {
      const isRevealed = i <= revealedIdx || state.phase === PHASE.VOTING || state.phase === PHASE.SCORING;
      const wasRevealed = pile._revealed;
      if (isRevealed && !wasRevealed) {
        // Just revealed — flip face up.
        for (const c of pile) c.flipFaceUp();
        pile._revealed = true;
      } else if (!isRevealed && wasRevealed) {
        for (const c of pile) c.flipFaceDown();
        pile._revealed = false;
      }
    });
  }

  function onGameChange(state) {
    if (!sceneApi) return;
    rebuildAvatars();
    rebuildHand();
    rebuildTable();

    // Phase-change juice.
    const p = state.phase;
    if (p !== lastPhase) {
      if (p === PHASE.REVEAL && lastPhase === PHASE.PLAYING) {
        shake(4, 200);
        playSound('phaseChange');
      }
      if (p === PHASE.SCORING && lastPhase === PHASE.VOTING) {
        shake(10, 360);
        playSound('winnerReveal');
        setTimeout(() => {
          burst(window.innerWidth / 2, window.innerHeight / 2, 32, { distancePx: 180, durationMs: 1100 });
        }, 80);
      }
      if (p !== PHASE.PROMPT && p !== PHASE.PLAYING) {
        selected = [];
      }
      lastPhase = p;
    }

    // Reveal-by-reveal: each time revealedIndex increments, fire sound + small shake.
    if (state.revealedIndex > lastRevealedIndex && state.phase === PHASE.REVEAL) {
      shake(2, 140);
      playSound('cardFlip');
    }
    lastRevealedIndex = state.revealedIndex;
    if (state.round !== lastRound) {
      lastRevealedIndex = -1;
    }
    lastRound = state.round;
  }

  function onPointerMove(e) {
    if (!sceneApi || !cardsApi || !handCards.length) return;
    const rect = canvas.getBoundingClientRect();
    const ndc = {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
    };
    const fakeEvent = { clientX: e.clientX, clientY: e.clientY, ndc };
    const picked = cardsApi.pickCard(fakeEvent, sceneApi.camera, handCards);
    const newHovered = picked ? handCards.indexOf(picked) : null;
    if (newHovered !== hoveredIndex) {
      hoveredIndex = newHovered;
      cardsApi.layoutHand(handCards, hoveredIndex, selected);
      if (hoveredIndex !== null) playSound('cardHover');
      // Broadcast hover state to other players (so they see our stack lift).
      // Skipping actual network send for now — placeholder for the network hook.
    }
  }

  function onPointerClick(e) {
    if (!handCards.length) return;
    const rect = canvas.getBoundingClientRect();
    const ndc = {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
    };
    const fakeEvent = { clientX: e.clientX, clientY: e.clientY, ndc };
    const picked = cardsApi.pickCard(fakeEvent, sceneApi.camera, handCards);
    if (!picked) return;
    const idx = handCards.indexOf(picked);
    const text = picked.text;
    let next;
    if (selected.includes(text)) {
      next = selected.filter((t) => t !== text);
    } else {
      const pick = $game.blackCard?.pick || 1;
      if (selected.length >= pick) {
        next = [...selected.slice(1), text];
      } else {
        next = [...selected, text];
      }
    }
    selected = next;
    cardsApi.layoutHand(handCards, hoveredIndex, selected);
    playSound('cardSelect');
  }

  function handlePlay() {
    if (selected.length !== ($game.blackCard?.pick || 1)) return;
    // Animate the selected cards flying to the table.
    const me = myId();
    const angle = ($game.submissions?.length || 0) * 0.5;
    const target = { x: Math.cos(angle) * 0.6, y: 0.04, z: Math.sin(angle) * 0.6 };
    const flyPromises = [];
    const cardsToRemove = handCards.filter((c) => selected.includes(c.text));
    for (const c of cardsToRemove) {
      flyPromises.push(c.flyTo(target, { x: -Math.PI / 2, y: Math.random() * Math.PI * 2, z: 0 }, 720));
    }
    // Remove them from handCards after flight starts.
    handCards = handCards.filter((c) => !selected.includes(c.text));
    shake(3, 160);
    playSound('cardDrop');
    actions.pickCards(selected);
    selected = [];
    // Re-layout remaining hand.
    cardsApi.layoutHand(handCards, null, []);
  }

  function revealNext() {
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
  function toggleLookCloser() {
    looking = !looking;
    sceneApi?.cameraLookCloser();
  }

  onMount(async () => {
    if (!$session?.roomCode) {
      navigate('/');
      return;
    }
    await setupScene();
    unsubConn = connState.subscribe((cs) => {
      if (cs.status === 'error' || (cs.status === 'closed' && !amHost())) {
        // Error overlay shows automatically via the existing overlay logic.
      }
    });
    // Auto-hide help after 6 seconds.
    setTimeout(() => (showHelp = false), 6000);
  });

  onDestroy(() => {
    disposed = true;
    unsubConn?.();
    canvas?.removeEventListener('pointermove', onPointerMove);
    canvas?.removeEventListener('click', onPointerClick);
    // Dispose Three.js resources.
    try {
      for (const av of avatars.values()) av.dispose?.();
      for (const c of handCards) c.dispose?.();
      for (const pile of tableCards) for (const c of pile) c.dispose?.();
      blackCardObj?.dispose?.();
      sceneApi?.dispose?.();
    } catch (e) {
      console.warn('dispose error', e);
    }
  });

  // React to window resize.
  function onResize() {
    if (!sceneApi) return;
    sceneApi.resize(window.innerWidth, window.innerHeight);
  }

  // Derived UI state.
  const me = $derived(myId());
  const czar = $derived(isCzar($game));
  const host = $derived(amHost());
  const phase = $derived($game.phase);
  const players = $derived($game.players);
  const blackCard = $derived($game.blackCard);
  const canPlay = $derived(selected.length === (blackCard?.pick || 1));
  const gameOverWinner = $derived(
    phase === PHASE.GAMEOVER ? players.find((p) => p.score >= $game.targetScore) : null
  );
</script>

<svelte:window onresize={onResize} />

<main class="game3d" data-phase={phase}>
  <canvas bind:this={canvas} class="canvas"></canvas>

  <!-- Top bar: room code, round, mute, leave -->
  <header class="topbar">
    <button class="icon-btn" onclick={leave} aria-label="leave">←</button>
    <span class="room">{roomCode}</span>
    <span class="conn-dot" data-status={$connState.status} aria-hidden="true"></span>
    <div class="spacer"></div>
    <span class="round">round {$game.round} · to {$game.targetScore}</span>
    <button class="icon-btn look-btn" class:active={looking} onclick={toggleLookCloser} aria-label="look closer" title="look closer">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="7" cy="7" r="4.5"></circle>
        <line x1="10.5" y1="10.5" x2="14" y2="14"></line>
      </svg>
    </button>
  </header>

  <!-- Roster strip -->
  <section class="roster">
    {#each players as p (p.id)}
      <div class="player" class:me={p.id === me} class:czar={p.id === $game.czarId} class:disconnected={p.connected === false}>
        <span class="pscore">{p.score}</span>
        <span class="pname">{p.name}{p.id === me ? ' (you)' : ''}</span>
        {#if p.id === $game.czarId}<span class="czar-tag">czar</span>{/if}
      </div>
    {/each}
  </section>

  <!-- Phase-driven hint -->
  {#if phase === PHASE.PROMPT || phase === PHASE.PLAYING}
    <div class="phase-hint">
      {#if czar}
        you are the czar — wait for players to play
      {:else if canPlay}
        <button class="play-btn" onclick={handlePlay}>play {selected.length > 1 ? `${selected.length} cards` : 'card'}</button>
      {:else}
        pick {blackCard?.pick || 1} card{blackCard?.pick > 1 ? 's' : ''}
      {/if}
    </div>
  {:else if phase === PHASE.REVEAL && czar}
    <div class="phase-hint">
      <button class="play-btn" onclick={revealNext}>
        {$game.revealedIndex < $game.submissions.length - 1 ? 'reveal next' : 'open voting'}
      </button>
    </div>
  {:else if phase === PHASE.VOTING}
    <div class="phase-hint">
      {#if czar}
        tap a card on the table to pick the winner
      {:else if $game.votingMode === 'open'}
        tap a card on the table to vote
      {:else}
        czar is choosing…
      {/if}
    </div>
  {:else if phase === PHASE.SCORING && (czar || host)}
    <div class="phase-hint">
      <button class="play-btn" onclick={nextRound}>next round →</button>
    </div>
  {/if}

  <!-- First-time help overlay -->
  {#if showHelp}
    <div class="help">
      <p>move mouse to look · click cards to select · "look closer" to inspect the table</p>
    </div>
  {/if}

  <!-- Game over overlay -->
  {#if phase === PHASE.GAMEOVER}
    <div class="overlay">
      <div class="overlay-inner">
        <h2>{gameOverWinner?.name || 'someone'} wins</h2>
        <p>first to {$game.targetScore} awesome points</p>
        <div class="overlay-actions">
          {#if host}<button class="primary" onclick={returnToLobby}>back to lobby</button>{/if}
          <button class="ghost" onclick={leave}>leave</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Host-left / error overlay -->
  {#if $connState.status === 'error' || ($connState.status === 'closed' && !host)}
    <div class="overlay">
      <div class="overlay-inner">
        <h2>{$connState.status === 'closed' && !host ? 'host left the room' : 'connection error'}</h2>
        {#if $connState.error}<p>{$connState.error}</p>{/if}
        <button class="primary" onclick={leave}>back home</button>
      </div>
    </div>
  {/if}
</main>

<style>
  .game3d {
    position: fixed;
    inset: 0;
    overflow: hidden;
    background: #ECECEC;
    color: #2a2a2a;
    font-family: var(--font);
  }
  .canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none;
  }
  .topbar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 18px;
    z-index: 10;
    pointer-events: auto;
  }
  .icon-btn {
    background: rgba(255, 255, 255, 0.6);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid rgba(0, 0, 0, 0.08);
    color: #2a2a2a;
    font-family: var(--font);
    font-size: 14px;
    cursor: pointer;
    padding: 6px 10px;
    border-radius: 8px;
    transition: background 180ms ease, transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1);
    display: inline-flex;
    align-items: center;
  }
  .icon-btn:hover { background: rgba(255, 255, 255, 0.9); transform: scale(1.04); }
  .icon-btn.active { background: rgba(0, 0, 0, 0.85); color: #fafafa; border-color: transparent; }
  .room {
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 0.32em;
    color: #2a2a2a;
  }
  .conn-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #4ade80;
  }
  .conn-dot[data-status='idle'] { background: #9a9a9a; }
  .conn-dot[data-status='error'],
  .conn-dot[data-status='closed'] { background: #ff6b6b; }
  .conn-dot[data-status='joining'],
  .conn-dot[data-status='reconnecting'] {
    background: #facc15;
    animation: dotpulse 1.4s cubic-bezier(0.45, 0, 0.55, 1) infinite;
  }
  @keyframes dotpulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
  .spacer { flex: 1; }
  .round {
    font-size: 11px;
    color: #6a6a6a;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .roster {
    position: absolute;
    top: 50px;
    left: 18px;
    right: 18px;
    display: flex;
    gap: 6px;
    overflow-x: auto;
    z-index: 10;
    pointer-events: none;
    scrollbar-width: none;
  }
  .roster::-webkit-scrollbar { display: none; }
  .player {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: rgba(255, 255, 255, 0.55);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    border: 1px solid rgba(0, 0, 0, 0.06);
    border-radius: 999px;
    font-size: 12px;
    color: #2a2a2a;
    flex-shrink: 0;
    transition: all 240ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .player.me { border-color: rgba(0, 0, 0, 0.4); }
  .player.czar {
    background: #2a2a2a;
    color: #fafafa;
    border-color: transparent;
  }
  .player.disconnected { opacity: 0.4; text-decoration: line-through; }
  .pscore { font-weight: 800; min-width: 14px; text-align: center; }
  .pname { font-weight: 500; }
  .czar-tag {
    font-size: 9px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    opacity: 0.7;
  }
  .phase-hint {
    position: absolute;
    bottom: 36px;
    left: 50%;
    transform: translateX(-50%);
    color: #4a4a4a;
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    background: rgba(255, 255, 255, 0.55);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    padding: 8px 14px;
    border-radius: 999px;
    border: 1px solid rgba(0, 0, 0, 0.06);
    z-index: 10;
    pointer-events: auto;
  }
  .play-btn {
    background: #2a2a2a;
    color: #fafafa;
    border: none;
    border-radius: 999px;
    padding: 10px 22px;
    font-family: var(--font);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
    transition: transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .play-btn:hover { transform: scale(1.04); }
  .play-btn:active { transform: scale(0.96); }
  .help {
    position: absolute;
    bottom: 80px;
    left: 50%;
    transform: translateX(-50%);
    color: #6a6a6a;
    font-size: 11px;
    background: rgba(255, 255, 255, 0.45);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid rgba(0, 0, 0, 0.05);
    z-index: 9;
    animation: helpfade 6s ease forwards;
  }
  @keyframes helpfade {
    0%, 70% { opacity: 1; }
    100% { opacity: 0; }
  }
  .overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.92);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    animation: overlayin 220ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  @keyframes overlayin {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .overlay-inner {
    text-align: center;
    color: #fafafa;
    display: flex;
    flex-direction: column;
    gap: 14px;
    align-items: center;
  }
  .overlay-inner h2 {
    margin: 0;
    font-size: clamp(28px, 6vw, 48px);
    font-weight: 800;
    letter-spacing: -0.04em;
  }
  .overlay-inner p { margin: 0; color: #9a9a9a; font-size: 14px; }
  .overlay-actions {
    display: flex;
    gap: 10px;
    margin-top: 12px;
  }
  .primary {
    background: #fafafa;
    color: #0a0a0a;
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
    color: #9a9a9a;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 999px;
    padding: 12px 22px;
    font-family: var(--font);
    font-size: 13px;
    cursor: pointer;
  }
  .ghost:hover { color: #fafafa; border-color: #fafafa; }
  @media (max-width: 640px) {
    .topbar { flex-wrap: wrap; gap: 6px; padding: 10px 12px; }
    .roster { top: 56px; left: 12px; right: 12px; }
    .phase-hint { bottom: 18px; font-size: 11px; padding: 6px 10px; }
    .play-btn { padding: 8px 16px; font-size: 12px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0ms !important; transition-duration: 0ms !important; }
  }
</style>
