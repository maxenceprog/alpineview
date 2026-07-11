import * as THREE from "three";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { createScene, updateSunDirection, updateSky, updateShadowCamera } from "./scene.js";
import { createFlyCamera, createWalkCamera } from "./camera.js";
import { initTouchControls } from "./touchControls.js";
import { IS_MOBILE } from "./deviceInfo.js";
import { sunDirectionAt } from "./sun.js";
import { TileManager } from "./tileManager.js";
import { wgs84ToL93, l93ToWgs84 } from "./proj.js";
import { createSlippyMap } from "./slippyMap.js";
import {
  CLASS_INFO as COSIA_CLASS_INFO,
  palette as cosiaPalette,
  setClassColor as setCosiaColor,
  setSatelliteColors,
} from "./cosia.js";
import { installTestControls } from "./testControls.js";
import { createBuildingsOverlay, createPoiOverlay } from "./overlays.js";
import { fetchWaypointDetail, resolveEmbeddedImages } from "./poi.js";
import { setBrightness, getBrightness } from "./layers.js";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

// --- Renderer ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
// Uncapped DPR on a 3x-retina phone triples fragment-shader/fill cost for no
// visible gain at that screen size — cap harder on mobile than desktop.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_MOBILE ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
renderer.domElement.style.transition = "opacity 0.35s ease";
document.body.appendChild(renderer.domElement);
initTouchControls(renderer.domElement);

// CSS2D label renderer (POI text labels) — overlays the WebGL canvas.
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = "absolute";
labelRenderer.domElement.style.top = "0";
labelRenderer.domElement.style.left = "0";
labelRenderer.domElement.style.pointerEvents = "none";
labelRenderer.domElement.style.transition = "opacity 0.35s ease";
document.body.appendChild(labelRenderer.domElement);

// --- Scene + Tile manager + Camera ---
// tileManager is created before the cameras because flyCtrl's ground-clamp
// callback captures it by reference — safe since the callback only ever
// runs later (render loop / teleport calls), never during this setup.
const scene    = createScene();
const tileManager = new TileManager(scene);
const flyCtrl  = createFlyCamera(renderer, (x, z) => tileManager.getHeightAt(x, z));
const walkCtrl = createWalkCamera(renderer, scene);
scene.add(flyCtrl.camera);
scene.add(walkCtrl.camera);

// Start above Barre des Écrins tile area (L93 ≈ x=965.5 km, y=6430.5 km),
// unless the URL carries ?x=&y= (L93 km) from a previous session/share link.
const urlParams = new URLSearchParams(window.location.search);
const urlX = parseFloat(urlParams.get("x"));
const urlY = parseFloat(urlParams.get("y"));
const hasUrlPos = !isNaN(urlX) && !isNaN(urlY);

const INIT_POS    = hasUrlPos
  ? new THREE.Vector3(urlX, 8, -urlY)
  : new THREE.Vector3(965.5, 8, -6430.5);
const INIT_TARGET = hasUrlPos
  ? new THREE.Vector3(urlX, 2, -urlY)
  : new THREE.Vector3(965.5, 2, -6430.5);
flyCtrl.teleport(INIT_POS, INIT_TARGET);

// Reflect the camera's L93 (x, y) position in the URL so the view is
// shareable/bookmarkable; replaceState avoids polluting browser history.
function updateURLFromPosition(pos) {
  const params = new URLSearchParams(window.location.search);
  params.set("x", pos.x.toFixed(3));
  params.set("y", (-pos.z).toFixed(3));
  const newUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
  window.history.replaceState(null, "", newUrl);
}
if (!hasUrlPos) updateURLFromPosition(INIT_POS);

let activeCtrl = flyCtrl;

