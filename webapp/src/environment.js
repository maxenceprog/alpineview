import * as itowns from "itowns";
import * as THREE from "three";
import { setTerrainLightingEnabled } from "./layers.js";
import { sunDirectionAt } from "./sun.js";
import { setSunDirection } from "./sunLighting.js";

export const DEFAULT_FOG_DENSITY_PER_KM = 0.05;

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

function skyStops(sunUp) {
  if (sunUp >= 0.25) return SKY_DAY;
  if (sunUp >= 0) {
    const t = sunUp / 0.25;
    return {
      zenith: lerpC(SKY_SUNSET.zenith, SKY_DAY.zenith, t),
      horizon: lerpC(SKY_SUNSET.horizon, SKY_DAY.horizon, t),
    };
  }
  if (sunUp >= -0.15) {
    const t = (sunUp + 0.15) / 0.15;
    return {
      zenith: lerpC(SKY_NIGHT.zenith, SKY_SUNSET.zenith, t),
      horizon: lerpC(SKY_NIGHT.horizon, SKY_SUNSET.horizon, t),
    };
  }
  return SKY_NIGHT;
}

const _sunDir = new THREE.Vector3(0.5, -0.8, 1.0).normalize();
const _fwd = new THREE.Vector3();
const SHADOW_DIST = 16000;
const SHADOW_GROUND_Z = 1500;
const SHADOW_LOOK_MAX = 14000;
let _enabled = true;

export function getSunDir() {
  return _sunDir;
}

export function initEnvironment(view) {
  const renderer = view.mainLoop.gfxEngine.renderer;
  renderer.shadowMap.enabled = false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  let _shadows = false;

  const scene = view.scene;

  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfff4e0, 1.2);
  sun.castShadow = false;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -10000;
  sun.shadow.camera.right = 10000;
  sun.shadow.camera.top = 10000;
  sun.shadow.camera.bottom = -10000;
  sun.shadow.camera.near = SHADOW_DIST - 8000;
  sun.shadow.camera.far = SHADOW_DIST + 8000;
  sun.shadow.bias = -0.001;
  sun.shadow.radius = 2;
  scene.add(sun);
  scene.add(sun.target);

  const skyCanvas = document.createElement("canvas");
  skyCanvas.width = 4;
  skyCanvas.height = 512;
  const skyTexture = new THREE.CanvasTexture(skyCanvas);

  function drawSky(sunUp) {
    const { zenith, horizon } = skyStops(sunUp);
    const ctx = skyCanvas.getContext("2d");
    const h = skyCanvas.height;
    for (let y = 0; y < h; y++) {
      const t = y / h;
      const c = t <= 0.5
        ? lerpC(zenith, horizon, t / 0.5)
        : lerpC(horizon, [30, 25, 20], (t - 0.5) / 0.5);
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.fillRect(0, y, skyCanvas.width, 1);
    }
    skyTexture.needsUpdate = true;
    return new THREE.Color(horizon[0] / 255, horizon[1] / 255, horizon[2] / 255);
  }

  const skyGeo = new THREE.SphereGeometry(400000, 32, 16);
  skyGeo.rotateX(Math.PI / 2);
  const skySphere = new THREE.Mesh(
    skyGeo,
    new THREE.MeshBasicMaterial({ map: skyTexture, side: THREE.BackSide, fog: false }),
  );
  scene.add(skySphere);

  const sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(5000, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xfffde0, fog: false }),
  );
  scene.add(sunMesh);
  const sunGlow = new THREE.Mesh(
    new THREE.SphereGeometry(15000, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffe566, transparent: true, opacity: 0.25, fog: false }),
  );
  scene.add(sunGlow);

  const horizon = drawSky(_sunDir.z);
  scene.fog = new THREE.FogExp2(horizon, DEFAULT_FOG_DENSITY_PER_KM / 1000);
  scene.background = horizon.clone();

  view.addFrameRequester(itowns.MAIN_LOOP_EVENTS.BEFORE_RENDER, () => {
    const cam = view.camera3D.position;
    skySphere.position.copy(cam);
    const aboveHorizon = _enabled && _sunDir.z > -0.02;
    sunMesh.visible = aboveHorizon;
    sunGlow.visible = aboveHorizon;
    if (aboveHorizon) {
      sunMesh.position.copy(cam).addScaledVector(_sunDir, 350000);
      sunGlow.position.copy(sunMesh.position);
    }

    view.camera3D.getWorldDirection(_fwd);
    let dist = _fwd.z < -0.05 ? (cam.z - SHADOW_GROUND_Z) / -_fwd.z : SHADOW_LOOK_MAX;
    dist = Math.min(Math.max(dist, 0), SHADOW_LOOK_MAX);
    const fx = cam.x + _fwd.x * dist;
    const fy = cam.y + _fwd.y * dist;
    sun.position.set(
      fx + _sunDir.x * SHADOW_DIST,
      fy + _sunDir.y * SHADOW_DIST,
      SHADOW_GROUND_Z + _sunDir.z * SHADOW_DIST,
    );
    sun.target.position.set(fx, fy, SHADOW_GROUND_Z);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
    skySphere.updateMatrixWorld();
    sunMesh.updateMatrixWorld();
    sunGlow.updateMatrixWorld();
  });

  function setSunDate(date) {
    const old = sunDirectionAt(date);
    _sunDir.set(old.x, -old.z, old.y).normalize();
    setSunDirection(_sunDir);

    sun.intensity = Math.max(0, _sunDir.z) * 1.2;
    const t = Math.max(0, Math.min(1, (_sunDir.z + 0.2) / 0.5));
    ambient.intensity = 0.05 + 0.35 * (t * t * (3 - 2 * t));

    const c = drawSky(_sunDir.z);
    scene.fog.color.copy(c);
    scene.background.copy(c);
    view.notifyChange(view.camera3D);
  }

  let savedFogDensity = scene.fog.density;

  function setEnabled(on) {
    _enabled = on;
    ambient.visible = on;
    sun.visible = on;
    skySphere.visible = on;
    if (on) {
      scene.fog.density = savedFogDensity;
    } else {
      savedFogDensity = scene.fog.density;
      scene.fog.density = 0;
    }
    setTerrainLightingEnabled(on);
    applyShadowState();
    view.notifyChange(view.camera3D);
  }

  // three bakes USE_SHADOWMAP / NUM_DIR_LIGHT_SHADOWS into cached programs and
  // keyed material properties. Changing the flags without dropping those caches
  // leaves a program expecting directionalShadowMatrix[1] while the light state
  // array is empty -> crash on upload. Emptying the cache forces a clean
  // recompile against the new state.
  function applyShadowState() {
    const active = _shadows && _enabled;
    renderer.shadowMap.enabled = active;
    sun.castShadow = active;
    renderer.shadowMap.needsUpdate = true;
    renderer.renderLists.dispose();
    renderer.properties.dispose();
  }

  function setShadowsEnabled(on) {
    _shadows = on;
    applyShadowState();
    view.notifyChange(view.camera3D);
  }

  setSunDate(new Date());
  return { setSunDate, setEnabled, setShadowsEnabled };
}

export class TileLightingLayer extends itowns.Layer {
  constructor(id) {
    super(id, { source: false });
  }

  update(context, layer, node) {
    if (!node.material?.setUniform) return;
    node.material.setUniform("lightingEnabled", _enabled);
    node.material.setUniform("lightPosition", _sunDir);
  }
}
