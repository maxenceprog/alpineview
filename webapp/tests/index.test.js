import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Window } from "happy-dom";

let document;

beforeAll(() => {
  const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
  const win = new Window();
  win.document.write(html);
  document = win.document;
});

describe("index.html structure", () => {
  it("has a search bar", () => {
    expect(document.getElementById("search-input")).not.toBeNull();
    expect(document.getElementById("search-btn")).not.toBeNull();
  });

  it("has the iTowns viewer container", () => {
    expect(document.getElementById("viewerDiv")).not.toBeNull();
  });

  it("has the environment and layer toggles", () => {
    expect(document.getElementById("env-toggle")).not.toBeNull();
    expect(document.getElementById("layer-toggle")).not.toBeNull();
  });

  it("has the POI info panel", () => {
    expect(document.getElementById("poi-panel")).not.toBeNull();
  });

  it("has no legacy sidebar or layer buttons", () => {
    expect(document.getElementById("sidebar-left")).toBeNull();
    expect(document.querySelector(".layer-btn")).toBeNull();
  });
});
