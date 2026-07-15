import { describe, expect, it, vi } from "vitest";

vi.mock("../src/deviceInfo.js", () => ({ IS_MOBILE: false }));

const { fetchWmtsCanvas } = await import("../src/wmts.js");

// happy-dom has no 2D context.
HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });

// Tile requests the plan layer answers, from its published TileMatrixLimits.
// z7 publishes 4 columns but the layer only fills 0-2 — col 3 404s.
function requestedTiles(urls) {
  return urls.map((u) => {
    const p = new URLSearchParams(u.split("?")[1]);
    return `${p.get("TILEMATRIX")}/${p.get("TILECOL")}/${p.get("TILEROW")}`;
  });
}

describe("fetchWmtsCanvas coverage", () => {
  it("skips tiles outside the layer's data box", async () => {
    const urls = [];
    vi.stubGlobal("Image", class {
      set src(u) { urls.push(u); setTimeout(() => this.onload?.(), 0); }
    });
    // Eastern edge of the view extent: overlaps plan col 3 at z7, which has no data.
    await fetchWmtsCanvas(
      { west: 1_200_000, east: 1_280_000, south: 6_100_000, north: 6_180_000 },
      "plan",
    );
    expect(urls.length).toBeGreaterThan(0);
    expect(requestedTiles(urls).some((t) => t.startsWith("7/3/"))).toBe(false);
  });

  it("still returns a canvas when a tile fails to load", async () => {
    vi.stubGlobal("Image", class {
      set src(_u) { setTimeout(() => this.onerror?.(), 0); }
    });
    const canvas = await fetchWmtsCanvas(
      { west: 900_000, east: 901_000, south: 6_400_000, north: 6_401_000 },
      "ortho",
    );
    expect(canvas.width).toBeGreaterThan(0);
  });
});
