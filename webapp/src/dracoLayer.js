import * as itowns from "itowns";
import * as THREE from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { API_BASE_URL } from "./apiConfig.js";
import { processGeometry } from "./geometryWorkerPool.js";
import {
  buildVerticalDiffuseMaterial,
  disposeLayerMaterials,
  replaceMeshMaterial,
} from "./layers.js";
import { fetchWmtsCanvas } from "./wmts.js";

export const DRACO_BASE_LEVEL = 10;
export const DRACO_MAX_Z = 2;
export const DRACO_MIN_Z = 0;

const CRS = "EPSG:2154";

const _loader = new DRACOLoader();
_loader.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);

const _extent = new itowns.Extent(CRS, 0, 0, 0, 0);

const CULL_MARGIN = new THREE.Vector3(40, 40, 80);

function tileKey(tile) {
  const z = tile.zoom - DRACO_BASE_LEVEL;
  const scale = 2 ** z;
  const extent = tile.isExtent ? tile : tile.toExtent(CRS, _extent);
  const tx = Math.round((extent.west / 1000) * scale);
  const ty = Math.round((extent.south / 1000) * scale);
  return { tx, ty, z, ox: Math.floor(tx / scale), oy: Math.floor(ty / scale) };
}

// Positions are km relative to the parent cell origin (ox, oy); the extent is L93 metres,
// and v runs from north down to match the unflipped canvas.
function bakeUVs(geometry, ox, oy, { west, east, south, north }) {
  const pos = geometry.attributes.position.array;
  const count = pos.length / 3;
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    uvs[i * 2] = ((ox + pos[i * 3]) * 1000 - west) / (east - west);
    uvs[i * 2 + 1] = (north - (oy + pos[i * 3 + 1]) * 1000) / (north - south);
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
}

async function loadTileTexture(geometry, { tx, ty, z, ox, oy }) {
  const s = 2 ** -z * 1000;
  const extent = { west: tx * s, east: (tx + 1) * s, south: ty * s, north: (ty + 1) * s };
  const canvas = await fetchWmtsCanvas(extent);
  bakeUVs(geometry, ox, oy, extent);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  return texture;
}

// The API 404s absent tiles; itowns' Fetcher turns that into a plain Error
// carrying the Response. Missing is normal (sparse coverage) — never retry.
function isTileMissing(err) {
  return !!err.isTileMissing || err.response?.status === 404;
}

async function parseDraco(buffer) {
  if (
    buffer.byteLength < 5 ||
    new TextDecoder().decode(new Uint8Array(buffer, 0, 5)) !== "DRACO"
  ) {
    const err = new Error("not a DRACO file");
    err.isTileMissing = true;
    throw err;
  }
  const geometry = await new Promise((resolve, reject) =>
    _loader.parse(buffer, resolve, reject),
  );
  const { positions, normals, bbox } = await processGeometry(
    geometry.getAttribute("position").array,
    geometry.getIndex().array,
    false,
  );
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(bbox[0], bbox[1], bbox[2]),
    new THREE.Vector3(bbox[3], bbox[4], bbox[5]),
  );
  return geometry;
}

async function loadVegetationGeometry({ tx, ty, z }) {
  try {
    const res = await fetch(`${API_BASE_URL}/vegetation/tile.${tx}.${ty}.${z}.veg.drc`);
    if (!res.ok) {
      return null;
    }
    return await parseDraco(await res.arrayBuffer());
  } catch {
    return null;
  }
}

export class DracoTileSource extends itowns.Source {
  constructor(config = {}) {
    super({
      crs: CRS,
      url: `${API_BASE_URL}/tiles/tile.\${x}.\${y}.\${z}.drc`,
      fetcher: itowns.Fetcher.arrayBuffer,
      parser: parseDraco,
      ...config,
    });
    this.isDracoTileSource = true;
    this.isVectorSource = false;
    this.zoom = config.zoom ?? {
      min: DRACO_BASE_LEVEL + DRACO_MIN_Z,
      max: DRACO_BASE_LEVEL + DRACO_MAX_Z,
    };
  }

  handlingError(err) {
    throw err;
  }

  urlFromExtent(tile) {
    const { tx, ty, z } = tileKey(tile);
    return `${API_BASE_URL}/tiles/tile.${tx}.${ty}.${z}.drc`;
  }

  extentInsideLimit(extent, zoom) {
    return zoom >= this.zoom.min && zoom <= this.zoom.max;
  }
}

