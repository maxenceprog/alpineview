import * as THREE from "three";

import { IS_MOBILE } from "./deviceInfo.js";
import { currentTraces, paintTraces } from "./gpxPainter.js";
import { effectiveTile, tileUrl } from "./wmts.js";

const CACHE_MAX = IS_MOBILE ? 200 : 800;
const FETCH_TIMEOUT_MS = 10_000;
const PLACEHOLDER_MAX_LEVELS = 6;

let currentSource = "ortho";
const cache = new Map();

function buildTexture(bitmap) {
  const texture = new THREE.Texture(bitmap);
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

async function load(entry, url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Failed to load tile: ${url} (${res.status})`);
  entry.bitmap = await createImageBitmap(await res.blob(), { imageOrientation: "flipY" });
  entry.texture = buildTexture(await paintTraces(entry.bitmap, entry.key));
  return entry.texture;
}

function entryFor(sourceKey, key) {
  const url = tileUrl(sourceKey, key.x, key.y, key.z);
  const hit = cache.get(url);
  if (hit) {
    cache.delete(url);
    cache.set(url, hit);
    return hit;
  }

  const entry = { key, bitmap: null, texture: null };
  entry.promise = load(entry, url);
  entry.promise.catch(() => cache.delete(url));
  cache.set(url, entry);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return entry;
}

export function setMapSource(sourceKey) {
  currentSource = sourceKey;
  cache.clear();
}

/** The source subsequent fetches use, to detect a switch across an await. */
export const currentMapSource = () => currentSource;

/**
 * The shared texture covering (x, y, z), plus the WMTS key it actually spans —
 * one source tile serves 4, 16 or 64 terrain tiles, so callers bake their UVs
 * against `key`, not against the tile they asked for.
 */
export function wmtsTexture(x, y, z, sourceKey = currentSource) {
  if (sourceKey === "none") return null;
  const key = effectiveTile(sourceKey, x, y, z);
  return { key, texture: entryFor(sourceKey, key).promise };
}

/** The nearest already-loaded ancestor texture, for use until the real one arrives. */
export function peekWmtsTexture(x, y, z, sourceKey = currentSource) {
  if (sourceKey === "none") return null;
  for (let dz = 1; dz <= Math.min(PLACEHOLDER_MAX_LEVELS, z); dz++) {
    const key = effectiveTile(sourceKey, x >> dz, y >> dz, z - dz);
    const entry = cache.get(tileUrl(sourceKey, key.x, key.y, key.z));
    if (entry?.texture) return { key, texture: entry.texture };
  }
  return null;
}

/** Repaints every cached texture in place, so meshes pick the traces up without re-draping. */
export async function repaintTraces() {
  const traces = currentTraces();
  await Promise.all([...cache.values()].map(async (entry) => {
    const texture = await entry.promise.catch(() => null);
    if (!texture) return;
    const image = await paintTraces(entry.bitmap, entry.key);
    if (currentTraces() !== traces) return;
    texture.image = image;
    texture.needsUpdate = true;
  }));
}