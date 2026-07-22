import * as itowns from "itowns";
import * as THREE from "three";
import { API_BASE_URL } from "../apiConfig.js";
import { bomHas, loadBom } from "../bom.js";
import {
  MODE_DEPTH,
  MODE_FINAL,
  buildVerticalDiffuseMaterial,
  disposeLayerMaterials,
  replaceMeshMaterial,
} from "../layers.js";
import {
  DRACO_MAX_ZOOM,

  cacheKey,
  loadTileTexture,
  tileKey,
} from "./grid.js";
import {
  LAYER_MAX_DIFF_ARRAY,
  distanceToTrigMerge,
  gridDiff,
  patchCulling,
  patchSubdivision,
  subtreeSettled,
  wantsFinerLod
} from "./lod.js";
import {
  DracoTileSource,
  TileState,
  bumpCacheBust,
  isTileMissing,
  loadVegetationGeometry,
} from "./tileSource.js";

const MAX_MESHES = Math.ceil(
  4 * Math.PI * LAYER_MAX_DIFF_ARRAY.reduce((total, maxDiff) => total + (0.75 * maxDiff) ** 2, 0),
);

const CAMERA_SETTLE_MS = 250;
const PRUNE_RATIO = 2;

const _priorityCenter = new THREE.Vector3();

function isWanted(node) {
  return !!node.parent && node.visible;
}

function meshMaxElevation(mesh) {
  return (mesh.geometry.boundingBox?.max.z ?? 0) * 1000;
}

function geometryBytes(geometry) {
  let bytes = geometry.index?.array.byteLength ?? 0;
  for (const attribute of Object.values(geometry.attributes)) {
    bytes += attribute.array.byteLength;
  }
  return bytes;
}

const MIPMAP_FACTOR = 4 / 3;

function textureBytes(material) {
  const image = material?.uniforms?.map?.value?.image;
  return image ? image.width * image.height * 4 * MIPMAP_FACTOR : 0;
}

function meshBytes(mesh) {
  let bytes = geometryBytes(mesh.geometry) + textureBytes(mesh.material);
  for (const child of mesh.children) {
    bytes += meshBytes(child);
  }
  return bytes;
}

const DracoProvider = {
  executeCommand(command) {
    const { layer, extentsSource } = command;
    const tile = extentsSource[0];
    return layer.source.loadData(tile, layer)
      .then((geometry) => layer.convert(geometry, tile))
      .then((mesh) => [mesh]);
  },
};

export class DracoTileLayer extends itowns.GeometryLayer {
  constructor(id, config = {}) {
    const { view, object3d, ...layerConfig } = config;
    super(id, object3d ?? new THREE.Group(), {
      source: new DracoTileSource(),
      ...layerConfig,
    });
    this.isDracoTileLayer = true;
    this._covered = new WeakMap();
    this.meshCache = new Map();
    this.view = view;
    this.protocol = "draco";
    this._bomHd = null;
    this._bomLd = null;
    this._bomVegetation = null;
    this._lastMissingDataToast = 0;
    this._lastCameraMove = 0;
    this._settleTimer = null;
    this._cameraPosition = new THREE.Vector3();
    this._cameraQuaternion = new THREE.Quaternion();
    loadBom(`${API_BASE_URL}/tiles/bom_hd.txt`).then((set) => {
      this._bomHd = set;
      view?.notifyChange(this, true);
    });
    loadBom(`${API_BASE_URL}/tiles/bom_ld.txt`).then((set) => {
      this._bomLd = set;
      view?.notifyChange(this, true);
    });
    loadBom(`${API_BASE_URL}/vegetation/bom_vegetation.txt`).then((set) => {
      this._bomVegetation = set;
    });

    if (view) {
      view.mainLoop.scheduler.addProtocolProvider(this.protocol, DracoProvider);
      view.tileLayer.object3d.add(this.object3d);
      this._patchDepthPicking(view);
      patchCulling(this, view);
      patchSubdivision(this, view);
    }
  }

  _patchDepthPicking(view) {
    const readDepthBuffer = view.readDepthBuffer.bind(view);
    view.readDepthBuffer = (...args) => {
      const shown = [];
      for (const mesh of this.object3d.children) {
        mesh.material.mode = MODE_DEPTH;
        for (const child of mesh.children) {
          if (child.visible) {
            child.visible = false;
            shown.push(child);
          }
        }
      }
      const buffer = readDepthBuffer(...args);
      for (const mesh of this.object3d.children) {
        mesh.material.mode = MODE_FINAL;
      }
      for (const child of shown) {
        child.visible = true;
      }
      return buffer;
    };
  }

