import { API_BASE_URL } from "./apiConfig.js";

export const TILESET_URL = `${API_BASE_URL}/terrain/tileset.json`;

export const CELL_KM = 16;

const HD_LEVEL = 7;

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function isHdCell(baseUrl, name) {
  const tileset = await fetchJson(`${baseUrl}/${name}/tileset.json`);
  const levels = tileset?.root?.implicitTiling?.availableLevels ?? 0;
  return levels > HD_LEVEL;
}

export async function loadTilesetCoverage(url = TILESET_URL) {
  const root = await fetchJson(url);
  const children = root?.root?.children;
  if (!Array.isArray(children)) return null;

  const baseUrl = url.replace(/\/[^/]*$/, "");
  const names = children
    .map((child) => child.content?.uri?.split("/")[0])
    .filter((name) => /^-?\d+\.-?\d+$/.test(name ?? ""));

  const hd = await Promise.all(names.map((name) => isHdCell(baseUrl, name)));

  const cells = new Set(names.filter((_, i) => hd[i]));
  return cells.size ? cells : null;
}
