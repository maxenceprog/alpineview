import * as THREE from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { API_BASE_URL } from "./apiConfig.js";
import { IS_MOBILE } from "./deviceInfo.js";
import { buildHeightmap, sampleHeight } from "./heightmap.js";
import { processGeometry } from "./geometryWorkerPool.js";
import { applyLayer, disposeLayerMaterials } from "./layers.js";
import { setSunDirection } from "./sunLighting.js";

const _loader = new DRACOLoader();
_loader.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);

// A cell is served by EITHER its own tile OR its four children one zoom deeper,
// chosen by camera distance — never both, so no overlap / z-fighting.
//   z=0 → 1 km, z=1 → 500 m, z=2 → 250 m
// Load radius (km) scales with camera altitude: near the ground the horizon
// is close anyway (terrain occludes it in the mountains), so there's no
// point paying for far z=0 tiles; at high altitude the view opens up and
// needs a bigger radius. Capped lower on mobile — the ceiling is what mostly
// matters there, since flying high with a large radius is the worst case for
// tile/imagery memory.
const LOAD_RADIUS_MIN = 4;                  // km — floor, even at ground level
export const LOAD_RADIUS_MAX = IS_MOBILE ? 6 : 8;  // km — ceiling, at high altitude
const MAX_Z = 2;          // deepest zoom level available
// Subdivide a tile at zoom z into z+1 children when its centre is within DETAIL_RADIUS[z].
const DETAIL_RADIUS = [1.5, 0.6]; // z=0→z=1, z=1→z=2, km
// Radius within which terrain is at least at the medium (z=1, 500 m) LOD.
// Proximity overlays (buildings, vegetation) key off this so they never render
// fine detail on top of still-coarse (z=0) terrain.
export const MEDIUM_LOD_RADIUS_KM = DETAIL_RADIUS[0];
// Hysteresis: once subdivided, a cell only collapses back when the camera moves
// past DETAIL_RADIUS[z] * this factor. Without it, a camera sitting near a
// boundary makes the cell flip-flop every tick, endlessly reloading high-res
// children. > 1.
const DETAIL_HYSTERESIS = 1.35;
// Altitude contribution to LOD distance. 1.0 = equal weight as horizontal,
// 0.1 = altitude needs to be 10× the horizontal threshold to matter.
// Keep low so you can get full-res tiles by being close horizontally
// regardless of moderate fly altitude.
const ALTITUDE_LOD_WEIGHT = 0.15;

function tileKey(tx, ty, z) { return `${tx}|${ty}|${z}`; }

/** Tile size in km at zoom z. */
function tileSize(z) { return 1 / (1 << z); }

/**
 * World translation (Three.js) to apply to a tile's mesh: x=L93_x, z=-L93_y.
 * Sub-tile vertices are stored relative to the PARENT 1 km tile origin (the
 * build pipeline crops without re-translating), so the offset is the parent km
 * origin — `floor(tx / 2^z)` — identical for all LOD levels of the same cell.
 */
function tileMeshOffset(tx, ty, z) {
  const scale = 1 << z;
  return new THREE.Vector3(Math.floor(tx / scale), 0, -Math.floor(ty / scale));
}

/**
 * True if tiles a and b cover overlapping ground — i.e. one is the quadtree
 * ancestor of (or equal to) the other. Uses arithmetic `>>`, which floors
 * toward -∞ for negative coords, matching how children are derived (tx*2+i).
 */
function sameLineage(ax, ay, az, bx, by, bz) {
  if (az > bz) { const k = az - bz; return (ax >> k) === bx && (ay >> k) === by; }
  const k = bz - az; return (bx >> k) === ax && (by >> k) === ay;
}

/** World footprint centre of tile (tx,ty,z) in L93 km. */
function tileCenter(tx, ty, z) {
  const s = tileSize(z);
  return { x: (tx + 0.5) * s, y: (ty + 0.5) * s };
}

/**
 * Distance from the camera to the centre of tile (tx,ty,z), in L93 km.
 * `ch` is the camera height (km) above ground — include it so LOD coarsens
 * with altitude. Without it, flying straight up keeps maximum detail directly
 * below the camera (horizontal distance ≈ 0) and never falls back to low-res.
 */
