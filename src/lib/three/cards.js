/**
 * cards.js — 3D card system for the symmetrical-broccoli CAH game.
 *
 * Each card is a thin BoxGeometry (0.7 × 1.0 × 0.012) with 6 materials:
 *   - Front (+Z) and back (-Z) faces: MeshStandardMaterial with a CanvasTexture
 *     (rendered text + "broccoli." logo on the back).
 *   - Edges (+X, -X, +Y, -Y): MeshStandardMaterial with a solid color slightly
 *     darker than the face, giving the card visual depth.
 *
 * Card lifecycle states (set via `setState`):
 *   - 'hand'        — fanned in front of the south seat (player view).
 *   - 'flying'      — mid bezier-arc flight toward the table.
 *   - 'table-down'  — lying flat on the table, back face up (submission pile).
 *   - 'table-up'    — lying flat on the table, front face up (revealed).
 *   - 'black-stand' — standing upright on the table, tilted back ~10°.
 *
 * Rotation conventions (Three.js Euler default order 'XYZ'):
 *   - hand fan:      (rx=-10°, ry=-fan_angle, rz=0) — upright, fanned.
 *   - table-up:      (rx=-π/2, ry=0,    rz=0)       — flat, front face up.
 *   - table-down:    (rx=-π/2, ry=π,    rz=0)       — flat, back face up.
 *   - black-stand:   (rx=-10°, ry=0,    rz=0)       — upright, tilted back.
 *
 * The face-up ↔ face-down transition is a π rotation around local Y
 * (which is the in-plane "south" horizontal axis once the card is flat).
 * BoxGeometry UV mapping was verified against three 0.185 source: with the
 * rotations above, both the front texture (face-up) and the back texture
 * (face-down) read right-side-up and non-mirrored to a south-seat viewer.
 *
 * prefers-reduced-motion: every animation snaps to its final state instantly.
 */

import * as THREE from 'three';
import { bezier } from '../anim/easing-helpers.js';

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

export const CARD_WIDTH = 0.7;
export const CARD_HEIGHT = 1.0;
export const CARD_THICKNESS = 0.012;

// Edge colors (spec): white edge #E0E0E0, black edge #1A1A1A. Face colors are
// driven by the canvas fill, so the edge material is what gives the bevel
// contrast. We use the literal spec values; black edges end up slightly
// lighter than the pure-black face which reads as a beveled highlight.
const EDGE_COLOR_WHITE = 0xe0e0e0;
const EDGE_COLOR_BLACK = 0x1a1a1a;

// Canvas face backgrounds.
const FACE_BG_WHITE = '#ffffff';
const FACE_BG_BLACK = '#1a1a1a';
const TEXT_COLOR_WHITE = '#000000';
const TEXT_COLOR_BLACK = '#ffffff';

// Text rendering constants.
const TEX_W = 512;
const TEX_H = 720;
const TEXT_FONT = '600 36px Helvetica, Arial, sans-serif';
const TEXT_LINE_HEIGHT = 44;
const TEXT_PAD = 40;
const PICK_FONT = '500 24px Helvetica, Arial, sans-serif';
const LOGO_FONT = '600 22px Helvetica, Arial, sans-serif';

// Hand fan layout (south seat at z = +1.5 looking toward -Z).
const FAN_CENTER_Y = 0.5;
const FAN_CENTER_Z = 1.0;
const FAN_RADIUS_X = 0.9;
const FAN_FORWARD_CURVE = 0.3;
const FAN_SPREAD_DEG = 60; // total arc, -30° to +30°
const FAN_TILT_BACK_RAD = -10 * Math.PI / 180;
const HOVER_LIFT = 0.08;
const HOVER_SCALE = 1.05;
const SELECT_LIFT = 0.12;
const SELECT_SCALE = 1.06;
const SELECT_EMISSIVE = 0x222222;
const NEIGHBOR_SPREAD_NEAR = 0.03;
const NEIGHBOR_SPREAD_FAR = 0.015;

// Animation durations (ms) — match easing.js table where possible.
const DURATION_FLY = 720;
const DURATION_FLIP = 760;
const DURATION_DROP = 760;
const FLY_ARC_LIFT = 0.5;
const FLY_MID_ROT = Math.PI / 6; // ±30° on Y mid-flight

// Reduced-motion check (read once at module load; cheap and stable enough).
const REDUCED_MOTION =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// SHARED GEOMETRY
// ---------------------------------------------------------------------------

let _sharedGeometry = null;

/**
 * Returns the singleton BoxGeometry used by every card. The geometry is not
 * owned by any one card and must not be disposed by `createCard().dispose()`;
 * call `disposeCardSystem()` at scene teardown instead.
 *
 * @returns {THREE.BoxGeometry}
 */
