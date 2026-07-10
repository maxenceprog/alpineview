export const HMAP_RES = 1024; // 2x finer grid — reduces gaps between sample
// points on steep terrain where the camera's ground floor could clip through.

/**
 * Build a 2D max-height grid from a flat Float32Array of XYZ vertices.
 * posArray: flat array [x0,y0,z0, x1,y1,z1, ...]
 * Returns { hmap, invX, invZ, minX, maxX, minZ, maxZ } for use with sampleHeight.
 */
export function buildHeightmap(posArray, count, minX, maxX, minZ, maxZ) {
  const hmap = new Float32Array(HMAP_RES * HMAP_RES).fill(-Infinity);
  if (maxX === minX || maxZ === minZ) return { hmap, invX: 0, invZ: 0, minX, maxX, minZ, maxZ };
  const invX = (HMAP_RES - 1) / (maxX - minX);
  const invZ = (HMAP_RES - 1) / (maxZ - minZ);

  for (let i = 0; i < count; i++) {
    const vx = posArray[i * 3], vy = posArray[i * 3 + 1], vz = posArray[i * 3 + 2];
    const gx = Math.floor((vx - minX) * invX);
    const gz = Math.floor((vz - minZ) * invZ);
    if (gx < 0 || gx >= HMAP_RES || gz < 0 || gz >= HMAP_RES) continue;
    const idx = gz * HMAP_RES + gx;
    if (vy > hmap[idx]) hmap[idx] = vy;
  }

  return { hmap, invX, invZ, minX, maxX, minZ, maxZ };
}

/**
 * Bilinear sample of the heightmap at world position (wx, wz).
 * Returns null if the point is outside the mesh bounds.
 */
export function sampleHeight(hmapData, wx, wz) {
  const { hmap, invX, invZ, minX, maxX, minZ, maxZ } = hmapData;
  if (wx < minX || wx > maxX || wz < minZ || wz > maxZ) return null;

  const fx = (wx - minX) * invX;
  const fz = (wz - minZ) * invZ;
  const x0 = Math.max(0, Math.min(HMAP_RES - 2, Math.floor(fx)));
  const z0 = Math.max(0, Math.min(HMAP_RES - 2, Math.floor(fz)));
  const tx = fx - x0, tz = fz - z0;

  const h00 = hmap[ z0      * HMAP_RES + x0    ];
  const h10 = hmap[ z0      * HMAP_RES + x0 + 1];
  const h01 = hmap[(z0 + 1) * HMAP_RES + x0    ];
  const h11 = hmap[(z0 + 1) * HMAP_RES + x0 + 1];

  if (h00 > -Infinity && h10 > -Infinity && h01 > -Infinity && h11 > -Infinity) {
    return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz)
         + h01 * (1 - tx) * tz       + h11 * tx * tz;
  }
  const candidates = [h00, h10, h01, h11].filter((h) => h > -Infinity);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}
