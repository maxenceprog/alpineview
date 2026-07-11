import * as THREE from "three";
import { API_BASE_URL } from "./apiConfig.js";
import { getSunDirection, registerLitMaterial } from "./sunLighting.js";

// ---------------------------------------------------------------------------
// COSIA land-cover layer.
//
// Each tile ships a `tile.x.y.z.cosia.png`: a single-channel image where the
// pixel value is the COSIA `numero` class, rasterised over the tile's footprint
// (one texture per LOD). The webapp samples it per fragment with world-XY UVs
// and looks the colour up in an editable 256×1 palette LUT — crisp class
// boundaries independent of mesh resolution.
// ---------------------------------------------------------------------------

// COSIA numero -> label + natural default colour.
export const CLASS_INFO = [
  { code: 1, label: "Bâtiment", color: "#c0563b" },
  { code: 2, label: "Zone perméable", color: "#b9a06a" },
  { code: 3, label: "Zone imperméable", color: "#8b8f94" },
  { code: 4, label: "Piscine", color: "#36c5d0" },
  { code: 5, label: "Sol nu", color: "#c2a878" },
  { code: 6, label: "Surface eau", color: "#3f78c4" },
  { code: 7, label: "Neige", color: "#eef3f8" },
  { code: 8, label: "Conifère", color: "#1f6b3a" },
  { code: 9, label: "Feuillu", color: "#4a9e4f" },
  { code: 10, label: "Broussaille", color: "#8a9a4d" },
  { code: 11, label: "Vigne", color: "#8a5a8a" },
  { code: 12, label: "Pelouse", color: "#9ccf6a" },
  { code: 13, label: "Culture", color: "#c8b24a" },
  { code: 14, label: "Terre labourée", color: "#9a6b3f" },
  { code: 15, label: "Serre", color: "#b8d0e0" },
];

const NODATA_COLOR = "#0d1b2a"; // class 0 (no COSIA coverage)

// 256×1 RGBA LUT indexed by class code. Linear colour space: bytes are read raw
// and fed straight into the shaded albedo.
const _lutData = new Uint8Array(256 * 4);
export const paletteTexture = new THREE.DataTexture(
  _lutData,
  256,
  1,
  THREE.RGBAFormat,
  THREE.UnsignedByteType,
);
paletteTexture.colorSpace = THREE.LinearSRGBColorSpace;
paletteTexture.magFilter = THREE.NearestFilter;
paletteTexture.minFilter = THREE.NearestFilter;

const _c = new THREE.Color();

function _writeLut(code, hex) {
  _c.setStyle(hex, THREE.SRGBColorSpace); // -> linear components
  const o = code * 4;
  _lutData[o] = Math.round(_c.r * 255);
  _lutData[o + 1] = Math.round(_c.g * 255);
  _lutData[o + 2] = Math.round(_c.b * 255);
  _lutData[o + 3] = 255;
}

export const palette = {};
for (let i = 0; i < 256; i++) _writeLut(i, NODATA_COLOR);
for (const { code, color } of CLASS_INFO) {
  palette[code] = color;
  _writeLut(code, color);
}
paletteTexture.needsUpdate = true;

/** Recolour a COSIA class everywhere (updates the shared LUT). */
export function setClassColor(code, hex) {
  palette[code] = hex;
  _writeLut(code, hex);
  paletteTexture.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Texture loading
// ---------------------------------------------------------------------------

const _texLoader = new THREE.TextureLoader();

// Colour source for the COSIA layer: false = editable class palette,
// true = per-polygon colours sampled from the orthophoto (tile.*.cosia_rgb.png).
let _satelliteColors = false;
export const isSatelliteColors = () => _satelliteColors;
export function setSatelliteColors(on) {
  _satelliteColors = on;
}

/**
 * Load a tile's COSIA class texture, or null if there is none. The class id is
 * the raw R channel, so use NearestFilter and no colour-space conversion.
 */
export async function loadCosiaTexture(tx, ty, z, reload = false) {
  const url = `${API_BASE_URL}/tiles/tile.${tx}.${ty}.${z}.cosia.png${reload ? `?t=${Date.now()}` : ""}`;
  try {
    const tex = await _texLoader.loadAsync(url);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.colorSpace = THREE.NoColorSpace;
    return tex;
  } catch {
    return null; // missing tile (dev server returns index.html → decode error)
  }
}

/**
 * Load a tile's baked "posterized satellite" COSIA texture (per-polygon ortho
 * colours), or null if there is none. This is a normal sRGB colour image.
 */
export async function loadCosiaRgbTexture(tx, ty, z, reload = false) {
  const url = `${API_BASE_URL}/tiles/tile.${tx}.${ty}.${z}.cosia_rgb.png${reload ? `?t=${Date.now()}` : ""}`;
  try {
    const tex = await _texLoader.loadAsync(url);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Material — class-id texture -> palette colour, shaded by the real sun
// direction (matches the satellite layer and buildings/vegetation), with fog.
// ---------------------------------------------------------------------------

export function buildCosiaMaterial(classTexture) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsLib.fog,
      ...THREE.UniformsLib.lights,
      uClassMap: { value: classTexture },
      uPalette: { value: paletteTexture },
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
      uniform sampler2D uClassMap;
      uniform sampler2D uPalette;
      uniform vec3 uSunDir;
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      void main() {
        float id = floor(texture2D(uClassMap, vUv).r * 255.0 + 0.5);
        vec3 col = texture2D(uPalette, vec2((id + 0.5) / 256.0, 0.5)).rgb;
        float ambient = 0.15;
        float direct = 0.85 * max(0.0, dot(vWorldNormal, uSunDir));
        #if NUM_DIR_LIGHT_SHADOWS > 0
          direct *= getShadow(directionalShadowMap[0], directionalLightShadows[0].shadowMapSize,
            directionalLightShadows[0].shadowIntensity, directionalLightShadows[0].shadowBias,
            directionalLightShadows[0].shadowRadius, vDirectionalShadowCoord[0]);
        #endif
        float d = ambient + direct;
        gl_FragColor = vec4(col * d, 1.0);
        #include <fog_fragment>
      }
    `,
    fog: true,
    lights: true,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  registerLitMaterial(mat);
  return mat;
}
