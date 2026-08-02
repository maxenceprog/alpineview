import geoConstants from "../../geo_constants.json";
import { cellLevels } from "./terrainPack.js";

export const CELL_LEVEL = geoConstants.cell_level.value;

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