function tileDist(cx, cy, tx, ty, z, ch = 0) {
  const c = tileCenter(tx, ty, z);
  return Math.hypot(cx - c.x, cy - c.y, ch);
}

/** z=0 load radius (km) for camera height `ch` (km above ground) — see LOAD_RADIUS_MIN/MAX. */
function loadRadiusFor(ch) {
  return Math.min(LOAD_RADIUS_MAX, Math.max(LOAD_RADIUS_MIN, LOAD_RADIUS_MIN + ch * 1.5));
}


// Placeholder quads are subdivided so their surface can follow the terrain:
// border vertices are sampled a couple of metres into whichever real
// neighbour tile is loaded, and interior heights are inverse-distance
// interpolated from those border samples.
const PH_SEGMENTS = 16;
const PH_BORDER_EPS_KM = 0.002;

function elevatePlaceholder(ph, tx, ty, z, sampleWorldHeight) {
  const s = tileSize(z);
  const half = s / 2;
  const tol = s * 1e-6;
  const c = tileCenter(tx, ty, z);
  const pos = ph.geometry.attributes.position;

  const samples = [];
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i), lz = pos.getZ(i);
    const dx = Math.abs(lx + half) < tol ? -1 : Math.abs(lx - half) < tol ? 1 : 0;
    const dz = Math.abs(lz + half) < tol ? -1 : Math.abs(lz - half) < tol ? 1 : 0;
    if (!dx && !dz) continue;
    const h = sampleWorldHeight(c.x + lx + dx * PH_BORDER_EPS_KM,
      -c.y + lz + dz * PH_BORDER_EPS_KM);
    if (h != null) samples.push([lx, lz, h]);
  }
  if (!samples.length) return;

  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i), lz = pos.getZ(i);
    let wSum = 0, hSum = 0;
    for (const [sx, sz, h] of samples) {
      const d2 = (lx - sx) * (lx - sx) + (lz - sz) * (lz - sz);
      if (d2 < 1e-12) { wSum = 1; hSum = h; break; }
      const w = 1 / d2;
      wSum += w; hSum += w * h;
    }
    pos.setY(i, hSum / wSum);
  }
  pos.needsUpdate = true;
  ph.geometry.computeBoundingSphere();
}

// Once the real tile is in the scene the placeholder only serves as a dark
// backdrop behind mesh holes: flatten the draped quad and park it below the
// tile so it can never poke through the real surface.
function flattenPlaceholder(ph, y) {
  const pos = ph.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, 0);
  pos.needsUpdate = true;
  ph.position.y = y;
  ph.geometry.computeBoundingSphere();
}

function makePlaceholder(tx, ty, z) {
  const s = tileSize(z);
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0d1b2a";
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = "#2a4a6a";
  ctx.lineWidth = 4;
  ctx.strokeRect(6, 6, 244, 244);
  ctx.fillStyle = "#3a6a9a";
  ctx.font = "bold 28px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`${tx}, ${ty}`, 128, 108);
  ctx.font = "18px monospace";
  ctx.fillStyle = "#2a5a7a";
  ctx.fillText(`z=${z}`, 128, 152);
  const geo = new THREE.PlaneGeometry(s, s, PH_SEGMENTS, PH_SEGMENTS);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    map: new THREE.CanvasTexture(canvas),
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  }));
  const c = tileCenter(tx, ty, z);
  mesh.position.set(c.x, 0, -c.y);
  mesh.name = `ph-${tx}-${ty}-${z}`;
  return mesh;
}

// Decoded DRACO geometries are cached across unload/reload cycles (LOD churn,
// camera pan-back) instead of re-fetched + re-decoded each time. `_unload`
// transfers ownership of a tile's geometry here instead of disposing it;
// `loadDraco` reclaims it on a cache hit. Bounded + LRU (re-insert on hit),
// evicting via geometry.dispose() to free GPU buffers.
const GEOMETRY_CACHE_MAX = 300;
const geometryCache = new Map(); // key → THREE.BufferGeometry

function cacheGeometry(key, geometry) {
  if (geometryCache.has(key)) { geometry.dispose(); return; }
  geometryCache.set(key, geometry);
  if (geometryCache.size > GEOMETRY_CACHE_MAX) {
    const oldestKey = geometryCache.keys().next().value;
    geometryCache.get(oldestKey).dispose();
    geometryCache.delete(oldestKey);
  }
}

