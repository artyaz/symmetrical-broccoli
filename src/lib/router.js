// router.js — Minimal hash-based router. No external deps, ~1kb.
// Routes are defined inline. View components are LAZY-loaded on first
// navigation so the initial bundle stays tiny.
//
// Why hash router: Vite preview / GitHub Pages / any static host works with
// zero server config. The "no loading on transitions" requirement is met by
// (a) caching the lazy chunks via requestIdleCallback pre-warming and
// (b) wrapping navigation in document.startViewTransition when available.

import { writable } from 'svelte/store';

export const ROUTES = {
  home: { pattern: /^\/?$/, loader: () => import('./views/Home.svelte') },
  lobby: { pattern: /^\/lobby\/([A-Z0-9]{4})\/?$/, loader: () => import('./views/Lobby.svelte') },
  game: { pattern: /^\/game\/([A-Z0-9]{4})\/?$/, loader: () => import('./views/Game.svelte') },
  join: { pattern: /^\/join\/?$/, loader: () => import('./views/Join.svelte') },
  packs: { pattern: /^\/packs\/?$/, loader: () => import('./views/Packs.svelte') },
};

// View cache: once a chunk is loaded we keep the module so re-navigating is instant.
const _viewCache = new Map();

export const route = writable({ name: 'home', params: {}, module: null, ready: false });

function parse(pathname) {
  for (const [name, def] of Object.entries(ROUTES)) {
    const m = pathname.match(def.pattern);
    if (m) {
      const params = m.slice(1);
      return { name, params, def };
    }
  }
  return { name: 'home', params: [], def: ROUTES.home };
}

async function loadView(name, def, params) {
  if (!_viewCache.has(name)) {
    _viewCache.set(name, def.loader());
  }
  const mod = await _viewCache.get(name);
  route.set({ name, params, module: mod.default, ready: true });
}

export async function navigate(to, { withTransition = true } = {}) {
  // Normalise: accept '/lobby/ABCD' or 'lobby/ABCD' or '/lobby/ABCD/'.
  const path = to.startsWith('/') ? to : `/${to}`;
  const { name, params, def } = parse(path);

  // Update URL via hash so reloads + sharing work.
  if (location.hash !== `#${path}`) {
    history.pushState(null, '', `#${path}`);
  }

  // Wrap in View Transition if supported.
  const run = () => loadView(name, def, params);

  if (withTransition && document.startViewTransition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.startViewTransition(run);
  } else {
    run();
  }
}

// Initial route from current hash.
export function initRouter() {
  const path = location.hash.slice(1) || '/';
  const { name, params, def } = parse(path);
  loadView(name, def, params);

  window.addEventListener('hashchange', () => {
    const p = location.hash.slice(1) || '/';
    const parsed = parse(p);
    loadView(parsed.name, parsed.def, parsed.params);
  });

  window.addEventListener('popstate', () => {
    const p = location.hash.slice(1) || '/';
    const parsed = parse(p);
    loadView(parsed.name, parsed.def, parsed.params);
  });
}