  readTerrainDepthBuffer(x, y, width, height, buffer) {
    const g = this.view.mainLoop.gfxEngine;
    const shown = [];
    const hiddenLd = [];
    for (const mesh of this.object3d.children) {
      if (mesh.userData.tileInfo.zoom < 0) {
        if (mesh.visible) {
          mesh.visible = false;
          hiddenLd.push(mesh);
        }
        continue;
      }
      mesh.material.mode = MODE_DEPTH;
      for (const child of mesh.children) {
        if (child.visible) {
          child.visible = false;
          shown.push(child);
        }
      }
    }
    buffer = g.renderViewToBuffer(
      { camera: this.view.camera, scene: this.object3d },
      { x, y, width, height, buffer },
    );
    for (const mesh of this.object3d.children) {
      if (mesh.userData.tileInfo.zoom >= 0) mesh.material.mode = MODE_FINAL;
    }
    for (const mesh of hiddenLd) mesh.visible = true;
    for (const child of shown) child.visible = true;
    return buffer;
  }

  meshFor(node) {
    const key = (node.userData.dracoKey ??= cacheKey(tileKey(node.extent)));
    return this.meshCache.get(key);
  }

  preUpdate(context, sources) {
    this._trackCameraMotion(context.camera.camera3D);
    // this.pruneCache();
    const fullPass = sources.has(undefined) || sources.size === 0 ||
      [...sources].some((s) => s.isCamera || s.layer !== this.parent);
    if (fullPass) {
      for (const mesh of this.meshCache.values()) {
        mesh.visible = false;
      }
    }
  }

  cacheStats() {
    const levels = new Map();
    let bytes = 0;
    let visible = 0;
    for (const mesh of this.meshCache.values()) {
      const { zoom } = mesh.userData.tileInfo;
      const size = meshBytes(mesh);
      const level = levels.get(zoom) ??
        { zoom, meshes: 0, visible: 0, vegetation: 0, bytes: 0 };
      level.meshes++;
      level.visible += mesh.visible ? 1 : 0;
      level.vegetation += mesh.children.length;
      level.bytes += size;
      levels.set(zoom, level);
      bytes += size;
      visible += mesh.visible ? 1 : 0;
    }
    return {
      levels: [...levels.values()].sort((a, b) => a.zoom - b.zoom),
      meshes: this.meshCache.size,
      maxMeshes: MAX_MESHES,
      visible,
      bytes,
    };
  }

  get cameraSettled() {
    return Date.now() - this._lastCameraMove >= CAMERA_SETTLE_MS;
  }

  _trackCameraMotion(camera3D) {
    if (
      this._cameraPosition.equals(camera3D.position) &&
      this._cameraQuaternion.equals(camera3D.quaternion)
    ) {
      return;
    }
    this._cameraPosition.copy(camera3D.position);
    this._cameraQuaternion.copy(camera3D.quaternion);
    this._lastCameraMove = Date.now();
    clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(
      () => this.view?.notifyChange(this, false),
      CAMERA_SETTLE_MS,
    );
  }

  cacheMesh(key, mesh) {
    mesh.userData.cacheKey = key;
    this.meshCache.set(key, mesh);
    this.object3d.add(mesh);
    this.evictFarthest();
  }

  syncNodeBBox(node, mesh) {
    const bbox = mesh.geometry.boundingBox;
    if (!bbox) {
      return;
    }
    const min = bbox.min.z * 1000;
    const max = bbox.max.z * 1000;
    node.userData.maxElevation = max;
    if (node.obb.z.min !== min || node.obb.z.max !== max) {
      node.setBBoxZ({ min, max });
    }
  }

  cacheRatio(mesh, camera) {
    const tileInfo = mesh.userData.tileInfo;
    return gridDiff(tileInfo, meshMaxElevation(mesh), camera) /
      distanceToTrigMerge(tileInfo.zoom);
  }

  pruneCache() {
    const camera = this.view?.camera3D;
    if (!camera) {
      return;
    }
    for (const mesh of this.meshCache.values()) {
      if (!mesh.visible && this.cacheRatio(mesh, camera) > PRUNE_RATIO) {
        this.disposeMesh(mesh);
      }
    }
  }

  evictFarthest() {
    const camera = this.view?.camera3D;
    if (!camera) {
      return;
    }
    while (this.meshCache.size > MAX_MESHES) {
      let farthest = null;
      let maxRatio = -1;
      for (const mesh of this.meshCache.values()) {
        if (mesh.visible) {
          continue;
        }
        const ratio = this.cacheRatio(mesh, camera);
        if (ratio > maxRatio) {
          maxRatio = ratio;
          farthest = mesh;
        }
      }
      if (!farthest) {
        return;
      }
      this.disposeMesh(farthest);
    }
  }

