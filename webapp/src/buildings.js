/**
 * CityJSONL building loader.
 *
 * Fetches a CityJSONL file (one JSON object per line, roofer output, still in
 * L93/NGF89 metres), parses LOD 2.2 / 1.2 geometry and returns a single
 * merged Three.js Mesh in the scene's local work frame (Z up, see
 * workFrame.js) — the same frame the terrain tileset renders in.
 */

import * as THREE from "three";
import { Earcut } from "three/src/extras/Earcut.js";
import { l93ToWebMercator } from "./proj.js";
import { getSunDirection, registerLitMaterial } from "./sunLighting.js";
import { mercToLocal } from "./workFrame.js";

/** L93 metres → local work frame metres (x=east, y=north, z=up). */
function l93ToLocal(xm, ym, zm) {
  const [mx, my] = l93ToWebMercator.forward([xm, ym]);
  const [lx, ly] = mercToLocal([mx, my]);
  return [lx, ly, zm];
}

/** Decode one CityJSON quantised vertex to L93 metres. */
function decodeVert(v, scale, translate) {
  return [
    v[0] * scale[0] + translate[0],
    v[1] * scale[1] + translate[1],
    v[2] * scale[2] + translate[2],
  ];
}

/**
 * Triangulate one surface (array of rings) and append to `out`.
 * surface[0] = exterior ring, surface[1..] = holes.
 * Each ring is an array of vertex indices into `featVerts`.
 */
function triangulateSurface(surface, featVerts, scale, translate, out) {
  if (!surface[0] || surface[0].length < 3) return;

  const rings3d = surface.map((ring) =>
    ring.map((idx) => l93ToLocal(...decodeVert(featVerts[idx], scale, translate))),
  );

  const ext = rings3d[0];
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < ext.length; i++) {
    const a = ext[i], b = ext[(i + 1) % ext.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const anx = Math.abs(nx), any = Math.abs(ny), anz = Math.abs(nz);

  let u, v;
  if (anx >= any && anx >= anz) { u = 1; v = 2; }
  else if (any >= anx && any >= anz) { u = 0; v = 2; }
  else { u = 0; v = 1; }

  const coords = [];
  const holeIndices = [];
  for (let r = 0; r < rings3d.length; r++) {
    if (r > 0) holeIndices.push(coords.length / 2);
    for (const pt of rings3d[r]) coords.push(pt[u], pt[v]);
  }

  const indices = Earcut.triangulate(coords, holeIndices);

  const allPts = rings3d.flat();
  for (let i = 0; i < indices.length; i += 3) {
    const p0 = allPts[indices[i]], p1 = allPts[indices[i + 1]], p2 = allPts[indices[i + 2]];
    const ex = p1[0] - p0[0], ey = p1[1] - p0[1], ez = p1[2] - p0[2];
    const fx = p2[0] - p0[0], fy = p2[1] - p0[1], fz = p2[2] - p0[2];
    const dot = (ey * fz - ez * fy) * nx + (ez * fx - ex * fz) * ny + (ex * fy - ey * fx) * nz;
    if (dot >= 0) out.push(...p0, ...p1, ...p2);
    else out.push(...p0, ...p2, ...p1);
  }
}

/** Collect all polygon rings from a CityJSON geometry object. */
function collectSurfaces(geom) {
  if (geom.type === "MultiSurface") return geom.boundaries;
  if (geom.type === "Solid") {
    const surfs = [];
    for (const shell of geom.boundaries)
      for (const surf of shell) surfs.push(surf);
    return surfs;
  }
  return [];
}

const UP_AXIS = /* glsl */ "vec3(0.0, 0.0, 1.0)";
const ROOF_COLOR = /* glsl */ "vec3(0.25, 0.20, 0.20)";

/** Flat red-brown roof, flat white wall; both lit by the sun. No texture. */
function buildBuildingMaterial() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: getSunDirection().clone() },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vWorldNormal;
      void main() {
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uSunDir;
      varying vec3 vWorldNormal;
      void main() {
        #include <logdepthbuf_fragment>
        float roof = smoothstep(0.3, 0.7, dot(vWorldNormal, ${UP_AXIS}));
        float light = 0.15 + 0.85 * max(0.0, dot(vWorldNormal, uSunDir));
        vec3 color = mix(vec3(1.0), ${ROOF_COLOR}, roof);
        gl_FragColor = vec4(color * light, 1.0);
      }
    `,
    side: THREE.DoubleSide,
  });
  registerLitMaterial(material);
  return material;
}

/**
 * Load a CityJSONL file and return a Three.js Mesh of all buildings, in
 * local work-frame coordinates.
 *
 * @param {string} url  URL of the .city.jsonl file.
 * @returns {THREE.Mesh|null}
 */
export async function loadCityBuildings(url) {
  const res = await fetch(url);
  if (res.status === 404) return null; // no buildings for this cell
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const text = await res.text();

  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return null;

  const header = JSON.parse(lines[0]);
  const { scale, translate } = header.transform;

  const positions = [];

  for (let i = 1; i < lines.length; i++) {
    let feat;
    try { feat = JSON.parse(lines[i]); } catch { continue; }

    const featVerts = feat.vertices ?? [];
    const cityObjs = feat.CityObjects ?? {};

    for (const co of Object.values(cityObjs)) {
      const geoms = co.geometry ?? [];

      const geom =
        geoms.find((g) => String(g.lod) === "2.2") ??
        geoms.find((g) => String(g.lod) === "1.2");
      if (!geom) continue;

      for (const surface of collectSurfaces(geom))
        triangulateSurface(surface, featVerts, scale, translate, positions);
    }
  }

  if (positions.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();

  return new THREE.Mesh(geometry, buildBuildingMaterial());
}
