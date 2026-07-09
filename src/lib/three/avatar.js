/**
 * avatar.js — "Design B: The Egg" procedural avatar for the CAH 3D table.
 *
 * Replaces the old sphere+cone ("restroom icon" / ISO 7001 pictogram) avatar
 * with a single deformed sphere (egg/bean, Among Us / Fall Guys silhouette).
 * Photo lives on a visor patch on the front (planar UV, no equirect pole
 * distortion). Glossy XP-plastic body. Lower portion fades to alpha 0 with
 * a Perlin-noise-broken alphaMap. Idle anims: breathing, weight shift,
 * head tracking, micro-jitter. Nickname sprite + blob shadow.
 * Spec: docs/RESEARCH_3D_REBUILD.md §8.5 Design B.
 *
 * API (unchanged from previous avatar.js so Game3D.svelte keeps working):
 *   createAvatar({ id, name, seatIndex, photoImage }) → {
 *     group, id, seatIndex,
 *     setPhoto(img), setName(str), setLookAt(vec3),
 *     setHovering(bool), update(dt), dispose(),
 *   }
 */

import * as THREE from 'three';
import { springs } from '../anim/easing-helpers.js';

// SEAT_POSITIONS — local copy matching scene.js (avoids circular import).
// rotY rotates the group so the avatar's +Z (visor / face) points toward
// the table centre.
export const SEAT_POSITIONS = [
  { id: 'south', pos: [0,    0,  1.5], rotY:  Math.PI,       label: 'you' },
  { id: 'west',  pos: [-1.5, 0,  0  ], rotY:  Math.PI / 2,   label: 'left' },
  { id: 'north', pos: [0,    0, -1.5], rotY:  0,             label: 'across' },
  { id: 'east',  pos: [1.5,  0,  0  ], rotY: -Math.PI / 2,   label: 'right' },
];

const DEFAULT_LOOK_AT   = new THREE.Vector3(0, 0.4, 0);    // table centre
const LOOK_YAW_CLAMP    = THREE.MathUtils.degToRad(15);    // ±15°
const LOOK_PITCH_CLAMP  = THREE.MathUtils.degToRad(5);     // ±5° (subtle nod)
const JITTER_AMP        = THREE.MathUtils.degToRad(0.3);   // ±0.3°

function _prefersReducedMotion() {
  return typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Deterministic hash + cheap fake-Perlin 1D noise (combo of sines, ~0..1).
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function fakeNoise(t) {
  return 0.5 + 0.30 * Math.sin(t * 1.7 + 0.3)
             + 0.15 * Math.sin(t * 3.3 + 1.2)
             + 0.05 * Math.sin(t * 7.1 + 2.7);
}

// --- PHOTO PROCESSING ------------------------------------------------------
const PHOTO_CACHE = new Map();
const PHOTO_SIZE = 512;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('avatar: image load failed: ' + String(src).slice(0, 64)));
    img.src = src;
  });
}

async function toImage(imageOrDataUrl) {
  if (typeof imageOrDataUrl === 'string') return loadImage(imageOrDataUrl);
  if (typeof HTMLImageElement !== 'undefined' && imageOrDataUrl instanceof HTMLImageElement) {
    if (imageOrDataUrl.complete && imageOrDataUrl.naturalWidth > 0) return imageOrDataUrl;
    return new Promise((resolve, reject) => {
      imageOrDataUrl.onload  = () => resolve(imageOrDataUrl);
      imageOrDataUrl.onerror = () => reject(new Error('avatar: image load failed'));
    });
  }
  throw new Error('avatar: invalid photo (expected HTMLImageElement or string)');
}

/**
 * Build a 512×512 photo texture: center-cropped to square, with a subtle
 * radial alpha fade at the edges so the photo blends into the gray body at
 * the visor boundary. Cached by image src.
 */
