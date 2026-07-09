# Animation Guide — symmetrical-broccoli (Cards Against Humanity, 3D, Svelte)

> **Design thesis:** The UI is *really-really minimal* (Helvetica, black/white
> cards, lots of negative space). The animations are the **opposite** of
> minimal — they are the entire personality of the product. Where the page is
> silent, motion speaks. Every card touch should feel like flipping a real,
> heavy, slightly-sticky playing card across a real table.

This guide is the single source of truth for animation in the project. Every
constant referenced here is exported from
[`src/lib/anim/easing.js`](../src/lib/anim/easing.js). If you change a number,
change it there, not in your component.

---

## Table of contents

1. [Theoretical foundation](#1-theoretical-foundation)
   - 1.1 [Juice / Game Feel](#11-juice--game-feel)
   - 1.2 [Disney's 12 Principles, adapted for the web](#12-disneys-12-principles-adapted-for-the-web)
   - 1.3 [Vlambeer's "Art of Screenshake" checklist](#13-vlambeers-art-of-screenshake-checklist)
   - 1.4 [Addictive UX & the Hook Model](#14-addictive-ux--the-hook-model)
2. [Easing curves — the master table](#2-easing-curves--the-master-table)
3. [Svelte spring / tweened configs](#3-svelte-spring--tweened-configs)
4. [Timing budget](#4-timing-budget)
5. [Card-specific animation specs](#5-card-specific-animation-specs)
6. [Juice techniques: hit-stop, screen shake, particles](#6-juice-techniques-hit-stop-screen-shake-particles)
7. [Svelte + CSS implementation patterns](#7-svelte--css-implementation-patterns)
8. [Performance rules](#8-performance-rules)
9. [Anti-patterns to avoid](#9-anti-patterns-to-avoid)
10. [Accessibility & reduced motion](#10-accessibility--reduced-motion)

---

## 1. Theoretical foundation

### 1.1 Juice / Game Feel

"Juice" is the term popularised by Vlambeer's Jan Willem Nijman (GDC / INDIGO
2013, *"The Art of Screenshake"*) and expanded by countless follow-ups
(*"Juice It or Lose It"*, the GameDesign.gg knowledge base, etc.). The short
definition: **juice is every piece of feedback a game gives the player that is
not strictly required by the simulation.** A button that grows 4% on hover is
juice. A card that squashes 8% when it lands is juice. A 60 ms freeze on a
heavy play is juice.

The purpose of juice is to make every interaction feel like it has *physical
consequences*. A CAH card is a flat rectangle on a flat screen — without juice
it is a `<div>`. With juice it is a thing with mass, friction, and intent.

Five juicy principles we adopt wholesale:

1. **Squash & stretch** — On any impact the card deforms along the impact
   axis, then recovers. A card landing on the table squashes vertically
   (scaleY 0.9, scaleX 1.08) for ~80 ms then springs back.
2. **Hit-stop / freeze-frame** — A 60–120 ms pause of all motion on a
   significant event (card drop, winner reveal). The pause is *below* conscious
   perception as a "stop", but above perception as "weight". Without it the
   event feels flimsy.
3. **Screen shake** — A short, decaying camera offset. For a card game the
   intensities are *tiny* (4–12 px) compared to a shooter. Anything above
   ~16 px reads as a bug.
4. **Particle bursts** — On key beats: black/white "ink" particles on a card
   drop, confetti on a win, dust on a shuffle. 8–24 particles per burst; more
   becomes visual noise.
5. **Anticipation → action → follow-through** — Three beats, always. Wind up
   (40–80 ms), act (120–260 ms), settle (160–300 ms). A card that simply
   translates from A to B with no anticipation and no follow-through is the
   signature of a cheap web app.

### 1.2 Disney's 12 Principles, adapted for the web

Johnston & Thomas's twelve principles (originally for hand-drawn character
animation, 1981) all map cleanly onto UI. We commit to these eight:

| Principle | CAH-web translation |
|---|---|
| **Squash & stretch** | `transform: scale()` on card land / hover press |
| **Anticipation** | `easing.anticipation` curve (negative-Y bezier); a 60 ms backward translate before a card flies to centre |
| **Staging** | Only one card animates "loudly" at a time. Others dim to `opacity: 0.55` while the hero card plays. |
| **Follow-through & overlapping action** | After the played card lands, its neighbours in hand shift position 80 ms later, not simultaneously |
| **Slow in / slow out** | No `linear` easing, ever. Use `settle`, `juicy`, `reveal`. |
| **Arcs** | Cards thrown to centre follow a parabola: `translateY` peaks at mid-flight. Use the `arcPath()` helper (§7.5). |
| **Secondary action** | Subtle: the deck visibly shrinks by 1 card when one is drawn; a soft glow ring pulses on the czar's seat while they decide |
| **Timing** | Micro 120 ms / short 180 ms / medium 260 ms / long 380 ms / hero 520 ms (see §4) |

Three we de-prioritise for our specific product:

- **Solid drawing** — we are intentionally flat; the 3D comes from transforms
  only, not from painted shading.
- **Appeal** — covered by typography (Helvetica) and the strict black/white
  palette; animation doesn't fight it.
- **Straight-ahead vs. pose-to-pose** — for deterministic UI we always use
  pose-to-pose (start state, end state, in-between easing).

### 1.3 Vlambeer's "Art of Screenshake" checklist

Direct from Nijman's talk, mapped to our card interactions:

| Vlambeer technique | Where we use it |
|---|---|
| Screen shake | Card drop on table (4 px), winner reveal (12 px) |
| Hit pause | Czar selects winner — 90 ms full freeze |
| Particle bursts | Card lands (ink), winner reveal (confetti) |
| Color flash | Black card → white flash on reveal; subtle `filter: brightness(1.4)` for 1 frame |
| Camera kick | Brief `translateX(2px)` on card collision in the play area |
| Knockback | Played cards push the deck back 6 px then spring back |
| Sound (always!) | Audio + visual must align; see §6.4 |
| Bigger recoil than expected | Card selected scales 1.08 → 1.0 instead of 1.02 |
| Animation frames | Add 1 frame of squash on impact, even if the rest is procedural |
| Stretched frames | Card in mid-flight stretches ~5% along travel axis |

### 1.4 Addictive UX & the Hook Model

Nir Eyal's *Hooked* model is a four-step loop: **Trigger → Action → Variable
Reward → Investment**. Applied ethically to a party card game (we are not
building a slot machine — but we want the loop to *feel* rewarding):

1. **Trigger.** External (a friend invites you / it's your turn notification)
   and internal (the satisfying *thunk* you remember from last round). The
   game's audio-visual identity *is* the internal trigger.
2. **Action.** The simplest action possible: click a card. The friction must
   be near-zero — single click, no confirmation modal.
3. **Variable reward.** CAH has this built in: you never know what card you'll
   draw, you never know what the czar will pick. **Our job is to amplify the
   reveal moment** — a card drawn from the deck should feel like opening a
   booster pack, not like a list item appearing. Use `easing.reveal` + a
   90 ms hit-stop + an ink-burst of 12 particles.
4. **Investment.** Players invest by selecting cards, by being czar, by
   earning "Awesome Points". The score counter should *count up* with a tween
   (`tweenConfig('scoreCount', easing.juicy)`) rather than snap, so the
   investment feels like it accrues.

Related addictive-UX mechanics we deliberately adopt (all reinforce the loop,
none exploit the player — there's no money and no FOMO timer):

- **Near-miss effect.** When the czar is choosing between cards, your card
  visibly "almost wins" — a subtle glow pulse 200 ms before the winner is
  revealed. If yours isn't picked, the glow dies. If yours is picked, the
  glow explodes into confetti.
- **Anticipation builds dopamine.** The 400–600 ms before a card flips is
  *intentional* delay. Don't compress it. Players' dopamine peaks during
  anticipation, not during resolution.
- **Sensory feedback loop.** Every visual beat has a paired audio beat at the
  same millisecond. Visual alone is 30% as satisfying.
- **Celebration on small wins.** Even picking a card from your hand to play
  gets a 4 px shake + ink burst. The micro-loop must close every time.
- **Loss aversion.** When a card is "spent" to the discard pile, it does not
  just disappear — it falls with `easing.drop`, rotates, and fades. Losing a
  card should feel like losing something, not like clearing a list item.

---

## 2. Easing curves — the master table

All values are `[x1, y1, x2, y2]` (cubic-bezier control points). Y values
outside `[0,1]` produce overshoot / wind-up. X must stay in `[0,1]` per the
CSS spec. These live in `src/lib/anim/easing.js` under `easing`.

| Name | Bezier | Use it for | Why this curve |
|---|---|---|---|
| `juicy` | `[0.34, 1.56, 0.64, 1]` | Hero moments: card lands, score pops, button confirm | Classic back-out. Overshoots ~14% then settles. The signature "this thing has weight" curve. |
| `snap` | `[0.85, 0, 0.15, 1]` | Toggle states, fast UI feedback, hover-out | No overshoot. Symmetric S-curve compressed in time — feels like a physical switch. |
| `settle` | `[0.22, 1, 0.36, 1]` | Cards dealt into hand, panels opening, generic "arrival" | Smooth expo-out. Fast start, gentle landing. |
| `anticipation` | `[0.4, 0, 0.6, -1]` | Wind-up before a primary action (card about to fly to centre) | Negative Y means the value *decreases* before increasing — the card pulls back ~20% then lunges. |
| `bounce` | `[0.68, -0.55, 0.265, 1.55]` | "You won" pulses, bouncy reveals | Both control points outside `[0,1]` → overshoots on both ends. Use sparingly; loud. |
| `whip` | `[0.55, 0, 0.1, 1]` | Card thrown toward table — fast in, slow out | The "throw" feel: most velocity at the start, decelerating into land. |
| `drop` | `[0.55, 0.085, 0.68, 0.53]` | Card falling into discard pile | Ease-in. Gravity is doing this — it should accelerate. |
| `lift` | `[0.25, 0.46, 0.45, 0.94]` | Hover-lift on a card in hand | Gentle ease-out, no overshoot — the card rises smoothly toward the cursor. |
| `easeInOutBack` | `[0.68, -0.6, 0.32, 1.6]` | Symmetric reveals (panel open + close pair) | Overshoots on enter and exit. Use for two-way transitions. |
| `reveal` | `[0.16, 1, 0.3, 1]` | 3D card flip — the back-face settle | Long ease-out so by the time the back face is visible it's already decelerating, giving the impression the card "snapped" into its rest state. |
| `subtleshake` | `[0.36, 0, 0.66, -0.56]` | Inner keyframes of a screen-shake burst | Negative mid-curve gives the shake an asymmetric "punch then recoil" feel. |

**Rule of thumb:** if you're about to type `ease` or `linear`, stop. Pick a
named curve from this table. There is no scenario in this project where the
browser default is correct.

---

## 3. Svelte spring / tweened configs

Svelte's `spring(initial, { stiffness, damping, precision })` is the workhorse
for continuous, interruptible motion (card hover, hand fan, screen-shake
offset). `tweened()` is for fixed-duration transitions (card flip, panel
open).

Defaults in Svelte: `stiffness: 0.15`, `damping: 0.8`. We override per use-case.

| Name | Config | Use it for | Notes |
|---|---|---|---|
| `cardHover` | `{ stiffness: 0.28, damping: 0.55 }` | Card lift toward cursor | Stiff enough to feel responsive, low damping gives one small overshoot |
| `cardSelect` | `{ stiffness: 0.40, damping: 0.45 }` | Selected-card pulse ring | High stiffness + low damping = clear "thunk" with visible bounce |
| `cardPlay` | `{ stiffness: 0.12, damping: 0.35 }` | Card flies to centre | Loose spring = long travel, weighty oscillation |
| `handFan` | `{ stiffness: 0.09, damping: 0.82 }` | Neighbours rearrange on add/remove | Smooth and slow; high damping so they glide |
| `deckShuffle` | `{ stiffness: 0.55, damping: 0.25 }` | Deck jitter during shuffle | High stiffness + low damping = tight erratic motion |
| `flipReveal` | `{ stiffness: 0.18, damping: 0.72 }` | 3D flip back-to-front | Settles with no visible bounce — flip should snap, not jiggle |
| `winnerFlyTo` | `{ stiffness: 0.06, damping: 0.50 }` | Winning card flies to winner avatar | Very loose = long celebratory arc |
| `screenShake` | `{ stiffness: 0.50, damping: 0.30 }` | Camera offset for shake bursts | Stiff so the camera returns to (0,0) between impulses |
| `ambient` | `{ stiffness: 0.10, damping: 0.85 }` | Score counters, idle drift | Soft, no overshoot — background motion |

These are exported as the `springs` object. Spread straight into a store:

```js
import { spring } from 'svelte/motion';
import { springs } from '$lib/anim/easing';
const hover = spring(0, springs.cardHover);
```

---

## 4. Timing budget

| Token | ms | Use |
|---|---|---|
| `micro` | 120 | Glow pulse, hover state change, button press |
| `short` | 180 | Small lift, toggle, hover-out |
| `medium` | 260 | Card lift into hand, panel open |
| `long` | 380 | Card flip reveal |
| `hero` | 520 | Winner fly-to, round-end celebration |
| `hitStop` | 90 | Freeze-frame on heavy card drop / czar select |
| `screenShake` | 240 | Total envelope of a shake burst |

Rules:

- **Micro-interactions must stay ≤ 300 ms.** Anything longer feels sluggish.
- **Hero moments may go up to 600 ms.** Beyond 600 ms players assume the app
  is loading, not animating.
- **Hit-stop is never > 120 ms.** Past that it reads as a freeze bug.
- **Anticipation windows are 40–80 ms.** Just long enough to register as
  "something is about to happen".

---

## 5. Card-specific animation specs

For each interaction: the properties animated, the easing/spring used, the
duration, and the juice layered on top.

### 5.1 Card draw (from deck to hand)

| Phase | Property | From → To | Curve | Duration |
|---|---|---|---|---|
| Anticipation | `translateY` + `scale` | 0 → -4px, 1.0 → 0.98 | `anticipation` | 60 ms |
| Travel | `translateX/Y` + `rotateZ` | deck pos → hand slot, 0 → -6deg | `settle` | 260 ms |
| Overshoot | `rotateZ` | -6 → -8 → -6deg | `juicy` (via spring `cardPlay`) | ~120 ms tail |
| Land | `scaleX/Y` squash | 1.0 → (0.94, 1.06) → 1.0 | `juicy` | 80 ms |

Juice:
- 8 ink particles burst at the deck position at the start of travel.
- Subtle `filter: brightness(1.15)` flash on the card for 1 frame as it leaves
  the deck (one of Vlambeer's "stretched frames" translated to web).
- The deck `scaleY` dips by ~2% for 100 ms — mass leaving.

### 5.2 Card hover in hand (lift + tilt + glow)

Three properties driven by Svelte springs (`cardHover` config):

| Property | Driven by | Range |
|---|---|---|
| `translateZ` | on/off (0 / `card3d.hoverLiftZ`) | 0 → 60px |
| `rotateX` | cursor Y inside card | -12 → 12 deg |
| `rotateY` | cursor X inside card | -12 → 12 deg |
| `box-shadow` | hover state | 0 → `0 12px 30px rgba(0,0,0,0.45)` + inner glow |

The two neighbours of the hovered card nudge outward by ~12 px each on the X
axis using `handFan` spring — overlap with primary action (Disney principle 5).

Glow ring: a `::after` pseudo-element with `border-radius: 50%; opacity: 0.0 → 0.6`
pulsing with `easing.juicy` at `micro` duration, repeating every 1.6 s while
hovered.

### 5.3 Card select (pulse + glow ring)

| Phase | Property | Curve | Duration |
|---|---|---|---|
| Pulse out | `scale` 1.0 → 1.08 | `juicy` | 140 ms |
| Pulse in | `scale` 1.08 → 1.0 | `settle` | 180 ms |
| Ring expand | `::after` scale 0.6 → 1.6, opacity 0.8 → 0 | `snap` | 360 ms |
| Hit-stop | (whole app) | — | 90 ms |

The hit-stop here is *deliberately disruptive* — selecting a card is the
single most common consequential action; it deserves weight.

### 5.4 Card play (fly to centre, arc, land with squash)

Three beats, total ~700 ms:

1. **Anticipation (60 ms).** Card pulls back 16 px toward player, scales to
   0.96, `easing.anticipation`.
2. **Travel (260 ms).** Card follows a parabolic arc to the centre slot.
   `translateX` linear-in-time, `translateY` is `-(4*h*(t-t²))` where `h` is
   arc height (~120 px). `rotateZ` goes 0 → ±15deg (sign depends on which
   side the card started). Mid-flight, `scaleY` stretches to 1.06 (Vlambeer's
   "stretched frames"). `easing.whip` on the X translation.
3. **Land (80 ms + 200 ms settle).** On landing: `scaleX 1.08, scaleY 0.9`
   squash for 80 ms (`juicy`), then spring back to 1.0 over 200 ms
   (`springs.cardPlay`). Trigger 4 px screen-shake + 12 ink particles +
   90 ms hit-stop.

### 5.5 Card flip reveal (3D Y-axis rotation)

CSS 3D: parent has `perspective: 1200px`, card has `transform-style: preserve-3d`,
front face at `rotateY(0)`, back face at `rotateY(180deg)`, both
`backface-visibility: hidden`.

| Phase | Property | Curve | Duration |
|---|---|---|---|
| Wind-up | `rotateY` 0 → -8deg | `anticipation` | 80 ms |
| Flip | `rotateY` -8 → 180deg | `reveal` | 380 ms |
| Settle | `translateZ` 0 → 8 → 0 | `juicy` | 200 ms tail |

While flipping:
- A shadow on the ground beneath the card scales with `sin(rotateY)` —
  widest at 90°, narrowest at 0°/180°. Communicates real 3D depth.
- `filter: brightness(1.4)` peak at the 90° mark (card edge-on, "catching the
  light"), settles back to 1.0.
- 90 ms hit-stop *exactly* at the 180° mark so the new face lands with a
  freeze.

### 5.6 Card stack / shuffle (Z-jitter)

Deck visibly "riffles": top 5 cards get small `translateZ` 0 → 4 → -4 → 0 px
offsets with randomised 40–80 ms delays, `springs.deckShuffle`, total
duration 600–900 ms. Each card also gets a tiny `rotateZ` ±1.5deg jitter.
No screen shake — too loud for a routine action. Optional: soft paper-shuffle
audio bed (looped) under the visual.

### 5.7 Winner reveal (spotlight + confetti + fly-to)

The single biggest moment in a round. Sequence (total ~1.8 s):

1. **Dim** (200 ms): all non-winning cards `opacity 1.0 → 0.25` with `settle`.
2. **Spotlight** (300 ms): a radial-gradient `::before` overlay on the
   winning card scales 0 → 1.4, `juicy`, with a soft `backdrop-filter: blur()`
   ring expanding behind it.
3. **Confetti** (1200 ms): 24 particles spawned from the winning card's
   centre, each with random velocity, rotation, and gravity. Mix of black and
   white "ink" particles plus a few accent hues (kept very desaturated to
   respect the minimal palette). Particle lifetime 800–1200 ms.
4. **Fly-to** (520 ms): the winning card flies toward the winner's avatar in
   a long arc using `springs.winnerFlyTo`. Card scales 1.0 → 0.4 as it
   approaches the avatar (perspective trick).
5. **Screen shake** (`shakePresets.winnerReveal`): 12 px decaying over 480 ms.
6. **Hit-stop**: 120 ms at the moment the card "merges" with the avatar.
7. **Score increment**: the winner's Awesome Points counter tweens up using
   `tweenConfig('scoreCount', easing.juicy)` — never a snap.

### 5.8 Hand fan (arc arrangement, hover expands neighbours)

Cards arranged on an arc. For a hand of N cards:

```
angle_i = -maxAngle/2 + (i / (N-1)) * maxAngle    // maxAngle ≈ 24deg for N≤7
x_i = sin(angle_i) * radius
y_i = (1 - cos(angle_i)) * radius                  // parabolic dip
rotateZ_i = angle_i
```

Where `radius ≈ 900px` (large radius → gentle arc). On hover of card `k`:

- Card `k`: full lift (§5.2).
- Cards `k-1` and `k+1`: `translateY += 8px`, `rotateZ` nudges ±2deg away.
- Cards further out: smaller nudge, falling off as `1/distance`.

All driven by `springs.handFan` so the whole hand rearranges fluidly. The
expansion is *secondary action* (Disney 7) — it supports the primary hover
without competing.

---

## 6. Juice techniques: hit-stop, screen shake, particles

### 6.1 Hit-stop (freeze-frame)

A programmatic pause of the entire animation state. Implementation:

```js
// $lib/anim/hitStop.js (sketch)
import { get } from 'svelte/store';

export function hitStop(ms = 90) {
  // Set a global "frozen" flag that gates every motion store .set() call.
  // For pure-CSS animations, attach a class that sets animation-play-state: paused.
  frozen.set(true);
  setTimeout(() => frozen.set(false), ms);
}
```

When `frozen` is true:
- All `spring.set()` calls are queued, not applied.
- All CSS animations get `animation-play-state: paused` via a `body.frozen`
  selector.
- Network messages still flow — only visuals freeze.

Use hit-stop on: card select (90 ms), card land (80 ms), winner reveal peak
(120 ms), czar hover on a candidate (40 ms — *very* short, just a "hiccup").

### 6.2 Screen shake

Decaying random offset applied to the camera wrapper. Three presets in
`shakePresets` (`cardDrop`, `cardSelect`, `winnerReveal`). Implementation
sketch:

```svelte
<script>
  import { spring } from 'svelte/motion';
  import { springs, shakePresets } from '$lib/anim/easing';

  const camX = spring(0, springs.screenShake);
  const camY = spring(0, springs.screenShake);

  export function shake(preset = 'cardDrop') {
    const { intensity, decay, durationMs } = shakePresets[preset];
    const steps = Math.floor(durationMs / 50);
    let step = 0;
    const interval = setInterval(() => {
      const decayed = intensity * Math.pow(decay, step);
      camX.set((Math.random() - 0.5) * 2 * decayed);
      camY.set((Math.random() - 0.5) * 2 * decayed);
      step++;
      if (step > steps) {
        clearInterval(interval);
        camX.set(0); camY.set(0);
      }
    }, 50);
  }
</script>

<div class="camera" style="transform: translate({$camX}px, {$camY}px)">
  <slot />
</div>
```

**Critical:** keep intensities tiny. 4 px is plenty for a card drop. Players
should feel the shake, not notice it. Anything above 16 px reads as a bug.

### 6.3 Particle bursts

A particle pool (no per-frame allocation). Each burst spawns 8–24 particles
with: position, velocity, lifetime, rotation, size, color. Rendered to a
single `<canvas>` overlay OR as recycled DOM nodes (`<div>`s in a pool of 64).

For CAH, particles are ink-themed: black or white circles with
`mix-blend-mode: difference` so they read on either card color. On winner
reveal, swap to small rectangles of paper (confetti).

A particle needs: spawn at impact point, initial velocity 60–200 px/s, gravity
~400 px/s², drag ~0.92, lifetime 400–1200 ms, fade-out in last 200 ms.

### 6.4 Audio-visual pairing

Every visual beat has a paired audio beat at the *same millisecond*. Library
recommendation: use the Web Audio API for short procedurally-generated sounds
(60 ms noise burst = card land; 200 ms filtered sawtooth = card flip; melodic
arpeggio = winner). Audio must respect the same `frozen` flag as visuals
during hit-stop.

The cardinal rule: **a visual without audio is 30% as satisfying.** An audio
without a visual is confusing. Pair them, always.

---

## 7. Svelte + CSS implementation patterns

### 7.1 The 3D card shell

```svelte
<!-- Card.svelte (sketch) -->
<script>
  import { spring } from 'svelte/motion';
  import { springs, card3d, easing, duration } from '$lib/anim/easing';

  export let flipped = false;
  const rotY = spring(0, springs.flipReveal);
  $: rotY.set(flipped ? 180 : 0);

  const lift = spring(0, springs.cardHover);
  const tiltX = spring(0, springs.cardHover);
  const tiltY = spring(0, springs.cardHover);

  function onMove(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width  - 0.5;
    const py = (e.clientY - r.top)  / r.height - 0.5;
    tiltY.set(px * card3d.hoverTiltMax * 2);
    tiltX.set(-py * card3d.hoverTiltMax * 2);
  }
  function onEnter() { lift.set(card3d.hoverLiftZ); }
  function onLeave() { lift.set(0); tiltX.set(0); tiltY.set(0); }
</script>

<div class="card-3d"
  style="transform: rotateX({$tiltX}deg) rotateY({$tiltY}deg) translateZ({$lift}px)"
  on:mouseenter={onEnter}
  on:mouseleave={onLeave}
  on:mousemove={onMove}
>
  <div class="flipper" style="transform: rotateY({$rotY}deg)">
    <div class="face front"><slot name="front" /></div>
    <div class="face back"><slot name="back" /></div>
  </div>
</div>

<style>
  .card-3d {
    transform-style: preserve-3d;
    will-change: transform;
    transition: filter 120ms linear; /* brightness flash */
  }
  .flipper {
    position: relative;
    width: 100%; height: 100%;
    transform-style: preserve-3d;
    transition: transform 380ms cubic-bezier(/* easing.reveal */ 0.16,1,0.3,1);
  }
  .face {
    position: absolute; inset: 0;
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
    border-radius: 8px;
  }
  .back { transform: rotateY(180deg); }
  /* parent of .card-3d must have perspective: 1200px */
</style>
```

### 7.2 Using `in:` / `out:` / `transition:` with custom easing

Svelte transitions accept an `easing` function. Use the `cubicBezierArray`
helper to convert the named curves:

```svelte
<script>
  import { fly, scale } from 'svelte/transition';
  import { cubicBezierArray, easing, duration } from '$lib/anim/easing';
  const juicy = cubicBezierArray(easing.juicy);
</script>

{#if visible}
  <div in:fly={{ y: 24, duration: duration.medium, easing: juicy }}
       out:fly={{ y: -16, duration: duration.short, easing: juicy }}>
    Card dealt
  </div>
{/if}
```

### 7.3 `crossfade` for card moving between hand and table

```js
import { crossfade } from 'svelte/transition';
import { cubicBezierArray, easing, duration } from '$lib/anim/easing';

const juicy = cubicBezierArray(easing.juicy);
export const [send, receive] = crossfade({
  duration: duration.medium,
  easing: juicy,
  fallback: () => ({ duration: duration.short, easing: juicy }),
});
```

Then in templates: `<div in:receive out:send>` on every card. When a card
moves from hand to table, Svelte will animate it directly between positions.

### 7.4 Web Animations API for imperative one-shots

When you need to fire a sequence (anticipation → travel → land) imperatively
rather than reactively, use `element.animate()`:

```js
import { easing, duration } from '$lib/anim/easing';

export function playCard(el, from, to) {
  const juicy = easing.juicy.join(',');
  const whip  = easing.whip.join(',');
  const antic = easing.anticipation.join(',');

  el.animate([
    { transform: `translate(${from.x}px, ${from.y}px) scale(0.96)`, offset: 0 },
    { transform: `translate(${from.x}px, ${from.y - 16}px) scale(0.96)`, offset: 0.08 }, // wind-up
    { transform: `translate(${to.x}px, ${to.y - 120}px) scale(1.06) rotate(8deg)`, offset: 0.5 }, // arc peak
    { transform: `translate(${to.x}px, ${to.y}px) scale(1.08, 0.9) rotate(0)`, offset: 0.85 }, // squash
    { transform: `translate(${to.x}px, ${to.y}px) scale(1) rotate(0)`, offset: 1 },
  ], {
    duration: duration.medium + duration.short,
    easing: 'cubic-bezier(' + whip + ')', // overall; per-segment via offset
    fill: 'forwards',
  });
}
```

### 7.5 `arcPath()` helper for parabolic flight

```js
// $lib/anim/arc.js
export function arcPath(from, to, height = 120) {
  return (t) => {
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t - 4 * height * t * (1 - t);
    return { x, y };
  };
}
```

Feed `t` from a `tweened(0 → 1)` to drive both X and Y along an arc.

### 7.6 CSS keyframes for ambient animations

For non-interactive ambient motion (subtle deck breathing, czar's seat glow
pulse), use plain CSS `@keyframes` so they don't consume a Svelte store:

```css
@keyframes deck-breathe {
  0%, 100% { transform: translateZ(0) scale(1); }
  50%      { transform: translateZ(8px) scale(1.005); }
}
.deck { animation: deck-breathe 3.2s cubic-bezier(0.22,1,0.36,1) infinite; }

@keyframes czar-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0); }
  50%      { box-shadow: 0 0 24px 4px rgba(255,255,255,0.18); }
}
.czar-seat { animation: czar-glow 1.8s cubic-bezier(0.34,1.56,0.64,1) infinite; }
```

### 7.7 View Transitions API for round-to-round

For SvelteKit (or Svelte 5 with a router that supports it), use the View
Transitions API for the page-level swap between rounds:

```svelte
<!-- +layout.svelte -->
<script>
  import { beforeNavigate } from '$app/navigation';
  beforeNavigate(({ to, from }) => {
    if (!document.startViewTransition) return;
    // Default browser transition is fine; override in CSS:
  });
</script>

<style>
  :root::view-transition-old(root) {
    animation: 260ms cubic-bezier(0.22, 1, 0.36, 1) both fade-out;
  }
  :root::view-transition-new(root) {
    animation: 380ms cubic-bezier(0.16, 1, 0.30, 1) both fade-in;
  }
  @keyframes fade-out { to { opacity: 0; transform: scale(0.98); } }
  @keyframes fade-in  { from { opacity: 0; transform: scale(1.02); } }
</style>
```

Note: View Transitions don't replace per-element `crossfade` for cards moving
within a single view — use both, scoped to their respective layers.

### 7.8 Glass / backdrop-filter

For the czar's seat and any modal overlay:

```css
.glass {
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(12px) saturate(140%);
  -webkit-backdrop-filter: blur(12px) saturate(140%);
}
```

Animate `backdrop-filter` sparingly — it is GPU-expensive. Animate `opacity`
of the overlay instead; let the blur be static.

---

## 8. Performance rules

1. **Animate only GPU-friendly properties.** `transform`, `opacity`,
   `filter`, `backdrop-filter`. Never `top`, `left`, `width`, `height`,
   `margin`, `padding`, `border-width`. Layout reflows kill 60fps.
2. **`will-change` is a hint, not a brute-force tool.** Add it just before an
   animation starts, remove it after it ends. Leaving `will-change: transform`
   on 200 cards permanently burns memory and can *slow down* the page.
   ```js
   el.style.willChange = 'transform';
   el.addEventListener('transitionend', () => el.style.willChange = 'auto', { once: true });
   ```
3. **Promote to a layer once, reuse it.** A card that will be hovered/played
   should get `transform: translateZ(0)` (or `will-change: transform`) at
   mount, not on hover.
4. **Cap simultaneous animations.** More than ~12 elements animating
   `transform` at once will drop frames on mid-range hardware. If the whole
   hand (7 cards) hovers at once (it shouldn't), stagger them.
5. **Avoid animating `filter` and `backdrop-filter` continuously.** They are
   expensive. Animate `opacity` of a layered element instead. The one
   exception: the brightness flash on card flip is a single-frame change, not
   a continuous animation — that's fine.
6. **Prefer `spring()` over `tweened()` for interruptible motion.** Springs
   handle velocity hand-off when interrupted; tweens re-aim from current
   position but lose momentum. Use `tweened` only for fixed-duration reveals.
7. **Pool DOM for particles.** Never `appendChild` 24 nodes per burst. Keep a
   pool of 64 absolutely-positioned `<div>`s and recycle them. Or use a
   single `<canvas>`.
8. **Audio decoding is async.** Pre-decode all sounds at app boot. Triggering
   an audio decode mid-animation will stall the visual.
9. **Respect `prefers-reduced-motion`.** See §10.
10. **Measure.** The Chrome Performance panel → "Animations" track. Target
    60fps with < 4ms per frame budget. If a card flip drops a frame, the
    flip is too long or animating too many properties.

---

## 9. Anti-patterns to avoid

| Anti-pattern | Why it's bad | Do this instead |
|---|---|---|
| `linear` easing | Reads as mechanical / cheap | Pick from `easing` table |
| `ease`, `ease-in-out` defaults | Boring, no personality | Same — pick a named curve |
| Animating `top` / `left` / `width` | Triggers layout reflow | Use `transform: translate()` / `scale()` |
| `transition: all 200ms` | Animates *everything*, including unrelated props; surprises | List specific properties |
| Micro-interaction > 300 ms | Feels sluggish | Use the `duration` table |
| Hero animation > 600 ms | Reads as loading | Cap at `duration.hero` (520 ms) |
| Screen shake > 16 px | Reads as a bug | Use `shakePresets`, never exceed 12 px |
| More than 1 hero card animating at a time | Loses staging | Dim others to `opacity: 0.55` |
| Confetti without gravity | Looks like a screensaver, not a celebration | `gravity: 400 px/s²`, `drag: 0.92` |
| Particle count > 24 per burst | Visual noise | Cap at 24, lower for routine events |
| `will-change` set permanently | Memory leak / GPU thrash | Add on enter, remove on end |
| Audio not synced to visual | Breaks the feedback loop | Same-millisecond pairing |
| Animation without purpose | Every animation must communicate *something* (state change, feedback, hierarchy) | If unsure, cut it |
| Animating `box-shadow` directly | Forces repaint on every frame | Layer a `::after` with the shadow, animate its `opacity` |
| Pausing the network during hit-stop | Causes desync in multiplayer | Freeze visuals only, let network flow |

---

## 10. Accessibility & reduced motion

Not every player can handle rapid motion. Respect
`prefers-reduced-motion: reduce`:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

Plus, in JS:

```js
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export function shake(preset) {
  if (reduced) return; // skip shake entirely
  // ...
}
```

Strategy:

- **Keep state changes legible.** A card flip becomes an instant swap; the
  state change still communicates.
- **Keep audio.** Reduced-motion players still get the audio-visual pairing
  via audio alone.
- **Never remove feedback.** The card still gets selected, the score still
  increments — just without the long motion path. Use `tweened` with
  `duration: 1ms` rather than skipping the update entirely.

### Flash thresholds

Avoid more than 3 flashes per second anywhere on screen. Our pulses are
1.6 s+ period, well under the threshold.

---

## Appendix A — File map

```
src/lib/anim/
├── easing.js          ← all constants (cubic-bezier, springs, durations, 3D, shakes)
├── hitStop.js         ← freeze-frame helper (TODO, see §6.1)
├── arc.js             ← arcPath() helper (TODO, see §7.5)
├── particles.js       ← particle pool (TODO, see §6.3)
├── shake.js           ← shake() helper (TODO, see §6.2)
└── audio.js           ← Web Audio one-shots (TODO, see §6.4)
```

`easing.js` is the only file produced by this research task; the others are
stubbed here so the team knows where the matching implementations will live.

## Appendix B — References

- Jan Willem Nijman (Vlambeer), *"The Art of Screenshake"*, INDIGO Classes 2013 — https://www.youtube.com/watch?v=AJdEqssNZ-U
- *"Juice It or Lose It"* talk — https://www.youtube.com/watch?v=Fy0aCDmgnxg
- *"Secrets of Game Feel and Juice"* — https://www.youtube.com/watch?v=216_5nu4aVQ
- Disney's 12 principles (Wikipedia) — https://en.wikipedia.org/wiki/Twelve_basic_principles_of_animation
- Nir Eyal, *"Hooked: How to Build Habit-Forming Products"* — https://www.nirandfar.com/how-to-manufacture-desire
- Svelte `svelte/motion` docs (spring, tweened) — https://svelte.dev/docs/svelte/svelte-motion
- Svelte `svelte/transition` docs (crossfade, fly, scale) — https://svelte.dev/docs/svelte/transition
- SvelteKit View Transitions — https://svelte.dev/blog/view-transitions
- MDN `cubic-bezier()` — https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/easing-function/cubic-bezier
- easings.net cheat sheet — https://easings.net
- Josh W. Comeau, *"Springs and Bounces in Native CSS"* — https://www.joshwcomeau.com/animation/linear-timing-function/
- David DeSandro, *"Intro to CSS 3D transforms"* — https://3dtransforms.desandro.com/card-flip
- MDN `Element.animate()` (Web Animations API) — https://developer.mozilla.org/en-US/docs/Web/API/Element/animate
- Smashing Magazine, *"CSS GPU Animation: Doing It Right"* — https://www.smashingmagazine.com/2016/12/gpu-animation-doing-it-right
- CritPoints on hit-stop / hitlag — https://critpoints.net/2017/05/17/hitstophitfreezehitlaghitpausehitshit
