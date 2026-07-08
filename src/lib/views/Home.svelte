<script>
  // Home.svelte — Landing screen. Minimal. Two actions: create or join.
  // Restores session if available and offers "Resume" button.

  import { onMount } from 'svelte';
  import { navigate } from '../router.js';
  import { session, setSession, getFingerprint, getPublicIP } from '../stores/session.js';
  import { hostRoom } from '../net/network.js';
  import { game, wireNetwork, setHostRole, actions } from '../stores/game.js';

  let name = $state('');
  let creating = $state(false);
  let error = $state(null);

  onMount(() => {
    name = $session?.name || '';
  });

  async function createRoom() {
    if (!name.trim()) {
      error = 'pick a name.';
      return;
    }
    creating = true;
    error = null;
    try {
      const fp = getFingerprint();
      const ip = await getPublicIP();
      const { code, peerId } = await hostRoom({ name: name.trim(), fingerprint: fp, ip });
      // Save session so a refresh can rejoin.
      setSession({ name: name.trim(), roomCode: code, peerId, role: 'host', fingerprint: fp, ip });
      setHostRole(true);
      wireNetwork({ isHost: true });
      actions.setRoom(code);
      actions.setHostInfo(peerId);
      // Add myself as a player.
      game.update((s) => ({
        ...s,
        players: [{ id: peerId, name: name.trim(), score: 0, isHost: true, connected: true, fingerprint: fp, ip }],
      }));
      navigate(`/lobby/${code}`);
    } catch (e) {
      error = e?.type === 'unavailable-id'
        ? 'room code collision — try again.'
        : (e?.message || 'could not create room.');
    } finally {
      creating = false;
    }
  }

  function goJoin() {
    if (!name.trim()) {
      error = 'pick a name.';
      return;
    }
    setSession({ name: name.trim() });
    navigate('/join');
  }

  function resume() {
    const s = $session;
    if (!s?.roomCode) return;
    if (s.role === 'host') {
      navigate(`/lobby/${s.roomCode}`);
    } else {
      navigate(`/game/${s.roomCode}`);
    }
  }
</script>

<main class="home">
  <section class="hero">
    <h1>broccoli.</h1>
    <p class="tag">a minimal cards against humanity clone. 3d, juicy, no login.</p>
  </section>

  <section class="actions">
    <label class="field">
      <span>your name</span>
      <input
        type="text"
        bind:value={name}
        placeholder="anything"
        maxlength="24"
        autocomplete="off"
        spellcheck="false"
        onkeydown={(e) => e.key === 'Enter' && createRoom()}
      />
    </label>

    <div class="buttons">
      <button class="primary" onclick={createRoom} disabled={creating}>
        {creating ? 'creating…' : 'create room'}
      </button>
      <button class="ghost" onclick={goJoin}>join with code</button>
    </div>

    {#if $session?.roomCode}
      <button class="resume" onclick={resume}>
        resume · {$session.roomCode}
      </button>
    {/if}

    {#if error}
      <p class="error">{error}</p>
    {/if}
  </section>

  <footer class="foot">
    <span>{$session?.name ? `hi, ${$session.name}` : ''}</span>
    <button class="link" onclick={() => navigate('/packs')}>browse packs →</button>
  </footer>
</main>

<style>
  .home {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
    gap: 48px;
    min-height: 100vh;
    min-height: 100dvh;
  }
  .hero { text-align: center; }
  h1 {
    font-size: clamp(48px, 9vw, 96px);
    font-weight: 800;
    letter-spacing: -0.05em;
    margin: 0;
    line-height: 1;
  }
  .tag {
    margin: 14px 0 0;
    color: var(--ink-dim);
    font-size: 13px;
    letter-spacing: 0.02em;
  }
  .actions {
    width: 100%;
    max-width: 360px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 11px;
    color: var(--ink-dim);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  input {
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--line);
    color: var(--ink);
    font-family: var(--font);
    font-size: 22px;
    font-weight: 500;
    padding: 6px 0 10px;
    outline: none;
    transition: border-color 200ms ease;
  }
  input:focus { border-bottom-color: var(--ink); }
  .buttons {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }
  .buttons button {
    flex: 1;
    padding: 14px 18px;
    border-radius: 8px;
    font-family: var(--font);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
    transition: transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1), background 200ms ease;
  }
  .primary {
    background: var(--ink);
    color: var(--bg);
    border: none;
  }
  .primary:not(:disabled):hover { transform: scale(1.03); }
  .primary:not(:disabled):active { transform: scale(0.97); }
  .primary:disabled { opacity: 0.5; cursor: wait; }
  .ghost {
    background: transparent;
    color: var(--ink);
    border: 1px solid var(--line);
  }
  .ghost:hover { background: rgba(255, 255, 255, 0.04); transform: scale(1.03); }
  .ghost:active { transform: scale(0.97); }
  .resume {
    background: transparent;
    border: none;
    color: var(--ink-dim);
    font-family: var(--font);
    font-size: 12px;
    cursor: pointer;
    padding: 6px;
    margin-top: 6px;
    letter-spacing: 0.04em;
    text-decoration: underline;
    text-underline-offset: 4px;
    text-decoration-color: var(--line);
  }
  .resume:hover { color: var(--ink); text-decoration-color: var(--ink); }
  .error {
    color: #ff8a8a;
    font-size: 12px;
    margin: 4px 0 0;
    text-align: center;
  }
  .foot {
    position: absolute;
    bottom: 18px;
    left: 0;
    right: 0;
    display: flex;
    justify-content: space-between;
    padding: 0 24px;
    font-size: 11px;
    color: var(--ink-dim);
  }
  .link {
    background: transparent;
    border: none;
    color: var(--ink-dim);
    font-family: var(--font);
    font-size: 11px;
    cursor: pointer;
    padding: 4px;
  }
  .link:hover { color: var(--ink); }
</style>
