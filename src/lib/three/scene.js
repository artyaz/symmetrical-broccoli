/**
 * scene.js — Three.js scene manager for the symmetrical-broccoli CAH game.
 *
 * Sets up a first-person view of a "table" sitting in an infinite soft-gray
 * space. Procedural geometry only — no glTF, no external models. Cards (added
 * by other modules) are the only properly-textured objects; everything else
 * is subtle grays with soft shadows.
 *
 * Design language:
 *   - Background + fog: #ECECEC warm light gray. FogExp2 density 0.018 lets
 *     the 200x200 floor fade smoothly into infinity.
 *   - Single key DirectionalLight with PCFSoftShadowMap and shadow.radius 4
 *     for buttery soft shadows. A dim fill light kills harsh black shadows
 *     on the opposite side.
 *   - Materials use roughness >= 0.7 so nothing reads as plastic or wet.
 *
 * Camera:
 *   - Default pose is a "sitting at the table" view: (0, 1.6, 1.4) looking
 *     at (0, 0.8, 0) — the player's seat (south).
 *   - Subtle head-bob (sine wave) + tiny mouse-look spring keep the scene
 *     alive without being nauseating. Both respect prefers-reduced-motion.
 *   - cameraLookCloser() tween (800ms, reveal easing) zooms the camera in
 *     for inspecting played cards; calling again returns to default.
 *
 * Exports:
 *   - createScene(canvas) → { scene, camera, renderer, registerUpdate,
 *     resize, dispose, cameraLookCloser, getClock }
 *   - SEAT_POSITIONS  (4 seats, one per cardinal direction)
 *   - TABLE_RADIUS    (2.2)
 */

import * as THREE from 'three';
import { bezier } from '../anim/easing-helpers.js';

// ---------------------------------------------------------------------------
// PUBLIC CONSTANTS
// ---------------------------------------------------------------------------

/** Radius of the circular table surface (metres). */
export const TABLE_RADIUS = 2.2;

/**
 * Seat positions around the table. `pos` is the seat origin (feet on floor);
 * `rotY` is the yaw to apply so an avatar / card fan faces the table centre.
 * The camera occupies the 'south' seat — that's "you".
 */
export const SEAT_POSITIONS = [
  { id: 'south', pos: [0,    0,  1.5], rotY:  Math.PI,       label: 'you' },
  { id: 'west',  pos: [-1.5, 0,  0  ], rotY:  Math.PI / 2,   label: 'left' },
  { id: 'north', pos: [0,    0, -1.5], rotY:  0,             label: 'across' },
  { id: 'east',  pos: [1.5,  0,  0  ], rotY: -Math.PI / 2,   label: 'right' },
];

// ---------------------------------------------------------------------------
// CAMERA POSES
// ---------------------------------------------------------------------------

const DEFAULT_POS  = new THREE.Vector3(0, 1.6, 1.4);
const DEFAULT_LOOK = new THREE.Vector3(0, 0.8, 0);
const CLOSER_POS   = new THREE.Vector3(0, 1.2, 0.7);
const CLOSER_LOOK  = new THREE.Vector3(0, 0.4, 0);

const LOOK_CLOSER_MS = 800;

// Mouse-look rotation limits (radians). Subtle — not FPS-style.
const YAW_MAX_RAD   = THREE.MathUtils.degToRad(3);
const PITCH_MAX_RAD = THREE.MathUtils.degToRad(1.5);

// Head-bob amplitudes (metres) and frequencies (Hz).
const BOB_Y_AMP = 0.01;
const BOB_Y_HZ  = 0.6;
const BOB_X_AMP = 0.005;
const BOB_X_HZ  = 0.4;

// ---------------------------------------------------------------------------
// PREFERS-REDUCED-MOTION
// ---------------------------------------------------------------------------

function prefersReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------------------------------------------------------------------------
// DAMPED SPRING (tiny inline impl)
// ---------------------------------------------------------------------------
// The easing-helpers.js exports Svelte-flavoured spring configs (stiffness /
// damping in 0..1) which only make sense when fed to Svelte's `spring()` store.
// For raw JS we need actual physics. This is a 1-DOF damped spring with
// explicit mass-spring-damper coefficients; critically damped by default so
// the mouse-look eases to its target without overshooting.
// ---------------------------------------------------------------------------

function makeDampedSpring(freqHz = 4, dampingRatio = 1.0) {
  const omega = 2 * Math.PI * freqHz;
  const k = omega * omega;            // stiffness
  const c = 2 * dampingRatio * omega; // damping coefficient
  let pos = 0;
  let vel = 0;
  return {
    set(value) { pos = value; vel = 0; },
    get() { return pos; },
    update(target, dt) {
      // Clamp dt to avoid blow-ups after tab-switch pauses.
      const step = Math.min(dt, 1 / 30);
      const force = -k * (pos - target) - c * vel;
      vel += force * step;
      pos += vel * step;
      return pos;
    },
  };
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
    antialias: true,
    alpha: false, // we paint our own background
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  // --- Scene --------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xECECEC);
  scene.fog = new THREE.FogExp2(0xECECEC, 0.018);

  // --- Camera -------------------------------------------------------------
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
  camera.position.copy(DEFAULT_POS);

  // "Base" pose that bob/mouse/tween offsets are applied on top of.
  const basePos  = DEFAULT_POS.clone();
  const baseLook = DEFAULT_LOOK.clone();

  // --- Lights -------------------------------------------------------------
  const ambient = new THREE.AmbientLight(0xFFFFFF, 0.6);
  scene.add(ambient);

  const hemi = new THREE.HemisphereLight(0xFFFFFF, 0xDCDCDC, 0.4);
  scene.add(hemi);

  const keyLight = new THREE.DirectionalLight(0xFFFFFF, 1.2);
  keyLight.position.set(3, 6, 4);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.left   = -4;
  keyLight.shadow.camera.right  =  4;
  keyLight.shadow.camera.top    =  4;
  keyLight.shadow.camera.bottom = -4;
  keyLight.shadow.camera.near   = 0.5;
  keyLight.shadow.camera.far    = 20;
  keyLight.shadow.bias          = -0.0005;
  keyLight.shadow.radius        = 4;
  keyLight.shadow.camera.updateProjectionMatrix();
  scene.add(keyLight);
  // DirectionalLight targets origin by default — explicit target keeps it stable.
  scene.add(keyLight.target);

  const fillLight = new THREE.DirectionalLight(0xF0F0F5, 0.3);
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

  // --- Table surface (subtle circular plane) ------------------------------
  const table = new THREE.Mesh(
    new THREE.CircleGeometry(TABLE_RADIUS, 64),
    new THREE.MeshStandardMaterial({
      color: 0xDEDEDE,
      roughness: 0.7,
      metalness: 0,
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

  // --- Initial camera orientation -----------------------------------------
  camera.lookAt(baseLook);

  // --- Animation loop state ----------------------------------------------
  const clock = new THREE.Clock();
  const updateCallbacks = new Set();
  let rafId = null;
  let disposed = false;

  // Input + accessibility state.
  let reducedMotion = prefersReducedMotion();
  const mouseTarget = new THREE.Vector2(0, 0);
  const yawSpring   = makeDampedSpring(4, 1.0);
  const pitchSpring = makeDampedSpring(4, 1.0);

  // Tween state for cameraLookCloser().
  const tween = {
    active: false,
    start: 0,
    duration: LOOK_CLOSER_MS,
    fromPos:  new THREE.Vector3(),
    toPos:    new THREE.Vector3(),
    fromLook: new THREE.Vector3(),
    toLook:   new THREE.Vector3(),
    easing: bezier.reveal,
  };
  let isCloser = false;
  let mouseInfluence = 1; // dampened while a tween is running

  // --- Mouse handler ------------------------------------------------------
  function onMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((e.clientY - rect.top) / rect.height) * 2 - 1); // flip: up = +
    mouseTarget.set(x, y);
  }

  // --- prefers-reduced-motion listener -----------------------------------
  let reducedMotionMql = null;
  function onReducedMotionChange(e) {
    reducedMotion = e.matches;
    if (reducedMotion) {
      // Snap to neutral so the camera doesn't sit at a stale offset.
      yawSpring.set(0);
      pitchSpring.set(0);
      mouseTarget.set(0, 0);
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

  // --- Resize -------------------------------------------------------------
  function resize(w, h) {
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  // --- Camera "look closer" toggle ---------------------------------------
  function cameraLookCloser() {
    tween.fromPos.copy(basePos);
    tween.fromLook.copy(baseLook);
    if (isCloser) {
      tween.toPos.copy(DEFAULT_POS);
      tween.toLook.copy(DEFAULT_LOOK);
    } else {
      tween.toPos.copy(CLOSER_POS);
      tween.toLook.copy(CLOSER_LOOK);
    }
    tween.start = performance.now();
    tween.active = true;
    isCloser = !isCloser;
  }

  // --- Animation loop -----------------------------------------------------
  function tick() {
    if (disposed) return;
    const dt = clock.getDelta();
    const t  = clock.elapsedTime;

    // Drive the look-closer tween.
    if (tween.active) {
      const elapsed = performance.now() - tween.start;
      const k = Math.min(1, Math.max(0, elapsed / tween.duration));
      const eased = tween.easing(k);
      basePos.lerpVectors(tween.fromPos,  tween.toPos,  eased);
      baseLook.lerpVectors(tween.fromLook, tween.toLook, eased);
      // Dampen mouse-look influence during the tween so they don't fight.
      // Full influence at the endpoints, zero at the midpoint.
      mouseInfluence = Math.abs(k - 0.5) * 2;
      if (k >= 1) {
        tween.active = false;
        mouseInfluence = 1;
      }
    }

    // Update mouse-look springs (subtle, smooth).
    if (!reducedMotion) {
      yawSpring.update(mouseTarget.x * YAW_MAX_RAD, dt);
      pitchSpring.update(mouseTarget.y * PITCH_MAX_RAD, dt);
    }

    // Head-bob offsets (sine waves).
    let bobX = 0;
    let bobY = 0;
    if (!reducedMotion) {
      bobX = Math.sin(t * 2 * Math.PI * BOB_X_HZ) * BOB_X_AMP;
      bobY = Math.sin(t * 2 * Math.PI * BOB_Y_HZ) * BOB_Y_AMP;
    }

    // Apply transforms to the camera.
    camera.position.set(
      basePos.x + bobX,
      basePos.y + bobY,
      basePos.z,
    );
    camera.lookAt(baseLook);
    if (!reducedMotion) {
      // lookAt orients local Y = world Y, so rotateY is world-yaw. Then
      // rotateX pitches around the post-yaw local X (FPS-style).
      camera.rotateY(yawSpring.get() * mouseInfluence);
      camera.rotateX(pitchSpring.get() * mouseInfluence);
    }

    // Run registered update callbacks (card animations, etc.).
    if (updateCallbacks.size > 0) {
      for (const fn of updateCallbacks) {
        try {
          fn(dt, t);
        } catch (err) {
          console.error('[scene update callback]', err);
        }
      }
    }

    renderer.render(scene, camera);
    rafId = requestAnimationFrame(tick);
  }

  // Kick off the loop.
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
    disposeObject3D(scene);
    renderer.dispose();
  }

  return {
    scene,
    camera,
    renderer,
    registerUpdate,
    resize,
    dispose,
    cameraLookCloser,
    getClock,
  };
}

export default { createScene, SEAT_POSITIONS, TABLE_RADIUS };
