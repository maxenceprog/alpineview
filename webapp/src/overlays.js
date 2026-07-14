import * as THREE from "three";
import * as itowns from "itowns";
import { API_BASE_URL } from "./apiConfig.js";
import { loadCityBuildings } from "./buildings.js";
import { getSunDir } from "./environment.js";

// Cell (x0, y0) → source LAZ stem (NW-corner naming: y = y0 + 1 km).
export function cellLazStem(x0, y0) {
  const pad = (n) => String(n).padStart(4, "0");
  return `LHD_FXX_${pad(x0)}_${pad(y0 + 1)}_PTS_LAMB93_IGN69`;
}

// Buildings are keyed to the level-11 (z=1, 500 m) terrain node lifecycle —
// the same node.dispose()-driven pattern dracoLayer.js uses for vegetation —
// instead of a camera-distance proximity overlay. That avoids a real race: a
// camera-driven overlay discards a building the instant its async load
// resolves if the (fast, teleporting) iTowns camera has already drifted out
// of range by then, which a slow legacy fly camera rarely triggered. Tying
// loading to iTowns' own tile residency means a building simply stays for as
// long as iTowns itself keeps that patch of terrain around — no polling, no
// proxy camera, no discard-on-arrival race.
const BUILDING_LEVEL = 11;

// Legacy building meshes are built in the old Y-up/km scene convention (see
// buildings.js). Wrapping in this group reproduces the same conversion
// dracoLayer.js applies to raw .drc geometry — no rotation there because
// draco vertices are already Z-up; here the mesh itself is Y-up, hence the
// rotation.
const UP_AXIS = new THREE.Vector3(0, 0, 1);

function wrapForItowns(mesh) {
  const group = new THREE.Group();
  group.rotation.x = Math.PI / 2;
  group.scale.setScalar(1000);
  group.add(mesh);
  group.updateMatrixWorld(true);
  return group;
}

function disposeGroup(group) {
  group.traverse((obj) => {
    obj.geometry?.dispose();
    obj.material?.dispose();
  });
}

// A 1 km building cell is covered by up to 4 sibling level-11 nodes; loads
// are deduped and refcounted across them so each cell fetches once.
export class BuildingsLayer extends itowns.Layer {
  constructor(id, view) {
    super(id, { source: false });
    this.view = view;
    this.object3d = new THREE.Group();
    this.object3d.name = id;
    this._nodeCells = new Map(); // node.id -> cellKey
    this._cells = new Map(); // cellKey -> { status, group, refCount }
  }

  update(context, layer, node) {
    if (node.level !== BUILDING_LEVEL || this._nodeCells.has(node.id)) return;

    const ox = Math.round(node.extent.west / 1000);
    const oy = Math.round(node.extent.south / 1000);
    const cellKey = `${ox}|${oy}`;
    this._nodeCells.set(node.id, cellKey);

    let cell = this._cells.get(cellKey);
    if (!cell) {
      cell = { status: "loading", group: null, refCount: 0 };
      this._cells.set(cellKey, cell);

      loadCityBuildings(`${API_BASE_URL}/buildings/${cellLazStem(ox, oy)}.city.jsonl`, {
        x0: ox, y0: oy, sunDir: getSunDir(), upAxis: UP_AXIS,
      }).then((mesh) => {
        if (this._cells.get(cellKey) !== cell) return; // evicted while loading
        if (!mesh) { cell.status = "empty"; return; }
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        cell.group = wrapForItowns(mesh);
        cell.status = "done";
        if (cell.refCount > 0) {
          this.object3d.add(cell.group);
          this.view.notifyChange(this.parent ?? this);
        }
      }).catch((err) => {
        console.error("[itowns buildings] loader threw:", err);
        cell.status = "failed";
      });
    }
    cell.refCount++;

    node.addEventListener("dispose", () => {
      this._nodeCells.delete(node.id);
      cell.refCount--;
      if (cell.refCount <= 0) {
        if (cell.group) {
          this.object3d.remove(cell.group);
          disposeGroup(cell.group);
        }
        this._cells.delete(cellKey);
      }
    });

    if (cell.status === "done" && cell.group && !cell.group.parent) {
      this.object3d.add(cell.group);
    }
  }
}
