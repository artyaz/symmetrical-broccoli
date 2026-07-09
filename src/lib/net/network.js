// network.js — PeerJS wrapper for P2P multiplayer.
//
// Architecture:
//   - The room CODE is a 4-character string (A-Z, 0-9) that maps 1:1 to a
//     deterministic PeerJS peer ID prefixed with "broccoli-". So room "ABCD"
//     → peer ID "broccoli-ABCD".
//   - The HOST creates the peer with that ID. Clients connect to it.
//   - The HOST is the authoritative game state owner; it broadcasts state
//     snapshots to every connected client on every change. Clients send
//     actions (play card, vote, etc.) as messages addressed to the host.
//   - We use a tiny typed-message protocol over PeerJS's data channel.
//   - If the host disconnects, the room dies. (For a party game where the
//     host is in the room, that's the right tradeoff vs. a stateful server.)

import Peer from 'peerjs';
import { writable, get } from 'svelte/store';

// Message types — short codes keep payload small over the wire.
export const MSG = {
  HELLO: 'hello',          // client → host: { name, fp, ip }
  WELCOME: 'welcome',      // host → client: { you: playerId, state }
  STATE: 'state',          // host → all: full game state snapshot
  ACTION: 'action',        // client → host: { kind, payload }
  KICKED: 'kicked',        // host → client
  PING: 'ping',
  PONG: 'pong',
};

// Generate a 4-char room code from a 32-char alphabet (1.1M combinations).
// We avoid ambiguous chars (0/O, 1/I) for verbal sharing.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generateRoomCode() {
  let out = '';
  const buf = new Uint32Array(4);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 4; i++) out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return out;
}

export function codeToPeerId(code) {
  return `broccoli-${code.toUpperCase()}`;
}

export function isValidCode(code) {
  return /^[A-Z0-9]{4}$/.test((code || '').toUpperCase());
}

// Connection state store — UI can subscribe to this.
export const connState = writable({
  status: 'idle',          // idle | hosting | joining | connected | error | closed
  role: null,              // 'host' | 'guest'
  roomCode: null,
  peerId: null,
  error: null,
  connectedPeers: 0,
});

// The PeerJS Peer object (kept out of stores so it doesn't trigger re-renders).
let _peer = null;
// Map of guestId → DataConnection (host-side).
const _connections = new Map();
// The host connection (guest-side).
let _hostConn = null;
// Local player identity (filled in by join/host calls).
let _me = null;

// ----- HOST ---------------------------------------------------------------

export async function hostRoom({ name, fingerprint, ip }) {
  if (_peer) _peer.destroy();
  const code = generateRoomCode();
  const peerId = codeToPeerId(code);
  _me = { id: peerId, name: name || 'Host', fingerprint, ip, isHost: true };

  return new Promise((resolve, reject) => {
    let settled = false;
    _peer = new Peer(peerId, { debug: 1 });

    _peer.on('open', () => {
      connState.set({
        status: 'hosting',
        role: 'host',
        roomCode: code,
        peerId,
        error: null,
        connectedPeers: 0,
      });
      settled = true;
      resolve({ code, peerId });
    });

    _peer.on('connection', (conn) => {
      // A new guest is connecting.
      conn.on('open', () => {
        _connections.set(conn.peer, conn);
      });
      conn.on('data', (data) => handleHostMessage(conn, data));
      conn.on('close', () => {
        _connections.delete(conn.peer);
        // Notify game store that a player left; the host's game logic decides
        // what to do (forfeit hand, etc.).
        emitLocal('peer-left', { peerId: conn.peer });
        broadcastState();
      });
      conn.on('error', () => {
        _connections.delete(conn.peer);
      });
    });

    _peer.on('error', (err) => {
      if (!settled) reject(err);
      else connState.update((s) => ({ ...s, status: 'error', error: err?.type || String(err) }));
    });

    _peer.on('disconnected', () => {
      // Try to revive the signalling connection.
      try { _peer.reconnect(); } catch { /* ignore */ }
    });

    _peer.on('close', () => {
      connState.set({ status: 'closed', role: null, roomCode: null, peerId: null, error: null, connectedPeers: 0 });
    });
  });
}

function handleHostMessage(conn, data) {
  if (!data || typeof data !== 'object') return;
  switch (data.type) {
    case MSG.HELLO: {
      // New guest identified themselves. Add to roster and welcome them.
      const player = {
        id: conn.peer,
        name: (data.name || 'Guest').slice(0, 24),
        fingerprint: data.fingerprint,
        ip: data.ip,
        // Photo is a 256x256 JPEG data URL (~10-20kb). Included in HELLO so
        // the host can broadcast it to all guests in the next state snapshot.
        photo: typeof data.photo === 'string' && data.photo.length < 100000 ? data.photo : null,
        isHost: false,
        connectedAt: Date.now(),
      };
      emitLocal('peer-joined', { player });
      // Send welcome back.
      send(conn, { type: MSG.WELCOME, you: player.id });
      // Broadcast updated state to everyone.
      broadcastState();
      break;
    }
    case MSG.ACTION: {
      // Forward to host game logic.
      emitLocal('action', { from: conn.peer, ...data.payload });
      break;
    }
    case MSG.PING: {
      send(conn, { type: MSG.PONG, t: data.t });
      break;
    }
  }
}

