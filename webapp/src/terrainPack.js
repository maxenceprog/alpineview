import * as THREE from "three";
import geoConstants from "../../geo_constants.json";
import { API_BASE_URL } from "./apiConfig.js";
import { noteTileMs } from "./automaticSseThreshold.js";
import pack from "./terrainPack.json";

const LOD_LOCAL_LEVEL = geoConstants.lod_level0.value - geoConstants.cell_level.value;

export const TILESET_URL = `${API_BASE_URL}/pm/tileset.json`;

const TERRAIN_BASE = new URL(TILESET_URL.replace(/\/[^/]*$/, "/"), window.location.href).toString();

/**
 * Every cell's transform is already a plain translation in the same
 * lat_ref-scaled Mercator "work" frame the builder reconstructs in — see
 * ogc3d_tiler/build_tileset.py. The only thing left to do here is shift the
 * whole tileset to sit near a small local origin (the root bounding volume's
 * own centre) so the GPU-side float32 render path stays precise close to the
 * camera; there is no CRS conversion happening.
 */
export const localToWork = new THREE.Matrix4();
export const localOrigin = new THREE.Vector3();

function localizeTileset(tileset) {
  const [cx, cy, cz] = tileset.root.boundingVolume.sphere;
  localOrigin.set(cx, cy, cz);
  localToWork.makeTranslation(cx, cy, cz);

  const toLocal = new THREE.Matrix4().copy(localToWork).invert();
  tileset.root.transform = toLocal.toArray();
  return tileset;
}

localizeTileset(pack.tileset);

function toArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}


export const terrainPackPlugin = {
  name: "terrain-pack",
  fetchData(url, options) {
    if (url === TILESET_URL) {
      return Promise.resolve(pack.tileset);
    }

    if (!url.startsWith(TERRAIN_BASE)) {
      return null;
    }

    const path = url.slice(TERRAIN_BASE.length);

    const subtree = pack.subtrees[path];
    if (subtree) {
      return Promise.resolve(toArrayBuffer(subtree));
    }

    const hdSubtree = hdSubtreeBuffer(path);
    if (hdSubtree) {
      return Promise.resolve(hdSubtree);
    }

    if (!url.endsWith(".glb")) {
      return null;
    }

    // Monkey patch: downloadQueue frees its concurrency slot as soon as fetch()'s promise
    // resolves, i.e. once headers arrive -- it never sees body-read time. On
    // a throttled connection that lets far more than maxJobs bodies stream at
    // once, starving each other. Reading the body here, before resolving,
    // makes the slot correctly stay held for the full download.
    const startedAt = performance.now();
    return fetch(url, options).then(async (res) => {
      if (!res.ok) {
        return res;
      }

      const buffer = await res.arrayBuffer();
      noteTileMs(performance.now() - startedAt);
      return new Response(buffer, { status: res.status, statusText: res.statusText });
    });
  },
};

// Absolute WebMercatorQuad level pack.hdLevel tile indices of every built HD
// tile -- the real (non-square) LiDAR HD footprint, finer-grained than a
// cell's availableLevels flag. See ogc3d_tiler/build_tileset.py.
export function hdLevelTiles() {
  return {
    level: pack.hdLevel,
    x: new Uint16Array(toArrayBuffer(pack.x15)),
    y: new Uint16Array(toArrayBuffer(pack.y15)),
    maxLevel: new Uint8Array(toArrayBuffer(pack.maxLevel15)),
    zHi: new Uint16Array(toArrayBuffer(pack.zHi15)),
  };
}

let hdTileByKey = null;

function hdTileIndex() {
  if (!hdTileByKey) {
    const { x, y, maxLevel, zHi } = hdLevelTiles();
    hdTileByKey = new Map();
    for (let i = 0; i < x.length; i++) {
      hdTileByKey.set(x[i] * 65536 + y[i], { maxLevel: maxLevel[i], zHi: zHi[i] });
    }
  }
  return hdTileByKey;
}

let hdSubtreeBuffers = null;
let leafSubtreeBuffer = null;

const LEAF_TIER_LEVEL = LOD_LOCAL_LEVEL + LOD_LOCAL_LEVEL;

const SUBTREE_PATH_RE = /^(\d+)\.(\d+)\/subtrees\/(\d+)\.(\d+)\.(\d+)\.subtree$/;

function hdSubtreeBuffer(path) {
  const m = SUBTREE_PATH_RE.exec(path);
  if (!m) {
    return null;
  }
  const [, cx, cy, level, x, y] = m.map(Number);

  if (level === LOD_LOCAL_LEVEL) {
    const n = 1 << LOD_LOCAL_LEVEL;
    const tile = hdTileIndex().get((cx * n + x) * 65536 + (cy * n + y));
    if (!tile) {
      return null;
    }

    if (!hdSubtreeBuffers) {
      hdSubtreeBuffers = pack.hdSubtreeBlobs.map(toArrayBuffer);
    }
    return hdSubtreeBuffers[tile.maxLevel - pack.hdLevel];
  }

  if (level === LEAF_TIER_LEVEL) {
    const n = 1 << LEAF_TIER_LEVEL;
    const ancestorShift = LOD_LOCAL_LEVEL;
    const gx = (cx * n + x) >> ancestorShift;
    const gy = (cy * n + y) >> ancestorShift;
    const tile = hdTileIndex().get(gx * 65536 + gy);
    if (!tile || tile.maxLevel - pack.hdLevel !== pack.hdSubtreeBlobs.length - 1) {
      return null;
    }

    if (!leafSubtreeBuffer) {
      leafSubtreeBuffer = toArrayBuffer(pack.leafSubtreeBlob);
    }
    return leafSubtreeBuffer;
  }

  return null;
}

export const terrainZBoundsPlugin = {
  name: "terrain-z-bounds",
  preprocessNode(tile) {
    const data = tile.implicitTilingData;
    const box = tile.boundingVolume?.box;
    if (!data || !box || data.level < LOD_LOCAL_LEVEL) {
      return;
    }

    const cellName = data.root.content.uri.split("/")[0];
    const [cx, cy] = cellName.split(".").map(Number);
    const shift = data.level - LOD_LOCAL_LEVEL;
    const gx = cx * (1 << LOD_LOCAL_LEVEL) + (data.x >> shift);
    const gy = cy * (1 << LOD_LOCAL_LEVEL) + (data.y >> shift);

    const hdTile = hdTileIndex().get(gx * 65536 + gy);
    if (!hdTile) {
      return;
    }

    const loZ = box[2] - box[11];
    box[11] = (hdTile.zHi - loZ) / 2;
    box[2] = loZ + box[11];
  },
};

export function cellLevels() {
  const levels = new Map();

  for (const child of pack.tileset.root.children) {
    const name = child.content?.uri?.split("/")[0];

    if (name) {
      levels.set(name, child.implicitTiling?.availableLevels ?? 0);
    }
  }

  return levels;
}
