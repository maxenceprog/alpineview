import * as itowns from "itowns";
import * as THREE from "three";
import { IS_MOBILE } from "./deviceInfo.js";
import { DracoTileLayer } from "./dracoLayer.js";
import { initEnvironment } from "./environment.js";
import { initHdAvailability } from "./hdAvailability.js";
import { setBrightness } from "./layers.js";
import { BuildingsLayer } from "./overlays.js";
import { initPoi, searchWaypoints, showPoiPanel } from "./poi.js";
import { initTouchControls } from "./touchControls.js";
import { setMapSource } from "./wmts.js";

itowns.CRS.defs(
  "EPSG:2154",
  "+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs",
);

const extent = new itowns.Extent("EPSG:2154", 256000, 1280000, 5952000, 6976000);

const viewerDiv = document.getElementById("viewerDiv");
const params = new URLSearchParams(location.search);
const x = 1000 * (parseFloat(params.get("x")) || 954.6);
const y = 1000 * (parseFloat(params.get("y")) || 6438.5);

const PLANAR_CONTROLS = {
  // >0: at nadir the orbit offset aligns with camera.up and handleRotation's
  // lookAt loses its azimuth to a degenerate cross product
  minZenithAngle: 5,
  maxZenithAngle: 130,
  maxAltitude: 30000,
  zoomFactor: 1.4,
};

const view = new itowns.PlanarView(viewerDiv, extent, {
  maxSubdivisionLevel: 12,
  segments: 64,
  controls: PLANAR_CONTROLS,
  placement: {
    coord: new itowns.Coordinates("EPSG:2154", x, y),
    range: 5000,
    tilt: 80,
    heading: 0,
  },
});


window.view = view;

initTouchControls(view);





{
  let lastMouseEvent = null;
  window.addEventListener("mousedown", (e) => { lastMouseEvent = e; }, true);
  const pickIsUsable = (event) => {
    if (!event) return false;
    const picked = view.getPickingPositionFromDepth(view.eventToViewCoords(event));
    return picked !== undefined && picked.z > 1;
  };
  const { initiateZoom } = view.controls;
  view.controls.initiateZoom = (event) => {
    if (pickIsUsable(event)) initiateZoom.call(view.controls, event);
  };

  const _ray = new THREE.Raycaster();
  const _down = new THREE.Vector3(0, 0, -1);
  const terrainZAt = (x, y) => {
    const meshes = view.getLayerById("draco")?.object3d.children ?? [];
    _ray.set(new THREE.Vector3(x, y, 5000), _down);
    const hits = _ray.intersectObjects(meshes, true);
    return hits.length ? hits[0].point.z : null;
  };


  view.controls.initiateSmartTravel = (event) => {
    const e = event ?? lastMouseEvent;
    if (!pickIsUsable(e)) return;
    const controls = view.controls;
    const target = view.getPickingPositionFromDepth(view.eventToViewCoords(e));

    const dir = target.clone().sub(view.camera3D.position);
    dir.z = 0;
    dir.normalize();
    const distance = view.camera3D.position.distanceTo(target);
    const height = THREE.MathUtils.lerp(
      controls.smartTravelHeightMin,
      controls.smartTravelHeightMax,
      Math.min(distance / 5000, 1),
    );

    const moveTarget = target.clone();
    if (controls.enableRotation) moveTarget.add(dir.multiplyScalar(-height * 2));
    moveTarget.z = target.z + height;

    const terrainAtEnd = terrainZAt(moveTarget.x, moveTarget.y);
    if (terrainAtEnd !== null) {
      moveTarget.z = Math.max(moveTarget.z, terrainAtEnd + controls.smartTravelHeightMin);
    }

    controls.initiateTravel(moveTarget, "auto", target, true);
  };
}

view.mainLoop.scheduler.maxCommandsPerHost = 24;

const dracoLayer = new DracoTileLayer("draco", { view });
dracoLayer.priority = 10;
view.addLayer(dracoLayer);

let planVisible = false;
document.getElementById("layer-toggle").addEventListener("click", () => {
  planVisible = !planVisible;

  setMapSource(planVisible ? "plan" : "ortho");
  dracoLayer.refreshTextures();
  view.notifyChange(view.tileLayer);
});

const { setSunDate, setEnabled, setShadowsEnabled } = initEnvironment(view);
setBrightness(1.2);

view.addLayer(new BuildingsLayer("buildings", view));

initPoi(view);

import("./consoleControls.js").then(({ initConsoleControls }) => initConsoleControls(view));

if (__TEST_CONTROLS__) {
  import("./testControls.js").then(({ initTestControls }) => initTestControls(view));
}

const envEnabledInput = document.getElementById("env-enabled");
envEnabledInput.addEventListener("change", () => {
  setEnabled(envEnabledInput.checked);
});

const shadowsInput = document.getElementById("shadows-enabled");
shadowsInput.addEventListener("change", () => {
  setShadowsEnabled(shadowsInput.checked);
});

