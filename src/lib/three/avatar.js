/**
 * avatar.js — Procedural Three.js avatar system for the CAH 3D table.
 *
 * Each player avatar = gray Windows-XP-style sphere head with a photo
 * stretched over the front hemisphere, a smooth gradient-fade body below,
 * and a subtle nickname label sprite above. Breathing + look-at + hover-ring
 * animations keep them alive without being distracting.
 * All geometry is procedural; no external models.
 *
 * Photo-stretch trick: a SphereGeometry's +Z vertex sits at UV u=0.25. To
 * let the photo live at canvas-centre (u=0.5), we set texture.offset.x = 0.25
 * + wrapS = RepeatWrapping. Equirect polar distortion does the rest of the
 * "stretched over a ball" look (centre clear, edges smeared). Empirically
 * verified against three 0.185.
 */

import * as THREE from 'three';
import { springs } from '../anim/easing-helpers.js';

// SEAT_POSITIONS — local copy matching scene.js (avoids circular import).
// rotY rotates the group so the avatar's +Z (where the face/photo is) points
// toward the table centre.
export const SEAT_POSITIONS = [
  { id: 'south', pos: [0, 0, 1.5],  rotY: Math.PI,        label: 'you' },
  { id: 'west',  pos: [-1.5, 0, 0], rotY: Math.PI / 2,    label: 'left' },
  { id: 'north', pos: [0, 0, -1.5], rotY: 0,              label: 'across' },
  { id: 'east',  pos: [1.5, 0, 0],  rotY: -Math.PI / 2,   label: 'right' },
];

// Respect reduced-motion: disable ambient breathing + hover pulse.
function _prefersReducedMotion() {
  return typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// --- PHOTO PROCESSING ------------------------------------------------------
const PHOTO_CACHE = new Map();
const PHOTO_W = 1024;
const PHOTO_H = 512;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('avatar: image load failed: ' + src.slice(0, 64)));
    img.src = src;
  });
}

async function toImage(imageOrDataUrl) {
  if (typeof imageOrDataUrl === 'string') return loadImage(imageOrDataUrl);
  if (typeof HTMLImageElement !== 'undefined' && imageOrDataUrl instanceof HTMLImageElement) {
    if (imageOrDataUrl.complete && imageOrDataUrl.naturalWidth > 0) return imageOrDataUrl;
    return new Promise((resolve, reject) => {
      imageOrDataUrl.onload = () => resolve(imageOrDataUrl);
      imageOrDataUrl.onerror = () => reject(new Error('avatar: image load failed'));
    });
  }
  throw new Error('avatar: invalid photo (expected HTMLImageElement or string)');
}

/** Compose 1024x512 head texture: gray gradient + photo on centre-front with
 *  radial alpha fade. Cached by source so re-processing the same image is free.
 *  @param {HTMLImageElement|string} imageOrDataUrl
 *  @returns {Promise<THREE.CanvasTexture>} */
