/**
 * CityJSONL building loader.
 *
 * Fetches a CityJSONL file (one JSON object per line, roofer output),
 * parses LOD 2.2 / 1.2 geometry and returns a single merged Three.js Mesh
 * in scene coordinates (L93 km: x=east, y=altitude, z=-north).
 *
 * When opts.x0 / opts.y0 are supplied, each vertex is coloured with the
 * satellite orthophoto pixel at its (x, z) scene position.
 */

import * as THREE from "three";
import { Earcut } from "three/src/extras/Earcut.js";
import { bakeWorldUVs, buildCanvas, WMTS_ZOOM_FOR_LOD } from "./layers.js";

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

/** L93 metres → Three.js scene km (x=east, y=alt, z=-north). */
function l93ToScene(xm, ym, zm) {
  return [xm / 1000, zm / 1000, -ym / 1000];
}

/**
 * L93 metres → Three.js scene km, relative to a local origin (subtracted
 * before scaling). Vertex buffers stay small (~cell-sized) instead of baking
 * absolute world coordinates (~965 km) straight into the geometry — the mesh
 * carries the large offset instead, via `mesh.position`. Large per-vertex
 * float32 values lose enough precision at that magnitude to visibly jitter
 * ("vibrate") as the camera moves; terrain tiles avoid this the same way.
 */
function l93ToSceneLocal(xm, ym, zm, originXm, originYm) {
  return l93ToScene(xm - originXm, ym - originYm, zm);
}

/** Decode one CityJSON quantised vertex to L93 metres. */
function decodeVert(v, scale, translate) {
  return [
    v[0] * scale[0] + translate[0],
    v[1] * scale[1] + translate[1],
    v[2] * scale[2] + translate[2],
  ];
}

// ---------------------------------------------------------------------------
// Triangulation — earcut (handles concave polygons and holes)
// ---------------------------------------------------------------------------

/**
 * Triangulate one surface (array of rings) and append to `out`.
 * surface[0] = exterior ring, surface[1..] = holes.
 * Each ring is an array of vertex indices into `featVerts`.
 */
