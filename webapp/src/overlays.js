/**
 * Proximity overlays — load per-cell features (buildings, vegetation) on demand.
 *
 * When enabled, a CellOverlay watches the camera and, for every 1 km L93 cell
 * within `radiusKm` (horizontal distance only — camera Y is absolute elevation,
 * not height above ground, so it can't be used for the range check), fetches
 * that cell's data via `load(x0, y0)` and adds it to the scene; cells that fall out of range
 * are disposed. Cells with no data (404) are remembered so they aren't refetched
 * — that memory is cleared when the overlay is toggled off, so newly-built data
 * is picked up on re-enable.
 */

import { API_BASE_URL } from "./apiConfig.js";
import { loadCityBuildings } from "./buildings.js";
import { fetchCellPois, buildPoiGroup } from "./poi.js";
import { MEDIUM_LOD_RADIUS_KM } from "./tileManager.js";

// Buildings key off this so they only render where terrain has already
// reached at least the medium (z=1) LOD, keeping overlay detail coherent
// with the terrain it sits on. (Vegetation rides the z=2 tiles directly in
// the tile manager.)
const OVERLAY_RADIUS_KM = MEDIUM_LOD_RADIUS_KM;

/** Cell (x0, y0) → source LAZ stem (NW-corner naming: y = y0 + 1 km). */
export function cellLazStem(x0, y0) {
  const pad = (n) => String(n).padStart(4, "0");
  return `LHD_FXX_${pad(x0)}_${pad(y0 + 1)}_PTS_LAMB93_IGN69`;
}

export class CellOverlay {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts  { radiusKm, load: (x0,y0) => Promise<Object3D|null> }
   */
  constructor(scene, { radiusKm, load }) {
    this._scene = scene;
    this._radiusKm = radiusKm;
    this._load = load;
    this._objects = new Map(); // "x|y" → Object3D
    this._loading = new Set();
    this._empty = new Set(); // cells known to have no data
    this._needed = new Set(); // cells wanted as of the last tick (live)
    this.enabled = false;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this._clear();
  }

  /** Currently-loaded overlay objects (for e.g. sun-direction updates). */
  objects() {
    return this._objects.values();
  }

  update(camera) {
    if (!this.enabled) return;
    const cx = camera.position.x, cy = -camera.position.z;
    const r = Math.ceil(this._radiusKm);
    const x0c = Math.floor(cx), y0c = Math.floor(cy);

    const needed = new Set();
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++) {
        const x0 = x0c + dx, y0 = y0c + dy;
        const d = Math.hypot(cx - (x0 + 0.5), cy - (y0 + 0.5));
        if (d <= this._radiusKm) needed.add(`${x0}|${y0}`);
      }
    this._needed = needed; // expose live set for in-flight loads to re-check

    for (const key of needed) {
      if (this._objects.has(key) || this._loading.has(key) || this._empty.has(key))
        continue;
      this._loading.add(key);
      const [x0, y0] = key.split("|").map(Number);
      console.log("[overlay] loading cell", key);
      this._load(x0, y0)
        .then((obj) => {
          this._loading.delete(key);
          if (!obj) { console.warn("[overlay] cell returned null (empty):", key); this._empty.add(key); return; }
          // Discard if the overlay was disabled or the cell drifted out of range
          // while loading (check the live set, not the tick that started us).
          if (!this.enabled || !this._needed.has(key)) { console.log("[overlay] cell discarded (out of range or disabled):", key); _dispose(obj); return; }
          console.log("[overlay] cell added to scene:", key, obj);
          this._scene.add(obj);
          this._objects.set(key, obj);
        })
        .catch((err) => {
          this._loading.delete(key);
          this._empty.add(key); // missing/failed → don't hammer the server
          console.warn("[overlay] cell failed, marked empty:", key, err);
        });
    }

    for (const [key, obj] of this._objects)
      if (!needed.has(key)) {
        this._scene.remove(obj);
        _dispose(obj);
        this._objects.delete(key);
      }
  }

  _clear() {
    for (const obj of this._objects.values()) {
      this._scene.remove(obj);
      _dispose(obj);
    }
    this._objects.clear();
    this._empty.clear(); // retry 404s next time the overlay is enabled
  }
}

/** Free geometry + material for an object and any children. */
function _dispose(root) {
  root.traverse((obj) => {
    obj.geometry?.dispose();
    obj.material?.dispose();
    // CSS2DObject (e.g. POI labels): its "removed" listener only fires when
    // it is removed directly, not when an ancestor (this cell's group) is
    // removed from the scene — detach its DOM element explicitly here.
    obj.element?.remove();
  });
}

/** Build an overlay that fetches `/{dir}/{lazStem}.{ext}` per cell via `loader`. */
function makeCellOverlay(scene, { dir, ext, loader }) {
  return new CellOverlay(scene, {
    radiusKm: OVERLAY_RADIUS_KM,
    load: (x0, y0) =>
      loader(`${API_BASE_URL}/${dir}/${cellLazStem(x0, y0)}.${ext}`).catch((err) => { console.error("[overlay] loader threw:", err); return null; }),
  });
}

/** Buildings overlay: fetch each cell's CityJSONL, null if absent. */
export function createBuildingsOverlay(scene, getSunDir, getTerrainCanvas) {
  return new CellOverlay(scene, {
    radiusKm: OVERLAY_RADIUS_KM,
    load: (x0, y0) =>
      loadCityBuildings(`${API_BASE_URL}/buildings/${cellLazStem(x0, y0)}.city.jsonl`, {
        x0, y0, sunDir: getSunDir?.(), getTerrainCanvas,
      }).catch((err) => { console.error("[overlay] loader threw:", err); return null; }),
  });
}

/** POI overlay: fetch each cell's summits/passes/huts/parking via the Camptocamp API, build labels. */
export function createPoiOverlay(scene, tileManager, onSelect) {
  return new CellOverlay(scene, {
    radiusKm: OVERLAY_RADIUS_KM,
    load: (x0, y0) =>
      fetchCellPois(x0, y0)
        .then((pois) => buildPoiGroup(pois, x0, y0, (wx, wz) => tileManager.getHeightAt(wx, wz), onSelect))
        .catch((err) => { console.error("[overlay] poi loader threw:", err); return null; }),
  });
}

