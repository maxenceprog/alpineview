import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCityBuildings } from "../src/buildings.js";
import { loadVegetationTile } from "../src/tileManager.js";

// Empty marker outputs written by the pipeline for cells without buildings
// or vegetation (see alpineview_ewoks/core/buildings.py / vegetation.py):
// a header-only .city.jsonl and zero-byte .veg.drc files.

const EMPTY_CITY_HEADER =
  '{"type":"CityJSON","version":"2.0",' +
  '"transform":{"scale":[0.001,0.001,0.001],"translate":[0,0,0]},' +
  '"CityObjects":{},"vertices":[]}\n';

afterEach(() => vi.unstubAllGlobals());

describe("empty cell outputs", () => {
  it("loadCityBuildings returns null on a header-only .city.jsonl", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, text: async () => EMPTY_CITY_HEADER }));
    expect(await loadCityBuildings("/buildings/x.city.jsonl")).toBeNull();
  });

  it("loadVegetationTile rejects a zero-byte .veg.drc before Draco decode", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }));
    await expect(loadVegetationTile(0, 0, 2)).rejects.toThrow(/not a DRACO file/);
  });

  it("loadVegetationTile rejects a missing tile", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 404 }));
    await expect(loadVegetationTile(0, 0, 2)).rejects.toThrow(/not found/);
  });
});
