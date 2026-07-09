/**
 * cards.js — 3D card system. Rebuilt (p2) per docs/RESEARCH_3D_REBUILD.md §6.
 *
 * Geometry: rounded-rectangle ExtrudeGeometry (shared singleton) with mergeVertices
 * + toCreasedNormals for sharp edges. 3-material array [face, side, back].
 * Size 0.35 × 0.49 × 0.008 (proper 5:7; was 0.7 × 1.0). CanvasTexture 512 × 720
 * with anisotropy 16 + SRGB. Bayer 4×4 dithered discard for fade in/out (opaque
 * pass — no z-sort pop on stacked cards). Cards on table sit at y=0.06.
 *
 * Card-local frame: shape in XY, extruded +Z; front cap (text) at +Z, back cap
 * (broccoli. logo) at -Z with U-flipped UVs so the wordmark reads correctly.
 *
 * Rotations (Euler 'XYZ'): hand=(rx=-10°,ry=-fan,rz=0), table-up=(-π/2,0,0),
 * table-down=(-π/2,π,0), black-stand=(-10°,0,0).
 *
 * prefers-reduced-motion: every animation snaps to its final state instantly.
 */

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { bezier } from '../anim/easing-helpers.js';

// --- CONSTANTS -------------------------------------------------------------

export const CARD_WIDTH = 0.35;
export const CARD_HEIGHT = 0.49;
export const CARD_THICKNESS = 0.008;
const CARD_CORNER_RADIUS = 0.03;
const CARD_BEVEL_THICKNESS = 0.001;
const CARD_BEVEL_SIZE = 0.001;
const CARD_BEVEL_SEGMENTS = 2;
const CREASE_ANGLE_DEG = 40;

/** Cards resting on the table sit at this Y (was 0.03 — raised to fix z-fight). */
export const TABLE_CARD_Y = 0.06;

const EDGE_COLOR_WHITE = 0xe0e0e0;
const EDGE_COLOR_BLACK = 0x1a1a1a;
const FACE_BG_WHITE = '#FAFAFA';     // slightly off-pure to avoid CGI-flat look
const FACE_BG_BLACK = '#0A0A0A';
const TEXT_COLOR_WHITE = '#0A0A0A';
const TEXT_COLOR_BLACK = '#FAFAFA';

const TEX_W = 512, TEX_H = 720;
const TEXT_FONT = '600 36px Helvetica, Arial, sans-serif';
const TEXT_LINE_HEIGHT = 44, TEXT_PAD = 40;
const PICK_FONT = '500 24px Helvetica, Arial, sans-serif';
const LOGO_FONT = '600 22px Helvetica, Arial, sans-serif';

let MAX_ANISOTROPY = 16;  // override via setMaxAnisotropy(renderer caps)

// Hand fan layout. Positions are in WORLD space (south-seat camera at
// (0,1.6,1.4) looking at (0,0.8,0)). The viewmodel-camera approach (research
// §7) is layered on top in Game3D.svelte.
const FAN_CENTER_Y = 0.5;
const FAN_CENTER_Z = 0.8;
const FAN_RADIUS_X = 0.4;        // was 0.9 — cards are half-size now
const FAN_FORWARD_CURVE = 0.15;  // was 0.3
const FAN_SPREAD_DEG = 60;       // -30° to +30°
const FAN_TILT_BACK_RAD = -10 * Math.PI / 180;
const HOVER_LIFT = 0.04, HOVER_SCALE = 1.04;     // was 0.08 / 1.05
const SELECT_LIFT = 0.06, SELECT_SCALE = 1.05;   // was 0.12 / 1.06
const SELECT_EMISSIVE = 0x222222;
const NEIGHBOR_SPREAD_NEAR = 0.015, NEIGHBOR_SPREAD_FAR = 0.0075;

const DURATION_FLY = 720, DURATION_FLIP = 760, DURATION_DROP = 760;
const FLY_ARC_LIFT = 0.3;        // was 0.5
const FLY_MID_ROT = Math.PI / 6; // ±30° Y mid-flight

