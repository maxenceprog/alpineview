import * as THREE from "three";

const BIAS = 20;

export function createPoiOcclusion(tilesLayer) {
  const tiles = new Map();
  const raycaster = new THREE.Raycaster();
  const direction = new THREE.Vector3();
  const hitPoint = new THREE.Vector3();

  tilesLayer.addEventListener("load-model", (e) => {
    e.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.updateWorldMatrix(true, false);
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      tiles.set(o, {
        tile: e.tile,
        box: o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld),
      });
    });
  });

  tilesLayer.addEventListener("dispose-model", (e) => {
    e.scene.traverse((o) => tiles.delete(o));
  });

  const isOccluded = (camera, world) => {
    direction.copy(world).sub(camera.position);
    const distance = direction.length();
    if (distance <= BIAS) return false;
    direction.divideScalar(distance);

    raycaster.set(camera.position, direction);
    raycaster.near = 0;
    raycaster.far = distance - BIAS;

    const { visibleTiles } = tilesLayer.tilesRenderer;
    for (const [, { tile, box }] of tiles) {
      if (!visibleTiles.has(tile)) continue;
      if (box.containsPoint(camera.position)) return true;
      if (!raycaster.ray.intersectBox(box, hitPoint)) continue;
      if (hitPoint.distanceTo(camera.position) > raycaster.far) continue;
      return true;
    }
    return false;
  };

  return { isOccluded };
}
