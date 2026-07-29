import * as THREE from "three";
const GOTO_TILT = 80;
const GOTO_RANGE = 8000;

export function itownsPlacement(view, x, y) {
    const target = new THREE.Vector3(x, y, 0);
    // tilt is measured from the ground plane, as in PlanarView's `placement`.
    const tilt = THREE.MathUtils.degToRad(GOTO_TILT);
    view.camera3D.position.set(
        x,
        y - GOTO_RANGE * Math.cos(tilt),
        GOTO_RANGE * Math.sin(tilt),
    );
    view.camera3D.lookAt(target);
    view.camera3D.updateMatrixWorld(true);
    view.notifyChange(view.camera3D);
}