export async function processPhoto(imageOrDataUrl) {
  const cacheKey = typeof imageOrDataUrl === 'string'
    ? imageOrDataUrl
    : (imageOrDataUrl && imageOrDataUrl.src) || String(imageOrDataUrl);
  if (PHOTO_CACHE.has(cacheKey)) return PHOTO_CACHE.get(cacheKey);
  const img = await toImage(imageOrDataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = PHOTO_W;
  canvas.height = PHOTO_H;
  const ctx = canvas.getContext('2d');

  // 1) Vertical gray gradient (light top, darker bottom).
  const grad = ctx.createLinearGradient(0, 0, 0, PHOTO_H);
  grad.addColorStop(0, '#E8E8E8');
  grad.addColorStop(1, '#C8C8C8');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, PHOTO_W, PHOTO_H);

  // 2) Photo rect: middle 50% width, middle 60% height of canvas. After the
  //    offset.x=0.25 shift this maps onto the front hemisphere; the equirect
  //    distortion does the rest of the "stretching".
  const photoW = PHOTO_W * 0.5, photoH = PHOTO_H * 0.6;
  const photoX = (PHOTO_W - photoW) / 2, photoY = (PHOTO_H - photoH) / 2;
  // Cover-fit source image into photo rect (preserve aspect, crop).
  const srcAspect = img.width / img.height, dstAspect = photoW / photoH;
  let sx = 0, sy = 0, sw = img.width, sh = img.height;
  if (srcAspect > dstAspect) {
    sw = img.height * dstAspect; sx = (img.width - sw) / 2;
  } else {
    sh = img.width / dstAspect; sy = (img.height - sh) / 2;
  }
  // 3) Radial fade mask so the photo melts into the gray gradient instead
  //    of a hard rectangle. 'source-in' compositing: mask defines alpha, then
  //    the image is drawn into that alpha shape.
  ctx.save();
  const cx = photoX + photoW / 2, cy = photoY + photoH / 2;
  const mask = ctx.createRadialGradient(
    cx, cy, Math.min(photoW, photoH) * 0.18,
    cx, cy, Math.max(photoW, photoH) * 0.55,
  );
  mask.addColorStop(0,   'rgba(255,255,255,1)');
  mask.addColorStop(0.7, 'rgba(255,255,255,0.95)');
  mask.addColorStop(1,   'rgba(255,255,255,0)');
  ctx.fillStyle = mask;
  ctx.fillRect(photoX, photoY, photoW, photoH);
  ctx.globalCompositeOperation = 'source-in';
  ctx.drawImage(img, sx, sy, sw, sh, photoX, photoY, photoW, photoH);
  ctx.restore();

  // 4) CanvasTexture + equirect shift so canvas-centre maps to +Z (front).
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.offset.x = 0.25; // shift canvas U=0.5 (photo centre) onto +Z vertex (U=0.25)
  tex.anisotropy = 4;
  tex.needsUpdate = true;

  PHOTO_CACHE.set(cacheKey, tex);
  return tex;
}

/** Drop the photo cache (frees GPU memory held by shared textures). */
export function clearPhotoCache() {
  for (const tex of PHOTO_CACHE.values()) tex.dispose();
  PHOTO_CACHE.clear();
}

// --- NICKNAME LABEL SPRITE -------------------------------------------------
const LABEL_W = 512;
const LABEL_H = 128;

function makeLabelTexture(name) {
  const canvas = document.createElement('canvas');
  canvas.width = LABEL_W;
  canvas.height = LABEL_H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, LABEL_W, LABEL_H);
  ctx.fillStyle = '#888888';
  ctx.font = '48px Helvetica, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, LABEL_W / 2, LABEL_H / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function truncate(name) {
  const s = (name == null) ? '' : String(name);
  return s.length > 14 ? s.slice(0, 14) + '\u2026' : s;
}

// --- SIMPLE JS SPRING ------------------------------------------------------
// Mirrors Svelte's spring() algorithm so the easing config values from
// easing-helpers.js (stiffness / damping / precision) can be reused in
// pure-JS contexts. Used for smooth look-at rotation.
class Spring {
  constructor(initial, cfg = springs.cardHover) {
    this.value = initial;
    this.target = initial;
    this.velocity = 0;
    this.stiffness = cfg.stiffness ?? 0.15;
    this.damping = cfg.damping ?? 0.8;
    this.precision = cfg.precision ?? 0.01;
  }
  setTarget(t) { this.target = t; }
  update(dt) {
    // Svelte's spring assumes a ~60fps fixed step. We approximate by running
    // 1..8 sub-steps proportional to dt (clamped to avoid spiral-of-death).
    const steps = Math.max(1, Math.min(8, Math.round(dt * 60)));
    for (let i = 0; i < steps; i++) {
      const force = (this.target - this.value) * this.stiffness;
      this.velocity = (this.velocity + force) * this.damping;
      this.value += this.velocity;
    }
    if (Math.abs(this.target - this.value) < this.precision &&
        Math.abs(this.velocity) < this.precision) {
      this.value = this.target;
      this.velocity = 0;
    }
    return this.value;
  }
}

