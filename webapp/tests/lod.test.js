import { describe, expect, it, vi } from "vitest";

vi.mock("../src/bom.js", () => ({ bomHas: () => true, loadBom: async () => new Set() }));

const { distanceToTrigSubdivide, wantsFinerLod } = await import("../src/terrain/lod.js");
const { DRACO_BASE_LEVEL } = await import("../src/terrain/grid.js");

const layer = { minSubdivisionLevel: 0, maxSubdivisionLevel: 12 };
const SETTLED = { cameraSettled: true };
const MOVING = { cameraSettled: false };

const MAX_DIFF_TO_Z1 = distanceToTrigSubdivide(1);
const MAX_DIFF_TO_Z2 = distanceToTrigSubdivide(2);

function makeNode(zoom, tx, ty, maxElevation) {
  const s = 2 ** -zoom * 1000;
  return {
    level: DRACO_BASE_LEVEL + zoom,
    extent: {
      isExtent: true,
      zoom: DRACO_BASE_LEVEL + zoom,
      west: tx * s,
      south: ty * s,
    },
    userData: { maxElevation },
    children: [],
    parent: null,
  };
}

const HORIZONTAL = [1, 0, 0];
const NADIR = [0, 0, -1];

const at = (x, y, z, direction = HORIZONTAL) => ({
  camera: {
    camera3D: {
      position: { x, y, z },
      getWorldDirection: (target) => target.set(...direction),
    },
  },
});

const CAMERA = at(23340, 12230, 3200);
const CAM_CELL = { 0: [23, 12], 1: [46, 24] };

function eastOf(zoom, cells) {
  const [cx, cy] = CAM_CELL[zoom];
  return makeNode(zoom, cx + cells, cy, 3200);
}

describe("wantsFinerLod grid rule", () => {
  it("subdivides while the tile centre is inside its level's radius", () => {
    const origin = at(0, 0, 0);
    for (const zoom of [-1, 0, 1]) {
      const maxDiff = distanceToTrigSubdivide(zoom + 1);
      expect(wantsFinerLod(SETTLED, origin, layer, makeNode(zoom, maxDiff - 1, 0, 0)))
        .toBe(true);
      expect(wantsFinerLod(SETTLED, origin, layer, makeNode(zoom, maxDiff, 0, 0)))
        .toBe(false);
    }
  });

  it("accepts a 500 m tile one cell away", () => {
    expect(wantsFinerLod(SETTLED, CAMERA, layer, makeNode(1, 47, 24, 3030))).toBe(true);
  });

  it("holds the finest level to a tighter radius than the level above", () => {
    expect(MAX_DIFF_TO_Z2).toBeLessThan(MAX_DIFF_TO_Z1);
    expect(wantsFinerLod(SETTLED, CAMERA, layer, eastOf(1, MAX_DIFF_TO_Z2))).toBe(true);
    expect(wantsFinerLod(SETTLED, CAMERA, layer, eastOf(1, MAX_DIFF_TO_Z2 + 1)))
      .toBe(false);
    expect(wantsFinerLod(SETTLED, CAMERA, layer, eastOf(0, MAX_DIFF_TO_Z1 - 1)))
      .toBe(true);
  });

  it("withholds the finest level while the camera moves, but keeps existing children", () => {
    expect(wantsFinerLod(MOVING, CAMERA, layer, eastOf(1, MAX_DIFF_TO_Z2))).toBe(false);

    const subdivided = eastOf(1, MAX_DIFF_TO_Z2);
    subdivided.children = [{ layer }];
    expect(wantsFinerLod(MOVING, CAMERA, layer, subdivided)).toBe(true);
  });

  it("still subdivides coarser levels while the camera moves", () => {
    expect(wantsFinerLod(MOVING, CAMERA, layer, eastOf(0, MAX_DIFF_TO_Z1 - 1))).toBe(true);
  });

  it("refuses a tile once the camera climbs far enough above it", () => {
    const high = at(23340, 12230, 7030);
    expect(wantsFinerLod(SETTLED, high, layer, makeNode(1, 47, 24, 3030))).toBe(false);
  });

  it("falls back to the parent's maxElevation when the node has none", () => {
    const node = makeNode(1, 47, 24, undefined);
    node.parent = { userData: { maxElevation: 3030 } };
    expect(wantsFinerLod(SETTLED, CAMERA, layer, node)).toBe(true);
  });

  it("widens the horizontal reach when the camera looks down", () => {
    const beyond = () => makeNode(0, 23 + MAX_DIFF_TO_Z1 + 1, 12, 3200);
    expect(wantsFinerLod(SETTLED, CAMERA, layer, beyond())).toBe(false);

    const down = at(23340, 12230, 3200, NADIR);
    expect(wantsFinerLod(SETTLED, down, layer, beyond())).toBe(true);
  });

  it("weighs elevation more heavily when the camera looks down", () => {
    const above = () => makeNode(1, 46, 24, 4600);
    expect(wantsFinerLod(SETTLED, CAMERA, layer, above())).toBe(true);

    const down = at(23340, 12230, 3200, NADIR);
    expect(wantsFinerLod(SETTLED, down, layer, above())).toBe(false);
  });

  it("never subdivides past maxSubdivisionLevel, however close the camera", () => {
    const node = makeNode(2, 93, 48, 3200);
    expect(wantsFinerLod(SETTLED, CAMERA, { ...layer, maxSubdivisionLevel: node.level }, node))
      .toBe(false);
  });
});
