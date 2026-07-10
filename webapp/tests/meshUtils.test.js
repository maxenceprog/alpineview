import { describe, it, expect } from "vitest";
import { meshNameFromUrl, createEntry, toggleEntry } from "../src/meshUtils.js";

describe("meshNameFromUrl", () => {
  it("strips directory and .ply extension", () => {
    expect(meshNameFromUrl("/api/meshes/0964_6431.final.ply")).toBe(
      "0964_6431.final"
    );
  });

  it("handles url without directory", () => {
    expect(meshNameFromUrl("demo.ply")).toBe("demo");
  });

  it("is case-insensitive for the extension", () => {
    expect(meshNameFromUrl("/meshes/TILE.PLY")).toBe("TILE");
  });
});

describe("createEntry", () => {
  it("creates an entry with visible=true", () => {
    const mesh = { name: "ply-1", visible: true };
    const entry = createEntry(mesh, "My tile");
    expect(entry.visible).toBe(true);
    expect(entry.name).toBe("My tile");
    expect(entry.mesh).toBe(mesh);
  });
});

describe("toggleEntry", () => {
  it("toggles visible from true to false and updates mesh.visible", () => {
    const mesh = { visible: true };
    const entry = createEntry(mesh, "t");
    toggleEntry(entry);
    expect(entry.visible).toBe(false);
    expect(mesh.visible).toBe(false);
  });

  it("toggles visible from false to true", () => {
    const mesh = { visible: true };
    const entry = createEntry(mesh, "t");
    toggleEntry(entry);
    toggleEntry(entry);
    expect(entry.visible).toBe(true);
    expect(mesh.visible).toBe(true);
  });
});
