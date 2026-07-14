import { describe, expect, it } from "vitest";


// Sanity-check the L93 WMTS tile-size formula baked into the UV math.
// These drive the satellite UV ranges; wrong values shift textures.
describe("L93 WMTS tile-size formula", () => {
  const tileSize = (scaleDenom) => 256 * scaleDenom * 0.00028;

  it("level 15 tile is ~1638 m", () => {
    expect(tileSize(22857.1429)).toBeCloseTo(1638, 0);
  });

  it("level 16 tile is ~819 m (half of level 15)", () => {
    expect(tileSize(11428.5714)).toBeCloseTo(819, 0);
  });

  it("level 17 tile is ~410 m (half of level 16)", () => {
    expect(tileSize(5714.2857)).toBeCloseTo(410, 0);
  });

  it("each level is exactly half the previous", () => {
    const s15 = tileSize(22857.1429);
    const s16 = tileSize(11428.5714);
    const s17 = tileSize(5714.2857);
    expect(s15 / s16).toBeCloseTo(2, 1);
    expect(s16 / s17).toBeCloseTo(2, 1);
  });
});
