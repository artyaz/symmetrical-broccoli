// game.js — Authoritative game state store (host-side) + thin client mirror
// (guest-side). All mutations flow through `dispatch()` which routes to the
// host's reducer. Guests receive snapshots via the network layer.
//
// Game phases:
//   lobby    → players join, host picks packs, host starts
//   dealing  → host shuffles deck, deals hands
//   prompt   → black card revealed, czar waits, players pick cards
//   playing  → players submit; submissions hidden until all in
//   reveal   → czar reads submissions one by one (with dramatic flip)
//   voting   → czar picks winner (or open vote if host enabled that mode)
//   scoring  → winner point awarded, animations fire
//   roundend → brief pause, next round or game over

import { writable, get } from 'svelte/store';
import { sendAction, onNetEvent, broadcastState, me as netMe } from '../net/network.js';

export const PHASE = {
  LOBBY: 'lobby',
  DEALING: 'dealing',
  PROMPT: 'prompt',
  PLAYING: 'playing',
  REVEAL: 'reveal',
  VOTING: 'voting',
  SCORING: 'scoring',
  ROUNDEND: 'roundend',
  GAMEOVER: 'gameover',
};

// The canonical state shape. Everything the UI needs is here.
const emptyState = () => ({
  version: 1,
  phase: PHASE.LOBBY,
  roomCode: null,
  hostId: null,
  czarId: null,           // who is the current Card Czar
  players: [],            // [{ id, name, score, isHost, connected, fingerprint, ip }]
  packs: ['base'],        // slugs of selected packs
  packNames: [],          // pretty names for UI
  blackCard: null,        // { text, pick }
  blackDeckCount: 0,
  whiteDeckCount: 0,
  hands: {},              // playerId → [cardText, ...]
  picks: {},              // playerId → [cardText, ...] (their submission this round)
  submissions: [],        // [{ playerId, cards: [...] }] — order shuffled for reveal
  revealedIndex: -1,      // which submission is currently being revealed
  votes: {},              // voterId → submissionIndex (open voting mode)
  votingMode: 'czar',     // 'czar' | 'open'
  round: 0,
  targetScore: 8,         // first to this many awesome points wins
  history: [],            // [{ round, blackCard, winnerId, submission }]
  czarOrder: [],          // rotated as rounds progress
  czarOrderIndex: 0,
  settings: {
    handSize: 7,
    pickTimerSec: 90,     // 0 = no timer
    openVoteAfterCzar: false,
  },
  updatedAt: 0,
});

export const game = writable(emptyState());
let _isHost = false;
let _meId = null;

// Internal: set up network listeners once.
let _wired = false;
export function wireNetwork({ isHost }) {
  if (_wired) return;
  _wired = true;
  _isHost = isHost;
  const m = netMe();
  _meId = m?.id;

  onNetEvent('action', ({ from, kind, ...payload }) => {
    if (_isHost) {
      // Host runs the reducer.
      game.update((s) => reducer(s, { from, kind, ...payload }));
      // Broadcast new state to all guests.
      broadcastState(get(game));
    }
  });

  onNetEvent('state', ({ state }) => {
    // Guest receives a fresh snapshot.
    if (!_isHost && state) {
      game.set(state);
    }
  });

  onNetEvent('peer-joined', ({ player }) => {
    if (_isHost) {
      game.update((s) => {
        if (s.players.find((p) => p.id === player.id)) return s;
        const players = [...s.players, { ...player, score: 0 }];
        const next = { ...s, players };
        broadcastState(next);
        return next;
      });
    }
  });

  onNetEvent('peer-left', ({ peerId }) => {
    if (_isHost) {
      game.update((s) => {
        const players = s.players.map((p) => p.id === peerId ? { ...p, connected: false } : p);
        const next = { ...s, players };
        broadcastState(next);
        return next;
      });
    }
  });

  onNetEvent('welcome', ({ you }) => {
    _meId = you;
  });

  onNetEvent('host-left', () => {
    // Guest side: room is dead. Show "host left" overlay.
    game.update((s) => ({ ...s, phase: PHASE.GAMEOVER, hostLeft: true }));
  });
}

// Mark that *this* client is the host (so we know to run the reducer).
export function setHostRole(isHost) {
  _isHost = isHost;
  if (isHost) {
    const m = netMe();
    _meId = m?.id;
  }
}

// Public action helpers — call these from UI components. They wrap sendAction
// so the same code path works on host (loops back) and guest (sends to host).
export const actions = {
  setRoom(code) { game.update((s) => ({ ...s, roomCode: code })); },
  setHostInfo(hostId) { game.update((s) => ({ ...s, hostId })); },
  setName(name) {
    // Local-only: stored in session, broadcast on next state.
  },
  addPack(slug, name) { sendAction('addPack', { slug, name }); },
  removePack(slug) { sendAction('removePack', { slug }); },
  setTargetScore(n) { sendAction('setTargetScore', { n }); },
  setVotingMode(mode) { sendAction('setVotingMode', { mode }); },
  startGame() { sendAction('startGame'); },
  pickCards(cardTexts) { sendAction('pickCards', { cards: cardTexts }); },
  revealNext() { sendAction('revealNext'); },
  vote(submissionIndex) { sendAction('vote', { submissionIndex }); },
  // Czar picking winner = vote with a special flag.
  czarPick(submissionIndex) { sendAction('czarPick', { submissionIndex }); },
  nextRound() { sendAction('nextRound'); },
  returnToLobby() { sendAction('returnToLobby'); },
  kick(playerId) { sendAction('kick', { playerId }); },
};

