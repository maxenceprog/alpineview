import DOMPurify from "dompurify";
import * as itowns from "itowns";
import MarkdownIt from "markdown-it";
import * as THREE from "three";
import { KIND_CLASS, fetchCellPois, fetchDocDetail, fetchWaypointDetail, resolveEmbeddedImages } from "./camptocampApi.js";
import { setActiveTraces } from "./gpxPainter.js";
import { createPoiOcclusion } from "./poiOcclusion.js";
import { mercToLocal } from "./workFrame.js";

const BLOCK_KM = 8;

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
let poiTraces = []; // { documentId, lines: [[mx, my], ...][] }

function pushTraces() {
  setActiveTraces(poiTraces.flatMap((t) => t.lines));
}


function drawTrace(doc) {
  if (!doc.geometry?.geom_detail) return;
  const geojson = JSON.parse(doc.geometry.geom_detail);
  const lines = (geojson.type === "MultiLineString" ? geojson.coordinates : [geojson.coordinates])
    .map((coords) => coords.map(([mx, my]) => [mx, my]));
  poiTraces.push({ documentId: doc.document_id, lines });
}

export function showPoiPanel(poi) {
  const token = ++poiRequestToken;
  const panel = document.getElementById("poi-panel");
  const title = document.getElementById("poi-title");
  const meta = document.getElementById("poi-meta");
  const text = document.getElementById("poi-text");
  const link = document.getElementById("poi-link");
  const tracesButton = document.getElementById("poi-traces");
  tracesButton.style.display = "none";
  poiTraces = [];
  pushTraces();

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

    const routes = doc.associations?.all_routes?.documents ?? [];
    const outings = doc.associations?.recent_outings?.documents ?? [];
    if (routes.length || outings.length) {
      tracesButton.style.display = "";
      tracesButton.textContent = "Montrer les traces récentes";
      let shown = [];
      tracesButton.onclick = () => {
        if (poiTraces.length) {
          poiTraces = [];
          pushTraces();
          tracesButton.textContent = "Montrer les traces récentes";
          return;
        }
        if (shown.length) {
          poiTraces = shown;
          pushTraces();
          tracesButton.textContent = "Cacher les traces récentes";
          return;
        }
        tracesButton.textContent = "Chargement…";
        Promise.allSettled([
          ...routes.map((r) => fetchDocDetail("routes", r.document_id)),
          ...outings.map((o) => fetchDocDetail("outings", o.document_id)),
        ]).then((results) => {
          if (token !== poiRequestToken) return;
          poiTraces = [];
          for (const result of results) {
            if (result.status === "fulfilled") drawTrace(result.value);
            else console.warn("trace fetch failed", result.reason);
          }
          shown = poiTraces;
          pushTraces();
          tracesButton.textContent = "Cacher les traces récentes";
        });
      };
    }

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
