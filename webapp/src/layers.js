import * as THREE from "three";

import { IS_MOBILE } from "./deviceInfo.js";
import { getSunDirection, registerLitMaterial, unregisterLitMaterial } from "./sunLighting.js";

const L93_ORIGIN_X = 0;
const L93_ORIGIN_Y = 12_000_000;
const L93_TILE_SIZE_M = {
  14: 256 * 45714.2857 * 0.00028,
  15: 256 * 22857.1429 * 0.00028,
  16: 256 * 11428.5714 * 0.00028,
  17: 256 * 5714.2857 * 0.00028,
  18: 256 * 2857.1429 * 0.00028,
  19: 256 * 1428.5714 * 0.00028,
};
export const WMTS_ZOOM_FOR_LOD = IS_MOBILE ? [15, 17, 18] : [16, 18, 19];

const ignOrthoUrl = (col, row, level) =>
  `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
  `&LAYER=HR.ORTHOIMAGERY.ORTHOPHOTOS.L93&STYLE=normal&FORMAT=image%2Fjpeg` +
  `&TILEMATRIXSET=2154_10cm_10_20&TILEMATRIX=${level}&TILEROW=${row}&TILECOL=${col}`;

const ignPlanUrl = (col, row, level) =>
  `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
  `&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2.L93&STYLE=normal&FORMAT=image%2Fjpeg` +
  `&TILEMATRIXSET=2154_10cm_6_20&TILEMATRIX=${level}&TILEROW=${row}&TILECOL=${col}`;

const MAP_SOURCE_URLS = { ortho: ignOrthoUrl, plan: ignPlanUrl };

let currentMapSource = "ortho";

export function setMapSource(source) {
  currentMapSource = source;
}

export function getMapSource() {
  return currentMapSource;
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
    const oldestKey = _imageCache.keys().next().value;
    _imageCache.delete(oldestKey);
  }
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
  canvas.width = (colMax - colMin + 1) * 256;
  canvas.height = (rowMax - rowMin + 1) * 256;
  const ctx = canvas.getContext("2d");

  const tileUrl = MAP_SOURCE_URLS[currentMapSource];
  const fetches = [];
  for (let r = rowMin; r <= rowMax; r++)
    for (let c = colMin; c <= colMax; c++)
      fetches.push(loadImage(tileUrl(c, r, level)).then(img => ({ img, col: c - colMin, row: r - rowMin })));

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

const TILE_DRAW = {
  side: THREE.FrontSide,
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
};

let currentBrightness = 1.0;
let currentLit = 1.0;
const verticalDiffuseMaterials = new Set();

export function setTerrainLightingEnabled(on) {
  currentLit = on ? 1.0 : 0.0;
  for (const mat of verticalDiffuseMaterials) mat.uniforms.uLit.value = currentLit;
}

export function setBrightness(value) {
  currentBrightness = value;
  for (const mat of verticalDiffuseMaterials) mat.uniforms.uBrightness.value = value;
}

export function getBrightness() {
  return currentBrightness;
}

export function buildVerticalDiffuseMaterial(texture) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsLib.fog,
      ...THREE.UniformsLib.lights,
      map: { value: texture },
      uBrightness: { value: currentBrightness },
      uLit: { value: currentLit },
      uSunDir: { value: getSunDirection().clone() },
    },
    vertexShader: `
      #include <common>
      #include <shadowmap_pars_vertex>
      #include <fog_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      void main() {
        vUv = uv;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vec3 transformed = position;
        vec3 transformedNormal = normalize(normalMatrix * normal);
        vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
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
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D map;
      uniform float uBrightness;
      uniform float uLit;
      uniform vec3 uSunDir;
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      void main() {
        #include <logdepthbuf_fragment>
        vec4 c = texture2D(map, vUv);
        float ambient = 0.15;
        float direct = 0.85 * max(0.0, dot(vWorldNormal, uSunDir));
        #if NUM_DIR_LIGHT_SHADOWS > 0
          direct *= getShadow(directionalShadowMap[0], directionalLightShadows[0].shadowMapSize,
            directionalLightShadows[0].shadowIntensity, directionalLightShadows[0].shadowBias,
            directionalLightShadows[0].shadowRadius, vDirectionalShadowCoord[0]);
        #endif
        float d = mix(1.0, ambient + direct, uLit);
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

export function bakeWorldUVs(geometry, meshPos, xMin, xMax, zMin, zMax) {
  const pos = geometry.attributes.position.array;
  const count = pos.length / 3;
  const uvs = new Float32Array(count * 2);
  const xRange = xMax - xMin, zRange = zMax - zMin;
  for (let i = 0; i < count; i++) {
    uvs[i * 2] = (pos[i * 3] + meshPos.x - xMin) / xRange;
    uvs[i * 2 + 1] = (pos[i * 3 + 2] + meshPos.z - zMin) / zRange;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
}

function disposeMeshMaterial(mat) {
  if (!mat) return;
  const tex = mat.uniforms?.map?.value;
  if (tex) tex.dispose();
  verticalDiffuseMaterials.delete(mat);
  unregisterLitMaterial(mat);
  mat.dispose();
}

export function replaceMeshMaterial(mesh, newMaterial) {
  const oldMaterial = mesh.material;
  mesh.material = newMaterial;
  disposeMeshMaterial(oldMaterial);
}

export async function applyLayer(mesh, tileZ = 2) {
  const ver = (mesh.userData._layerVer = ((mesh.userData._layerVer ?? 0) + 1));

  const wmtsZoom = WMTS_ZOOM_FOR_LOD[tileZ] ?? WMTS_ZOOM_FOR_LOD[WMTS_ZOOM_FOR_LOD.length - 1];
  const { min, max } = mesh.geometry.boundingBox;
  const wx = mesh.position.x, wz = mesh.position.z;
  const { canvas, xMin, xMax, zMin, zMax } =
    await buildCanvas(min.x + wx, max.x + wx, min.z + wz, max.z + wz, wmtsZoom);
  if (mesh.userData._layerVer !== ver) return;

  bakeWorldUVs(mesh.geometry, mesh.position, xMin, xMax, zMin, zMax);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  mesh.userData.textureData = { canvas, xMin, xMax, zMin, zMax };

  replaceMeshMaterial(mesh, buildVerticalDiffuseMaterial(texture));
}

export function disposeLayerMaterials(mesh) {
  disposeMeshMaterial(mesh.material);
  mesh.material = null;
}