const envPanel = document.getElementById("env-panel");
if (IS_MOBILE) envPanel.classList.add("hidden");
document.getElementById("env-toggle").addEventListener("click", () => {
  envPanel.classList.toggle("hidden");
});

const helpPanel = document.getElementById("help-panel");
const HELP_SEEN = "3dalpsview.helpSeen";
helpPanel.classList.toggle("hidden", localStorage.getItem(HELP_SEEN) === "1");
document.getElementById("help-close").addEventListener("click", () => {
  helpPanel.classList.add("hidden");
  localStorage.setItem(HELP_SEEN, "1");
});
document.getElementById("help-toggle").addEventListener("click", () => {
  helpPanel.classList.toggle("hidden");
});
initHdAvailability(helpPanel, view);

const sunDateInput = document.getElementById("sun-date");
const sunTimeInput = document.getElementById("sun-time");
const sunTimeValue = document.getElementById("sun-time-value");

function minutesToHHMM(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function applySunInputs() {
  const minutes = parseInt(sunTimeInput.value, 10);
  sunTimeValue.textContent = minutesToHHMM(minutes);
  const d = new Date(`${sunDateInput.value}T${minutesToHHMM(minutes)}:00`);
  if (!isNaN(d)) setSunDate(d);
}

const noon = new Date();
noon.setHours(12, 0, 0, 0);
sunDateInput.value = `${noon.getFullYear()}-${String(noon.getMonth() + 1).padStart(2, "0")}-${String(noon.getDate()).padStart(2, "0")}`;
applySunInputs();
sunDateInput.addEventListener("change", applySunInputs);
sunTimeInput.addEventListener("input", applySunInputs);

const brightnessInput = document.getElementById("brightness");
const brightnessValue = document.getElementById("brightness-value");
brightnessInput.addEventListener("input", () => {
  const v = parseFloat(brightnessInput.value);
  setBrightness(v);
  brightnessValue.textContent = v.toFixed(2);
  view.notifyChange(view.camera3D);
});

const fogInput = document.getElementById("fog-density");
const fogValue = document.getElementById("fog-density-value");
fogInput.addEventListener("input", () => {
  const v = parseFloat(fogInput.value);
  view.scene.fog.density = v / 1000;
  fogValue.textContent = v.toFixed(2);
  view.notifyChange(view.camera3D);
});

const searchInput = document.getElementById("search-input");
const searchBtn = document.getElementById("search-btn");
const searchResultsEl = document.getElementById("search-results");
const SEARCH_RESULT_LIMIT = 5;
const SEARCH_DEBOUNCE_MS = 400;
const SEARCH_MIN_CHARS = 3;
let searchDebounceTimer = null;

function hideSearchResults() {
  searchResultsEl.classList.remove("visible");
  searchResultsEl.innerHTML = "";
}

const SEARCH_RANGE = 3000;
const SEARCH_PITCH = Math.PI / 4;

function goToSearchResult(result) {
  hideSearchResults();
  showPoiPanel(result);
  const target = new THREE.Vector3(result.x, result.y, result.elevation ?? 0);
  const camPos = target.clone();
  camPos.z += SEARCH_RANGE * Math.sin(SEARCH_PITCH);
  camPos.y -= SEARCH_RANGE * Math.cos(SEARCH_PITCH);
  view.controls.initiateTravel(camPos, "auto", target, true);
  view.notifyChange(view.camera3D);
}

function renderSearchResults(results) {
  searchResultsEl.innerHTML = "";
  for (const result of results) {
    const item = document.createElement("div");
    item.className = "search-result";
    item.textContent = [result.title, result.elevation ? `${result.elevation} m` : null, result.area]
      .filter(Boolean).join(" · ");
    item.addEventListener("click", () => goToSearchResult(result));
    searchResultsEl.append(item);
  }
  searchResultsEl.classList.toggle("visible", results.length > 0);
}

async function doSearch({ jumpOnSingleResult } = {}) {
  const q = searchInput.value.trim();
  if (!q) return;
  searchBtn.disabled = true;
  try {
    const results = await searchWaypoints(q, SEARCH_RESULT_LIMIT);
    if (!results.length) { hideSearchResults(); return; }
    if (results.length === 1 && jumpOnSingleResult) {
      goToSearchResult(results[0]);
    } else {
      renderSearchResults(results);
    }
  } catch {
    hideSearchResults();
  } finally {
    searchBtn.disabled = false;
  }
}

searchBtn.addEventListener("click", () => doSearch({ jumpOnSingleResult: true }));
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch({ jumpOnSingleResult: true });
});
searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounceTimer);
  if (searchInput.value.trim().length < SEARCH_MIN_CHARS) { hideSearchResults(); return; }
  searchDebounceTimer = setTimeout(() => doSearch({ jumpOnSingleResult: false }), SEARCH_DEBOUNCE_MS);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#search-form")) hideSearchResults();
});
