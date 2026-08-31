import * as THREE from "three";
import { describe, expect, it } from "vitest";

globalThis.__API_BASE_URL__ = "";
const { cumulativeDist, parseGpx, pointAt } = await import("../src/gpsCamera.js");

const GPX = `<?xml version="1.0"?>
<gpx version="1.1">
  <trk><trkseg>
    <trkpt lat="44.92" lon="6.35"><ele>3000</ele></trkpt>
    <trkpt lat="44.93" lon="6.36"><ele>3100</ele></trkpt>
  </trkseg>
  <trkseg>
    <trkpt lat="45.0" lon="6.4"/>
  </trkseg></trk>
</gpx>`;

describe("parseGpx", () => {
  it("keeps segments of at least two points, with elevation defaulting to 0", () => {
    const segs = parseGpx(GPX);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual([
      { lat: 44.92, lon: 6.35, ele: 3000 },
      { lat: 44.93, lon: 6.36, ele: 3100 },
    ]);
  });

  it("falls back to route points when there is no track", () => {
    const segs = parseGpx(`<gpx><rte>
      <rtept lat="1" lon="2"/><rtept lat="3" lon="4"/>
    </rte></gpx>`);
    expect(segs[0].map((p) => p.ele)).toEqual([0, 0]);
    expect(segs[0][1]).toEqual({ lat: 3, lon: 4, ele: 0 });
  });

  it("rejects garbage", () => {
    expect(() => parseGpx("not xml at all <")).toThrow();
  });
});

describe("pointAt", () => {
  const points = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(30, 0, 30),
    new THREE.Vector3(30, 40, 130),
  ];
  const cumDist = cumulativeDist(points);

  it("measures distance horizontally only", () => {
    expect(cumDist).toEqual([0, 30, 70]);
  });

  it("interpolates along the segment and clamps outside the track", () => {
    expect(pointAt(points, cumDist, 15).toArray()).toEqual([15, 0, 15]);
    expect(pointAt(points, cumDist, 50).toArray()).toEqual([30, 20, 80]);
    expect(pointAt(points, cumDist, -5).toArray()).toEqual([0, 0, 0]);
    expect(pointAt(points, cumDist, 999).toArray()).toEqual([30, 40, 130]);
  });
});