window.addEventListener("keydown", (e) => {
  if (e.code !== "KeyC") return;
  // Don't switch camera mode if search bar is focused
  if (document.activeElement === searchInput) return;

  if (activeCtrl === flyCtrl) {
    const { yaw, pitch } = flyCtrl.getOrientation();
    walkCtrl.camera.position.copy(flyCtrl.camera.position);
    walkCtrl.setOrientation(yaw, pitch);
    flyCtrl.disable();
    walkCtrl.enable();
    activeCtrl = walkCtrl;
    cameraModeEl.textContent = "Walk";
  } else {
    const { yaw, pitch } = walkCtrl.getOrientation();
    flyCtrl.camera.position.copy(walkCtrl.camera.position);
    flyCtrl.setOrientation(yaw, pitch);
    walkCtrl.disable();
    flyCtrl.enable();
    activeCtrl = flyCtrl;
    cameraModeEl.textContent = "Fly";
  }
});

// --- DOM refs ---
const status         = document.getElementById("status");
const searchInput    = document.getElementById("search-input");
const searchBtn      = document.getElementById("search-btn");
const searchResultsEl = document.getElementById("search-results");
const sidebarLeft    = document.getElementById("sidebar-left");
const toggleLeft     = document.getElementById("toggle-left");
const sidebarRight   = document.getElementById("sidebar-right");
const toggleRight    = document.getElementById("toggle-right");
const resizeRight    = document.getElementById("resize-right");
const layerBtns      = document.querySelectorAll(".layer-selector .layer-btn");
const sunDateInput   = document.getElementById("sun-date");
const sunTimeInput   = document.getElementById("sun-time");
const sunHint        = document.getElementById("sun-hint");
const cameraModeEl   = document.getElementById("camera-mode");
const fogDensityInput  = document.getElementById("fog-density");
const fogDensityValue  = document.getElementById("fog-density-value");
const sunTimeLabel     = document.getElementById("sun-time-label");

// --- Slippy map (Leaflet/OpenTopoMap): manually toggled via #map-mode-btn,
// replaces the 3D view entirely while active. camera.position stays the
// single source of truth for "where are we" in both modes — see
// slippyMap.js for the altitude<->zoom heuristic used to keep the two views'
// positions closely connected across the switch. The two layers cross-fade
// (both elements have a CSS opacity transition) instead of hard-swapping.
const FADE_MS = 350;
const slippyMapEl = document.getElementById("slippy-map");
const slippyMap = createSlippyMap(slippyMapEl);
const mapModeBtn = document.getElementById("map-mode-btn");
let inMapMode = false;

slippyMap.onChange((lat, lon, altitudeKm) => {
  if (!inMapMode) return;
  const [xm, ym] = wgs84ToL93.forward([lon, lat]);
  activeCtrl.camera.position.set(xm / 1000, altitudeKm, -ym / 1000);
  updateURLFromPosition(activeCtrl.camera.position);
});

function enterMapMode() {
  inMapMode = true;
  const pos = activeCtrl.camera.position;
  const [lon, lat] = l93ToWgs84.forward([pos.x * 1000, -pos.z * 1000]);
  slippyMap.setViewFromCamera(lat, lon, pos.y);

  slippyMap.show(); // display:'' + invalidateSize; opacity still 0 → fades in below
  requestAnimationFrame(() => { slippyMapEl.style.opacity = "1"; });
  renderer.domElement.style.opacity = "0";
  labelRenderer.domElement.style.opacity = "0";
  // Actually stop rendering/painting the 3D layer only once its fade-out is done.
  setTimeout(() => {
    renderer.domElement.style.display = "none";
    labelRenderer.domElement.style.display = "none";
  }, FADE_MS);

  status.textContent = "Open Topo Map";
  mapModeBtn.textContent = "🌍 3D view";
}

