/**
 * scene.js — Three.js scene manager for the symmetrical-broccoli CAH game.
 *
 * Rebuilt (p1) to address the rendering problems diagnosed in
 * docs/RESEARCH_3D_REBUILD.md §2–§5: low resolution, screen shuttering,
 * poor shadows, and a flat / cheap-looking image with no post-processing.
 *
 * Pipeline highlights:
 *   - WebGLRenderer: PCFSoftShadowMap, SRGBColorSpace, NoToneMapping on
 *     the renderer (tone mapping moves into the post-processing chain —
 *     critical to avoid double-tonemapping with pmndrs/postprocessing).
 *   - Adaptive DPR with dirty-check resize, called every tick (cheap when
 *     the device-pixel buffer size hasn't changed). Research §3.1.
 *   - Delta-clamped rAF loop: `delta = min((t - last)/1000, 0.05)` so a
 *     backgrounded tab refocus doesn't teleport animations. No fixed
 *     timestep — our sim is reactive (Svelte store updates), not physics —
 *     but the clamp covers the user-visible failure mode in §2.7.
 *   - Frame-rate-independent lerp (`1 - exp(-delta / lag)`) for the camera
 *     "look closer" toggle, mouse-look spring, and idle head-bob.
 *   - Shadow: 4096² PCFSoftShadowMap, tight ±2 frustum (4× effective
 *     resolution vs old ±4), near 0.5 / far 10, bias -0.0005, radius 4.
 *   - RoomEnvironment baked once via PMREMGenerator for free IBL; PMREM
 *     disposed after baking. Research §5.5.
 *   - Post-processing chain (pmndrs/postprocessing + n8ao):
 *       RenderPass → N8AOPostPass → Bloom → SMAA → ACES ToneMapping
 *     EffectComposer uses HalfFloat HDR frame buffers + MSAA(4) baseline.
 *     TAA deliberately skipped — see note in setupPostProcessing().
 *
 * Exports:
 *   - createScene(canvas) → { scene, camera, renderer, composer,
 *     registerUpdate, resize, dispose, cameraLookCloser, getClock }
 *   - SEAT_POSITIONS  (4 seats, one per cardinal direction)
 *   - TABLE_RADIUS    (2.2)
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  ToneMappingEffect,
  ToneMappingMode,
  BloomEffect,
  SMAAEffect,
  SMAAPreset,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

// ---------------------------------------------------------------------------
// PUBLIC CONSTANTS
// ---------------------------------------------------------------------------

/** Radius of the circular table surface (metres). */
export const TABLE_RADIUS = 2.2;

/**
 * Seat positions around the table. `pos` is the seat origin (feet on floor);
 * `rotY` is the yaw so an avatar / card fan faces the table centre.
 * The camera occupies the 'south' seat — that's "you".
 *
 * NOTE: avatar.js keeps its own copy to avoid a circular import; if you
 * change this here, update that too.
 */
export const SEAT_POSITIONS = [
  { id: 'south', pos: [0,    0,  1.5], rotY:  Math.PI,       label: 'you' },
  { id: 'west',  pos: [-1.5, 0,  0  ], rotY:  Math.PI / 2,   label: 'left' },
  { id: 'north', pos: [0,    0, -1.5], rotY:  0,             label: 'across' },
  { id: 'east',  pos: [1.5,  0,  0  ], rotY: -Math.PI / 2,   label: 'right' },
];

// ---------------------------------------------------------------------------
// CAMERA POSES + SPRING CONSTANTS
// ---------------------------------------------------------------------------

const DEFAULT_POS  = new THREE.Vector3(0, 1.6, 1.4);
const DEFAULT_LOOK = new THREE.Vector3(0, 0.8, 0);
const CLOSER_POS   = new THREE.Vector3(0, 1.2, 0.7);
const CLOSER_LOOK  = new THREE.Vector3(0, 0.4, 0);

// Frame-rate-independent lerp lag (seconds). Per-frame factor is
// `1 - exp(-delta / lag)`; converges with time-constant `lag` regardless of
// frame rate. Smaller = snappier.
const LOOK_CLOSER_LAG = 0.30;  // 300ms ease for the camera toggle
const MOUSE_LOOK_LAG  = 0.15;  // 150ms ease for mouse-look

