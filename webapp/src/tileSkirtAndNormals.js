import * as THREE from "three";


function computeNormals(position, index) {
  const normal = new Float32Array(position.length);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    const e1x = position[b] - position[a];
    const e1y = position[b + 1] - position[a + 1];
    const e1z = position[b + 2] - position[a + 2];
    const e2x = position[c] - position[a];
    const e2y = position[c + 1] - position[a + 1];
    const e2z = position[c + 2] - position[a + 2];
    const e3x = position[c] - position[b];
    const e3y = position[c + 1] - position[b + 1];
    const e3z = position[c + 2] - position[b + 2];
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const cl = Math.hypot(cx, cy, cz);
    if (cl === 0) continue;
    let nx = cx, ny = cy, nz = cz, wa = 1, wb = 1, wc = 1;
    if (WEIGHT_MODE !== "area") {
      nx = cx / cl; ny = cy / cl; nz = cz / cl;
      const lab = Math.hypot(e1x, e1y, e1z);
      const lac = Math.hypot(e2x, e2y, e2z);
      const lbc = Math.hypot(e3x, e3y, e3z);
      if (WEIGHT_MODE === "max") {
        wa = cl / (lab * lab * lac * lac);
        wb = cl / (lab * lab * lbc * lbc);
        wc = cl / (lac * lac * lbc * lbc);
      } else {
        wa = Math.acos(Math.max(-1, Math.min(1, (e1x * e2x + e1y * e2y + e1z * e2z) / (lab * lac))));
        wb = Math.acos(Math.max(-1, Math.min(1, -(e1x * e3x + e1y * e3y + e1z * e3z) / (lab * lbc))));
        wc = Math.PI - wa - wb;
      }
    }
    normal[a] += nx * wa; normal[a + 1] += ny * wa; normal[a + 2] += nz * wa;
    normal[b] += nx * wb; normal[b + 1] += ny * wb; normal[b + 2] += nz * wb;
    normal[c] += nx * wc; normal[c + 1] += ny * wc; normal[c + 2] += nz * wc;
  }
  for (let i = 0; i < normal.length; i += 3) {
    const l = Math.hypot(normal[i], normal[i + 1], normal[i + 2]) || 1;
    normal[i] /= l; normal[i + 1] /= l; normal[i + 2] /= l;
  }
  smoothNormals(normal, index, SMOOTH_PASSES, SMOOTH_CENTER_WEIGHT);
  return normal;
}

const WEIGHT_MODE = "angle";

const SMOOTH_PASSES = 2;
const SMOOTH_CENTER_WEIGHT = 0.5;

function smoothNormals(normal, index, passes, centerWeight) {
  if (passes <= 0) return;
  const vertexCount = normal.length / 3;
  const acc = new Float32Array(normal.length);
  const count = new Uint32Array(vertexCount);

  for (let p = 0; p < passes; p++) {
    acc.fill(0);
    count.fill(0);
    for (let t = 0; t < index.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const v = index[t + k];
        const n1 = index[t + ((k + 1) % 3)];
        const n2 = index[t + ((k + 2) % 3)];
        acc[v * 3] += normal[n1 * 3] + normal[n2 * 3];
        acc[v * 3 + 1] += normal[n1 * 3 + 1] + normal[n2 * 3 + 1];
        acc[v * 3 + 2] += normal[n1 * 3 + 2] + normal[n2 * 3 + 2];
        count[v] += 2;
      }
    }
    for (let v = 0; v < vertexCount; v++) {
      const c = count[v];
      if (c === 0) continue;
      const w = (1 - centerWeight) / c;
      let x = normal[v * 3] * centerWeight + acc[v * 3] * w;
      let y = normal[v * 3 + 1] * centerWeight + acc[v * 3 + 1] * w;
      let z = normal[v * 3 + 2] * centerWeight + acc[v * 3 + 2] * w;
      const l = Math.hypot(x, y, z) || 1;
      normal[v * 3] = x / l;
      normal[v * 3 + 1] = y / l;
      normal[v * 3 + 2] = z / l;
    }
  }
}




