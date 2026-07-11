// Round-robin pool fronting geometryWorker.js. Workers are created lazily
// (only once a tile actually needs processing) and reused for the life of
// the page — mirrors the sizing rationale in tileManager.js's own knobs:
// fewer workers on mobile where cores and memory are both tighter.
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

// positions: Float32Array (transferred — do not reuse the caller's reference
// after calling this). index: Uint32Array/Uint16Array, read-only, copied.
export function processGeometry(positions, index) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    const pool = getWorkers();
    const worker = pool[rrIndex++ % pool.length];
    worker.postMessage({ id, positions, index }, [positions.buffer]);
  });
}
