import { IS_MOBILE } from "./deviceInfo.js";

const POOL_SIZE = IS_MOBILE ? 1 : 2;

let workers = null;
let rrIndex = 0;
let nextId = 1;
const pending = new Map();

function getWorkers() {
  if (!workers) {
    workers = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const worker = new Worker(new URL("./geometryWorker.js", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (e) => {
        const { id, positions, normals, bbox } = e.data;
        const resolve = pending.get(id);
        pending.delete(id);
        resolve({ positions, normals, bbox });
      };
      workers.push(worker);
    }
  }
  return workers;
}

export function processGeometry(positions, index, rotate = true) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    const pool = getWorkers();
    const worker = pool[rrIndex++ % pool.length];
    worker.postMessage({ id, positions, index, rotate }, [positions.buffer]);
  });
}
