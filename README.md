# symmetrical-broccoli

A minimal, 3D, animated _Cards Against Humanity_ clone. Built with Vite + Svelte.
No login. Rooms work by 4-letter codes. Sessions persist in localStorage.

## Stack

- **Vite** — fast dev + tiny production bundles.
- **Svelte 5 (runes mode)** — compile-time reactivity, no virtual DOM.
- **PeerJS** — peer-to-peer multiplayer. The host is the room authority; guests
  connect directly to the host's peer ID derived from the room code.
- **CSS 3D transforms** — every card animation (flip, hover, drop, fan) is GPU
  accelerated. No Three.js, no canvas, no heavy animation library.

## Performance contract

- `index.html` inlines critical CSS so first paint happens with zero extra
  round-trips. Kept under 3kb raw.
- The entry JS chunk is split so the gzip size stays under **14kb**. Everything
  else — PeerJS, card data, individual views, animation helpers — is lazy
  loaded via dynamic `import()` and pre-warmed during browser idle time using
  `requestIdleCallback`.
- Page-to-page transitions use the **View Transitions API** where supported
  (no loading flash).
- All animations animate `transform` and `opacity` only — never `width`,
  `height`, `top`, or `left`.

## Card data

The canonical Cards Against Humanity dataset is fetched from
[`crhallberg/json-against-humanity`](https://github.com/crhallberg/json-against-humanity)
and split per pack into `src/lib/data/packs/<slug>.json`. Each pack is loaded
on demand so the initial bundle never pays for cards the user never selects.

CAH content is licensed under
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). This
project is non-commercial.

## Development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
npm run stats   # prints bundle sizes & verifies the 14kb target
```

## Architecture

```
src/
  main.js              # entry — mounts App, restores session, hides boot screen
  App.svelte           # top-level shell, reads route store
  lib/
    router.js          # tiny hash router with View Transitions API support
    stores/
      session.js       # localStorage + IP-bound session
      game.js          # authoritative game state (host) + mirror (guest)
    net/
      network.js       # PeerJS wrapper, message protocol
    data/
      manifest.json    # all pack metadata
      packs/           # per-pack JSON files (lazy loaded)
      packs/index.js   # metadata + async loadPack() helper
    anim/
      easing.js        # cubic-bezier arrays, spring configs, durations
      easing-helpers.js# Svelte-usable easing functions + CSS strings
    components/
      BlackCard.svelte
      WhiteCard.svelte
      Hand.svelte
      Table.svelte
    views/
      Home.svelte      # landing — create / join / resume
      Join.svelte      # join with code
      Lobby.svelte     # pre-game room, pack selection
      Game.svelte      # main game screen
      Packs.svelte     # browse all 200+ packs
```

## Animations

See [`docs/ANIMATION_GUIDE.md`](docs/ANIMATION_GUIDE.md) for the full design
spec. Key principles applied:

- **Juice over minimalism.** UI is sparse; animations are not. Every card
  interaction has anticipation, overshoot, and follow-through.
- **3D depth via `perspective` + `rotateX/Y` + `translateZ`.** Pointer-driven
  tilt on hover makes flat cards feel physical.
- **Cubic-bezier curves tuned per interaction** — `juicy [0.34, 1.56, 0.64, 1]`
  for hero moments, `settle [0.22, 1, 0.36, 1]` for arrivals, `anticipation`
  for wind-ups.
- **Reveal ceremony.** Cards enter face-down and flip on Y-axis with a slow
  ease-out so the back face is already settling by the time it's visible.
- **`prefers-reduced-motion`** disables all animations globally.

## License

Code: MIT.
Card content: CC BY-NC-SA 4.0 (Cards Against Humanity).