// Scratch vectors / matrices (avoid per-frame allocation).
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _m4 = new THREE.Matrix4();

// --- HEAD VERTEX COLORS (subtle vertical gradient on the bare-gray sphere) -
function applyHeadGradient(geometry) {
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(0xE8E8E8);
  const bot = new THREE.Color(0xC8C8C8);
  const c = new THREE.Color();
  // SphereGeometry y spans -radius..+radius; radius is 0.32 for our head.
  const r = 0.32;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = Math.max(0, Math.min(1, (y + r) / (2 * r)));
    c.copy(bot).lerp(top, t);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// --- BODY ALPHA MAP (vertical gradient: opaque top, transparent bottom) ----
// Shared across all avatars — created once, never disposed per-avatar.
let _bodyAlphaTex = null;
function getBodyAlphaTexture() {
  if (_bodyAlphaTex) return _bodyAlphaTex;
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 64;
  const ctx = c.getContext('2d');
  // Canvas y=0 is the top. With flipY=true (CanvasTexture default), UV V=1
  // samples canvas y=0. CylinderGeometry sets v=1 at the top ring, so:
  //   top of cylinder → V=1 → canvas top → white (opaque)
  //   bottom of cylinder → V=0 → canvas bottom → black (transparent)
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0,   '#FFFFFF');
  g.addColorStop(0.7, '#FFFFFF');
  g.addColorStop(1,   '#000000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 64);
  _bodyAlphaTex = new THREE.CanvasTexture(c);
  _bodyAlphaTex.colorSpace = THREE.NoColorSpace; // alpha map is data, not color
  return _bodyAlphaTex;
}

// --- AVATAR API -----------------------------------------------------------
// Internal implementations, exported both standalone and attached to the
// avatar object so callers can use either style:
//   avatar.setPhoto(img)   OR   setPhoto(avatar, img)

async function setPhoto(avatar, imageOrDataUrl) {
  if (avatar._disposed) return;
  if (!imageOrDataUrl) {
    avatar._headMat.map = null;
    avatar._headMat.vertexColors = true;
    avatar._headMat.needsUpdate = true;
    return;
  }
  const tex = await processPhoto(imageOrDataUrl);
  if (avatar._disposed) return; // check again after await
  avatar._headMat.map = tex;
  avatar._headMat.vertexColors = false; // texture already has the gradient baked in
  avatar._headMat.needsUpdate = true;
}

function setName(avatar, newName) {
  if (avatar._disposed) return;
  avatar._labelTex.dispose();
  avatar._labelTex = makeLabelTexture(truncate(newName));
  avatar._label.material.map = avatar._labelTex;
  avatar._label.material.needsUpdate = true;
}

function setLookAt(avatar, targetVec3) {
  if (avatar._disposed) return;
  if (!targetVec3) {
    avatar._yawSpring.setTarget(0);
    avatar._pitchSpring.setTarget(0);
    return;
  }
  // Compute target in the avatar group's local space (so the look-at respects
  // the seat rotation automatically).
  avatar.group.updateMatrixWorld(true);
  _m4.copy(avatar.group.matrixWorld).invert();
  _v1.copy(targetVec3).applyMatrix4(_m4); // target in group-local
  _v2.copy(avatar._head.position);        // head pos in group-local
  _v3.copy(_v1).sub(_v2);
  if (_v3.lengthSq() < 1e-8) { // target == head
    avatar._yawSpring.setTarget(0);
    avatar._pitchSpring.setTarget(0);
    return;
  }
  _v3.normalize();
  // We want head's +Z to point along _v3 → decompose into yaw (Y) + pitch (X).
  const yaw = Math.atan2(_v3.x, _v3.z);
  const horiz = Math.sqrt(_v3.x * _v3.x + _v3.z * _v3.z);
  let pitch = -Math.atan2(_v3.y, horiz);
  pitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, pitch)); // no flip
  avatar._yawSpring.setTarget(yaw);
  avatar._pitchSpring.setTarget(pitch);
}

