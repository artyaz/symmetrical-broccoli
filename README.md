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

## Deploy

The app is auto-deployed to **GitHub Pages** on every push to `main` by the
workflow in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).
The workflow:

1. Checks out the repo, sets up Node 22, and runs `npm ci && npm run build`.
2. Uploads `dist/` as a Pages artifact via `actions/upload-pages-artifact@v3`.
3. Deploys the artifact to the `github-pages` environment via
   `actions/deploy-pages@v4`.

The site lives at `https://artyaz.github.io/symmetrical-broccoli/`.

The `base` path is derived from `GITHUB_REPOSITORY` in
[`vite.config.js`](vite.config.js) so the same build works locally (where
`base = '/'`) and on Pages (where `base = '/symmetrical-broccoli/'`). Routing
is hash-based, so **no SPA fallback is needed** on Pages — every route lives
after the `#` and is resolved client-side.

To deploy manually (e.g. from a branch other than `main`), open the
**Actions** tab and run the "Deploy to GitHub Pages" workflow via
`workflow_dispatch`.

First-time setup (one-off, per repository): in **Settings → Pages → Build and
deployment → Source**, choose **GitHub Actions**. The workflow handles the
rest.

## Mobile

The UI is responsive down to ~360px portrait phones. Key breakpoints:

- **Cards in hand** shrink from 130×184 to 90×127 at `max-width: 640px`.
- **Hand fan arc** flattens from 3° to 1.5° per card so 7–10 small cards
  don't overlap.
- **Black card** shrinks from 200×280 to 140×196 (same 5:7 aspect ratio).
- **Submission cards** on the table shrink to match the hand cards.
- **Topbar** wraps onto multiple lines if needed; the round pill can drop to
  a second row.
- **Lobby grid** collapses to a single column at `max-width: 720px` (already
  present).
- **Touch input**: the cursor-driven 3D tilt is gated behind
  `@media (hover: hover)` and `(pointer: fine)` so it never fires on a pure
  tap. Sticky `:hover` states are avoided for the same reason.

All animations respect `prefers-reduced-motion`.

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

## Screenshots

> _Placeholder — capture after the first Pages deploy._
>
> - `docs/screenshots/home.png` — landing screen with create / join actions.
> - `docs/screenshots/lobby.png` — pre-game room with pack picker.
> - `docs/screenshots/game.png` — mid-round table with black card + fan of white cards.
> - `docs/screenshots/reveal.png` — czar reveal ceremony with read-aloud hint.
> - `docs/screenshots/mobile.png` — responsive layout on a 375px phone.

## Roadmap

What's done:

- [x] 3D animated card hover / select / play / flip / reveal
- [x] P2P multiplayer via PeerJS (host-authoritative)
- [x] 200+ CAH packs, lazy-loaded per pack
- [x] Czar-pick and open-voting modes
- [x] WebAudio synth SFX (no audio files)
- [x] Mobile-responsive layout down to ~360px
- [x] Connection status indicator + error overlay
- [x] GitHub Pages auto-deploy

What's **not** yet implemented (intentionally deferred):

- [ ] **Spectating.** No way to join a room as a non-playing observer.
- [ ] **Replay / history.** Round results aren't browsable after the fact;
      only the live `history` array is shown in the gameover screen.
- [ ] **PWA / installable.** No service worker, no `manifest.json`, no
      offline shell — the app needs network on every load.
- [ ] **Host migration.** If the host leaves, the room dies. Guests see a
      "host left the room" overlay and have to start a new room.
- [ ] **Reconnection.** A dropped peer connection (network blip) doesn't
      auto-rejoin; the user has to manually re-enter the code.
- [ ] **Account / persistence.** Scores and stats don't persist across
      rooms; the localStorage session only remembers your name + last room.
- [ ] **Card submission draft.** You can't reorder or unselect individual
      cards in a multi-pick submission before playing.
- [ ] **Accessibility audit.** Keyboard nav works for cards (Enter / Space)
      but the roster, topbar, and overlay haven't been screen-reader tested.
- [ ] **Internationalisation.** UI strings are hardcoded English.
- [ ] **Custom card packs.** No UI to load a user-supplied JSON pack.

## License

Code: MIT.
Card content: CC BY-NC-SA 4.0 (Cards Against Humanity).
