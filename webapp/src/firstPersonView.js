import * as itowns from "itowns";
import * as THREE from "three";
import { IS_MOBILE } from "./deviceInfo.js";
import { clampCameraZenith } from "./utils.js";

const EYE_HEIGHT = 1.7;
const HEIGHTMAP_TILE_GRID_SIZE = 16;
const ADJACENCY_MARGIN_M = 1;
const MOVE_SPEED = 8;
const SPRINT_MULTIPLIER = 4;
const LOOK_SENSITIVITY = 0.0025;
const MAX_PITCH = THREE.MathUtils.degToRad(150);
const UP = new THREE.Vector3(0, 0, 1);
const JOYSTICK_RADIUS = 50;
const TOUCH_LOOK_SPEED = 0.8;

function createStaticJoystick(side) {
  const base = document.createElement("div");
  base.style.cssText = `position:fixed;bottom:25vh;${side}:32px;width:${JOYSTICK_RADIUS * 2}px;
    height:${JOYSTICK_RADIUS * 2}px;border-radius:50%;background:rgba(255,255,255,0.15);
    border:2px solid rgba(255,255,255,0.4);touch-action:none;z-index:1000;`;
  const knob = document.createElement("div");
  knob.style.cssText = `position:absolute;left:50%;top:50%;width:${JOYSTICK_RADIUS}px;height:${JOYSTICK_RADIUS}px;
    border-radius:50%;background:rgba(255,255,255,0.5);transform:translate(-50%,-50%);`;
  base.appendChild(knob);
  document.body.appendChild(base);

  const state = { vecX: 0, vecY: 0 };
  let pointerId = null;

  const onDown = (e) => {
    if (pointerId !== null) return;
    pointerId = e.pointerId;
    base.setPointerCapture(pointerId);
  };
  const onMove = (e) => {
    if (e.pointerId !== pointerId) return;
    const rect = base.getBoundingClientRect();
    const dx = THREE.MathUtils.clamp(e.clientX - (rect.left + rect.width / 2), -JOYSTICK_RADIUS, JOYSTICK_RADIUS);
    const dy = THREE.MathUtils.clamp(e.clientY - (rect.top + rect.height / 2), -JOYSTICK_RADIUS, JOYSTICK_RADIUS);
    knob.style.left = `${JOYSTICK_RADIUS + dx}px`;
    knob.style.top = `${JOYSTICK_RADIUS + dy}px`;
    state.vecX = dx / JOYSTICK_RADIUS;
    state.vecY = dy / JOYSTICK_RADIUS;
  };
  const onUp = (e) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    state.vecX = 0;
    state.vecY = 0;
    knob.style.left = "50%";
    knob.style.top = "50%";
  };
  base.addEventListener("pointerdown", onDown);
  base.addEventListener("pointermove", onMove);
  base.addEventListener("pointerup", onUp);
  base.addEventListener("pointercancel", onUp);

  return { state, destroy: () => base.remove() };
}

function nearestCellHeight(grid, x, y) {
  const { originX, originY, cellSize, gridSize, heights } = grid;
  const gx = THREE.MathUtils.clamp(Math.floor((x - originX) / cellSize), 0, gridSize - 1);
  const gy = THREE.MathUtils.clamp(Math.floor((y - originY) / cellSize), 0, gridSize - 1);
  const h = heights[gy * gridSize + gx];
  return Number.isFinite(h) ? h : null;
}

function boxesAdjacent(a, b, margin) {
  const dx = Math.max(a.min.x - b.max.x, b.min.x - a.max.x);
  const dy = Math.max(a.min.y - b.max.y, b.min.y - a.max.y);
  return dx <= margin && dy <= margin;
}