function exitMapMode() {
  inMapMode = false;
  renderer.domElement.style.display = "";
  labelRenderer.domElement.style.display = "";
  requestAnimationFrame(() => {
    renderer.domElement.style.opacity = "1";
    labelRenderer.domElement.style.opacity = "1";
  });
  slippyMapEl.style.opacity = "0";
  setTimeout(() => slippyMap.hide(), FADE_MS);

  const pos = activeCtrl.camera.position.clone();
  activeCtrl.teleport(pos, new THREE.Vector3(pos.x, 0, pos.z));
  status.textContent = "Ready";
  mapModeBtn.textContent = "🗺️ Open Topo Map";
}

mapModeBtn.addEventListener("click", () => {
  if (inMapMode) exitMapMode(); else enterMapMode();
});

// --- Sidebar toggles ---
toggleLeft.addEventListener("click", () => {
  sidebarLeft.classList.toggle("collapsed");
  toggleLeft.textContent = sidebarLeft.classList.contains("collapsed") ? "›" : "‹";
});

toggleRight.addEventListener("click", () => {
  sidebarRight.classList.toggle("collapsed");
  toggleRight.textContent = sidebarRight.classList.contains("collapsed") ? "‹" : "›";
});

resizeRight.addEventListener("click", () => {
  sidebarRight.classList.toggle("wide");
  resizeRight.textContent = sidebarRight.classList.contains("wide") ? "⤡" : "⤢";
});

// --- Search ---
const SEARCH_RESULT_LIMIT = 5;

function hideSearchResults() {
  searchResultsEl.classList.remove("visible");
  searchResultsEl.innerHTML = "";
}

function goToSearchResult(result) {
  const { display_name, lat, lon } = result;
  status.textContent = display_name.split(",").slice(0, 2).join(",");
  hideSearchResults();

  // Convert WGS84 (lat/lon) to L93 (scene coordinates in km)
  const l93 = wgs84ToL93.forward([parseFloat(lon), parseFloat(lat)]);
  const x_km = l93[0] / 1000; // convert m to km
  const y_km = l93[1] / 1000;

  // Teleport camera to location (fly mode: at altitude; walk mode: will snap to ground)
  const altitude = activeCtrl === flyCtrl ? 5 : 0; // fly at 5 km altitude, walk snaps to ground
  const target = new THREE.Vector3(x_km, altitude, -y_km); // negate Y for L93→scene conversion
  const lookAt = new THREE.Vector3(x_km, 0, -y_km);
  activeCtrl.teleport(target, lookAt);
  updateURLFromPosition(target);
}

function renderSearchResults(results) {
  searchResultsEl.innerHTML = "";
  results.forEach((result) => {
    const item = document.createElement("div");
    item.className = "search-result";
    item.textContent = result.display_name;
    item.addEventListener("click", () => goToSearchResult(result));
    searchResultsEl.append(item);
  });
  searchResultsEl.classList.toggle("visible", results.length > 0);
}

async function doSearch({ jumpOnSingleResult } = {}) {
  const q = searchInput.value.trim();
  if (!q) return;
  searchBtn.disabled = true;
  status.textContent = `Searching "${q}"…`;
  try {
    const res  = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=${SEARCH_RESULT_LIMIT}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);
    const data = await res.json();
    if (!data.length) { status.textContent = `Not found: "${q}"`; hideSearchResults(); return; }

    if (data.length === 1 && jumpOnSingleResult) {
      goToSearchResult(data[0]);
    } else {
      status.textContent = `${data.length} result${data.length > 1 ? "s" : ""} for "${q}"`;
      renderSearchResults(data);
    }
  } catch (e) {
    status.textContent = `Search error: ${e.message}`;
    hideSearchResults();
  } finally {
    searchBtn.disabled = false;
  }
}
const SEARCH_DEBOUNCE_MS = 400;
const SEARCH_MIN_CHARS   = 3;
let searchDebounceTimer  = null;

