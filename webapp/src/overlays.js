import * as THREE from "three";
import * as itowns from "itowns";
import { API_BASE_URL } from "./apiConfig.js";
import { loadCityBuildings } from "./buildings.js";
import { getSunDir } from "./environment.js";

export function cellLazStem(x0, y0) {
  const pad = (n) => String(n).padStart(4, "0");
  return `LHD_FXX_${pad(x0)}_${pad(y0 + 1)}_PTS_LAMB93_IGN69`;
}

const BUILDING_LEVEL = 11;

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

export class BuildingsLayer extends itowns.Layer {
  constructor(id, view) {
    super(id, { source: false });
    this.view = view;
    this.object3d = new THREE.Group();
    this.object3d.name = id;
    this._nodeCells = new Map();
    this._cells = new Map();
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
        if (this._cells.get(cellKey) !== cell) return;
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
