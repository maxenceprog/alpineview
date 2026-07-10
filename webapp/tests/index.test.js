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

  it("has the left sidebar", () => {
    expect(document.getElementById("sidebar-left")).not.toBeNull();
  });

  it("has layer buttons for satellite and cosia", () => {
    const btns = [...document.querySelectorAll(".layer-btn")];
    const layers = btns.map((b) => b.dataset.layer);
    expect(layers).toContain("satellite");
    expect(layers).toContain("cosia");
  });

  it("has no build-btn or poi input", () => {
    expect(document.getElementById("build-btn")).toBeNull();
    expect(document.getElementById("poi")).toBeNull();
  });
});
