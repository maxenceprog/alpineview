import * as THREE from "three";
import { showInfoToast } from "./infoToast.js";
import { capDragStep, dragStepCapFor, isTargetAllowed } from "./utils.js";

const TAP_MAX_MS = 500;
const TAP_MAX_MOVE = 20; // px
const LOOK_SMOOTHING = 0.15;
const ZOOM_SMOOTHING = 0.2;
const TWIST_DEADZONE_RAD = 0.015; // filters incidental twist noise from a 2-finger drag
const ZOOM_DEADZONE_PX = 2; // filters incidental spread noise from a 2-finger drag
const CAM_MODE_SWITCH_MSG_3D = "Caméra mode 3D";
const CAM_MODE_SWITCH_MSG_2D = "Caméra mode 2D";
const CAM_MODE_SWITCH_TOAST_COOLDOWN_MS = 3000;
const PITCH_2D_THRESHOLD_DEG = 20; // pitch (from horizon) above this = 2D mode
const PHI_3D_MIN = THREE.MathUtils.degToRad(90 - PITCH_2D_THRESHOLD_DEG); // zenith angle above this = 3D mode

export function initTouchControls(view) {
  const controls = view.controls;
  const dom = view.domElement;
  const coord = new THREE.Vector2();
  const ndc = new THREE.Vector2();
  const dir = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const panDelta = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const right = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const dragRay = new THREE.Raycaster();
  const dragPlane = new THREE.Plane();

  let gesture = null; // active Gesture, or null between touches
  let lastIs2D = true;
  let lastModeToast = 0;
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

  const zenithAngle = () => {
    view.camera3D.getWorldDirection(dir);
    return Math.acos(THREE.MathUtils.clamp(-dir.z, -1, 1));
  };

  const setMode2D = (next, timeStamp) => {
    if (next === lastIs2D) return;
    lastIs2D = next;
    if (timeStamp - lastModeToast > CAM_MODE_SWITCH_TOAST_COOLDOWN_MS) {
      lastModeToast = timeStamp;
      showInfoToast(next ? CAM_MODE_SWITCH_MSG_2D : CAM_MODE_SWITCH_MSG_3D);
    }
  };

  const applyRotation = (thetaTwist, pitchDrag, timeStamp) => {
    const camera = view.camera3D;
    let phi = zenithAngle();
    const is2D = phi < PHI_3D_MIN;
    if (thetaTwist !== 0) {
      if (is2D && gesture.orbitEnabled) {
        quat.setFromAxisAngle(zAxis, thetaTwist);
        offset.copy(camera.position).sub(gesture.centerPoint).applyQuaternion(quat);
        camera.position.copy(gesture.centerPoint).add(offset);
        dir.applyQuaternion(quat);
      } else if (!is2D) {
        quat.setFromAxisAngle(zAxis, thetaTwist);
        dir.applyQuaternion(quat);
      }
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
    setMode2D(phi < PHI_3D_MIN, timeStamp);
  };

  // Base gesture: anchors to the picked ground point under the touch(es) and
  // can pan the camera against that anchor. start/update/stop are virtual.
  class Gesture {
    #centerPoint = null;
    #dragAnchor = null;
    #dragStepCap = Infinity;

    constructor(touches) {
      this.start(touches);
    }

    get orbitEnabled() {
      return this.#centerPoint !== null && this.#dragAnchor !== null;
    }

    get centerPoint() {
      return this.#centerPoint;
    }

    anchorAt(x, y) {
      const picked = pickGround(x, y);
      if (!picked) {
        this.#centerPoint = null;
        this.#dragAnchor = null;
        return;
      }
      this.#centerPoint = picked;
      this.#dragAnchor = pickPlane(x, y, picked.z);
      this.#dragStepCap = dragStepCapFor(view.camera3D.position.z, picked.z);
    }

    pan(x, y) {
      if (!this.orbitEnabled) return;
      const current = pickPlane(x, y, this.#centerPoint.z);
      if (current) {
        view.camera3D.position.add(capDragStep(panDelta.copy(this.#dragAnchor).sub(current), this.#dragStepCap));
      }
    }

    start(_touches) {}
    update(_touches, _timeStamp) {}
    stop() {}
  }

  class OneFingerGesture extends Gesture {
    start(touches) {
      const t = touches[0];
      this.anchorAt(t.clientX, t.clientY);
    }

    update(touches) {
      const t = touches[0];
      this.pan(t.clientX, t.clientY);
    }
  }

  class TwoFingerGesture extends Gesture {
    #lastDist = 0;
    #smoothedDist = 0;
    #lastAngle = 0;
    #lastMidY = 0;
    #smoothedTwist = 0;
    #smoothedPitch = 0;

    start(touches) {
      this.anchorAt(midX(touches), midY(touches));
      this.#lastDist = this.#smoothedDist = spread(touches);
      this.#lastAngle = angle(touches);
      this.#lastMidY = midY(touches);
    }

    update(touches, timeStamp) {
      const cam = view.camera3D;

      let rawDist = spread(touches);
      if (Math.abs(rawDist - this.#lastDist) < ZOOM_DEADZONE_PX) rawDist = this.#lastDist;
      this.#smoothedDist += (rawDist - this.#smoothedDist) * ZOOM_SMOOTHING;
      const factor = THREE.MathUtils.clamp(this.#smoothedDist / this.#lastDist, 0.5, 2);
      if (this.orbitEnabled && (factor > 1 || cam.position.z < controls.maxAltitude)) {
        cam.position.lerpVectors(cam.position, this.centerPoint, 1 - 1 / factor);
      }
      this.#lastDist = this.#smoothedDist;

      const my = midY(touches);
      const pitchRaw = (-controls.rotateSpeed * (my - this.#lastMidY)) / view.mainLoop.gfxEngine.height;
      this.#lastMidY = my;
      this.#smoothedPitch += (pitchRaw - this.#smoothedPitch) * LOOK_SMOOTHING;

      const a = angle(touches);
      let da = a - this.#lastAngle;
      if (da > Math.PI) da -= 2 * Math.PI;
      else if (da < -Math.PI) da += 2 * Math.PI;
      this.#lastAngle = a;
      if (Math.abs(da) < TWIST_DEADZONE_RAD) da = 0;
      this.#smoothedTwist += (da - this.#smoothedTwist) * LOOK_SMOOTHING;

      applyRotation(this.#smoothedTwist, this.#smoothedPitch, timeStamp);
    }
  }

  const startOneFinger = (e) => {
    gesture = new OneFingerGesture(e.touches);
  };

  const startTwoFingers = (e) => {
    gesture = new TwoFingerGesture(e.touches);
  };

  const teleportTo = (x, y) => controls.initiateSmartTravel(at(x, y));

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
      if (!gesture || !controls.enabled) return;
      e.preventDefault();
      if (e.touches.length === 1 && tapStart) {
        const t = e.touches[0];
        if (Math.hypot(t.clientX - tapStart.x, t.clientY - tapStart.y) > TAP_MAX_MOVE) tapStart = null;
      }
      gesture.update(e.touches, e.timeStamp);
      view.notifyChange(view.camera3D);
    },
    { passive: false },
  );

  const onEnd = (e) => {
    if (tapStart && e.timeStamp - tapStart.t < TAP_MAX_MS) {
      if (lastTap && e.timeStamp - lastTap.t < TAP_MAX_MS && Math.hypot(tapStart.x - lastTap.x, tapStart.y - lastTap.y) < TAP_MAX_MOVE) {
        teleportTo(tapStart.x, tapStart.y);
        lastTap = null;
      } else {
        lastTap = tapStart;
      }
    }
    tapStart = null;
    gesture?.stop();
    if (e.touches.length === 1) startOneFinger(e);
    else if (e.touches.length >= 2) startTwoFingers(e);
    else gesture = null;
  };
  dom.addEventListener("touchend", onEnd);
  dom.addEventListener("touchcancel", onEnd);
}
