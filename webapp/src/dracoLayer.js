import * as itowns from "itowns";
import * as THREE from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { API_BASE_URL } from "./apiConfig.js";
import { processGeometry } from "./geometryWorkerPool.js";
import {
  buildCanvas,
  buildVerticalDiffuseMaterial,
  disposeLayerMaterials,
  replaceMeshMaterial,
  WMTS_ZOOM_FOR_LOD,
} from "./layers.js";

export const DRACO_BASE_LEVEL = 10;
export const DRACO_MAX_Z = 2;
export const DRACO_MIN_Z = 0;

const CRS = "EPSG:2154";

// buildCanvas only knows the WMTS matrices down to 14.
const MIN_WMTS_ZOOM = 14;

const _loader = new DRACOLoader();
_loader.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);

const _extent = new itowns.Extent(CRS, 0, 0, 0, 0);

// The planar quadtree root is the view extent, so level 10 tiles are the 1 km
// draco grid: level = 10 + z, tx = west_km * 2^z (z < 0 → tiles bigger than a
// km, hence 2 ** z, not 1 << z). `.drc` vertices are relative to the enclosing
// origin cell (ox, oy), in km.
function tileKey(tile) {
  const z = tile.zoom - DRACO_BASE_LEVEL;
  const scale = 2 ** z;
  const extent = tile.isExtent ? tile : tile.toExtent(CRS, _extent);
  const tx = Math.round((extent.west / 1000) * scale);
  const ty = Math.round((extent.south / 1000) * scale);
  return { tx, ty, z, ox: Math.floor(tx / scale), oy: Math.floor(ty / scale) };
}

// One WMTS zoom step per terrain LOD step: a coarse tile covers more ground and
// is only ever seen from far away.
function wmtsZoom(z) {
  return Math.max(MIN_WMTS_ZOOM, WMTS_ZOOM_FOR_LOD[Math.max(z, 0)] + Math.min(z, 0));
}

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

// buildCanvas speaks the legacy km / z=-north frame.
async function loadTileTexture(geometry, { tx, ty, z, ox, oy }) {
  const s = 2 ** -z;
  const bounds = await buildCanvas(
    tx * s, (tx + 1) * s, -(ty + 1) * s, -ty * s, wmtsZoom(z),
  );
  bakeUVs(geometry, ox, oy, bounds);
  const texture = new THREE.CanvasTexture(bounds.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  return texture;
}

// The dev server answers missing tiles with index.html, so a 200 isn't enough.
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
  // Normals + bbox off the main thread; the raw draco frame is already Z-up
  // here, so no legacy rotation.
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

// Crown meshes on the same grid and in the same frame as the z=2 terrain tiles
// (km, relative to the parent 1 km cell), vertex colours baked at build time.
// Best-effort: most tiles have no vegetation, and a missing one is not an error.
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
    // Decoded geometries are owned (and disposed) by the meshes; keeping them
    // in Source's LRU would hand out disposed buffers on a second visit.
    this.isVectorSource = false;
    this.zoom = config.zoom ?? {
      min: DRACO_BASE_LEVEL + DRACO_MIN_Z,
      max: DRACO_BASE_LEVEL + DRACO_MAX_Z,
    };
  }

  urlFromExtent(tile) {
    const { tx, ty, z } = tileKey(tile);
    return `${API_BASE_URL}/tiles/tile.${tx}.${ty}.${z}.drc`;
  }

  extentInsideLimit(extent, zoom) {
    return zoom >= this.zoom.min && zoom <= this.zoom.max;
  }
}

// A node is worth finishing only while it is still in the tree and in the
// frustum (TiledGeometryLayer re-culls node.visible every traversal).
function isWanted(node) {
  return !!node.parent && node.visible;
}

function cancelled() {
  const err = new Error("draco tile no longer needed");
  err.isCancelledCommandException = true;
  return err;
}

// The stock DataSourceProvider only passes extents to the layer, so a command
// can't tell whether its node is still wanted. Draping the imagery (buildCanvas
// + canvas upload) is the expensive, main-thread half of the work: rotating a
// far view queues a burst of tiles that leave the frustum before their turn
// comes, and paying for their drape anyway is what locks up the page.
const DracoProvider = {
  executeCommand(command) {
    const { layer, requester, extentsSource } = command;
    const tile = extentsSource[0];
    return layer.source.loadData(tile, layer).then((geometry) => {
      if (!isWanted(requester)) {
        geometry.dispose();
        throw cancelled();
      }
      return layer.convert(geometry, tile).then((mesh) => [mesh]);
    });
  },
};

