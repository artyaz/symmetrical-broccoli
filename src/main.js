// main.js — Application entry. Kept intentionally tiny so the initial chunk
// stays under 14kb gzipped. Everything heavy (PeerJS, card data, animation
// helpers, full UI) is dynamically imported AFTER first paint.

import { mount } from 'svelte';
import App from './App.svelte';
import { restoreSession } from './lib/stores/session.js';
import './styles/global.css';

// 1. Restore any saved session synchronously so the first route renders
//    with the right context (returning player vs first-time visitor).
restoreSession();

// 2. Mount the Svelte app.
const app = mount(App, { target: document.getElementById('app') });

// 3. Fade out the inline boot dot now that Svelte has taken over the screen.
requestAnimationFrame(() => {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.classList.add('gone');
  setTimeout(() => boot.remove(), 320);
});

// 4. Kick off idle-time preloading of the next-likely chunks. We don't await
//    this — it just warms the browser cache so view transitions are instant.
//    The list is intentionally short: only the chunks the user is most likely
//    to navigate into next.
if ('requestIdleCallback' in window) {
  requestIdleCallback(
    () => {
      // Warm up networking + first view + first card pack metadata.
      import('./lib/net/network.js').catch(() => {});
      import('./lib/views/Home.svelte').catch(() => {});
      import('./lib/data/packs/index.js').catch(() => {});
    },
    { timeout: 1500 },
  );
}

// 5. Surface the app on window for debugging (dev only).
if (import.meta.env.DEV) {
  window.__app = app;
}
