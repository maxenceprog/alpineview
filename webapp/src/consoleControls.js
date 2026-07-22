import * as THREE from "three";
import { API_BASE_URL } from "./apiConfig.js";
import { DRACO_BASE_LEVEL } from "./terrain/grid.js";
import { itownsPlacement } from "./utils.js";


export function initConsoleControls(view) {
  const centerL93 = () => {
    const { width, height } = view.mainLoop.gfxEngine.getWindowSize();
    const p = view.getPickingPositionFromDepth(new THREE.Vector2(width / 2, height / 2));
    if (!p) throw new Error("nothing under the centre of the screen");
    return p;
  };

  const centerCell = () => {
    const p = centerL93();
    return [Math.floor(p.x / 1000), Math.floor(p.y / 1000)];
  };

  window.read_meta = async (x, y, limit = 1) => {
    if (x == null || y == null) [x, y] = centerCell();
    const res = await fetch(`${API_BASE_URL}/meta?x=${x}&y=${y}&limit=${limit}`);
    if (!res.ok) {
      console.error(`[read_meta] ${res.status}: ${await res.text()}`);
      return;
    }
    const { cell, count, entries } = await res.json();
    const name = `tile (${x}, ${y}) = cell (${cell.x_km}, ${cell.y_km})`;
    if (!count) {
      console.log(`[read_meta] no entry for ${name}`);
      return entries;
    }
    for (const entry of entries) {
      const build = entry.build;
      console.group(`${name} — ${entry.date} — returncode ${build.returncode}`);
      console.log("repo_commit:", entry.repo_commit);
      console.log("command:", build.command.join(" "));
      if (build.stdout) console.log(build.stdout);
      if (build.stderr) console.warn(build.stderr);
      console.groupEnd();
    }
    console.log(`[read_meta] ${count} build(s) recorded, showing ${entries.length}`);
    return entries;
  };

  // Same indices as read_meta/reload, so the tile lands under the camera whole.
  window.goto = (x, y) => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    itownsPlacement(view, (tx + 0.5) * 1000, (ty + 0.5) * 1000);
    console.log(`[goto] centre of tile (${tx}, ${ty})`);
  };

  window.reload = (x, y) => {
    const layer = view.getLayerById("draco");
    if (x == null || y == null) [x, y] = centerCell();
    layer.reload(x, y);
    console.log(`[reload] cell (${x}, ${y})`);
  };

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

  window.mem = () => {
    const layer = view.getLayerById("draco");
    const stats = layer.cacheStats();
    const renderer = view.mainLoop.gfxEngine.renderer;
    const mb = (bytes) => +(bytes / 1024 / 1024).toFixed(1);

    console.group(
      `[mem] ${stats.meshes}/${stats.maxMeshes} meshes, ${stats.visible} drawn, ` +
      `${mb(stats.bytes)} MB`,
    );
    console.table(stats.levels.map(({ zoom, meshes, visible, vegetation, bytes }) => ({
      zoom,
      tile: `${2 ** -zoom * 1000} m`,
      meshes,
      drawn: visible,
      vegetation,
      MB: mb(bytes),
      "MB/mesh": +(bytes / meshes / 1024 / 1024).toFixed(2),
    })));
    console.log("gpu:", renderer.info.memory, renderer.info.render);
    if (performance.memory) {
      console.log(
        `js heap: ${mb(performance.memory.usedJSHeapSize)} MB` +
        ` / ${mb(performance.memory.jsHeapSizeLimit)} MB`,
      );
    }
    console.groupEnd();
    return stats;
  };

  console.log(
    "[console] read_meta(x, y), goto(x, y), reload(x, y), which(lod), mem() available",
  );
}
