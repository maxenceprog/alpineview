import * as THREE from "three";
import { showInfoToast } from "./infoToast.js";

const STATE_NONE = -1;
const TAP_MAX_MS = 300;
const TAP_MAX_MOVE = 20; // px
const LOOK_SMOOTHING = 0.15;
const ZOOM_SMOOTHING = 0.2;
const TWIST_DEADZONE_RAD = 0.015; // filters incidental twist noise from a 2-finger drag
const ZOOM_DEADZONE_PX = 2; // filters incidental spread noise from a 2-finger drag
const GESTURE_LOCKED_MESSAGE = "Regarde le sol pour déplacer, zoomer ou tourner la caméra.";
const GESTURE_LOCKED_TOAST_COOLDOWN_MS = 3000;

export function initTouchControls(view) {
  const controls = view.controls;
  const dom = view.domElement;
  const coord = new THREE.Vector2();
  const ndc = new THREE.Vector2();
  const dir = new THREE.Vector3();
  const centerPoint = new THREE.Vector3();
  const dragAnchor = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const panDelta = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const right = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const dragRay = new THREE.Raycaster();
  const dragPlane = new THREE.Plane();

  let mode = null; // "orient" | "gesture"
  let lastTouchX = 0;
  let lastTouchY = 0;
  let smoothedOrientYaw = 0;
  let smoothedOrientPitch = 0;
  let lastDist = 0;
  let smoothedDist = 0;
  let lastAngle = 0;
  let smoothedTwist = 0;
  let phi = 0;
  let orbitEnabled = false;
  let lastGestureLockedToast = 0;
  let tapStart = null;
  let lastTap = null;

  const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const angle = (t) => Math.atan2(t[1].clientY - t[0].clientY, t[1].clientX - t[0].clientX);
  const midX = (t) => (t[0].clientX + t[1].clientX) / 2;
  const midY = (t) => (t[0].clientY + t[1].clientY) / 2;
  const at = (x, y) => ({ touches: [{ clientX: x, clientY: y }] });

  const pickGround = (clientX, clientY) => {
    const br = dom.getBoundingClientRect();
    return view.getPickingPositionFromDepth(coord.set(clientX - br.x, clientY - br.y));
  };

  const pickPlane = (clientX, clientY, altitude) => {
    const br = dom.getBoundingClientRect();
    view.viewToNormalizedCoords(coord.set(clientX - br.x, clientY - br.y), ndc);
    view.camera3D.updateMatrixWorld();
    dragRay.setFromCamera(ndc, view.camera3D);
    dragPlane.set(zAxis, -altitude);
    const hit = new THREE.Vector3();
    return dragRay.ray.intersectPlane(dragPlane, hit) ? hit : null;
  };

  const startOrient = (e) => {
    mode = "orient";
    controls.state = STATE_NONE;
    const t = e.touches[0];
    lastTouchX = t.clientX;
    lastTouchY = t.clientY;
    smoothedOrientYaw = 0;
    smoothedOrientPitch = 0;
    view.camera3D.getWorldDirection(dir);
    phi = Math.acos(THREE.MathUtils.clamp(-dir.z, -1, 1));
  };

  const startGesture = (e) => {
    mode = "gesture";
    controls.state = STATE_NONE;
    const t = e.touches;
    lastDist = smoothedDist = spread(t);
    lastAngle = angle(t);
    smoothedTwist = 0;
    const mx = midX(t);
    const my = midY(t);
    const picked = pickGround(mx, my);
    orbitEnabled = !!picked;
    if (picked) {
      centerPoint.copy(picked);
      const anchor = pickPlane(mx, my, centerPoint.z);
      if (anchor) dragAnchor.copy(anchor);
      else orbitEnabled = false;
    }
    if (!orbitEnabled && e.timeStamp - lastGestureLockedToast > GESTURE_LOCKED_TOAST_COOLDOWN_MS) {
      lastGestureLockedToast = e.timeStamp;
      showInfoToast(GESTURE_LOCKED_MESSAGE);
    }
    view.camera3D.getWorldDirection(dir);
    phi = Math.acos(THREE.MathUtils.clamp(-dir.z, -1, 1));
  };

  const applyRotation = (thetaTwist, yawDrag, pitchDrag) => {
    const camera = view.camera3D;
    if (orbitEnabled && thetaTwist !== 0) {
      quat.setFromAxisAngle(zAxis, thetaTwist);
      offset.copy(camera.position).sub(centerPoint).applyQuaternion(quat);
      camera.position.copy(centerPoint).add(offset);
      dir.applyQuaternion(quat);
    }
    if (pitchDrag !== 0 && phi + pitchDrag >= controls.minZenithAngle && phi + pitchDrag <= controls.maxZenithAngle) {
      phi += pitchDrag;
      right.setFromMatrixColumn(camera.matrix, 0);
      quat.setFromAxisAngle(right, pitchDrag);
      dir.applyQuaternion(quat);
    }
    if (yawDrag !== 0) {
      quat.setFromAxisAngle(zAxis, yawDrag);
      dir.applyQuaternion(quat);
    }
    dir.normalize();
    camera.up.set(0, 0, 1);
    camera.lookAt(lookTarget.copy(camera.position).add(dir));
    camera.updateMatrixWorld();
  };

  const smartTravelTo = (x, y) => {
    const evt = at(x, y);
    controls.updateMousePositionAndDelta(evt);
    controls.initiateSmartTravel(evt);
  };

  dom.addEventListener(
    "touchstart",
    (e) => {
      if (!controls.enabled || e.target.closest(".poi-label")) return;
      e.preventDefault();
      if (e.touches.length === 1) {
        const t = e.touches[0];
        tapStart = { x: t.clientX, y: t.clientY, t: e.timeStamp };
        startOrient(e);
      } else {
        tapStart = null;
        startGesture(e);
      }
    },
    { passive: false },
  );

  dom.addEventListener(
    "touchmove",
    (e) => {
      if (!mode || !controls.enabled) return;
      e.preventDefault();
      if (mode === "orient" && e.touches.length === 1) {
        const t = e.touches[0];
        if (tapStart && Math.hypot(t.clientX - tapStart.x, t.clientY - tapStart.y) > TAP_MAX_MOVE) {
          tapStart = null;
        }
        const yawRaw = (-controls.rotateSpeed * (t.clientX - lastTouchX)) / view.mainLoop.gfxEngine.width;
        const pitchRaw = (-controls.rotateSpeed * (t.clientY - lastTouchY)) / view.mainLoop.gfxEngine.height;
        lastTouchX = t.clientX;
        lastTouchY = t.clientY;
        smoothedOrientYaw += (yawRaw - smoothedOrientYaw) * LOOK_SMOOTHING;
        smoothedOrientPitch += (pitchRaw - smoothedOrientPitch) * LOOK_SMOOTHING;
        applyRotation(0, smoothedOrientYaw, smoothedOrientPitch);
      } else if (mode === "gesture" && e.touches.length >= 2) {
        const t = e.touches;
        const cam = view.camera3D;

        let rawDist = spread(t);
        if (Math.abs(rawDist - lastDist) < ZOOM_DEADZONE_PX) rawDist = lastDist;
        smoothedDist += (rawDist - smoothedDist) * ZOOM_SMOOTHING;
        const factor = THREE.MathUtils.clamp(smoothedDist / lastDist, 0.5, 2);
        if (orbitEnabled && (factor > 1 || cam.position.z < controls.maxAltitude)) {
          cam.position.lerpVectors(cam.position, centerPoint, 1 - 1 / factor);
        }
        lastDist = smoothedDist;

        if (orbitEnabled) {
          const current = pickPlane(midX(t), midY(t), centerPoint.z);
          if (current) cam.position.add(panDelta.copy(dragAnchor).sub(current));
        }

        const a = angle(t);
        let da = a - lastAngle;
        if (da > Math.PI) da -= 2 * Math.PI;
        else if (da < -Math.PI) da += 2 * Math.PI;
        lastAngle = a;
        if (Math.abs(da) < TWIST_DEADZONE_RAD) da = 0;
        smoothedTwist += (da - smoothedTwist) * LOOK_SMOOTHING;

        applyRotation(smoothedTwist, 0, 0);
      }
      view.notifyChange(view.camera3D);
    },
    { passive: false },
  );

  const onEnd = (e) => {
    controls.state = STATE_NONE;
    if (mode === "orient" && tapStart && e.timeStamp - tapStart.t < TAP_MAX_MS) {
      if (lastTap && e.timeStamp - lastTap.t < TAP_MAX_MS && Math.hypot(tapStart.x - lastTap.x, tapStart.y - lastTap.y) < TAP_MAX_MOVE) {
        smartTravelTo(tapStart.x, tapStart.y);
        lastTap = null;
      } else {
        lastTap = tapStart;
      }
    }
    tapStart = null;
    if (e.touches.length === 1) startOrient(e);
    else if (e.touches.length >= 2) startGesture(e);
    else mode = null;
  };
  dom.addEventListener("touchend", onEnd);
  dom.addEventListener("touchcancel", onEnd);
}
