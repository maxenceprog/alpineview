// True Web Mercator (EPSG:3857, what WMTS/Camptocamp speak) <-> the scene's
// local frame (the lat_ref-scaled "work" frame the terrain is meshed in,
// shifted by localOrigin -- see terrainPack.js).
import geoConstants from "../../geo_constants.json";
import { localOrigin } from "./terrainPack.js";

export const WORK_TO_MERC = 1 / Math.cos((geoConstants.lat_ref.value * Math.PI) / 180);

export function mercToLocal([mx, my]) {
  return [mx / WORK_TO_MERC - localOrigin.x, my / WORK_TO_MERC - localOrigin.y];
}

export function localToMerc(x, y) {
  return [(x + localOrigin.x) * WORK_TO_MERC, (y + localOrigin.y) * WORK_TO_MERC];
}