function setHovering(avatar, isHovering) {
  if (avatar._disposed) return;
  avatar._hovering = !!isHovering;
  if (!avatar._hovering) {
    avatar._ring.visible = false;
    avatar._ringMat.opacity = 0;
    avatar._head.scale.setScalar(1);
  } else {
    avatar._ring.visible = true;
  }
}

function update(avatar, dt) {
  if (avatar._disposed) return;
  avatar._time += dt;
  const t = avatar._time;
  const reduced = _prefersReducedMotion();

  // Look-at spring (always runs; not "motion" per se, just state easing).
  const yaw = avatar._yawSpring.update(dt);
  const pitch = avatar._pitchSpring.update(dt);

  // Breathing (disabled under prefers-reduced-motion).
  let breathY = 0, breathX = 0;
  if (!reduced) {
    const omega = 2 * Math.PI * 0.25; // 0.25 Hz → 4s cycle
    breathY = Math.sin(omega * t + avatar._phase) * 0.005;               // ±5mm
    breathX = Math.sin(omega * t + avatar._phase) * (0.5 * Math.PI / 180); // ±0.5°
  }
  avatar._head.position.y = 0.85 + breathY;
  // Euler 'YXZ' = yaw first, then pitch in the yaw-rotated frame. Breathing
  // adds a tiny extra X nod on top of the look-at pitch.
  avatar._head.rotation.set(pitch + breathX, yaw, 0, 'YXZ');

  // Hover pulse + glow ring.
  if (avatar._hovering) {
    if (!reduced) {
      const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.8); // 0.8 Hz
      avatar._head.scale.setScalar(1 + 0.05 * pulse);
      const ringT = (t * 1.2) % 1; // ring expands + fades, then restarts
      avatar._ring.scale.setScalar(1 + ringT * 0.6);
      avatar._ringMat.opacity = 0.35 * (1 - ringT);
      avatar._ring.visible = true;
    } else { // static hover indicator under reduced-motion
      avatar._head.scale.setScalar(1.05);
      avatar._ring.scale.setScalar(1);
      avatar._ringMat.opacity = 0.2;
    }
  } else {
    avatar._head.scale.setScalar(1);
    avatar._ring.visible = false;
    avatar._ringMat.opacity = 0;
  }
}

function dispose(avatar) {
  if (avatar._disposed) return;
  avatar._disposed = true;
  avatar._head.geometry.dispose();
  avatar._headMat.dispose();
  // head material .map (photo texture) is owned by PHOTO_CACHE — not disposed here.
  avatar._body.geometry.dispose();
  avatar._body.material.dispose();
  // body alphaMap is the shared singleton — not disposed here.
  avatar._label.material.dispose();
  avatar._labelTex.dispose();
  avatar._ring.geometry.dispose();
  avatar._ringMat.dispose();
  if (avatar.group.parent) avatar.group.parent.remove(avatar.group);
}

// --- AVATAR FACTORY --------------------------------------------------------

/**
 * Build a player avatar at the given seat.
 * @param {Object} opts
 * @param {string} opts.id
 * @param {string} opts.name
 * @param {number} opts.seatIndex        0..3 (south/west/north/east)
 * @param {HTMLImageElement|string} [opts.photoImage]  initial photo (async-applied)
 * @returns {Object} avatar
 */
