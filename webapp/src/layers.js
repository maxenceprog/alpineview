import * as THREE from "three";
import {
  buildCosiaMaterial,
  isSatelliteColors,
  loadCosiaRgbTexture,
  loadCosiaTexture,
} from "./cosia.js";
import { getSunDirection, registerLitMaterial, unregisterLitMaterial } from "./sunLighting.js";

const L93_ORIGIN_X = 0;
const L93_ORIGIN_Y = 12_000_000;
const L93_TILE_SIZE_M = {
  14: 256 * 45714.2857 * 0.00028,
  15: 256 * 22857.1429 * 0.00028,
  16: 256 * 11428.5714 * 0.00028,
  17: 256 *  5714.2857 * 0.00028,
  18: 256 *  2857.1429 * 0.00028,
  19: 256 *  1428.5714 * 0.00028,
};
// LOD0 (1km, farthest/coarsest tiles) uses one WMTS zoom level less than its
// terrain LOD would suggest — full 10cm imagery isn't needed at that
// distance, and it's fewer/larger-coverage tiles to fetch (faster, lighter).
export const WMTS_ZOOM_FOR_LOD = [16, 18, 19];

const ignOrthoUrl = (col, row, level) =>
  `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
  `&LAYER=HR.ORTHOIMAGERY.ORTHOPHOTOS.L93&STYLE=normal&FORMAT=image%2Fjpeg` +
  `&TILEMATRIXSET=2154_10cm_10_20&TILEMATRIX=${level}&TILEROW=${row}&TILECOL=${col}`;

export const LAYER_OPTIONS = [
  { id: "satellite", label: "Satellite" },
  { id: "cosia",     label: "COSIA" },
];

// ---------------------------------------------------------------------------
// Tile fetching
// ---------------------------------------------------------------------------
const IMAGE_TIMEOUT_MS = 10_000;

// In-memory cache of loaded orthophoto tiles, keyed by URL. The server does
// send a cacheable Cache-Control, but relying on the browser's HTTP cache
// alone still costs a disk-cache lookup per request and doesn't dedupe two
// concurrent loads of the same tile (e.g. two meshes needing it at once) —
// this makes a repeat/duplicate load genuinely free within the session.
const _imageCache = new Map(); // url -> Promise<HTMLImageElement>

function loadImage(url) {
  const cached = _imageCache.get(url);
  if (cached) return cached;

  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(
      () => reject(new Error(`Timeout loading tile: ${url}`)),
      IMAGE_TIMEOUT_MS,
    );
    img.crossOrigin = "anonymous";
    img.onload  = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error(`Failed to load tile: ${url}`)); };
    img.src = url;
  }).catch((err) => { _imageCache.delete(url); throw err; }); // don't cache failures

  _imageCache.set(url, promise);
  return promise;
}

export async function buildCanvas(worldMinX, worldMaxX, worldMinZ, worldMaxZ, level) {
  const s = L93_TILE_SIZE_M[level];
  const x0 = worldMinX * 1000, x1 = worldMaxX * 1000;
  const y0 = -worldMaxZ * 1000, y1 = -worldMinZ * 1000;

  const colMin = Math.floor((x0 - L93_ORIGIN_X) / s);
  const colMax = Math.floor((x1 - L93_ORIGIN_X) / s);
  const rowMin = Math.floor((L93_ORIGIN_Y - y1) / s);
  const rowMax = Math.floor((L93_ORIGIN_Y - y0) / s);

  const canvas = document.createElement("canvas");
  canvas.width  = (colMax - colMin + 1) * 256;
  canvas.height = (rowMax - rowMin + 1) * 256;
  const ctx = canvas.getContext("2d");

  const fetches = [];
  for (let r = rowMin; r <= rowMax; r++)
    for (let c = colMin; c <= colMax; c++)
      fetches.push(loadImage(ignOrthoUrl(c, r, level)).then(img => ({ img, col: c - colMin, row: r - rowMin })));

  for (const { img, col, row } of await Promise.all(fetches))
    ctx.drawImage(img, col * 256, row * 256, 256, 256);

  return {
    canvas,
    xMin: (L93_ORIGIN_X + colMin * s) / 1000,
    xMax: (L93_ORIGIN_X + (colMax + 1) * s) / 1000,
    zMin: -(L93_ORIGIN_Y - rowMin * s) / 1000,
    zMax: -(L93_ORIGIN_Y - (rowMax + 1) * s) / 1000,
  };
}

// Shared draw config: front-facing with a polygon offset so the draped texture
// doesn't z-fight the terrain. Spread into each tile material.
const TILE_DRAW = {
  side: THREE.FrontSide,
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
};

// ---------------------------------------------------------------------------
// Vertical-diffuse material — texture * max(0, worldNormal.y), ignores scene lights
// ---------------------------------------------------------------------------

let currentBrightness = 1.0;
const verticalDiffuseMaterials = new Set();

export function setBrightness(value) {
  currentBrightness = value;
  for (const mat of verticalDiffuseMaterials) mat.uniforms.uBrightness.value = value;
}

export function getBrightness() {
  return currentBrightness;
}

function buildVerticalDiffuseMaterial(texture) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsLib.fog,
      ...THREE.UniformsLib.lights,
      map: { value: texture },
      uBrightness: { value: currentBrightness },
      uSunDir: { value: getSunDirection().clone() },
    },
    vertexShader: `
      #include <common>
      #include <shadowmap_pars_vertex>
      #include <fog_pars_vertex>
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      void main() {
        vUv = uv;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vec3 transformed = position;
        vec3 transformedNormal = normalize(normalMatrix * normal);
        vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <worldpos_vertex>
        #include <shadowmap_vertex>
        #include <fog_vertex>
      }
    `,
    fragmentShader: `
      #include <common>
      #include <packing>
      #include <shadowmap_pars_fragment>
      #include <fog_pars_fragment>
      uniform sampler2D map;
      uniform float uBrightness;
      uniform vec3 uSunDir;
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      void main() {
        vec4 c = texture2D(map, vUv);
        float ambient = 0.15;
        float direct = 0.85 * max(0.0, dot(vWorldNormal, uSunDir));
        #if NUM_DIR_LIGHT_SHADOWS > 0
          direct *= getShadow(directionalShadowMap[0], directionalLightShadows[0].shadowMapSize,
            directionalLightShadows[0].shadowIntensity, directionalLightShadows[0].shadowBias,
            directionalLightShadows[0].shadowRadius, vDirectionalShadowCoord[0]);
        #endif
        float d = ambient + direct;
        // Screen-like lift: brightens dark pixels more than bright ones (reduces
        // contrast) instead of a flat multiply, which would blow out highlights.
        float amt = uBrightness - 1.0;
        vec3 lifted = clamp(c.rgb + amt * (1.0 - c.rgb), 0.0, 1.0);
        gl_FragColor = vec4(lifted * d, c.a);
        #include <fog_fragment>
      }
    `,
    fog: true,
    lights: true,
    ...TILE_DRAW,
  });
  verticalDiffuseMaterials.add(mat);
  registerLitMaterial(mat);
  return mat;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

export function bakeWorldUVs(geometry, meshPos, xMin, xMax, zMin, zMax) {
  const pos  = geometry.attributes.position.array;
  const count = pos.length / 3;
  const uvs  = new Float32Array(count * 2);
  const xRange = xMax - xMin, zRange = zMax - zMin;
  for (let i = 0; i < count; i++) {
    uvs[i * 2]     = (pos[i * 3]     + meshPos.x - xMin) / xRange;
    uvs[i * 2 + 1] = (pos[i * 3 + 2] + meshPos.z - zMin) / zRange;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
}

function magentaMaterial() {
  // Distinctive fallback so a tile with no texture is obvious.
  return new THREE.MeshStandardMaterial({
    roughness: 0.95, metalness: 0.0, color: 0xff00ff, ...TILE_DRAW,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function disposeMeshMaterial(mat) {
  if (!mat) return;
  // Per-tile textures live on uniforms.map (satellite / COSIA satellite) or
  // uniforms.uClassMap (COSIA palette). The palette LUT (uPalette) is shared and
  // must NOT be disposed.
  const tex = mat.uniforms?.map?.value ?? mat.uniforms?.uClassMap?.value;
  if (tex) tex.dispose();
  verticalDiffuseMaterials.delete(mat);
  unregisterLitMaterial(mat);
  mat.dispose();
}

export async function applyLayer(mesh, layerId, tileZ = 2) {
  const ver = (mesh.userData._layerVer = ((mesh.userData._layerVer ?? 0) + 1));

  let newMaterial;

  if (layerId === "cosia") {
    // COSIA land cover over the tile footprint. Two colour sources:
    //  • palette mode → class-id texture sampled into the editable palette LUT.
    //  • satellite mode → baked per-polygon ortho colours (plain RGB texture).
    const [, tx, ty, tz] = mesh.name.split("-").map(Number);
    const sat = isSatelliteColors();
    const tex = await (sat ? loadCosiaRgbTexture : loadCosiaTexture)(tx, ty, tz);
    if (mesh.userData._layerVer !== ver) return;
    if (tex) {
      const s = 1 / (1 << tz); // tile side in km
      bakeWorldUVs(mesh.geometry, mesh.position,
        tx * s, (tx + 1) * s, -(ty + 1) * s, -ty * s);
      newMaterial = sat ? buildVerticalDiffuseMaterial(tex) : buildCosiaMaterial(tex);
    } else {
      newMaterial = magentaMaterial();
    }

  } else {
    // satellite: IGN orthophoto draped over the tile via world-XY UVs.
    const wmtsZoom = WMTS_ZOOM_FOR_LOD[tileZ] ?? WMTS_ZOOM_FOR_LOD[WMTS_ZOOM_FOR_LOD.length - 1];
    mesh.geometry.computeBoundingBox();
    const { min, max } = mesh.geometry.boundingBox;
    const wx = mesh.position.x, wz = mesh.position.z;
    const { canvas, xMin, xMax, zMin, zMax } =
      await buildCanvas(min.x + wx, max.x + wx, min.z + wz, max.z + wz, wmtsZoom);
    if (mesh.userData._layerVer !== ver) return;

    bakeWorldUVs(mesh.geometry, mesh.position, xMin, xMax, zMin, zMax);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    newMaterial = buildVerticalDiffuseMaterial(texture);
    mesh.userData.textureData = { canvas, xMin, xMax, zMin, zMax };
  }

  const oldMaterial = mesh.material;
  mesh.material = newMaterial;
  disposeMeshMaterial(oldMaterial);
}

export function disposeLayerMaterials(mesh) {
  disposeMeshMaterial(mesh.material);
  mesh.material = null;
}