const cacheKey = ({ tx, ty, z }) => `${tx}.${ty}.${z}`;
const MAX_CACHED_MESHES = 240;

function isWanted(node) {
  return !!node.parent && node.visible;
}

// A requester that went away mid-flight still gets its mesh built: the node replacing it
// wants the same tile, and the fetch and decode are already paid for. Commands still
// queued are dropped by the layer's earlyDropFunction.
const DracoProvider = {
  executeCommand(command) {
    const { layer, extentsSource } = command;
    const tile = extentsSource[0];
    return layer.source.loadData(tile, layer)
      .then((geometry) => layer.convert(geometry, tile))
      .then((mesh) => [mesh]);
  },
};

class TileState {
  constructor() {
    this.pending = false;
    this.finished = false;
    this.errors = 0;
    this.nextTry = 0;
  }

  canTryUpdate() {
    return !this.pending && !this.finished && Date.now() >= this.nextTry;
  }

  newTry() {
    this.pending = true;
  }

  finish() {
    this.pending = false;
    this.finished = true;
  }

  failure(definitive) {
    this.pending = false;
    this.finished = definitive;
    this.errors++;
    this.nextTry = Date.now() + 1000 * Math.min(2 ** this.errors, 60);
    return this.nextTry - Date.now();
  }
}

/**
 * Lidar meshes draped with IGN imagery, riding the planar quadtree: iTowns
 * traverses its tiles, we load `/tiles/tile.{tx}.{ty}.{z}.drc` for the ones in
 * the draco level range and hide the DEM tile each mesh covers.
 */
export class DracoTileLayer extends itowns.GeometryLayer {
  constructor(id, config = {}) {
    const { view, object3d, ...layerConfig } = config;
    super(id, object3d ?? new THREE.Group(), {
      source: new DracoTileSource(),
      ...layerConfig,
    });
    this.isDracoTileLayer = true;
    this.displayed = new Set();
    this._covered = new WeakMap();
    this.meshCache = new Map();
    this.view = view;
    this.protocol = "draco";

    if (view) {
      view.mainLoop.scheduler.addProtocolProvider(this.protocol, DracoProvider);
      this._patchDepthPicking(view);
      this._patchCulling(view);
    }
  }

  _patchCulling(view) {
    const tileLayer = view.tileLayer;
    const box = new THREE.Box3();
    tileLayer.culling = (node, camera) => {
      box.copy(node.obb.box3D);
      box.expandByVector(CULL_MARGIN);
      return !camera.isBox3Visible(box, node.matrixWorld);
    };
  }

  _patchDepthPicking(view) {
    const readDepthBuffer = view.readDepthBuffer.bind(view);
    view.readDepthBuffer = (...args) => {
      const hidden = [];
      for (const node of this.displayed) {
        if (node.material && !node.material.visible) {
          node.material.visible = true;
          hidden.push(node.material);
        }
      }
      const buffer = readDepthBuffer(...args);
      for (const material of hidden) {
        material.visible = false;
      }
      return buffer;
    };
  }

  // itowns detaches a node's children when it is culled or stops subdividing, without
  // disposing them or emitting 'dispose': a mesh outlives its node, and the node replacing
  // it is a new object wanting the same tile. Meshes are therefore kept per tile rather
  // than per node, so panning back does not refetch and redecode. Only orphans are touched
  // here: an update pass may traverse a single subtree, leaving every other node's mesh to
  // hold the state its own update() last gave it.
  preUpdate() {
    for (const mesh of this.meshCache.values()) {
      if (this.isOrphaned(mesh)) {
        mesh.visible = false;
      }
    }
    for (const node of this.displayed) {
      if (!node.parent) {
        this.displayed.delete(node);
      }
    }
  }

  cacheMesh(key, mesh) {
    this.evictOrphanedMeshes();
    mesh.userData.cacheKey = key;
    this.meshCache.set(key, mesh);
    this.object3d.add(mesh);
  }

  attachMeshToNode(node, mesh) {
    node.link[this.id] = mesh;
    mesh.userData.node = node;
    this.markRecentlyUsed(mesh);
  }

  markRecentlyUsed(mesh) {
    this.meshCache.delete(mesh.userData.cacheKey);
    this.meshCache.set(mesh.userData.cacheKey, mesh);
  }

  isOrphaned(mesh) {
    return !mesh.userData.node?.parent;
  }

