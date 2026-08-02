import * as THREE from "three";
import { API_BASE_URL } from "./apiConfig.js";
import pack from "./terrainPack.json";

export const TILESET_URL = `${API_BASE_URL}/wm/terrain/tileset.json`;

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
  fetchData(url) {
    if (url === TILESET_URL) {
      return Promise.resolve(pack.tileset);
    }

    if (!url.startsWith(TERRAIN_BASE)) {
      return null;
    }

    const subtree = pack.subtrees[url.slice(TERRAIN_BASE.length)];

    return subtree ? Promise.resolve(toArrayBuffer(subtree)) : null;
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
