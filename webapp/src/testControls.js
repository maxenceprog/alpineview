// Dev-only console helpers (npm run test_build_and_serve). Typed in the browser
// console: build(x, y) rebuilds a cell via the /debug/build route. Common commands
// (which, goto, reload, read_meta) live in consoleControls.js (available in prod too).
import * as THREE from "three";

export function initTestControls(view) {
  function centerL93() {
    const { width, height } = view.mainLoop.gfxEngine.getWindowSize();
    const p = view.getPickingPositionFromDepth(new THREE.Vector2(width / 2, height / 2));
    if (!p) throw new Error("nothing under the centre of the screen");
    return p;
  }

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

  console.log("[testControls] build(x, y) available");
}