function triangulateSurface(surface, featVerts, scale, translate, originXm, originYm, out) {
  if (!surface[0] || surface[0].length < 3) return;

  // Project to the face's local 2-D plane so earcut works in 2-D.
  // We use the 3-D positions but pass dim=3 to earcut — it triangulates
  // using only x and y of the flat array, which means we need to project
  // out the dominant normal axis so the polygon isn't edge-on.

  // Collect 3-D scene coords for all rings, relative to (originXm, originYm).
  const rings3d = surface.map((ring) =>
    ring.map((idx) => {
      const [xm, ym, zm] = decodeVert(featVerts[idx], scale, translate);
      return l93ToSceneLocal(xm, ym, zm, originXm, originYm); // [sx, sy, sz]
    }),
  );

  // Compute face normal from the exterior ring to pick the projection plane.
  const ext = rings3d[0];
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < ext.length; i++) {
    const a = ext[i], b = ext[(i + 1) % ext.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const anx = Math.abs(nx), any = Math.abs(ny), anz = Math.abs(nz);

  // Drop the dominant-normal axis, use the other two as earcut u/v.
  let u, v;
  if (anx >= any && anx >= anz)      { u = 1; v = 2; } // drop x
  else if (any >= anx && any >= anz) { u = 0; v = 2; } // drop y
  else                               { u = 0; v = 1; } // drop z

  // Build flat [u0, v0, u1, v1, ...] for all rings plus hole start indices.
  const coords = [];
  const holeIndices = [];
  for (let r = 0; r < rings3d.length; r++) {
    if (r > 0) holeIndices.push(coords.length / 2);
    for (const pt of rings3d[r]) coords.push(pt[u], pt[v]);
  }

  const indices = Earcut.triangulate(coords, holeIndices);

  // Map flat vertex indices back to 3-D positions and emit triangles.
  // Enforce winding so the triangle normal aligns with the face normal (outward).
  const allPts = rings3d.flat();
  for (let i = 0; i < indices.length; i += 3) {
    const p0 = allPts[indices[i]], p1 = allPts[indices[i + 1]], p2 = allPts[indices[i + 2]];
    const ex = p1[0]-p0[0], ey = p1[1]-p0[1], ez = p1[2]-p0[2];
    const fx = p2[0]-p0[0], fy = p2[1]-p0[1], fz = p2[2]-p0[2];
    const dot = (ey*fz - ez*fy)*nx + (ez*fx - ex*fz)*ny + (ex*fy - ey*fx)*nz;
    if (dot >= 0) out.push(...p0, ...p1, ...p2);
    else          out.push(...p0, ...p2, ...p1);
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


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a CityJSONL file and return a Three.js Mesh of all buildings.
 *
 * @param {string} url  URL of the .city.jsonl file.
 * @param {object} opts { x0, y0, sunDir, getTerrainCanvas } cell grid coordinates, sun direction,
 *   and optional callback returning pre-loaded terrain canvas data (skips WMTS fetch).
 * @returns {THREE.Mesh|null}
 */
export async function loadCityBuildings(url, opts = {}) {
  const { x0, y0, sunDir, getTerrainCanvas } = opts;

  const canvasPromise = (x0 != null && y0 != null)
    ? (() => {
        const td = getTerrainCanvas?.(x0, y0);
        return td
          ? Promise.resolve(td)
          : buildCanvas(x0, x0 + 1, -(y0 + 1), -y0, WMTS_ZOOM_FOR_LOD[0]).catch(() => null);
      })()
    : Promise.resolve(null);

  const text = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
    return r.text();
  });

  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return null;

  const header = JSON.parse(lines[0]);
  const { scale, translate } = header.transform;

  // Cell's SW corner, in metres — subtracted from every vertex so the
  // geometry stays cell-sized; the mesh carries the large offset instead.
  const originXm = (x0 ?? 0) * 1000;
  const originYm = (y0 ?? 0) * 1000;
  const meshPos  = { x: x0 ?? 0, z: -(y0 ?? 0) };

  const positions = [];

  for (let i = 1; i < lines.length; i++) {
    let feat;
    try { feat = JSON.parse(lines[i]); } catch { continue; }

    const featVerts = feat.vertices ?? [];
    const cityObjs  = feat.CityObjects ?? {};

    for (const co of Object.values(cityObjs)) {
      const geoms = co.geometry ?? [];

      // Prefer LOD 2.2, fall back to 1.2, skip footprint-only (LOD 0)
      const geom =
        geoms.find((g) => String(g.lod) === "2.2") ??
        geoms.find((g) => String(g.lod) === "1.2");
      if (!geom) continue;

      for (const surface of collectSurfaces(geom))
        triangulateSurface(surface, featVerts, scale, translate, originXm, originYm, positions);
    }
  }

  if (positions.length === 0) return null;

  const posArray = new Float32Array(positions);
  const canvasData = await canvasPromise;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(posArray, 3));
  geometry.computeVertexNormals();

  let material;
  if (canvasData) {
    const { xMin, xMax, zMin, zMax, canvas } = canvasData;
    bakeWorldUVs(geometry, meshPos, xMin, xMax, zMin, zMax);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    const sun = sunDir ? sunDir.clone().normalize() : new THREE.Vector3(0.5, 1.0, 0.8).normalize();
    material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture },
        uSunDir: { value: sun },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vWorldNormal;
        void main() {
          vUv = uv;
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform vec3 uSunDir;
        varying vec2 vUv;
        varying vec3 vWorldNormal;
        void main() {
          float roof = smoothstep(0.3, 0.7, vWorldNormal.y);
          float nDotL = max(0.0, dot(vWorldNormal, uSunDir));
          // Same ambient floor / sun scale as the terrain shader (layers.js)
          // so walls shade consistently with the ground instead of looking
          // washed out relative to it.
          float light = 0.15 + 0.85 * nDotL;
          vec3 sat = texture2D(map, vUv).rgb;
          vec3 wall = vec3(1.0, 1.0, 1.0);
          gl_FragColor = vec4(mix(wall, sat, roof) * light, 1.0);
        }
      `,
      side: THREE.DoubleSide,
    });
  } else {
    material = new THREE.MeshLambertMaterial({ color: 0xd4b896, side: THREE.DoubleSide });
  }

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(meshPos.x, 0, meshPos.z);
  return mesh;
}