const REDUCED_MOTION =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// --- SHARED GEOMETRY (singleton) ------------------------------------------

let _sharedGeometry = null;
let _blobShadowTexture = null;

/** Override the anisotropic filtering level (call from Game3D with renderer caps). */
export function setMaxAnisotropy(n) { MAX_ANISOTROPY = Math.max(1, n | 0); }

/** Rounded-rectangle THREE.Shape centred at the origin. */
function makeRoundedRectShape(w, h, r) {
  const x0 = -w / 2, y0 = -h / 2, x1 = w / 2, y1 = h / 2;
  const s = new THREE.Shape();
  s.moveTo(x0 + r, y0);
  s.lineTo(x1 - r, y0); s.quadraticCurveTo(x1, y0, x1, y0 + r);
  s.lineTo(x1, y1 - r); s.quadraticCurveTo(x1, y1, x1 - r, y1);
  s.lineTo(x0 + r, y1); s.quadraticCurveTo(x0, y1, x0, y1 - r);
  s.lineTo(x0, y0 + r); s.quadraticCurveTo(x0, y0, x0 + r, y0);
  return s;
}

/**
 * Post-process an ExtrudeGeometry into a 3-group card. Returns the processed
 * geometry (note: `mergeVertices` and `toCreasedNormals` return NEW geometries,
 * not in-place mutations, so we must thread the result through).
 *
 * Final groups:
 *   group 0 (mat 0): front cap (+Z) — face texture
 *   group 1 (mat 1): side walls + bevel rim — solid edge colour
 *   group 2 (mat 2): back cap (-Z) — back texture (U flipped)
 *
 * Steps: center → mergeVertices → toCreasedNormals(40°) → bucket triangles by
 * face-normal Z → normalise cap UVs to [0,1] (back: flip U) → rebuild index
 * buffer in [front, side, back] order with 3 groups.
 *
 * After toCreasedNormals the geometry is NON-indexed (each triangle has 3
 * unique vertices with crease-split normals). We bucket by triangle index in
 * the non-indexed layout, then `setIndex` reorganises draw order without
 * welding vertices (preserving the creased normals).
 *
 * @param {THREE.ExtrudeGeometry} inputGeo
 * @returns {THREE.BufferGeometry}
 */
function postProcessCardGeometry(inputGeo) {
  let geo = inputGeo;
  geo.center();
  geo = BufferGeometryUtils.mergeVertices(geo, 0.0001);
  geo = BufferGeometryUtils.toCreasedNormals(geo, THREE.MathUtils.degToRad(CREASE_ANGLE_DEG));

  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const triCount = pos.count / 3;

  // XY bounding box for UV normalisation.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const sizeX = Math.max(1e-6, maxX - minX);
  const sizeY = Math.max(1e-6, maxY - minY);

  // Bucket triangles by face-normal Z sign. Non-indexed layout: vertex i*3..i*3+2.
  const frontIdx = [], sideIdx = [], backIdx = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < triCount; i++) {
    const ia = i * 3, ib = i * 3 + 1, ic = i * 3 + 2;
    a.fromBufferAttribute(pos, ia); b.fromBufferAttribute(pos, ib); c.fromBufferAttribute(pos, ic);
    e1.subVectors(b, a); e2.subVectors(c, a);
    n.crossVectors(e1, e2).normalize();
    if (n.z > 0.5) frontIdx.push(ia, ib, ic);
    else if (n.z < -0.5) backIdx.push(ia, ib, ic);
    else sideIdx.push(ia, ib, ic);
  }

  // Normalise cap UVs to [0,1] based on XY position. Front: identity mapping.
  // Back: flip U so the texture reads right-side-up when viewed from -Z
  // (the back-cap's outward normal — a card back viewed from behind would
  // otherwise appear mirrored).
  for (const vi of frontIdx) {
    uv.setXY(vi, (pos.getX(vi) - minX) / sizeX, (pos.getY(vi) - minY) / sizeY);
  }
  for (const vi of backIdx) {
    uv.setXY(vi, 1 - (pos.getX(vi) - minX) / sizeX, (pos.getY(vi) - minY) / sizeY);
  }
  uv.needsUpdate = true;

  // Rebuild index buffer in [front, side, back] order. setIndex on a
  // non-indexed geometry keeps the existing attributes and just adds an
  // index referencing them — no vertex welding, creased normals preserved.
  const newIdx = new Array(frontIdx.length + sideIdx.length + backIdx.length);
  let off = 0;
  for (const v of frontIdx) newIdx[off++] = v;
  for (const v of sideIdx) newIdx[off++] = v;
  for (const v of backIdx) newIdx[off++] = v;
  geo.setIndex(newIdx);

  geo.clearGroups();
  geo.addGroup(0, frontIdx.length, 0);
  geo.addGroup(frontIdx.length, sideIdx.length, 1);
  geo.addGroup(frontIdx.length + sideIdx.length, backIdx.length, 2);

  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** Singleton card geometry. Not owned by any card — call disposeCardSystem() at scene teardown. */
