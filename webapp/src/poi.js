import DOMPurify from "dompurify";
import * as itowns from "itowns";
import MarkdownIt from "markdown-it";
import * as THREE from "three";
import { l93ToWebMercator, webMercatorToL93 } from "./proj.js";

// POIs render as iTowns-native labels: a LabelLayer attached to the tile layer,
// fed by a custom Source that fetches Camptocamp waypoints per 1 km L93 cell.
// iTowns owns the projection (its built-in label2dRenderer), terrain clamping,
// frustum/collision culling and the render loop — no separate CSS2DRenderer.
const KIND_CLASS = { summit: "poi-peak", pass: "poi-pass", hut: "poi-hut", access: "poi-parking" };
// Levels at which the POI layer loads (10=1 km, 11=500 m, 12=250 m tiles). The
// lower bound is how far POIs appear; it's cheap to widen because fetches are
// batched per BLOCK_KM block, not per tile (see PoiSource).
const POI_ZOOM = { min: 10, max: 12 };
// Camptocamp fetches are snapped to this L93 grid: every tile within one block
// folds into a single paginated bbox request, decoupling request count from the
// (finer) display tiling. A block ~= BLOCK_KM² km²; waypoints are sparse enough
// that this is usually one page.
const BLOCK_KM = 8;

const ALPS_EXTENT = new itowns.Extent("EPSG:2154", 256000, 1280000, 5952000, 6976000);

const WAYPOINTS_URL = "https://api.camptocamp.org/waypoints";
const IMAGES_URL = "https://api.camptocamp.org/images";
const MEDIA_BASE = "https://media.camptocamp.org/c2corg-active";
// Camptocamp embeds photos as [img=<id> <modifiers...>]<caption>[/img] (a custom
// wiki tag, not markdown) — resolved into real <img> URLs before rendering.
const IMG_TAG_RE = /\[img=(\d+)[^\]]*\]([^[]*)\[\/img\]/g;
const PAGE_LIMIT = 100; // Camptocamp API max page size — paginate past it, don't cap.

function cellBboxWebMercator(x0, y0, sizeKm = 1) {
  const corners = [
    [x0, y0], [x0 + sizeKm, y0], [x0, y0 + sizeKm], [x0 + sizeKm, y0 + sizeKm],
  ].map(([x, y]) => l93ToWebMercator.forward([x * 1000, y * 1000]));
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

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

export async function fetchWaypointDetail(documentId) {
  const res = await fetch(`${WAYPOINTS_URL}/${documentId}?l=fr`);
  if (!res.ok) throw new Error(`Camptocamp API returned ${res.status}`);
  return res.json();
}

// size: "SI" small, "MI" medium, "BI" big.
export function imageUrl(filename, size = "MI") {
  return `${MEDIA_BASE}/${filename.replace(/\.([a-zA-Z0-9]+)$/, `${size}.$1`)}`;
}

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

// Camptocamp docs -> a GeoJSON FeatureCollection of 3D points in EPSG:2154
// (x, y, elevation). The z lets iTowns place each label at real altitude
// without sampling the DEM.
function poisToGeoJson(docs) {
  return {
    type: "FeatureCollection",
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::2154" } },
    features: docs.map((doc) => {
      const geom = JSON.parse(doc.geometry.geom); // {type:"Point", coordinates:[x3857,y3857]}
      const [x, y] = webMercatorToL93.forward(geom.coordinates);
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [x, y, doc.elevation ?? 0] },
        properties: {
          id: doc.document_id,
          title: doc.locales[0].title,
          wtyp: doc.waypoint_type,
          elevation: doc.elevation ?? null,
        },
      };
    }),
  };
}

class PoiSource extends itowns.Source {
  constructor() {
    super({
      url: "poi",
      crs: "EPSG:2154",
      extent: ALPS_EXTENT,
      // One Camptocamp request per BLOCK_KM block: every tile in a block maps to
      // the same url, so this cache collapses them to a single paginated fetch.
      fetcher: (url) => {
        let p = this._blockCache.get(url);
        if (!p) {
          const [x0, y0] = url.split("/").map(Number);
          p = fetchCellPois(x0, y0, BLOCK_KM).then(poisToGeoJson);
          this._blockCache.set(url, p);
        }
        return p;
      },
      parser: (data, options) => itowns.GeoJsonParser.parse(data, options),
    });
    this._blockCache = new Map();
    this.zoom = POI_ZOOM;
  }

  urlFromExtent(extent) {
    // iTowns passes a TMS Tile (zoom/row/col) here, not a spatial Extent —
    // convert to L93 bounds and snap to the BLOCK_KM grid so every tile in a
    // block shares one fetch. Points are still filtered to each tile downstream.
    const e = extent.isExtent ? extent : extent.toExtent(this.crs);
    const bx = Math.floor(e.west / 1000 / BLOCK_KM) * BLOCK_KM;
    const by = Math.floor(e.south / 1000 / BLOCK_KM) * BLOCK_KM;
    return `${bx}/${by}`;
  }

