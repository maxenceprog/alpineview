// Touch controls for the 3D scene view:
//  - one-finger drag: orient the camera (yaw/pitch)
//  - two-finger pinch (spread/pinch): zoom / dolly
// Listens on the WebGL canvas itself (not a full-screen overlay) so taps that
// land on UI panels/buttons drawn above the canvas never reach this logic —
// it only ever fires over the actual 3D scene view. No-op on non-mobile devices.
import { IS_MOBILE } from "./deviceInfo.js";

// Accumulated per-frame deltas (like mouse movementX / wheel deltaY), drained
// once per render frame by camera.js.
let _orientDelta = { x: 0, y: 0 };
let _zoomDelta = 0;

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

export function initTouchControls(canvas) {
  if (!IS_MOBILE) return;

  canvas.style.touchAction = "none";

  const touches = new Map(); // pointerId -> {x, y}, all active touches on canvas
  let pinchPrevDist = null; // previous two-finger distance while exactly 2 fingers are down

  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinchPrevDist = touches.size === 2 ? dist(...touches.values()) : null;
  });

  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
    const prev = touches.get(e.pointerId);
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (touches.size === 2 && pinchPrevDist != null) {
      const d = dist(...touches.values());
      _zoomDelta += d - pinchPrevDist;
      pinchPrevDist = d;
    } else if (touches.size === 1) {
      _orientDelta.x += e.clientX - prev.x;
      _orientDelta.y += e.clientY - prev.y;
    }
  });

  const onEnd = (e) => {
    if (e.pointerType !== "touch") return;
    touches.delete(e.pointerId);
    if (touches.size !== 2) pinchPrevDist = null;
  };
  canvas.addEventListener("pointerup", onEnd);
  canvas.addEventListener("pointercancel", onEnd);
}