// ----- HOST REDUCER --------------------------------------------------------
// Pure function. Takes state + action, returns new state. The host broadcasts
// the result; guests just receive it.

function reducer(s, action) {
  if (!s) s = emptyState();

  switch (action.kind) {
    case 'addPack': {
      if (s.phase !== PHASE.LOBBY) return s;
      if (s.packs.includes(action.slug)) return s;
      const packs = [...s.packs, action.slug];
      const packNames = action.name ? [...s.packNames, action.name] : s.packNames;
      return { ...s, packs, packNames };
    }
    case 'removePack': {
      if (s.phase !== PHASE.LOBBY) return s;
      const idx = s.packs.indexOf(action.slug);
      if (idx === -1) return s;
      const packs = s.packs.slice();
      packs.splice(idx, 1);
      const packNames = s.packNames.slice();
      packNames.splice(idx, 1);
      return { ...s, packs, packNames };
    }
    case 'setTargetScore': {
      return { ...s, targetScore: Math.min(20, Math.max(3, action.n | 0)) };
    }
    case 'setVotingMode': {
      return { ...s, votingMode: action.mode };
    }
    case 'startGame': {
      if (s.phase !== PHASE.LOBBY) return s;
      if (s.players.length < 2) return s;
      // Build decks from selected packs (lazy import via data/packs/index.js).
      // We can't do async in reducer — instead set phase to DEALING and let
      // a side-effect build the deck. For simplicity we stash a flag.
      return { ...s, phase: PHASE.DEALING, round: 1, czarOrderIndex: 0, czarId: s.players[0].id };
    }
    case 'deckReady': {
      // Internal: host has loaded cards. Build decks + deal initial hands.
      const { blackDeck, whiteDeck } = action;
      const hands = {};
      const players = s.players.map((p) => {
        hands[p.id] = whiteDeck.splice(0, s.settings.handSize);
        return p;
      });
      const blackCard = blackDeck.shift();
      return {
        ...s,
        phase: PHASE.PROMPT,
        players,
        hands,
        blackCard,
        blackDeckCount: blackDeck.length,
        whiteDeckCount: whiteDeck.length,
        _blackDeck: blackDeck,
        _whiteDeck: whiteDeck,
        picks: {},
        submissions: [],
        revealedIndex: -1,
        votes: {},
      };
    }
    case 'pickCards': {
      if (s.phase !== PHASE.PROMPT && s.phase !== PHASE.PLAYING) return s;
      if (action.from === s.czarId) return s;
      // Remove picked cards from hand, store as their submission.
      const hand = (s.hands[action.from] || []).slice();
      const picked = action.cards || [];
      // Remove first occurrence of each picked card.
      for (const c of picked) {
        const idx = hand.indexOf(c);
        if (idx !== -1) hand.splice(idx, 1);
      }
      const picks = { ...s.picks, [action.from]: picked };
      const hands = { ...s.hands, [action.from]: hand };
      // Transition to PLAYING once at least one submission is in (so the czar
      // sees a live count). Transition to REVEAL once all non-czar players
      // have submitted.
      const nonCzarPlayers = s.players.filter((p) => p.id !== s.czarId && p.connected !== false);
      const allIn = nonCzarPlayers.every((p) => picks[p.id] && picks[p.id].length > 0);
      let phase = s.phase;
      if (allIn) phase = PHASE.REVEAL;
      else if (s.phase === PHASE.PROMPT) phase = PHASE.PLAYING;
      // When transitioning to REVEAL, shuffle submissions into a numbered list
      // so the czar doesn't know who submitted what.
      let submissions = s.submissions;
      let revealedIndex = s.revealedIndex;
      if (phase === PHASE.REVEAL && s.phase !== PHASE.REVEAL) {
        submissions = nonCzarPlayers
          .map((pid) => ({ playerId: pid, cards: picks[pid] }))
          .sort(() => Math.random() - 0.5);
        revealedIndex = -1; // czar hasn't revealed any yet
      }
      return { ...s, hands, picks, submissions, revealedIndex, phase };
    }
    case 'revealNext': {
      if (s.phase !== PHASE.REVEAL) return s;
      const next = s.revealedIndex + 1;
      if (next >= s.submissions.length) {
        // All revealed — move to voting.
        return { ...s, phase: PHASE.VOTING, revealedIndex: s.submissions.length - 1 };
      }
      return { ...s, revealedIndex: next };
    }
    case 'vote': {
      if (s.phase !== PHASE.VOTING || s.votingMode !== 'open') return s;
      const votes = { ...s.votes, [action.from]: action.submissionIndex };
      const nonCzarPlayers = s.players.filter((p) => p.id !== s.czarId && p.connected !== false);
      const allVoted = nonCzarPlayers.every((p) => votes[p.id] !== undefined);
      if (!allVoted) return { ...s, votes };
      // Tally votes → winner.
      return tallyVotes({ ...s, votes });
    }
    case 'czarPick': {
      if (s.phase !== PHASE.VOTING) return s;
      if (action.from !== s.czarId) return s;
      const sub = s.submissions[action.submissionIndex];
      if (!sub) return s;
      return awardWinner(s, sub.playerId);
    }
    case 'nextRound': {
      if (s.phase !== PHASE.ROUNDEND && s.phase !== PHASE.SCORING) return s;
      // Check game over.
      const winner = s.players.find((p) => p.score >= s.targetScore);
      if (winner) return { ...s, phase: PHASE.GAMEOVER };
      // Refill hands from white deck.
      const whiteDeck = (s._whiteDeck || []).slice();
      const hands = {};
      for (const p of s.players) {
        const hand = (s.hands[p.id] || []).slice();
        while (hand.length < s.settings.handSize && whiteDeck.length) {
          hand.push(whiteDeck.shift());
        }
        hands[p.id] = hand;
      }
      const blackDeck = (s._blackDeck || []).slice();
      const blackCard = blackDeck.shift();
      // Rotate czar.
      const czarOrderIndex = (s.czarOrderIndex + 1) % s.players.length;
      const czarId = s.players[czarOrderIndex].id;
      return {
        ...s,
        phase: PHASE.PROMPT,
        round: s.round + 1,
        czarOrderIndex,
        czarId,
        hands,
        blackCard,
        blackDeckCount: blackDeck.length,
        whiteDeckCount: whiteDeck.length,
        _blackDeck: blackDeck,
        _whiteDeck: whiteDeck,
        picks: {},
        submissions: [],
        revealedIndex: -1,
        votes: {},
      };
    }
    case 'returnToLobby': {
      const players = s.players.map((p) => ({ ...p, score: 0 }));
      return { ...emptyState(), roomCode: s.roomCode, hostId: s.hostId, players, packs: s.packs, packNames: s.packNames, targetScore: s.targetScore, votingMode: s.votingMode };
    }
    case 'kick': {
      const players = s.players.filter((p) => p.id !== action.playerId);
      return { ...s, players };
    }
    default:
      return s;
  }
}