// Broadcast the current game state to all connected guests.
// Strips any field starting with `_` (host-internal data like deck contents)
// to keep payload small. Guests receive a public view; the host keeps the
// full state in its local store.
export function broadcastState(state) {
  if (!state) return;
  const publicState = sanitizeForBroadcast(state);
  for (const conn of _connections.values()) {
    if (conn.open) send(conn, { type: MSG.STATE, state: publicState });
  }
}

function sanitizeForBroadcast(state) {
  // Shallow-clone and strip underscore-prefixed keys.
  const out = {};
  for (const k of Object.keys(state)) {
    if (k.startsWith('_')) continue;
    out[k] = state[k];
  }
  return out;
}

// ----- GUEST ---------------------------------------------------------------

export async function joinRoom({ code, name, fingerprint, ip, photo }) {
  if (!isValidCode(code)) throw new Error('Invalid room code');
  if (_peer) _peer.destroy();
  const hostId = codeToPeerId(code);
  const guestId = `broccoli-${code.toUpperCase()}-${Math.random().toString(36).slice(2, 8)}`;
  _me = { id: guestId, name: name || 'Guest', fingerprint, ip, photo, isHost: false };

  return new Promise((resolve, reject) => {
    let settled = false;
    _peer = new Peer(guestId, { debug: 1 });

    _peer.on('open', () => {
      // Connect to host.
      _hostConn = _peer.connect(hostId, { reliable: true });
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Could not reach room — host may be offline or in a different region.'));
        }
      }, 12000);

      _hostConn.on('open', () => {
        clearTimeout(timeout);
        settled = true;
        // Send HELLO with identity.
        send(_hostConn, {
          type: MSG.HELLO,
          name: _me.name,
          fingerprint: _me.fingerprint,
          ip: _me.ip,
          photo: _me.photo,
        });
        connState.set({
          status: 'connected',
          role: 'guest',
          roomCode: code.toUpperCase(),
          peerId: guestId,
          error: null,
          connectedPeers: 1,
        });
        resolve({ code: code.toUpperCase(), peerId: guestId });
      });

      _hostConn.on('data', (data) => handleGuestMessage(data));
      _hostConn.on('close', () => {
        connState.set({ status: 'closed', role: null, roomCode: null, peerId: null, error: 'Host left', connectedPeers: 0 });
        emitLocal('host-left', {});
      });
      _hostConn.on('error', (err) => {
        clearTimeout(timeout);
        if (!settled) { settled = true; reject(err); }
      });
    });

    _peer.on('error', (err) => {
      if (!settled) reject(err);
      else connState.update((s) => ({ ...s, status: 'error', error: err?.type || String(err) }));
    });
  });
}

function handleGuestMessage(data) {
  if (!data || typeof data !== 'object') return;
  switch (data.type) {
    case MSG.WELCOME:
      emitLocal('welcome', { you: data.you });
      break;
    case MSG.STATE:
      emitLocal('state', { state: data.state });
      break;
    case MSG.KICKED:
      emitLocal('kicked', { reason: data.reason });
      break;
    case MSG.PONG:
      // RTT measurement if we ever want it.
      break;
  }
}

// ----- SEND / RECEIVE ------------------------------------------------------

function send(conn, payload) {
  if (conn && conn.open) {
    try { conn.send(payload); } catch { /* ignore transient errors */ }
  }
}

// Tiny local event emitter so the game store can subscribe without coupling.
const _listeners = new Map();
export function onNetEvent(type, cb) {
  if (!_listeners.has(type)) _listeners.set(type, new Set());
  _listeners.get(type).add(cb);
  return () => _listeners.get(type)?.delete(cb);
}
function emitLocal(type, payload) {
  _listeners.get(type)?.forEach((cb) => {
    try { cb(payload); } catch (e) { console.error('[net] listener error', e); }
  });
}

// Guest → host action sender.
export function sendAction(kind, payload = {}) {
  if (!_me) return;
  if (_me.isHost) {
    // Locally loop back so the host code path is identical to guest path.
    emitLocal('action', { from: _me.id, kind, ...payload });
  } else if (_hostConn?.open) {
    send(_hostConn, { type: MSG.ACTION, payload: { kind, ...payload } });
  }
}

export function me() { return _me; }

// Dev-only: allow tests to fake the local player identity.
if (import.meta.env && import.meta.env.DEV && typeof window !== 'undefined') {
  window.__setMe = (m) => { _me = m; };
}

export function disconnect() {
  try { _hostConn?.close(); } catch { /* ignore */ }
  _connections.clear();
  try { _peer?.destroy(); } catch { /* ignore */ }
  _peer = null;
  _hostConn = null;
  _me = null;
  connState.set({ status: 'idle', role: null, roomCode: null, peerId: null, error: null, connectedPeers: 0 });
}
