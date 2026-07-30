import { cellLevels } from "./terrainPack.js";

export const CELL_KM = 16;

const HD_LEVEL = 7;

export async function loadTilesetCoverage() {
  const cells = new Set();

  for (const [name, levels] of cellLevels()) {
    if (/^-?\d+\.-?\d+$/.test(name) && levels > HD_LEVEL) {
      cells.add(name);
    }
  }

  return cells.size ? cells : null;
}