  evictOrphanedMeshes() {
    for (const [key, mesh] of this.meshCache) {
      if (this.meshCache.size < MAX_CACHED_MESHES) {
        return;
      }
      if (!this.isOrphaned(mesh)) {
        continue;
      }
      this.meshCache.delete(key);
      this.disposeMesh(mesh);
    }
  }

  async convert(geometry, tile) {
    const key = tileKey(tile);
    const texture = await loadTileTexture(geometry, key);
    const mesh = new THREE.Mesh(geometry, buildVerticalDiffuseMaterial(texture));
    mesh.name = `draco-${key.tx}-${key.ty}-${key.z}`;
    mesh.userData.tile = key;
    mesh.layer = this;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.visible = false;
    mesh.position.set(key.ox * 1000, key.oy * 1000, 0);
    mesh.scale.setScalar(1000);
    mesh.updateMatrixWorld();

    if (key.z === DRACO_MAX_Z) {
      this.addVegetation(mesh, key);
    }
    return mesh;
  }

  async addVegetation(tileMesh, key) {
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
    veg.name = `veg-${key.tx}-${key.ty}-${key.z}`;
    veg.layer = this;
    veg.castShadow = true;
    veg.receiveShadow = true;
    tileMesh.add(veg);
    veg.updateMatrixWorld();
    this.view?.notifyChange(this, true);
  }

  isSettled(node, camera) {
    if (this.parent.culling(node, camera)) {
      return true;
    }
    if (node.link[this.id] || node.layerUpdateState[this.id]?.finished) {
      return true;
    }
    return this.subtreeSettled(node, camera);
  }

  subtreeSettled(node, camera) {
    const children = node.children.filter((child) => child.isTileMesh);
    return children.length > 0 &&
      children.every((child) => this.isSettled(child, camera));
  }

  update(context, layer, node) {
    const coveredByAncestor = node.parent ? this._covered.get(node.parent) === true : false;
    const mesh = node.link[this.id];

    const display = !!mesh && node.visible && !coveredByAncestor &&
      (node.material.visible || !this.subtreeSettled(node, context.camera));

    if (mesh) {
      mesh.visible = display;
      this.markRecentlyUsed(mesh);
    }

    const covered = display || coveredByAncestor;
    this._covered.set(node, covered);
    if (covered) {
      node.material.visible = false;
      this.displayed.add(node);
    } else {
      this.displayed.delete(node);
    }

    if (this.frozen || !this.visible || !node.visible) {
      return;
    }

    let state = node.layerUpdateState[this.id];
    if (!state) {
      state = node.layerUpdateState[this.id] = new TileState();
      node.addEventListener("dispose", () => this.removeNodeMesh(node));
    }
    if (!state.canTryUpdate()) {
      return;
    }

    const tiles = node.getExtentsByProjection(this.source.crs) ?? [node.extent];
    if (!this.source.extentInsideLimit(node.extent, tiles[0].zoom)) {
      state.finish();
      return;
    }

    const key = cacheKey(tileKey(tiles[0]));
    const cached = this.meshCache.get(key);
    if (cached) {
      state.finish();
      this.attachMeshToNode(node, cached);
      context.view.notifyChange(this, false);
      return;
    }

    state.newTry();
    return context.scheduler.execute({
      layer: this,
      view: context.view,
      requester: node,
      extentsSource: tiles,
      priority: covered || node.material.visible ? 100 : 10,
      earlyDropFunction: (cmd) => !isWanted(cmd.requester),
    }).then(
      ([mesh]) => {
        state.finish();
        this.cacheMesh(key, mesh);
        if (node.parent) {
          this.attachMeshToNode(node, mesh);
        }
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

  removeNodeMesh(node) {
    const mesh = node.link[this.id];
    this.displayed.delete(node);
    delete node.layerUpdateState[this.id];
    if (!mesh) {
      return;
    }
    delete node.link[this.id];
    if (mesh.userData.node === node) {
      delete mesh.userData.node;
    }
  }

  disposeMesh(mesh) {
    this.meshCache.delete(mesh.userData.cacheKey);
    this.object3d.remove(mesh);
    disposeLayerMaterials(mesh);
    itowns.ObjectRemovalHelper.removeChildrenAndCleanupRecursively(this, mesh);
  }

  async refreshTextures() {
    await Promise.all(this.object3d.children.map(async (mesh) => {
      const texture = await loadTileTexture(mesh.geometry, mesh.userData.tile);
      replaceMeshMaterial(mesh, buildVerticalDiffuseMaterial(texture));
    }));
    this.view?.notifyChange(this, true);
  }
}
