import * as itowns from "itowns";
import * as THREE from "three";

const UP = new THREE.Vector3(0, 0, 1);

/** Google-Maps-style compass: needle tracks camera heading, click resets to north. */
export function initCompass(view) {
  const el = document.getElementById("compass");
  const svg = el.querySelector("svg");
  const camera = view.camera3D;
  const dir = new THREE.Vector3();

  const lastQuaternion = new THREE.Quaternion();
  view.addFrameRequester(itowns.MAIN_LOOP_EVENTS.AFTER_RENDER, () => {
    if (camera.quaternion.equals(lastQuaternion)) return;
    lastQuaternion.copy(camera.quaternion);
    camera.getWorldDirection(dir);
    const yawDeg = THREE.MathUtils.radToDeg(Math.atan2(-dir.x, dir.y));
    svg.style.transform = `rotate(${-yawDeg}deg)`;
  });

  el.addEventListener("click", () => {
    camera.getWorldDirection(dir);
    const phi = Math.acos(THREE.MathUtils.clamp(-dir.z, -1, 1));
    const pitch = Math.PI / 2 - phi;
    const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch);
    camera.quaternion.copy(qPitch);
    camera.up.copy(UP);
    camera.updateMatrixWorld(true);
    view.notifyChange(camera);
  });
}
