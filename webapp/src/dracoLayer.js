import * as itowns from "itowns";
import * as THREE from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { API_BASE_URL } from "./apiConfig.js";
import { IS_MOBILE } from "./deviceInfo.js";
import { processGeometry } from "./geometryWorkerPool.js";
import {
  buildVerticalDiffuseMaterial,
  disposeLayerMaterials,
  MODE_DEPTH,
  MODE_FINAL,
  replaceMeshMaterial,
} from "./layers.js";
import { fetchWmtsCanvas } from "./wmts.js";

export const DRACO_BASE_LEVEL = 10;
export const DRACO_MAX_Z = 3;
export const DRACO_MIN_Z = -2;

const CRS = "EPSG:2154";

const _loader = new DRACOLoader();
_loader.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);

const _extent = new itowns.Extent(CRS, 0, 0, 0, 0);

// Bumped by DracoTileLayer.reload() so a rebuilt tile is refetched past the HTTP cache.
let _cacheBust = 0;
const bustSuffix = () => (_cacheBust ? `?v=${_cacheBust}` : "");

// itowns' PlanarControls STATE.TRAVEL, the animated fly/zoom state.
const CONTROLS_STATE_TRAVEL = 3;

// itowns subdivides on screen-space error scaled by `subdivisionThreshold` (256,
// "the texture size") — a DEM/imagery notion irrelevant to our meshes, which carry
// their own baked texture. We drive subdivision purely off the tile's on-screen
// footprint instead: subdivide once the tile spans more than this many pixels, so a
// level is one halving finer than the screen needs. Higher = coarser, fewer tiles and
// requests; lower = finer, more of both.
const SUBDIVIDE_SCREEN_PX = 384;

const _priorityCenter = new THREE.Vector3();
const _subCenter = new THREE.Vector3();
const _subDim = new THREE.Vector2();

// Meshes can overhang their tile's extent slightly; the extent itself is exact.
const CULL_MARGIN = new THREE.Vector3(40, 40, 0);
// French Alps, Mont Blanc is 4809 m.
const DOMAIN_Z_MIN = 0;
const DOMAIN_Z_MAX = 5000;

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
    const res = await fetch(
      `${API_BASE_URL}/vegetation/tile.${tx}.${ty}.${z}.veg.drc${bustSuffix()}`,
    );
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
    return `${API_BASE_URL}/tiles/tile.${tx}.${ty}.${z}.drc${bustSuffix()}`;
  }

  extentInsideLimit(extent, zoom) {
    return zoom >= this.zoom.min && zoom <= this.zoom.max;
  }
}

