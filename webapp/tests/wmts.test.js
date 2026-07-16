import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/deviceInfo.js", () => ({ IS_MOBILE: false }));

const { fetchWmtsCanvas } = await import("../src/wmts.js");

// happy-dom has no 2D context.
let draws = 0;
HTMLCanvasElement.prototype.getContext = () => ({ drawImage() { draws++; } });

function requestedTiles(urls) {
  return urls.map((u) => {
    const p = new URLSearchParams(u.split("?")[1]);
    return `${p.get("TILEMATRIX")}/${p.get("TILECOL")}/${p.get("TILEROW")}`;
  });
}

const OK = { ok: true, status: 200, blob: () => Promise.resolve({}) };
const NOT_FOUND = { ok: false, status: 404 };
const SERVER_ERROR = { ok: false, status: 500 };

// Each test uses a distinct extent: the module caches tiles by URL across tests.
function stubFetch(urls, respond = () => OK) {
  vi.stubGlobal("fetch", (url) => {
    urls.push(url);
    return Promise.resolve(respond(url));
  });
  vi.stubGlobal("createImageBitmap", () => Promise.resolve({}));
}

beforeEach(() => { draws = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("fetchWmtsCanvas coverage", () => {
  it("skips tiles outside the layer's data box", async () => {
    const urls = [];
    stubFetch(urls);
    // Eastern edge of the view extent: overlaps plan col 3 at z7, which has no data.
    await fetchWmtsCanvas(
      { west: 1_200_000, east: 1_280_000, south: 6_100_000, north: 6_180_000 },
      "plan",
    );
    expect(urls.length).toBeGreaterThan(0);
    expect(requestedTiles(urls).some((t) => t.startsWith("7/3/"))).toBe(false);
  });

  // IGN 404s sea and coverage gaps inside the data box; one must not lose the mosaic.
  it("draws the other tiles when one 404s", async () => {
    const urls = [];
    let first = true;
    stubFetch(urls, () => (first ? ((first = false), NOT_FOUND) : OK));
    const canvas = await fetchWmtsCanvas(
      { west: 900_000, east: 901_000, south: 6_400_000, north: 6_401_000 },
      "ortho",
    );
    expect(urls.length).toBeGreaterThan(1);
    expect(draws).toBe(urls.length - 1);
    expect(canvas.width).toBeGreaterThan(0);
  });

  it("still returns a canvas when a tile fails to load", async () => {
    const urls = [];
    stubFetch(urls, () => SERVER_ERROR);
    const canvas = await fetchWmtsCanvas(
      { west: 902_000, east: 903_000, south: 6_402_000, north: 6_403_000 },
      "ortho",
    );
    expect(draws).toBe(0);
    expect(canvas.width).toBeGreaterThan(0);
  });
});
