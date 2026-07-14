import * as SunCalc from "suncalc";
import * as THREE from "three";

const DEFAULT_LAT = 46.5;
const DEFAULT_LON = 2.5;

const DEG = Math.PI / 180;

/**
 * Convert SunCalc v2 altitude/azimuth (degrees) to a Three.js direction vector
 * pointing FROM the sun TOWARD the origin.
 *
 * SunCalc v2 conventions:
 *   altitude — degrees above horizon (positive = above)
 *   azimuth  — degrees from North, clockwise (N=0, E=90, S=180, W=270)
 *
 * Scene orientation after PLY rotateX(-π/2):
 *   +X = east, -Z = north, +Z = south, +Y = up
 */
export function sunDirection(altitudeDeg, azimuthDeg) {
  const altRad = altitudeDeg * DEG;
  const azRad = azimuthDeg * DEG;
  const cosAlt = Math.cos(altRad);
  return new THREE.Vector3(
    Math.sin(azRad) * cosAlt,
    Math.sin(altRad),
    -Math.cos(azRad) * cosAlt
  ).normalize();
}

/** Return the sun's direction vector for a given date at the default scene location. */
export function sunDirectionAt(date) {
  const { altitude, azimuth } = SunCalc.getPosition(date, DEFAULT_LAT, DEFAULT_LON);
  return sunDirection(altitude, azimuth);
}