// Mouse-look rotation limits (radians). Subtle — not FPS-style.
const YAW_MAX_RAD   = THREE.MathUtils.degToRad(3);    // ±3°
const PITCH_MAX_RAD = THREE.MathUtils.degToRad(1.5);  // ±1.5°

// Head-bob amplitudes (m) + frequencies (Hz). Subtle "living camera" feel.
const BOB_Y_AMP = 0.008, BOB_Y_HZ = 0.6;
const BOB_X_AMP = 0.004, BOB_X_HZ = 0.4;

// Delta clamp: prevents teleport-on-refocus (research §2.7). 50ms = 20fps min.
const MAX_DELTA = 0.05;

// ---------------------------------------------------------------------------
// PREFERS-REDUCED-MOTION
// ---------------------------------------------------------------------------

function prefersReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Frame-rate-independent lerp factor. `current += (target - current) * factor`
 *  converges to target with time-constant `lag` seconds, regardless of fps.
 *  Equivalent to integrating `dx/dt = -(x - target) / lag` over `delta`. */
function lerpFactor(delta, lag) {
  return 1 - Math.exp(-delta / lag);
}

// ---------------------------------------------------------------------------
// DISPOSAL HELPER
// ---------------------------------------------------------------------------

/** Recursively dispose geometry / material / textures under an Object3D. */
function disposeObject3D(obj) {
  obj.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) {
        for (const key in m) {
          const v = m[key];
          if (v && v.isTexture) v.dispose();
        }
        m.dispose();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// SCENE FACTORY
// ---------------------------------------------------------------------------

export function createScene(canvas) {
  // --- Renderer -----------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,   // baseline MSAA; SMAA layered on top in the chain
    alpha: false,      // we paint our own background
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // CRITICAL: leave tone mapping OFF on the renderer. The ToneMappingEffect
  // at the end of the post chain handles ACES; if the renderer also
  // tone-maps, colors get double-tonemapped and look dark/muddy.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1.0;

  // --- Scene --------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xECECEC);
  scene.fog = new THREE.FogExp2(0xECECEC, 0.018);

  // --- Environment (IBL) — bake RoomEnvironment once, dispose PMREM -------
  const pmrem = new THREE.PMREMGenerator(renderer);
  // 0.04 = sigma in fromScene() blur; soft studio look without sharp
  // reflection highlights from the procedural RoomEnvironment lights.
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  // Cap env-map contribution so PBR materials don't get double-lit by both
  // the env map and the explicit lights (causes over-exposure).
  scene.environmentIntensity = 0.5;
  pmrem.dispose();

  // --- Camera -------------------------------------------------------------
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
  camera.position.copy(DEFAULT_POS);
  camera.lookAt(DEFAULT_LOOK);

  // --- Lights -------------------------------------------------------------
  // Ambient + Hemisphere dimmed slightly vs the old scene because the
  // RoomEnvironment now contributes a soft IBL fill — stacking both at the
  // old strengths washed everything out.
  const ambient = new THREE.AmbientLight(0xFFFFFF, 0.25);
  scene.add(ambient);
  const hemi = new THREE.HemisphereLight(0xFFFFFF, 0xDCDCDC, 0.2);
  scene.add(hemi);

  const keyLight = new THREE.DirectionalLight(0xFFFFFF, 1.0);
  keyLight.position.set(3, 6, 4);
  keyLight.castShadow = true;
  // 4096² + tight ±2 frustum = 1024 samples/unit (vs old 2048² + ±4 = 256).
  // Avatar heads (~0.32r) go from ~80 to ~320 samples across — the
  // difference between "pixelated" and "soft". Research §4.2.
  keyLight.shadow.mapSize.set(4096, 4096);
  keyLight.shadow.camera.left   = -2;
  keyLight.shadow.camera.right  =  2;
  keyLight.shadow.camera.top    =  2;
  keyLight.shadow.camera.bottom = -2;
  keyLight.shadow.camera.near   = 0.5;
  keyLight.shadow.camera.far    = 10;
  keyLight.shadow.bias          = -0.0005;
  keyLight.shadow.radius        = 4;  // soft penumbra
  keyLight.shadow.camera.updateProjectionMatrix();
  scene.add(keyLight);
  scene.add(keyLight.target); // explicit target keeps direction stable

  const fillLight = new THREE.DirectionalLight(0xF0F0F5, 0.2);
  fillLight.position.set(-3, 4, -2);
  scene.add(fillLight);

  // --- Floor (infinite fade into fog) ------------------------------------
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({
      color: 0xE8E8E8,
      roughness: 0.95,
      metalness: 0,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // --- Table surface ------------------------------------------------------
  // polygonOffset pushes the table back in depth space so co-planar geometry
  // above it (cards at y=0.03+) doesn't z-fight. Belt-and-suspenders with
  // the physical separation cards.js applies. Research §6.1.
  const table = new THREE.Mesh(
    new THREE.CircleGeometry(TABLE_RADIUS, 64),
    new THREE.MeshStandardMaterial({
      color: 0xDEDEDE,
      roughness: 0.7,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
  );
  table.rotation.x = -Math.PI / 2;
  table.position.y = 0.02;
  table.receiveShadow = true;
  scene.add(table);

  // --- Table edge ring (subtle definition) --------------------------------
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(TABLE_RADIUS, 0.015, 16, 96),
    new THREE.MeshStandardMaterial({
      color: 0xC8C8C8,
      roughness: 0.7,
      metalness: 0,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.021; // a hair above the table to avoid z-fighting
  scene.add(ring);

  // --- Post-processing chain ---------------------------------------------
  const composer = setupPostProcessing(renderer, scene, camera);

  // --- Animation loop state ----------------------------------------------
  const clock = new THREE.Clock();
  const updateCallbacks = new Set();
  let rafId = null;
  let disposed = false;
  let lastTime = performance.now();

  // Input + accessibility state.
  let reducedMotion = prefersReducedMotion();
  let mouseX = 0;
  let mouseY = 0;
  let yawSpring = 0;
  let pitchSpring = 0;

  // "Look closer" toggle — a 0..1 lerp that drives camera position + lookAt.
  let lookCloser = false;
  let camLerp = 0;

  // Scratch vectors (avoid per-frame allocation).
  const _pos    = new THREE.Vector3();
  const _look   = new THREE.Vector3();
  const _closer = new THREE.Vector3();

  // --- Mouse handler ------------------------------------------------------
  function onMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    mouseX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    // Flip Y so up = + (matches camera pitch intuition).
    mouseY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
  }

  // --- prefers-reduced-motion listener -----------------------------------
  let reducedMotionMql = null;
  function onReducedMotionChange(e) {
    reducedMotion = e.matches;
    if (reducedMotion) {
      // Snap to neutral so the camera doesn't sit at a stale offset.
      yawSpring = 0;
      pitchSpring = 0;
      mouseX = 0;
      mouseY = 0;
    }
  }
  if (typeof window !== 'undefined' && window.matchMedia) {
    reducedMotionMql = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reducedMotionMql.addEventListener) {
      reducedMotionMql.addEventListener('change', onReducedMotionChange);
    } else if (reducedMotionMql.addListener) {
      // Safari < 14 fallback.
      reducedMotionMql.addListener(onReducedMotionChange);
    }
  }

  // Mouse listener on window so it works even with the cursor off the canvas.
  if (typeof window !== 'undefined') {
    window.addEventListener('mousemove', onMouseMove, { passive: true });
  }

  // --- Update callbacks ---------------------------------------------------
  function registerUpdate(fn) {
    updateCallbacks.add(fn);
    return function unregister() {
      updateCallbacks.delete(fn);
    };
  }

  function getClock() {
    return clock;
  }

  // --- Adaptive-DPR resize (dirty-checked) --------------------------------
  // Called every tick. When the device-pixel buffer hasn't changed (the
  // common case) it's two integer comparisons + early return. Research §3.1.
  //
  // Signature `(w, h)` is kept for backward-compat with Game3D.svelte which
  // calls `sceneApi.resize(window.innerWidth, window.innerHeight)`. If
  // either is omitted, falls back to canvas CSS pixel dims (the correct
  // source of truth — the drawing buffer should match CSS size × DPR).
  function resize(w, h) {
    const cssW = (w && h) ? w : (canvas.clientWidth  || window.innerWidth);
    const cssH = (w && h) ? h : (canvas.clientHeight || window.innerHeight);
    if (!cssW || !cssH) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.floor(cssW * dpr);
    const bh = Math.floor(cssH * dpr);
    // Dirty-check against the device-pixel buffer (canvas.width/height are
    // the buffer dims set by renderer.setSize).
    if (canvas.width === bw && canvas.height === bh) return;
    renderer.setPixelRatio(dpr);
    renderer.setSize(cssW, cssH, false); // false = don't override CSS
    camera.aspect = cssW / cssH;
    camera.updateProjectionMatrix();
    composer.setSize(cssW, cssH);
  }

  // --- Camera "look closer" toggle ---------------------------------------
  // Toggles a frame-rate-independent lerp between DEFAULT and CLOSER poses.
  // No tween bookkeeping — the per-frame lerp handles both directions and
  // naturally eases out as it approaches the target.
  function cameraLookCloser() {
    lookCloser = !lookCloser;
  }

  // --- Animation loop -----------------------------------------------------
  function tick(time) {
    if (disposed) return;

    // 1) Adaptive-DPR resize — cheap dirty-check every frame.
    resize();

    // 2) Delta clamp — prevents teleport-on-refocus (§2.7).
    const delta = Math.min((time - lastTime) / 1000, MAX_DELTA);
    lastTime = time;
    const t = time / 1000;

    // 3) Look-closer lerp toward its target (frame-rate-independent).
    const targetLerp = lookCloser ? 1 : 0;
    camLerp += (targetLerp - camLerp) * lerpFactor(delta, LOOK_CLOSER_LAG);

    // 4) Mouse-look springs (subtle, frame-rate-independent).
    if (!reducedMotion) {
      const targetYaw   = mouseX * YAW_MAX_RAD;
      const targetPitch = mouseY * PITCH_MAX_RAD;
      yawSpring   += (targetYaw   - yawSpring)   * lerpFactor(delta, MOUSE_LOOK_LAG);
      pitchSpring += (targetPitch - pitchSpring) * lerpFactor(delta, MOUSE_LOOK_LAG);
    }

    // 5) Camera base pose = lerp between DEFAULT and CLOSER.
    _pos.lerpVectors(DEFAULT_POS,  CLOSER_POS,  camLerp);
    _look.lerpVectors(DEFAULT_LOOK, CLOSER_LOOK, camLerp);

    // 6) Head-bob offsets (sine waves) on top of the base pose.
    if (!reducedMotion) {
      _pos.y += Math.sin(t * BOB_Y_HZ * Math.PI * 2) * BOB_Y_AMP;
      _pos.x += Math.sin(t * BOB_X_HZ * Math.PI * 2) * BOB_X_AMP;
    }

    // 7) Position + orient the camera. lookAt first (sets local Y = world Y),
    //    then FPS-style yaw (world Y) + pitch (local X after yaw).
    camera.position.copy(_pos);
    camera.lookAt(_look);
    if (!reducedMotion) {
      camera.rotateY(yawSpring);
      camera.rotateX(pitchSpring);
    }

    // 8) Run registered update callbacks (card animations, avatar breathing).
    //    They receive the clamped delta + elapsed time.
    if (updateCallbacks.size > 0) {
      for (const fn of updateCallbacks) {
        try { fn(delta, t); }
        catch (err) { console.error('[scene update callback]', err); }
      }
    }

    // 9) Render via the post-processing composer.
    composer.render(delta);
    rafId = requestAnimationFrame(tick);
  }

  // Kick off the loop. First frame uses lastTime = performance.now() set
  // above, so delta on frame 1 is ~0 (no initial lurch).
  rafId = requestAnimationFrame(tick);

  // --- Dispose ------------------------------------------------------------
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('mousemove', onMouseMove);
    }
    if (reducedMotionMql) {
      if (reducedMotionMql.removeEventListener) {
        reducedMotionMql.removeEventListener('change', onReducedMotionChange);
      } else if (reducedMotionMql.removeListener) {
        reducedMotionMql.removeListener(onReducedMotionChange);
      }
      reducedMotionMql = null;
    }
    updateCallbacks.clear();
    composer.dispose();
    disposeObject3D(scene);
    // Dispose the baked environment texture (it's a GPU resource).
    if (scene.environment) scene.environment.dispose();
    renderer.dispose();
  }

  return {
    scene,
    camera,
    renderer,
    composer,
    registerUpdate,
    resize,
    dispose,
    cameraLookCloser,
    getClock,
  };
}

// ---------------------------------------------------------------------------
// POST-PROCESSING CHAIN
// ---------------------------------------------------------------------------

/**
 * Build the EffectComposer pass chain. Order matters — each pass reads the
 * previous pass's output buffer:
 *   1. RenderPass       — rasterise scene (beauty + depth) to inputBuffer
 *   2. N8AOPostPass     — SSAO; reads depth texture (auto-attached by the
 *                         composer because N8AOPostPass sets needsDepthTexture)
 *                         and beauty texture, multiplies AO into beauty
 *   3. Bloom EffectPass — additive mipmap-blur bloom on bright pixels
 *   4. SMAA EffectPass  — sub-pixel edge enhancement (complements MSAA)
 *   5. ToneMappingPass  — ACES Filmic; MUST be last so prior passes operate
 *                         in HDR linear space
 *
 * HalfFloat frame buffer lets Bloom accumulate HDR values without clipping
 * before tone mapping. `multisampling=4` is hardware MSAA on the scene
 * rasterisation (WebGL2; silently 0 on WebGL1 where SMAA picks up slack).
 *
 * DEVIATION FROM SPEC: research §3.2 recommends true TAA (TAAPass). TAA in
 * Three.js needs camera motion vectors (velocity buffer) to reproject the
 * previous frame — every animated object must write its screen-space motion
 * into a velocity target, else moving things leave a smearing trail. For
 * our scene (flying cards, breathing avatars, bobbing camera) that's a
 * substantial motion-vector subsystem. MSAA(4) + SMAA(HIGH) gives most of
 * the visible quality at a fraction of the complexity, with no ghosting.
 * Revisit TAA if shimmer is still a problem after this lands.
 */
function setupPostProcessing(renderer, scene, camera) {
  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,  // HDR; lets Bloom accumulate >1
    multisampling: 4,                      // MSAA on scene rasterisation
  });

  // 1) Render the scene.
  composer.addPass(new RenderPass(scene, camera));

  // 2) N8AO — SSAO for crease + contact darkening. Half-res for perf (the
  //    AO signal is low-frequency, visually lossless after bilateral upscale).
  //    Color = pure black so AO darkens toward shadow, not a tint. Intensity
  //    1.5 is moderate; the default of 5 is far too hot for dim lighting.
  const n8ao = new N8AOPostPass(scene, camera, 1, 1);
  n8ao.configuration.aoSamples = 16;
  n8ao.configuration.halfRes = true;
  n8ao.configuration.color = new THREE.Color(0, 0, 0);
  n8ao.configuration.intensity = 2.5;
  // aoRadius is world units; default 5.0 covers creases around cards on the
  // table and under avatar feet without bleeding AO across the whole scene.
  composer.addPass(n8ao);

  // 3) Bloom — subtle highlight glow. Threshold 0.6 means only the brightest
  //    pixels (specular hits on cards, label sprites) bloom; midtones stay
  //    clean. mipmapBlur gives a soft photographic falloff.
  composer.addPass(new EffectPass(camera, new BloomEffect({
    intensity: 0.15,
    luminanceThreshold: 0.85,
    mipmapBlur: true,
  })));

  // 4) SMAA — sub-pixel morphological antialiasing. Catches shader aliasing
  //    (specular crawl, texture shimmer) that MSAA can't, because MSAA only
  //    supersamples polygon edges, not pixels shaded inside a triangle.
  //    HIGH preset is the quality/perf sweet spot.
  composer.addPass(new EffectPass(camera, new SMAAEffect({
    preset: SMAAPreset.HIGH,
  })));

  // 5) ACES Filmic tone mapping — last so every prior pass operated in
  //    linear HDR. ACES is the de-facto filmic curve since 2016 (§5.4);
  //    it desaturates highlights instead of clipping them to white.
  composer.addPass(new EffectPass(camera, new ToneMappingEffect({
    mode: ToneMappingMode.ACES_FILMIC,
  })));

  return composer;
}

export default { createScene, SEAT_POSITIONS, TABLE_RADIUS };