function evictGeometry(key) {
  geometryCache.get(key)?.dispose();
  geometryCache.delete(key);
}

async function loadDraco(tx, ty, z, layerId, signal, reload = false) {
  const key = tileKey(tx, ty, z);
  let geometry = reload ? null : geometryCache.get(key);

  if (geometry) {
    geometryCache.delete(key); // ownership transferred back to the live mesh
  } else {
    const cache = reload ? "reload" : "default";
    const url = `${API_BASE_URL}/tiles/tile.${tx}.${ty}.${z}.drc`;
    const res = await fetch(url, { signal, cache });
    if (!res.ok) throw new Error(`tile not found: ${url}`);
    const buffer = await res.arrayBuffer();
    // The dev server returns index.html (200) for missing files; a real DRACO
    // file starts with the magic string "DRACO". Reject anything else so the
    // decoder worker never sees an HTML blob ("Unexpected geometry type").
    if (
      buffer.byteLength < 5 ||
      new TextDecoder().decode(new Uint8Array(buffer, 0, 5)) !== "DRACO"
    ) {
      throw new Error(`not a DRACO file: ${url}`);
    }
    geometry = await new Promise((resolve, reject) =>
      _loader.parse(buffer, resolve, reject)
    );

    // Rotation, normals, and bbox are pure per-vertex/per-face array math
    // with no dependency on the live scene — offload them to a worker so a
    // burst of tile loads doesn't stall the render loop (see loadDraco perf
    // notes in tileManager.js's module doc).
    const posAttr = geometry.getAttribute("position");
    const idxAttr = geometry.getIndex();
    const { positions, normals, bbox } = await processGeometry(
      posAttr.array,
      idxAttr.array
    );
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(bbox[0], bbox[1], bbox[2]),
      new THREE.Vector3(bbox[3], bbox[4], bbox[5])
    );
  }

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    })
  );
  mesh.name = `tile-${tx}-${ty}-${z}`;
  mesh.position.copy(tileMeshOffset(tx, ty, z));

  await applyLayer(mesh, layerId, z);
  return mesh;
}

// Vegetation tiles are plain Draco crown meshes with the exact terrain-tile
// convention: vertices in km relative to the parent 1 km cell origin,
// x=east / y=north / z=altitude (see alpineview_ewoks/core/vegetation.py). Colors
// are baked per vertex at build time from IGN satellite imagery.