export async function enterFirstPerson(view, tilesLayer, spawnPoint) {
  const camera = view.camera3D;
  const tilesRenderer = tilesLayer.tilesRenderer;

  const controlsWereEnabled = view.controls.enabled !== false;
  view.controls.enabled = false;
  view.removeFrameRequester(itowns.MAIN_LOOP_EVENTS.AFTER_CAMERA_UPDATE, view.controls._handlerUpdate);

  let playerX = spawnPoint.x;
  let playerY = spawnPoint.y;
  let cameraZ = spawnPoint.z + EYE_HEIGHT;

  const worker = new Worker(new URL("./heightmapWorker.js", import.meta.url), { type: "module" });
  const pendingJobs = new Map();
  let nextJobId = 0;
  worker.onmessage = (e) => {
    const { id, ...grid } = e.data;
    const mesh = pendingJobs.get(id);
    pendingJobs.delete(id);
    if (mesh) mesh.userData.heightGrid = grid;
  };

  function requestHeightGrid(mesh) {
    if (mesh.userData.heightGrid || mesh.userData.heightGridRequested) return;
    mesh.userData.heightGridRequested = true;
    mesh.updateWorldMatrix(true, false);
    const src = mesh.geometry.attributes.position.array;
    const positions = new Float32Array(src.length);
    const v = new THREE.Vector3();
    for (let i = 0; i < src.length; i += 3) {
      v.set(src[i], src[i + 1], src[i + 2]).applyMatrix4(mesh.matrixWorld);
      positions[i] = v.x;
      positions[i + 1] = v.y;
      positions[i + 2] = v.z;
    }
    const id = nextJobId++;
    pendingJobs.set(id, mesh);
    worker.postMessage({ id, positions, gridSize: HEIGHTMAP_TILE_GRID_SIZE }, [positions.buffer]);
  }

  function worldBoxOf(mesh) {
    if (!mesh.userData.fpWorldBox) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      mesh.updateWorldMatrix(true, false);
      mesh.userData.fpWorldBox = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    }
    return mesh.userData.fpWorldBox;
  }

  let lastMesh = null;
  function meshAt(x, y) {
    if (lastMesh) {
      const box = worldBoxOf(lastMesh);
      if (x >= box.min.x && x <= box.max.x && y >= box.min.y && y <= box.max.y) return lastMesh;
    }

    let best = null;
    let bestArea = Infinity;
    tilesRenderer.forEachLoadedModel((scene) => {
      scene.traverse((mesh) => {
        if (!mesh.isMesh) return;
        const box = worldBoxOf(mesh);
        if (x < box.min.x || x > box.max.x || y < box.min.y || y > box.max.y) return;
        const area = (box.max.x - box.min.x) * (box.max.y - box.min.y);
        if (area < bestArea) {
          best = mesh;
          bestArea = area;
        }
      });
    });
    lastMesh = best;
    return best;
  }

  function neighborsOf(mesh) {
    if (!mesh.userData.fpNeighbors) {
      const box = worldBoxOf(mesh);
      const area = (box.max.x - box.min.x) * (box.max.y - box.min.y);
      const neighbors = [];
      tilesRenderer.forEachLoadedModel((scene) => {
        scene.traverse((candidate) => {
          if (candidate === mesh || !candidate.isMesh) return;
          const candidateBox = worldBoxOf(candidate);
          const candidateArea = (candidateBox.max.x - candidateBox.min.x) * (candidateBox.max.y - candidateBox.min.y);
          if (candidateArea > area * 1.5) return;
          if (boxesAdjacent(box, candidateBox, ADJACENCY_MARGIN_M)) neighbors.push(candidate);
        });
      });
      mesh.userData.fpNeighbors = neighbors;
    }
    return mesh.userData.fpNeighbors;
  }

  function requestGridForMeshAndNeighbors(mesh) {
    requestHeightGrid(mesh);
    for (const neighbor of neighborsOf(mesh)) requestHeightGrid(neighbor);
  }

  function sampleAt(candidates, x, y) {
    for (const mesh of candidates) {
      const grid = mesh.userData.heightGrid;
      if (!grid) continue;
      const box = worldBoxOf(mesh);
      if (x < box.min.x || x > box.max.x || y < box.min.y || y > box.max.y) continue;
      return nearestCellHeight(grid, x, y);
    }
    return null;
  }

  function heightAt(mesh, x, y) {
    const grid = mesh.userData.heightGrid;
    if (!grid) return null;
    const candidates = [mesh, ...neighborsOf(mesh)];

    const fx = (x - grid.originX) / grid.cellSize - 0.5;
    const fy = (y - grid.originY) / grid.cellSize - 0.5;
    const gx0 = Math.floor(fx);
    const gy0 = Math.floor(fy);
    const tx = fx - gx0;
    const ty = fy - gy0;

    const sampleCorner = (gx, gy) => sampleAt(
      candidates,
      grid.originX + (gx + 0.5) * grid.cellSize,
      grid.originY + (gy + 0.5) * grid.cellSize,
    );

    const h00 = sampleCorner(gx0, gy0);
    const h10 = sampleCorner(gx0 + 1, gy0);
    const h01 = sampleCorner(gx0, gy0 + 1);
    const h11 = sampleCorner(gx0 + 1, gy0 + 1);
    if (h00 === null || h10 === null || h01 === null || h11 === null) return h00 ?? h10 ?? h01 ?? h11;

    const top = h00 + (h10 - h00) * tx;
    const bottom = h01 + (h11 - h01) * tx;
    return top + (bottom - top) * ty;
  }

  const initDir = new THREE.Vector3();
  camera.getWorldDirection(initDir);
  let yaw = Math.atan2(-initDir.x, initDir.y);
  let pitch = 0;

  const keys = new Set();
  const onKeyDown = (e) => {
    keys.add(e.code);
    if (e.code === "Escape") exitFirstPerson();
    if (e.code === "F9") {
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      console.log("camera pos", camera.position.toArray(), "dir", dir.toArray(), "near", camera.near, "far", camera.far);
      const rows = [];
      let visits = 0;
      const RADIUS = 300;
      const visit = (t) => {
        if (++visits > 5000) return;
        const obb = t.engineData?.boundingVolume?.obb;
        const dist = obb ? obb.distanceToPoint(camera.position) : 0;
        if (dist > RADIUS) return;
        if (t.internal?.hasContent) {
          const min = obb.box.min.clone().applyMatrix4(obb.transform);
          const max = obb.box.max.clone().applyMatrix4(obb.transform);
          rows.push({
            depth: t.internal.depth,
            dist: dist.toFixed(1),
            inFrustum: t.traversal?.inFrustum,
            used: t.traversal?.used,
            min: min.toArray().map((v) => v.toFixed(0)).join(","),
            max: max.toArray().map((v) => v.toFixed(0)).join(","),
          });
        }
        (t.children || []).forEach(visit);
      };
      tilesLayer.tilesRenderer.getRoots?.().forEach(visit) ?? visit(tilesLayer.tilesRenderer.root);
      console.log("visited", visits);
      console.table(rows);
    }
  };
  const onKeyUp = (e) => keys.delete(e.code);
  const onMouseMove = (e) => {
    if (document.pointerLockElement !== view.domElement) return;
    yaw -= e.movementX * LOOK_SENSITIVITY;
    pitch = THREE.MathUtils.clamp(pitch - e.movementY * LOOK_SENSITIVITY, -MAX_PITCH, MAX_PITCH);
  };
  const onPointerLockChange = () => {
    if (document.pointerLockElement !== view.domElement) exitFirstPerson();
  };
  const onWheel = () => exitFirstPerson();

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("mousemove", onMouseMove);
  document.addEventListener("pointerlockchange", onPointerLockChange);
  window.addEventListener("wheel", onWheel);

  const moveJoystick = IS_MOBILE ? createStaticJoystick("left") : null;
  const lookJoystick = IS_MOBILE ? createStaticJoystick("right") : null;

  const exitButton = document.createElement("button");
  exitButton.textContent = "Sortir du mode marche";
  exitButton.style.cssText = `position:fixed;top:12px;right:12px;padding:10px 16px;border-radius:8px;
    background:rgba(0,0,0,0.4);color:#fff;border:2px solid rgba(255,255,255,0.4);font-size:16px;
    z-index:1000;${IS_MOBILE ? "" : "display:none;"}`;
  exitButton.addEventListener("click", () => exitFirstPerson());
  document.body.appendChild(exitButton);

  const qYaw = new THREE.Quaternion();
  const qPitch = new THREE.Quaternion();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const move = new THREE.Vector3();

  const onBeforeRender = (dt) => {
    const dtSec = Math.min(dt / 1000, 0.1);

    if (lookJoystick && (lookJoystick.state.vecX || lookJoystick.state.vecY)) {
      yaw -= lookJoystick.state.vecX * TOUCH_LOOK_SPEED * dtSec;
      pitch = THREE.MathUtils.clamp(pitch - lookJoystick.state.vecY * TOUCH_LOOK_SPEED * dtSec, -MAX_PITCH, MAX_PITCH);
    }

    qYaw.setFromAxisAngle(UP, yaw);
    qPitch.setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch);
    camera.quaternion.copy(qYaw).multiply(qPitch);

    const currentMesh = meshAt(playerX, playerY);
    if (currentMesh) requestGridForMeshAndNeighbors(currentMesh);

    if (currentMesh?.userData.heightGrid) {
      forward.set(-Math.sin(yaw), Math.cos(yaw), 0);
      right.set(Math.cos(yaw), Math.sin(yaw), 0);
      move.set(0, 0, 0);
      if (keys.has("KeyW")) move.add(forward);
      if (keys.has("KeyS")) move.sub(forward);
      if (keys.has("KeyD")) move.add(right);
      if (keys.has("KeyA")) move.sub(right);
      if (moveJoystick && (moveJoystick.state.vecX || moveJoystick.state.vecY)) {
        move.addScaledVector(forward, -moveJoystick.state.vecY);
        move.addScaledVector(right, moveJoystick.state.vecX);
      }

      const speed = MOVE_SPEED * (keys.has("ShiftLeft") || keys.has("ShiftRight") ? SPRINT_MULTIPLIER : 1);
      if (move.lengthSq() > 1) move.normalize();
      if (move.lengthSq() > 0) {
        move.multiplyScalar(speed * dtSec);
        playerX += move.x;
        playerY += move.y;
      }

      const groundZ = heightAt(currentMesh, playerX, playerY);
      if (groundZ !== null) cameraZ = groundZ + EYE_HEIGHT;
    }

    camera.position.set(playerX, playerY, cameraZ);
    camera.updateMatrixWorld(true);
    view.notifyChange(camera);
  };

  view.addFrameRequester(itowns.MAIN_LOOP_EVENTS.BEFORE_RENDER, onBeforeRender);
  view.notifyChange(camera);

  let exited = false;
  function exitFirstPerson() {
    if (exited) return;
    exited = true;

    view.removeFrameRequester(itowns.MAIN_LOOP_EVENTS.BEFORE_RENDER, onBeforeRender);
    worker.terminate();
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("pointerlockchange", onPointerLockChange);
    window.removeEventListener("wheel", onWheel);
    moveJoystick?.destroy();
    lookJoystick?.destroy();
    exitButton.remove();
    if (document.pointerLockElement === view.domElement) document.exitPointerLock();

    clampCameraZenith(camera);
    view.addFrameRequester(itowns.MAIN_LOOP_EVENTS.AFTER_CAMERA_UPDATE, view.controls._handlerUpdate);
    view.controls.enabled = controlsWereEnabled;
    view.notifyChange(camera);
  }

  return exitFirstPerson;
}
