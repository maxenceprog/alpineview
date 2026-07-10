import { describe, it, expect } from "vitest";
import { altitudeFromZoom, zoomFromAltitude } from "../src/slippyMap.js";

describe("altitudeFromZoom / zoomFromAltitude", () => {
  it("are monotonically decreasing/increasing and roughly inverse", () => {
    expect(altitudeFromZoom(2)).toBeGreaterThan(altitudeFromZoom(10));
    expect(zoomFromAltitude(1)).toBeGreaterThan(zoomFromAltitude(1000));

    for (const alt of [1, 5, 8, 10, 50, 500, 5000]) {
      const z = zoomFromAltitude(alt);
      const altBack = altitudeFromZoom(z);
      // round-trip within one zoom-level's worth of altitude (heuristic, not exact)
      expect(Math.abs(Math.log2(altBack / alt))).toBeLessThan(1);
    }
  });

  it("clamps zoom to the [2, 17] range (OpenTopoMap's max zoom)", () => {
    expect(zoomFromAltitude(1e9)).toBe(2);
    expect(zoomFromAltitude(1e-9)).toBe(17);
  });
});