export function getCardGeometry() {
  if (!_sharedGeometry) {
    _sharedGeometry = new THREE.BoxGeometry(CARD_WIDTH, CARD_HEIGHT, CARD_THICKNESS);
  }
  return _sharedGeometry;
}

/**
 * Disposes the shared card geometry. Call once when the entire 3D scene is
 * being torn down (not per-card).
 */
export function disposeCardSystem() {
  if (_sharedGeometry) {
    _sharedGeometry.dispose();
    _sharedGeometry = null;
  }
}

// ---------------------------------------------------------------------------
// TEXT RENDERING
// ---------------------------------------------------------------------------

/**
 * Word-wrap a string into lines that fit within `maxWidth` for the given
 * canvas 2D context (which carries the current font). Splits on whitespace;
 * a single word longer than maxWidth is allowed to overflow (rare for CAH).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string[]}
 */
function wrapText(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines = [];
  let line = words[0];
  for (let i = 1; i < words.length; i++) {
    const test = `${line} ${words[i]}`;
    if (ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = words[i];
    } else {
      line = test;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * Build a CanvasTexture for one face of a card.
 *
 * @param {Object} opts
 * @param {string} [opts.text='']     Card text (front face only).
 * @param {boolean} [opts.isBlack]    Black card vs white card.
 * @param {number} [opts.pick=1]      Pick N indicator (black cards only).
 * @param {boolean} [opts.isBack]     If true, render the back-face design
 *                                    (broccoli. logo + dot pattern) instead
 *                                    of the front text.
 * @returns {THREE.CanvasTexture}
 */
export function makeCardTexture({ text = '', isBlack = false, pick = 1, isBack = false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d');

  // Background fill (the card's face color).
  ctx.fillStyle = isBlack ? FACE_BG_BLACK : FACE_BG_WHITE;
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  if (isBack) {
    // Subtle dot pattern — same hue as the face, very low contrast.
    ctx.fillStyle = isBlack ? '#222222' : '#f0f0f0';
    for (let y = 36; y < TEX_H - 24; y += 28) {
      for (let x = 36; x < TEX_W - 24; x += 28) {
        ctx.beginPath();
        ctx.arc(x, y, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // "broccoli." wordmark bottom-right.
    ctx.fillStyle = isBlack ? '#555555' : '#bbbbbb';
    ctx.font = LOGO_FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('broccoli.', TEX_W - TEXT_PAD, TEX_H - TEXT_PAD);
  } else {
    // Front face: text with word-wrap. Triple-underscore blank markers in the
    // source data are converted to a visible underline.
    const display = String(text).replace(/___/g, '_____');
    ctx.fillStyle = isBlack ? TEXT_COLOR_BLACK : TEXT_COLOR_WHITE;
    ctx.font = TEXT_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const maxWidth = TEX_W - TEXT_PAD * 2;
    const lines = wrapText(ctx, display, maxWidth);
    let y = TEXT_PAD;
    for (const line of lines) {
      ctx.fillText(line, TEXT_PAD, y);
      y += TEXT_LINE_HEIGHT;
    }
    // Pick indicator on black cards (bottom-left).
    if (isBlack && pick > 1) {
      ctx.font = PICK_FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`Pick ${pick}`, TEXT_PAD, TEX_H - TEXT_PAD);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

// ---------------------------------------------------------------------------
// CARD FACTORY
// ---------------------------------------------------------------------------

/**
 * Build the 6-material array for a card. BoxGeometry face order is:
 *   [0] +X (right edge)   [1] -X (left edge)
 *   [2] +Y (top edge)     [3] -Y (bottom edge)
 *   [4] +Z (front face)   [5] -Z (back face)
 *
 * @param {Object} opts
 * @returns {{materials: THREE.Material[], frontTex, backTex, faceMat, backMat, edgeMat}}
 */
function buildCardMaterials({ text, isBlack, pick }) {
  const frontTex = makeCardTexture({ text, isBlack, pick, isBack: false });
  const backTex = makeCardTexture({ text, isBlack, pick, isBack: true });

  const faceMat = new THREE.MeshStandardMaterial({
    map: frontTex,
    roughness: 0.6,
    metalness: 0,
  });
  const backMat = new THREE.MeshStandardMaterial({
    map: backTex,
    roughness: 0.6,
    metalness: 0,
  });
  const edgeMat = new THREE.MeshStandardMaterial({
    color: isBlack ? EDGE_COLOR_BLACK : EDGE_COLOR_WHITE,
    roughness: 0.7,
    metalness: 0,
  });

  // Reuse the same edge material instance for all four edge slots — they all
  // render the same solid color, so sharing saves three draw calls per card
  // (Three.js batches consecutive groups with the same material).
  const materials = [edgeMat, edgeMat, edgeMat, edgeMat, faceMat, backMat];
  return { materials, frontTex, backTex, faceMat, backMat, edgeMat };
}

/**
 * Create a 3D card. The returned object owns its mesh and materials; the
 * geometry is shared (see `getCardGeometry`).
 *
 * @param {Object} [opts]
 * @param {string} [opts.text='']
 * @param {boolean} [opts.isBlack=false]
 * @param {number} [opts.pick=1]
 * @returns {Object} card handle
 */
export function createCard({ text = '', isBlack = false, pick = 1 } = {}) {
  const geometry = getCardGeometry();
  const { materials, frontTex, backTex, faceMat, backMat, edgeMat } =
    buildCardMaterials({ text, isBlack, pick });
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // Internal state.
  let state = 'hand';
  let anim = null; // { duration, elapsed, ease, apply, resolve, kind }

  // -----------------------------------------------------------------------
  // STATE
  // -----------------------------------------------------------------------

  function setState(next) {
    state = next;
  }

  function getState() {
    return state;
  }

  // -----------------------------------------------------------------------
  // HAND FAN POSITIONING
  // -----------------------------------------------------------------------

  /**
   * Place this card at slot `index` of `total` in the south-seat hand fan.
   * `hovered` and `selected` flags apply lift + scale + emissive glow.
   * Neighbor spread (when a neighboring card is hovered/selected) is applied
   * by `layoutHand`, not here, since it requires knowledge of the other cards.
   */
  function setHandTransform(index, total, hovered, selected) {
    const isHovered = !!hovered;
    const isSelected = !!selected;
    const n = Math.max(1, total | 0);
    const t = n === 1 ? 0.5 : index / (n - 1);
    const angleDeg = -FAN_SPREAD_DEG / 2 + t * FAN_SPREAD_DEG;
    const angleRad = (angleDeg * Math.PI) / 180;
    const x = Math.sin(angleRad) * FAN_RADIUS_X;
    const z = FAN_CENTER_Z + (1 - Math.cos(angleRad)) * FAN_FORWARD_CURVE;
    let y = FAN_CENTER_Y;
    let scale = 1;
    if (isHovered) { y += HOVER_LIFT; scale = HOVER_SCALE; }
    if (isSelected) { y += SELECT_LIFT; scale = SELECT_SCALE; }
    mesh.position.set(x, y, z);
    mesh.rotation.set(FAN_TILT_BACK_RAD, -angleRad, 0);
    mesh.scale.setScalar(scale);
    // Selected glow: subtle white emissive on both face materials.
    const em = isSelected ? SELECT_EMISSIVE : 0x000000;
    faceMat.emissive.setHex(em);
    backMat.emissive.setHex(em);
  }

  // -----------------------------------------------------------------------
  // ANIMATION CORE
  // -----------------------------------------------------------------------

  /**
   * Start a generic animation. `apply(t)` is called each frame with the eased
   * progress t ∈ [0,1]; it should set mesh.position/rotation/scale based on t.
   * Returns a Promise that resolves when the animation completes (or
   * immediately if prefers-reduced-motion is active).
   */
  function startAnim(kind, durationMs, easeFn, apply) {
    return new Promise((resolve) => {
      if (REDUCED_MOTION) {
        apply(1);
        anim = null;
        resolve();
        return;
      }
      anim = {
        kind,
        duration: Math.max(1, durationMs) / 1000,
        elapsed: 0,
        ease: easeFn,
        apply,
        resolve,
      };
    });
  }

  // -----------------------------------------------------------------------
  // FLY (hand → table)
  // -----------------------------------------------------------------------

  /**
   * Animate the card to a target world position + rotation along a bezier arc.
   * Adds a parabolic Y peak (max(start.y, end.y) + 0.5) and a random ±30°
   * mid-flight Y rotation that peaks at t=0.5. Default 720ms, `whip` curve.
   *
   * @param {{x:number,y:number,z:number}} targetPos
   * @param {{x:number,y:number,z:number}} targetRot  radians
   * @param {number} [durationMs=720]
   * @returns {Promise<void>}
   */
  function flyTo(targetPos, targetRot, durationMs = DURATION_FLY) {
    state = 'flying';
    const startPos = mesh.position.clone();
    const startRot = { x: mesh.rotation.x, y: mesh.rotation.y, z: mesh.rotation.z };
    const endPos = new THREE.Vector3(targetPos.x, targetPos.y, targetPos.z);
    const endRot = { x: targetRot.x, y: targetRot.y, z: targetRot.z };
    // Parabolic arc peak: max(start.y, end.y) + 0.5. Implemented as a sin
    // pulse on top of the linear Y interpolation so the endpoints match.
    const peakY = Math.max(startPos.y, endPos.y) + FLY_ARC_LIFT;
    const lift = peakY - (startPos.y + endPos.y) / 2;
    const midRotY = (Math.random() * 2 - 1) * FLY_MID_ROT; // ±30°
    const ease = bezier.whip;
    return startAnim('fly', durationMs, ease, (t) => {
      const x = startPos.x + (endPos.x - startPos.x) * t;
      const z = startPos.z + (endPos.z - startPos.z) * t;
      const arcY = startPos.y + (endPos.y - startPos.y) * t + lift * Math.sin(Math.PI * t);
      mesh.position.set(x, arcY, z);
      // Mid-flight rotation blends a transient Y twist that peaks at t=0.5
      // (4 * (1-t) * t is the standard tent weight).
      const midWeight = 4 * (1 - t) * t;
      const rotY = startRot.y + (endRot.y - startRot.y) * t + midRotY * midWeight;
      const rotX = startRot.x + (endRot.x - startRot.x) * t;
      const rotZ = startRot.z + (endRot.z - startRot.z) * t;
      mesh.rotation.set(rotX, rotY, rotZ);
    });
  }

  // -----------------------------------------------------------------------
  // FLIP (table-down ↔ table-up)
  // -----------------------------------------------------------------------

  /**
   * Flip the card face-up by rotating π on local Y (subtract π from current
   * rotation.y). 760ms, `reveal` easing. Resolves when complete.
   * @param {number} [durationMs=760]
   * @returns {Promise<void>}
   */
  function flipFaceUp(durationMs = DURATION_FLIP) {
    const startY = mesh.rotation.y;
    const endY = startY - Math.PI;
    const ease = bezier.reveal;
    return startAnim('flip-up', durationMs, ease, (t) => {
      mesh.rotation.y = startY + (endY - startY) * t;
    });
  }

  /**
   * Flip the card face-down by rotating +π on local Y. 760ms, `reveal` easing.
   * @param {number} [durationMs=760]
   * @returns {Promise<void>}
   */
  function flipFaceDown(durationMs = DURATION_FLIP) {
    const startY = mesh.rotation.y;
    const endY = startY + Math.PI;
    const ease = bezier.reveal;
    return startAnim('flip-down', durationMs, ease, (t) => {
      mesh.rotation.y = startY + (endY - startY) * t;
    });
  }

  // -----------------------------------------------------------------------
  // BLACK CARD DROP-IN
  // -----------------------------------------------------------------------

  /**
   * Drop the card in from above to its standing position on the table.
   * Start: (0, 4, -0.5) rot.z=-0.2 scale 0.7.
   * End:   (0, 0.5, -0.5) rot.z=0    scale 1.0  rot.x=-10° (tilted back).
   * 760ms, `drop` easing (gravity feel). Includes a tiny squash on land.
   * @param {number} [durationMs=760]
   * @returns {Promise<void>}
   */
  function dropInAsBlackCard(durationMs = DURATION_DROP) {
    state = 'black-stand';
    const startPos = new THREE.Vector3(0, 4, -0.5);
    const endPos = new THREE.Vector3(0, 0.5, -0.5);
    const startRot = { x: 0, y: 0, z: -0.2 };
    const endRot = { x: -0.17, y: 0, z: 0 }; // ~-10° tilt back
    const startScale = 0.7;
    const endScale = 1.0;
    mesh.position.copy(startPos);
    mesh.rotation.set(startRot.x, startRot.y, startRot.z);
    mesh.scale.setScalar(startScale);
    const ease = bezier.drop;
    return startAnim('drop', durationMs, ease, (t) => {
      // Small squash in the last 15% of the drop — sin pulse, max -5%.
      const squash = t > 0.85
        ? 1 - 0.05 * Math.sin(((t - 0.85) / 0.15) * Math.PI)
        : 1;
      mesh.position.lerpVectors(startPos, endPos, t);
      mesh.rotation.set(
        startRot.x + (endRot.x - startRot.x) * t,
        startRot.y + (endRot.y - startRot.y) * t,
        startRot.z + (endRot.z - startRot.z) * t,
      );
      const s = (startScale + (endScale - startScale) * t) * squash;
      mesh.scale.setScalar(s);
    });
  }

  // -----------------------------------------------------------------------
  // UPDATE LOOP
  // -----------------------------------------------------------------------

  /**
   * Advance any in-progress animation by `deltaTime` seconds. Called by the
   * scene's per-frame update loop. No-op when the card is static.
   * @param {number} deltaTime seconds
   */
  function update(deltaTime) {
    if (!anim) return;
    anim.elapsed += deltaTime;
    let t = anim.elapsed / anim.duration;
    if (t >= 1) {
      anim.apply(1);
      const resolve = anim.resolve;
      anim = null;
      resolve();
      return;
    }
    const eased = anim.ease(t);
    anim.apply(eased);
  }

  // -----------------------------------------------------------------------
  // DISPOSE
  // -----------------------------------------------------------------------

  /**
   * Release this card's GPU resources (textures + materials). Does NOT
   * dispose the shared geometry; call `disposeCardSystem()` for that.
   */
  function dispose() {
    frontTex.dispose();
    backTex.dispose();
    faceMat.dispose();
    backMat.dispose();
    edgeMat.dispose();
    anim = null;
  }

  return {
    mesh,
    text,
    isBlack,
    pick,
    setState,
    getState,
    setHandTransform,
    flyTo,
    flipFaceUp,
    flipFaceDown,
    dropInAsBlackCard,
    update,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// HAND FAN LAYOUT
// ---------------------------------------------------------------------------

/**
 * Lay out an array of cards in the south-seat hand fan. Cards at indices
 * neighboring `hoveredIndex` or `selectedIndex` spread outward slightly to
 * make room for the lifted card. Pass -1 for "no hover" / "no selection".
 *
 * @param {ReturnType<createCard>[]} cards
 * @param {number} [hoveredIndex=-1]
 * @param {number} [selectedIndex=-1]
 */
export function layoutHand(cards, hoveredIndex = -1, selectedIndex = -1) {
  const total = cards.length;
  for (let i = 0; i < total; i++) {
    const card = cards[i];
    card.setHandTransform(i, total, i === hoveredIndex, i === selectedIndex);

    // Neighbor spread: push immediate neighbors of a hovered/selected card
    // outward in x. Falls off with distance so the fan stays smooth.
    let neighborOffset = 0;
    if (hoveredIndex >= 0 && i !== hoveredIndex) {
      const d = i - hoveredIndex;
      const mag = Math.abs(d) === 1 ? NEIGHBOR_SPREAD_NEAR : NEIGHBOR_SPREAD_FAR;
      neighborOffset += Math.sign(d) * mag;
    }
    if (selectedIndex >= 0 && i !== selectedIndex) {
      const d = i - selectedIndex;
      const mag = Math.abs(d) === 1 ? NEIGHBOR_SPREAD_NEAR : NEIGHBOR_SPREAD_FAR;
      neighborOffset += Math.sign(d) * mag;
    }
    if (neighborOffset !== 0) {
      card.mesh.position.x += neighborOffset;
    }
  }
}

// ---------------------------------------------------------------------------
// RAYCAST HOVER
// ---------------------------------------------------------------------------

const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

/**
 * Pick the topmost card under the cursor. `event` should be a PointerEvent or
 * MouseEvent with `clientX`/`clientY` and a `target` that is the canvas (or
 * has a `getBoundingClientRect`). Returns the card handle or null.
 *
 * @param {PointerEvent|MouseEvent} event
 * @param {THREE.Camera} camera
 * @param {ReturnType<createCard>[]} cards
 * @returns {ReturnType<createCard>|null}
 */
export function pickCard(event, camera, cards) {
  if (!cards || cards.length === 0) return null;
  const target = event.target;
  let nx, ny;
  if (target && typeof target.getBoundingClientRect === 'function') {
    const rect = target.getBoundingClientRect();
    nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    ny = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  } else {
    nx = (event.clientX / window.innerWidth) * 2 - 1;
    ny = -(event.clientY / window.innerHeight) * 2 + 1;
  }
  _ndc.set(nx, ny);
  _raycaster.setFromCamera(_ndc, camera);
  const meshes = [];
  for (const c of cards) {
    if (c && c.mesh) meshes.push(c.mesh);
  }
  const hits = _raycaster.intersectObjects(meshes, false);
  if (hits.length === 0) return null;
  const hitMesh = hits[0].object;
  for (const c of cards) {
    if (c.mesh === hitMesh) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// DEFAULT EXPORT
// ---------------------------------------------------------------------------

export default {
  CARD_WIDTH,
  CARD_HEIGHT,
  CARD_THICKNESS,
  getCardGeometry,
  disposeCardSystem,
  makeCardTexture,
  createCard,
  layoutHand,
  pickCard,
};
