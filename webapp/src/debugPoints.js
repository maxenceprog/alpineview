/**
 * Debug loader: fetch a `.stk1` COPC point dump (see scripts/debug_copc_points.py)
 * and render each point as a 1 m diameter sphere colored by LAS classification.
 * Not Draco-encoded (debug bboxes are small); carries per-point classification.
 */

import * as THREE from "three";
import { sizeScale } from "./pointSprites.js";

const _MAGIC = "STK1";
const _HEADER_BYTES = 4 + 3 * 8 + 4; // magic + ox,oy,oz float64 + count uint32
const SPHERE_DIAMETER_M = 1;

// ASPRS LAS classification codes, IGN LiDAR HD subset. Flat (unshaded) colors,
// chosen so class 1 and 2 (by far the most common) read as clearly distinct.
const CLASS_COLORS = {
  1: 0xff0000, // unclassified — red
  2: 0x00ffff, // ground — cyan
  3: 0x9acd32, // low vegetation
  4: 0x4caf50, // medium vegetation
  5: 0x1b5e20, // high vegetation
  6: 0xff9800, // building
  9: 0x2196f3, // water
  17: 0x9c27b0, // bridge deck
};
const DEFAULT_COLOR = 0xffffff;

const _vertexShader = /* glsl */ `
  uniform float uScale;   // (viewportHeight/2) / tan(fov/2)
  uniform float uRadius;  // sphere radius in scene km
  attribute vec3 aColor;
  varying vec3 vColor;
  void main() {
    vColor  = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uRadius * uScale / -mv.z, 1.0, 64.0);
  }
`;

const _fragmentShader = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    if (dot(c, c) > 1.0) discard;          // round disc, not square
    gl_FragColor = vec4(vColor, 1.0);      // flat color, no shading
  }
`;

/**
 * Load a `.stk1` file and return a THREE.Points of classification-colored sphere impostors.
 *
 * @param {string} url
 * @returns {Promise<THREE.Points|null>}
 */
export async function loadDebugPoints(url) {
  const buf = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
    return r.arrayBuffer();
  });

  const dv = new DataView(buf);
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== _MAGIC) {
    throw new Error(`not a .stk1 file (magic="${magic}"): ${url}`);
  }
  const ox = dv.getFloat64(4, true);
  const oy = dv.getFloat64(12, true);
  const oz = dv.getFloat64(20, true);
  const count = dv.getUint32(28, true);
  if (count === 0) return null;

  const xyzBytes = count * 3 * 4;
  const local = new Float32Array(buf.slice(_HEADER_BYTES, _HEADER_BYTES + xyzBytes));
  const classification = new Uint8Array(buf, _HEADER_BYTES + xyzBytes, count);

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const tmpColor = new THREE.Color();

  for (let i = 0; i < count; i++) {
    // local metre offset → L93 metres → scene km (x=east, y=alt, z=-north).
    positions[i * 3]     = (ox + local[i * 3])     / 1000;
    positions[i * 3 + 1] = (oz + local[i * 3 + 2]) / 1000;
    positions[i * 3 + 2] = -(oy + local[i * 3 + 1]) / 1000;

    tmpColor.set(CLASS_COLORS[classification[i]] ?? DEFAULT_COLOR);
    colors[i * 3]     = tmpColor.r;
    colors[i * 3 + 1] = tmpColor.g;
    colors[i * 3 + 2] = tmpColor.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aColor",   new THREE.BufferAttribute(colors, 3));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uScale:  { value: 1000 },
      uRadius: { value: SPHERE_DIAMETER_M / 2 / 1000 },
    },
    vertexShader: _vertexShader,
    fragmentShader: _fragmentShader,
  });

  const points = new THREE.Points(geometry, material);
  points.name = "debug-points";
  points.frustumCulled = false;
  points.onBeforeRender = (renderer, scene, camera) => {
    material.uniforms.uScale.value = sizeScale(camera, renderer);
  };
  return points;
}
