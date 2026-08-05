import { IS_MOBILE } from "./deviceInfo.js";
import geoConstants from "../../geo_constants.json";

const WMQ_EXTENT = geoConstants.wmq_extent.value;

const WMTS_SOURCES = {
  ortho: { layer: "ORTHOIMAGERY.ORTHOPHOTOS", format: "image%2Fjpeg" },
  plan: { layer: "GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", format: "image%2Fpng" },
};

const tileUrl = (sourceKey, x, y, z) => {
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

let currentMapSource = "ortho";

export function setMapSource(sourceKey) {
  currentMapSource = sourceKey;
  _rawCache.clear();
  _rawResolved.clear();
}

const IMAGE_TIMEOUT_MS = 10_000;
const IMAGE_CACHE_MAX = IS_MOBILE ? 200 : 800;

const _rawCache = new Map();
const _rawResolved = new Map();

function fetchRaw(url) {
  const cached = _rawCache.get(url);
  if (cached) {
    _rawCache.delete(url);
    _rawCache.set(url, cached);
    return cached;
  }

  const promise = (async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to load tile: ${url} (${res.status})`);
    return createImageBitmap(await res.blob());
  })();

  promise.then((bitmap) => _rawResolved.set(url, bitmap))
    .catch(() => { _rawCache.delete(url); _rawResolved.delete(url); });

  _rawCache.set(url, promise);
  if (_rawCache.size > IMAGE_CACHE_MAX) {
    const oldest = _rawCache.keys().next().value;
    _rawCache.delete(oldest);
    _rawResolved.delete(oldest);
  }
  return promise;
}

function cropTile(raw, ox, oy, scale) {
  if (!raw) return Promise.resolve(null);
  if (scale === 1) return createImageBitmap(raw, { imageOrientation: "flipY" });
  const s = raw.width / scale;
  return createImageBitmap(raw, ox * s, oy * s, s, s, { imageOrientation: "flipY" });
}

let _blankBitmapPromise = null;

function blankBitmap() {
  if (!_blankBitmapPromise) {
    const canvas = new OffscreenCanvas(1, 1);
    canvas.getContext("2d").fillRect(0, 0, 1, 1);
    _blankBitmapPromise = createImageBitmap(canvas);
  }
  return _blankBitmapPromise;
}

const MAX_ZOOM = 17;

function effectiveTile(sourceKey, x, y, z) {
  if (z > MAX_ZOOM) {
    const scale = 2 ** (z - MAX_ZOOM);
    return { z: MAX_ZOOM, x: Math.floor(x / scale), y: Math.floor(y / scale) };
  }
  return { z, x, y };
}

export function fetchWmtsTile(x, y, z, sourceKey = currentMapSource) {
  if (sourceKey === "none") return blankBitmap();
  const eff = effectiveTile(sourceKey, x, y, z);
  const scale = 2 ** (z - eff.z);
  const url = tileUrl(sourceKey, eff.x, eff.y, eff.z);
  return fetchRaw(url).then((raw) => cropTile(raw, x - eff.x * scale, y - eff.y * scale, scale));
}

const PLACEHOLDER_MAX_LEVELS = 6;

export function peekPlaceholderTile(x, y, z, sourceKey = currentMapSource) {
  if (sourceKey === "none") return null;
  for (let dz = 1; dz <= Math.min(PLACEHOLDER_MAX_LEVELS, z); dz++) {
    const az = z - dz;
    const eff = effectiveTile(sourceKey, x >> dz, y >> dz, az);
    const raw = _rawResolved.get(tileUrl(sourceKey, eff.x, eff.y, eff.z));
    if (!raw) continue;
    const scale = 2 ** (z - eff.z);
    return cropTile(raw, x - eff.x * scale, y - eff.y * scale, scale);
  }
  return null;
}