searchBtn.addEventListener("click", () => doSearch({ jumpOnSingleResult: true }));
searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch({ jumpOnSingleResult: true }); });
searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounceTimer);
  if (searchInput.value.trim().length < SEARCH_MIN_CHARS) { hideSearchResults(); return; }
  searchDebounceTimer = setTimeout(() => doSearch({ jumpOnSingleResult: false }), SEARCH_DEBOUNCE_MS);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#search-form")) hideSearchResults();
});

// --- Layer selector ---
function setActiveLayer(layerId) {
  layerBtns.forEach((b) => b.classList.toggle("active", b.dataset.layer === layerId));
  tileManager.setLayer(layerId);
  // The right sidebar hosts the COSIA palette; show it only for that layer.
  const showRight = layerId === "cosia";
  sidebarRight.style.display = showRight ? "" : "none";
  toggleRight.style.display  = showRight ? "" : "none";
  resizeRight.style.display  = showRight ? "" : "none";
  document.getElementById("cosia-panel").style.display = showRight ? "" : "none";
}

layerBtns.forEach((btn) => {
  btn.addEventListener("click", () => setActiveLayer(btn.dataset.layer));
});
// Show right panel for the initial layer
setActiveLayer(tileManager._layer);

// --- Satellite texture brightness ---
const brightnessValue = document.getElementById("brightness-value");
const BRIGHTNESS_STEP = 0.15;
const BRIGHTNESS_MAX = 1.75;
const BRIGHTNESS_MIN = 0.4;

function adjustBrightness(delta) {
  const next = Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, getBrightness() + delta));
  setBrightness(next);
  brightnessValue.textContent = `${next.toFixed(1)}x`;
}

document.getElementById("brightness-up").addEventListener("click", () => adjustBrightness(BRIGHTNESS_STEP));
document.getElementById("brightness-down").addEventListener("click", () => adjustBrightness(-BRIGHTNESS_STEP));

// --- COSIA palette: one colour picker per class ---
function buildPaletteUI(containerId, classInfo, paletteMap, setColor) {
  const container = document.getElementById(containerId);
  for (const { code, label } of classInfo) {
    const row = document.createElement("div");
    row.className = "color-row";
    const lbl = document.createElement("label");
    lbl.textContent = label;
    const input = document.createElement("input");
    input.type = "color";
    input.value = paletteMap[code];
    input.addEventListener("input", (e) => setColor(code, e.target.value));
    row.append(lbl, input);
    container.append(row);
  }
}
buildPaletteUI("cosia-palette", COSIA_CLASS_INFO, cosiaPalette, setCosiaColor);

// COSIA: toggle between the editable class palette and baked satellite colours.
document.getElementById("cosia-sat").addEventListener("change", (e) => {
  setSatelliteColors(e.target.checked);
  // Per-class pickers only apply in palette mode.
  document.getElementById("cosia-palette").style.display = e.target.checked ? "none" : "";
  tileManager.refreshLayer();
});

// --- Sun ---
let currentSunDir = new THREE.Vector3(0.5, 1.0, 0.8).normalize();

// --- POI info panel: populated when a peak/pass/hut/parking label is clicked ---
const WAYPOINT_TYPE_LABEL = { summit: "Summit", pass: "Pass", hut: "Hut", access: "Parking / access" };
// Camptocamp text is a markdown dialect with some raw inline HTML (e.g. <sup>) —
// render it, then sanitize before inserting, since it's third-party wiki content.
const poiMarkdown = new MarkdownIt({ html: true, linkify: true });

function poiMeta(doc) {
  return [WAYPOINT_TYPE_LABEL[doc.waypoint_type] ?? doc.waypoint_type, doc.elevation ? `${doc.elevation} m` : null]
    .filter(Boolean).join(" · ");
}

// Guards against a slower earlier request overwriting the panel after a
// second POI is clicked before the first one's (multi-fetch) load finishes.
let poiRequestToken = 0;

