import * as itowns from "itowns";
import * as THREE from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { API_BASE_URL } from "../apiConfig.js";
import { processGeometry } from "../geometryWorkerPool.js";
import {
  CRS,
  DRACO_BASE_LEVEL,
  DRACO_MAX_ZOOM,
  DRACO_MIN_ZOOM,
  tileKey,
} from "./grid.js";

const _loader = new DRACOLoader();
_loader.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);

// Bumped by DracoTileLayer.reload() so a rebuilt tile is refetched past the HTTP cache.
let _cacheBust = 0;
const bustSuffix = () => (_cacheBust ? `?v=${_cacheBust}` : "");

export function bumpCacheBust() {
  _cacheBust = Date.now();
}

// The API 404s absent tiles; itowns' Fetcher turns that into a plain Error
// carrying the Response. Missing is normal (sparse coverage) — never retry.
export function isTileMissing(err) {
  return !!err.isTileMissing || err.response?.status === 404;
}

export async function parseDraco(buffer) {
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

export async function loadVegetationGeometry({ tx, ty, zoom }) {
  try {
    const res = await fetch(
      `${API_BASE_URL}/vegetation/tile.${tx}.${ty}.${zoom}.veg.drc${bustSuffix()}`,
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
      min: DRACO_BASE_LEVEL + DRACO_MIN_ZOOM,
      max: DRACO_BASE_LEVEL + DRACO_MAX_ZOOM,
    };
  }

  handlingError(err) {
    throw err;
  }

  urlFromExtent(tile) {
    const { tx, ty, zoom } = tileKey(tile);
    return `${API_BASE_URL}/tiles/tile.${tx}.${ty}.${zoom}.drc${bustSuffix()}`;
  }

  extentInsideLimit(extent, zoom) {
    return zoom >= this.zoom.min && zoom <= this.zoom.max;
  }
}

export class TileState {
  constructor() {
    this.pending = false;
    this.finished = false;
    // Finished and never expected to have a mesh: out of the source's zoom range, or
    // definitively absent (404). Distinguishes those from "loaded, mesh is in the
    // cache" — only the latter may be revived after an eviction.
    this.noMesh = false;
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

  finishWithoutMesh() {
    this.finish();
    this.noMesh = true;
  }

  failure(definitive) {
    this.pending = false;
    this.finished = definitive;
    this.noMesh = definitive;
    this.errors++;
    this.nextTry = Date.now() + 1000 * Math.min(2 ** this.errors, 60);
    return this.nextTry - Date.now();
  }
}
