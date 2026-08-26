const WINDOW = 50;
const MIN_SAMPLES = 10;
const DECIDE_MS = 5000;
const FAST_TILE_MS = 100;
const SLOW_TILE_MS = 600;

const FAST_ERROR_TARGET = 6;
const SLOW_ERROR_TARGET = 16;
const TARGET_STEP = 2;

const samples = [];

export function noteTileMs(ms) {
  samples.push(ms);
  if (samples.length > WINDOW) samples.shift();
}

export function medianTileMs() {
  if (samples.length < MIN_SAMPLES) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function errorTargetForTileMs(tileMs) {
  const span = (tileMs - FAST_TILE_MS) / (SLOW_TILE_MS - FAST_TILE_MS);
  const clamped = Math.min(Math.max(span, 0), 1);
  const target = FAST_ERROR_TARGET + clamped * (SLOW_ERROR_TARGET - FAST_ERROR_TARGET);
  return Math.round(target / TARGET_STEP) * TARGET_STEP;
}

export function initAutomaticSseThreshold(view, tilesLayer) {
  setInterval(() => {
    const tileMs = medianTileMs();
    if (tileMs === null) return;

    const next = errorTargetForTileMs(tileMs);
    const current = tilesLayer.sseThreshold;
    console.info(`tiles ${tileMs.toFixed(0)}ms median over ${samples.length} | sse ${current} -> ${next}`);
    if (next === current) return;
    tilesLayer.sseThreshold = next;
    view.notifyChange(tilesLayer);
  }, DECIDE_MS);
}