function tallyVotes(s) {
  const counts = new Map();
  for (const idx of Object.values(s.votes)) {
    counts.set(idx, (counts.get(idx) || 0) + 1);
  }
  let bestIdx = -1;
  let bestCount = -1;
  for (const [idx, c] of counts) {
    if (c > bestCount) { bestIdx = idx; bestCount = c; }
  }
  if (bestIdx === -1) return s;
  const sub = s.submissions[bestIdx];
  if (!sub) return s;
  return awardWinner(s, sub.playerId);
}

function awardWinner(s, winnerId) {
  const players = s.players.map((p) => p.id === winnerId ? { ...p, score: p.score + 1 } : p);
  const history = [...s.history, { round: s.round, blackCard: s.blackCard, winnerId, submission: s.submissions.find((x) => x.playerId === winnerId) }];
  return { ...s, players, history, phase: PHASE.SCORING };
}

// ----- DECK BUILDER (host-side async) -------------------------------------
// Called when host enters DEALING phase. Loads selected packs, builds decks.

export async function buildAndDealDecks() {
  const s = get(game);
  if (s.phase !== PHASE.DEALING) return;
  const { loadPack } = await import('../data/packs/index.js');
  const whites = [];
  const blacks = [];
  for (const slug of s.packs) {
    try {
      const p = await loadPack(slug);
      whites.push(...p.white);
      blacks.push(...p.black);
    } catch (e) {
      console.warn(`Failed to load pack ${slug}`, e);
    }
  }
  // Shuffle (Fisher-Yates).
  for (let i = whites.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [whites[i], whites[j]] = [whites[j], whites[i]];
  }
  for (let i = blacks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [blacks[i], blacks[j]] = [blacks[j], blacks[i]];
  }
  // Dispatch as an internal action.
  game.update((cur) => reducer(cur, { kind: 'deckReady', blackDeck: blacks, whiteDeck: whites }));
  broadcastState(get(game));
}

// Subscribe to phase changes; host triggers deck build when entering DEALING.
let _lastPhase = null;
game.subscribe((s) => {
  if (s.phase === _lastPhase) return;
  _lastPhase = s.phase;
  if (_isHost && s.phase === PHASE.DEALING) {
    buildAndDealDecks();
  }
});

// Helper: get my hand from state.
export function myHand(state) {
  const m = netMe();
  return (m && state.hands?.[m.id]) || [];
}

export function myId() {
  return netMe()?.id;
}

export function isCzar(state) {
  const m = netMe();
  return m?.id === state.czarId;
}

export function amHost() {
  return _isHost;
}
