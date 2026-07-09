<script>
  // Join.svelte — Enter a room code and join as a guest.
  import { navigate } from '../router.js';
  import { session, setSession, getFingerprint, getPublicIP } from '../stores/session.js';
  import { joinRoom, isValidCode } from '../net/network.js';
  import { game, wireNetwork, setHostRole, actions } from '../stores/game.js';

  let { params = [] } = $props();
  let code = $state('');
  let name = $state($session?.name || '');
  let joining = $state(false);
  let error = $state(null);

  // Auto-uppercase the code as you type, max 4 chars.
  function onInput(e) {
    code = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  }

  async function doJoin() {
    if (!name.trim()) { error = 'pick a name.'; return; }
    if (!isValidCode(code)) { error = 'need a 4-letter code.'; return; }
    joining = true;
    error = null;
    try {
      const fp = getFingerprint();
      const ip = await getPublicIP();
      const photo = $session?.photo || null;
      const { peerId } = await joinRoom({ code, name: name.trim(), fingerprint: fp, ip, photo });
      setSession({ name: name.trim(), roomCode: code, peerId, role: 'guest', fingerprint: fp, ip, photo });
      setHostRole(false);
      wireNetwork({ isHost: false });
      navigate(`/game/${code}`);
    } catch (e) {
      error = e?.type === 'peer-unavailable'
        ? 'room not found. check the code.'
        : (e?.message || 'could not join room.');
    } finally {
      joining = false;
    }
  }

  function back() { navigate('/'); }
</script>

<main class="join">
  <button class="back" onclick={back}>← back</button>
  <section class="card">
    <h2>join room</h2>
    <label class="field">
      <span>your name</span>
      <input type="text" bind:value={name} maxlength="24" autocomplete="off" spellcheck="false" />
    </label>
    <label class="field">
      <span>room code</span>
      <input
        type="text"
        value={code}
        oninput={onInput}
        placeholder="ABCD"
        maxlength="4"
        autocomplete="off"
        spellcheck="false"
        class="code-input"
        onkeydown={(e) => e.key === 'Enter' && doJoin()}
      />
    </label>
    <button class="primary" onclick={doJoin} disabled={joining}>
      {joining ? 'connecting…' : 'join'}
    </button>
    {#if error}<p class="error">{error}</p>{/if}
  </section>
</main>

<style>
  .join {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
    gap: 24px;
    min-height: 100vh;
    min-height: 100dvh;
  }
  .back {
    position: absolute;
    top: 18px;
    left: 18px;
    background: transparent;
    border: none;
    color: var(--ink-dim);
    font-family: var(--font);
    font-size: 13px;
    cursor: pointer;
  }
  .back:hover { color: var(--ink); }
  .card {
    width: 100%;
    max-width: 360px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 32px 28px;
    border: 1px solid var(--line);
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.02);
  }
  h2 { margin: 0 0 8px; font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
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
    padding: 6px 0 10px;
    outline: none;
    transition: border-color 200ms ease;
  }
  input:focus { border-bottom-color: var(--ink); }
  .code-input {
    font-size: 36px;
    font-weight: 800;
    letter-spacing: 0.4em;
    text-transform: uppercase;
    text-align: center;
  }
  .primary {
    margin-top: 8px;
    padding: 14px 18px;
    border-radius: 8px;
    background: var(--ink);
    color: var(--bg);
    border: none;
    font-family: var(--font);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
    transition: transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .primary:not(:disabled):hover { transform: scale(1.03); }
  .primary:not(:disabled):active { transform: scale(0.97); }
  .primary:disabled { opacity: 0.5; cursor: wait; }
  .error { color: #ff8a8a; font-size: 12px; margin: 4px 0 0; text-align: center; }
</style>