function boundaryEdges(index) {
  let cap = 16;
  while (cap < index.length * 2) cap <<= 1;
  const mask = cap - 1;
  const keys = new Float64Array(cap).fill(-1);
  const ea = new Int32Array(cap);
  const eb = new Int32Array(cap);

  for (let t = 0; t < index.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = index[t + k];
      const b = index[t + ((k + 1) % 3)];
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = lo * 4294967296 + hi;
      let slot = ((Math.imul(lo, 73856093) ^ Math.imul(hi, 19349663)) >>> 0) & mask;
      for (; ;) {
        const cur = keys[slot];
        if (cur === -1) {
          keys[slot] = key;
          ea[slot] = a;
          eb[slot] = b;
          break;
        }
        if (cur === key) {
          keys[slot] = -2;
          break;
        }
        slot = (slot + 1) & mask;
      }
    }
  }

  const out = [];
  for (let s = 0; s < cap; s++) {
    if (keys[s] >= 0) out.push(ea[s], eb[s]);
  }
  return out;
}

function addNormalsAndSkirtToGeometry(position, index) {

  if (!position || !index || index.length === 0) return null;

  const normal = computeNormals(position, index);

  const edges = boundaryEdges(index);
  const edgeCount = edges.length / 2;
  if (edgeCount === 0) return { position, index, normal, skirtQuads: 0 };


  const height = 10;

  const vertexCount = position.length / 3;
  const bottomOf = new Int32Array(vertexCount).fill(-1);
  let added = 0;
  for (let i = 0; i < edges.length; i++) {
    const v = edges[i];
    if (bottomOf[v] === -1) bottomOf[v] = vertexCount + added++;
  }

  const outPosition = new Float32Array((vertexCount + added) * 3);
  const outNormal = new Float32Array((vertexCount + added) * 3);
  outPosition.set(position);
  outNormal.set(normal);
  const dx = 0, dy = 0, dz = -height;
  for (let v = 0; v < vertexCount; v++) {
    const d = bottomOf[v];
    if (d === -1) continue;
    outPosition[d * 3] = position[v * 3] + dx;
    outPosition[d * 3 + 1] = position[v * 3 + 1] + dy;
    outPosition[d * 3 + 2] = position[v * 3 + 2] + dz;
    outNormal[d * 3] = normal[v * 3];
    outNormal[d * 3 + 1] = normal[v * 3 + 1];
    outNormal[d * 3 + 2] = normal[v * 3 + 2];
  }

  const outIndex = new Uint32Array(index.length + edgeCount * 6);
  outIndex.set(index);
  let o = index.length;
  for (let e = 0; e < edgeCount; e++) {
    const a = edges[e * 2];
    const b = edges[e * 2 + 1];
    const ad = bottomOf[a];
    const bd = bottomOf[b];
    outIndex[o++] = a; outIndex[o++] = ad; outIndex[o++] = bd;
    outIndex[o++] = a; outIndex[o++] = bd; outIndex[o++] = b;
  }

  return { position: outPosition, index: outIndex, normal: outNormal, skirtQuads: edgeCount };
}


export async function applySkirtAndNormals(geometry) {
  const posAttr = geometry.attributes.position;
  const indexAttr = geometry.index;
  if (!posAttr || !indexAttr || geometry.userData.skirted) return false;
  geometry.userData.skirted = true;

  const result = addNormalsAndSkirtToGeometry(posAttr.array, indexAttr.array);

  if (!result) return false;

  geometry.setAttribute("position", new THREE.BufferAttribute(result.position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(result.normal, 3));
  geometry.setIndex(new THREE.BufferAttribute(result.index, 1));
  geometry.boundingBox = null;
  geometry.boundingSphere = null;
  return true;
}

