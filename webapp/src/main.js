import { DebugTilesPlugin } from "3d-tiles-renderer/plugins";
import * as itowns from "itowns";
import * as THREE from "three";
import { initEnvironment } from "./environment.js";
import { initBuildings } from "./overlays.js";
import { initPoi } from "./poi.js";
import { TILESET_URL, terrainPackPlugin } from "./terrainPack.js";
import { installWmtsDraping } from "./tilesTexture.js";
import { initTouchControls } from "./touchControls.js";
import { initUi } from "./ui.js";
import { itownsPlacement } from "./utils.js";

itowns.CRS.defs(
  "EPSG:2154",
  "+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs",
);

const extent = new itowns.Extent("EPSG:2154", 256000, 1280000, 5952000, 6976000);

const viewerDiv = document.getElementById("viewerDiv");
const params = new URLSearchParams(location.search);
const x = 1000 * (parseFloat(params.get("x")) || 954.6);
const y = 1000 * (parseFloat(params.get("y")) || 6438.5);

const PLANAR_CONTROLS = {
  minZenithAngle: 5,
  maxZenithAngle: 130,
  maxAltitude: 10000,
  zoomFactor: 1.4,
};

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const view = new itowns.View("EPSG:2154", viewerDiv);
const dim = extent.planarDimensions();
view.camera3D.near = 0.1;
view.camera3D.far = 2 * Math.max(dim.x, dim.y);
view.camera3D.fov = 60;
view.camera3D.updateProjectionMatrix();
itownsPlacement(view, x, y);
view.controls = new itowns.PlanarControls(view, PLANAR_CONTROLS);

window.view = view;

initTouchControls(view);

itowns.enableDracoLoader(`${import.meta.env.BASE_URL}draco/`);
const tilesLayer = new itowns.OGC3DTilesLayer("terrain3d", {
  source: new itowns.OGC3DTilesSource({ url: TILESET_URL }),
  sseThreshold: 10,
});
// itowns' OGC3DTilesLayer already registers the stock plugin under this same
// name; invokeOnePlugin stops at the first match, so it must go before ours
// registers or GeometricErrorSUBTREELoader never runs.
// tilesLayer.tilesRenderer.unregisterPlugin("IMPLICIT_TILING_PLUGIN");
// tilesLayer.tilesRenderer.registerPlugin(new ImplicitTilingPlugin());
tilesLayer.tilesRenderer.registerPlugin(terrainPackPlugin);
const debugTiles = new DebugTilesPlugin({ displayBoxBounds: params.has("boxes") });
tilesLayer.tilesRenderer.registerPlugin(debugTiles);
tilesLayer.tilesRenderer.addEventListener("tile-load-error", (e) => {
  console.warn("tile-load-error", e.url, e.error?.message ?? e.error);
});
view.addLayer(tilesLayer);

window.tilesLayer = tilesLayer;

// The tiles are the ground, so they answer every question the controls ask of
// the terrain: depth picking, the drop test under a travel target, and the
// occlusion test behind POI labels.
const _pickCoords = new THREE.Vector2();
view.getPickingPositionFromDepth = (mouseCoords, target = new THREE.Vector3()) => {
  const coords = mouseCoords ?? _pickCoords.set(viewerDiv.clientWidth / 2, viewerDiv.clientHeight / 2);
  const hits = tilesLayer.pickObjectsAt(view, coords);
  if (!hits.length) return undefined;
  return target.copy(hits[0].point);
};

