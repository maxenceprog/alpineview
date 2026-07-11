import * as THREE from "three";
import { buildHeightmap, sampleHeight } from "./heightmap.js";
import { consumePanDelta, consumeOrientDelta, consumeZoomDelta } from "./touchControls.js";

// Scene units = km. Tile occupies roughly [913, 914]² in L93 km coords.
const MOVE_SPEED = 0.03;  // 30 m/s
const SPRINT_MUL = 4;
const SENSITIVITY = 0.002;
const WHEEL_SPEED = 0.003; // ~3 m per scroll tick
const PAN_SPEED = 0.003;
const WALK_HEIGHT = 0.020; // 20 m above ground
const GROUND_CLEARANCE = 0.002; // 2 m hard floor above sampled ground — smoothing
// alone lags behind fast terrain changes (steep
// slopes, LOD swaps) and can let the camera dip
// under the mesh, so this clamps every frame.
const FLY_GROUND_CLEARANCE_KM = 0.01; // 10 m hard floor above sampled ground in fly mode
const FLY_MIN_ALTITUDE_KM = 4; // fallback floor where no terrain is loaded at all
// (e.g. far outside the built tile area, or a
// teleport target synced from the 2D map)
const ACCEL_SMOOTH = 0.15;  // 0-1 per-frame lerp toward desired WASD velocity — smooth accel/decel
const WHEEL_FRICTION = 0.9; // per-frame decay of wheel-driven velocity — smooth coast instead of a jump-per-tick
const WHEEL_IMPULSE = 0.03; // feel-tuned: scales one wheel tick into a velocity impulse
// Ground-rejection runs on its own fixed-rate timer, not just inside update()
// — update() only runs when the render loop calls it (rAF, so it can skip or
// stall), which let the camera sit below ground for a stretch before the
// next correction. A setInterval tick keeps enforcing the floor regardless.
const PHYSICS_INTERVAL_MS = 20; // 50 Hz

// Shared key state across both cameras
const _keys = new Set();
window.addEventListener("keydown", (e) => _keys.add(e.code));
window.addEventListener("keyup", (e) => _keys.delete(e.code));

