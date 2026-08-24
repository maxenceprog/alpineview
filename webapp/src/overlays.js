import * as itowns from "itowns";
import * as THREE from "three";
import { API_BASE_URL } from "./apiConfig.js";
import { BUILDINGS_BOM } from "./buildingsBom.js";
import { loadCityBuildings } from "./buildings.js";
import { webMercatorToL93 } from "./proj.js";
import { localToMerc } from "./workFrame.js";

export function cellLazStem(x0, y0) {
  const pad = (n) => String(n).padStart(4, "0");
  return `LHD_FXX_${pad(x0)}_${pad(y0 + 1)}_PTS_LAMB93_IGN69`;
}

const BUILDING_RADIUS_KM = 2;

export function initBuildings(view) {
  const root = new THREE.Group();
  root.name = "buildings";
  view.scene.add(root);

  const camera = view.camera3D;
  const cells = new Map();

  const load = (ox, oy, cell) => {
    // A cell absent from the bom was built with no buildings (or never built):
    // skip the .city.jsonl fetch, since loadCityBuildings would just discard it.
    if (!BUILDINGS_BOM.has(`${ox}.${oy}`)) {
      cell.status = "empty";
      return;
    }
    cell.status = "loading";
    loadCityBuildings(`${API_BASE_URL}/buildings/${cellLazStem(ox, oy)}.city.jsonl`).then((mesh) => {
      if (cells.get(`${ox}|${oy}`) !== cell) return;
      if (!mesh) { cell.status = "empty"; return; }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      cell.mesh = mesh;
      cell.status = "done";
      cell.inScene = true;
      root.add(mesh);
      view.notifyChange(camera);
    }).catch((err) => {
      console.error("[buildings] loader threw:", err);
      cell.status = "failed";
    });
  };

  // The building grid is still keyed by L93 km cells (see cellLazStem), but
  // the camera lives in the local work frame (see workFrame.js) — convert
  // it back to L93 to know which cells are nearby.
  const cameraCellL93Km = () => {
    const [mx, my] = localToMerc(camera.position.x, camera.position.y);
    const [lx, ly] = webMercatorToL93.forward([mx, my]);
    return [lx / 1000, ly / 1000];
  };

  const refresh = () => {
    const [cx, cy] = cameraCellL93Km();
    const wanted = new Set();

    for (let ox = Math.floor(cx - BUILDING_RADIUS_KM); ox <= cx + BUILDING_RADIUS_KM; ox++) {
      for (let oy = Math.floor(cy - BUILDING_RADIUS_KM); oy <= cy + BUILDING_RADIUS_KM; oy++) {
        const key = `${ox}|${oy}`;
        wanted.add(key);
        let cell = cells.get(key);
        if (!cell) {
          cell = { status: "pending", mesh: null, inScene: false };
          cells.set(key, cell);
          load(ox, oy, cell);
        }
        if (cell.mesh && !cell.inScene) {
          root.add(cell.mesh);
          cell.inScene = true;
        }
      }
    }

    // Cells stay cached in `cells` once loaded -- only detached from the
    // scene, never disposed -- so re-entering a cell (e.g. a camera parked
    // near a grid boundary) reuses the mesh instead of refetching.
    for (const [key, cell] of cells) {
      if (wanted.has(key)) continue;
      if (cell.mesh && cell.inScene) {
        root.remove(cell.mesh);
        cell.inScene = false;
      }
    }
  };

  const lastCamPosition = new THREE.Vector3(Infinity, Infinity, Infinity);

  view.addFrameRequester(itowns.MAIN_LOOP_EVENTS.BEFORE_RENDER, () => {
    if (camera.position.equals(lastCamPosition)) return;
    lastCamPosition.copy(camera.position);
    refresh();
  });

  return root;
}
