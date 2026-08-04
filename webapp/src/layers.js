import * as THREE from "three";

import { getAmbientIntensity, getSunDirection, registerLitMaterial, unregisterLitMaterial } from "./sunLighting.js";

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

// itowns' RenderMode.MODES; readDepthBuffer only ever pushes DEPTH.
export const MODE_FINAL = 0;
export const MODE_DEPTH = 1;

export function buildVerticalDiffuseMaterial(texture) {
  const mat = new THREE.ShaderMaterial({
    defines: {
      MODE_FINAL,
      MODE_DEPTH,
      MODE: MODE_FINAL,
    },
    uniforms: {
      ...THREE.UniformsLib.fog,
      ...THREE.UniformsLib.lights,
      map: { value: texture },
      uBrightness: { value: currentBrightness },
      uLit: { value: currentLit },
      uSunDir: { value: getSunDirection().clone() },
      uAmbient: { value: getAmbientIntensity() },
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
      uniform float uAmbient;
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      void main() {
        #include <logdepthbuf_fragment>
        #if MODE == MODE_DEPTH
        // logdepthbuf_fragment has just written gl_FragDepth; three aliases
        // gl_FragDepthEXT to it. Encoding it is what makes this mesh visible to
        // itowns' depth picking (wheel zoom, smart travel).
        gl_FragColor = packDepthToRGBA(gl_FragDepthEXT);
        #else
        vec4 c = texture2D(map, vUv);
        float direct = (1.0 - uAmbient) * max(0.0, dot(vWorldNormal, uSunDir));
        #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
          direct *= getShadow(directionalShadowMap[0], directionalLightShadows[0].shadowMapSize,
            directionalLightShadows[0].shadowIntensity, directionalLightShadows[0].shadowBias,
            directionalLightShadows[0].shadowRadius, vDirectionalShadowCoord[0]);
        #endif
        float d = mix(1.0, uAmbient + direct, uLit);
        // Screen-like lift: brightens dark pixels more than bright ones (reduces
        // contrast) instead of a flat multiply, which would blow out highlights.
        float amt = uBrightness - 1.0;
        vec3 lifted = clamp(c.rgb + amt * (1.0 - c.rgb), 0.0, 1.0);
        gl_FragColor = vec4(lifted * d, c.a);
        #include <fog_fragment>
        #endif
      }
    `,
    fog: true,
    lights: true,
    ...TILE_DRAW,
  });
  // Same contract as itowns' LayeredMaterial, which RenderMode.push drives.
  Object.defineProperty(mat, "mode", {
    get() {
      return this.defines.MODE;
    },
    set(mode) {
      if (this.defines.MODE !== mode) {
        this.defines.MODE = mode;
        this.needsUpdate = true;
      }
    },
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

export function disposeLayerMaterials(mesh) {
  disposeMeshMaterial(mesh.material);
  mesh.material = null;
}
