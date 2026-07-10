import { describe, it, expect } from "vitest";
import { buildHeightmap, sampleHeight, HMAP_RES } from "../src/heightmap.js";

// Helper: flat terrain with N×N grid of vertices at a constant height
function flatGrid(minX, maxX, minZ, maxZ, height, n = 4) {
  const arr = new Float32Array(n * n * 3);
  let i = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      arr[i++] = minX + (c / (n - 1)) * (maxX - minX);
      arr[i++] = height;
      arr[i++] = minZ + (r / (n - 1)) * (maxZ - minZ);
    }
  }
  return arr;
}

describe("buildHeightmap", () => {
  it("stores max height at the correct grid cell", () => {
    const pos = new Float32Array([0.5, 2.0, 0.5]);
    const d = buildHeightmap(pos, 1, 0, 1, 0, 1);
    const gx = Math.floor(0.5 * d.invX);
    const gz = Math.floor(0.5 * d.invZ);
    expect(d.hmap[gz * HMAP_RES + gx]).toBe(2.0);
  });

  it("keeps the maximum when two vertices share a cell", () => {
    const pos = new Float32Array([0.5, 1.0, 0.5,  0.5, 3.0, 0.5]);
    const d = buildHeightmap(pos, 2, 0, 1, 0, 1);
    const gx = Math.floor(0.5 * d.invX);
    const gz = Math.floor(0.5 * d.invZ);
    expect(d.hmap[gz * HMAP_RES + gx]).toBe(3.0);
  });

  it("leaves out-of-bounds vertices at -Infinity", () => {
    const pos = new Float32Array([5.0, 1.0, 5.0]); // outside [0,1]×[0,1]
    const d = buildHeightmap(pos, 1, 0, 1, 0, 1);
    expect(d.hmap.every((h) => h === -Infinity)).toBe(true);
  });

  it("returns correct bounds", () => {
    const d = buildHeightmap(new Float32Array(0), 0, -5, 5, -3, 3);
    expect(d.minX).toBe(-5);
    expect(d.maxX).toBe(5);
    expect(d.minZ).toBe(-3);
    expect(d.maxZ).toBe(3);
  });
});

describe("sampleHeight", () => {
  it("returns null outside bounds", () => {
    const pos = flatGrid(0, 10, 0, 10, 1.5);
    const d = buildHeightmap(pos, pos.length / 3, 0, 10, 0, 10);
    expect(sampleHeight(d, -1, 5)).toBeNull();
    expect(sampleHeight(d, 5, 15)).toBeNull();
    expect(sampleHeight(d, 5, -0.01)).toBeNull();
  });

  it("returns the vertex height when sampled at the vertex world position", () => {
    // Single vertex — sample at the same XZ so the cell is guaranteed to be filled
    const pos = new Float32Array([0.5, 2.5, 0.5]);
    const d = buildHeightmap(pos, 1, 0, 1, 0, 1);
    // Fallback path: only 1 of 4 bilinear corners filled → returns that value
    const h = sampleHeight(d, 0.5, 0.5);
    expect(h).not.toBeNull();
    expect(h).toBe(2.5);
  });

  it("returns greater height for higher vertex", () => {
    // Two vertices far apart in XZ, different heights — sample near each
    const pos = new Float32Array([0.1, 0.0, 0.5,  0.9, 10.0, 0.5]);
    const d = buildHeightmap(pos, 2, 0, 1, 0, 1);
    const hLow  = sampleHeight(d, 0.1, 0.5);
    const hHigh = sampleHeight(d, 0.9, 0.5);
    expect(hLow).not.toBeNull();
    expect(hHigh).not.toBeNull();
    expect(hLow).toBeLessThan(hHigh);
  });
});
