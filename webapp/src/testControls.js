// Test controls, active only under `npm run test_build_and_serve`:
//   shift + left-click   dump raw COPC points around the click (/debug/copc)
//   ctrl + right-click  rebuild the clicked cell server-side (/debug/build)
//   double-click         force-reload the clicked tile (cache-busting refetch)
// The /debug/* routes exist only in vite.build_and_serve.config.js.
import * as THREE from "three";

import { loadDebugPoints } from "./debugPoints.js";

export function installTestControls({ renderer, scene, tileManager, getCamera }) {
  const canvas = renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downX = 0, downY = 0;

  const toast = document.createElement("div");
  toast.style.cssText =
    "position:fixed; z-index:1000; font-family:monospace; font-size:12px;" +
    "color:#0f0; background:rgba(0,0,0,0.8); padding:4px 8px; border-radius:4px;" +
    "pointer-events:none; opacity:0; transition:opacity .15s;";
  document.body.appendChild(toast);
  let toastTimer = 0;
  function showToast(text, x, y) {
    toast.textContent = text;
    toast.style.left = `${x + 12}px`;
    toast.style.top = `${y + 12}px`;
    toast.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.style.opacity = "0"), 1200);
  }

  function pickTile(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, getCamera());
    return raycaster
      .intersectObjects(scene.children, true)
      .find((h) => h.object.name?.startsWith("tile-") || h.object.name?.startsWith("ph-"));
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button === 2) { downX = e.clientX; downY = e.clientY; }
  });
  // Ctrl + right-click (not drag): rebuild the picked cell server-side
  // (dev-server middleware → alpineview_ewoks.build_one_tile on the ewoksjob worker).
  canvas.addEventListener("pointerup", async (e) => {
    if (e.button !== 2 || !e.ctrlKey) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return; // a drag, not a click
    const hit = pickTile(e.clientX, e.clientY);
    if (!hit) return;

    // Scene units are km, with x=east, y=altitude, z=-north (L93 negated).
    const xKm = hit.point.x;   // L93 easting  (km)
    const yKm = -hit.point.z;  // L93 northing (km)
    const label = `${Math.floor(xKm)} ${Math.floor(yKm)}`;
    showToast(`build ${label} …`, e.clientX, e.clientY);
    const { clientX, clientY } = e;
    try {
      const resp = await fetch(
        `/debug/build?x=${xKm.toFixed(4)}&y=${yKm.toFixed(4)}`,
      );
      const text = await resp.text();
      console.log(`[tile-build ${label}]\n${text}`);
      if (!resp.ok) {
        showToast(`build failed: ${text.slice(0, 80)}`, clientX, clientY);
        return;
      }
      showToast(`build done ${label} — reloading tile`, clientX, clientY);
      // Reload using the web-grid indices baked into the mesh name (the web
      // grid indexes the south edge — don't recompute from L93 here). Works
      // for placeholders too ("ph-..."): the freshly built tile replaces the quad.
      const [, tx, ty, z] = hit.object.name.split("-").slice(0, 4).map(Number);
      tileManager.reloadTile(tx, ty, z);
    } catch (err) {
      showToast(`build error: ${err.message}`, clientX, clientY);
    }
  });
  // Double-click: force-reload the clicked tile (cache-busting refetch).
  canvas.addEventListener("dblclick", (e) => {
    const hit = pickTile(e.clientX, e.clientY);
    if (!hit) return;
    const [, tx, ty, z] = hit.object.name.split("-").map(Number);
    tileManager.reloadTile(tx, ty, z);
    showToast(`reload  ${tx} ${ty} z${z}`, e.clientX, e.clientY);
  });

  // Shift + left-click: read the cached COPC within a 100x100 m bbox around
  // the clicked position and render each point as a classification-colored
  // 1 m sphere (dev-server middleware → laspy).
  let debugCloud = null;
  canvas.addEventListener("click", async (e) => {
    if (!e.shiftKey || e.button !== 0) return;
    const hit = pickTile(e.clientX, e.clientY);
    if (!hit) return;
    // Scene units are km, with x=east, y=altitude, z=-north (L93 negated).
    const xM = hit.point.x * 1000;
    const yM = -hit.point.z * 1000;
    if (debugCloud) {
      scene.remove(debugCloud);
      debugCloud.geometry.dispose();
      debugCloud.material.dispose();
      debugCloud = null;
    }
    showToast(`COPC ${xM.toFixed(0)} ${yM.toFixed(0)} …`, e.clientX, e.clientY);
    try {
      debugCloud = await loadDebugPoints(
        `/debug/copc?x=${xM.toFixed(2)}&y=${yM.toFixed(2)}&bbox=100`,
      );
      if (debugCloud) scene.add(debugCloud);
      showToast(`COPC ${xM.toFixed(0)} ${yM.toFixed(0)} ✓`, e.clientX, e.clientY);
    } catch (err) {
      console.error("debug COPC load failed:", err);
      showToast(`COPC ${xM.toFixed(0)} ${yM.toFixed(0)} ✗`, e.clientX, e.clientY);
    }
  });
}