const ACTIVITY_EMOJI = {
  skitouring: "⛷️",
  snow_ice_mixed: "🧊",
  mountain_climbing: "🏔️",
  rock_climbing: "🧗",
  ice_climbing: "🧊",
  hiking: "🥾",
  snowshoeing: "🐾",
  via_ferrata: "🪜",
  slacklining: "🎪",
  paragliding: "🪂",
  mountain_biking: "🚵",
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

/** Fill a <ul class="poi-link-list"> with links built from Camptocamp association items. */
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

function showPoiPanel(poi) {
  const token = ++poiRequestToken;

  document.getElementById("cosia-panel").style.display = "none";
  const panel = document.getElementById("poi-panel");
  const title = document.getElementById("poi-title");
  const meta  = document.getElementById("poi-meta");
  const text  = document.getElementById("poi-text");
  const link  = document.getElementById("poi-link");

  title.textContent = poi.locales[0].title;
  meta.textContent = poiMeta(poi);
  text.textContent = "Loading…";
  link.href = `https://www.camptocamp.org/waypoints/${poi.document_id}`;
  renderPoiLinkList("poi-routes-section", "poi-routes", [], "routes", routeTitle);
  renderPoiLinkList("poi-outings-section", "poi-outings", [], "outings", outingTitle);

  panel.style.display = "";
  sidebarRight.style.display = "";
  sidebarRight.classList.remove("collapsed");
  toggleRight.style.display = "";
  resizeRight.style.display = "";

  fetchWaypointDetail(poi.document_id).then(async (doc) => {
    if (token !== poiRequestToken) return;
    meta.textContent = poiMeta(doc);

    renderPoiLinkList("poi-routes-section", "poi-routes", doc.associations?.all_routes?.documents, "routes", routeTitle);
    renderPoiLinkList("poi-outings-section", "poi-outings", doc.associations?.recent_outings?.documents, "outings", outingTitle);

    const locale = doc.locales?.[0];
    const raw = [locale?.access, locale?.description].filter(Boolean).join("\n\n");
    if (!raw) { text.textContent = "No description available."; return; }
    const resolved = await resolveEmbeddedImages(raw);
    if (token !== poiRequestToken) return;
    text.innerHTML = DOMPurify.sanitize(poiMarkdown.render(resolved));
  }).catch(() => { if (token === poiRequestToken) text.textContent = "Failed to load details."; });
}

// --- Proximity overlays: buildings auto-load near the camera; vegetation
// rides the z=2 terrain tiles inside the tile manager.
const buildingsOverlay = createBuildingsOverlay(
  scene,
  () => currentSunDir,
  (x0, y0) => tileManager.getCellTextureData(x0, y0),
);
const poiOverlay = createPoiOverlay(scene, tileManager, showPoiPanel);
const vegetationToggle = {
  enabled: false,
  setEnabled(on) {
    this.enabled = on;
    tileManager.setVegetationEnabled(on);
  },
};

function applySunDate(date) {
  currentSunDir = sunDirectionAt(date);
  updateSunDirection(scene, currentSunDir);
  updateSky(scene, currentSunDir);
  tileManager.setSunDir(currentSunDir);
  sunHint.classList.toggle("visible", currentSunDir.y <= 0);
}

function minutesToHHMM(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function getSunDateFromInputs() {
  const dateStr = sunDateInput.value;
  const minutes = parseInt(sunTimeInput.value, 10);
  if (!dateStr || isNaN(minutes)) return null;
  return new Date(`${dateStr}T${minutesToHHMM(minutes)}:00`);
}

sunDateInput.addEventListener("change", () => {
  const d = getSunDateFromInputs();
  if (d && !isNaN(d)) applySunDate(d);
});

sunTimeInput.addEventListener("input", () => {
  sunTimeLabel.textContent = minutesToHHMM(parseInt(sunTimeInput.value, 10));
  const d = getSunDateFromInputs();
  if (d && !isNaN(d)) applySunDate(d);
});

(function initSun() {
  const formatter = new Intl.DateTimeFormat("fr-FR", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZone: "Europe/Paris",
  });
  const now = new Date();
  now.setHours(12, 0, 0, 0);

  const parts  = formatter.formatToParts(now);
  const year   = parts.find((p) => p.type === "year").value;
  const month  = parts.find((p) => p.type === "month").value;
  const day    = parts.find((p) => p.type === "day").value;
  const hour   = parseInt(parts.find((p) => p.type === "hour").value, 10);
  const minute = parseInt(parts.find((p) => p.type === "minute").value, 10);
  const totalMinutes = hour * 60 + minute;

  sunDateInput.value   = `${year}-${month}-${day}`;
  sunTimeInput.value   = totalMinutes;
  sunTimeLabel.textContent = minutesToHHMM(totalMinutes);

  applySunDate(now);
})();

// --- Fog ---
fogDensityInput.addEventListener("input", (e) => {
  const density = parseFloat(e.target.value);
  scene.fog.density = density;
  fogDensityValue.textContent = density.toFixed(2);
});

// --- Buildings / Vegetation: toggle the proximity overlays on/off ---
function wireOverlayToggle(selector, overlay) {
  document.querySelectorAll(selector).forEach((btn) => {
    btn.addEventListener("click", () => {
      const on = !overlay.enabled;
      overlay.setEnabled(on);
      btn.classList.toggle("active", on);
    });
  });
}
wireOverlayToggle(".buildings-btn", buildingsOverlay);
wireOverlayToggle(".vegetation-btn", vegetationToggle);
wireOverlayToggle(".poi-btn", poiOverlay);

// --- Resize ---
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
  flyCtrl.onResize();
  walkCtrl.onResize();
});

