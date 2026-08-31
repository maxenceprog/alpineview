import * as THREE from "three";

import { getSunDirection, registerLitMaterial, unregisterLitMaterial } from "./sunLighting.js";

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

export function setShadowLift(value) {
  currentBrightness = value;
  for (const mat of verticalDiffuseMaterials) mat.uniforms.uShadowLift.value = value;
}

export function getShadowLift() {
  return currentBrightness;
}

// Below this slope from vertical, the "no texture" mode (buildVerticalDiffuseMaterial(null)) paints snow.
const SNOW_MAX_SLOPE_DEG = 55;

export function buildVerticalDiffuseMaterial(texture) {
  const mat = new THREE.ShaderMaterial({
    defines: {
      ...(texture ? {} : { NO_TEXTURE: 1 }),
    },
    uniforms: {
      ...THREE.UniformsLib.fog,
      ...THREE.UniformsLib.lights,
      ...(texture ? { map: { value: texture } } : {}),
      uShadowLift: { value: currentBrightness },
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
      #ifndef NO_TEXTURE
      uniform sampler2D map;
      #endif
      uniform float uShadowLift;
      uniform float uLit;
      uniform vec3 uSunDir;
      const float AMBIENT = 0.02;
      const float TOP_LIGHT = 0.2;
      const float SNOW_MAX_SLOPE = radians(${SNOW_MAX_SLOPE_DEG.toFixed(1)});
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      void main() {
        #include <logdepthbuf_fragment>
        #ifdef NO_TEXTURE
        float slope = acos(clamp(dot(normalize(vWorldNormal), vec3(0.0, 0.0, 1.0)), -1.0, 1.0));
        vec4 c = slope < SNOW_MAX_SLOPE ? vec4(0.95, 0.95, 0.97, 1.0) : vec4(0.5, 0.46, 0.41, 1.0);
        #else
        vec4 c = texture2D(map, vUv);
        #endif
        float sunVisible = smoothstep(-0.1, 0.1, uSunDir.z);
        float direct = sunVisible * (1.0 - AMBIENT) * max(0.0, dot(vWorldNormal, uSunDir));
        #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
          direct *= getShadow(directionalShadowMap[0], directionalLightShadows[0].shadowMapSize,
            directionalLightShadows[0].shadowIntensity, directionalLightShadows[0].shadowBias,
            directionalLightShadows[0].shadowRadius, vDirectionalShadowCoord[0]);
        #endif
        float d = mix(1.0, AMBIENT + direct, uLit) + TOP_LIGHT * max(0.0, vWorldNormal.z);
        // Shadow lift: brightens dark pixels more than bright
        // ones (reduces contrast) instead of a flat multiply, which would blow out highlights.
        float liftAmount = uShadowLift - 1.0;
        vec3 lifted = clamp(c.rgb + liftAmount * (1.0 - c.rgb), 0.0, 1.0);
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
