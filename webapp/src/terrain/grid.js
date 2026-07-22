import * as itowns from "itowns";
import * as THREE from "three";
import { fetchWmtsCanvas } from "../wmts.js";

export const DRACO_BASE_LEVEL = 10;
export const DRACO_MAX_ZOOM = 2;
export const DRACO_MIN_ZOOM = -2;

export const CRS = "EPSG:2154";

const _extent = new itowns.Extent(CRS, 0, 0, 0, 0);

export function tileKey(tile) {
  const zoom = tile.zoom - DRACO_BASE_LEVEL;
  const scale = 2 ** zoom;
  const extent = tile.isExtent ? tile : tile.toExtent(CRS, _extent);
  const tx = Math.round((extent.west / 1000) * scale);
  const ty = Math.round((extent.south / 1000) * scale);
  return { tx, ty, zoom, ox: Math.floor(tx / scale), oy: Math.floor(ty / scale) };
}

export const cacheKey = ({ tx, ty, zoom }) => `${tx}.${ty}.${zoom}`;

export const tileSize = (zoom) => 2 ** -zoom * 1000;

export function tileExtent({ tx, ty, zoom }) {
  const s = tileSize(zoom);
  return { west: tx * s, east: (tx + 1) * s, south: ty * s, north: (ty + 1) * s };
}

function bakeUVs(geometry, ox, oy, { west, east, south, north }) {
  const pos = geometry.attributes.position.array;
  const count = pos.length / 3;
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    uvs[i * 2] = ((ox + pos[i * 3]) * 1000 - west) / (east - west);
    uvs[i * 2 + 1] = (north - (oy + pos[i * 3 + 1]) * 1000) / (north - south);
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
}

export async function loadTileTexture(geometry, key) {
  const extent = tileExtent(key);
  const canvas = await fetchWmtsCanvas(extent);
  bakeUVs(geometry, key.ox, key.oy, extent);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  return texture;
}