export async function processPhoto(imageOrDataUrl) {
  const cacheKey = typeof imageOrDataUrl === 'string'
    ? imageOrDataUrl
    : (imageOrDataUrl && imageOrDataUrl.src) || String(imageOrDataUrl);
  if (PHOTO_CACHE.has(cacheKey)) return PHOTO_CACHE.get(cacheKey);

  const img = await toImage(imageOrDataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = PHOTO_SIZE; canvas.height = PHOTO_SIZE;
  const ctx = canvas.getContext('2d');

  // 1) Fill with neutral gray (matches body color) so the visor background
  //    matches the surrounding body when the photo's alpha fades to 0.
  ctx.fillStyle = '#C8C8C8';
  ctx.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);

  // 2) Center-crop source image to a square (cover-fit).
  const srcSize = Math.min(img.width, img.height);
  const sx = (img.width  - srcSize) / 2;
  const sy = (img.height - srcSize) / 2;

  // 3) Draw photo into a centered rect (~82% of canvas) with a radial alpha
  //    mask so the edges fade smoothly into the gray background.
  const photoSize = PHOTO_SIZE * 0.82;
  const photoX = (PHOTO_SIZE - photoSize) / 2;
  const photoY = (PHOTO_SIZE - photoSize) / 2;
  const cx = PHOTO_SIZE / 2, cy = PHOTO_SIZE / 2;
  ctx.save();
  const mask = ctx.createRadialGradient(cx, cy, photoSize * 0.20, cx, cy, photoSize * 0.55);
  mask.addColorStop(0,   'rgba(255,255,255,1)');
  mask.addColorStop(0.7, 'rgba(255,255,255,0.95)');
  mask.addColorStop(1,   'rgba(255,255,255,0)');
  ctx.fillStyle = mask;
  ctx.fillRect(photoX, photoY, photoSize, photoSize);
  ctx.globalCompositeOperation = 'source-in';
  ctx.drawImage(img, sx, sy, srcSize, srcSize, photoX, photoY, photoSize, photoSize);
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  tex.needsUpdate = true;
  PHOTO_CACHE.set(cacheKey, tex);
  return tex;
}

/** Drop the photo cache (frees GPU memory held by shared textures). */
export function clearPhotoCache() {
  for (const tex of PHOTO_CACHE.values()) tex.dispose();
  PHOTO_CACHE.clear();
}

// --- BODY ALPHA MAP (Perlin-noise broken vertical gradient) ----------------
// White = opaque (top), black = transparent (bottom). Transition boundary is
// perturbed per-column by value noise so the fade edge is broken up — avoids
// the "melted candle" clean-gradient read. Shared singleton across avatars.
let _bodyAlphaTex = null;
function getBodyAlphaTexture() {
  if (_bodyAlphaTex) return _bodyAlphaTex;
  const W = 64, H = 64;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const hash = (n) => {
    const s = Math.sin(n * 12.9898) * 43758.5453;
    return s - Math.floor(s);
  };
  const vnoise = (x) => {
    const i = Math.floor(x), f = x - i;
    const t = f * f * (3 - 2 * f); // smoothstep
    return hash(i) * (1 - t) + hash(i + 1) * t;
  };
  // Canvas y=0 is the top. With flipY=true (default), UV V=1 samples canvas
  // y=0. SphereGeometry V=1 at the top → canvas y=0 (white) = top of avatar
  // = opaque. Good.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const n = vnoise(x * 0.5);                  // 0..1, smooth in x
      const boundary  = 0.55 * H + n * 0.25 * H;  // row where fade begins
      const fadeWidth = 0.15 * H;
      let a;
      if (y < boundary)                  a = 1;
      else if (y > boundary + fadeWidth) a = 0;
      else                               a = 1 - (y - boundary) / fadeWidth;
      if (a > 0 && a < 1) a = Math.max(0, Math.min(1, a + (n - 0.5) * 0.20));
      const v = Math.round(a * 255), idx = (y * W + x) * 4;
      img.data[idx] = img.data[idx + 1] = img.data[idx + 2] = v;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  _bodyAlphaTex = new THREE.CanvasTexture(c);
  _bodyAlphaTex.colorSpace = THREE.NoColorSpace;  // alpha map = data, not color
  _bodyAlphaTex.needsUpdate = true;
  return _bodyAlphaTex;
}