// --- Test controls (shift+left-click COPC points, shift+right-click rebuild):
// only under `npm run test_build_and_serve`, whose vite config defines
// __TEST_CONTROLS__ and serves the /debug/* routes they need.
if (__TEST_CONTROLS__) {
  installTestControls({
    renderer,
    scene,
    tileManager,
    getCamera: () => activeCtrl.camera,
  });
}

// --- Render loop ---
const clock    = new THREE.Clock();
const debugEl  = document.getElementById("debug-overlay");
const skySphere  = scene.getObjectByName("sky");
const sunMesh  = scene.getObjectByName("sun-mesh");
const sunGlow  = scene.getObjectByName("sun-glow");

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();

  // The 2D map handles its own rendering/interaction — nothing to draw here.
  // activeCtrl.update() is skipped too: fly mode applies WASD directly to
  // camera.position regardless of enable()/disable(), which would fight the
  // position slippyMap.onChange() is writing.
  if (inMapMode) return;

  activeCtrl.update(dt);
  tileManager.update(activeCtrl.camera, activeCtrl);
  buildingsOverlay.update(activeCtrl.camera);
  poiOverlay.update(activeCtrl.camera);
  if (skySphere) skySphere.position.copy(activeCtrl.camera.position);
  if (sunMesh) {
    const aboveHorizon = currentSunDir.y > -0.02;
    sunMesh.visible = aboveHorizon;
    sunGlow.visible = aboveHorizon;
    if (aboveHorizon) {
      const pos = activeCtrl.camera.position.clone().addScaledVector(currentSunDir, 350);
      sunMesh.position.copy(pos);
      sunGlow.position.copy(pos);
    }
  }
  updateShadowCamera(scene, activeCtrl.camera.position);
  renderer.render(scene, activeCtrl.camera);
  labelRenderer.render(scene, activeCtrl.camera);

  if (debugEl) {
    const p = activeCtrl.camera.position;
    debugEl.textContent =
      `cam  x:${p.x.toFixed(2)}  y:${p.y.toFixed(2)}  z:${p.z.toFixed(2)}\n` +
      `L93  x:${p.x.toFixed(2)} km  y:${(-p.z).toFixed(2)} km`;
  }
}

animate();
