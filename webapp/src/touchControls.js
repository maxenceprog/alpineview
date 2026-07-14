import * as THREE from "three";

const STATE_NONE = -1;
const TAP_MAX_MS = 300;
const TAP_MAX_MOVE = 20; // px — beyond this a touch is a drag, not a tap

// iTowns' PlanarControls only speaks mouse + keyboard. This adds the mobile
// gestures by driving the same control methods with touch data:
//   1 finger drag → move the map (drag)
//   1 finger double-tap → fly to that point (smart travel, like the wheel click)
//   2 fingers pinch → zoom, twist → turn the camera, vertical drag → tilt
export function initTouchControls(view) {
  const controls = view.controls;
  const dom = view.domElement;
  const coord = new THREE.Vector2();

  let mode = null; // "drag" | "gesture"
  let lastDist = 0;
  let lastAngle = 0;
  let turn = 0; // accumulated finger rotation, fed to the ROTATE state as azimuth
  let tapStart = null; // { x, y, t } of the current one-finger touch
  let lastTap = null; // { x, y, t } of the previous completed tap

  const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const angle = (t) => Math.atan2(t[1].clientY - t[0].clientY, t[1].clientX - t[0].clientX);
  const midX = (t) => (t[0].clientX + t[1].clientX) / 2;
  const midY = (t) => (t[0].clientY + t[1].clientY) / 2;
  // fake mouse event so PlanarControls.updateMousePositionAndDelta reads our point
  const at = (x, y) => ({ touches: [{ clientX: x, clientY: y }] });

  const startDrag = (e) => {
    mode = "drag";
    controls.updateMousePositionAndDelta(e);
    controls.initiateDrag();
  };

  // feed the ROTATE state a synthetic cursor: x carries finger twist (→ heading),
  // y carries the vertical midpoint (→ tilt); horizontal panning is left to 1 finger
  const rotateWidth = () => view.mainLoop.gfxEngine.width / controls.rotateSpeed;
  const feedRotation = (t) => controls.updateMousePositionAndDelta(at(turn * rotateWidth(), midY(t)));

  const startGesture = (e) => {
    mode = "gesture";
    const t = e.touches;
    lastDist = spread(t);
    lastAngle = angle(t);
    turn = 0;
    feedRotation(t);
    controls.initiateRotation();
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
        startDrag(e);
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
      if (mode === "drag" && e.touches.length === 1) {
        const t = e.touches[0];
        if (tapStart && Math.hypot(t.clientX - tapStart.x, t.clientY - tapStart.y) > TAP_MAX_MOVE) {
          tapStart = null;
        }
        controls.updateMousePositionAndDelta(e);
      } else if (mode === "gesture" && e.touches.length >= 2) {
        const t = e.touches;
        // pinch → zoom toward the world point between the fingers
        const dist = spread(t);
        const factor = THREE.MathUtils.clamp(dist / lastDist, 0.5, 2);
        const cam = view.camera3D;
        if (factor > 1 || cam.position.z < controls.maxAltitude) {
          const br = dom.getBoundingClientRect();
          const target = controls.getWorldPointAtScreenXY(coord.set(midX(t) - br.x, midY(t) - br.y));
          cam.position.lerpVectors(cam.position, target, 1 - 1 / factor);
        }
        lastDist = dist;
        // twist → heading, vertical drag → tilt (both via the ROTATE state)
        const a = angle(t);
        let da = a - lastAngle;
        if (da > Math.PI) da -= 2 * Math.PI;
        else if (da < -Math.PI) da += 2 * Math.PI;
        turn += da;
        lastAngle = a;
        feedRotation(t);
      }
      view.notifyChange(view.camera3D);
    },
    { passive: false },
  );

  const onEnd = (e) => {
    controls.state = STATE_NONE;
    if (mode === "drag" && tapStart && e.timeStamp - tapStart.t < TAP_MAX_MS) {
      if (lastTap && e.timeStamp - lastTap.t < TAP_MAX_MS && Math.hypot(tapStart.x - lastTap.x, tapStart.y - lastTap.y) < TAP_MAX_MOVE) {
        smartTravelTo(tapStart.x, tapStart.y); // client coords — eventToViewCoords handles the offset
        lastTap = null;
      } else {
        lastTap = tapStart;
      }
    }
    tapStart = null;
    if (e.touches.length === 1) startDrag(e); // gesture fell back to one finger
    else if (e.touches.length >= 2) startGesture(e);
    else mode = null;
  };
  dom.addEventListener("touchend", onEnd);
  dom.addEventListener("touchcancel", onEnd);
}
