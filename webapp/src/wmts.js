import { IS_MOBILE } from "./deviceInfo.js";

// The "2154_10cm_*" matrix sets share one ladder: 256 px tiles resolving 10 cm at zoom
// 21, doubling every zoom up, off a common TopLeftCorner. Values below are from the
// service's GetCapabilities; the ladder is exact, so no scale denominators are needed.
const L93_ORIGIN_X = 0;
const L93_ORIGIN_Y = 12_000_000;
const TILE_PX = 256;
const FINEST_ZOOM = 21;
const FINEST_RESOLUTION_M = 0.1;

const resolutionM = (zoom) => FINEST_RESOLUTION_M * 2 ** (FINEST_ZOOM - zoom);
const tileSizeM = (zoom) => TILE_PX * resolutionM(zoom);

// Texture pixels we aim to drape across one tile, whatever its ground size.
const TARGET_TEXTURE_PX = IS_MOBILE ? 128 : 256;

// zoom = the levels each set publishes (its TileMatrixLimits); the ortho stops short at 10.
// bbox = the layer's data coverage in L93 metres, from its GetCapabilities WGS84BoundingBox.
// The matrix is wider than the data (z7 has 4 columns, the plan layer fills 3), so tiles
// outside this box 404 — checked against every published TileMatrixLimits, the box
// reproduces them exactly, which is why it can stand in for parsing 15 of them.
const WMTS_SOURCES = {
  ortho: {
    layer: "HR.ORTHOIMAGERY.ORTHOPHOTOS.L93",
    matrixSet: "2154_10cm_10_20",
    zoom: { min: 10, max: 20 },
    bbox: { west: 14410, east: 1300132, south: 5877034, north: 7239966 },
  },
  plan: {
    layer: "GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2.L93",
    matrixSet: "2154_10cm_6_20",
    zoom: { min: 6, max: 20 },
    bbox: { west: 17559, east: 1250051, south: 6025045, north: 7139915 },
  },
};

// Coarsest zoom still giving TARGET_TEXTURE_PX across a tile of sizeM metres.
const zoomForSize = (sizeM) =>
  Math.round(FINEST_ZOOM - Math.log2(sizeM / (FINEST_RESOLUTION_M * TARGET_TEXTURE_PX)));

// Does tile (col, row) of tileSizeM `s` overlap the layer's data at all?
function coversData(sourceKey, col, row, s) {
  const { bbox } = WMTS_SOURCES[sourceKey];
  const west = L93_ORIGIN_X + col * s;
  const north = L93_ORIGIN_Y - row * s;
  return west < bbox.east && west + s > bbox.west
    && north > bbox.south && north - s < bbox.north;
}

const tileUrl = (sourceKey, col, row, zoom) =>
  `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
  `&LAYER=${WMTS_SOURCES[sourceKey].layer}&STYLE=normal&FORMAT=image%2Fjpeg` +
  `&TILEMATRIXSET=${WMTS_SOURCES[sourceKey].matrixSet}` +
  `&TILEMATRIX=${zoom}&TILEROW=${row}&TILECOL=${col}`;

let currentMapSource = "ortho";

export function setMapSource(sourceKey) {
  currentMapSource = sourceKey;
}

const IMAGE_TIMEOUT_MS = 10_000;
const IMAGE_CACHE_MAX = IS_MOBILE ? 200 : 800;
const _imageCache = new Map();

function loadImage(url) {
  const cached = _imageCache.get(url);
  if (cached) {
    _imageCache.delete(url);
    _imageCache.set(url, cached);
    return cached;
  }

  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(
      () => reject(new Error(`Timeout loading tile: ${url}`)),
      IMAGE_TIMEOUT_MS,
    );
    img.crossOrigin = "anonymous";
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error(`Failed to load tile: ${url}`)); };
    img.src = url;
  }).catch((err) => { _imageCache.delete(url); throw err; });

  _imageCache.set(url, promise);
  if (_imageCache.size > IMAGE_CACHE_MAX) {
    _imageCache.delete(_imageCache.keys().next().value);
  }
  return promise;
}

/**
 * Quadtree levels whose derived zoom the matrix set publishes, given the root tile size.
 * Outside this range the zoom would clamp, and a clamped-coarse zoom means stitching a
 * tile out of hundreds.
 */
export function wmtsLevelRange(sourceKey, rootSizeM) {
  const { zoom } = WMTS_SOURCES[sourceKey];
  const levels = [];
  for (let level = 0; level <= 20; level++) {
    const z = zoomForSize(rootSizeM / 2 ** level);
    if (z >= zoom.min && z <= zoom.max) levels.push(level);
  }
  return { min: levels[0], max: levels[levels.length - 1] };
}

/**
 * The one way to get IGN imagery. Returns a canvas covering exactly the given L93 extent
 * (metres, x=east/y=north), stitched from the WMTS tiles overlapping it at a zoom picked
 * from the extent's size. Tiles are drawn at their true offset and clipped to the extent,
 * so callers map UVs straight against the extent they asked for.
 */
export async function fetchWmtsCanvas(
  { west, east, south, north },
  sourceKey = currentMapSource,
) {
  const { zoom } = WMTS_SOURCES[sourceKey];
  const z = Math.min(Math.max(zoomForSize(east - west), zoom.min), zoom.max);
  const s = tileSizeM(z);
  const mPerPx = resolutionM(z);

  const colMin = Math.floor((west - L93_ORIGIN_X) / s);
  const colMax = Math.floor((east - L93_ORIGIN_X) / s);
  const rowMin = Math.floor((L93_ORIGIN_Y - north) / s);
  const rowMax = Math.floor((L93_ORIGIN_Y - south) / s);

  const canvas = document.createElement("canvas");
  canvas.width = Math.round((east - west) / mPerPx);
  canvas.height = Math.round((north - south) / mPerPx);
  const ctx = canvas.getContext("2d");

  const fetches = [];
  for (let r = rowMin; r <= rowMax; r++)
    for (let c = colMin; c <= colMax; c++) {
      if (!coversData(sourceKey, c, r, s)) continue;
      fetches.push(loadImage(tileUrl(sourceKey, c, r, z)).then((img) => ({
        img,
        x: (L93_ORIGIN_X + c * s - west) / mPerPx,
        y: (north - (L93_ORIGIN_Y - r * s)) / mPerPx,
      })));
    }

  // One unreachable tile leaves its patch blank rather than failing the whole extent.
  for (const res of await Promise.allSettled(fetches))
    if (res.status === "fulfilled")
      ctx.drawImage(res.value.img, res.value.x, res.value.y, TILE_PX, TILE_PX);

  return canvas;
}
