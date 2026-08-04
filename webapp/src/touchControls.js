import * as THREE from "three";
import { showInfoToast } from "./infoToast.js";
import { capDragStep, dragStepCapFor, isTargetAllowed } from "./utils.js";

const STATE_NONE = -1;
const TAP_MAX_MS = 500;
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

  let mode = null; // "pan" | "gesture"
  let smoothedPitch = 0;
  let lastDist = 0;
  let smoothedDist = 0;
  let lastAngle = 0;
  let lastMidY = 0;
  let smoothedTwist = 0;
  let phi = 0;
  let orbitEnabled = false;
  let dragStepCap = Infinity;
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
    const picked = view.getPickingPositionFromDepth(coord.set(clientX - br.x, clientY - br.y));
    return isTargetAllowed(view, picked) ? picked : undefined;
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

  const anchorAt = (x, y, timeStamp) => {
    const picked = pickGround(x, y);
    orbitEnabled = !!picked;
    if (picked) {
      centerPoint.copy(picked);
      const anchor = pickPlane(x, y, centerPoint.z);
      if (anchor) dragAnchor.copy(anchor);
      else orbitEnabled = false;
      dragStepCap = dragStepCapFor(view.camera3D.position.z, centerPoint.z);
    }
    if (!orbitEnabled && timeStamp - lastGestureLockedToast > GESTURE_LOCKED_TOAST_COOLDOWN_MS) {
      lastGestureLockedToast = timeStamp;
      showInfoToast(GESTURE_LOCKED_MESSAGE);
    }
  };

  const syncLookDir = () => {
    view.camera3D.getWorldDirection(dir);
    phi = Math.acos(THREE.MathUtils.clamp(-dir.z, -1, 1));
  };

  const applyPan = (x, y) => {
    if (!orbitEnabled) return;
    const current = pickPlane(x, y, centerPoint.z);
    if (current) {
      view.camera3D.position.add(capDragStep(panDelta.copy(dragAnchor).sub(current), dragStepCap));
    }
  };

  const startOneFinger = (e) => {
    mode = "pan";
    controls.state = STATE_NONE;
    anchorAt(e.touches[0].clientX, e.touches[0].clientY, e.timeStamp);
    syncLookDir();
  };

  const startTwoFingers = (e) => {
    mode = "gesture";
    controls.state = STATE_NONE;
    const t = e.touches;
    lastDist = smoothedDist = spread(t);
    lastAngle = angle(t);
    lastMidY = midY(t);
    smoothedTwist = 0;
    smoothedPitch = 0;
    anchorAt(midX(t), midY(t), e.timeStamp);
    syncLookDir();
  };

  const applyRotation = (thetaTwist, pitchDrag) => {
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
    dir.normalize();
    camera.up.set(0, 0, 1);
    camera.lookAt(lookTarget.copy(camera.position).add(dir));
    camera.updateMatrixWorld();
  };

  const teleportTo = (x, y) => {
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
        startOneFinger(e);
      } else {
        tapStart = null;
        startTwoFingers(e);
      }
    },
    { passive: false },
  );

  dom.addEventListener(
    "touchmove",
    (e) => {
      if (!mode || !controls.enabled) return;
      e.preventDefault();
      if (e.touches.length === 1) {
        const t = e.touches[0];
        if (tapStart && Math.hypot(t.clientX - tapStart.x, t.clientY - tapStart.y) > TAP_MAX_MOVE) {
          tapStart = null;
        }

        applyPan(t.clientX, t.clientY);
        view.notifyChange(view.camera3D);
        return;
      } else if (e.touches.length >= 2) {
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

        const my = midY(t);
        const pitchRaw = (-controls.rotateSpeed * (my - lastMidY)) / view.mainLoop.gfxEngine.height;
        lastMidY = my;
        smoothedPitch += (pitchRaw - smoothedPitch) * LOOK_SMOOTHING;

        const a = angle(t);
        let da = a - lastAngle;
        if (da > Math.PI) da -= 2 * Math.PI;
        else if (da < -Math.PI) da += 2 * Math.PI;
        lastAngle = a;
        if (Math.abs(da) < TWIST_DEADZONE_RAD) da = 0;
        smoothedTwist += (da - smoothedTwist) * LOOK_SMOOTHING;

        applyRotation(smoothedTwist, smoothedPitch);
      }
      view.notifyChange(view.camera3D);
    },
    { passive: false },
  );

  const onEnd = (e) => {
    controls.state = STATE_NONE;
    if (mode === "pan" && tapStart && e.timeStamp - tapStart.t < TAP_MAX_MS) {
      if (lastTap && e.timeStamp - lastTap.t < TAP_MAX_MS && Math.hypot(tapStart.x - lastTap.x, tapStart.y - lastTap.y) < TAP_MAX_MOVE) {
        teleportTo(tapStart.x, tapStart.y);
        lastTap = null;
      } else {
        lastTap = tapStart;
      }
    }
    tapStart = null;
    if (e.touches.length === 1) startOneFinger(e);
    else if (e.touches.length >= 2) startTwoFingers(e);
    else mode = null;
  };
  dom.addEventListener("touchend", onEnd);
  dom.addEventListener("touchcancel", onEnd);
}
