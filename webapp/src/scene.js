import * as THREE from "three";
import { LOAD_RADIUS_MAX } from "./tileManager.js";

const SUN_NAME = "sun-light";
const AMBIENT_NAME = "ambient-light";


const FOG_FAR_ATTENUATION = 1;
export const DEFAULT_FOG_DENSITY = FOG_FAR_ATTENUATION / LOAD_RADIUS_MAX;

let _sunDir = new THREE.Vector3(0.5, 1.0, 0.8).normalize();

// Sky texture — rebuilt on sun change via updateSky()
const SKY_NIGHT = { zenith: [3, 8, 25], horizon: [10, 20, 55] };
const SKY_SUNSET = { zenith: [40, 55, 140], horizon: [255, 120, 30] };
const SKY_DAY = { zenith: [8, 50, 160], horizon: [120, 195, 250] };

function lerpC(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function skyStops(sunY) {
  if (sunY >= 0.25) return SKY_DAY;
  if (sunY >= 0) {
    const t = sunY / 0.25;
    return { zenith: lerpC(SKY_SUNSET.zenith, SKY_DAY.zenith, t), horizon: lerpC(SKY_SUNSET.horizon, SKY_DAY.horizon, t) };
  }
  if (sunY >= -0.15) {
    const t = (sunY + 0.15) / 0.15;
    return { zenith: lerpC(SKY_NIGHT.zenith, SKY_SUNSET.zenith, t), horizon: lerpC(SKY_NIGHT.horizon, SKY_SUNSET.horizon, t) };
  }
  return SKY_NIGHT;
}

let _skyCanvas = null;
let _skyTexture = null;

function drawSky(sunY) {
  const { zenith, horizon } = skyStops(sunY);
  const ctx = _skyCanvas.getContext("2d");
  const h = _skyCanvas.height;
  for (let y = 0; y < h; y++) {
    const t = y / h;
    const c = t <= 0.5
      ? lerpC(zenith, horizon, t / 0.5)
      : lerpC(horizon, [30, 25, 20], (t - 0.5) / 0.5);
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.fillRect(0, y, _skyCanvas.width, 1);
  }
  _skyTexture.needsUpdate = true;
  return horizon;
}

export function createScene() {
  const scene = new THREE.Scene();

  _skyCanvas = document.createElement("canvas");
  _skyCanvas.width = 4;
  _skyCanvas.height = 512;
  _skyTexture = new THREE.CanvasTexture(_skyCanvas);

  const initialHorizon = drawSky(0.8);
  const horizonColor = new THREE.Color(
    initialHorizon[0] / 255, initialHorizon[1] / 255, initialHorizon[2] / 255,
  );
  scene.background = horizonColor.clone();
  scene.fog = new THREE.FogExp2(horizonColor, DEFAULT_FOG_DENSITY);

  // Sky sphere — follows camera each frame (see main.js)
  const skySphere = new THREE.Mesh(
    new THREE.SphereGeometry(400, 32, 16),
    new THREE.MeshBasicMaterial({ map: _skyTexture, side: THREE.BackSide, fog: false }),
  );
  skySphere.name = "sky";
  scene.add(skySphere);

  // Ambient — intensity driven smoothly by sun elevation
  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  ambient.name = AMBIENT_NAME;
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfff4e0, 1.2);
  sun.name = SUN_NAME;
  sun.castShadow = true;
  sun.position.set(0.5, 2, 0.8);

  // Shadow frustum: covers a 10 × 10 km box, 2048² map → ~5 m/px
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -10;
  sun.shadow.camera.right = 10;
  sun.shadow.camera.top = 10;
  sun.shadow.camera.bottom = -10;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 25; // sun is 15 km from target; covers terrain ±10 km depth
  sun.shadow.bias = -0.001;
  sun.shadow.radius = 2;     // PCF soft kernel

  scene.add(sun);
  scene.add(sun.target); // target must be in scene for shadow camera to track it

  const fill = new THREE.DirectionalLight(0xb0c8ff, 0.3);
  fill.position.set(-0.8, 0.4, -0.6);
  scene.add(fill);

  const grid = new THREE.GridHelper(4, 40, 0x334455, 0x222d3a);
  grid.name = "grid";
  scene.add(grid);

  // Sun disc + glow — positioned each frame in main.js along _sunDir
  const sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(5, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xfffde0, fog: false }),
  );
  sunMesh.name = "sun-mesh";
  scene.add(sunMesh);

  const sunGlow = new THREE.Mesh(
    new THREE.SphereGeometry(15, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffe566, transparent: true, opacity: 0.25, fog: false }),
  );
  sunGlow.name = "sun-glow";
  scene.add(sunGlow);

  return scene;
}

/** Reposition shadow frustum to stay centred over the camera.
 *  Sun position and target are both kept relative to the camera so the
 *  shadow map always covers the nearby terrain regardless of world offset. */
export function updateShadowCamera(scene, cameraPos) {
  const sun = scene.getObjectByName(SUN_NAME);
  if (!sun?.shadow) return;
  // Place sun 15 km from camera along sun direction; target at ground below camera.
  sun.position.set(
    cameraPos.x + _sunDir.x * 15,
    _sunDir.y * 15,
    cameraPos.z + _sunDir.z * 15,
  );
  sun.target.position.set(cameraPos.x, 0, cameraPos.z);
  sun.target.updateMatrixWorld();
  sun.shadow.camera.updateProjectionMatrix();
}

/** Redraw sky gradient + fog/background color to match sun elevation. */
export function updateSky(scene, sunDir) {
  if (!_skyCanvas) return;
  const horizon = drawSky(sunDir.y);
  const c = new THREE.Color(horizon[0] / 255, horizon[1] / 255, horizon[2] / 255);
  if (scene.fog) scene.fog.color.copy(c);
  scene.background.copy(c);
}

/** Update sun direction and smoothly adjust light intensities for day/night.
 *  sun.position is owned by updateShadowCamera (called every frame) so we
 *  only store the direction here and let that function reposition. */
export function updateSunDirection(scene, direction) {
  _sunDir = direction.clone().normalize();

  const sun = scene.getObjectByName(SUN_NAME);
  const ambient = scene.getObjectByName(AMBIENT_NAME);
  if (!sun) return;

  sun.intensity = Math.max(0, _sunDir.y) * 1.2;

  if (ambient) {
    const t = Math.max(0, Math.min(1, (_sunDir.y + 0.2) / 0.5));
    const smooth = t * t * (3 - 2 * t);
    ambient.intensity = 0.05 + 0.35 * smooth;
  }
}
