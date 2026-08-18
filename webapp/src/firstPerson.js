import { enterFirstPerson } from "./firstPersonView.js";

const FP_EMOJI = "🧍";

export function initFirstPerson(view, tilesLayer) {
  const btn = document.getElementById("fp-toggle");
  let dragging = false;
  let exitFn = null;

  const ghost = document.createElement("div");
  ghost.textContent = FP_EMOJI;
  ghost.style.cssText = "position:fixed;z-index:21;font-size:50px;pointer-events:none;display:none;"
    + "transform:translate(-50%,-50%);";
  document.body.append(ghost);

  const moveDrag = (event) => {
    if (!dragging) return;
    ghost.style.left = `${event.clientX}px`;
    ghost.style.top = `${event.clientY}px`;
  };

  const endDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    btn.classList.remove("dragging");
    btn.textContent = FP_EMOJI;
    ghost.style.display = "none";

    const picked = view.getPickingPositionFromDepth(view.eventToViewCoords(event));
    if (!picked) return;

    if (exitFn) {
      exitFn();
      exitFn = null;
    }

    // Must be requested synchronously from this input event — by the time
    // enterFirstPerson's async physics/WASM setup finishes, the browser no
    // longer considers this a user gesture and silently refuses the lock.
    // Also throws if requested too soon after a previous lock was released
    // (browser cooldown) — harmless here, mouse-look just won't work yet.
    // Touch drags must not lock the pointer: it freezes clientX/Y, which the
    // mobile joystick reads directly.
    if (event.pointerType !== "touch") view.domElement.requestPointerLock()?.catch(() => { });
    enterFirstPerson(view, tilesLayer, picked).then((exit) => { exitFn = exit; });
  };

  btn.addEventListener("pointerdown", (event) => {
    dragging = true;
    btn.setPointerCapture(event.pointerId);
    btn.classList.add("dragging");
    btn.textContent = "";
    ghost.style.left = `${event.clientX}px`;
    ghost.style.top = `${event.clientY}px`;
    ghost.style.display = "block";
  });
  btn.addEventListener("pointermove", moveDrag);
  btn.addEventListener("pointerup", endDrag);
  btn.addEventListener("pointercancel", endDrag);
}
