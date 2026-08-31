import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/deviceInfo.js", () => ({ IS_MOBILE: false }));

const { mercBounds } = await import("../src/wmts.js");
const { wmtsTexture } = await import("../src/wmtsTextures.js");

function requestedTile(url) {
  const p = new URLSearchParams(url.split("?")[1]);
  return { z: p.get("TILEMATRIX"), x: p.get("TILECOL"), y: p.get("TILEROW"), layer: p.get("LAYER") };
}

const OK = { ok: true, status: 200, blob: () => Promise.resolve({}) };
const NOT_FOUND = { ok: false, status: 404 };

function stubFetch(urls, respond = () => OK) {
  vi.stubGlobal("fetch", (url) => {
    urls.push(url);
    return Promise.resolve(respond(url));
  });
  vi.stubGlobal("createImageBitmap", () => Promise.resolve({ width: 256, height: 256 }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("wmtsTexture", () => {
  it("fetches one level coarser, so one source tile serves four terrain tiles", async () => {
    const urls = [];
    stubFetch(urls);
    const source = wmtsTexture(1057, 736, 11, "ortho");
    await source.texture;
    expect(urls.length).toBe(1);
    expect(requestedTile(urls[0])).toEqual({ z: "10", x: "528", y: "368", layer: "ORTHOIMAGERY.ORTHOPHOTOS" });
    expect(source.key).toEqual({ z: 10, x: 528, y: 368 });
  });

  it("gives the four terrain tiles of one source tile the same texture", async () => {
    const urls = [];
    stubFetch(urls);
    const textures = await Promise.all([
      wmtsTexture(2000, 1500, 11, "ortho").texture,
      wmtsTexture(2001, 1500, 11, "ortho").texture,
      wmtsTexture(2000, 1501, 11, "ortho").texture,
      wmtsTexture(2001, 1501, 11, "ortho").texture,
    ]);
    expect(urls.length).toBe(1);
    expect(new Set(textures).size).toBe(1);
  });

  it("returns the key of the source tile, not of the tile asked for", () => {
    stubFetch([]);
    expect(wmtsTexture(4000, 3000, 20, "plan").key).toEqual({ z: 17, x: 500, y: 375 });
  });

  it("rejects on a 404 and drops the entry, so a later call retries", async () => {
    const urls = [];
    stubFetch(urls, () => NOT_FOUND);
    await expect(wmtsTexture(1, 2, 3, "plan").texture).rejects.toThrow();
    await expect(wmtsTexture(1, 2, 3, "plan").texture).rejects.toThrow();
    expect(urls.length).toBe(2);
  });

  it("serves nothing when the map source is off", () => {
    stubFetch([]);
    expect(wmtsTexture(10, 20, 7, "none")).toBe(null);
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
