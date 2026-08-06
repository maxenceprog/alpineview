import * as THREE from "three";
import geoConstants from "../../geo_constants.json";
import { onTracesChanged, paintTraces, tileNeedsRedrape } from "./gpxPainter.js";
import { buildVerticalDiffuseMaterial, disposeLayerMaterials, replaceMeshMaterial } from "./layers.js";
import { localToWork } from "./terrainPack.js";
import { applySkirtAndNormals } from "./tileSkirtAndNormals.js";
import { fetchWmtsTile, mercBounds, peekPlaceholderTile } from "./wmts.js";
import { WORK_TO_MERC } from "./workFrame.js";

const CELL_LEVEL = geoConstants.cell_level.value;

const TILE_KEY_RE = /(\d+)\.(\d+)\/(\d+)\/(\d+)\.(\d+)\.glb(?:$|\?)/;

function tileKeyFromUrl(url) {
  const m = TILE_KEY_RE.exec(url);
  if (!m) return null;
  const [cx, cy, level, x, y] = m.slice(1).map(Number);
  return { z: CELL_LEVEL + level, x: (cx << level) + x, y: (cy << level) + y };
}

const _box = new THREE.Box3();
const _tileBox = new THREE.Box3();
const _toLocal = new THREE.Matrix4();

function tightenTileHeight(tile, scene) {
  const obb = tile.engineData?.boundingVolume?.obb;
  if (!obb) return;

  scene.updateMatrixWorld(true);
  _tileBox.makeEmpty();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    _toLocal.multiplyMatrices(obb.inverseTransform, o.matrixWorld);
    _tileBox.union(_box.copy(o.geometry.boundingBox).applyMatrix4(_toLocal));
  });
  if (_tileBox.isEmpty()) return;

  obb.box.min.z = _tileBox.min.z;
  obb.box.max.z = _tileBox.max.z;
  obb.update();
}

const meshes = new Map();
let redrawView = null;

onTracesChanged((prev, next) => {
  const pending = [];
  for (const [mesh, tileKey] of meshes) {
    if (tileNeedsRedrape(prev, next, tileKey)) pending.push(drapeMesh(mesh, tileKey, redrawView));
  }
  Promise.all(pending).then(() => redrawView?.()).catch(() => redrawView?.());
});

const _vertex = new THREE.Vector3();

function bakeUVs(mesh, x, y, z) {
  const { x0, y0, s } = mercBounds(z, x, y);
  const pos = mesh.geometry.attributes.position;
  const uv = new Float32Array(pos.count * 2);

  for (let i = 0; i < pos.count; i++) {
    _vertex.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).applyMatrix4(localToWork);
    uv[i * 2] = (_vertex.x * WORK_TO_MERC - x0) / s;
    uv[i * 2 + 1] = (_vertex.y * WORK_TO_MERC - y0) / s;
  }

  mesh.geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

function applyBitmap(mesh, bitmap) {
  if (!bitmap) {
    replaceMeshMaterial(mesh, buildVerticalDiffuseMaterial(null));
    return;
  }
  const texture = new THREE.Texture(bitmap);
  texture.needsUpdate = true;
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  replaceMeshMaterial(mesh, buildVerticalDiffuseMaterial(texture));
}

async function drapeMesh(mesh, tileKey, redraw) {
  await applySkirtAndNormals(mesh.geometry);
  if (!mesh.parent) return;

  mesh.updateWorldMatrix(true, false);
  bakeUVs(mesh, tileKey.x, tileKey.y, tileKey.z);

  const placeholder = peekPlaceholderTile(tileKey.x, tileKey.y, tileKey.z);
  if (placeholder) {
    const bitmap = await placeholder;
    if (!mesh.parent) return;
    if (bitmap) {
      applyBitmap(mesh, bitmap);
      redraw();
    }
  }

  const bitmap = await fetchWmtsTile(tileKey.x, tileKey.y, tileKey.z);
  if (!mesh.parent) return;
  applyBitmap(mesh, bitmap ? await paintTraces(bitmap, tileKey) : null);
}

/**
 * Drapes IGN WMTS imagery (ortho or plan) over every mesh an OGC3DTilesLayer
 * loads. Returns refreshTextures() to re-drape the loaded tiles after
 * setMapSource() switches which layer is served.
 */
export function installWmtsDraping(view, tilesLayer) {
  const redraw = () => view.notifyChange(view.camera3D);
  redrawView = redraw;

  tilesLayer.addEventListener("load-model", (e) => {
    const tileKey = tileKeyFromUrl(e.tile.content?.uri ?? "");
    if (!tileKey) {
      console.warn("wmts draping: no tile key for", e.tile.content?.uri);
      return;
    }

    tightenTileHeight(e.tile, e.scene);
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
    Promise.all(loaded.map((mesh) => drapeMesh(mesh, tileKey, redraw))).then(redraw).catch((err) => {
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
      await Promise.all([...meshes].map(([mesh, tileKey]) => drapeMesh(mesh, tileKey, redraw)));
      redraw();
    },
  };
}
