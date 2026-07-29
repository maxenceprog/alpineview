import * as THREE from "three";
import * as itowns from "itowns";
import { API_BASE_URL } from "./apiConfig.js";
import { bomHas, loadBom } from "./bom.js";
import { loadCityBuildings } from "./buildings.js";
import { getSunDir } from "./environment.js";

export function cellLazStem(x0, y0) {
  const pad = (n) => String(n).padStart(4, "0");
  return `LHD_FXX_${pad(x0)}_${pad(y0 + 1)}_PTS_LAMB93_IGN69`;
}

const BUILDING_RADIUS_KM = 3;
const BUILDING_DROP_KM = 5;
const THROTTLE = 200;

const UP_AXIS = new THREE.Vector3(0, 0, 1);

function wrapForItowns(mesh) {
  const group = new THREE.Group();
  group.rotation.x = Math.PI / 2;
  group.scale.setScalar(1000);
  group.add(mesh);
  group.updateMatrixWorld(true);
  return group;
}

function disposeGroup(group) {
  group.traverse((obj) => {
    obj.geometry?.dispose();
    obj.material?.dispose();
  });
}

export function initBuildings(view) {
  const root = new THREE.Group();
  root.name = "buildings";
  view.scene.add(root);

  const camera = view.camera3D;
  const cells = new Map();
  let bom = null;
  let bomReady = false;
  loadBom(`${API_BASE_URL}/buildings/bom_buildings.txt`).then((set) => {
    bom = set;
    bomReady = true;
    view.notifyChange(camera);
  });

  const load = (ox, oy, cell) => {
    // A cell absent from the bom was built with no buildings (or never built):
    // skip both the .city.jsonl fetch and its paired WMTS canvas fetch, since
    // loadCityBuildings would just discard them.
    if (!bomHas(bom, ox, oy)) {
      cell.status = "empty";
      return;
    }
    cell.status = "loading";
    loadCityBuildings(`${API_BASE_URL}/buildings/${cellLazStem(ox, oy)}.city.jsonl`, {
      x0: ox, y0: oy, sunDir: getSunDir(), upAxis: UP_AXIS,
    }).then((mesh) => {
      if (cells.get(`${ox}|${oy}`) !== cell) return;
      if (!mesh) { cell.status = "empty"; return; }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      cell.group = wrapForItowns(mesh);
      cell.status = "done";
      root.add(cell.group);
      view.notifyChange(camera);
    }).catch((err) => {
      console.error("[buildings] loader threw:", err);
      cell.status = "failed";
    });
  };

  const refresh = () => {
    if (!bomReady) return;
    const cx = camera.position.x / 1000;
    const cy = camera.position.y / 1000;

    for (let ox = Math.floor(cx - BUILDING_RADIUS_KM); ox <= cx + BUILDING_RADIUS_KM; ox++) {
      for (let oy = Math.floor(cy - BUILDING_RADIUS_KM); oy <= cy + BUILDING_RADIUS_KM; oy++) {
        const key = `${ox}|${oy}`;
        if (cells.has(key)) continue;
        const cell = { status: "pending", group: null };
        cells.set(key, cell);
        load(ox, oy, cell);
      }
    }

    for (const [key, cell] of [...cells]) {
      const [ox, oy] = key.split("|").map(Number);
      const dx = Math.max(0, Math.abs(ox + 0.5 - cx) - 0.5);
      const dy = Math.max(0, Math.abs(oy + 0.5 - cy) - 0.5);
      if (Math.hypot(dx, dy) <= BUILDING_DROP_KM) continue;
      if (cell.group) {
        root.remove(cell.group);
        disposeGroup(cell.group);
      }
      cells.delete(key);
    }
  };

  let lastPass = 0;
  const lastCamPosition = new THREE.Vector3(Infinity, Infinity, Infinity);

  view.addFrameRequester(itowns.MAIN_LOOP_EVENTS.BEFORE_RENDER, () => {
    const now = performance.now();
    if (lastPass && (now - lastPass < THROTTLE || camera.position.equals(lastCamPosition))) return;
    lastCamPosition.copy(camera.position);
    lastPass = now;
    refresh();
  });

  return root;
}
