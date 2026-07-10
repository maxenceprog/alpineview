/**
 * Shared sizing helper for THREE.Points shader materials that draw round
 * sprite impostors (spheres, sticks, ...) with a `gl_PointSize` clamped to a
 * fixed screen-space size. Used by debugPoints.js (.stk1).
 */

import * as THREE from "three";

/** (viewportHeight/2)/tan(fov/2) — px-per-km-at-unit-depth factor for sizing. */
export function sizeScale(camera, renderer) {
  const h = renderer.getSize(new THREE.Vector2()).y;
  return (h * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
}
