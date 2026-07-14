
function rotateXMinus90(positions) {
  for (let i = 0; i < positions.length; i += 3) {
    const y = positions[i + 1];
    const z = positions[i + 2];
    positions[i + 1] = z;
    positions[i + 2] = -y;
  }
}

function computeVertexNormals(positions, index) {
  const normals = new Float32Array(positions.length);

  for (let i = 0; i < index.length; i += 3) {
    const vA = index[i] * 3;
    const vB = index[i + 1] * 3;
    const vC = index[i + 2] * 3;

    const abx = positions[vA] - positions[vB];
    const aby = positions[vA + 1] - positions[vB + 1];
    const abz = positions[vA + 2] - positions[vB + 2];

    const cbx = positions[vC] - positions[vB];
    const cby = positions[vC + 1] - positions[vB + 1];
    const cbz = positions[vC + 2] - positions[vB + 2];

    const nx = cby * abz - cbz * aby;
    const ny = cbz * abx - cbx * abz;
    const nz = cbx * aby - cby * abx;

    normals[vA] += nx; normals[vA + 1] += ny; normals[vA + 2] += nz;
    normals[vB] += nx; normals[vB + 1] += ny; normals[vB + 2] += nz;
    normals[vC] += nx; normals[vC + 1] += ny; normals[vC + 2] += nz;
  }

  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i], y = normals[i + 1], z = normals[i + 2];
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    normals[i] = x / len;
    normals[i + 1] = y / len;
    normals[i + 2] = z / len;
  }

  return normals;
}

function computeBoundingBox(positions) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return [minX, minY, minZ, maxX, maxY, maxZ];
}

self.onmessage = (e) => {
  const { id, positions, index, rotate } = e.data;

  if (rotate) rotateXMinus90(positions);
  const normals = computeVertexNormals(positions, index);
  const bbox = computeBoundingBox(positions);

  self.postMessage({ id, positions, normals, bbox }, [positions.buffer, normals.buffer]);
};
