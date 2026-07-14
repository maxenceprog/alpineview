/**
 * Camptocamp points of interest (summits, passes, huts, parking/access) per
 * 1 km L93 cell, fetched from the Camptocamp v6 API (api.camptocamp.org) and
 * rendered as a clickable text label planted at terrain height.
 */

import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { l93ToWebMercator, webMercatorToL93 } from "./proj.js";

const WAYPOINTS_URL = "https://api.camptocamp.org/waypoints";
const IMAGES_URL = "https://api.camptocamp.org/images";
const MEDIA_BASE = "https://media.camptocamp.org/c2corg-active";
// Camptocamp description text embeds photos as [img=<id> <modifiers...>]<caption>[/img]
// (a custom wiki tag, not markdown) — modifiers are a variable-length,
// space-separated list (e.g. "right", "big central") — resolved into real
// <img> URLs before rendering.
const IMG_TAG_RE = /\[img=(\d+)[^\]]*\]([^[]*)\[\/img\]/g;
const LABEL_HEIGHT_KM = 0.005; // 5 m above terrain
// Camptocamp waypoint_type → our label class. summit=peak, pass=col,
// hut=refuge, access=parking/trailhead.
const KIND_CLASS = { summit: "poi-peak", pass: "poi-pass", hut: "poi-hut", access: "poi-parking" };

/** Web Mercator (EPSG:3857) bbox [xmin,ymin,xmax,ymax] covering L93 block (x0,y0)..(x0+sizeKm,y0+sizeKm) km. */
function cellBboxWebMercator(x0, y0, sizeKm = 1) {
  const corners = [
    [x0, y0], [x0 + sizeKm, y0], [x0, y0 + sizeKm], [x0 + sizeKm, y0 + sizeKm],
  ].map(([x, y]) => l93ToWebMercator.forward([x * 1000, y * 1000]));
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const PAGE_LIMIT = 100; // Camptocamp API's max page size — paginate past it, don't cap results.

/** Fetch every named summit/pass/hut/access waypoint within a sizeKm-wide L93 block's bbox. */
export async function fetchCellPois(x0, y0, sizeKm = 1) {
  const bbox = cellBboxWebMercator(x0, y0, sizeKm).join(",");
  const wtyp = Object.keys(KIND_CLASS).join(",");
  const docs = [];
  let offset = 0;
  for (;;) {
    const url = `${WAYPOINTS_URL}?bbox=${bbox}&wtyp=${wtyp}&pl=fr&limit=${PAGE_LIMIT}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Camptocamp API returned ${res.status}`);
    const data = await res.json();
    const page = data.documents ?? [];
    docs.push(...page);
    offset += PAGE_LIMIT;
    if (page.length < PAGE_LIMIT || docs.length >= (data.total ?? 0)) break;
  }
  return docs.filter((doc) => doc.locales?.[0]?.title);
}

/** Fetch full detail (description, access, elevation, ...) for one waypoint. */
export async function fetchWaypointDetail(documentId) {
  const res = await fetch(`${WAYPOINTS_URL}/${documentId}?l=fr`);
  if (!res.ok) throw new Error(`Camptocamp API returned ${res.status}`);
  return res.json();
}

/** Public URL for a Camptocamp image filename. size: "SI" small, "MI" medium, "BI" big. */
export function imageUrl(filename, size = "MI") {
  return `${MEDIA_BASE}/${filename.replace(/\.([a-zA-Z0-9]+)$/, `${size}.$1`)}`;
}

/**
 * Replace every `[img=id align]caption[/img]` tag in raw Camptocamp text with
 * a markdown image (`![caption](url)`), resolving each referenced image's
 * filename via the Camptocamp images API. Tags whose image fails to resolve
 * fall back to their caption text.
 */
export async function resolveEmbeddedImages(rawText) {
  const ids = [...new Set([...rawText.matchAll(IMG_TAG_RE)].map((m) => m[1]))];
  if (!ids.length) return rawText;

  const urlById = new Map(await Promise.all(ids.map(async (id) => {
    try {
      const res = await fetch(`${IMAGES_URL}/${id}?l=fr`);
      if (!res.ok) throw new Error(`Camptocamp API returned ${res.status}`);
      const doc = await res.json();
      return [id, doc.filename ? imageUrl(doc.filename) : null];
    } catch {
      return [id, null];
    }
  })));

  return rawText.replace(IMG_TAG_RE, (_match, id, caption) => {
    const url = urlById.get(id);
    const alt = caption.trim();
    return url ? `\n\n![${alt}](${url})\n\n` : alt;
  });
}

/**
 * Build a THREE.Group of labels per POI, positioned at the cell's local
 * origin (x0, 0, -y0) — same convention as buildings.js. Clicking a label
 * calls `onSelect(poi)`. Height comes from Camptocamp's own `elevation`
 * field (real-world metres) rather than the loaded terrain mesh — sampling
 * the mesh raced its load order and could permanently drop a POI whose cell
 * resolved before the matching terrain tile finished loading (CellOverlay
 * caches an empty result and never retries). `getHeightAt` is only a
 * fallback for the rare POI with no elevation. Returns null if no POI could
 * be placed at all.
 */
export function buildPoiGroup(pois, x0, y0, getHeightAt, onSelect) {
  const group = new THREE.Group();
  group.position.set(x0, 0, -y0);
  let any = false;

  for (const poi of pois) {
    const geom = JSON.parse(poi.geometry.geom); // {type:"Point", coordinates:[x3857,y3857]}
    const [xm, ym] = webMercatorToL93.forward(geom.coordinates);
    const wx = xm / 1000, wz = -ym / 1000; // scene world km
    const h = poi.elevation != null ? poi.elevation / 1000 : getHeightAt(wx, wz);
    if (h == null) continue; // no elevation and terrain not loaded here yet — skip this cycle

    const lx = wx - x0, lz = wz + y0; // local to group origin

    const el = document.createElement("div");
    el.className = `poi-label ${KIND_CLASS[poi.waypoint_type] ?? "poi-hut"}`;
    el.textContent = poi.locales[0].title;
    el.addEventListener("click", () => onSelect?.(poi));
    const label = new CSS2DObject(el);
    label.position.set(lx, h + LABEL_HEIGHT_KM, lz);
    group.add(label);

    any = true;
  }

  return any ? group : null;
}
