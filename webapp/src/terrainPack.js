import { API_BASE_URL } from "./apiConfig.js";
import pack from "./terrainPack.json";

export const TILESET_URL = `${API_BASE_URL}/terrain/tileset.json`;

const TERRAIN_BASE = new URL(TILESET_URL.replace(/\/[^/]*$/, "/"), window.location.href).toString();

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
