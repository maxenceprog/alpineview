import DOMPurify from "dompurify";
import * as itowns from "itowns";
import MarkdownIt from "markdown-it";
import * as THREE from "three";
import { createPoiOcclusion } from "./poiOcclusion.js";
import { localToMerc, mercToLocal } from "./workFrame.js";

const KIND_CLASS = { summit: "poi-peak", pass: "poi-pass", hut: "poi-hut", access: "poi-parking" };
const BLOCK_KM = 8;

const WAYPOINTS_URL = "https://api.camptocamp.org/waypoints";
const SEARCH_URL = "https://api.camptocamp.org/search";
const IMAGES_URL = "https://api.camptocamp.org/images";
const MEDIA_BASE = "https://media.camptocamp.org/c2corg-active";
const IMG_TAG_RE = /\[img=(\d+)[^\]]*\]([^[]*)\[\/img\]/g;
const PAGE_LIMIT = 100;

function cellBboxWebMercator(x0, y0, sizeKm = 1) {
  const corners = [
    [x0, y0], [x0 + sizeKm, y0], [x0, y0 + sizeKm], [x0 + sizeKm, y0 + sizeKm],
  ].map(([x, y]) => localToMerc(x * 1000, y * 1000));
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
      const [x, y] = mercToLocal(JSON.parse(doc.geometry.geom).coordinates);
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
export function initPoi(view, tilesLayer) {
  const labelRoot = document.createElement("div");
  labelRoot.id = "poi-labels";
  labelRoot.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:1;";
  view.domElement.appendChild(labelRoot);

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

  const labels = installPoiLabels(view, labelRoot, tilesLayer);
  return labels;
}

const POI_RADIUS_KM = 1.4;
const POI_DROP_KM = 1.5;
const POI_MAX_DISTANCE = 3000;

function installPoiLabels(view, labelRoot, tilesLayer) {
  const camera = view.camera3D;
  const occlusion = createPoiOcclusion(tilesLayer);
  const blocks = new Map();
  const labels = [];

  const makeLabel = (doc) => {
    const geom = JSON.parse(doc.geometry.geom);
    const [x, y] = mercToLocal(geom.coordinates);
    const anchor = poiDomElement({
      id: doc.document_id,
      title: doc.locales[0].title,
      wtyp: doc.waypoint_type,
      elevation: doc.elevation ?? null,
    });
    anchor.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;visibility:hidden;";
    labelRoot.appendChild(anchor);
    const entry = {
      anchor,
      el: anchor.firstChild,
      world: new THREE.Vector3(x, y, (doc.elevation ?? 0)),
      sx: 0, sy: 0, labelZ: 0,
      onScreen: false,
    };
    return entry;
  };

  const dropBlock = (key) => {
    const block = blocks.get(key);
    blocks.delete(key);
    for (const label of block.labels ?? []) {
      label.anchor.remove();
      const i = labels.indexOf(label);
      if (i >= 0) labels.splice(i, 1);
    }
  };

  const refreshBlocks = () => {
    const cx = camera.position.x / 1000;
    const cy = camera.position.y / 1000;
    const snap = (v) => Math.floor(v / BLOCK_KM) * BLOCK_KM;

    for (let bx = snap(cx - POI_RADIUS_KM); bx <= cx + POI_RADIUS_KM; bx += BLOCK_KM) {
      for (let by = snap(cy - POI_RADIUS_KM); by <= cy + POI_RADIUS_KM; by += BLOCK_KM) {
        const key = `${bx}/${by}`;
        if (blocks.has(key)) continue;
        const block = { labels: [] };
        blocks.set(key, block);
        fetchCellPois(bx, by, BLOCK_KM).then((docs) => {
          if (blocks.get(key) !== block) return;
          for (const doc of docs) {
            if (!doc.geometry?.geom) continue;
            const label = makeLabel(doc);
            block.labels.push(label);
            labels.push(label);
          }
          dirty = true;
          view.notifyChange(camera);
        }).catch(() => { blocks.delete(key); });
      }
    }

    for (const key of [...blocks.keys()]) {
      const [bx, by] = key.split("/").map(Number);
      const dx = Math.max(0, Math.abs(bx + BLOCK_KM / 2 - cx) - BLOCK_KM / 2);
      const dy = Math.max(0, Math.abs(by + BLOCK_KM / 2 - cy) - BLOCK_KM / 2);
      if (Math.hypot(dx, dy) > POI_DROP_KM) dropBlock(key);
    }
  };

  const ndc = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const toLabel = new THREE.Vector3();

  const place = () => {
    const dim = view.mainLoop.gfxEngine.getWindowSize();
    const w = dim.x | 0, h = dim.y | 0;
    camera.getWorldDirection(forward);

    for (const label of labels) {
      ndc.copy(label.world).project(camera);
      label.onScreen = ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1 && ndc.z <= 1
        && label.world.distanceTo(camera.position) <= POI_MAX_DISTANCE;
      if (!label.onScreen) {
        label.anchor.style.visibility = "hidden";
        continue;
      }
      label.sx = Math.round((ndc.x * 0.5 + 0.5) * w);
      label.sy = Math.round((-ndc.y * 0.5 + 0.5) * h);
      label.labelZ = toLabel.copy(label.world).sub(camera.position).dot(forward);
      label.anchor.style.transform = `translate(${label.sx}px,${label.sy}px)`;
    }
  };

  const declutter = () => {
    const candidates = labels.filter((l) => l.onScreen).sort((a, b) => a.labelZ - b.labelZ);

    const kept = [];
    for (const label of candidates) {
      const el = label.el;
      const hw = el.offsetWidth / 2;
      const hh = el.offsetHeight;
      const left = label.sx - hw, right = label.sx + hw;
      const top = label.sy - hh, bottom = label.sy;
      const overlaps = kept.some((k) => left < k.right && right > k.left && top < k.bottom && bottom > k.top);
      const hidden = overlaps || occlusion.isOccluded(camera, label.world);
      label.anchor.style.visibility = hidden ? "hidden" : "visible";
      if (!hidden) kept.push({ left, right, top, bottom });
    }
  };

  let dirty = true;
  const lastCamMatrix = new THREE.Matrix4();

  view.addFrameRequester(itowns.MAIN_LOOP_EVENTS.AFTER_RENDER, () => {
    if (!dirty && camera.matrixWorld.equals(lastCamMatrix)) return;
    lastCamMatrix.copy(camera.matrixWorld);
    dirty = false;
    place();
    refreshBlocks();
    declutter();
  });

  return labels;
}
