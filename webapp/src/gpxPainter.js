import { mercBounds } from "./wmts.js";

let activeTraces = [];
let listener = null;

/** Called once by tilesTexture.js to repaint tiles when the trace set changes. */
export function onTracesChanged(fn) {
  listener = fn;
}

/** Replaces the set of mercator polylines drawn onto WMTS tiles. */
export function setActiveTraces(traces) {
  activeTraces = traces;
  listener?.();
}

/** Identity of the current trace set, to detect a change across an await. */
export const currentTraces = () => activeTraces;

function tileMercBbox(tileKey) {
  const { x0, y0, s } = mercBounds(tileKey.z, tileKey.x, tileKey.y);
  return [x0, y0, x0 + s, y0 + s];
}

// Liang-Barsky segment-vs-rectangle clip test.
function segmentIntersectsBbox([ax, ay], [bx, by], x0, y0, x1, y1) {
  const dx = bx - ax, dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
  let tMin = 0, tMax = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > tMax) return false; if (r > tMin) tMin = r; }
      else { if (r < tMin) return false; if (r < tMax) tMax = r; }
    }
  }
  return true;
}

function tracesInBbox(traces, [x0, y0, x1, y1]) {
  return traces.filter((pts) => {
    if (pts.length === 1) {
      const [mx, my] = pts[0];
      return mx >= x0 && mx <= x1 && my >= y0 && my <= y1;
    }
    for (let i = 1; i < pts.length; i++) {
      if (segmentIntersectsBbox(pts[i - 1], pts[i], x0, y0, x1, y1)) return true;
    }
    return false;
  });
}

/** Draws the active traces crossing tileKey onto a copy of bitmap; returns bitmap unchanged if none cross it. */
export async function paintTraces(bitmap, tileKey) {
  const bbox = tileMercBbox(tileKey);
  const hits = tracesInBbox(activeTraces, bbox);
  if (!hits.length) return bitmap;
  const [x0, y0, x1, y1] = bbox;
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  ctx.strokeStyle = "#f52e2e";
  ctx.lineWidth = 2;
  ctx.setLineDash([2, 6]);
  ctx.lineCap = "round";
  for (const pts of hits) {
    ctx.beginPath();
    pts.forEach(([mx, my], i) => {
      const px = ((mx - x0) / (x1 - x0)) * canvas.width;
      const py = ((my - y0) / (y1 - y0)) * canvas.height;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }
  return createImageBitmap(canvas);
}
