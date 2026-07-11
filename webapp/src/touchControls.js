// Touch controls for the 3D scene view:
//  - one-finger drag: move in the ground plane (XY only, no altitude change)
//  - two-finger drag (centroid movement): orient the camera (yaw/pitch)
//  - two-finger pinch (spread/pinch): zoom / dolly
// Listens on the WebGL canvas itself (not a full-screen overlay) so taps that
// land on UI panels/buttons drawn above the canvas never reach this logic —
// it only ever fires over the actual 3D scene view. No-op on non-mobile devices.
import { IS_MOBILE } from "./deviceInfo.js";

// Accumulated per-frame deltas (like mouse movementX / wheel deltaY), drained
// once per render frame by camera.js rather than held as continuous state.
let _panDelta = { x: 0, y: 0 };
let _orientDelta = { x: 0, y: 0 };
let _zoomDelta = 0;

export function consumePanDelta() {
  const d = _panDelta;
  _panDelta = { x: 0, y: 0 };
  return d;
}
export function consumeOrientDelta() {
  const d = _orientDelta;
  _orientDelta = { x: 0, y: 0 };
  return d;
}
export function consumeZoomDelta() {
  const d = _zoomDelta;
  _zoomDelta = 0;
  return d;
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

export function initTouchControls(canvas) {
  if (!IS_MOBILE) return;

  canvas.style.touchAction = "none";

  const touches = new Map(); // pointerId -> {x, y}, all active touches on canvas
  let gesture = null; // { ids: [id, id], prevDist, prevMid } while exactly a 2-finger gesture is live

  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      const ids = [...touches.keys()];
      const [a, b] = ids.map((id) => touches.get(id));
      gesture = { ids, prevDist: dist(a, b), prevMid: mid(a, b) };
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
    const prev = touches.get(e.pointerId);
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (gesture) {
      const [idA, idB] = gesture.ids;
      if (!touches.has(idA) || !touches.has(idB)) return;
      const a = touches.get(idA);
      const b = touches.get(idB);
      const d = dist(a, b);
      const m = mid(a, b);
      _orientDelta.x += m.x - gesture.prevMid.x;
      _orientDelta.y += m.y - gesture.prevMid.y;
      _zoomDelta += d - gesture.prevDist;
      gesture.prevDist = d;
      gesture.prevMid = m;
    } else if (touches.size === 1) {
      _panDelta.x += e.clientX - prev.x;
      _panDelta.y += e.clientY - prev.y;
    }
  });

  const onEnd = (e) => {
    if (e.pointerType !== "touch") return;
    touches.delete(e.pointerId);
    if (gesture && gesture.ids.includes(e.pointerId)) gesture = null;
  };
  canvas.addEventListener("pointerup", onEnd);
  canvas.addEventListener("pointercancel", onEnd);
}