{
  let lastMouseEvent = null;
  window.addEventListener("mousedown", (e) => { lastMouseEvent = e; }, true);
  const pickIsUsable = (event) => {
    if (!event) return false;
    const picked = view.getPickingPositionFromDepth(view.eventToViewCoords(event));
    return picked !== undefined && picked.z > 1;
  };
  const { initiateZoom } = view.controls;
  view.controls.initiateZoom = (event) => {
    if (pickIsUsable(event)) initiateZoom.call(view.controls, event);
  };

  // PlanarControls drags by unprojecting the mouse onto a horizontal plane at
  // the grabbed point's altitude. Near-horizontal views make that ray almost
  // parallel to the plane, so a few pixels become kilometres (and past the
  // horizon the delta flips sign). Cap the per-frame step to a fraction of the
  // camera's height above terrain.
  const { initiateDrag, handleDragMovement } = view.controls;
  const _dragBefore = new THREE.Vector3();
  const _dragStep = new THREE.Vector3();
  let dragStepCap = Infinity;
  view.controls.initiateDrag = function () {
    initiateDrag.call(this);
    const ground = terrainZAt(this.camera.position.x, this.camera.position.y);
    const height = ground === null ? this.camera.position.z : this.camera.position.z - ground;
    dragStepCap = 0.25 * Math.max(height, 10);
  };
  view.controls.handleDragMovement = function () {
    _dragBefore.copy(this.camera.position);
    handleDragMovement.call(this);
    _dragStep.subVectors(this.camera.position, _dragBefore);
    if (_dragStep.length() > dragStepCap) {
      this.camera.position.copy(_dragBefore).add(_dragStep.setLength(dragStepCap));
    }
  };

  const _ray = new THREE.Raycaster();
  const _down = new THREE.Vector3(0, 0, -1);
  const terrainZAt = (x, y) => {
    _ray.set(new THREE.Vector3(x, y, 5000), _down);
    const hits = _ray.intersectObject(tilesLayer.object3d, true);
    return hits.length ? hits[0].point.z : null;
  };

  view.controls.initiateSmartTravel = (event) => {
    const e = event ?? lastMouseEvent;
    if (!pickIsUsable(e)) return;
    const controls = view.controls;
    const target = view.getPickingPositionFromDepth(view.eventToViewCoords(e));

    const dir = target.clone().sub(view.camera3D.position);
    dir.z = 0;
    dir.normalize();
    const distance = view.camera3D.position.distanceTo(target);
    const height = THREE.MathUtils.lerp(
      controls.smartTravelHeightMin,
      controls.smartTravelHeightMax,
      Math.min(distance / 5000, 1),
    );

    const moveTarget = target.clone();
    if (controls.enableRotation) moveTarget.add(dir.multiplyScalar(-height * 2));
    moveTarget.z = target.z + height;

    const terrainAtEnd = terrainZAt(moveTarget.x, moveTarget.y);
    if (terrainAtEnd !== null) {
      moveTarget.z = Math.max(moveTarget.z, terrainAtEnd + controls.smartTravelHeightMin);
    }

    view.camera3D.position.copy(moveTarget);
    view.camera3D.lookAt(target);
    view.camera3D.updateMatrixWorld(true);
    view.notifyChange(view.camera3D);
  };
}

const { setSunDate, setEnabled, setShadowsEnabled } = initEnvironment(view);
const { refreshTextures } = installWmtsDraping(view, tilesLayer);

view.addFrameRequester(itowns.MAIN_LOOP_EVENTS.BEFORE_RENDER, () => {
  const { downloadQueue, parseQueue, processNodeQueue } = tilesLayer.tilesRenderer;
  if (downloadQueue?.running || parseQueue?.running || processNodeQueue?.running) {
    view.notifyChange(tilesLayer);
  }
});

initBuildings(view);
initPoi(view, tilesLayer);

initUi(view, { setSunDate, setEnabled, setShadowsEnabled, refreshTextures });

// Debug helper: jump to wherever the tileset actually is, whatever the placement.
window.frameTileset = () => {
  const sphere = new THREE.Sphere();
  if (!tilesLayer.tilesRenderer.getBoundingSphere(sphere)) return;
  const { center, radius } = sphere;
  view.camera3D.position.set(center.x, center.y - radius * 2, center.z + radius * 2);
  view.camera3D.lookAt(center);
  view.camera3D.updateMatrixWorld(true);
  view.notifyChange(view.camera3D);
  console.log("tileset sphere", center.toArray().map(Math.round), "r", Math.round(radius));
};

// Implicit quadtree subdivision scales only the x/y axes of the root bounding
// box, so every tile inherits the root's full z extent no matter how deep it
// sits. boxes() shows it: a tile's declared volume against the mesh actually in
// it. ?boxes=1 draws them, window.toggleBoxes() flips it at runtime.
window.toggleBoxes = () => {
  debugTiles.displayBoxBounds = !debugTiles.displayBoxBounds;
  view.notifyChange(view.camera3D);
  return debugTiles.displayBoxBounds;
};

window.boxReport = () => {
  const declared = new THREE.Box3();
  const rows = [];
  tilesLayer.tilesRenderer.traverse((tile) => {
    const scene = tile.engineData && tile.engineData.scene;
    if (!scene || !tile.engineData.boundingVolume) return;
    tile.engineData.boundingVolume.getAABB(declared);
    const d = declared.getSize(new THREE.Vector3());
    const a = new THREE.Box3().setFromObject(scene).getSize(new THREE.Vector3());
    rows.push({
      uri: tile.content && tile.content.uri,
      ge: Number(tile.geometricError.toFixed(2)),
      boxW: Math.round(d.x),
      boxH: Math.round(d.z),
      meshH: Math.round(a.z),
      tallerBy: Number((d.z / Math.max(a.z, 1)).toFixed(1)),
      flatness: Number((d.z / Math.max(d.x, 1)).toFixed(1)),
    });
  });
  console.table(rows);
  const n = rows.length;
  if (n) {
    const mean = (k) => (rows.reduce((s, r) => s + r[k], 0) / n).toFixed(1);
    console.log(`${n} loaded tiles: box is on average ${mean("tallerBy")}x taller `
      + `than its mesh, and ${mean("flatness")}x taller than it is wide`);
  }
  return rows.length;
};
