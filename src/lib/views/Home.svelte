<script>
  // Home.svelte — Landing screen. Minimal. Two actions: create or join.
  // Restores session if available and offers "Resume" button.

  import { onMount } from 'svelte';
  import { navigate } from '../router.js';
  import { session, setSession, getFingerprint, getPublicIP } from '../stores/session.js';
  import { hostRoom } from '../net/network.js';
  import { game, wireNetwork, setHostRole, actions } from '../stores/game.js';

  let name = $state('');
  let photo = $state(null);  // data URL of user's chosen photo (for avatar face)
  let creating = $state(false);
  let error = $state(null);

  onMount(() => {
    name = $session?.name || '';
    photo = $session?.photo || null;
  });

  // Handle file input — read image, downscale to 256x256, store as data URL.
  // We downscale to keep PeerJS broadcast size small + texture load fast.
  async function onPhotoChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      error = 'photo must be an image.';
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      error = 'photo too large (max 8mb).';
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const img = await loadImage(dataUrl);
      // Center-crop to square, downscale to 256x256.
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext('2d');
      const size = Math.min(img.width, img.height);
      const sx = (img.width - size) / 2;
      const sy = (img.height - size) / 2;
      ctx.drawImage(img, sx, sy, size, size, 0, 0, 256, 256);
      photo = canvas.toDataURL('image/jpeg', 0.85);
      setSession({ photo });
      error = null;
    } catch (e) {
      error = 'could not load photo.';
    }
  }

  function clearPhoto() {
    photo = null;
    setSession({ photo: null });
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

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
      setSession({ name: name.trim(), roomCode: code, peerId, role: 'host', fingerprint: fp, ip, photo });
      setHostRole(true);
      wireNetwork({ isHost: true });
      actions.setRoom(code);
      actions.setHostInfo(peerId);
      // Add myself as a player.
      game.update((s) => ({
        ...s,
        players: [{ id: peerId, name: name.trim(), score: 0, isHost: true, connected: true, fingerprint: fp, ip, photo }],
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
    setSession({ name: name.trim(), photo });
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
    <div class="photo-row">
      <label class="photo-picker" class:has-photo={photo}>
        {#if photo}
          <img src={photo} alt="your avatar" />
          <button class="photo-clear" onclick={(e) => { e.preventDefault(); clearPhoto(); }} aria-label="clear photo">×</button>
        {:else}
          <span class="photo-placeholder">+</span>
        {/if}
        <input type="file" accept="image/*" onchange={onPhotoChange} />
      </label>
      <div class="photo-hint">
        <span>your face</span>
        <small>stretched onto a 3d head. pick something funny.</small>
      </div>
    </div>

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
  .photo-row {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .photo-picker {
    position: relative;
    width: 64px;
    height: 64px;
    border-radius: 50%;
    border: 1px dashed var(--line);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    overflow: hidden;
    flex-shrink: 0;
    transition: border-color 180ms ease, transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .photo-picker:hover {
    border-color: var(--ink);
    transform: scale(1.04);
  }
  .photo-picker.has-photo {
    border-style: solid;
    border-color: var(--ink);
  }
  .photo-picker img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .photo-placeholder {
    font-size: 24px;
    color: var(--ink-dim);
    font-weight: 300;
    line-height: 1;
  }
  .photo-clear {
    position: absolute;
    top: -2px;
    right: -2px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--ink);
    color: var(--bg);
    border: 2px solid var(--bg);
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .photo-picker input[type="file"] {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
  .photo-hint {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
    color: var(--ink-dim);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .photo-hint small {
    font-size: 10px;
    color: var(--ink-dim);
    text-transform: none;
    letter-spacing: 0.02em;
    opacity: 0.7;
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

  /* Mobile / portrait phone — shrink the hero title and tighten the
     vertical rhythm so the create/join form stays above the fold without
     scrolling. The clamp() on h1 already adapts; we just lower its floor. */
  @media (max-width: 640px) {
    .home {
      padding: 18px;
      gap: 36px;
    }
    h1 {
      font-size: clamp(40px, 14vw, 64px);
    }
    .tag {
      font-size: 12px;
      margin-top: 10px;
    }
    input {
      font-size: 18px;
      padding: 4px 0 8px;
    }
    .buttons button {
      padding: 12px 14px;
      font-size: 12px;
    }
    .foot {
      padding: 0 18px;
      bottom: 14px;
    }
  }
</style>
