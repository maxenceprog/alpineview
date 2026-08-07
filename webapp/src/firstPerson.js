import * as THREE from "three";

const EYE_HEIGHT = 1.7;

// Step 1: drag the 🧍 button anywhere on screen; on release, raycast the
// terrain under the pointer (same picking path as depth-based controls) and
// teleport the camera down to eye height at that point.
export function initFirstPerson(view) {
  const btn = document.getElementById("fp-toggle");
  let dragging = false;

  const moveDrag = (event) => {
    if (!dragging) return;
    btn.style.left = `${event.clientX - btn.offsetWidth / 2}px`;
    btn.style.top = `${event.clientY - btn.offsetHeight / 2}px`;
    btn.style.bottom = "auto";
  };

  const endDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    btn.classList.remove("dragging");
    btn.style.left = "";
    btn.style.top = "";
    btn.style.bottom = "";

    const picked = view.getPickingPositionFromDepth(view.eventToViewCoords(event));
    if (!picked) return;

    const camera = view.camera3D;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.z = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
    dir.normalize();

    camera.position.set(picked.x, picked.y, picked.z + EYE_HEIGHT);
    camera.lookAt(camera.position.clone().add(dir));
    camera.updateMatrixWorld(true);
    view.notifyChange(camera);
  };

  btn.addEventListener("pointerdown", (event) => {
    dragging = true;
    btn.setPointerCapture(event.pointerId);
    btn.classList.add("dragging");
  });
  btn.addEventListener("pointermove", moveDrag);
  btn.addEventListener("pointerup", endDrag);
  btn.addEventListener("pointercancel", endDrag);
}
