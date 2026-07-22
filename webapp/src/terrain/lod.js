import * as THREE from "three";
import { bomHas } from "../bom.js";
import { showInfoToast } from "../infoToast.js";
import { DRACO_MAX_ZOOM, DRACO_MIN_ZOOM, tileKey, tileSize } from "./grid.js";

export const LAYER_MAX_DIFF_ARRAY = [5, 4, 4, 3, 2];

export const distanceToTrigSubdivide = (childZoom) =>
  LAYER_MAX_DIFF_ARRAY[
  THREE.MathUtils.clamp(childZoom - DRACO_MIN_ZOOM, 0, LAYER_MAX_DIFF_ARRAY.length - 1)
  ];

export const distanceToTrigMerge = (zoom) => 2 * distanceToTrigSubdivide(zoom);

const CULL_MARGIN = new THREE.Vector3(40, 40, 0);
const SETTLE_CULL_MARGIN = new THREE.Vector3(300, 300, 0);
const DOMAIN_Z_MIN = 0;
const DOMAIN_Z_MAX = 5000;

const MISSING_DATA_MESSAGE = "Pas de données HD disponibles pour cette zone";
const MISSING_DATA_TOAST_COOLDOWN_MS = 5000;

const INCLINATION_WEIGHT_MIN = 0.5;

const _settleBox = new THREE.Box3();
const _cullBox = new THREE.Box3();
const _viewDirection = new THREE.Vector3();

function nodeMaxElevation(node) {
  for (let n = node; n; n = n.parent) {
    const maxElevation = n.userData?.maxElevation;
    if (maxElevation !== undefined) {
      return maxElevation;
    }
  }
  return DOMAIN_Z_MAX;
}

export function gridDiff({ tx, ty, zoom }, maxElevation, camera) {
  const s = tileSize(zoom);
  camera.getWorldDirection(_viewDirection);
  const verticality = Math.abs(_viewDirection.z);
  const horizontalWeight = 1 - verticality * (1 - INCLINATION_WEIGHT_MIN);
  const verticalWeight = 1 - (1 - verticality) * (1 - INCLINATION_WEIGHT_MIN);
  const { position } = camera;
  return Math.hypot(
    horizontalWeight * (tx + 0.5 - position.x / s),
    horizontalWeight * (ty + 0.5 - position.y / s),
    verticalWeight * ((maxElevation - position.z) / s),)
    ;
}

export function wantsFinerLod(dracoLayer, context, layer, node) {
  if (node.level < layer.minSubdivisionLevel) {
    return true;
  }
  if (node.level >= layer.maxSubdivisionLevel) {
    return false;
  }
  const key = tileKey(node.extent);
  const childZoom = key.zoom + 1;
  const camera = context.camera.camera3D;
  const alreadySubdivided = node.children.some((n) => n.layer === layer);
  const wantsFiner =
    gridDiff(key, nodeMaxElevation(node), camera) <= distanceToTrigSubdivide(childZoom);

  if (wantsFiner && !alreadySubdivided) {
    if (childZoom === DRACO_MAX_ZOOM && !dracoLayer.cameraSettled) {
      return false;
    }
    if (!finerDataAvailable(dracoLayer, node)) {
      reportMissingData(dracoLayer);
      return false;
    }
  }
  return wantsFiner;
}

function finerDataAvailable(dracoLayer, node) {
  const key = tileKey(node.extent);
  const childZoom = key.zoom + 1;

  if (childZoom < DRACO_MIN_ZOOM) {
    return true;
  }
  if (childZoom >= 0) {
    return bomHas(dracoLayer._bomHd, key.ox, key.oy);
  }
  return bomHas(dracoLayer._bomLd, Math.floor(key.ox / 4), Math.floor(key.oy / 4));
}

function reportMissingData(dracoLayer) {
  const now = Date.now();
  if (now - dracoLayer._lastMissingDataToast < MISSING_DATA_TOAST_COOLDOWN_MS) {
    return;
  }
  dracoLayer._lastMissingDataToast = now;
  showInfoToast(MISSING_DATA_MESSAGE);
}

export function isSettled(dracoLayer, node, camera) {
  if (isCulledForSettling(dracoLayer, node, camera)) {
    return true;
  }
  if (dracoLayer.meshFor(node) || node.layerUpdateState[dracoLayer.id]?.noMesh) {
    return true;
  }
  return subtreeSettled(dracoLayer, node, camera);
}

function isCulledForSettling(dracoLayer, node, camera) {
  _settleBox.copy(node.obb.box3D);
  if (!dracoLayer.meshFor(node)) {
    _settleBox.min.z = DOMAIN_Z_MIN;
    _settleBox.max.z = DOMAIN_Z_MAX;
  }
  _settleBox.expandByVector(SETTLE_CULL_MARGIN);
  return !camera.isBox3Visible(_settleBox, node.matrixWorld);
}

export function subtreeSettled(dracoLayer, node, camera) {
  const children = node.children.filter((child) => child.isTileMesh);
  return children.length > 0 &&
    children.every((child) => isSettled(dracoLayer, child, camera));
}

export function patchSubdivision(dracoLayer, view) {
  const tileLayer = view.tileLayer;
  tileLayer.subdivision = (context, layer, node) => {
    if (wantsFinerLod(dracoLayer, context, layer, node)) {
      return true;
    }
    const alreadySubdivided = node.children.some((n) => n.layer === layer);
    const ready = !!dracoLayer.meshFor(node) ||
      !!node.layerUpdateState[dracoLayer.id]?.noMesh;
    return alreadySubdivided && !ready;
  };
}

export function patchCulling(dracoLayer, view) {
  const tileLayer = view.tileLayer;
  tileLayer.culling = (node, camera) => {
    _cullBox.copy(node.obb.box3D);
    if (!dracoLayer.meshFor(node)) {
      _cullBox.min.z = DOMAIN_Z_MIN;
      _cullBox.max.z = DOMAIN_Z_MAX;
    }
    _cullBox.expandByVector(CULL_MARGIN);
    return !camera.isBox3Visible(_cullBox, node.matrixWorld);
  };
}
