import * as THREE from "three";
const GOTO_TILT = 80;
const GOTO_RANGE = 8000;

const DRAG_STEP_CAP_RATIO = 0.25;
const DRAG_STEP_CAP_MIN = 10;

export function dragStepCapFor(cameraZ, groundZ) {
    const height = groundZ === null ? cameraZ : cameraZ - groundZ;
    return DRAG_STEP_CAP_RATIO * Math.max(height, DRAG_STEP_CAP_MIN);
}

export function capDragStep(step, cap) {
    return step.length() > cap ? step.setLength(cap) : step;
}


export const MAX_TARGET_DISTANCE = 10000;

export function isTargetAllowed(view, point) {
    if (!point) return false;

    const dir = new THREE.Vector3();
    view.camera3D.getWorldDirection(dir);
    const phi = Math.acos(THREE.MathUtils.clamp(-dir.z, -1, 1));
    const pitch = Math.PI / 2 - phi;
    const MIN_PITCH_RAD = THREE.MathUtils.degToRad(20);

    const distance = view.camera3D.position.distanceTo(point);

    return (pitch >= MIN_PITCH_RAD) || (distance <= MAX_TARGET_DISTANCE);
}

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