// LayerUpdateState isn't part of itowns' public entry point; this is the subset
// of it we need (one try in flight, no retry once the tile is known missing).
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
    this.view = view;
    this.protocol = "draco";

    if (view) {
      view.mainLoop.scheduler.addProtocolProvider(this.protocol, DracoProvider);
      this._patchDepthPicking(view);
    }
  }

  // Depth picking (wheel zoom / smart travel target) re-renders only the DEM
  // tile tree, where the tiles we cover are hidden — un-hide them for the read
  // (DEM and lidar surfaces agree within metres).
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

  async convert(geometry, tile) {
    const key = tileKey(tile);
    const texture = await loadTileTexture(geometry, key);
    const mesh = new THREE.Mesh(geometry, buildVerticalDiffuseMaterial(texture));
    mesh.name = `draco-${key.tx}-${key.ty}-${key.z}`;
    mesh.userData.tile = key;
    mesh.layer = this;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // update() turns it on once the DEM tile it covers is hidden.
    mesh.visible = false;
    mesh.position.set(key.ox * 1000, key.oy * 1000, 0);
    mesh.scale.setScalar(1000);
    mesh.updateMatrixWorld();

    if (key.z === DRACO_MAX_Z) {
      this.addVegetation(mesh, key);
    }
    return mesh;
  }

  // Vegetation rides the finest terrain LOD instead of being placed by camera
  // proximity: as a child of the tile mesh it shares its frame (km, same origin
  // cell), its visibility — so the LOD hold applies to it — and its disposal.
  // Not awaited: the terrain must not wait on it to show.
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

  // A tile is settled once nothing better is still on its way for the ground it
  // covers: it is culled (we never load those, so waiting on one would hold the
  // parent forever — the case of a foreground tile whose siblings are behind
  // the camera), its mesh is in, its `.drc` is known missing, or its own
  // subtree is settled.
  //
  // Culling is re-tested against the current camera rather than read from
  // node.visible: TiledGeometryLayer only refreshes that flag when it reaches
  // the node, which is after the parent has already decided. A child that comes
  // back into the frustum would still look culled for one frame, and the parent
  // would uncover it before its mesh is there — a one-frame flash of bare DEM.
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
    // iTowns hands us parents before children, so the ancestor's decision for
    // this frame is already in.
    const coveredByAncestor = node.parent ? this._covered.get(node.parent) === true : false;
    const mesh = node.link[this.id];

    // Hold the coarse mesh until every finer mesh under it has landed, then
    // swap the whole quad at once — otherwise the DEM (or a half-filled level)
    // shows through during the subdivision.
    const display = !!mesh && node.visible && !coveredByAncestor &&
      (node.material.visible || !this.subtreeSettled(node, context.camera));

    if (mesh) {
      mesh.visible = display;
    }

    // The displayed mesh replaces the DEM tiles it covers, down the subtree.
    // iTowns re-asserts tile visibility every frame, so nothing to restore.
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
      // A detached node is never handed to attached layers again (see
      // GeometryLayer.getObjectToUpdateForAttachedLayers), but iTowns disposes
      // it through ObjectRemovalHelper, which dispatches 'dispose'.
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

    state.newTry();
    return context.scheduler.execute({
      layer: this,
      view: context.view,
      requester: node,
      extentsSource: tiles,
      // Tiles at the display level first — including the ones we hid because a
      // coarser mesh still covers them, since the swap is waiting on those.
      // For the same reason the drop test can't look at material.visible.
      priority: covered || node.material.visible ? 100 : 10,
      earlyDropFunction: (cmd) => !isWanted(cmd.requester),
    }).then(
      ([mesh]) => {
        if (!node.parent) {
          this.disposeMesh(mesh);
          return;
        }
        state.finish();
        node.link[this.id] = mesh;
        this.object3d.add(mesh);
        context.view.notifyChange(this, true);
      },
      (err) => {
        if (err.isCancelledCommandException) {
          state.pending = false;
          return;
        }
        const delay = state.failure(err.isTileMissing || state.errors > 3);
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
    this.disposeMesh(mesh);
  }

  disposeMesh(mesh) {
    this.object3d.remove(mesh);
    // ObjectRemovalHelper only disposes textures held as direct properties of
    // the material. buildVerticalDiffuseMaterial is a ShaderMaterial: its
    // canvas texture hides in uniforms.map, and the material itself is held by
    // two module-level registries (sun direction + brightness) that only
    // disposeLayerMaterials clears — otherwise material, texture and the
    // stitched imagery canvas all stay alive for the life of the page.
    disposeLayerMaterials(mesh);
    itowns.ObjectRemovalHelper.removeChildrenAndCleanupRecursively(this, mesh);
  }

  // Re-drapes every loaded mesh, e.g. after the base map source (ortho/plan)
  // changed.
  async refreshTextures() {
    await Promise.all(this.object3d.children.map(async (mesh) => {
      const texture = await loadTileTexture(mesh.geometry, mesh.userData.tile);
      replaceMeshMaterial(mesh, buildVerticalDiffuseMaterial(texture));
    }));
    this.view?.notifyChange(this, true);
  }
}
