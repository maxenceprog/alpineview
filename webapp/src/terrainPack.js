import * as THREE from "three";
import { API_BASE_URL } from "./apiConfig.js";
import pack from "./terrainPack.json";

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

    const subtree = pack.subtrees[url.slice(TERRAIN_BASE.length)];
    if (subtree) {
      return Promise.resolve(toArrayBuffer(subtree));
    }

    if (!url.endsWith(".glb")) {
      return null;
    }

    // downloadQueue frees its concurrency slot as soon as fetch()'s promise
    // resolves, i.e. once headers arrive -- it never sees body-read time. On
    // a throttled connection that lets far more than maxJobs bodies stream at
    // once, starving each other. Reading the body here, before resolving,
    // makes the slot correctly stay held for the full download.
    return fetch(url, options).then(async (res) => {
      if (!res.ok) {
        return res;
      }

      const buffer = await res.arrayBuffer();
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
  };
}

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
