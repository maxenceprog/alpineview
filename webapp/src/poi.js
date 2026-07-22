import DOMPurify from "dompurify";
import * as itowns from "itowns";
import MarkdownIt from "markdown-it";
import * as THREE from "three";
import { l93ToWebMercator, webMercatorToL93 } from "./proj.js";

const KIND_CLASS = { summit: "poi-peak", pass: "poi-pass", hut: "poi-hut", access: "poi-parking" };
const POI_ZOOM = { min: 10, max: 12 };
const BLOCK_KM = 8;

const ALPS_EXTENT = new itowns.Extent("EPSG:2154", 256000, 1280000, 5952000, 6976000);

const WAYPOINTS_URL = "https://api.camptocamp.org/waypoints";
const SEARCH_URL = "https://api.camptocamp.org/search";
const IMAGES_URL = "https://api.camptocamp.org/images";
const MEDIA_BASE = "https://media.camptocamp.org/c2corg-active";
const IMG_TAG_RE = /\[img=(\d+)[^\]]*\]([^[]*)\[\/img\]/g;
const PAGE_LIMIT = 100;

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
  for (; ;) {
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

export async function searchWaypoints(q, limit = 5) {
  const res = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(q)}&t=w&pl=fr&limit=${limit * 5}`);
  if (!res.ok) throw new Error(`Camptocamp API returned ${res.status}`);
  const data = await res.json();
  return (data.waypoints?.documents ?? [])
    .filter((doc) => doc.waypoint_type in KIND_CLASS && doc.locales?.[0]?.title && doc.geometry?.geom)
    .slice(0, limit)
    .map((doc) => {
      const [x, y] = webMercatorToL93.forward(JSON.parse(doc.geometry.geom).coordinates);
      return {
        id: doc.document_id,
        title: doc.locales[0].title,
        wtyp: doc.waypoint_type,
        elevation: doc.elevation ?? null,
        area: doc.areas?.find((a) => a.area_type === "range")?.locales?.[0]?.title ?? null,
        x,
        y,
      };
    });
}

export async function fetchWaypointDetail(documentId) {
  const res = await fetch(`${WAYPOINTS_URL}/${documentId}?l=fr`);
  if (!res.ok) throw new Error(`Camptocamp API returned ${res.status}`);
  return res.json();
}

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

function poisToGeoJson(docs) {
  return {
    type: "FeatureCollection",
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::2154" } },
    features: docs.map((doc) => {
      const geom = JSON.parse(doc.geometry.geom);
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
    const e = extent.isExtent ? extent : extent.toExtent(this.crs);
    const bx = Math.floor(e.west / 1000 / BLOCK_KM) * BLOCK_KM;
    const by = Math.floor(e.south / 1000 / BLOCK_KM) * BLOCK_KM;
    return `${bx}/${by}`;
  }

  extentInsideLimit(extent, zoom) {
    return zoom >= this.zoom.min && zoom <= this.zoom.max;
  }
}

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

let poiRequestToken = 0;

export function showPoiPanel(poi) {
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
    style: { text: { anchor: "bottom" } },
  });
  view.addLayer(poiLayer, view.tileLayer);

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

function installLabelOcclusion(view, poiLayer) {
  const g = view.mainLoop.gfxEngine;
  const dracoLayer = view.getLayerById("draco");
  const camera = view.camera3D;
  const MARGIN = 60;
  const THROTTLE = 100;

  let buffer = null;
  let lastPass = 0;
  let lastCamMatrix = new THREE.Matrix4();
  const world = new THREE.Vector3();
  const ndc = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const toLabel = new THREE.Vector3();

  const eachLabel = (fn) => {
    for (const node of poiLayer.object3d.children) {
      for (const label of node.children) if (label.isLabel) fn(label);
    }
  };

  // iTowns may clamp label.coordinates.z to the DEM; the Camptocamp altitude is authoritative.
  const labelWorldPosition = (label, out) => {
    const el = label.content.querySelector(".poi-label");
    const elevation = el?.dataset.elevation != null ? Number(el.dataset.elevation) : NaN;
    if (!Number.isFinite(elevation)) return label.getWorldPosition(out);
    return out.set(label.coordinates.x, label.coordinates.y, elevation);
  };

  // One readDepthBuffer call per tick (each call re-renders the tile layer in depth
  // mode before reading, so per-label calls multiply render+readback stalls instead of
  // shrinking them). Instead: collect the screen footprint of the labels actually on
  // screen, and read only that bounding rect in a single render+readback pass.
  const recompute = () => {
    const dim = g.getWindowSize();
    const w = dim.x | 0, h = dim.y | 0;
    camera.getWorldDirection(forward);

    const onScreen = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    eachLabel((label) => {
      labelWorldPosition(label, world);
      ndc.copy(world).project(camera);
      if (ndc.x < -1 || ndc.x > 1 || ndc.y < -1 || ndc.y > 1 || ndc.z > 1) {
        label._occluded = false;
        return;
      }
      const sx = Math.min(w - 1, Math.max(0, Math.round((ndc.x * 0.5 + 0.5) * w)));
      const sy = Math.min(h - 1, Math.max(0, Math.round((-ndc.y * 0.5 + 0.5) * h)));
      const labelZ = toLabel.copy(world).sub(camera.position).dot(forward);
      onScreen.push({ label, sx, sy, labelZ });
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    });

    if (onScreen.length) {
      const rectW = maxX - minX + 1;
      const rectH = maxY - minY + 1;
      if (!buffer || buffer.length !== rectW * rectH * 4) buffer = new Uint8Array(rectW * rectH * 4);
      dracoLayer.readTerrainDepthBuffer(minX, minY, rectW, rectH, buffer);
      for (const { label, sx, sy, labelZ } of onScreen) {
        const lx = sx - minX;
        const ly = sy - minY;
        const idx = ((rectH - ly - 1) * rectW + lx) * 4;
        const terrainZ = g.depthBufferRGBAValueToOrthoZ(buffer.subarray(idx, idx + 4), camera);
        label._occluded = terrainZ > 0 && terrainZ < labelZ - MARGIN;
      }
    }

    lastCamMatrix.copy(camera.matrixWorld);
    lastPass = performance.now();
  };

  view.addFrameRequester(itowns.MAIN_LOOP_EVENTS.AFTER_RENDER, () => {
    if (!poiLayer.object3d.children.length) return;
    const now = performance.now();
    const moved = !camera.matrixWorld.equals(lastCamMatrix);
    if (!lastPass || (moved && now - lastPass > THROTTLE)) recompute();
    eachLabel((label) => { if (label._occluded) label.visible = false; });

  });
}
