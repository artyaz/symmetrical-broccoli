// session.js — Persistent player session.
// Strategy:
//   - All session data is stored in localStorage so a refresh keeps the
//     player's name + last room. No login, no server-side account.
//   - We bind the session to a coarse "fingerprint" (a stable random ID we
//     generate once + a tiny browser fingerprint + the client's public IP
//     fetched lazily). This satisfies the "bind to IP to re-join" requirement:
//     if the same browser+IP returns, we silently rejoin the saved room. If
//     either changes, we still offer to rejoin but require the room code.
//   - The IP fetch is best-effort. If it fails (offline, blocked CORS) the
//     session still works — IP is a soft re-join signal, not a hard gate.

import { writable } from 'svelte/store';

const LS_KEY = 'broccoli.session.v1';
const FP_KEY = 'broccoli.fp.v1';

function loadFingerprint() {
  let fp = localStorage.getItem(FP_KEY);
  if (!fp) {
    // Random UUID-ish + a couple of stable browser signals. Not a tracker,
    // just a stable per-browser token so we can tell "same browser, new tab"
    // from "different browser entirely".
    const rand = Math.random().toString(36).slice(2, 12);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'na';
    const lang = (navigator.language || 'na').slice(0, 8);
    fp = `${rand}.${btoa(`${tz}.${lang}`)}`;
    localStorage.setItem(FP_KEY, fp);
  }
  return fp;
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return null;
    return s;
  } catch {
    return null;
  }
}

export function saveSession(s) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    /* quota or disabled — best effort */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

export const session = writable(loadSession());

export function setSession(partial) {
  session.update((cur) => {
    const next = { ...(cur || {}), ...partial, updatedAt: Date.now() };
    saveSession(next);
    return next;
  });
}

export function restoreSession() {
  // Synchronously read localStorage so the first render knows whether to
  // offer "Resume" or show the home screen.
  const s = loadSession();
  if (s) session.set(s);
  return s;
}

// Lazy, best-effort public IP fetch. Uses a tiny public API; failures are
// silent. Cached in localStorage so we don't re-hit the network every load.
let _ipPromise = null;
export function getPublicIP() {
  if (_ipPromise) return _ipPromise;
  _ipPromise = (async () => {
    const cached = localStorage.getItem('broccoli.ip.v1');
    if (cached) return cached;
    try {
      const r = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
      const j = await r.json();
      if (j?.ip) {
        localStorage.setItem('broccoli.ip.v1', j.ip);
        return j.ip;
      }
    } catch {
      /* offline / blocked */
    }
    return null;
  })();
  return _ipPromise;
}

export function getFingerprint() {
  return loadFingerprint();
}