// --- BLOB SHADOW TEXTURE (radial gradient) ---------------------------------
let _blobShadowTex = null;
function getBlobShadowTexture() {
  if (_blobShadowTex) return _blobShadowTex;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0,    'rgba(0,0,0,0.45)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.25)');
  g.addColorStop(1,    'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  _blobShadowTex = new THREE.CanvasTexture(c);
  _blobShadowTex.colorSpace = THREE.NoColorSpace;
  _blobShadowTex.needsUpdate = true;
  return _blobShadowTex;
}

// --- NICKNAME LABEL SPRITE -------------------------------------------------
const LABEL_W = 512, LABEL_H = 128;
function makeLabelTexture(name) {
  const canvas = document.createElement('canvas');
  canvas.width = LABEL_W; canvas.height = LABEL_H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, LABEL_W, LABEL_H);
  ctx.fillStyle = '#6A6A6A';
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

// --- SPRING (smooth look-at rotation) --------------------------------------
// Mirrors Svelte's spring() algorithm so easing-helpers.js configs (stiffness
// / damping / precision) can be reused in pure-JS contexts.
class Spring {
  constructor(initial, cfg = springs.cardHover) {
    this.value = initial; this.target = initial; this.velocity = 0;
    this.stiffness = cfg.stiffness ?? 0.15;
    this.damping = cfg.damping ?? 0.8;
    this.precision = cfg.precision ?? 0.01;
  }
  setTarget(t) { this.target = t; }
  update(dt) {
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

// --- EGG GEOMETRY BUILDER --------------------------------------------------
// Single deformed SphereGeometry → egg/bean with shoulders, brow indent,
// tapering bottom. Two material groups: [0]=body (gray plastic), [1]=visor
// (photo patch). Visor verts get planar UVs (u=(nx+1)/2, v=(ny+1)/2); body
// verts keep default sphere UVs (body material only uses the alphaMap, whose
// V axis maps cleanly onto the sphere's V axis).
function buildEggGeometry() {
  const geom = new THREE.SphereGeometry(0.5, 32, 24);
  geom.scale(0.85, 1.4, 0.85);                  // egg proportions

  const pos = geom.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // (a) Bottom taper: y<-0.2 pulled down + inward → rounded point at floor.
    if (v.y < -0.2) {
      const depth = -0.2 - v.y;
      v.y -= 0.45 * depth;
      const r = Math.max(0, 1 - 0.7 * depth);
      v.x *= r; v.z *= r;
    }
    // (b) Shoulders: subtle outward bulge in y ∈ [0.1, 0.3].
    if (v.y > 0.1 && v.y < 0.3) {
      const ramp = 1 - Math.abs(v.y - 0.2) / 0.1;
      const s = 1 + 0.08 * ramp;
      v.x *= s; v.z *= s;
    }
    // (c) Brow indent: front-facing (z>0.3) at y≈0.4 pushed inward (-z).
    if (v.z > 0.3 && v.y > 0.3 && v.y < 0.5) {
      const ramp = 1 - Math.abs(v.y - 0.4) / 0.1;
      v.z -= 0.04 * ramp;
    }
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals();

  // Partition faces: visor iff all 3 verts satisfy z>0.25 AND y>0.1.
  const indexAttr = geom.index;
  if (indexAttr) {
    const bodyIdx = [], visorIdx = [];
    const tmp = new THREE.Vector3();
    for (let i = 0; i < indexAttr.count; i += 3) {
      const a = indexAttr.getX(i), b = indexAttr.getX(i + 1), c = indexAttr.getX(i + 2);
      let isVisor = true;
      for (const vi of [a, b, c]) {
        tmp.fromBufferAttribute(pos, vi);
        if (!(tmp.z > 0.25 && tmp.y > 0.1)) { isVisor = false; break; }
      }
      (isVisor ? visorIdx : bodyIdx).push(a, b, c);
    }
    geom.setIndex(bodyIdx.concat(visorIdx));
    geom.clearGroups();
    geom.addGroup(0, bodyIdx.length, 0);
    geom.addGroup(bodyIdx.length, visorIdx.length, 1);
  }

  // Planar UVs for visor vertices: u=(nx+1)/2, v=(ny+1)/2.
  const uv = geom.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    if (v.z > 0.25 && v.y > 0.1) {
      const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      uv.setXY(i, (v.x / len + 1) / 2, (v.y / len + 1) / 2);
    }
  }
  uv.needsUpdate = true;

  // Translate so the egg's bottom sits at y=0 (local) — breathing scale.y
  // then expands upward from the floor, not symmetrically around centre.
  geom.computeBoundingBox();
  geom.translate(0, -geom.boundingBox.min.y, 0);
  return geom;
}

// Shared geometry instance (immutable after build; safe to share across all
// avatars). Built lazily on first createAvatar() call.
let _eggGeom = null;
function getEggGeometry() {
  if (!_eggGeom) _eggGeom = buildEggGeometry();
  return _eggGeom;
}

// --- AVATAR API -----------------------------------------------------------
// Internal impls; exported standalone AND attached to avatar obj.
async function setPhoto(avatar, imageOrDataUrl) {
  if (avatar._disposed) return;
  if (!imageOrDataUrl) {
    avatar._setVisorMaterial(avatar._visorFallbackMat);  // no photo → fallback
    return;
  }
  const tex = await processPhoto(imageOrDataUrl);
  if (avatar._disposed) return;  // re-check after await
  // Build (or reuse) a MeshBasicMaterial with the photo as map. Unlit so the
  // photo stays crisp and undistorted by scene lighting.
  let mat = avatar._visorPhotoMat;
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
    avatar._visorPhotoMat = mat;
  } else {
    mat.map = tex;
    mat.needsUpdate = true;
  }
  avatar._setVisorMaterial(mat);
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
  avatar._lookAtTarget = targetVec3 ? targetVec3.clone() : null;
}