export async function loadVegetationTile(tx, ty, z) {
  const url = `${API_BASE_URL}/vegetation/tile.${tx}.${ty}.${z}.veg.drc`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`veg tile not found: ${url}`);
  const buffer = await res.arrayBuffer();
  if (
    buffer.byteLength < 5 ||
    new TextDecoder().decode(new Uint8Array(buffer, 0, 5)) !== "DRACO"
  ) {
    throw new Error(`not a DRACO file: ${url}`);
  }
  const geometry = await new Promise((resolve, reject) =>
    _loader.parse(buffer, resolve, reject)
  );
  const posAttr = geometry.getAttribute("position");
  const idxAttr = geometry.getIndex();
  const { positions, normals } = await processGeometry(posAttr.array, idxAttr.array);
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true })
  );
  mesh.name = `veg-${tx}-${ty}-${z}`;
  mesh.position.copy(tileMeshOffset(tx, ty, z));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export class TileManager {
  constructor(scene) {
    this._scene = scene;
    this._layer = "satellite";
    this._tiles = new Map(); // key → { mesh, placeholder, tx, ty, z }
    this._loading = new Set();
    this._abortControllers = new Map(); // key → AbortController for in-flight fetches
    this._needed = new Set(); // keys wanted as of the last tick
    this._reload = new Set(); // keys to refetch bypassing the HTTP cache
    this._lastTick = 0;
    this._lastSig = "";        // last logged tile-count signature
    this.TICK_MS = 500;
    this._heightSampler = (wx, wz) => this._sampleLoadedHeight(wx, wz);
    this._vegetationEnabled = false;
  }

  /**
   * Vegetation ships as /vegetation/tile.{tx}.{ty}.{z}.veg.drc on the same
   * web grid as the z=MAX_Z terrain tiles and follows their lifecycle
   * exactly: fetched when the tile enters the scene (if enabled), disposed
   * with it in _unload.
   */
  setVegetationEnabled(on) {
    this._vegetationEnabled = on;
    for (const [key, entry] of this._tiles) {
      if (on) this._loadVegetationFor(key, entry);
      else this._removeVegetation(entry);
    }
  }

  _loadVegetationFor(key, entry) {
    if (!this._vegetationEnabled || entry.placeholder || entry.z !== MAX_Z) return;
    if (entry.veg || entry.vegLoading || entry.vegEmpty) return;
    entry.vegLoading = true;
    loadVegetationTile(entry.tx, entry.ty, entry.z).then((mesh) => {
      entry.vegLoading = false;
      // Dropped meanwhile (toggle off / tile unloaded / reloaded)?
      if (!this._vegetationEnabled || this._tiles.get(key) !== entry) {
        mesh.geometry.dispose();
        mesh.material.dispose();
        return;
      }
      entry.veg = mesh;
      this._scene.add(mesh);
    }).catch(() => {
      entry.vegLoading = false;
      entry.vegEmpty = true; // missing veg tile: don't hammer the server
    });
  }

  _removeVegetation(entry) {
    if (!entry.veg) return;
    this._scene.remove(entry.veg);
    entry.veg.geometry.dispose();
    entry.veg.material.dispose();
    entry.veg = null;
    entry.vegEmpty = false; // retry on next enable
  }

  /**
   * Terrain height (scene y, km) at world (x, z) from any loaded real tile,
   * or null. Heightmaps are built lazily per tile (local coords) and dropped
   * with the entry on unload; used to drape placeholder quads over the
   * surrounding terrain.
   */
  getHeightAt(wx, wz) {
    return this._sampleLoadedHeight(wx, wz);
  }

  _sampleLoadedHeight(wx, wz) {
    for (const entry of this._tiles.values()) {
      if (entry.placeholder) continue;
      const { geometry, position } = entry.mesh;
      const box = geometry.boundingBox;
      const lx = wx - position.x, lz = wz - position.z;
      if (!box || lx < box.min.x || lx > box.max.x || lz < box.min.z || lz > box.max.z)
        continue;
      if (!entry.hmapData) {
        const pos = geometry.attributes.position;
        entry.hmapData = buildHeightmap(
          pos.array, pos.count, box.min.x, box.max.x, box.min.z, box.max.z,
        );
      }
      const h = sampleHeight(entry.hmapData, lx, lz);
      if (h != null) return h;
    }
    return null;
  }

  /**
   * Force a single tile to reload from the server, bypassing the browser cache
   * (debug: pick up a regenerated .drc / .cls.gz). Unloads it now; the next
   * update() tick re-fetches it if still needed.
   */
  reloadTile(tx, ty, z) {
    const key = tileKey(tx, ty, z);
    this._abortControllers.get(key)?.abort();
    const entry = this._tiles.get(key);
    if (entry) this._unload(key, entry);
    evictGeometry(key); // don't serve stale cached geometry for a forced reload
    this._reload.add(key);
  }

  setLayer(layerId) {
    this._layer = layerId;
    for (const [, entry] of this._tiles) {
      if (entry.placeholder) continue;
      applyLayer(entry.mesh, layerId, entry.z);
    }
  }

  refreshLayer() {
    this.setLayer(this._layer);
  }

  setSunDir(dir) {
    // Updates the uSunDir uniform on every currently-loaded tile material in
    // place — cheap, so no need to reapply/rebuild layers on a sun change.
    // Vegetation meshes are MeshStandardMaterial: the scene's sun light
    // (updateSunDirection) lights them, nothing to do here.
    setSunDirection(dir);
  }

  /**
   * Return the satellite canvas covering a 1km cell (x0, y0), stitched from
   * whatever terrain tiles are currently loaded for that cell (any LOD).
   * Returns null if no tiles are loaded yet.
   */
  getCellTextureData(x0, y0) {
    const worldXMin = x0, worldXMax = x0 + 1;
    const worldZMin = -(y0 + 1), worldZMax = -y0;

    const pieces = [];
    for (const [, entry] of this._tiles) {
      if (entry.placeholder) continue;
      const td = entry.mesh?.userData?.textureData;
      if (!td) continue;
      if (td.xMax <= worldXMin || td.xMin >= worldXMax) continue;
      if (td.zMax <= worldZMin || td.zMin >= worldZMax) continue;
      pieces.push(td);
    }

    if (pieces.length === 0) return null;

    // Single piece covering the full cell — return as-is
    if (pieces.length === 1) {
      const p = pieces[0];
      if (p.xMin <= worldXMin && p.xMax >= worldXMax &&
        p.zMin <= worldZMin && p.zMax >= worldZMax)
        return p;
    }

    // Stitch sub-tile canvases into one combined canvas covering the 1km cell.
    // Canvas pixel (0,0) = world (worldXMin, worldZMin) — top-left = NW corner.
    const worldW = worldXMax - worldXMin;
    const worldH = worldZMax - worldZMin;

    let maxPxPerKm = 0;
    for (const p of pieces) {
      const r = Math.max(
        p.canvas.width / (p.xMax - p.xMin),
        p.canvas.height / (p.zMax - p.zMin),
      );
      if (r > maxPxPerKm) maxPxPerKm = r;
    }

    const W = Math.round(worldW * maxPxPerKm);
    const H = Math.round(worldH * maxPxPerKm);
    const combined = document.createElement("canvas");
    combined.width = W;
    combined.height = H;
    const ctx = combined.getContext("2d");

    for (const p of pieces) {
      const dx = (p.xMin - worldXMin) / worldW * W;
      const dy = (p.zMin - worldZMin) / worldH * H;
      const dw = (p.xMax - p.xMin) / worldW * W;
      const dh = (p.zMax - p.zMin) / worldH * H;
      ctx.drawImage(p.canvas, dx, dy, dw, dh);
    }

    return { canvas: combined, xMin: worldXMin, xMax: worldXMax, zMin: worldZMin, zMax: worldZMax };
  }

  /** Call from the render loop — throttled internally. ctrl is the active camera controller. */
  update(camera, ctrl) {
    const now = performance.now();
    if (now - this._lastTick < this.TICK_MS) return;
    this._lastTick = now;

    const cx = camera.position.x;       // L93 km east
    const cy = -camera.position.z;      // L93 km north
    // Height above ground: use heightmap sample when available (same data as
    // walk-camera ground snap), otherwise fall back to raw camera Y.
    const groundH = ctrl?.getFloorHeight?.() ?? 0;
    const ch = Math.max(0, camera.position.y - groundH);

    // Walk the z=0 grid in range; descend the quadtree per cell by distance.
    // Subdivision uses 3D distance (includes altitude) so detail coarsens as
    // the camera climbs; the LOAD_RADIUS check below stays horizontal so tiles
    // don't disappear when flying high.
    const needed = new Set();
    // True if any of this cell's four children are currently loaded — i.e. the
    // cell is already subdivided. Used to apply collapse hysteresis.
    const isSubdivided = (tx, ty, z) => {
      for (let i = 0; i < 2; i++)
        for (let j = 0; j < 2; j++) {
          const k = tileKey(tx * 2 + i, ty * 2 + j, z + 1);
          if (this._tiles.has(k) || this._loading.has(k)) return true;
        }
      return false;
    };
    const addCell = (tx, ty, z) => {
      if (z < MAX_Z) {
        // Sticky threshold: harder to leave detail than to enter it.
        const margin = isSubdivided(tx, ty, z) ? DETAIL_HYSTERESIS : 1;
        if (tileDist(cx, cy, tx, ty, z, ch * ALTITUDE_LOD_WEIGHT) <= DETAIL_RADIUS[z] * margin) {
          for (let i = 0; i < 2; i++)
            for (let j = 0; j < 2; j++) addCell(tx * 2 + i, ty * 2 + j, z + 1);
          return;
        }
      }
      needed.add(tileKey(tx, ty, z));
    };
    const loadRadius = loadRadiusFor(ch);
    const r = Math.ceil(loadRadius);
    const tx0 = Math.floor(cx);
    const ty0 = Math.floor(cy);
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const X = tx0 + dx;
        const Y = ty0 + dy;
        if (tileDist(cx, cy, X, Y, 0) <= loadRadius) addCell(X, Y, 0);
      }
    }
    this._needed = needed;

    for (const key of this._loading) {
      if (!needed.has(key)) {
        this._abortControllers.get(key)?.abort();
      }
    }

    // Load missing — _load placeholders any tile that isn't a valid DRACO file
    for (const key of needed) {
      if (this._tiles.has(key) || this._loading.has(key)) continue;
      const [tx, ty, z] = key.split("|").map(Number);
      this._load(tx, ty, z);
    }

    // Unload anything no longer needed. For an LOD swap, keep the stale tile
    // until every replacement covering its footprint has resolved (real mesh
    // or placeholder) — avoids a visible gap mid-transition. Out-of-range
    // tiles have no covering replacement, so they unload immediately.
    for (const [key, entry] of this._tiles) {
      if (needed.has(key)) continue;
      if (this._replacementsReady(entry)) this._unload(key, entry);
    }

    const sig = `${this._tiles.size}|${this._loading.size}`;
    if (sig !== this._lastSig) {
      this._lastSig = sig;
      console.log(`[TileManager] meshes:${this._tiles.size} loading:${this._loading.size}`);
    }
  }

  _load(tx, ty, z) {
    const key = tileKey(tx, ty, z);
    this._loading.add(key);
    const controller = new AbortController();
    this._abortControllers.set(key, controller);
    const reload = this._reload.delete(key);

    // The placeholder joins the scene only once the outcome is known: as a
    // flattened backdrop behind the loaded mesh, or as the visible quad for a
    // missing tile. Never during loading — a .drc that exists must not flash.
    const ph = makePlaceholder(tx, ty, z);

    loadDraco(tx, ty, z, this._layer, controller.signal, reload).then((mesh) => {
      this._loading.delete(key);
      this._abortControllers.delete(key);
      if (!this._needed.has(key)) {
        cacheGeometry(key, mesh.geometry);
        disposeLayerMaterials(mesh);
        this._scene.remove(ph);
        ph.geometry.dispose();
        ph.material.map?.dispose();
        ph.material.dispose();
        return;
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this._scene.add(mesh);
      flattenPlaceholder(ph, (mesh.geometry.boundingBox?.min.y ?? 0) - 0.02);
      this._scene.add(ph);
      const entry = { mesh, ph, tx, ty, z };
      this._tiles.set(key, entry);
      this._loadVegetationFor(key, entry);
    }).catch((err) => {
      this._loading.delete(key);
      this._abortControllers.delete(key);
      if (err.name === "AbortError" || !this._needed.has(key)) {
        this._scene.remove(ph);
        ph.geometry.dispose();
        ph.material.map?.dispose();
        ph.material.dispose();
        return;
      }
      // Failed — the tile is missing: drape the quad over the neighbours and
      // show it as the tile itself.
      elevatePlaceholder(ph, tx, ty, z, this._heightSampler);
      this._scene.add(ph);
      this._tiles.set(key, { mesh: ph, ph: null, placeholder: true, tx, ty, z });
    });
  }

  /**
   * True once every needed tile overlapping this (no-longer-needed) tile's
   * footprint is present in the scene. A still-loading replacement returns
   * false, so the stale tile is kept one more tick.
   */
  _replacementsReady(entry) {
    for (const key of this._needed) {
      const [nx, ny, nz] = key.split("|").map(Number);
      if (!sameLineage(nx, ny, nz, entry.tx, entry.ty, entry.z)) continue;
      if (!this._tiles.has(key)) return false; // replacement still loading
    }
    return true;
  }

  _unload(key, entry) {
    this._removeVegetation(entry);
    this._scene.remove(entry.mesh);
    if (!entry.placeholder) cacheGeometry(key, entry.mesh.geometry);
    disposeLayerMaterials(entry.mesh);
    if (entry.ph) {
      this._scene.remove(entry.ph);
      entry.ph.geometry.dispose();
      entry.ph.material.map?.dispose();
      entry.ph.material.dispose();
    }
    this._tiles.delete(key);
  }
}
