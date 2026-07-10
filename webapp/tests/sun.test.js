import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { sunDirection, sunDirectionAt } from "../src/sun.js";

describe("sunDirection (SunCalc v2: degrees, azimuth from North CW)", () => {
  it("zenith (altitude=90°) points straight up", () => {
    const d = sunDirection(90, 0);
    expect(d.y).toBeCloseTo(1, 5);
    expect(Math.abs(d.x)).toBeLessThan(1e-4);
    expect(Math.abs(d.z)).toBeLessThan(1e-4);
  });

  it("horizon south (altitude=0, azimuth=180°) points +Z (south)", () => {
    const d = sunDirection(0, 180);
    expect(d.z).toBeCloseTo(1, 5);
    expect(d.y).toBeCloseTo(0, 5);
    expect(d.x).toBeCloseTo(0, 5);
  });

  it("horizon east (altitude=0, azimuth=90°) points +X (east)", () => {
    const d = sunDirection(0, 90);
    expect(d.x).toBeCloseTo(1, 5);
    expect(d.y).toBeCloseTo(0, 5);
  });

  it("horizon west (altitude=0, azimuth=270°) points -X (west)", () => {
    const d = sunDirection(0, 270);
    expect(d.x).toBeCloseTo(-1, 5);
  });

  it("horizon north (altitude=0, azimuth=0°) points -Z (north)", () => {
    const d = sunDirection(0, 0);
    expect(d.z).toBeCloseTo(-1, 5);
  });

  it("returns a unit vector", () => {
    const d = sunDirection(35, 200);
    expect(d.length()).toBeCloseTo(1, 5);
  });

  it("below horizon has negative y", () => {
    const d = sunDirection(-10, 180);
    expect(d.y).toBeLessThan(0);
  });
});

describe("sunDirectionAt", () => {
  const SUMMER_NOON = new Date("2025-06-21T12:00:00Z");
  const GRENOBLE_BBOX = { minLon: 5.72, minLat: 45.18, maxLon: 5.73, maxLat: 45.19 };

  it("returns a THREE.Vector3", () => {
    const d = sunDirectionAt(SUMMER_NOON, GRENOBLE_BBOX);
    expect(d).toBeInstanceOf(THREE.Vector3);
  });

  it("summer noon in Grenoble: sun is above horizon", () => {
    const d = sunDirectionAt(SUMMER_NOON, GRENOBLE_BBOX);
    expect(d.y).toBeGreaterThan(0);
  });

  it("winter midnight in Grenoble: sun is below horizon", () => {
    const midnight = new Date("2025-12-21T00:00:00Z");
    const d = sunDirectionAt(midnight, GRENOBLE_BBOX);
    expect(d.y).toBeLessThan(0);
  });

  it("falls back to default location when bbox is null", () => {
    expect(() => sunDirectionAt(SUMMER_NOON, null)).not.toThrow();
  });
});
