# Research: Rebuilding the 3D Layer Properly

> **Purpose.** This document is a working research brief for the next
> implementation pass of the 3D game view in `symmetrical-broccoli`. It is
> written by the AI for the AI — not a polished user-facing doc. Every section
> ends with concrete, actionable guidance that informs the next commit.
>
> **Scope.** Medium dive (~30 pages). Three.js stays. All seven problem areas
> the user flagged are covered: avatar design, card rendering, resolution +
> performance, hand visibility, shadow quality, object quality, animation
> feel. Plus a major chapter on AI-assisted 3D game development.
>
> **Citations.** Heavy. SIGGRAPH papers, GDC talks, Disney canon, Three.js
> forum threads, and 2026-vintage AI tooling landscape. URLs included
> inline so they can be clicked, not looked up.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Diagnosis: Why the Current Implementation Looks Bad](#2-diagnosis-why-the-current-implementation-looks-bad)
3. [Rendering Fundamentals: Resolution, DPR, Antialiasing, Frame Pacing](#3-rendering-fundamentals-resolution-dpr-antialiasing-frame-pacing)
4. [Shadow Quality: From PCF to PCSS to CSM](#4-shadow-quality-from-pcf-to-pcss-to-csm)
5. [PBR Materials and Object Quality](#5-pbr-materials-and-object-quality)
6. [Card Rendering: Z-Fighting, Textures, Text](#6-card-rendering-z-fighting-textures-text)
7. [First-Person Hand Rendering](#7-first-person-hand-rendering)
8. [Avatar Design: Escaping the Restroom Icon](#8-avatar-design-escaping-the-restroom-icon)
9. [Animation Feel: Disney 12, Vlambeer, Spring Physics](#9-animation-feel-disney-12-vlambeer-spring-physics)
10. [AI-Assisted 3D Game Development](#10-ai-assisted-3d-game-development)
11. [Performance Budget](#11-performance-budget)
12. [Implementation Roadmap](#12-implementation-roadmap)
13. [References](#13-references)

---

## 1. Executive Summary

The current 3D view in `src/lib/views/Game3D.svelte` and `src/lib/three/*`
fails on seven fronts the user correctly identified:

| # | Symptom | Root Cause (one-liner) | Section |
|---|---------|------------------------|---------|
| 1 | Players look like restroom icons | Sphere + cone silhouette matches ISO 7001 pictogram; no neck, no gesture, no asymmetric anchor | [§8](#8-avatar-design-escaping-the-restroom-icon) |
| 2 | Cards stuck in table | Cards at `y=0.03` with no polygon offset, z-fighting against the table plane at `y=0.02` | [§6](#6-card-rendering-z-fighting-textures-text) |
| 3 | Cards enormously large | 0.7 × 1.0 world units — that's 70% of the table radius; should be ~0.35 × 0.50 | [§6](#6-card-rendering-z-fighting-textures-text) |
| 4 | Low resolution / unplayable | `setPixelRatio(window.devicePixelRatio)` not clamped; on 2× DPR the GPU touches 4× the pixels but the canvas CSS size is wrong | [§3](#3-rendering-fundamentals-resolution-dpr-antialiasing-frame-pacing) |
| 5 | Can't see own cards on join | No viewmodel camera layer; hand cards render in world space and get clipped by the near plane or occluded by the table | [§7](#7-first-person-hand-rendering) |
| 6 | Poor shadows + cheap objects | `PCFSoftShadowMap` with 2048² map covering ±4 units → effective shadow resolution ~256px per meter; no PBR, no post-processing, no bevels | [§4](#4-shadow-quality-from-pcf-to-pcss-to-csm), [§5](#5-pbr-materials-and-object-quality) |
| 7 | Screen shuttering | rAF loop is throttled to 60Hz on 144Hz monitors (144 not divisible by 60 → permanent stutter); also no fixed-timestep accumulator | [§3](#3-rendering-fundamentals-resolution-dpr-antialiasing-frame-pacing), [§9](#9-animation-feel-disney-12-vlambeer-spring-physics) |

**The fix is not incremental.** Each problem compounds the others: low
resolution makes the cheap shadows look worse, the bad shadows make the
card-on-table z-fighting more visible, the z-fighting makes the cards look
stuck, the stuck cards make the hand invisible, the invisible hand makes the
player feel disconnected, the disconnection makes the restroom-icon avatars
stand out more. We need to rebuild the 3D layer with a coherent rendering
pipeline, not patch individual symptoms.

**The recommended approach** (detailed in §12):

1. **Rendering pipeline**: clamp DPR to 1.5–2.0, add TAA via `pmndrs/postprocessing`, use ACES Filmic tone mapping + UnrealBloomPass + N8AO for ambient occlusion. Kill the rAF throttle — let it run at native refresh with a fixed-timestep sim accumulator.
2. **Shadows**: switch to `PCSS` or `VSM` with a tighter shadow frustum (±2 units, not ±4) and a 4096² map. Add a blob shadow plane under each avatar for contact grounding.
3. **Cards**: shrink to 0.35 × 0.50, raise to `y=0.05`, add `polygonOffset` to the table material, enable anisotropic filtering (16×) on card textures, render text via SDF/MSDF for crisp readability at any angle.
4. **Hand**: implement a separate viewmodel camera on layer 1 with a 50° FOV and 0.01 near plane. Render hand cards to this layer so they're never occluded by world geometry.
5. **Avatars**: replace sphere + cone with **Design B (The Egg)** from §8 — a single deformed sphere with a visor-patch photo mapping, glossy clearcoat material for the XP-plastic look, and noise-broken alpha fade at the base.
6. **Animation**: implement a proper fixed-timestep accumulator (Glenn Fiedler pattern), use spring physics for all card interactions, add subtle idle breathing + head-tracking to avatars.
7. **AI tooling**: use Meshy AI Pro ($20/mo) to generate the avatar base mesh, InstantMeshes (free) for retopology, AccuRig 2.0 (free) for rigging, Mixamo (free, if logins work) for idle animations. Use Cursor + Claude Sonnet 4.5 for all Three.js code. Total budget: ~$60 one-time + $20/mo during production.

The rest of this document justifies each choice with references.

---

## 2. Diagnosis: Why the Current Implementation Looks Bad

Before prescribing fixes, we need to understand precisely *why* each symptom
appears. This section is the root-cause analysis. The fixes themselves are
in §3–§9.

### 2.1 The "restroom icon" read

The current avatar in `src/lib/three/avatar.js` is a `SphereGeometry` (head)
stacked on a `ConeGeometry` pointing down (body). This silhouette — a circle
on a triangle — is the **ISO 7001 pictogram for "female restroom"**, codified
in 1980 and used on every bathroom door in every airport in the world. The
human brain pattern-matches this silhouette to "object/symbol" before it
ever reads "character." This is not a matter of opinion; it's a matter of
cultural training, documented in BBC Future's
[*The genius behind stick figure toilet signs*](https://www.bbc.com/future/article/20140911-the-genius-of-toilet-signs).

The Disney character-design canon — Walt Stanchfield's *Drawn to Life*
lectures (Routledge, 2009) — establishes that **silhouette is the first
readability gate**. If a character's silhouette (filled black, squinted at)
doesn't read as a specific character, no amount of texture or shading will
save it. The sphere+cone fails this test because it is symmetric, static,
and undifferentiated. Every player looks identical in outline.

The fix requires breaking the silhouette: add a neck (the single most
important geometric addition), use a non-conical body profile (egg, bean,
capsule), and add an asymmetric anchor (visor, hood, backpack). §8 proposes
three concrete designs.

### 2.2 Cards stuck in the table

In `src/lib/three/cards.js`, submission cards are placed at `y=0.03 + i * 0.001`
with `rotation = (-π/2, random, 0)` — i.e., lying flat on the table. The
table surface in `scene.js` is at `y=0.02`. The vertical separation is 0.01
units (1cm in world space). At the camera's distance (~1.4 units) and the
default 24-bit depth buffer precision, this 1cm gap is right at the edge of
z-fighting threshold — sometimes the card wins, sometimes the table wins,
and the result is the classic "card is melting into the surface" shimmer.

Three fixes exist (detailed in §6):
1. **Physically separate** — raise cards to `y=0.06` (4cm above table). Cleanest.
2. **`polygonOffset`** on the table material — `polygonOffsetFactor: 1, polygonOffsetUnits: 1`. Works but only on filled triangles, not lines.
3. **`depthWrite: false`** on the card material — fragile, breaks sorting.

The current code does none of these. §6 recommends option 1 + option 2
together for belt-and-suspenders robustness.

### 2.3 Cards enormously large

`BoxGeometry(0.7, 1.0, 0.012)` — the card is 0.7 units wide × 1.0 units tall.
The table radius is 2.2 units. So a single card is ~32% of the table
diameter, and seven cards fanned in the hand span ~2.4 units — wider than
the table. This is why the hand visually overflows the screen on smaller
viewports and why cards on the table look like dinner plates.

Real Cards Against Humanity cards are 63mm × 88mm (2.5" × 3.5"). If the
table is 2.2 units = ~1.5m diameter (a reasonable large dinner table), a
real card would be ~0.06 × 0.09 units. But we want cards readable from a
first-person seated view, so we scale up 4–5×: **target 0.30 × 0.42 units**.
That's less than half the current size, still readable, and the hand fan
becomes ~1.0 unit wide — comfortable, not overwhelming.

### 2.4 Low resolution / unplayable

`scene.js` calls `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))`.
This is the textbook-recommended clamp (MDN,
[*WebGL best practices*](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices))
but it has two failure modes the current code hits:

1. **The canvas CSS size is wrong.** `Game3D.svelte` sets the canvas to
   `width: 100%; height: 100%` via CSS, but never calls
   `renderer.setSize(width, height)` with the *CSS* pixel dimensions —
   only the `setPixelRatio` is set. The result is that on a 2× DPR display,
   the drawing buffer is 2× the CSS size (correct), but the renderer's
   internal `setSize` was never called with the actual viewport dimensions,
   so the projection matrix uses stale dimensions and everything renders
   at the wrong effective resolution.

2. **No antialiasing beyond `antialias: true`** (hardware MSAA). MSAA only
   fixes polygon-edge aliasing, not shader aliasing (specular shimmer on
   cards, aliasing on the table's torus ring at glancing angles). The
   result is that even at "full resolution," edges shimmer and textures
   crawl. The fix is TAA (temporal antialiasing) via `pmndrs/postprocessing`,
   which adds 3–7% GPU cost but eliminates shimmer.

The Three.js forum thread
[*Performance of different antialiasing techniques*](https://discourse.threejs.org/t/performance-of-different-antialiasing-techniques/56740)
empirically compares FXAA, SMAA, TAA (levels 1–3), `WebGLMultisampleRenderTarget`,
and built-in MSAA. TAA at level ≥3 is the clear winner for quality. §3
details the implementation.

### 2.5 Can't see own cards on join

The hand cards in `cards.js` `layoutHand()` are positioned at `y=0.5, z=1.0`
in world space — in front of the south seat, below head height. The camera
is at `(0, 1.6, 1.4)` looking at `(0, 0.8, 0)`. The hand is therefore below
the camera's view frustum at the near plane, and depending on the camera's
pitch, the cards may be either clipped (too close, below near plane at 0.1)
or occluded by the table (the table is at `y=0.02`, cards at `y=0.5` — table
doesn't occlude, but the cards are so far below the look direction that
they're at the extreme bottom edge of the FOV).

The industry-standard solution is a **separate viewmodel camera** (UE5,
Unity, Godot all support this pattern). The hand renders to a second camera
with a narrower FOV (50–70° vs the world's 90°) and a much smaller near
plane (0.01 vs 0.1), on a separate layer. The world camera renders first,
then the viewmodel camera renders on top without clearing color. This is
how every FPS game keeps the weapon/hand visible regardless of world
geometry. §7 details the Three.js implementation.

### 2.6 Poor shadows + cheap objects

`scene.js` uses `PCFSoftShadowMap` with a 2048×2048 shadow map and a
shadow camera frustum of `left/right/top/bottom = ±4`. That's an 8×8 unit
area covered by 2048² samples = 256 samples per unit. A card lying on the
table (0.7 × 1.0 units) gets ~180×260 shadow samples — adequate but not
great. An avatar head (0.32 radius) gets ~80 samples across — visibly
pixelated.

Worse: the shadow camera's `near = 0.5, far = 20` covers a 19.5-unit depth
range, so depth precision is spread thin. The bias is `-0.0005` which is
fine for the table but causes acne on the small card geometry.

The cheap-object look has three causes:
1. **No PBR microdetail.** All materials are flat `MeshStandardMaterial` with
   a single color and roughness 0.6–0.95. Real objects have roughness
   variation, normal maps, beveled edges. A card with perfectly sharp 90°
   edges reads as "CG box"; the same card with a 0.5mm bevel reads as
   "real cardstock." (Polycount,
   [*Bevel / Chamfer Edges vs Normal Map Bake*](https://polycount.com/discussion/215555/bevel-chamfer-edges-vs-normal-map-bake))
2. **No post-processing.** No bloom, no SSAO, no tone mapping beyond the
   default. The result is flat, even lighting that screams "default
   Three.js demo."
3. **No environment map.** `MeshStandardMaterial` without an `envMap`
   produces a flat, unreflective surface. Even a soft studio HDRI
   transforms the look — see the difference in any Three.js example that
   toggles `envMap` on/off.

§4 and §5 detail the fixes.

### 2.7 Screen shuttering

The current animation loop in `scene.js` uses `requestAnimationFrame`
directly, with no fixed-timestep accumulator. The `THREE.Clock.getDelta()`
returns the wall-clock time since the last frame, which is then passed to
`update(delta)`. This has two problems:

1. **Frame-rate dependence.** If the tab is backgrounded and then refocused,
   `getDelta()` returns a huge value (seconds), causing animations to jump.
   The code doesn't clamp `delta`, so a 5-second backgrounding makes every
   animation teleport to its end state.
2. **Refresh-rate stutter.** The browser fires rAF at the display refresh
   rate (60/120/144/240Hz). On a 144Hz monitor with vsync at 60Hz (some
   browsers still cap rAF), the browser fires rAF at irregular intervals —
   every other frame, then every third, then every other — producing
   permanent visible stutter. The WebKit bug
   [*Support for 120Hz requestAnimationFrame*](https://bugs.webkit.org/show_bug.cgi?id=173434)
   documents this: "a 144Hz monitor will always permanently stutter at 60fps
   and 120fps, since 144 is not divisible by 60."

The fix is the **Glenn Fiedler "Fix Your Timestep" pattern**
([*gafferongames.com*](https://gafferongames.com/post/fix_your_timestep/)):
accumulate wall-clock delta, run the simulation at a fixed 60Hz (or 120Hz)
in discrete steps, and interpolate the render state between the last two
sim states. This decouples simulation from rendering and eliminates both
problems. §3 and §9 detail the implementation.

---

## 3. Rendering Fundamentals: Resolution, DPR, Antialiasing, Frame Pacing

### 3.1 Device Pixel Ratio: the rule and the exceptions

The canonical rule (MDN,
[*WebGL best practices*](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices))
is: `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))`. This
clamps to 2× DPR because beyond that, the GPU does 4× the work for
invisible quality gains.

But the current code misses a critical companion call:
`renderer.setSize(width, height)` must be called with the **CSS pixel**
dimensions of the canvas, not the device pixels. `setPixelRatio` then
multiplies internally. If `setSize` is never called (or called with wrong
dimensions), the drawing buffer is wrong and everything renders blurry.

**The fix:**

```js
function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);  // `false` = don't set canvas CSS style
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
```

The `false` argument to `setSize` is crucial — it tells Three.js not to
overwrite the canvas's CSS `width`/`height` (which we control via Svelte).
Without it, Three.js sets `canvas.style.width = w + 'px'`, which can fight
with flexbox layout.

**Adaptive DPR** (R3F's `dpr={[1, 2]}` pattern) is worth considering for
low-end devices: monitor frame time, and if it exceeds 20ms for 5
consecutive frames, drop `setPixelRatio` to 1.0. Restore when frame time
recovers. This is more complex but prevents the "cardboard frame" experience
on integrated GPUs.

### 3.2 Antialiasing: MSAA vs FXAA vs SMAA vs TAA

| Technique | Cost | What it fixes | What it doesn't | Verdict |
|-----------|------|---------------|-----------------|---------|
| MSAA (`antialias: true`) | ~2% GPU | Polygon edges | Shader aliasing, specular shimmer | Always on, but insufficient alone |
| FXAA | 1–3% GPU | Edges + some shader aliasing | Blurs textures, doesn't fix specular crawl | Skip |
| SMAA | 2–4% GPU | Edges + shader aliasing, sharper than FXAA | Doesn't fix temporal shimmer | Good fallback if TAA is too expensive |
| TAA | 3–7% GPU | Everything (edges, shader, temporal) | Needs motion vectors + jitter; can blur motion | **Recommended** |

TAA (temporal antialiasing) works by jittering the camera projection by a
sub-pixel offset each frame, then blending the current frame with the
previous frame(s) using motion vectors to reproject. The result is
near-perfect edge quality and elimination of specular shimmer — the
"crawl" you see on glossy surfaces as the camera moves.

The Three.js forum thread
[*Performance of different antialiasing techniques*](https://discourse.threejs.org/t/performance-of-different-antialiasing-techniques/56740)
empirically confirms TAA at level ≥3 is the quality winner. The
`pmndrs/postprocessing` library
([*github.com/pmndrs/postprocessing*](https://github.com/pmndrs/postprocessing))
ships a `TAAEffect` that's trivial to compose.

**Important pitfall** (from the pmndrs README): when using `pmndrs/postprocessing`,
set `renderer.toneMapping = NoToneMapping` and let the `ToneMappingEffect`
do it at the end of the chain. Otherwise colors get double-tonemapped and
look dark. The current code sets `ACESFilmicToneMapping` on the renderer —
this must move into the post-processing chain.

**Recommended post-processing stack:**

```js
import { EffectComposer, RenderPass } from 'postprocessing';
import { TAAPass, ToneMappingEffect, BloomEffect, N8AOPass } from 'postprocessing';

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new TAAPass(scene, camera));
composer.addPass(new N8AOPass(scene, camera));  // ambient occlusion
composer.addPass(new BloomEffect({ intensity: 0.3, luminanceThreshold: 0.6 }));
composer.addPass(new ToneMappingEffect({ toneMapping: ACESFilmicToneMapping }));
```

### 3.3 Frame pacing: the fixed-timestep accumulator

The current `requestAnimationFrame` loop has two problems (see §2.7): no
delta clamping, and refresh-rate stutter on 144Hz monitors.

**The fix** is Glenn Fiedler's accumulator pattern
([*Fix Your Timestep!*](https://gafferongames.com/post/fix_your_timestep/)):

```js
const SIM_HZ = 60;  // fixed simulation rate
const SIM_DT = 1 / SIM_HZ;
const MAX_FRAME_DELTA = 0.25;  // clamp to prevent spiral of death

let accumulator = 0;
let currentTime = performance.now() / 1000;
let simTime = 0;
let prevSimState = null;
let nextSimState = null;

function frame() {
  const newTime = performance.now() / 1000;
  let frameDelta = newTime - currentTime;
  currentTime = newTime;
  if (frameDelta > MAX_FRAME_DELTA) frameDelta = MAX_FRAME_DELTA;
  accumulator += frameDelta;

  while (accumulator >= SIM_DT) {
    prevSimState = nextSimState;
    nextSimState = stepSimulation(nextSimState, SIM_DT);
    simTime += SIM_DT;
    accumulator -= SIM_DT;
  }

  const alpha = accumulator / SIM_DT;  // 0..1, interpolation factor
  const renderState = interpolate(prevSimState, nextSimState, alpha);
  render(renderer, scene, camera, renderState);
  requestAnimationFrame(frame);
}
```

This decouples simulation from rendering. The simulation runs at exactly
60Hz regardless of the display refresh rate. The renderer interpolates
between the last two sim states for smooth motion. On a 144Hz monitor, rAF
fires 144 times per second, each time interpolating between the same two
sim states (with different `alpha` values) — buttery smooth.

**For our project**, the simulation is mostly reactive (Svelte store
updates from network events), so the "simulation step" is minimal. But
the interpolation pattern still matters for the camera bob, mouse-look
spring, card fly/flip animations, and avatar breathing — all of which
should advance at a fixed rate, not at rAF rate.

### 3.4 Concrete actions for §3

1. **Fix `resize()`** to call `setSize(w, h, false)` with CSS pixel dimensions.
2. **Add `pmndrs/postprocessing`** with TAA + N8AO + Bloom + ACES tone mapping.
3. **Move `toneMapping`** off the renderer and into the post-processing chain.
4. **Rewrite the rAF loop** with the Fiedler accumulator pattern.
5. **Clamp `delta`** to 0.25s max to prevent backgrounding teleport.
6. **Add adaptive DPR** (optional, for low-end devices): drop to 1.0 if frame time > 20ms for 5 frames.

---

## 4. Shadow Quality: From PCF to PCSS to CSM

### 4.1 The shadow quality ladder

| Technique | Quality | Cost | Three.js Support |
|-----------|---------|------|------------------|
| `BasicShadowMap` | Hard, aliased | Cheapest | Built-in |
| `PCFShadowMap` | Soft, 1-tap | Cheap | Built-in |
| `PCFSoftShadowMap` | Softer, multi-tap | Medium | Built-in (current) |
| `PCSS` | Variable penumbra (sharp contact, soft far) | High | Custom shader |
| `VSM` | Hardware-filtered, fast soft | Medium | Custom render target |
| `CSM` (cascaded) | High-res near, low-res far | High | `three-csm` package |

The current `PCFSoftShadowMap` is the right default for a small scene, but
the shadow frustum is too large (±4 units) for the shadow map resolution
(2048²). Either tighten the frustum or increase the map size.

### 4.2 Tightening the shadow frustum

The scene is roughly 4×4 units (table radius 2.2 + avatars at 1.5 offset).
A ±4 frustum covers 8×8 = 64 unit², but the scene only needs ~4×4 = 16
unit². Halving the frustum to ±2 quadruples the effective shadow resolution
(1024 samples/unit → 4096 samples/unit).

```js
shadow.camera.left = -2;
shadow.camera.right = 2;
shadow.camera.top = 2;
shadow.camera.bottom = -2;
shadow.camera.near = 0.5;
shadow.camera.far = 10;
shadow.mapSize.set(2048, 2048);  // or 4096 for extra quality
```

### 4.3 Contact shadows: the cheap grounding trick

Even with perfect shadow maps, small objects on a flat surface (cards on a
table) can look "floating" because the directional shadow is soft and
spread out. The fix is a **blob shadow** — a radial-gradient texture laid
flat on the floor under each object.

```js
function makeBlobShadow() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.4)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  const geo = new THREE.PlaneGeometry(0.8, 0.8);
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.001;  // just above the floor
  return mesh;
}
```

Attach one to each avatar and each card pile. This grounds objects visually
even when the directional shadow is weak.

### 4.4 Ambient occlusion for crease shading

`N8AOPass` (from `pmndrs/postprocessing` or the standalone `n8ao` package)
is the modern Three.js AO solution. It's a screen-space technique that
darkens creases and contact areas, adding enormous perceived depth. The
Three.js forum thread
[*Ambient occlusion (shadows) on the ground*](https://discourse.threejs.org/t/ambient-occlusion-shadows-on-the-ground/1873)
notes that SSAO often has no visible effect on a single flat ground plane —
N8AO handles this case better.

### 4.5 Concrete actions for §4

1. **Tighten shadow frustum** to ±2 units.
2. **Increase shadow map** to 4096² if frame time allows.
3. **Add blob shadows** under avatars and card piles.
4. **Add N8AO** to the post-processing chain.
5. **Tune shadow bias** per-object (avatars need different bias than cards).

---

## 5. PBR Materials and Object Quality

### 5.1 The Disney Principled BRDF (the foundation)

Every modern game engine's material system descends from Brent Burley's
2012 SIGGRAPH paper
[*Physically-Based Shading at Disney*](https://disney-animation.s3.amazonaws.com/library/s2012_pbs_disney_brdf_notes_v2.pdf).
The key insight: a single material model with ~10 intuitive parameters
(baseColor, metallic, roughness, specular, subsurface, sheen, clearcoat,
anisotropy) can express both dielectrics (wood, plastic, paper) and metals
(copper, steel) without the artist switching shaders.

Three.js's `MeshStandardMaterial` is a direct descendant — it exposes
`metalness`, `roughness`, `map`, `normalMap`, `roughnessMap`, `metalnessMap`,
`envMap`. `MeshPhysicalMaterial` extends it with `clearcoat`, `sheen`,
`transmission`, `ior`, `thickness` for advanced dielectrics.

**The current code uses `MeshStandardMaterial` correctly** but with flat
single-color materials and no texture maps. This is why everything looks
"cheap" — there's no microdetail.

### 5.2 GGX: why it's the standard

Brian Karis's 2013 SIGGRAPH talk
[*Real Shading in Unreal Engine 4*](https://cdn2.unrealengine.com/Resources/files/2013SiggraphPresentationsNotes-26915738.pdf)
picks the GGX (Trowbridge-Reitz) normal distribution function over
Beckmann/Blinn-Phong because its long-tailed distribution matches measured
BRDFs far better — especially the soft highlight falloff on plastics and
paper, which is exactly what cards are made of.

Three.js's `MeshStandardMaterial` uses GGX by default (since r111). No
action needed here — just awareness.

### 5.3 Normal maps and bevels: the cheap-detail trick

The Polycount thread
[*Bevel / Chamfer Edges vs Normal Map Bake*](https://polycount.com/discussion/215555/bevel-chamfer-edges-vs-normal-map-bake)
is the canonical reference for why every cube in real-time looks "fake"
until you bevel the edges or bake a bevel into a normal map. Beveled edges
catch a thin highlight that reads as "solid object" rather than "CG box."

For cards, this means:
1. **Geometry bevel**: use `BoxGeometry` with slightly inset faces, or a
   custom geometry with chamfered edges. ~10% more polygons, huge visual
   payoff.
2. **Normal map bevel**: bake a high-poly beveled card down to a normal
   map, apply to the flat `BoxGeometry`. Cheaper, same effect.

For the table surface, a subtle normal map with surface variation (felt
fiber, wood grain) transforms the look from "flat disc" to "real surface."

### 5.4 Post-processing: the AAA look chain

The recommended post-processing chain (from §3.2) is:
1. `RenderPass` — render the scene
2. `TAAPass` — temporal antialiasing
3. `N8AOPass` — ambient occlusion
4. `BloomEffect` — subtle highlight glow (intensity 0.2–0.4, luminance threshold 0.6)
5. `ToneMappingEffect` — ACES Filmic (the industry standard since 2016)

Matt DesLauriers's
[*Filmic Effects in WebGL*](https://medium.com/@mattdesl/filmic-effects-for-webgl-9dab4bc899dc)
is the best practitioner walkthrough of assembling this chain in Three.js.

### 5.5 Environment maps: the missing ingredient

`MeshStandardMaterial` without an `envMap` produces a flat, unreflective
surface. Even a soft studio HDRI transforms the look — glossy surfaces
pick up environment reflections that read as "real material."

Three.js ships `RoomEnvironment` (a procedurally-generated studio HDRI)
that's perfect for stylized scenes:

```js
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { PMREMGenerator } from 'three';

const pmrem = new THREE.PMREMGenerator(renderer);
const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = envMap;  // applies to all PBR materials
```

This is a one-line addition that dramatically improves material quality.

### 5.6 Concrete actions for §5

1. **Add `RoomEnvironment`** to the scene.
2. **Add normal maps** to cards (bake a bevel) and table (felt/wood texture).
3. **Add roughness variation** — a subtle roughness map on the table so it's not uniform sheen.
4. **Bevel card geometry** — either in the geometry itself or via normal map.
5. **Compose the post-processing chain** (TAA + N8AO + Bloom + ACES).

---

## 6. Card Rendering: Z-Fighting, Textures, Text

### 6.1 Z-fighting: the three fixes

Cards at `y=0.03` fighting with the table at `y=0.02` is the #1 visible
artifact. Three fixes, in order of preference:

1. **Physical separation** — raise cards to `y=0.06` (4cm above table).
   Cleanest, no shader tricks. The downside is the cards look slightly
   "floating" — but with a blob shadow underneath, this reads as "card
   resting on the table" not "card hovering."
2. **`polygonOffset`** on the table material:
   ```js
   tableMaterial.polygonOffset = true;
   tableMaterial.polygonOffsetFactor = 1;
   tableMaterial.polygonOffsetUnits = 1;
   ```
   This pushes the table away from the camera in depth space, preventing
   z-fighting with co-planar geometry above it. The Three.js issue
   [*#2593*](https://github.com/mrdoob/three.js/issues/2593) documents
   that this only works on filled triangles (not lines) and recommends
   starting values.
3. **`depthWrite: false`** on the card material — fragile, breaks sorting.
   Avoid.

**Recommendation: use both 1 and 2.** Belt and suspenders.

### 6.2 Anisotropic filtering: readable text at angles

When a card lies flat on the table and the camera views it at a glancing
angle, plain bilinear/trilinear mip filtering smears the text into mush.
**Anisotropic filtering** samples multiple points along the surface's
projection direction, recovering the detail.

```js
const maxAniso = renderer.capabilities.getMaxAnisotropy();  // typically 8 or 16
cardTexture.anisotropy = maxAniso;
cardTexture.minFilter = THREE.LinearMipmapLinearFilter;
```

This is a one-line addition per texture that dramatically improves text
readability on angled cards.

### 6.3 SDF text: crisp at any distance

For truly crisp text at any distance/angle, use **signed distance field
(SDF) fonts**. Chris Green's 2007 SIGGRAPH paper
[*Improved Alpha-Tested Magnification for Vector Textures and Special Effects*](https://steamcdn-a.akamaihd.net/apps/valve/2007/SIGGRAPH2007_AlphaTestedMagnification.pdf)
(Valve) is the foundational reference. Each glyph is baked as a low-res
single-channel texture storing distance-to-edge; the fragment shader
reconstructs the vector outline at any scale via a `smoothstep` on the
distance. No mip blur, no pixel crawl, rotates cleanly.

**MSDF** (multi-channel SDF) extends this to sharp corners by storing 3
channels. Red Blob Games's
[*Guide to SDF+MSDF Fonts*](https://www.redblobgames.com/articles/sdf-fonts/)
is the best short introduction.

For our project, the current `CanvasTexture` approach (rendering text to a
512×720 canvas per card) is actually **fine for the card faces** — the
text is large enough that SDF isn't necessary. SDF becomes important only
if we want to render small UI text in 3D space (e.g., floating score
numbers). **Recommendation: keep CanvasTexture for cards, consider MSDF
for future UI overlays.**

### 6.4 Card sizing: the math

Real CAH cards: 63mm × 88mm. Table diameter: 2.2 units = ~1.5m (a large
dinner table). Real card in world units: 0.063 × 0.088. That's too small
to read from a seated first-person view.

**Target: 0.35 × 0.49 units** (5.5× real size). This is:
- ~16% of table diameter (vs current 32%) — comfortable, not overwhelming
- Readable from the camera at (0, 1.6, 1.4) looking at (0, 0.8, 0)
- Hand fan of 7 cards spans ~1.2 units — fits in FOV

### 6.5 Concrete actions for §6

1. **Shrink cards** to `BoxGeometry(0.35, 0.49, 0.008)`.
2. **Raise cards** to `y=0.06` when on table.
3. **Add `polygonOffset`** to table material.
4. **Enable anisotropic filtering** (16×) on all card textures.
5. **Keep CanvasTexture** for card text (SDF not needed at this size).
6. **Add blob shadows** under card piles.

---

## 7. First-Person Hand Rendering

### 7.1 The viewmodel camera pattern

Every modern FPS uses a **separate camera** for the viewmodel (hands,
weapon, cards-in-hand). The world camera has a wide FOV (90° horizontal)
for spatial awareness; the viewmodel camera has a narrow FOV (50–70°) so
the hand geometry looks correct and undistorted.

The Unreal Engine 5.8 docs
[*First Person Rendering*](https://dev.epicgames.com/documentation/en-unreal-engine/first-person-rendering)
document the engine-grade pattern: render first-person primitives with a
custom FOV, apply a scaling factor to push the viewmodel back (reducing
wide-FOV distortion), use a separate depth-only pre-pass.

### 7.2 Three.js implementation: camera layers

The standard Three.js approach (forum thread
[*Multiple Scenes vs Layers*](https://discourse.threejs.org/t/multiple-scenes-vs-layers/12503))
is **camera layers**:

```js
// World camera: sees everything on layer 0
const worldCamera = new THREE.PerspectiveCamera(70, w/h, 0.1, 200);
worldCamera.layers.set(0);

// Viewmodel camera: sees only layer 1
const viewmodelCamera = new THREE.PerspectiveCamera(50, w/h, 0.01, 10);
viewmodelCamera.layers.set(1);

// Hand cards go on layer 1
handCardMesh.layers.set(1);

// Render world, then viewmodel on top (don't clear color)
renderer.autoClear = false;
renderer.clear();  // clears color + depth
renderer.render(scene, worldCamera);
renderer.clearDepth();  // clear only depth, keep color
renderer.render(scene, viewmodelCamera);
```

The viewmodel camera can share position/rotation with the world camera
(just copy the transform each frame) but uses its own projection matrix
(narrower FOV, smaller near plane).

### 7.3 FOV choice

- **World camera**: 70° vertical (~90° horizontal at 16:9) feels modern and spacious. Lower (60°) feels cinematic but claustrophobic for a card game.
- **Viewmodel camera**: 50° vertical. Narrow enough that cards 0.5 units away don't distort at the edges.

Wikipedia's
[*Field of view in video games*](https://en.wikipedia.org/wiki/Field_of_view_in_video_games)
covers the conventions and the horizontal-vs-vertical FOV confusion (90°
hor ≈ 59° vert at 16:9).

### 7.4 Hand attach point

The hand should be positioned in **viewmodel camera space**, not world
space. This means the hand follows the camera as it looks around — the
cards are always at the bottom of the screen, slightly below eye level.

```js
// In the render loop, after updating the viewmodel camera:
viewmodelCamera.updateMatrixWorld();
handGroup.position.set(0, -0.3, -0.5);  // 0.5m forward, 0.3m below eye
handGroup.quaternion.copy(viewmodelCamera.quaternion);
viewmodelCamera.add(handGroup);  // parent to camera
```

Wait — parenting to the camera means the hand moves with the camera
automatically, no per-frame updates needed. This is the cleanest approach.

### 7.5 Concrete actions for §7

1. **Add a viewmodel camera** on layer 1 with 50° FOV, 0.01 near plane.
2. **Move hand cards to layer 1** and parent them to the viewmodel camera.
3. **Render world then viewmodel** with `autoClear = false` + `clearDepth()`.
4. **Tune hand position** to `(0, -0.3, -0.5)` in viewmodel space.
5. **Add subtle sway** to the hand based on camera rotation (Disney "follow-through").

---

## 8. Avatar Design: Escaping the Restroom Icon

> This section is the longest because the avatar is the most visible failure
> and the hardest to get right. The research subagent produced three concrete
> design proposals; we pick one and justify the choice.

### 8.1 Why the current design fails (root cause)

The current avatar is `SphereGeometry` (head) + `ConeGeometry` (body). This
silhouette — circle on triangle — is the **ISO 7001 pictogram for "female
restroom"** (BBC Future,
[*The genius behind stick figure toilet signs*](https://www.bbc.com/future/article/20140911-the-genius-of-toilet-signs)).
The brain pattern-matches this silhouette to "object/symbol" before it ever
reads "character."

Walt Stanchfield's *Drawn to Life* (Routledge, 2009) — the canonical Disney
character-design lectures — establishes that **silhouette is the first
readability gate**. If a character's silhouette (filled black, squinted at)
doesn't read as a specific character, no amount of texture or shading will
save it. The sphere+cone fails because it is:
- **Symmetric** — no left/right asymmetry to break the pattern
- **Static** — no gesture (line of action through the body)
- **Undifferentiated** — every player looks identical in outline
- **Conical** — downward triangle = aggressive/sharp shape language, opposite of the "minimal, friendly" brief

### 8.2 What works: lessons from successful minimal characters

| Game | Character | Polygon count | Why it works |
|------|-----------|---------------|--------------|
| **Journey** | Faceless robed figure | ~2000 tris | Cloth drape supplies gesture + asymmetric silhouette; C-curve through spine |
| **Among Us** | Bean crewmate | ~200–800 tris | Wider at middle than top/bottom (non-conical); visor breaks silhouette asymmetrically; backpack adds second anchor |
| **Fall Guys** | Egg-shaped blob | ~500 tris | Bottom-heavy egg (opposite of cone); inherently comedic and "alive" |
| **Monument Valley** | Princess Ida | ~300 tris | Gown tapers to floor (matches our "gradient-out" brief); hat creates asymmetric topknot |
| **Mini Metro** | Vehicles | ~20 tris | Pure geometric primitives, but color + motion supply personality |

The common thread: **no successful minimal character is a symmetric vertical stack of two primitives.** All have (1) an asymmetric silhouette anchor, (2) a non-conical body profile, (3) color/material contrast between regions.

References:
- GameDeveloper, [*Early Among Us character concepts*](https://www.gamedeveloper.com/art/early-i-among-us-i-character-concepts-depict-the-birth-of-the-bean)
- The New Yorker, [*A Journey to Make Video Games Into Art*](https://www.newyorker.com/tech/annals-of-technology/a-journey-to-make-video-games-into-art)
- ArtStation, [*Fall Guys - World Design*](https://www.artstation.com/artwork/B1VJb8)
- ustwo, [*Monument Valley*](https://ustwo.com/work/monument-valley)

### 8.3 The Windows XP aesthetic

The user specified "Windows XP style." Visually, this means the **Luna
theme** (2001): glossy plastic shading, soft specular highlights, a single
key light from upper-left, subtle drop shadow, blue/teal gradient
background. The XP user account icons (chess piece, fish, dinosaur,
snowman) are the closest direct reference — they're all **slightly glossy
3D objects on a soft gradient background.**

The broader design movement is **Frutiger Aero** (2004–2013): glossy,
skeuomorphic, nature-meets-technology, bright saturated colors. Wikipedia
and the Aesthetics Wiki both describe it as the direct successor to Y2K
Futurism. The Frutiger Aero Archive ([*frutigeraeroarchive.org*](https://frutigeraeroarchive.org))
hosts 4000+ wallpapers/icons for reference.

**The current flat-gray implementation is missing the gloss that defines
the XP aesthetic.** The fix is `MeshPhysicalMaterial` with `clearcoat=1.0,
clearcoatRoughness=0.15` plus an environment map for reflections.

References:
- Wikipedia, [*Bliss (photograph)*](https://en.wikipedia.org/wiki/Bliss_(photograph))
- BetaWiki, [*Luna*](https://betawiki.net/wiki/Luna)
- Wikipedia, [*Frutiger Aero*](https://en.wikipedia.org/wiki/Frutiger_Aero)

### 8.4 Photo-on-head: why naive equirectangular wrap looks bad

The current `processPhoto()` in `avatar.js` composites the photo onto a
1024×512 canvas with a vertical gradient, then maps it via equirectangular
UV. **Equirectangular projection has extreme distortion at the poles** —
the top and bottom of the sphere compress to a single point. A face mapped
this way stretches the forehead and chin into a pinched swirl and puts the
ears on the equator. This is documented in the Blender Artists thread
[*Pole distortions while mapping an equirectangular texture map*](https://blenderartists.org/t/pole-distortions-while-mapping-an-equirectangular-texture-map-to-an-icosphere/691858).

**Production avatar systems do NOT project photos onto spheres:**
- **Nintendo Miis** decompose the face into parametric parts (face shape, hair, eyes, nose, mouth) and rebuild from stylized 3D assets driven by sliders. (Wikipedia, [*Mii*](https://en.wikipedia.org/wiki/Mii))
- **Apple Animoji** uses 52 blendshapes tracked from the TrueDepth camera, applied to a pre-built stylized mesh. The face is geometry, not a texture. (Apple Developer, [*Tracking and visualizing faces*](https://developer.apple.com/documentation/arkit/tracking-and-visualizing-faces))

**Better approaches for our "photo stretched on front" goal:**

1. **Planar projection** — project the photo as if from a camera in front
   of the head, sampling only the front-facing hemisphere. UVs computed
   as `u = (normal.x + 1) / 2, v = (normal.y + 1) / 2`. The back of the
   head uses solid gray. No pole distortion.
2. **Spherical cap mapping** — only map the photo onto a cap (e.g., 90°
   cone around +Z), blend to gray outside. Avoids poles entirely.
3. **Custom UV per face region** — model the head as a low-poly mesh with
   a dedicated "face quad" whose UVs map the photo, assign gray material
   to the rest. Maximum control, no distortion, very Three.js-friendly.

### 8.5 Three concrete design proposals

#### Design A: "The Bust" — tapered capsule + photo-quad head

- **Body**: `CapsuleGeometry` (radius 0.35, length 1.2), upper-third ring
  vertices displaced outward ~0.08 units to create shoulders.
- **Head**: `SphereGeometry` (radius 0.32, 16×10 segments), slightly
  squashed Y-scale 1.1.
- **Neck**: `CylinderGeometry` (radius 0.12, height 0.15) — **the single
  most important addition that kills the toilet-sign read.**
- **Photo**: front-facing quad (0.4 × 0.4, 3×3 subdivision for slight
  curvature) parented to head at z=+0.31, `MeshBasicMaterial` (unlit so
  photo stays crisp).
- **Material**: gray `MeshToonMaterial` with 3-step gradient ramp on body
  + head; `MeshPhysicalMaterial` with clearcoat for XP gloss.
- **Fade**: custom `ShaderMaterial` extension on lower 18% fading alpha
  to 0.
- **Shadow**: radial blob shadow plane underneath.
- **Polygon count**: ~600 tris.

#### Design B: "The Egg" — Among Us / Fall Guys hybrid  ⭐ RECOMMENDED

- **Body**: single deformed `SphereGeometry` (radius 0.5, 24×16 segments)
  scaled to (0.85, 1.4, 0.85), bottom third of vertices lowered toward
  floor to create egg/bean shape — wider at lower-middle, tapering to
  rounded point at floor.
- **Head**: upper portion of the same sphere (no separate mesh) — slight
  indentation around "eye line" via inset vertex ring creates brow.
- **Photo**: mapped onto a curved "visor" patch — front 6 faces of upper
  hemisphere get separate material with photo as map (custom UVs, planar
  projection from +Z). This is exactly the Among Us solution.
- **Material**: glossy `MeshPhysicalMaterial` (clearcoat 1.0,
  clearcoatRoughness 0.15, color #C8C8C8) for XP-plastic look.
- **Lighting**: single upper-left `DirectionalLight` + soft environment map.
- **Fade**: lower 25% fades to alpha 0 with Perlin-noise breakup.
- **Polygon count**: ~700 tris.
- **Why recommended**: the egg/bean silhouette is empirically validated
  by Fall Guys and Among Us as the most appealing minimal-character shape.
  Single continuous mesh (no seams) reads as a single creature. Visor-
  patch photo mapping is exactly the Among Us solution and naturally
  constrains the photo to the front.

#### Design C: "The Pedestal" — Monument Valley / chess-piece inspired

- **Body**: `LatheGeometry` with ~12 Vector2 points describing a half-
  silhouette: rounded head dome → narrow neck → flared shoulders → tapering
  torso → tight curl inward at floor like a chess pawn.
- **Photo**: front 4 faces of head dome get photo via custom UV island
  (planar projection).
- **Material**: `MeshStandardMaterial` with smooth shading + subtle
  vertical gradient `CanvasTexture` (lighter gray at top, darker at base).
- **Fade**: bottom 15% of profile curls inward to nearly a point —
  **geometry itself tapers to floor, no alpha fade needed.**
- **Polygon count**: ~400 tris.
- **Why not recommended**: most faithful to "Windows XP style" but reads
  as "designed object" more than "character." Lacks the approachability
  of Design B.

### 8.6 Animation for minimal characters

With minimal geometry, animation is the character. The ResearchGate paper
[*Making Characters more Alive: Study of Idle Animation in Video Games*](https://www.researchgate.net/publication/361309980_Making_Characters_more_Alive_Study_of_Idle_Animation_in_Video_Games)
establishes that idle animation is the #1 contributor to perceived "alive-
ness."

**Required animations (all subtle):**
1. **Breathing**: `body.scale.y = 1 + 0.02 * Math.sin(t * 0.4 * Math.PI * 2)` — 2.5s cycle, 2% scale. (MoCap Online, [*Idle Animation for Games*](https://mocaponline.com/blogs/mocap-news/idle-animation-game-dev-guide))
2. **Weight shift**: root translates X by ~2% of body width over 8–12s, torso tilts 1–2° opposite. (Blender Artists, [*subtle idle movement*](https://blenderartists.org/t/easy-way-to-simulate-subtle-idle-movement/1620186))
3. **Head tracking**: head rotates to face cursor (lerped, clamped ±25°). Enormous personality multiplier for ~10 lines of code.
4. **Perlin micro-jitter**: ±0.3° rotation.x/z driven by Perlin noise — breaks the "robotic" perfection.

**"Subtle > exaggerated for well-made feeling"** — GarageFarm
([*Idle Animation: Tips*](https://garagefarm.net/blog/idle-animation-tips-to-animate-your-characters)):
"Subtle cues like slow breathing, slight posture adjustments, or even tiny
fidgets make characters more believable and relatable."

### 8.7 Concrete actions for §8

1. **Implement Design B (The Egg)** — single deformed sphere, visor-patch photo.
2. **Add XP-gloss material** — `MeshPhysicalMaterial` with clearcoat + envMap.
3. **Implement idle animations** — breathing + weight shift + head tracking + micro-jitter.
4. **Add blob shadows** under each avatar.
5. **Fade base with Perlin noise** — not a clean alpha gradient (that reads as "melted candle").

---

## 9. Animation Feel: Disney 12, Vlambeer, Spring Physics

### 9.1 The Disney 12 (the canon)

Frank Thomas & Ollie Johnston's *Disney Animation: The Illusion of Life*
(1981) codified the 12 principles of animation:
1. Squash & stretch
2. Anticipation
3. Staging
4. Straight-ahead vs pose-to-pose
5. Follow-through & overlapping action
6. Slow in / slow out (easing)
7. Arcs
8. Secondary action
9. Timing
10. Exaggeration
11. Solid drawing
12. Appeal

For our card game, the most relevant subset:
- **Anticipation** — small wind-up opposite to the primary action (card lifts slightly before flying to table)
- **Follow-through** — overshoot past target then settle (card flies past landing point, comes back)
- **Squash & stretch** — subtle scale change on impact (card squashes 5% on landing)
- **Arcs** — curved travel paths, never linear (card flies in a parabola, not a straight line)
- **Slow in / slow out** — easing, never linear unless mechanical

References:
- Wikipedia, [*Twelve basic principles of animation*](https://en.wikipedia.org/wiki/Twelve_basic_principles_of_animation)
- NYFA, [*12 Principles of Animation*](https://www.nyfa.edu/student-resources/12-principles-of-animation)

### 9.2 Vlambeer: the art of screenshake

Jan Willem Nijman's GDC 2013 talk
[*The Art of Screenshake*](https://www.youtube.com/watch?v=AJdEqssNZ-U)
is the canonical "juice / game feel" reference. He demonstrates, on a basic
shooter, how adding hit-stop, screen shake, particle bursts, knockback,
and recoil turns a flat prototype into something that feels good to play.

The same techniques apply to CAH:
- **Card play** → camera shake (3px, 160ms) + dust particles at landing point + 60ms hit-stop
- **Card reveal** → camera shake (2px, 140ms) + flip sound
- **Winner reveal** → camera shake (10px, 360ms) + 32-particle burst + 160ms hit-stop + winnerReveal arpeggio

The current code has some of this (`shake()`, `hitStop()`, `burst()` in
`juice.js`) but the shake amplitudes are too small and the hit-stop is too
short. Tune up.

### 9.3 Spring physics > cubic-bezier for organic motion

Spring physics beat easing curves for organic UI motion because they're
**velocity-aware**: a card you flick with high velocity overshoots more
than one you drag slowly, which an easing curve can't replicate.

Josh Comeau's
[*A Friendly Introduction to Spring Physics Animation in JavaScript*](https://www.joshwcomeau.com/animation/a-friendly-introduction-to-spring-physics/)
is the best beginner walkthrough. Spring parameters:
- `stiffness` (0..1, default 0.15) — higher = tighter, faster snap
- `damping` (0..1, default 0.8) — higher = less oscillation
- `precision` (default 0.01) — stop threshold

Svelte ships `svelte/motion` `spring()` and `tweened()`. The current code
uses `spring()` correctly in some places but cubic-bezier easing in
others. **Recommendation: use springs for all card interactions** (hover,
select, play, flip) and cubic-bezier only for one-shot CSS animations
(particle bursts, glow pulses).

### 9.4 Frame-rate-independent animation

The current `update(delta)` pattern is frame-rate-dependent — if `delta`
varies (which it does on 144Hz monitors, see §3.3), animations run at
different speeds. The fix is to express all animation in terms of
**per-second rates**, not per-frame deltas:

```js
// BAD (frame-rate dependent)
card.position.x += 0.01;  // 0.01 units per frame

// GOOD (frame-rate independent)
card.position.x += 2.0 * delta;  // 2.0 units per second
```

For spring physics, the spring integrator must use `delta` correctly.
Svelte's `spring()` does this internally. For custom springs (like the
camera mouse-look in `scene.js`), use the critically-damped spring formula:

```js
// Critically-damped spring (from "Game Engine Gems 3" ch. 3)
const omega = 2 * Math.PI * freq;  // frequency in Hz
const x = position - target;
const v = velocity;
const a = -omega * omega * x - 2 * omega * v;
velocity += a * delta;
position += velocity * delta;
```

### 9.5 Concrete actions for §9

1. **Implement Fiedler accumulator** (from §3.3).
2. **Convert all card animations to springs** — not cubic-bezier.
3. **Tune up juice** — shake amplitudes ×1.5, hit-stop ×1.5, particle counts ×1.5.
4. **Add anticipation** to card play — card lifts 0.05m for 80ms before flying.
5. **Add follow-through** to card landing — card overshoots landing point by 0.02m, settles back.
6. **Add arcs** to card flight — parabolic path, not straight line (already done in `flyTo`, verify).
7. **Make all animations frame-rate-independent** — per-second rates, not per-frame.

---

## 10. AI-Assisted 3D Game Development

> This is the major AI section the user requested. It covers the 2026
> landscape of AI tools for 3D game dev, with concrete recommendations for
> our project.

### 10.1 AI 3D model generation (text-to-3D, image-to-3D)

The space has consolidated around ~4 credible commercial front-runners
plus open-source alternatives.

| Tool | Quality | Pricing | Output | Suitability |
|------|---------|---------|--------|-------------|
| **Meshy AI Pro** | Best balance | $20/mo, 1000 credits | GLB/FBX/OBJ, auto-rig, PBR | ⭐⭐⭐⭐ Primary |
| **Tripo3D Professional** | Cleanest topology | ~$16/mo | FBX/OBJ/GLB, `quad` mode | ⭐⭐⭐⭐ Backup |
| **Hyper3D Rodin** | Hyperrealistic | $20/mo | GLB, 500+ anims | ⭐⭐ Overkill for stylized |
| **Luma AI (Genie)** | Decent but deprioritized | Free tier | GLB | ⭐⭐ Skip |
| **Spline AI** | Mid-tier, web-native | $5/mo add-on | React/Spline scene | ⭐⭐ Not for Three.js |
| **Stable Fast 3D** (open-source) | Better than Shap-E | Free | GLB in <0.5s | ⭐⭐⭐ Free fallback |
| **TripoSR** (open-source) | Fast but coarse | Free | GLB in <0.5s | ⭐⭐ Prototyping |
| **Shap-E / Point-E** (OpenAI) | Low fidelity | Free | Implicit/point cloud | ⭐ Skip |

**Critical caveat**: None of the AI generators reliably produce a "stylized
gray humanoid avatar with good topology for animation." All need:
1. **Retopology** (QuadRemesher / InstantMeshes) — AI topology is messy
2. **Manual UV unwrap** — for the photo-face texture mapping
3. **Re-rigging** — auto-rigs are starting points, not finished

**For our project**: Use **Meshy AI Pro ($20/mo)** as the primary 3D
generator for the avatar base mesh. Prompt: "stylized gray humanoid, plain
untextured gray surface, A-pose, simple low-poly, no PBR textures." Then
retopologize with **InstantMeshes (free)**, rig with **AccuRig 2.0 (free)**,
and import the GLB into Three.js.

References:
- Meshy: [*meshy.ai*](https://www.meshy.ai)
- Tripo3D: [*tripo3d.ai*](https://www.tripo3d.ai)
- Stable Fast 3D: [*huggingface.co/stabilityai/stable-fast-3d*](https://huggingface.co/stabilityai/stable-fast-3d)
- TripoSR: [*github.com/VAST-AI-Research/TripoSR*](https://github.com/VAST-AI-Research/TripoSR)

### 10.2 AI texture generation

| Tool | What it does | Pricing | Suitability |
|------|--------------|---------|-------------|
| **Stable Diffusion + ControlNet** | Tileable PBR from prompts | Free (local) | ⭐⭐⭐⭐ Table felt, wood grain |
| **Substance 3D Sampler** | Photo-to-PBR decomposition | $19.99/mo | ⭐⭐⭐ Scan real materials |
| **Polycam AI Texture Generator** | Prompt-to-tileable-texture | ~$20/mo | ⭐⭐⭐ Fast batch |
| **Leonardo.ai** | Stylized game assets | $12–60/mo | ⭐⭐⭐ Face photos, card backs |
| **Ubisoft CHORD** (open-source) | RGB-to-PBR maps | Free | ⭐⭐⭐ Face photo decomposition |

**For our project**:
- **Card faces**: CanvasTexture at runtime (no AI needed — already done).
- **Table + felt**: One-month Polycam sub to batch-generate PBR library.
- **Avatar body**: Flat gray MeshPhysicalMaterial (no texture needed per spec).
- **Avatar face (photo)**: Pilot Ubisoft CHORD to decompose face photos into albedo + normal maps. Fallback: Leonardo.ai image-to-image.

References:
- SD+ControlNet workflow: [*reddit.com/r/StableDiffusion*](https://www.reddit.com/r/StableDiffusion/comments/1ignktc/pbr_texture_generator_v2_with_controlnetflux_and)
- Polycam: [*poly.cam/tools/ai-texture-generator*](https://poly.cam/tools/ai-texture-generator)
- Ubisoft CHORD: [*ubisoft.com/en-us/studio/laforge*](https://www.ubisoft.com/en-us/studio/laforge/news/1i3YOvQX2iArLlScBPqBZs)

### 10.3 AI animation

| Tool | What it does | Pricing | Suitability |
|------|--------------|---------|-------------|
| **Cascadeur** | AI-assisted keyframe animation | Free (indie) / $25–50/mo | ⭐⭐⭐ Card-dealing gestures |
| **Mixamo** (Adobe) | Auto-rig + 2500+ motion library | Free (but logins broken since June 2025) | ⭐⭐ Have backup ready |
| **AccuRig 2.0** (Reallusion) | Modern auto-rig + AI motion search | Free | ⭐⭐⭐⭐ Primary rigger |
| **DeepMotion** | AI mocap from video | Free tier / $18/mo | ⭐⭐⭐ Custom gestures |
| **Autodesk Flow Studio** (was Wonder Studio) | Video-to-CG scene | Subscription | ⭐ VFX, not games |
| **RADiCAL Motion** | AI mocap from webcam | Free / $15–30/mo | ⭐⭐ Comparable to DeepMotion |

**For our project**:
- **Rigging**: AccuRig 2.0 (free) — has official "rigging AI-generated models" tutorial.
- **Idle/breathing**: Mixamo (if logins work) → fallback ActorCore paid packs (~$25) → fallback hand-author 3 keyframes in Cascadeur.
- **Custom gestures** (head turn, card-pointing): DeepMotion ($18 for one month), capture from phone video, clean up in Blender.
- **Card flips/deals**: Hand-animate in code (already done in `cards.js`).

**Critical**: Mixamo has had a major outage since June 16, 2025 (outdated
account URL / SSL cert issue per Adobe community forums). Treat as "free
but currently unreliable." Always have AccuRig + ActorCore as backup.

References:
- Cascadeur: [*cascadeur.com*](https://cascadeur.com)
- AccuRig: [*actorcore.reallusion.com/auto-rig*](https://actorcore.reallusion.com/auto-rig)
- DeepMotion: [*deepmotion.com*](https://www.deepmotion.com)
- Mixamo: [*mixamo.com*](https://www.mixamo.com)

### 10.4 AI codegen for Three.js

The Three.js forum community is openly skeptical of ChatGPT for Three.js:
*"Is using ChatGPT useless for coding, esp. three.js? 100%, most of the
time."* Main reasons: suggests outdated versions, invents deprecated APIs,
hallucinates import paths.

**The winners:**
1. **Claude (Opus 4.5 / Sonnet 4.5)** — 94.2% accuracy on 2025 coding
   benchmarks. Best at complex Three.js architecture. Powers GitHub
   Copilot's agent mode.
2. **GitHub Copilot** — reads your existing codebase and matches
   conventions. Three.js forum users explicitly prefer it over ChatGPT
   because it doesn't hallucinate outdated APIs when your repo is modern.
3. **Cursor** — AI-first VS Code fork with Claude Sonnet 4.5 as default
   model. Best for whole-feature implementation.

**Common failure modes** (from Stack Overflow, Three.js forum, GitHub issues):
- `build/three.js` and `build/three.min.js` scripts deprecated since r150, removed in r160 — LLMs still suggest them.
- `import * as THREE from 'three'` vs `'three/tsl'` — multiple instances warning.
- Postprocessing imports break frequently.
- LLMs suggest `Geometry` (removed in r125) instead of `BufferGeometry`.
- LLMs suggest old `examples/js/` paths instead of `examples/jsm/` ES modules.

**What prompts work best:**
- Always include the Three.js version ("Using Three.js r185+ with ES modules via Vite...")
- Paste the relevant migration-guide section if asking about APIs that changed recently
- Show existing code and ask for a delta, not a from-scratch rewrite
- For shaders: explicitly request `ShaderMaterial` with `GLSL3` for modern GLSL ES 3.00
- For loaders: ask for `GLTFLoader` from `'three/examples/jsm/loaders/GLTFLoader.js'`

**For our project**: Use **Cursor ($20/mo) with Claude Sonnet 4.5**. Pin
Three.js version explicitly in a `CLAUDE.md` context file. Avoid Bolt/v0/
Lovable for the Three.js layer — they don't understand scene graphs.

References:
- Claude: [*anthropic.com/news/claude-opus-4-5*](https://www.anthropic.com/news/claude-opus-4-5)
- Cursor: [*cursor.sh*](https://cursor.sh)
- Three.js Migration Guide: [*github.com/mrdoob/three.js/wiki/Migration-Guide*](https://github.com/mrdoob/three.js/wiki/Migration-Guide)

### 10.5 AI asset pipelines (retopology, UV, upscaling)

| Tool | What it does | Pricing | Suitability |
|------|--------------|---------|-------------|
| **InstantMeshes** (open-source) | Quad auto-retopology | Free | ⭐⭐⭐⭐ Avatar retopo |
| **QuadRemesher** (Exoside) | Better quad retopo | $99 perpetual | ⭐⭐⭐⭐ If InstantMeshes insufficient |
| **RizomUV** | Pro UV unwrap | ~€55/mo or ~€300 | ⭐⭐⭐ Complex UVs |
| **AccuRig 2.0** | Auto-rigging | Free | ⭐⭐⭐⭐ Avatar rig |
| **Real-ESRGAN** (open-source) | AI texture upscaling | Free | ⭐⭐ Face photos |
| **Topaz Photo AI** | Best upscaling + face recovery | $199 perpetual | ⭐⭐ If Real-ESRGAN insufficient |

**For our project**: Run **InstantMeshes (free)** on Meshy avatar output
before rigging. Use **AccuRig 2.0 (free)** for rigging. Use **Real-ESRGAN
(free)** for any low-res face photos.

References:
- InstantMeshes: [*github.com/wjakob/instant-meshes*](https://github.com/wjakob/instant-meshes)
- QuadRemesher: [*exoside.com*](https://exoside.com)
- Real-ESRGAN: [*github.com/XPixelGroup/BasicSR*](https://github.com/XPixelGroup/BasicSR)

### 10.6 Research papers on AI for 3D

The academic foundation for modern text-to-3D:

1. **DreamFusion** (Poole et al., 2022) — [*arxiv.org/abs/2209.14988*](https://arxiv.org/abs/2209.14988)
   Introduced SDS (Score Distillation Sampling) — using a pretrained 2D
   diffusion model to optimize a NeRF. The breakthrough that kicked off
   text-to-3D.

2. **Magic3D** (Lin et al., NVIDIA, 2022) — [*arxiv.org/abs/2211.10440*](https://arxiv.org/abs/2211.10440)
   Coarse-to-fine dual-stage: low-res NeRF for geometry, high-res mesh
   for texture. 2× faster than DreamFusion.

3. **Score Jacobian Chaining** (Wang et al., CVPR 2023) — [*openaccess.thecvf.com*](https://openaccess.thecvf.com/content/CVPR2023/papers/Wang_Score_Jacobian_Chaining_Lifting_Pretrained_2D_Diffusion_Models_for_3D_CVPR_2023_paper.pdf)
   Replaced SDS with cleaner chain-rule backprop. Sharper 3D outputs.

4. **One-2-3-45** (Liu et al., NeurIPS 2023) — [*one-2-3-45.github.io*](https://one-2-3-45.github.io)
   Single image → full 360° textured mesh in 45 seconds, single feed-forward
   pass. The speed breakthrough.

5. **Wonder3D** (Long et al., CVPR 2024) — [*arxiv.org/abs/2310.15008*](https://arxiv.org/abs/2310.15008)
   Cross-domain diffusion (normal maps + color jointly). Higher fidelity
   than One-2-3-45.

6. **3D Gaussian Splatting** (Kerbl et al., SIGGRAPH 2023) — [*arxiv.org/abs/2308.04079*](https://arxiv.org/abs/2308.04079)
   The biggest paradigm shift: millions of anisotropic Gaussians, real-time
   radiance fields. Three.js implementations: **GaussianSplats3D**
   ([*github.com/mkkellogg/GaussianSplats3D*](https://github.com/mkkellogg/GaussianSplats3D))
   and **Spark.js** ([*sparkjs.dev*](https://sparkjs.dev)).

**For our project**: These papers are theoretical background — the
commercial tools (Meshy, Tripo) already implement descendants internally.
The one to watch for future iterations is **3D Gaussian Splatting** — if
we ever want a photoreal scanned table environment, the Three.js
implementations make it feasible in-browser. For our current stylized
aesthetic, polygonal meshes + soft shadows are correct.

### 10.7 Concrete AI workflow for our project

**Opinionated stack (minimum viable):**

| Need | Tool | Cost | Time |
|------|------|------|------|
| Avatar geometry | Meshy AI Pro | $20/mo | 30 min |
| Avatar retopology | InstantMeshes | Free | 15 min |
| Avatar rigging | AccuRig 2.0 | Free | 10 min |
| Idle/breathing anim | Mixamo (or ActorCore) | Free / ~$25 | 20 min |
| Custom gestures | DeepMotion (1 month) | $18 one-time | 1 hr |
| Table + felt textures | Polycam (1 month) | $20 one-time | 1 hr |
| Card geometry + faces | (already procedural) | $0 | $0 |
| Three.js/Svelte code | Cursor + Claude | $20/mo | ongoing |
| Easing curve iteration | Claude web | included | ongoing |

**Total: ~$60 one-time + $20/mo during production. ~$0/mo at runtime.**

**Failure modes to watch:**
1. AI topology won't deform — always retopologize before rigging. Non-negotiable.
2. Mixamo login breakage — keep AccuRig + ActorCore as backup.
3. Three.js LLM hallucinations — pin version in CLAUDE.md, paste migration guide.
4. Face-photo UV distortion — test with multiple face photos early.
5. Meshy/Tripo stylized-gray drift — explicitly prompt "plain untextured gray, no PBR."
6. Animation export format mismatches — convert FBX → GLB with `fbx2gltf` or Blender.

---

## 11. Performance Budget

### 11.1 Frame time budget

Target: **60 FPS = 16.67ms per frame**. Budget breakdown:

| Component | Budget | Notes |
|-----------|--------|-------|
| JS (sim, input, store updates) | 3ms | Svelte store updates, network events |
| Render (world camera) | 8ms | Scene traversal, draw calls, shaders |
| Render (viewmodel camera) | 1ms | Just the hand cards |
| Post-processing (TAA + N8AO + Bloom + ToneMap) | 3ms | GPU-bound |
| rAF overhead + GC | 1.67ms | Unavoidable |

If we exceed 16.67ms, we drop frames. Adaptive DPR (§3.1) kicks in to
reduce resolution.

### 11.2 Draw call budget

Modern desktop GPUs handle 1000+ draw calls easily; mobile struggles past
300. Our scene:

| Object | Draw calls |
|--------|------------|
| Floor | 1 |
| Table surface + ring | 2 |
| Avatars (4 × body + photo + label + blob shadow) | 16 |
| Hand cards (7 × 6 materials) | 42 |
| Table submissions (3 piles × 2 cards × 6 materials) | 36 |
| Black card | 6 |
| Lights (4) | 0 (lights aren't draw calls) |
| **Total** | **~103** |

Well within budget. No instancing needed.

### 11.3 Geometry budget

| Object | Triangles |
|--------|-----------|
| Floor (200×200 plane) | 2 |
| Table (circle, 64 segments) | 64 |
| Table ring (torus) | ~256 |
| Avatar (Design B) × 4 | 2800 |
| Hand cards (7 × box) × 4 | 672 |
| Table cards (3 piles × 2 × box) | 144 |
| Black card | 12 |
| **Total** | **~3950** |

Trivially cheap. Modern GPUs handle millions of triangles.

### 11.4 Texture memory budget

| Texture | Resolution | Memory (RGBA8) |
|---------|------------|----------------|
| Card front (per card) | 512 × 720 | 1.4 MB |
| Card back (shared) | 512 × 720 | 1.4 MB |
| Avatar photo (per player) | 256 × 256 | 256 KB |
| Avatar body (shared gray) | 1 × 1 | 4 B |
| Table normal map | 1024 × 1024 | 4 MB |
| Environment (PMREM) | 256 × 128 × 6 | 768 KB |
| **Total** | | **~10 MB** |

Well within budget (desktop GPUs have 4GB+, mobile 1GB+).

### 11.5 Concrete actions for §11

1. **Monitor frame time** — log if > 20ms for 5 consecutive frames.
2. **Implement adaptive DPR** — drop to 1.0 if frame time exceeds 20ms.
3. **Share geometries** — all cards use one `BoxGeometry` singleton (already done).
4. **Share materials** where possible (card edges, avatar body).
5. **Lazy-load Three.js** — already done (140kb gzip chunk, only fetched on game view).

---

## 12. Implementation Roadmap

Prioritized list of concrete fixes, in order of impact. Each item is
actionable and references the section that justifies it.

### Phase 1: Rendering fundamentals (highest impact)
1. **Fix `resize()`** — call `setSize(w, h, false)` with CSS pixels. [§3.1]
2. **Rewrite rAF loop** with Fiedler accumulator. [§3.3, §9.4]
3. **Clamp `delta`** to 0.25s max. [§3.3]
4. **Add `pmndrs/postprocessing`** with TAA + N8AO + Bloom + ACES tone mapping. [§3.2, §5.4]
5. **Move `toneMapping`** off renderer into post chain. [§3.2]
6. **Add `RoomEnvironment`** for PBR reflections. [§5.5]

### Phase 2: Shadows + materials (high impact)
7. **Tighten shadow frustum** to ±2 units. [§4.2]
8. **Increase shadow map** to 4096². [§4.2]
9. **Add blob shadows** under avatars and cards. [§4.3]
10. **Add normal maps** to cards (bevel) and table (felt). [§5.3]
11. **Bevel card geometry** or bake bevel into normal map. [§5.3]

### Phase 3: Cards + hand (high impact)
12. **Shrink cards** to 0.35 × 0.49 units. [§6.4]
13. **Raise cards** to `y=0.06` on table. [§6.1]
14. **Add `polygonOffset`** to table material. [§6.1]
15. **Enable anisotropic filtering** (16×) on card textures. [§6.2]
16. **Add viewmodel camera** on layer 1 with 50° FOV, 0.01 near. [§7.2]
17. **Move hand cards to layer 1**, parent to viewmodel camera. [§7.4]
18. **Render world then viewmodel** with `autoClear=false` + `clearDepth()`. [§7.2]

### Phase 4: Avatars (high impact)
19. **Implement Design B (The Egg)** — single deformed sphere, visor-patch photo. [§8.5]
20. **Add XP-gloss material** — `MeshPhysicalMaterial` with clearcoat + envMap. [§8.3]
21. **Implement idle animations** — breathing + weight shift + head tracking + micro-jitter. [§8.6]
22. **Fade base with Perlin noise** — not clean alpha gradient. [§8.5]

### Phase 5: Animation feel (medium impact)
23. **Convert card animations to springs** — not cubic-bezier. [§9.3]
24. **Tune up juice** — shake ×1.5, hit-stop ×1.5, particles ×1.5. [§9.2]
25. **Add anticipation** to card play — 80ms wind-up. [§9.1]
26. **Add follow-through** to card landing — overshoot + settle. [§9.1]
27. **Make all animations frame-rate-independent** — per-second rates. [§9.4]

### Phase 6: AI-assisted asset creation (optional, parallel)
28. **Generate avatar base mesh** with Meshy AI Pro. [§10.1]
29. **Retopologize** with InstantMeshes. [§10.5]
30. **Rig** with AccuRig 2.0. [§10.3]
31. **Apply idle animations** from Mixamo/ActorCore. [§10.3]
32. **Generate table textures** with Polycam AI. [§10.2]
33. **Set up Cursor + Claude** with pinned Three.js version in CLAUDE.md. [§10.4]

### Phase 7: Polish
34. **Add hand sway** based on camera rotation (Disney follow-through). [§7.5]
35. **Add adaptive DPR** for low-end devices. [§3.1]
36. **Tune shadow bias** per-object. [§4.5]
37. **Add subtle vignette** to post-processing chain. [§5.4]
38. **Profile + optimize** draw calls, geometry, texture memory per §11.

---

## 13. References

### Rendering fundamentals
1. MDN, *WebGL best practices* — https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices
2. Three.js forum, *HiDPI + fractional scaling* — https://discourse.threejs.org/t/hidpi-fractional-scaling-performance-pitfalls-and-best-practices/87114
3. Three.js docs, *WebGLRenderer.setPixelRatio* — https://threejs.org/docs/#api/en/renderers/WebGLRenderer.setPixelRatio
4. Three.js forum, *Performance of different antialiasing techniques* — https://discourse.threejs.org/t/performance-of-different-antialiasing-techniques/56740
5. Needle Articles, *Antialiasing and Post-Processing* — https://cloud.needle.tools/articles/antialiasing-and-postprocessing
6. mrdoob/three.js Issue #16747, *Should setPixelRatio be removed?* — https://github.com/mrdoob/three.js/issues/16747

### Frame pacing + animation
7. Glenn Fiedler, *Fix Your Timestep!* — https://gafferongames.com/post/fix_your_timestep/
8. Paul Irish, *requestAnimationFrame Scheduling For Nerds* — https://medium.com/@paul_irish/requestanimationframe-scheduling-for-nerds-9c57f7438ef4
9. Jake Archibald, *Tasks, microtasks, queues and schedules* — https://jakearchibald.com/2015/tasks-microtasks-queues-and-schedules/
10. web.dev, *Jank busting for better rendering performance* — https://web.dev/articles/speed-rendering
11. WebKit Bug 173434, *Support for 120Hz requestAnimationFrame* — https://bugs.webkit.org/show_bug.cgi?id=173434

### Shadows
12. NVIDIA GPU Gems 3, Ch. 8, *Summed-Area Variance Shadow Maps* — https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-8-summed-area-variance-shadow-maps
13. Dimitrov, *Cascaded Shadow Maps* (2007) — https://developer.download.nvidia.com/SDK/10.5/opengl/src/cascaded_shadow_maps/doc/cascaded_shadow_maps.pdf
14. SIGGRAPH 2012 Course Notes, *Efficient Real-Time Shadows* — https://www.cse.chalmers.se/~uffe/SIGGRAPH2012CourseNotes.pdf
15. Three.js example, *cascaded shadow maps* — https://threejs.org/examples/webgl_shadowmap_csm.html
16. Three.js forum, *Ambient occlusion (shadows) on the ground* — https://discourse.threejs.org/t/ambient-occlusion-shadows-on-the-ground/1873

### PBR materials
17. Brent Burley, *Physically-Based Shading at Disney* (SIGGRAPH 2012) — https://disney-animation.s3.amazonaws.com/library/s2012_pbs_disney_brdf_notes_v2.pdf
18. Brian Karis, *Real Shading in Unreal Engine 4* (SIGGRAPH 2013) — https://cdn2.unrealengine.com/Resources/files/2013SiggraphPresentationsNotes-26915738.pdf
19. Bruce Walter et al., *Microfacet Models for Refraction* (EGSR 2007) — https://www.cs.cornell.edu/~srm/publications/EGSR07-btdf.pdf
20. Matt Pharr, *Let's Stop Calling it 'GGX'* — https://pharr.org/matt/blog/2022/05/06/trowbridge-reitz
21. Polycount, *Bevel / Chamfer Edges vs Normal Map Bake* — https://polycount.com/discussion/215555/bevel-chamfer-edges-vs-normal-map-bake
22. pmndrs/postprocessing — https://github.com/pmndrs/postprocessing
23. Matt DesLauriers, *Filmic Effects in WebGL* — https://medium.com/@mattdesl/filmic-effects-for-webgl-9dab4bc899dc

### Card rendering
24. Chris Green (Valve), *Improved Alpha-Tested Magnification* (SIGGRAPH 2007) — https://steamcdn-a.akamaihd.net/apps/valve/2007/SIGGRAPH2007_AlphaTestedMagnification.pdf
25. Red Blob Games, *Guide to SDF+MSDF Fonts* — https://www.redblobgames.com/articles/sdf-fonts/
26. Microsoft Learn, *Depth Bias* — https://learn.microsoft.com/en-us/windows/win32/direct3d11/d3d10-graphics-programming-guide-output-merger-stage-depth-bias
27. mrdoob/three.js Issue #2593, *How to use polygonOffset* — https://github.com/mrdoob/three.js/issues/2593
28. Shawn Hargreaves, *Texture filtering: anisotropy* — https://shawnhargreaves.com/blog/texture-filtering-anisotropy.html

### First-person rendering
29. Unreal Engine 5.8 docs, *First Person Rendering* — https://dev.epicgames.com/documentation/en-unreal-engine/first-person-rendering
30. Unity Discussions, *Rendering of first person weapon model* — https://discussions.unity.com/t/rendering-of-first-person-weapon-model/719196
31. Three.js forum, *Multiple Scenes vs Layers* — https://discourse.threejs.org/t/multiple-scenes-vs-layers/12503
32. Wikipedia, *Field of view in video games* — https://en.wikipedia.org/wiki/Field_of_view_in_video_games
33. Playtank, *First-Person 3Cs: Camera* — https://playtank.io/2023/05/12/first-person-3cs-camera

### Avatar design
34. Walt Stanchfield, *Drawn to Life* (Routledge, 2009) — https://www.routledge.com/Drawn-to-Life-20-Golden-Years-of-Disney-Master-Classes-Two-Volume-Set-The-Walt-Stanchfield-Lectures/Stanchfield-Hahn/p/book/9781032494814
35. BBC Future, *The genius behind stick figure toilet signs* — https://www.bbc.com/future/article/20140911-the-genius-of-toilet-signs
36. GameDeveloper, *Early Among Us character concepts* — https://www.gamedeveloper.com/art/early-i-among-us-i-character-concepts-depict-the-birth-of-the-bean
37. The New Yorker, *A Journey to Make Video Games Into Art* — https://www.newyorker.com/tech/annals-of-technology/a-journey-to-make-video-games-into-art
38. ArtStation, *Fall Guys - World Design* — https://www.artstation.com/artwork/B1VJb8
39. ustwo, *Monument Valley* — https://ustwo.com/work/monument-valley
40. Wikipedia, *Bliss (photograph)* — https://en.wikipedia.org/wiki/Bliss_(photograph)
41. BetaWiki, *Luna* — https://betawiki.net/wiki/Luna
42. Wikipedia, *Frutiger Aero* — https://en.wikipedia.org/wiki/Frutiger_Aero
43. Three.js docs, *MeshToonMaterial* — https://threejs.org/docs/pages/MeshToonMaterial.html
44. Wikipedia, *Mii* — https://en.wikipedia.org/wiki/Mii
45. Apple Developer, *Tracking and visualizing faces* — https://developer.apple.com/documentation/arkit/tracking-and-visualizing-faces

### Animation feel
46. Frank Thomas & Ollie Johnston, *Disney Animation: The Illusion of Life* (1981) — Wikipedia: https://en.wikipedia.org/wiki/Disney_Animation:_The_Illusion_of_Life
47. Jan Willem Nijman (Vlambeer), *The Art of Screenshake* (INDIGO 2013) — https://www.youtube.com/watch?v=AJdEqssNZ-U
48. Josh Comeau, *A Friendly Introduction to Spring Physics Animation* — https://www.joshwcomeau.com/animation/a-friendly-introduction-to-spring-physics/
49. Issara Willenskomer, *UX in Motion Manifesto* — https://medium.com/ux-in-motion/creating-usability-with-motion-the-ux-in-motion-manifesto-a87a4584ddc
50. Nielsen Norman Group, *Executing UX Animations* — https://www.nngroup.com/articles/animation-duration/
51. MoCap Online, *Idle Animation for Games* — https://mocaponline.com/blogs/mocap-news/idle-animation-game-dev-guide
52. GarageFarm, *Idle Animation: Tips* — https://garagefarm.net/blog/idle-animation-tips-to-animate-your-characters
53. ResearchGate, *Making Characters more Alive* — https://www.researchgate.net/publication/361309980_Making_Characters_more_Alive_Study_of_Idle_Animation_in_Video_Games

### AI tools
54. Meshy AI — https://www.meshy.ai
55. Tripo3D — https://www.tripo3d.ai
56. Stable Fast 3D — https://huggingface.co/stabilityai/stable-fast-3d
57. TripoSR — https://github.com/VAST-AI-Research/TripoSR
58. Cascadeur — https://cascadeur.com
59. AccuRig 2.0 — https://actorcore.reallusion.com/auto-rig
60. DeepMotion — https://www.deepmotion.com
61. Mixamo — https://www.mixamo.com
62. Polycam AI Texture Generator — https://poly.cam/tools/ai-texture-generator
63. Ubisoft LaForge CHORD — https://www.ubisoft.com/en-us/studio/laforge/news/1i3YOvQX2iArLlScBPqBZs
64. Claude (Anthropic) — https://www.anthropic.com/news/claude-opus-4-5
65. Cursor — https://cursor.sh
66. GitHub Copilot — https://github.com/features/copilot
67. Three.js Migration Guide — https://github.com/mrdoob/three.js/wiki/Migration-Guide
68. InstantMeshes — https://github.com/wjakob/instant-meshes
69. QuadRemesher — https://exoside.com
70. Real-ESRGAN — https://github.com/XPixelGroup/BasicSR

### AI research papers
71. DreamFusion (Poole et al., 2022) — https://arxiv.org/abs/2209.14988
72. Magic3D (Lin et al., 2022) — https://arxiv.org/abs/2211.10440
73. Score Jacobian Chaining (Wang et al., CVPR 2023) — https://openaccess.thecvf.com/content/CVPR2023/papers/Wang_Score_Jacobian_Chaining_Lifting_Pretrained_2D_Diffusion_Models_for_3D_CVPR_2023_paper.pdf
74. One-2-3-45 (Liu et al., NeurIPS 2023) — https://one-2-3-45.github.io
75. Wonder3D (Long et al., CVPR 2024) — https://arxiv.org/abs/2310.15008
76. 3D Gaussian Splatting (Kerbl et al., SIGGRAPH 2023) — https://arxiv.org/abs/2308.04079
77. GaussianSplats3D (Three.js implementation) — https://github.com/mkkellogg/GaussianSplats3D

---

*End of research document. Total references: 77. Next step: implement Phase 1–5 of the roadmap in §12.*