function setHovering(avatar, isHovering) {
  if (avatar._disposed) return;
  avatar._hovering = !!isHovering;
  if (avatar._hovering) {
    avatar._ring.visible = true;
    avatar._ringCycle = 0;
  } else {
    avatar._ring.visible = false;
    avatar._ringMat.opacity = 0;
  }
}

function update(avatar, dt) {
  if (avatar._disposed) return;
  avatar._time += dt;
  const t = avatar._time;
  const reduced = _prefersReducedMotion();

  // Look-at: compute yaw/pitch from head to target (default = table centre).
  const target = avatar._lookAtTarget || DEFAULT_LOOK_AT;
  avatar.group.updateMatrixWorld(true);
  _m4.copy(avatar.group.matrixWorld).invert();
  _v1.copy(target).applyMatrix4(_m4);                // target in group-local
  _v2.set(0, 1.2, 0);                               // head/eye (group-local)
  _v3.copy(_v1).sub(_v2);
  let yaw = 0, pitch = 0;
  if (_v3.lengthSq() > 1e-8) {
    _v3.normalize();
    yaw   = Math.atan2(_v3.x, _v3.z);
    const horiz = Math.sqrt(_v3.x * _v3.x + _v3.z * _v3.z);
    pitch = -Math.atan2(_v3.y, horiz); // >0 = look down (target below head)
  }
  yaw   = Math.max(-LOOK_YAW_CLAMP,   Math.min(LOOK_YAW_CLAMP,   yaw));
  pitch = Math.max(-LOOK_PITCH_CLAMP, Math.min(LOOK_PITCH_CLAMP, pitch));
  avatar._yawSpring.setTarget(yaw);
  avatar._pitchSpring.setTarget(pitch);
  const sYaw   = avatar._yawSpring.update(dt);
  const sPitch = avatar._pitchSpring.update(dt);

  // Micro-jitter (cheap fake-Perlin), disabled on reduced-motion.
  let jX = 0, jZ = 0;
  if (!reduced) {
    jX = (fakeNoise(t * 0.7 + avatar._phase)       - 0.5) * 2 * JITTER_AMP;
    jZ = (fakeNoise(t * 0.5 + avatar._phase + 100) - 0.5) * 2 * JITTER_AMP;
  }
  // Yaw on bodyPivot (egg centre); pitch + jitter on bodyMesh (egg bottom —
  // pitch tilts top forward, bottom stays put).
  avatar._bodyPivot.rotation.y = sYaw;
  avatar._bodyMesh.rotation.set(sPitch + jX, 0, jZ, 'XYZ');

  // Breathing: scale.y around bottom (top grows up, bottom stays).
  const breathY = reduced ? 1
    : 1 + 0.015 * Math.sin(t * 0.4 * Math.PI * 2 + avatar._phase);
  const hoverScale = avatar._hovering ? 1.03 : 1.0;
  avatar._bodyMesh.scale.set(hoverScale, hoverScale * breathY, hoverScale);

  // Hover: expanding glow ring (1.2s loop).
  if (avatar._hovering) {
    if (!reduced) {
      avatar._ringCycle = (avatar._ringCycle + dt / 1.2) % 1;
      const k = avatar._ringCycle;
      avatar._ring.scale.setScalar(0.75 + 0.75 * k); // radius 0.3 → 0.6
      avatar._ringMat.opacity = 0.3 * (1 - k);       // 0.3 → 0
    } else {
      avatar._ring.scale.setScalar(1);
      avatar._ringMat.opacity = 0.2;
    }
    avatar._ring.visible = true;
  } else {
    avatar._ring.visible = false;
    avatar._ringMat.opacity = 0;
  }

  // Weight shift: group.position.x sways ±0.02 over 12.5s.
  if (!reduced) {
    avatar.group.position.x =
      avatar._basePos.x + Math.sin(t * 0.08 * Math.PI * 2 + avatar._phase) * 0.02;
  }
}