const cacheKey = ({ tx, ty, z }) => `${tx}.${ty}.${z}`;
const MAX_CACHED_MESHES = IS_MOBILE ? 50 : 200;

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
      // View.addLayer parks object3d straight in view.scene, where readDepthBuffer —
      // which renders tileLayer.object3d alone — cannot see it.
      view.tileLayer.object3d.add(this.object3d);
      this._patchDepthPicking(view);
      this._patchCulling(view);
      this._patchSubdivision(view);
    }
  }

  // Replace itowns' texture-resolution SSE with a plain screen-footprint test, so the
  // draco meshes subdivide on how big a tile is on screen, not on a 256 px texture size.
  // Drives both real subdivision and the load gate below (both call tileLayer.subdivision).
  _patchSubdivision(view) {
    const tileLayer = view.tileLayer;
    tileLayer.subdivision = (context, layer, node) => {
      if (node.level < layer.minSubdivisionLevel) {
        return true;
      }
      if (node.level >= layer.maxSubdivisionLevel) {
        return false;
      }
      node.extent.planarDimensions(_subDim);
      const groundSize = Math.max(_subDim.x, _subDim.y);
      _subCenter.copy(node.boundingSphere.center).applyMatrix4(node.matrixWorld);
      const distance = Math.max(
        1,
        context.camera.camera3D.position.distanceTo(_subCenter),
      );
      node.screenSize = (context.camera._preSSE * groundSize) / distance;
      return node.screenSize > SUBDIVIDE_SCREEN_PX;
    };
  }

  // A node carrying a mesh has an exact OBB (see syncNodeBBox), so it is culled as-is.
  // Without one, obb.z comes from the DEM's min/max, which XbilParser samples every 8th
  // texel while the geometry draws every 4th: measured on our tiles the drawn surface
  // escapes that box by up to ~1x the tile's own relief — the lid missing summits, the
  // floor sitting up to 1 km above all-NO_DATA blocks floored to 0. No margin fixes a
  // z range that wrong, but the tile's XY extent is exact, so cull on footprint alone
  // and let z span the domain. Goes away with the DEM, once draco covers every level.
  _patchCulling(view) {
    const tileLayer = view.tileLayer;
    const box = new THREE.Box3();
    tileLayer.culling = (node, camera) => {
      box.copy(node.obb.box3D);
      if (!node.link[this.id]) {
        box.min.z = DOMAIN_Z_MIN;
        box.max.z = DOMAIN_Z_MAX;
      }
      box.expandByVector(CULL_MARGIN);
      return !camera.isBox3Visible(box, node.matrixWorld);
    };
  }

  // itowns picks by re-rendering tileLayer.object3d in a depth-encoding mode. Our meshes
  // now live under it (see constructor) and their material honours MODE_DEPTH, so picking
  // reads the lidar surface itself instead of the DEM standing in for it. RenderMode is
  // not exported by itowns, and its push() is only applied to level0Nodes, so the mode is
  // set here directly — the same two lines it would run.
  _patchDepthPicking(view) {
    const readDepthBuffer = view.readDepthBuffer.bind(view);
    view.readDepthBuffer = (...args) => {
      // Vegetation is a MeshStandardMaterial child of its tile mesh: it ignores `mode`
      // and would write colour into the depth buffer. Hiding it also keeps travel on the
      // ground rather than on a treetop.
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
    this.syncNodeBBox(node, mesh);
  }

  // The mesh is the surface itowns culls and subdivides against, so its own bbox is the
  // exact z range — no DEM proxy, no every-8th-texel scan, no max/mean bias. Geometry is
  // km and mesh.scale is 1000; a planar tile's local z is world z, which is why the
  // elevation layer can hand setBBoxZ plain metres too.
  // Re-asserted from update() rather than set once: an ElevationLayer rewrites obb.z from
  // its own texture whenever a tile lands, and this must win.
  syncNodeBBox(node, mesh) {
    const bbox = mesh.geometry.boundingBox;
    if (!bbox) {
      return;
    }
    const min = bbox.min.z * 1000;
    const max = bbox.max.z * 1000;
    if (node.obb.z.min !== min || node.obb.z.max !== max) {
      node.setBBoxZ({ min, max });
    }
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
      this.syncNodeBBox(node, mesh);
    }

    const covered = display || coveredByAncestor;
    this._covered.set(node, covered);
    if (covered) {
      node.material.visible = false;
      this.displayed.add(node);
    } else {
      this.displayed.delete(node);
      // No draco mesh here and none covering from above: draw nothing rather than
      // the flat imagery quadtree tile at sea level. Applies at every level — the
      // coarse far/horizon leaves included — so the ground is draco meshes only,
      // until draco covers levels 0-9 too. iTowns re-asserts material.visible every
      // frame, so this holds without restore logic, same mechanism as `covered`.
      node.material.visible = false;
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

    // itowns will subdivide this node, so its children carry the display and
    // baking its imagery is wasted. Without this gate every ancestor from the
    // draco floor (level 1) up to the display leaf bakes a WMTS canvas on each
    // zoom-in — thousands of tile requests, and the coarse ones stitch huge
    // grids. Only final-LOD leaves (subdivision() == false) fetch; a cached
    // coarser mesh (attached above) still stands in while children load.
    if (this.parent.subdivision(context, this.parent, node)) {
      return;
    }

    // Don't queue new tiles mid-fly: an animated travel sweeps the whole path
    // and would fetch + bake imagery for every tile passed, none of them seen.
    // Cached meshes still render; the destination loads once the travel ends
    // (STATE.TRAVEL === 3, not re-exported from the itowns package root).
    if (this.view?.controls?.state === CONTROLS_STATE_TRAVEL) {
      return;
    }

    // Load nearest first: the scheduler dequeues highest priority first, so use
    // the negated camera distance. Currently-shown tiles get a boost on top, to
    // fill the visible surface ahead of equidistant neighbours off to the side.
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

  reload() {
    _cacheBust = Date.now();
    for (const mesh of [...this.meshCache.values()]) {
      const node = mesh.userData.node;
      if (node) {
        this.removeNodeMesh(node);
      }
      this.disposeMesh(mesh);
    }
    this.meshCache.clear();
    this.displayed.clear();
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
      const texture = await loadTileTexture(mesh.geometry, mesh.userData.tile);
      replaceMeshMaterial(mesh, buildVerticalDiffuseMaterial(texture));
    }));
    this.view?.notifyChange(this, true);
  }
}