export function getCardGeometry() {
  if (!_sharedGeometry) {
    const shape = makeRoundedRectShape(CARD_WIDTH, CARD_HEIGHT, CARD_CORNER_RADIUS);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: CARD_THICKNESS,
      bevelEnabled: true,
      bevelThickness: CARD_BEVEL_THICKNESS,
      bevelSize: CARD_BEVEL_SIZE,
      bevelSegments: CARD_BEVEL_SEGMENTS,
    });
    _sharedGeometry = postProcessCardGeometry(geo);
  }
  return _sharedGeometry;
}

/** Dispose the shared card geometry + cached blob shadow texture. */
export function disposeCardSystem() {
  if (_sharedGeometry) { _sharedGeometry.dispose(); _sharedGeometry = null; }
  if (_blobShadowTexture) { _blobShadowTexture.dispose(); _blobShadowTexture = null; }
}

// --- TEXT RENDERING --------------------------------------------------------

/** Word-wrap a string into lines fitting `maxWidth` for the given 2D context. */
function wrapText(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines = [];
  let line = words[0];
  for (let i = 1; i < words.length; i++) {
    const test = `${line} ${words[i]}`;
    if (ctx.measureText(test).width > maxWidth) { lines.push(line); line = words[i]; }
    else { line = test; }
  }
  lines.push(line);
  return lines;
}

/**
 * Build a CanvasTexture for one face of a card (front text or back design).
 * Sets anisotropy=MAX_ANISOTROPY, SRGB color space, mip-mapped linear filtering.
 */