function dispose(avatar) {
  if (avatar._disposed) return;
  avatar._disposed = true;
  // Geometry is shared — NOT disposed per-avatar.
  avatar._bodyMat.dispose();
  avatar._visorFallbackMat.dispose();
  if (avatar._visorPhotoMat) avatar._visorPhotoMat.dispose();
  // Photo texture (visor map) is owned by PHOTO_CACHE — not disposed here.
  // Body alphaMap + blob shadow texture are shared singletons — not disposed.
  avatar._shadowMat.dispose();
  avatar._label.material.dispose();
  avatar._labelTex.dispose();
  avatar._ring.geometry.dispose();
  avatar._ringMat.dispose();
  if (avatar.group.parent) avatar.group.parent.remove(avatar.group);
}

// --- AVATAR FACTORY --------------------------------------------------------

/**
 * Build a "Design B: The Egg" player avatar at the given seat.
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

  // BODY: bodyPivot at y=0.85 (egg centre) for yaw; bodyMesh at y=-0.85
  // inside bodyPivot so its local origin (egg bottom) lands at group y=0.
  const bodyPivot = new THREE.Group();
  bodyPivot.position.set(0, 0.85, 0);
  group.add(bodyPivot);

  // Body material (group 0): glossy XP-plastic.
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: 0xC8C8C8, roughness: 0.4, metalness: 0,
    clearcoat: 1.0, clearcoatRoughness: 0.15,
    transparent: true, alphaTest: 0.01,
    alphaMap: getBodyAlphaTexture(), depthWrite: true,
  });
  // Visor material (group 1): default = gray body-matching fallback (so an
  // avatar with no photo reads as a uniform gray egg). setPhoto() swaps in a
  // MeshBasicMaterial with the photo as map when one loads.
  const visorFallbackMat = new THREE.MeshPhysicalMaterial({
    color: 0xC8C8C8, roughness: 0.4, metalness: 0,
    clearcoat: 1.0, clearcoatRoughness: 0.15,
  });
  const bodyMesh = new THREE.Mesh(getEggGeometry(), [bodyMat, visorFallbackMat]);
  bodyMesh.position.set(0, -0.85, 0);  // egg bottom at group y=0
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  bodyPivot.add(bodyMesh);

  // NICKNAME LABEL SPRITE.
  const labelTex = makeLabelTexture(truncate(name));
  const label = new THREE.Sprite(new THREE.SpriteMaterial({
    map: labelTex, transparent: true, depthWrite: false, depthTest: true,
  }));
  label.scale.set(0.9, 0.225, 1.0);
  label.position.set(0, 1.85, 0);  // above head (egg top ≈ 1.7)
  group.add(label);

  // BLOB SHADOW.
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.2, 1.2),
    new THREE.MeshBasicMaterial({
      map: getBlobShadowTexture(), transparent: true,
      depthWrite: false, depthTest: true,
    }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, 0.001, 0);  // a hair above the floor
  group.add(shadow);

  // HOVER RING (TorusGeometry at the base, hidden by default).
  const ringGeom = new THREE.TorusGeometry(0.4, 0.02, 8, 32);
  ringGeom.rotateX(Math.PI / 2);  // lay flat in the XZ plane
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xFFFFFF, transparent: true, opacity: 0.0, depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.position.set(0, 0.02, 0);
  ring.visible = false;
  group.add(ring);

  // Deterministic phase from id (fallback seatIndex) so avatars don't sync.
  const phaseSeed = String(id ?? seatIndex ?? '');
  const phase = (hashString(phaseSeed) % 1000) / 1000 * Math.PI * 2;

  const avatar = {
    group, id, seatIndex,
    // internals (underscore-prefixed; not part of the public API):
    _bodyPivot: bodyPivot, _bodyMesh: bodyMesh, _bodyMat: bodyMat,
    _visorFallbackMat: visorFallbackMat,
    _visorPhotoMat: null,
    _visorMatCurrent: visorFallbackMat,
    _label: label, _labelTex: labelTex,
    _shadow: shadow, _shadowMat: shadow.material,
    _ring: ring, _ringMat: ringMat, _ringCycle: 0,
    _phase: phase,
    _yawSpring:   new Spring(0, springs.cardHover),
    _pitchSpring: new Spring(0, springs.cardHover),
    _lookAtTarget: null, _hovering: false, _time: 0, _disposed: false,
    _basePos: new THREE.Vector3(seat.pos[0], seat.pos[1], seat.pos[2]),
    _lastPhoto: null, // Game3D.svelte writes here to detect photo changes
    // Swaps the visor material (group 1) on the bodyMesh's material array.
    _setVisorMaterial(mat) {
      if (this._visorMatCurrent === mat) return;
      this._bodyMesh.material[1] = mat;
      this._visorMatCurrent = mat;
    },
    // Public API (delegate to standalone exports):
    setPhoto:     (img) => setPhoto(avatar, img),
    setName:      (n)   => setName(avatar, n),
    setLookAt:    (v)   => setLookAt(avatar, v),
    setHovering:  (b)   => setHovering(avatar, b),
    update:       (dt)  => update(avatar, dt),
    dispose:      ()    => dispose(avatar),
  };

  // Apply initial photo (async; avatar is usable immediately, photo pops in
  // when loaded).
  if (photoImage) {
    avatar._lastPhoto = photoImage;
    avatar.setPhoto(photoImage).catch((e) => {
      console.warn('[avatar] initial photo load failed:', e?.message || e);
    });
  }
  return avatar;
}

// Re-export standalone API fns (mirrors `setLookAt(av, v)` / `setHovering(av, b)`).
export { setPhoto, setName, setLookAt, setHovering, update, dispose };
export default { createAvatar, processPhoto, SEAT_POSITIONS, clearPhotoCache };