export function createAvatar({ id, name, seatIndex, photoImage } = {}) {
  const group = new THREE.Group();
  group.name = `avatar-${id ?? seatIndex ?? 'anon'}`;

  const seat = SEAT_POSITIONS[seatIndex] ?? SEAT_POSITIONS[0];
  group.position.set(seat.pos[0], seat.pos[1], seat.pos[2]);
  group.rotation.y = seat.rotY;

  // --- HEAD ---
  const headGeom = new THREE.SphereGeometry(0.32, 64, 64);
  applyHeadGradient(headGeom);
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xFFFFFF,
    roughness: 0.85,
    metalness: 0,
    vertexColors: true, // initial bare-gray gradient; disabled once a photo is set
  });
  const head = new THREE.Mesh(headGeom, headMat);
  head.position.set(0, 0.85, 0);
  head.castShadow = true;
  head.receiveShadow = true;
  group.add(head);

  // --- BODY (gradient-fade cone below the head) ---
  // CylinderGeometry(radiusTop, radiusBottom, height, ...) → downward cone
  // (wide at top, point at bottom).
  const bodyGeom = new THREE.CylinderGeometry(0.25, 0.0, 0.6, 32, 1, true);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xD8D8D8,
    roughness: 0.9,
    metalness: 0,
    transparent: true,
    alphaMap: getBodyAlphaTexture(),
    opacity: 1.0,
    depthWrite: false, // avoids sorting artifacts on transparent surface
  });
  const body = new THREE.Mesh(bodyGeom, bodyMat);
  body.position.set(0, 0.3, 0); // cone top y=0.6 tucks into head bottom y=0.53
  body.castShadow = true;
  body.receiveShadow = false;
  group.add(body);

  // --- NICKNAME LABEL SPRITE ---
  const labelTex = makeLabelTexture(truncate(name));
  const labelMat = new THREE.SpriteMaterial({
    map: labelTex,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const label = new THREE.Sprite(labelMat);
  label.scale.set(1.0, 0.25, 1.0);
  label.position.set(0, 1.4, 0); // above head (head top ≈ 1.17)
  group.add(label);

  // --- HOVER RING (TorusGeometry at the base, hidden by default) ---
  const ringGeom = new THREE.TorusGeometry(0.32, 0.025, 8, 64);
  ringGeom.rotateX(Math.PI / 2); // lay flat in the XZ plane
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xFFFFFF,
    transparent: true,
    opacity: 0.0,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.position.set(0, 0.02, 0);
  ring.visible = false;
  group.add(ring);

  // --- AVATAR STATE ---
  // Deterministic phase from id (fallback seatIndex) so avatars don't sync.
  const phaseSeed = String(id ?? seatIndex ?? '');
  let seed = 0;
  for (let i = 0; i < phaseSeed.length; i++) seed = (seed * 31 + phaseSeed.charCodeAt(i)) | 0;
  const phase = ((Math.abs(seed) * 9301 + 49297) % 233280) / 233280 * Math.PI * 2;
  const yawSpring = new Spring(0, springs.cardHover);
  const pitchSpring = new Spring(0, springs.cardHover);

  const avatar = {
    group, id, seatIndex,
    // internals (underscore-prefixed; not part of the public API):
    _head: head, _body: body, _label: label, _labelTex: labelTex,
    _ring: ring, _ringMat: ringMat, _headMat: headMat,
    _phase: phase, _yawSpring: yawSpring, _pitchSpring: pitchSpring,
    _hovering: false, _time: 0, _disposed: false,
    // Public API (delegate to standalone exports):
    setPhoto: (img) => setPhoto(avatar, img),
    setName: (n) => setName(avatar, n),
    setLookAt: (v) => setLookAt(avatar, v),
    setHovering: (b) => setHovering(avatar, b),
    update: (dt) => update(avatar, dt),
    dispose: () => dispose(avatar),
  };

  // Apply initial photo (async; avatar is usable immediately, photo pops in
  // when loaded).
  if (photoImage) {
    avatar.setPhoto(photoImage).catch((e) => {
      console.warn('[avatar] initial photo load failed:', e?.message || e);
    });
  }
  return avatar;
}

// Re-export the standalone API functions so callers can use them directly
// (mirrors the spec's `setLookAt(avatar, target)` / `setHovering(avatar, bool)`
// signatures).
export { setPhoto, setName, setLookAt, setHovering, update, dispose };

export default { createAvatar, processPhoto, SEAT_POSITIONS, clearPhotoCache };