  async convert(geometry, tile) {
    const key = tileKey(tile);
    const texture = await loadTileTexture(geometry, key);
    const mesh = new THREE.Mesh(geometry, buildVerticalDiffuseMaterial(texture));
    mesh.name = `draco-${key.tx}-${key.ty}-${key.zoom}`;
    mesh.userData.tileInfo = key;
    mesh.layer = this;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.visible = false;
    mesh.position.set(key.ox * 1000, key.oy * 1000, 0);
    mesh.scale.setScalar(1000);
    mesh.updateMatrixWorld();

    if (key.zoom === DRACO_MAX_ZOOM) {
      this.addVegetation(mesh, key);
    }
    return mesh;
  }

  async addVegetation(tileMesh, key) {
    if (!bomHas(this._bomVegetation, key.ox, key.oy)) {
      return;
    }
    const geometry = await loadVegetationGeometry(key);
    if (!geometry) {
      return;
    }
    if (!tileMesh.layer) {
      geometry.dispose();
      return;
    }
    const veg = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ vertexColors: true }),
    );
    veg.name = `veg-${key.tx}-${key.ty}-${key.zoom}`;
    veg.layer = this;
    veg.castShadow = true;
    veg.receiveShadow = true;
    tileMesh.add(veg);
    veg.updateMatrixWorld();
    this.view?.notifyChange(this, true);
  }

  update(context, layer, node) {
    const coveredByAncestor = node.parent ? this._covered.get(node.parent) === true : false;
    const mesh = this.meshFor(node);
    if (mesh) {
      this.syncNodeBBox(node, mesh);
    }

    const display = !!mesh && node.visible && !coveredByAncestor &&
      (node.material.visible || !subtreeSettled(this, node, context.camera));
    if (display) {
      mesh.visible = true;
    }

    const covered = display || coveredByAncestor;
    this._covered.set(node, covered);
    node.material.visible = false;

    if (this.frozen || !this.visible || !node.visible) {
      return;
    }

    let state = node.layerUpdateState[this.id];
    if (!state) {
      state = node.layerUpdateState[this.id] = new TileState();
    }
    if (!mesh && state.finished && !state.noMesh) {
      state = node.layerUpdateState[this.id] = new TileState();
    }
    if (!state.canTryUpdate()) {
      return;
    }

    const tiles = node.getExtentsByProjection(this.source.crs) ?? [node.extent];
    if (!this.source.extentInsideLimit(node.extent, tiles[0].zoom)) {
      state.finishWithoutMesh();
      return;
    }

    const rawKey = tileKey(tiles[0]);
    const key = cacheKey(rawKey);
    if (this.meshCache.has(key)) {
      state.finish();
      context.view.notifyChange(this, false);
      return;
    }

    if (wantsFinerLod(this, context, this.parent, node)) {
      return;
    }

    _priorityCenter.copy(node.boundingSphere.center).applyMatrix4(node.matrixWorld);
    const distance = context.camera.camera3D.position.distanceTo(_priorityCenter);
    const priority = (covered || node.material.visible ? 1e7 : 0) - distance;

    state.newTry();
    return context.scheduler.execute({
      layer: this,
      view: context.view,
      requester: node,
      extentsSource: tiles,
      priority,
      earlyDropFunction: (cmd) => !isWanted(cmd.requester),
    }).then(
      ([mesh]) => {
        state.finish();
        this.cacheMesh(key, mesh);
        context.view.notifyChange(this, true);
      },
      (err) => {
        if (err.isCancelledCommandException) {
          state.pending = false;
          return;
        }
        const delay = state.failure(isTileMissing(err) || state.errors > 3);
        if (!state.finished) {
          setTimeout(() => context.view.notifyChange(node, false), delay);
        }
      },
    );
  }

  disposeMesh(mesh) {
    const key = mesh.userData.cacheKey;
    this.meshCache.delete(key);
    this.object3d.remove(mesh);
    disposeLayerMaterials(mesh);
    itowns.ObjectRemovalHelper.removeChildrenAndCleanupRecursively(this, mesh);
  }

  reload(x_km, y_km) {
    const inCell = (mesh) =>
      x_km == null ||
      (mesh.userData.tileInfo.ox === x_km && mesh.userData.tileInfo.oy === y_km);
    bumpCacheBust();
    for (const mesh of [...this.meshCache.values()].filter(inCell)) {
      this.disposeMesh(mesh);
    }
    this._covered = new WeakMap();
    this.view?.tileLayer.object3d.traverse((node) => {
      if (node.isTileMesh) {
        delete node.layerUpdateState[this.id];
      }
    });
    this.view?.notifyChange(this, true);
  }

  async refreshTextures() {
    await Promise.all(this.object3d.children.map(async (mesh) => {
      const texture = await loadTileTexture(mesh.geometry, mesh.userData.tileInfo);
      replaceMeshMaterial(mesh, buildVerticalDiffuseMaterial(texture));
    }));
    this.view?.notifyChange(this, true);
  }
}
