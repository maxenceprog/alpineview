import geoConstants from "../../geo_constants.json";

const WMQ_EXTENT = geoConstants.wmq_extent.value;

const WMTS_SOURCES = {
  ortho: { layer: "ORTHOIMAGERY.ORTHOPHOTOS", format: "image%2Fjpeg" },
  plan: { layer: "GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", format: "image%2Fpng" },
};

export const tileUrl = (sourceKey, x, y, z) => {
  if (sourceKey === "opentopomap") return `https://a.tile.opentopomap.org/${z}/${x}/${y}.png`;
  const { layer, format } = WMTS_SOURCES[sourceKey];
  return `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=${layer}&STYLE=normal&FORMAT=${format}` +
    `&TILEMATRIXSET=PM_0_19&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`;
};

export function mercBounds(z, x, y) {
  const s = (2 * WMQ_EXTENT) / 2 ** z;
  const x0 = -WMQ_EXTENT + x * s;
  const y1 = WMQ_EXTENT - y * s;
  return { x0, y0: y1 - s, s };
}

/** Inverse of mercBounds: the tile at zoom z containing merc point (mx, my). */
export function mercTileAt(z, mx, my) {
  const s = (2 * WMQ_EXTENT) / 2 ** z;
  return { x: Math.floor((mx + WMQ_EXTENT) / s), y: Math.floor((WMQ_EXTENT - my) / s) };
}

export const WMTS_SOURCE_MAX_ZOOM_ORTHO = 18;
export const WMTS_SOURCE_MAX_ZOOM = 17;

/** The source tile actually fetched for (x, y, z): one level coarser, so it serves 4+ terrain tiles. */
export function effectiveTile(sourceKey, x, y, z) {
  const wmts_max_zoom = (sourceKey == "ortho") ? WMTS_SOURCE_MAX_ZOOM_ORTHO : WMTS_SOURCE_MAX_ZOOM;
  const eff_z = Math.min(z - 1, wmts_max_zoom);
  const scale = 2 ** (z - eff_z);
  return { z: eff_z, x: Math.floor(x / scale), y: Math.floor(y / scale) };
}
