/**
 * Shared sun direction for terrain-tile shaders (
 */

import * as THREE from "three";

let currentSunDir = new THREE.Vector3(0.5, 1.0, 0.8).normalize();
const litMaterials = new Set();

export function setSunDirection(dir) {
  currentSunDir.copy(dir).normalize();
  for (const mat of litMaterials) mat.uniforms.uSunDir.value.copy(currentSunDir);
}

export function getSunDirection() {
  return currentSunDir;
}

export function registerLitMaterial(mat) {
  litMaterials.add(mat);
}

export function unregisterLitMaterial(mat) {
  litMaterials.delete(mat);
}
