import * as THREE from "three";
import { API_BASE_URL } from "./apiConfig.js";
import { itownsPlacement } from "./utils.js";

// The webapp's one tiling convention: (ix, iy, level), exactly as baked into
// on-disk tile.{ix}.{iy}.{level}.glb names. Only the builder (mesh_lod.cpp,
// tileset_pipeline.py) still deals in the underlying (tx, ty, z) scheme.
const ROOT_X0_KM = 768;
const ROOT_Y0_KM = 6144;

function isAncestor(root, obj) {
  for (let o = obj; o; o = o.parent) if (o === root) return true;
  return false;
}

// Flashes a wireframe box around the tile a few times. A Box3Helper added
// straight to the scene, independent of the tile's own mesh/material, so it
// can't collide with tilesTexture.js's async WMTS material swap.
function blinkScene(view, scene, times = 3, intervalMs = 150) {
  const box = new THREE.Box3().setFromObject(scene);
  const helper = new THREE.Box3Helper(box, 0xff2222);
  const totalSteps = times * 2;
  let step = 0;

  const tick = () => {
    const on = step % 2 === 0;
    if (on) view.scene.add(helper);
    else view.scene.remove(helper);
    view.notifyChange(view.camera3D);
    step++;
    if (step < totalSteps) {
      setTimeout(tick, intervalMs);
    } else {
      view.scene.remove(helper);
      view.notifyChange(view.camera3D);
    }
  };
  tick();
}

export function initConsoleControls(view) {
  const centerCoords = () => {
    const { width, height } = view.mainLoop.gfxEngine.getWindowSize();
    return new THREE.Vector2(width / 2, height / 2);
  };

  const centerL93 = () => {
    const p = view.getPickingPositionFromDepth(centerCoords());
    if (!p) throw new Error("nothing under the centre of the screen");
    return p;
  };

  // (ix, iy) of the 1 km cell (level 9) under the crosshair.
  const centerCell = () => {
    const p = centerL93();
    return [Math.floor(p.x / 1000) - ROOT_X0_KM, Math.floor(p.y / 1000) - ROOT_Y0_KM];
  };

  window.read_meta = async (ix, iy, limit = 1) => {
    if (ix == null || iy == null) [ix, iy] = centerCell();
    const tx = ix + ROOT_X0_KM;
    const ty = iy + ROOT_Y0_KM;
    const res = await fetch(`${API_BASE_URL}/meta?x=${tx}&y=${ty}&limit=${limit}`);
    if (!res.ok) {
      console.error(`[read_meta] ${res.status}: ${await res.text()}`);
      return;
    }
    const { cell, count, entries } = await res.json();
    const name = `tile (${ix}, ${iy}) = cell (${cell.x_km}, ${cell.y_km})`;
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

  // Same indices as read_meta, so the tile lands under the camera whole.
  window.goto = (ix, iy) => {
    const tx = Math.floor(ix) + ROOT_X0_KM;
    const ty = Math.floor(iy) + ROOT_Y0_KM;
    itownsPlacement(view, (tx + 0.5) * 1000, (ty + 0.5) * 1000);
    console.log(`[goto] centre of tile (${ix}, ${iy})`);
  };

  // Whatever tile is actually rendered under the crosshair right now -- no
  // level argument, no guessing: pick the real geometry, resolve it back to
  // the loaded tile that owns it, and blink that exact mesh.
  window.which = () => {
    const layer = view.getLayerById("terrain3d");
    const hits = layer.pickObjectsAt(view, centerCoords());
    if (!hits.length) throw new Error("nothing under the centre of the screen");
    const { point, object } = hits[0];

    let matched = null;
    layer.tilesRenderer.forEachLoadedModel((scene, tile) => {
      if (!matched && isAncestor(scene, object)) matched = { scene, tile };
    });
    if (!matched) {
      console.log("[which] picked geometry isn't tracked by any loaded tile");
      return undefined;
    }

    const { level, x: ix, y: iy } = matched.tile.implicitTilingData;
    const info = {
      level,
      ix,
      iy,
      tile: matched.tile.content?.uri ?? `tile.${ix}.${iy}.${level}.glb`,
      xKm: point.x / 1000,
      yKm: point.y / 1000,
      altitude: point.z,
    };
    console.log(`[which] ${info.tile}  x=${info.xKm.toFixed(3)} y=${info.yKm.toFixed(3)} km  alt=${point.z.toFixed(1)} m`);
    blinkScene(view, matched.scene);
    return info;
  };

  window.mem = () => {
    const tilesRenderer = view.getLayerById("terrain3d").tilesRenderer;
    const stats = tilesRenderer.stats;
    const renderer = view.mainLoop.gfxEngine.renderer;
    const mb = (bytes) => +(bytes / 1024 / 1024).toFixed(1);

    console.group(
      `[mem] ${stats.visible} tiles drawn, ${stats.active} active, ` +
      `${stats.inCache}/${tilesRenderer.lruCache.maxSize} cached`,
    );
    console.log("tiles:", stats);
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
    "[console] read_meta(ix, iy), goto(ix, iy), which(), mem() available",
  );
}