export function createFlyCamera(renderer, getGroundHeight) {
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.001, 1000);
  camera.position.set(0, 1.5, 2.5);
  camera.lookAt(0, 0, 0);

  let yaw = camera.rotation.y;
  let pitch = camera.rotation.x;
  let enabled = true;

  const canvas = renderer.domElement;
  let rightClickActive = false;
  let middleClickActive = false;

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  canvas.addEventListener("pointerdown", (e) => {
    if (!enabled) return;
    if (e.button === 2) rightClickActive = true;
    if (e.button === 1) { middleClickActive = true; e.preventDefault(); }
  });
  window.addEventListener("pointerup", (e) => {
    if (e.button === 2) rightClickActive = false;
    if (e.button === 1) middleClickActive = false;
  });

  // Remembers the last sampled ground elevation so both the hard floor and
  // the speed scaling stay continuous through brief gaps in tile coverage
  // (LOD swaps, a tile still loading) instead of snapping to a fixed value
  // — that snap is what caused the "teleported back" jolt. FLY_MIN_ALTITUDE_KM
  // only applies before any ground has ever been sampled this session.
  let _lastGroundHeight = null;
  function sampledGroundHeight() {
    const h = getGroundHeight?.(camera.position.x, camera.position.z);
    if (h != null) _lastGroundHeight = h;
    return _lastGroundHeight;
  }

  function groundFloor() {
    const h = sampledGroundHeight();
    return h != null ? h + FLY_GROUND_CLEARANCE_KM : FLY_MIN_ALTITUDE_KM;
  }

  function heightAboveGround() {
    return camera.position.y - (sampledGroundHeight() ?? 0);
  }

  // Continuous movement (WASD, wheel-zoom, middle-click pan): after applying
  // it, snap Y up to the floor if it ended up below ground.
  function moveIfClear(applyFn) {
    applyFn();
    const floor = groundFloor();
    if (camera.position.y < floor) camera.position.y = floor;
  }

  // Fixed-rate safety net, independent of the render loop: enforces the
  // floor even if update() didn't run this tick for any reason.
  setInterval(() => {
    const floor = groundFloor();
    if (camera.position.y < floor) camera.position.y = floor;
  }, PHYSICS_INTERVAL_MS);

  const _right = new THREE.Vector3();
  const _camUp = new THREE.Vector3();

  canvas.addEventListener("pointermove", (e) => {
    if (!enabled) return;
    if (rightClickActive) {
      yaw -= e.movementX * SENSITIVITY;
      pitch -= e.movementY * SENSITIVITY;
      pitch = Math.max(-Math.PI / 2 * 0.98, Math.min(Math.PI / 2 * 0.98, pitch));
      camera.rotation.set(pitch, yaw, 0, "YXZ");
    }
    if (middleClickActive) {
      _right.setFromMatrixColumn(camera.matrixWorld, 0);
      _camUp.setFromMatrixColumn(camera.matrixWorld, 1);
      moveIfClear(() => {
        camera.position.addScaledVector(_right, e.movementX * PAN_SPEED);
        camera.position.addScaledVector(_camUp, -e.movementY * PAN_SPEED);
      });
    }
  });

  // Wheel ticks add an impulse to a decaying scalar velocity (applied along
  // whichever way the camera is facing each frame) instead of moving the
  // camera instantly — smooths a burst of ticks into one continuous coast.
  let _wheelVelocity = 0;

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (!enabled) return;

    // Impulse at sprint speed + altitude multiplier (same as Q+W)
    const altitudeMultiplier = 1 + Math.max(0, heightAboveGround() - 0.1);
    const sprintSpeed = MOVE_SPEED * SPRINT_MUL * altitudeMultiplier;
    _wheelVelocity += -e.deltaY * sprintSpeed * WHEEL_IMPULSE;
  }, { passive: false });

  const _forward = new THREE.Vector3();
  const _forwardFlat = new THREE.Vector3(); // _forward with y zeroed — used for touch pan (ground-plane only)
  const _worldUp = new THREE.Vector3(0, 1, 0);
  const _velocity = new THREE.Vector3(); // WASD velocity, eased toward _desired each frame
  const _desired = new THREE.Vector3();

  function update(dt) {
    const sprint = _keys.has("KeyQ") ? SPRINT_MUL : 1;

    // Scale speed by height above ground (not sea-level altitude): higher
    // above the terrain = faster, closer to it = slower.
    const altitudeMultiplier = 1 + Math.max(0, heightAboveGround());
    const maxSpeed = MOVE_SPEED * sprint * altitudeMultiplier;

    camera.getWorldDirection(_forward);
    _right.crossVectors(_forward, _worldUp).normalize();
    _forwardFlat.set(_forward.x, 0, _forward.z);
    if (_forwardFlat.lengthSq() > 0) _forwardFlat.normalize();

    _desired.set(0, 0, 0);
    if (_keys.has("KeyW")) _desired.add(_forward);
    if (_keys.has("KeyS")) _desired.addScaledVector(_forward, -1);
    if (_keys.has("KeyA")) _desired.addScaledVector(_right, -1);
    if (_keys.has("KeyD")) _desired.add(_right);
    if (_desired.lengthSq() > 0) _desired.normalize().multiplyScalar(maxSpeed);

    // Ease velocity toward the desired direction/speed: smooth accel when a
    // key is pressed, smooth decel (coasts to a stop) when released — same
    // per-frame-lerp smoothing style as walk mode's height easing below.
    _velocity.lerp(_desired, ACCEL_SMOOTH);
    _wheelVelocity *= WHEEL_FRICTION;

    // One-finger touch drag: move in the ground plane only (no altitude
    // change) — up/down drag maps to forward/back, left/right to strafe.
    const panDelta = consumePanDelta();
    if (panDelta.x !== 0 || panDelta.y !== 0) {
      moveIfClear(() => {
        camera.position.addScaledVector(_forwardFlat, -panDelta.y * PAN_SPEED);
        camera.position.addScaledVector(_right, panDelta.x * PAN_SPEED);
      });
    }

    // Two-finger touch drag: orient the camera (delta-based, like the
    // right-click-drag handled in pointermove above).
    const orientDelta = consumeOrientDelta();
    if (orientDelta.x !== 0 || orientDelta.y !== 0) {
      yaw -= orientDelta.x * SENSITIVITY;
      pitch -= orientDelta.y * SENSITIVITY;
      pitch = Math.max(-Math.PI / 2 * 0.98, Math.min(Math.PI / 2 * 0.98, pitch));
      camera.rotation.set(pitch, yaw, 0, "YXZ");
    }

    // Two-finger pinch: zoom / dolly (mirrors wheel zoom).
    const zoomDelta = consumeZoomDelta();
    if (zoomDelta !== 0) {
      const altitudeMultiplier = 1 + Math.max(0, heightAboveGround() - 0.1);
      const sprintSpeed = MOVE_SPEED * SPRINT_MUL * altitudeMultiplier;
      _wheelVelocity += zoomDelta * sprintSpeed * WHEEL_IMPULSE;
    }

    moveIfClear(() => {
      camera.position.addScaledVector(_velocity, dt);
      camera.position.addScaledVector(_forward, _wheelVelocity * dt);
    });
  }

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }

  function getOrientation() { return { yaw, pitch }; }
  function setOrientation(y, p) {
    yaw = y; pitch = p;
    camera.rotation.set(pitch, yaw, 0, "YXZ");
  }
  function teleport(pos, target) {
    camera.position.copy(pos);
    // A teleport is a deliberate jump, not continuous movement — clamp the
    // altitude up if needed rather than "stopping" (there's nothing to stop).
    if (camera.position.y < groundFloor()) camera.position.y = groundFloor();
    camera.lookAt(target);
    camera.rotation.reorder("YXZ");
    yaw = camera.rotation.y;
    pitch = camera.rotation.x;
    camera.rotation.set(pitch, yaw, 0, "YXZ");
  }

  return {
    camera, update, onResize, getOrientation, setOrientation, teleport,
    enable() { enabled = true; },
    disable() { enabled = false; rightClickActive = false; middleClickActive = false; },
    snapToGround: undefined, // fly mode doesn't snap to ground
  };
}

