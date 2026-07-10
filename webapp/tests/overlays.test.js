import { describe, it, expect } from "vitest";
import { CellOverlay, cellLazStem } from "../src/overlays.js";

// Minimal fakes so CellOverlay can run without three.js / a real scene.
function makeScene() {
  const c = new Set();
  return { add: (o) => c.add(o), remove: (o) => c.delete(o), has: (o) => c.has(o), get size() { return c.size; } };
}
function makeObj() {
  return { geometry: { dispose() {} }, material: { dispose() {} }, traverse(cb) { cb(this); } };
}
const cam = (cx, cy, ch = 0) => ({ position: { x: cx, y: ch, z: -cy } });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("cellLazStem", () => {
  it("maps a cell (x0,y0) to its NW-corner LAZ stem (y = y0+1)", () => {
    expect(cellLazStem(965, 6430)).toBe("LHD_FXX_0965_6431_PTS_LAMB93_IGN69");
  });
  it("zero-pads to 4 digits", () => {
    expect(cellLazStem(932, 6437)).toBe("LHD_FXX_0932_6438_PTS_LAMB93_IGN69");
  });
});

describe("CellOverlay", () => {
  it("does nothing while disabled", async () => {
    const scene = makeScene();
    const ov = new CellOverlay(scene, { radiusKm: 0.6, load: async () => makeObj() });
    ov.update(cam(965.5, 6430.5));
    await flush();
    expect(scene.size).toBe(0);
  });

  it("loads and adds the nearby cell when enabled", async () => {
    const scene = makeScene();
    const obj = makeObj();
    const ov = new CellOverlay(scene, { radiusKm: 0.6, load: async () => obj });
    ov.setEnabled(true);
    ov.update(cam(965.5, 6430.5));
    await flush();
    expect(scene.has(obj)).toBe(true);
    expect([...ov.objects()]).toEqual([obj]);
  });

  it("disposing/disabling clears loaded objects", async () => {
    const scene = makeScene();
    const ov = new CellOverlay(scene, { radiusKm: 0.6, load: async () => makeObj() });
    ov.setEnabled(true);
    ov.update(cam(965.5, 6430.5));
    await flush();
    expect(scene.size).toBe(1);
    ov.setEnabled(false);
    expect(scene.size).toBe(0);
  });

  it("remembers empty cells but retries after a toggle off/on", async () => {
    const scene = makeScene();
    let calls = 0;
    const ov = new CellOverlay(scene, { radiusKm: 0.6, load: async () => { calls++; return null; } });
    ov.setEnabled(true);
    ov.update(cam(965.5, 6430.5));
    await flush();
    ov.update(cam(965.5, 6430.5)); // still empty → no refetch
    await flush();
    expect(calls).toBe(1);

    ov.setEnabled(false); // clears the empty memory
    ov.setEnabled(true);
    ov.update(cam(965.5, 6430.5));
    await flush();
    expect(calls).toBe(2); // retried now that the cell is no longer marked empty
  });
});