export function makeCardTexture({ text = '', isBlack = false, pick = 1, isBack = false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W; canvas.height = TEX_H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = isBlack ? FACE_BG_BLACK : FACE_BG_WHITE;
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  if (isBack) {
    // Subtle dot pattern + broccoli. wordmark bottom-right.
    ctx.fillStyle = isBlack ? '#1f1f1f' : '#f0f0f0';
    for (let y = 36; y < TEX_H - 24; y += 28) {
      for (let x = 36; x < TEX_W - 24; x += 28) {
        ctx.beginPath(); ctx.arc(x, y, 1.4, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.fillStyle = isBlack ? '#555555' : '#bbbbbb';
    ctx.font = LOGO_FONT;
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText('broccoli.', TEX_W - TEXT_PAD, TEX_H - TEXT_PAD);
  } else {
    // Front face: word-wrapped text. Triple-underscore blanks → visible underline.
    const display = String(text).replace(/___/g, '_____');
    ctx.fillStyle = isBlack ? TEXT_COLOR_BLACK : TEXT_COLOR_WHITE;
    ctx.font = TEXT_FONT;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const maxWidth = TEX_W - TEXT_PAD * 2;
    const lines = wrapText(ctx, display, maxWidth);
    let y = TEXT_PAD;
    for (const line of lines) { ctx.fillText(line, TEXT_PAD, y); y += TEXT_LINE_HEIGHT; }
    if (isBlack && pick > 1) {
      ctx.font = PICK_FONT;
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(`Pick ${pick}`, TEXT_PAD, TEX_H - TEXT_PAD);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = MAX_ANISOTROPY;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// --- DITHERED FADE MATERIAL ------------------------------------------------
// Patches MeshStandardMaterial's fragment shader to apply a Bayer 4×4 thresholded
// discard based on a runtime `uDitherOpacity` uniform. The material stays in the
// opaque pass (transparent=false, depthWrite=true) so stacked cards never z-sort
// pop during fade in/out — the bg3d DitheredMaterials.js pattern (research §r4).
// --------------------------------------------------------------------------

const DITHER_SNIPPET = `
uniform float uDitherOpacity;
float bayer4x4Threshold(vec2 frag) {
  vec2 q = mod(frag, 4.0);
  int xi = int(q.x); int yi = int(q.y);
  float v = 0.0;
  if (yi == 0) {
    if (xi == 0) v = 0.0; else if (xi == 1) v = 8.0;
    else if (xi == 2) v = 2.0; else v = 10.0;
  } else if (yi == 1) {
    if (xi == 0) v = 12.0; else if (xi == 1) v = 4.0;
    else if (xi == 2) v = 14.0; else v = 6.0;
  } else if (yi == 2) {
    if (xi == 0) v = 3.0; else if (xi == 1) v = 11.0;
    else if (xi == 2) v = 1.0; else v = 9.0;
  } else {
    if (xi == 0) v = 15.0; else if (xi == 1) v = 7.0;
    else if (xi == 2) v = 13.0; else v = 5.0;
  }
  return v / 16.0;
}
`;

/**
 * Patch a MeshStandardMaterial so it discards pixels based on a Bayer 4×4
 * threshold tied to `material.userData.ditherOpacity` (0..1). At opacity = 1
 * no pixels are discarded; at opacity = 0 all are discarded; intermediate
 * values produce a stippled fade with no alpha-sort dependency.
 */
function makeDitheredMaterial(baseMaterial) {
  baseMaterial.userData.ditherOpacity = 1.0;
  baseMaterial.transparent = false;
  baseMaterial.depthWrite = true;

  baseMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uDitherOpacity = {
      get value() { return baseMaterial.userData.ditherOpacity; },
    };
    shader.fragmentShader = DITHER_SNIPPET + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `{
        float threshold = bayer4x4Threshold(gl_FragCoord.xy);
        if (uDitherOpacity < threshold) discard;
      }
      #include <opaque_fragment>`,
    );
  };
  baseMaterial.needsUpdate = true;
  return baseMaterial;
}

// --- BLOB SHADOW -----------------------------------------------------------

/** Lazy-build the shared radial-gradient blob shadow texture. */
function getBlobShadowTexture() {
  if (_blobShadowTexture) return _blobShadowTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
  grad.addColorStop(0.55, 'rgba(0, 0, 0, 0.22)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  _blobShadowTexture = tex;
  return tex;
}

// --- CARD FACTORY ----------------------------------------------------------

/**
 * Build the 3-material array [face, side, back] matching geometry groups.
 * All three are patched with dithered fade so the whole card fades uniformly.
 */
function buildCardMaterials({ text, isBlack, pick }) {
  const frontTex = makeCardTexture({ text, isBlack, pick, isBack: false });
  const backTex = makeCardTexture({ text, isBlack, pick, isBack: true });

  const faceMat = new THREE.MeshStandardMaterial({ map: frontTex, roughness: 0.6, metalness: 0 });
  const sideMat = new THREE.MeshStandardMaterial({
    color: isBlack ? EDGE_COLOR_BLACK : EDGE_COLOR_WHITE,
    roughness: 0.7, metalness: 0,
  });
  const backMat = new THREE.MeshStandardMaterial({ map: backTex, roughness: 0.6, metalness: 0 });

  makeDitheredMaterial(faceMat);
  makeDitheredMaterial(sideMat);
  makeDitheredMaterial(backMat);

  return { materials: [faceMat, sideMat, backMat], frontTex, backTex, faceMat, sideMat, backMat };
}

/**
 * Create a 3D card. The returned object owns its mesh + materials; the geometry
 * is shared (see getCardGeometry). API preserved for Game3D.svelte: mesh, text,
 * isBlack, pick, setState, setHandTransform, flyTo, flipFaceUp/Down,
 * dropInAsBlackCard, update, dispose. New: setOpacity, addBlobShadow.
 */
export function createCard({ text = '', isBlack = false, pick = 1 } = {}) {
  const geometry = getCardGeometry();
  const { materials, frontTex, backTex, faceMat, sideMat, backMat } =
    buildCardMaterials({ text, isBlack, pick });
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  let state = 'hand';
  let anim = null;
  let blobShadow = null;

  // --- STATE + OPACITY ----------------------------------------------------

  function setState(next) { state = next; }
  function getState() { return state; }

  /** Set dithered opacity (0..1) across all 3 materials. */
  function setOpacity(opacity) {
    const o = Math.max(0, Math.min(1, opacity));
    faceMat.userData.ditherOpacity = o;
    sideMat.userData.ditherOpacity = o;
    backMat.userData.ditherOpacity = o;
    mesh.visible = o > 0.001;
  }

  // --- HAND FAN POSITIONING -----------------------------------------------

  /** Place this card at slot `index` of `total` in the south-seat hand fan. */
  function setHandTransform(index, total, hovered, selected) {
    const isHovered = !!hovered;
    const isSelected = !!selected;
    const n = Math.max(1, total | 0);
    const t = n === 1 ? 0.5 : index / (n - 1);
    const angleDeg = -FAN_SPREAD_DEG / 2 + t * FAN_SPREAD_DEG;
    const angleRad = (angleDeg * Math.PI) / 180;
    const x = Math.sin(angleRad) * FAN_RADIUS_X;
    const z = FAN_CENTER_Z + (1 - Math.cos(angleRad)) * FAN_FORWARD_CURVE;
    let y = FAN_CENTER_Y, scale = 1;
    if (isHovered) { y += HOVER_LIFT; scale = HOVER_SCALE; }
    if (isSelected) { y += SELECT_LIFT; scale = SELECT_SCALE; }
    mesh.position.set(x, y, z);
    mesh.rotation.set(FAN_TILT_BACK_RAD, -angleRad, 0);
    mesh.scale.setScalar(scale);
    const em = isSelected ? SELECT_EMISSIVE : 0x000000;
    faceMat.emissive.setHex(em);
    backMat.emissive.setHex(em);
  }

  // --- ANIMATION CORE -----------------------------------------------------

  /** Start a generic eased animation; returns a Promise that resolves on end. */
  function startAnim(kind, durationMs, easeFn, apply) {
    return new Promise((resolve) => {
      if (REDUCED_MOTION) { apply(1); anim = null; resolve(); return; }
      anim = {
        kind,
        duration: Math.max(1, durationMs) / 1000,
        elapsed: 0, ease: easeFn, apply, resolve,
      };
    });
  }

  // --- FLY (hand → table) -------------------------------------------------

  /**
   * Animate to target world position + rotation along a bezier arc.
   * Parabolic Y peak = max(start.y, end.y) + FLY_ARC_LIFT; random ±30° Y twist
   * mid-flight. 720ms, `whip` easing.
   */
  function flyTo(targetPos, targetRot, durationMs = DURATION_FLY) {
    state = 'flying';
    const startPos = mesh.position.clone();
    const startRot = { x: mesh.rotation.x, y: mesh.rotation.y, z: mesh.rotation.z };
    const endPos = new THREE.Vector3(targetPos.x, targetPos.y, targetPos.z);
    const endRot = { x: targetRot.x, y: targetRot.y, z: targetRot.z };
    const peakY = Math.max(startPos.y, endPos.y) + FLY_ARC_LIFT;
    const lift = peakY - (startPos.y + endPos.y) / 2;
    const midRotY = (Math.random() * 2 - 1) * FLY_MID_ROT;
    return startAnim('fly', durationMs, bezier.whip, (t) => {
      const x = startPos.x + (endPos.x - startPos.x) * t;
      const z = startPos.z + (endPos.z - startPos.z) * t;
      const arcY = startPos.y + (endPos.y - startPos.y) * t + lift * Math.sin(Math.PI * t);
      mesh.position.set(x, arcY, z);
      const midWeight = 4 * (1 - t) * t;
      const rotY = startRot.y + (endRot.y - startRot.y) * t + midRotY * midWeight;
      mesh.rotation.set(
        startRot.x + (endRot.x - startRot.x) * t,
        rotY,
        startRot.z + (endRot.z - startRot.z) * t,
      );
    });
  }

  // --- FLIP (table-down ↔ table-up) --------------------------------------

  /** Flip face-up by rotating -π on local Y. 760ms, `reveal` ease. */
  function flipFaceUp(durationMs = DURATION_FLIP) {
    const startY = mesh.rotation.y, endY = startY - Math.PI;
    return startAnim('flip-up', durationMs, bezier.reveal, (t) => {
      mesh.rotation.y = startY + (endY - startY) * t;
    });
  }

  /** Flip face-down by rotating +π on local Y. 760ms, `reveal` ease. */
  function flipFaceDown(durationMs = DURATION_FLIP) {
    const startY = mesh.rotation.y, endY = startY + Math.PI;
    return startAnim('flip-down', durationMs, bezier.reveal, (t) => {
      mesh.rotation.y = startY + (endY - startY) * t;
    });
  }

  // --- BLACK CARD DROP-IN -------------------------------------------------

  /**
   * Drop from above to standing position on table.
   * Start: (0,4,-0.5) rot.z=-0.2 scale 0.7. End: (0,0.5,-0.5) rot.x=-10° scale 1.
   * 760ms, `drop` easing, tiny squash on land.
   */
  function dropInAsBlackCard(durationMs = DURATION_DROP) {
    state = 'black-stand';
    const startPos = new THREE.Vector3(0, 4, -0.5);
    const endPos = new THREE.Vector3(0, 0.5, -0.5);
    const startRot = { x: 0, y: 0, z: -0.2 };
    const endRot = { x: -0.17, y: 0, z: 0 };
    mesh.position.copy(startPos);
    mesh.rotation.set(startRot.x, startRot.y, startRot.z);
    mesh.scale.setScalar(0.7);
    return startAnim('drop', durationMs, bezier.drop, (t) => {
      const squash = t > 0.85
        ? 1 - 0.05 * Math.sin(((t - 0.85) / 0.15) * Math.PI)
        : 1;
      mesh.position.lerpVectors(startPos, endPos, t);
      mesh.rotation.set(
        startRot.x + (endRot.x - startRot.x) * t,
        startRot.y + (endRot.y - startRot.y) * t,
        startRot.z + (endRot.z - startRot.z) * t,
      );
      mesh.scale.setScalar((0.7 + 0.3 * t) * squash);
    });
  }

  // --- BLOB SHADOW --------------------------------------------------------

  /**
   * Attach a blob shadow to this card. Returns a handle whose `mesh` must be
   * added to the scene by the caller. The card's update() keeps the shadow's
   * XZ synced to the card; shadow Y stays at 0.025 (just above the table).
   * Used for cards on the table — hand cards (in viewmodel space) don't need it.
   */
  function addBlobShadow(parent) {
    if (blobShadow) return blobShadow;
    const mat = new THREE.MeshBasicMaterial({
      map: getBlobShadowTexture(),
      transparent: true, depthWrite: false, opacity: 0.6,
    });
    const geo = new THREE.PlaneGeometry(CARD_WIDTH * 1.3, CARD_HEIGHT * 1.3);
    const shadowMesh = new THREE.Mesh(geo, mat);
    shadowMesh.rotation.x = -Math.PI / 2;
    shadowMesh.position.set(mesh.position.x, 0.025, mesh.position.z);
    shadowMesh.renderOrder = -1;
    if (parent) parent.add(shadowMesh);
    blobShadow = { mesh: shadowMesh, material: mat, geometry: geo, parent };
    return blobShadow;
  }

  // --- UPDATE LOOP --------------------------------------------------------

  /** Advance animation by `deltaTime` seconds and sync blob shadow XZ. */
  function update(deltaTime) {
    if (anim) {
      anim.elapsed += deltaTime;
      const t = anim.elapsed / anim.duration;
      if (t >= 1) {
        anim.apply(1);
        const resolve = anim.resolve;
        anim = null;
        resolve();
      } else {
        anim.apply(anim.ease(t));
      }
    }
    if (blobShadow) {
      blobShadow.mesh.position.x = mesh.position.x;
      blobShadow.mesh.position.z = mesh.position.z;
      blobShadow.mesh.visible = mesh.visible;
    }
  }

  // --- DISPOSE ------------------------------------------------------------

  /** Release this card's GPU resources (does NOT dispose the shared geometry). */
  function dispose() {
    if (blobShadow) {
      if (blobShadow.parent) blobShadow.parent.remove(blobShadow.mesh);
      blobShadow.material.dispose();
      blobShadow.geometry.dispose();
      blobShadow = null;
    }
    frontTex.dispose();
    backTex.dispose();
    faceMat.dispose();
    sideMat.dispose();
    backMat.dispose();
    anim = null;
  }

  return {
    mesh, text, isBlack, pick,
    setState, getState, setOpacity, setHandTransform,
    flyTo, flipFaceUp, flipFaceDown, dropInAsBlackCard,
    addBlobShadow, update, dispose,
  };
}

// --- HAND FAN LAYOUT -------------------------------------------------------

/**
 * Lay out an array of cards in the south-seat hand fan. Cards neighbouring the
 * hovered card or any selected card spread outward slightly.
 *
 * Polymorphic third arg (backward-compat with Game3D.svelte which passes an
 * array of selected card texts):
 *   - number: single selected index
 *   - string[]: list of selected card texts (resolved to indices via card.text)
 *   - -1 / null / []: no selection
 */
export function layoutHand(cards, hoveredIndex = -1, selected = -1) {
  const total = cards.length;
  const selectedSet = new Set();
  if (Array.isArray(selected)) {
    for (let i = 0; i < total; i++) {
      if (selected.includes(cards[i].text)) selectedSet.add(i);
    }
  } else if (typeof selected === 'number' && selected >= 0) {
    selectedSet.add(selected);
  }
  const hovIdx = typeof hoveredIndex === 'number' ? hoveredIndex : -1;

  for (let i = 0; i < total; i++) {
    const card = cards[i];
    card.setHandTransform(i, total, i === hovIdx, selectedSet.has(i));

    // Neighbour spread — push immediate neighbours outward in X.
    let neighborOffset = 0;
    if (hovIdx >= 0 && i !== hovIdx) {
      const d = i - hovIdx;
      neighborOffset += Math.sign(d) * (Math.abs(d) === 1 ? NEIGHBOR_SPREAD_NEAR : NEIGHBOR_SPREAD_FAR);
    }
    for (const si of selectedSet) {
      if (i !== si) {
        const d = i - si;
        neighborOffset += Math.sign(d) * (Math.abs(d) === 1 ? NEIGHBOR_SPREAD_NEAR : NEIGHBOR_SPREAD_FAR);
      }
    }
    if (neighborOffset !== 0) card.mesh.position.x += neighborOffset;
  }
}

// --- RAYCAST HOVER ---------------------------------------------------------

const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

/**
 * Pick the topmost card under the cursor. Works with ExtrudeGeometry like with
 * BoxGeometry — raycaster handles convex meshes natively. Returns the card or null.
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
  for (const c of cards) if (c && c.mesh) meshes.push(c.mesh);
  const hits = _raycaster.intersectObjects(meshes, false);
  if (hits.length === 0) return null;
  const hitMesh = hits[0].object;
  for (const c of cards) if (c.mesh === hitMesh) return c;
  return null;
}

// --- DEFAULT EXPORT --------------------------------------------------------

export default {
  CARD_WIDTH, CARD_HEIGHT, CARD_THICKNESS, TABLE_CARD_Y,
  getCardGeometry, disposeCardSystem, setMaxAnisotropy,
  makeCardTexture, createCard, layoutHand, pickCard,
};