export function createWalkCamera(renderer, scene) {
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.001, 1000);
  camera.position.set(0, WALK_HEIGHT, 0);

  let yaw = 0;
  let pitch = 0;
  let enabled = false;

  const canvas = renderer.domElement;
  let locked = false;

  document.addEventListener("pointerlockchange", () => {
    locked = document.pointerLockElement === canvas;
  });

  // Re-acquire pointer lock on click while walk mode is active
  canvas.addEventListener("click", () => {
    if (enabled && !locked) canvas.requestPointerLock();
  });

  // Mouse look via pointer lock — no button hold required
  document.addEventListener("pointermove", (e) => {
    if (!enabled || !locked) return;
    yaw -= e.movementX * SENSITIVITY;
    pitch -= e.movementY * SENSITIVITY;
    pitch = Math.max(-Math.PI / 2 * 0.7, Math.min(Math.PI / 2 * 0.7, pitch));
    camera.rotation.set(pitch, yaw, 0, "YXZ");
  });

  canvas.addEventListener("wheel", (e) => { e.preventDefault(); }, { passive: false });

  const _forward = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _worldUp = new THREE.Vector3(0, 1, 0);

  let _cachedTerrain = null;
  let _hmapData = null; // built once per terrain mesh, from heightmap.js
  let _targetY = WALK_HEIGHT; // smooth camera Y towards this target
  let _groundHeight = 0; // last sampled raw ground height (no WALK_HEIGHT offset) — hard floor
  const SMOOTH_FACTOR = 0.15; // exponential smoothing: 0–1, higher = faster response

  function snapToGround() {
    const cx = camera.position.x;
    const cz = camera.position.z;

    // If still within the cached tile's bounds, skip the O(n) scene traversal.
    if (_cachedTerrain) {
      const box = _cachedTerrain.geometry.boundingBox;
      if (box) {
        const minX = box.min.x + _cachedTerrain.position.x;
        const maxX = box.max.x + _cachedTerrain.position.x;
        const minZ = box.min.z + _cachedTerrain.position.z;
        const maxZ = box.max.z + _cachedTerrain.position.z;
        if (cx >= minX && cx <= maxX && cz >= minZ && cz <= maxZ) {
          const localX = cx - _cachedTerrain.position.x;
          const localZ = cz - _cachedTerrain.position.z;
          const h = sampleHeight(_hmapData, localX, localZ);
          if (h !== null) { _groundHeight = h; _targetY = h + WALK_HEIGHT; }
          return;
        }
      }
    }

    // Traverse to find the highest-resolution tile (highest z) at this location.
    let terrain = null;
    let maxZ = -1;
    scene.traverse((obj) => {
      if (!obj.isMesh || !obj.name.startsWith("tile-")) return;
      const box = obj.geometry.boundingBox;
      if (!box) return;
      // World bounds = local geometry bounds + mesh position offset
      const minX = box.min.x + obj.position.x;
      const maxX = box.max.x + obj.position.x;
      const minZ = box.min.z + obj.position.z;
      const maxZ_tile = box.max.z + obj.position.z;
      if (cx >= minX && cx <= maxX && cz >= minZ && cz <= maxZ_tile) {
        // Extract z from tile name: "tile-x-y-z"
        const parts = obj.name.split("-");
        const z = parseInt(parts[3], 10);
        if (z > maxZ) {
          maxZ = z;
          terrain = obj;
        }
      }
    });
    if (!terrain) {
      console.log(`[walk] no terrain at (${cx.toFixed(2)}, ${cz.toFixed(2)})`);
      return;
    }

    if (terrain !== _cachedTerrain) {
      _cachedTerrain = terrain;
      terrain.geometry.computeBoundingBox();
      const box = terrain.geometry.boundingBox;
      const pos = terrain.geometry.attributes.position;
      _hmapData = buildHeightmap(pos.array, pos.count, box.min.x, box.max.x, box.min.z, box.max.z);
      console.log(`[walk] switched to ${terrain.name}, LOD z=${maxZ}, pos=(${terrain.position.x.toFixed(2)}, ${terrain.position.z.toFixed(2)}), heightmap: ${pos.count} vertices`);
    }

    // Sample height in local geometry coordinates (subtract mesh position)
    const localX = cx - terrain.position.x;
    const localZ = cz - terrain.position.z;
    const h = sampleHeight(_hmapData, localX, localZ);
    if (h !== null) {
      _groundHeight = h;
      _targetY = h + WALK_HEIGHT;
    }
  }

  function update(dt) {
    if (!enabled) return;

    // One-finger touch drag: move in the ground plane (XY only) — up/down
    // drag maps to forward/back, left/right to strafe, same as WASD.
    const panDelta = consumePanDelta();
    const moving = _keys.has("KeyW") || _keys.has("KeyS") || _keys.has("KeyA") || _keys.has("KeyD")
      || panDelta.x !== 0 || panDelta.y !== 0;

    if (moving) {
      const sprint = _keys.has("KeyQ") ? SPRINT_MUL : 1;
      const speed = MOVE_SPEED * sprint;
      const d = speed * dt;

      camera.getWorldDirection(_forward);
      _forward.y = 0;
      if (_forward.lengthSq() > 0) _forward.normalize();
      _right.crossVectors(_forward, _worldUp).normalize();

      if (_keys.has("KeyW")) camera.position.addScaledVector(_forward, d);
      if (_keys.has("KeyS")) camera.position.addScaledVector(_forward, -d);
      if (_keys.has("KeyA")) camera.position.addScaledVector(_right, -d);
      if (_keys.has("KeyD")) camera.position.addScaledVector(_right, d);
      camera.position.addScaledVector(_forward, -panDelta.y * PAN_SPEED);
      camera.position.addScaledVector(_right, panDelta.x * PAN_SPEED);
    }

    // Two-finger touch drag: orient the camera, standing in for the
    // pointer-lock mouse-look above (Pointer Lock isn't available on touch).
    const orientDelta = consumeOrientDelta();
    if (orientDelta.x !== 0 || orientDelta.y !== 0) {
      yaw -= orientDelta.x * SENSITIVITY;
      pitch -= orientDelta.y * SENSITIVITY;
      pitch = Math.max(-Math.PI / 2 * 0.7, Math.min(Math.PI / 2 * 0.7, pitch));
      camera.rotation.set(pitch, yaw, 0, "YXZ");
    }

    snapToGround();

    // Smooth camera Y towards target height (exponential smoothing)
    camera.position.y += (_targetY - camera.position.y) * SMOOTH_FACTOR;

    enforceFloor();
  }

  // Hard floor: never let the camera sink below the actual ground, regardless
  // of how far the smoothing in update() lags behind a sudden height change.
  function enforceFloor() {
    const minY = _groundHeight + GROUND_CLEARANCE;
    if (camera.position.y < minY) camera.position.y = minY;
  }

  // Fixed-rate safety net, independent of the render loop: re-samples the
  // ground and re-enforces the floor even if update() didn't run this tick
  // (dropped/delayed frame) — update() alone left a window where the camera
  // could sit below the mesh until the next render tick corrected it.
  setInterval(() => {
    if (!enabled) return;
    snapToGround();
    enforceFloor();
  }, PHYSICS_INTERVAL_MS);

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }

  function getOrientation() { return { yaw, pitch }; }
  function setOrientation(y, p) {
    yaw = y; pitch = p;
    camera.rotation.set(pitch, yaw, 0, "YXZ");
  }
  function teleport(pos, target) {
    // Walk mode: set XZ and reset Y; snapToGround() will correct once terrain loads.
    camera.position.x = pos.x;
    camera.position.z = pos.z;
    _targetY = WALK_HEIGHT; // reset so we don't inherit previous location's height
    _cachedTerrain = null;  // invalidate terrain cache for the new location
    _hmapData = null;
    camera.lookAt(target);
    camera.rotation.reorder("YXZ");
    yaw = camera.rotation.y;
    pitch = camera.rotation.x;
    camera.rotation.set(pitch, yaw, 0, "YXZ");
    snapToGround();
  }

  return {
    camera, update, onResize, getOrientation, setOrientation, teleport, snapToGround,
    enable() {
      enabled = true;
      // Don't move camera XZ — just snap Y to ground at current location.
      // _targetY must be initialized before snapToGround() overwrites it.
      _targetY = camera.position.y;
      snapToGround();
      canvas.requestPointerLock();
    },
    disable() { enabled = false; if (document.pointerLockElement === canvas) document.exitPointerLock(); },
    getFloorHeight() {
      if (!_hmapData || !_cachedTerrain) return null;
      const localX = camera.position.x - _cachedTerrain.position.x;
      const localZ = camera.position.z - _cachedTerrain.position.z;
      return sampleHeight(_hmapData, localX, localZ);
    },
    getCachedBox() { return _hmapData ? { min: { x: _hmapData.minX, z: _hmapData.minZ }, max: { x: _hmapData.maxX, z: _hmapData.maxZ } } : null; },
  };
}
