/**
 * Shared sun direction for terrain-tile shaders (
 */

import * as THREE from "three";

let currentSunDir = new THREE.Vector3(0.5, 1.0, 0.8).normalize();
let currentAmbient = 0.15;
const litMaterials = new Set();

export function setSunDirection(dir) {
  currentSunDir.copy(dir).normalize();
  for (const mat of litMaterials) mat.uniforms.uSunDir.value.copy(currentSunDir);
}

export function getSunDirection() {
  return currentSunDir;
}

export function setAmbientIntensity(value) {
  currentAmbient = value;
  for (const mat of litMaterials) {
    if (mat.uniforms.uAmbient) mat.uniforms.uAmbient.value = currentAmbient;
  }
}

export function getAmbientIntensity() {
  return currentAmbient;
}

export function registerLitMaterial(mat) {
  litMaterials.add(mat);
}

export function unregisterLitMaterial(mat) {
  litMaterials.delete(mat);
}
