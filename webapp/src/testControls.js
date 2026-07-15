// Dev-only console helpers (npm run test_build_and_serve). Typed in the browser
// console: build(x, y) rebuilds a cell via the /debug/build route, which(lod)
// names the tile at the centre of the screen.
import * as THREE from "three";
import { DRACO_BASE_LEVEL } from "./dracoLayer.js";

export function initTestControls(view) {
  function centerL93() {
    const { width, height } = view.mainLoop.gfxEngine.getWindowSize();
    const p = view.getPickingPositionFromDepth(new THREE.Vector2(width / 2, height / 2));
    if (!p) throw new Error("nothing under the centre of the screen");
    return p;
  }

  window.which = (lod = 0) => {
    const p = centerL93();
    const scale = 2 ** lod;
    const tx = Math.floor((p.x / 1000) * scale);
    const ty = Math.floor((p.y / 1000) * scale);
    const info = {
      tx,
      ty,
      z: lod,
      level: DRACO_BASE_LEVEL + lod,
      tile: `tile.${tx}.${ty}.${lod}.drc`,
      x: p.x / 1000,
      y: p.y / 1000,
      altitude: p.z,
    };
    console.log(`[which] ${info.tile}  x=${info.x.toFixed(3)} y=${info.y.toFixed(3)} km  alt=${p.z.toFixed(1)} m`);
    return info;
  };

  window.build = async (x, y) => {
    if (x == null || y == null) {
      const p = centerL93();
      x = p.x / 1000;
      y = p.y / 1000;
    }
    console.log(`[build] ${x} ${y} (Lambert-93 km)`);
    const res = await fetch(`/debug/build?x=${x}&y=${y}`);
    if (!res.ok) {
      console.error(`[build] ${res.status}: ${await res.text()}`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      console.log(decoder.decode(value, { stream: true }).replace(/\n$/, ""));
    }
    console.log("[build] done");
  };

  console.log("[testControls] build(x, y) and which(lod) available");
}