  extentInsideLimit(extent, zoom) {
    // The source extent spans the whole view, so every tile intersects it;
    // gate on zoom alone (the level range where 1 km cells are worth loading).
    return zoom >= this.zoom.min && zoom <= this.zoom.max;
  }
}

// Each label is a zero-size anchor (positioned by iTowns at the point) wrapping
// an inner element offset up-and-centred via CSS. iTowns overwrites only the
// anchor's transform each frame, so the inner transform survives; cloneNode
// (Label clones the content) keeps the data-* attributes used for click
// identity and the class used for per-type styling.
function poiDomElement(props) {
  const anchor = document.createElement("div");
  const inner = document.createElement("span");
  inner.className = `poi-label ${KIND_CLASS[props.wtyp] ?? "poi-hut"}`;
  inner.textContent = props.title;
  inner.dataset.id = props.id;
  inner.dataset.title = props.title;
  inner.dataset.wtyp = props.wtyp;
  if (props.elevation != null) inner.dataset.elevation = props.elevation;
  anchor.appendChild(inner);
  return anchor;
}

const WAYPOINT_TYPE_LABEL = { summit: "Summit", pass: "Pass", hut: "Hut", access: "Parking / access" };
const poiMarkdown = new MarkdownIt({ html: true, linkify: true });

function poiMeta(doc) {
  return [WAYPOINT_TYPE_LABEL[doc.waypoint_type] ?? doc.waypoint_type, doc.elevation ? `${doc.elevation} m` : null]
    .filter(Boolean).join(" · ");
}

const ACTIVITY_EMOJI = {
  skitouring: "⛷️", snow_ice_mixed: "🧊", mountain_climbing: "🏔️", rock_climbing: "🧗",
  ice_climbing: "🧊", hiking: "🥾", snowshoeing: "🐾", via_ferrata: "🪜",
  slacklining: "🎪", paragliding: "🪂", mountain_biking: "🚵",
};

function routeTitle(route) {
  const locale = route.locales?.[0];
  const name = locale?.title_prefix ? `${locale.title_prefix} – ${locale.title}` : locale?.title ?? "?";
  const emojis = (route.activities ?? []).map((a) => ACTIVITY_EMOJI[a] ?? "📍").join("");
  const grade = [route.global_rating, route.engagement_rating].filter(Boolean).join(" · ");
  return [emojis, grade, name].filter(Boolean).join(" ");
}

function outingTitle(outing) {
  const name = outing.locales?.[0]?.title ?? "?";
  const date = outing.date_start ? new Date(outing.date_start).toLocaleDateString("fr-FR") : null;
  return date ? `${date} — ${name}` : name;
}

function renderPoiLinkList(sectionId, listId, items, urlBase, titleFn) {
  const section = document.getElementById(sectionId);
  const list = document.getElementById(listId);
  list.innerHTML = "";
  if (!items?.length) { section.style.display = "none"; return; }
  for (const item of items) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `https://www.camptocamp.org/${urlBase}/${item.document_id}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = titleFn(item);
    li.appendChild(a);
    list.appendChild(li);
  }
  section.style.display = "";
}

// Guards a slower earlier detail fetch from overwriting the panel after a
// second POI is clicked before the first one's load finishes.
let poiRequestToken = 0;

function showPoiPanel(poi) {
  const token = ++poiRequestToken;
  const panel = document.getElementById("poi-panel");
  const title = document.getElementById("poi-title");
  const meta = document.getElementById("poi-meta");
  const text = document.getElementById("poi-text");
  const link = document.getElementById("poi-link");

  title.textContent = poi.title;
  meta.textContent = poiMeta({ waypoint_type: poi.wtyp, elevation: poi.elevation });
  text.textContent = "Chargement…";
  link.href = `https://www.camptocamp.org/waypoints/${poi.id}`;
  renderPoiLinkList("poi-routes-section", "poi-routes", [], "routes", routeTitle);
  renderPoiLinkList("poi-outings-section", "poi-outings", [], "outings", outingTitle);
  panel.classList.remove("hidden");

  fetchWaypointDetail(poi.id).then(async (doc) => {
    if (token !== poiRequestToken) return;
    meta.textContent = poiMeta(doc);
    renderPoiLinkList("poi-routes-section", "poi-routes", doc.associations?.all_routes?.documents, "routes", routeTitle);
    renderPoiLinkList("poi-outings-section", "poi-outings", doc.associations?.recent_outings?.documents, "outings", outingTitle);
    const locale = doc.locales?.[0];
    const raw = [locale?.access, locale?.description].filter(Boolean).join("\n\n");
    if (!raw) { text.textContent = "Aucune description disponible."; return; }
    const resolved = await resolveEmbeddedImages(raw);
    if (token !== poiRequestToken) return;
    text.innerHTML = DOMPurify.sanitize(poiMarkdown.render(resolved));
  }).catch(() => { if (token === poiRequestToken) text.textContent = "Échec du chargement des détails."; });
}

