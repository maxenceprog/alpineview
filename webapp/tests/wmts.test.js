import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/deviceInfo.js", () => ({ IS_MOBILE: false }));

const { fetchWmtsTile, mercBounds } = await import("../src/wmts.js");

function requestedTile(url) {
  const p = new URLSearchParams(url.split("?")[1]);
  return { z: p.get("TILEMATRIX"), x: p.get("TILECOL"), y: p.get("TILEROW"), layer: p.get("LAYER") };
}

const OK = { ok: true, status: 200, blob: () => Promise.resolve({}) };
const NOT_FOUND = { ok: false, status: 404 };
const SERVER_ERROR = { ok: false, status: 500 };

function stubFetch(urls, respond = () => OK) {
  vi.stubGlobal("fetch", (url) => {
    urls.push(url);
    return Promise.resolve(respond(url));
  });
  vi.stubGlobal("createImageBitmap", () => Promise.resolve({}));
}

beforeEach(() => {});
afterEach(() => { vi.unstubAllGlobals(); });

describe("fetchWmtsTile", () => {
  it("requests the exact (x, y, z) key it's given", async () => {
    const urls = [];
    stubFetch(urls);
    await fetchWmtsTile(1057, 736, 11, "ortho");
    expect(urls.length).toBe(1);
    expect(requestedTile(urls[0])).toEqual({ z: "11", x: "1057", y: "736", layer: "ORTHOIMAGERY.ORTHOPHOTOS" });
  });

  it("returns null on a 404 instead of throwing", async () => {
    const urls = [];
    stubFetch(urls, () => NOT_FOUND);
    const bitmap = await fetchWmtsTile(1, 2, 3, "plan");
    expect(bitmap).toBe(null);
  });

  it("throws on a real server error", async () => {
    const urls = [];
    stubFetch(urls, () => SERVER_ERROR);
    await expect(fetchWmtsTile(4, 5, 6, "ortho")).rejects.toThrow();
  });

  it("caches by URL: a second call for the same tile doesn't refetch", async () => {
    const urls = [];
    stubFetch(urls);
    await fetchWmtsTile(10, 20, 7, "ortho");
    await fetchWmtsTile(10, 20, 7, "ortho");
    expect(urls.length).toBe(1);
  });
});

describe("mercBounds", () => {
  it("covers the full Web Mercator extent at level 0", () => {
    const { x0, y0, s } = mercBounds(0, 0, 0);
    expect(x0).toBeCloseTo(-20037508.342789244, 3);
    expect(y0).toBeCloseTo(-20037508.342789244, 3);
    expect(s).toBeCloseTo(2 * 20037508.342789244, 3);
  });

  it("halves in size each level, tiling without gaps", () => {
    const a = mercBounds(5, 3, 3);
    const b = mercBounds(6, 6, 6);
    expect(b.s).toBeCloseTo(a.s / 2, 6);
    expect(b.x0).toBeCloseTo(a.x0, 6);
    expect(b.y0).toBeCloseTo(a.y0 + a.s / 2, 6);
  });
});
