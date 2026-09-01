import * as THREE from "three";
import geoConstants from "../../geo_constants.json";
import { onTracesChanged } from "./gpxPainter.js";
import { buildVerticalDiffuseMaterial, disposeLayerMaterials, replaceMeshMaterial } from "./layers.js";
import { localToWork } from "./terrainPack.js";
import { applySkirtAndNormals } from "./tileSkirtAndNormals.js";
import { WMTS_SOURCE_MAX_ZOOM, mercBounds } from "./wmts.js";
import { currentMapSource, peekWmtsTexture, repaintTraces, wmtsTexture } from "./wmtsTextures.js";
import { WORK_TO_MERC } from "./workFrame.js";

const CELL_LEVEL = geoConstants.cell_level.value;

const TILE_KEY_RE = /(\d+)\.(\d+)\/(\d+)\/(\d+)\.(\d+)\.glb(?:$|\?)/;

function tileKeyFromUrl(url) {
  const m = TILE_KEY_RE.exec(url);
  if (!m) return null;
  const [cx, cy, level, x, y] = m.slice(1).map(Number);
  return { z: CELL_LEVEL + level, x: (cx << level) + x, y: (cy << level) + y };
}

const meshes = new Map();

const _vertex = new THREE.Vector3();

function bakeUVs(mesh, key) {
  const { x0, y0, s } = mercBounds(key.z, key.x, key.y);
  const transform = mesh.userData.tileTransform;
  const pos = mesh.geometry.attributes.position;
  const uv = new Float32Array(pos.count * 2);

  for (let i = 0; i < pos.count; i++) {
    _vertex.fromBufferAttribute(pos, i).applyMatrix4(transform).applyMatrix4(localToWork);
    uv[i * 2] = (_vertex.x * WORK_TO_MERC - x0) / s;
    uv[i * 2 + 1] = (_vertex.y * WORK_TO_MERC - y0) / s;
  }

  mesh.geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

function applyTexture(mesh, key, texture) {
  const tag = key && `${key.z}/${key.x}/${key.y}`;
  if (tag && mesh.userData.uvKey !== tag) {
    bakeUVs(mesh, key);
    mesh.userData.uvKey = tag;
  }
  replaceMeshMaterial(mesh, buildVerticalDiffuseMaterial(texture));
}

async function prepareMesh(mesh, tileKey, transform) {
  mesh.userData.tileTransform = transform;
  await applySkirtAndNormals(mesh.geometry, tileKey.z <= WMTS_SOURCE_MAX_ZOOM);

  const placeholder = peekWmtsTexture(tileKey.x, tileKey.y, tileKey.z);
  if (placeholder) applyTexture(mesh, placeholder.key, placeholder.texture);
}

const meshPrepPlugin = {
  name: "wmts-mesh-prep",
  init(tiles) {
    this.tiles = tiles;
  },
  async processTileModel(scene, tile) {
    const tileKey = tileKeyFromUrl(tile.content?.uri ?? "");
    if (!tileKey) return;

    const transform = new THREE.Matrix4().multiplyMatrices(tile.engineData.transform, this.tiles._upRotationMatrix);
    const meshesToPrep = [];
    scene.traverse((o) => {
      if (o.isMesh) meshesToPrep.push(o);
    });
    await Promise.all(meshesToPrep.map((mesh) => prepareMesh(mesh, tileKey, transform)));
  },
};

async function drapeMesh(mesh, tileKey) {
  const sourceKey = currentMapSource();
  const source = wmtsTexture(tileKey.x, tileKey.y, tileKey.z, sourceKey);
  if (!source) {
    applyTexture(mesh, null, null);
    return;
  }
  const texture = await source.texture;
  if (mesh.parent && currentMapSource() === sourceKey) applyTexture(mesh, source.key, texture);
}

/**
 * Drapes IGN WMTS imagery (ortho or plan) over every mesh an OGC3DTilesLayer
 * loads. Returns refreshTextures() to re-drape the loaded tiles after
 * setMapSource() switches which layer is served.
 */
export function installWmtsDraping(view, tilesLayer) {
  const redraw = () => view.notifyChange(view.camera3D);

  onTracesChanged(() => repaintTraces().then(redraw, redraw));

  tilesLayer.tilesRenderer.registerPlugin(meshPrepPlugin);

  tilesLayer.addEventListener("load-model", (e) => {
    const tileKey = tileKeyFromUrl(e.tile.content?.uri ?? "");
    if (!tileKey) {
      console.warn("wmts draping: no tile key for", e.tile.content?.uri);
      return;
    }

    const loaded = [];
    e.scene.traverse((o) => {
      if (o.isMesh) {
        o.frustumCulled = false;
        o.castShadow = true;
        o.receiveShadow = true;
        meshes.set(o, tileKey);
        loaded.push(o);
      }
    });
    Promise.all(loaded.map((mesh) => drapeMesh(mesh, tileKey))).then(redraw).catch((err) => {
      console.warn("wmts draping failed", err);
    });
  });

  tilesLayer.addEventListener("dispose-model", (e) => {
    e.scene.traverse((o) => {
      if (!o.isMesh || !meshes.delete(o)) return;
      disposeLayerMaterials(o);
    });
  });

  return {
    async refreshTextures() {
      await Promise.all([...meshes].map(([mesh, tileKey]) => drapeMesh(mesh, tileKey)));
      redraw();
    },
  };
}
