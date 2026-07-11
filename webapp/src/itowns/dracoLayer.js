import * as itowns from "itowns";
import * as THREE from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { API_BASE_URL } from "../apiConfig.js";
import {
  buildCanvas,
  buildVerticalDiffuseMaterial,
  disposeLayerMaterials,
  replaceMeshMaterial,
  WMTS_ZOOM_FOR_LOD,
} from "../layers.js";

export const DRACO_BASE_LEVEL = 10;
export const DRACO_MAX_Z = 2;

const _loader = new DRACOLoader();
_loader.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);

function bakeUVs(geometry, ox, oy, { xMin, xMax, zMin, zMax }) {
  const pos = geometry.attributes.position.array;
  const count = pos.length / 3;
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    uvs[i * 2] = (ox + pos[i * 3] - xMin) / (xMax - xMin);
    uvs[i * 2 + 1] = (-(oy + pos[i * 3 + 1]) - zMin) / (zMax - zMin);
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
}

async function loadTileTexture(tx, ty, z, geometry, ox, oy) {
  const s = 1 / (1 << z);
  const bounds = await buildCanvas(
    tx * s, (tx + 1) * s, -(ty + 1) * s, -ty * s, WMTS_ZOOM_FOR_LOD[z],
  );
  bakeUVs(geometry, ox, oy, bounds);
  const texture = new THREE.CanvasTexture(bounds.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  return texture;
}

async function loadTileMesh(tx, ty, z) {
  const url = `${API_BASE_URL}/tiles/tile.${tx}.${ty}.${z}.drc`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tile not found: ${url}`);
  const buffer = await res.arrayBuffer();
  if (
    buffer.byteLength < 5 ||
    new TextDecoder().decode(new Uint8Array(buffer, 0, 5)) !== "DRACO"
  ) {
    throw new Error(`not a DRACO file: ${url}`);
  }
  const geometry = await new Promise((resolve, reject) =>
    _loader.parse(buffer, resolve, reject),
  );
  geometry.computeVertexNormals();

  const ox = Math.floor(tx / (1 << z));
  const oy = Math.floor(ty / (1 << z));
  const texture = await loadTileTexture(tx, ty, z, geometry, ox, oy);

  const mesh = new THREE.Mesh(geometry, buildVerticalDiffuseMaterial(texture));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = `draco-${tx}-${ty}-${z}`;
  mesh.position.set(ox * 1000, oy * 1000, 0);
  mesh.scale.setScalar(1000);
  mesh.updateMatrixWorld();
  return mesh;
}

export class DracoTileLayer extends itowns.Layer {
  constructor(id, view) {
    super(id, { source: false });
    this.view = view;
    this.object3d = new THREE.Group();
    this.object3d.name = id;
    this._states = new Map();

    // Depth picking (wheel zoom target) renders only the DEM tile tree, where
    // draco-covered tiles are hidden — un-hide them during the depth read.
    const readDepthBuffer = view.readDepthBuffer.bind(view);
    view.readDepthBuffer = (...args) => {
      const unhidden = [];
      for (const state of this._states.values()) {
        const material = state.node.material;
        if (state.mesh?.visible && material && !material.visible) {
          material.visible = true;
          unhidden.push(material);
        }
      }
      const buffer = readDepthBuffer(...args);
      for (const material of unhidden) material.visible = false;
      return buffer;
    };
  }

  update(context, layer, node) {
    const z = node.level - DRACO_BASE_LEVEL;
    if (z < 0 || z > DRACO_MAX_Z) return;

    let state = this._states.get(node.id);
    if (!state) {
      const tx = Math.round((node.extent.west / 1000) * (1 << z));
      const ty = Math.round((node.extent.south / 1000) * (1 << z));
      state = { status: "loading", mesh: null, node, tx, ty, z };
      this._states.set(node.id, state);
      node.addEventListener("dispose", () => {
        if (state.mesh) {
          this.object3d.remove(state.mesh);
          state.mesh.geometry.dispose();
          disposeLayerMaterials(state.mesh);
        }
        this._states.delete(node.id);
      });

      loadTileMesh(tx, ty, z).then((mesh) => {
        if (!this._states.has(node.id)) {
          mesh.geometry.dispose();
          disposeLayerMaterials(mesh);
          return;
        }
        state.status = "done";
        state.mesh = mesh;
        this.object3d.add(mesh);
        this.view.notifyChange(this.parent ?? this);
      }).catch(() => {
        state.status = "failed";
      });
    }

    if (state.mesh) {
      state.mesh.visible = node.visible && node.material.visible;
      if (state.mesh.visible) node.material.visible = false;
    }
  }

  // Re-fetches the drape texture for every loaded tile mesh, e.g. after the
  // base map source (ortho/plan) changes.
  async refreshTextures() {
    const reloads = [];
    for (const state of this._states.values()) {
      if (state.status !== "done" || !state.mesh) continue;
      const { mesh, tx, ty, z } = state;
      const ox = Math.floor(tx / (1 << z));
      const oy = Math.floor(ty / (1 << z));
      reloads.push(
        loadTileTexture(tx, ty, z, mesh.geometry, ox, oy).then((texture) => {
          replaceMeshMaterial(mesh, buildVerticalDiffuseMaterial(texture));
        }),
      );
    }
    await Promise.all(reloads);
    this.view.notifyChange(this.parent ?? this);
  }
}
