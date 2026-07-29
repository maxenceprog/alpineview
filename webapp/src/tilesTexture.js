import * as THREE from "three";
import { buildVerticalDiffuseMaterial, disposeLayerMaterials, replaceMeshMaterial } from "./layers.js";
import { applySkirtAndNormals } from "./tileSkirtAndNormals.js";
import { fetchWmtsCanvas } from "./wmts.js";

const _box = new THREE.Box3();
const _vertex = new THREE.Vector3();
const _tileBox = new THREE.Box3();
const _meshBox = new THREE.Box3();
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
    _tileBox.union(_meshBox.copy(o.geometry.boundingBox).applyMatrix4(_toLocal));
  });
  if (_tileBox.isEmpty()) return;

  obb.box.min.z = _tileBox.min.z;
  obb.box.max.z = _tileBox.max.z;
  obb.update();
}

// The glTF carries neither UVs nor an extent: both are derived from where the
// mesh actually lands in L93, so the canvas covers exactly its footprint and the
// UVs map straight against it.
function meshExtent(mesh) {
  mesh.updateWorldMatrix(true, false);
  _box.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
  return { west: _box.min.x, east: _box.max.x, south: _box.min.y, north: _box.max.y };
}

function bakeUVs(mesh, { west, east, south, north }) {
  const pos = mesh.geometry.attributes.position;
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    _vertex.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    uvs[i * 2] = (_vertex.x - west) / (east - west);
    uvs[i * 2 + 1] = (north - _vertex.y) / (north - south);
  }
  mesh.geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
}

async function drapeMesh(mesh) {
  await applySkirtAndNormals(mesh.geometry);
  if (!mesh.parent) return;
  mesh.geometry.computeBoundingBox();

  const extent = meshExtent(mesh);
  bakeUVs(mesh, extent);
  const canvas = await fetchWmtsCanvas(extent);
  if (!mesh.parent) return;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  replaceMeshMaterial(mesh, buildVerticalDiffuseMaterial(texture));
}

/**
 * Drapes IGN WMTS imagery (ortho or plan) over every mesh an OGC3DTilesLayer
 * loads. Returns refreshTextures() to re-drape the loaded tiles after
 * setMapSource() switches which layer is served.
 */
export function installWmtsDraping(view, tilesLayer) {
  const meshes = new Set();

  const redraw = () => view.notifyChange(view.camera3D);

  tilesLayer.addEventListener("load-model", (e) => {
    tightenTileHeight(e.tile, e.scene);
    const loaded = [];
    e.scene.traverse((o) => {
      if (o.isMesh) {
        o.frustumCulled = false;
        o.castShadow = true;
        o.receiveShadow = true;
        meshes.add(o);
        loaded.push(o);
      }
    });
    Promise.all(loaded.map(drapeMesh)).then(redraw).catch((err) => {
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
      await Promise.all([...meshes].map(drapeMesh));
      redraw();
    },
  };
}
