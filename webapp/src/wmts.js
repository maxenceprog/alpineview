import { IS_MOBILE } from "./deviceInfo.js";
import geoConstants from "../../geo_constants.json";

const WMQ_EXTENT = geoConstants.wmq_extent.value;

const WMTS_SOURCES = {
  ortho: { layer: "ORTHOIMAGERY.ORTHOPHOTOS", format: "image%2Fjpeg" },
  plan: { layer: "GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", format: "image%2Fpng" },
};

const tileUrl = (sourceKey, x, y, z) => {
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

let currentMapSource = "ortho";

export function setMapSource(sourceKey) {
  currentMapSource = sourceKey;
}

const IMAGE_TIMEOUT_MS = 10_000;
const IMAGE_CACHE_MAX = IS_MOBILE ? 200 : 800;
const _imageCache = new Map();

async function fetchTile(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load tile: ${url} (${res.status})`);
  // three.js can't apply texture.flipY to an ImageBitmap at upload time (the
  // WebGL spec doesn't allow flipping one post-creation), so the UVs baked
  // against a flipY=true convention (v=0 at the tile's south edge) need the
  // flip done here instead, at bitmap creation.
  return createImageBitmap(await res.blob(), { imageOrientation: "flipY" });
}

function loadImage(url) {
  const cached = _imageCache.get(url);
  if (cached) {
    _imageCache.delete(url);
    _imageCache.set(url, cached);
    return cached;
  }

  const promise = fetchTile(url)
    .catch((err) => { _imageCache.delete(url); throw err; });

  _imageCache.set(url, promise);
  if (_imageCache.size > IMAGE_CACHE_MAX) {
    _imageCache.delete(_imageCache.keys().next().value);
  }
  return promise;
}

export function fetchWmtsTile(x, y, z, sourceKey = currentMapSource) {
  return loadImage(tileUrl(sourceKey, x, y, z));
}