/**
 * Attach the Camptocamp POI LabelLayer to an iTowns PlanarView and wire label
 * clicks (delegated, since iTowns clones each label's DOM) to the info panel.
 */
export function initPoi(view) {
  const poiLayer = new itowns.LabelLayer("poi", {
    source: new PoiSource(),
    zoom: POI_ZOOM,
    domElement: poiDomElement,
    // anchor only (domElement overrides all other text style); keep the point
    // altitude that comes from the feature's z coordinate.
    style: { text: { anchor: "bottom" } },
  });
  view.addLayer(poiLayer, view.tileLayer);

  // iTowns clones label DOM (stripping addEventListener handlers), so identify
  // the clicked POI from its data-* attributes via one delegated listener.
  const labelRoot = view.mainLoop.gfxEngine.label2dRenderer.domElement;
  labelRoot.addEventListener("click", (e) => {
    const el = e.target.closest(".poi-label");
    if (!el) return;
    showPoiPanel({
      id: el.dataset.id,
      title: el.dataset.title,
      wtyp: el.dataset.wtyp,
      elevation: el.dataset.elevation != null ? Number(el.dataset.elevation) : null,
    });
  });

  const panel = document.getElementById("poi-panel");
  document.getElementById("poi-close")?.addEventListener("click", () => {
    panel.classList.add("hidden");
  });
  const maximize = document.getElementById("poi-maximize");
  maximize?.addEventListener("click", () => {
    const max = panel.classList.toggle("maximized");
    maximize.textContent = max ? "⤡" : "⤢";
    maximize.title = max ? "Réduire" : "Agrandir";
  });

  installLabelOcclusion(view, poiLayer);
}

// iTowns' planar label renderer only frustum-culls: a label on a summit behind
// a nearer ridge still draws on top of it. Hide those by comparing each label's
// camera-forward depth against the terrain depth sampled from the (DEM) depth
// buffer at the label's pixel — the same buffer wheel-zoom picking reads, so
// the draco layer's un-hide wrap makes it reflect the real surface.
function installLabelOcclusion(view, poiLayer) {
  const g = view.mainLoop.gfxEngine;
  const camera = view.camera3D;
  // Occlude only when the terrain is at least this much nearer than the label,
  // so a label sitting exactly on its own summit never self-occludes.
  const MARGIN = 60;
  const THROTTLE = 100; // ms between depth reads during continuous motion

  let buffer = null;
  let lastPass = 0;
  let lastCamMatrix = new THREE.Matrix4();
  let trailer = null;
  const world = new THREE.Vector3();
  const ndc = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const toLabel = new THREE.Vector3();

  const eachLabel = (fn) => {
    for (const node of poiLayer.object3d.children) {
      for (const label of node.children) if (label.isLabel) fn(label);
    }
  };

  const recompute = () => {
    const dim = g.getWindowSize();
    const w = dim.x | 0, h = dim.y | 0;
    if (!buffer || buffer.length !== w * h * 4) buffer = new Uint8Array(w * h * 4);
    view.readDepthBuffer(0, 0, w, h, buffer);
    camera.getWorldDirection(forward);
    eachLabel((label) => {
      label.getWorldPosition(world);
      ndc.copy(world).project(camera);
      if (ndc.x < -1 || ndc.x > 1 || ndc.y < -1 || ndc.y > 1 || ndc.z > 1) {
        label._occluded = false; // off-screen: leave to frustum culling
        return;
      }
      const sx = Math.min(w - 1, Math.max(0, Math.round((ndc.x * 0.5 + 0.5) * w)));
      const sy = Math.min(h - 1, Math.max(0, Math.round((-ndc.y * 0.5 + 0.5) * h)));
      const idx = ((h - sy - 1) * w + sx) * 4;
      const terrainZ = g.depthBufferRGBAValueToOrthoZ(buffer.subarray(idx, idx + 4), camera);
      const labelZ = toLabel.copy(world).sub(camera.position).dot(forward);
      label._occluded = terrainZ > 0 && terrainZ < labelZ - MARGIN;
    });
    lastCamMatrix.copy(camera.matrixWorld);
    lastPass = performance.now();
  };

  view.addFrameRequester(itowns.MAIN_LOOP_EVENTS.AFTER_RENDER, () => {
    if (!poiLayer.object3d.children.length) return;
    const now = performance.now();
    if (!lastPass || (now - lastPass > THROTTLE && !camera.matrixWorld.equals(lastCamMatrix))) {
      recompute();
    }
    eachLabel((label) => { if (label._occluded) label.visible = false; });
    // Force one more render after motion settles so the final occlusion state
    // is computed at the resting camera position.
    clearTimeout(trailer);
    trailer = setTimeout(() => view.notifyChange(camera), THROTTLE + 20);
  });
}
