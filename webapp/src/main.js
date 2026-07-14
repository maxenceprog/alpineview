import * as itowns from "itowns";
import { API_BASE_URL } from "./apiConfig.js";
import { setBrightness, setMapSource } from "./layers.js";
import { wgs84ToL93 } from "./proj.js";
import { DracoTileLayer } from "./dracoLayer.js";
import { initEnvironment } from "./environment.js";
import { BuildingsLayer } from "./overlays.js";
import { initPoi } from "./poi.js";

itowns.CRS.defs(
  "EPSG:2154",
  "+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs",
);

const extent = new itowns.Extent("EPSG:2154", 256000, 1280000, 5952000, 6976000);

const viewerDiv = document.getElementById("viewerDiv");
const params = new URLSearchParams(location.search);
const x = 1000 * (parseFloat(params.get("x")) || 965.5);
const y = 1000 * (parseFloat(params.get("y")) || 6430.5);

const PLANAR_CONTROLS = {
  // Zenith angle counts from straight-down: iTowns' 82.5° default stops the
  // tilt short of the horizon, so peaks above the camera can't be looked at.
  maxZenithAngle: 130,
  maxAltitude: 100000,
};

const view = new itowns.PlanarView(viewerDiv, extent, {
  maxSubdivisionLevel: 12,
  // iTowns displaces the tile plane at its vertices only, so its 16x16 default
  // grid samples the elevation every ~62 m at level 10 — narrow summits are
  // simply flattened away, and depth picking (wheel zoom, smart travel) misses
  // them. The DEM tiles are hidden wherever a draco mesh shows, so the extra
  // vertices cost memory, not draw time.
  segments: 64,
  controls: PLANAR_CONTROLS,
  placement: {
    coord: new itowns.Coordinates("EPSG:2154", x, y),
    range: 8000,
    tilt: 25,
    heading: 0,
  },
});


window.view = view;

// Custom DEM built from the lidar meshes (scripts/build_dem_tiles.py), on the
// view's own TMS grid — displaces the (hidden) quadtree planes so depth
// picking, SSE subdivision and culling follow the real terrain.
const demSource = new itowns.TMSSource({
  crs: "EPSG:2154",
  url: `${API_BASE_URL}/dem/\${z}/\${x}/\${y}.bil`,
  format: "image/x-bil;bits=32",
  zoom: { min: 0, max: 11 },
});


const demLayer = new itowns.ElevationLayer("dem", {
  source: demSource,
  noDataValue: -99999,
  clampValues: { min: 0 },
});

view.addLayer(demLayer)

// Beyond the draco levels (10-12) the terrain IS the DEM-displaced quadtree —
// a 2.5D heightfield mesh — so it needs its own imagery: without a ColorLayer
// the distance renders plain grey. The draco tiles drape themselves (buildCanvas)
// and hide the DEM tile underneath, so these two never show at once.
const ignSource = (name) =>
  new itowns.WMSSource({
    url: "https://data.geopf.fr/wms-r/wms",
    name,
    crs: "EPSG:2154",
    extent,
    version: "1.3.0",
    format: "image/jpeg",
  });

const orthoLayer = new itowns.ColorLayer("ortho", {
  source: ignSource("ORTHOIMAGERY.ORTHOPHOTOS"),
});
const planLayer = new itowns.ColorLayer("plan", {
  source: ignSource("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2"),

});

view.addLayer(orthoLayer);
view.addLayer(planLayer);
planLayer.visible = false;




// Wheel zoom and middle-click smart travel aim at the depth-picked point on
// the DEM-displaced planes. Where the heightmap isn't loaded yet (or has no
// data) the pick lands on the z=0 plane, far below the terrain, and the
// animated travel "gets lost" — discard those moves instead.
{
  // Middle-click calls initiateSmartTravel() without the event — capture the
  // pointer position ourselves (window capture phase runs before the
  // controls' own handler).
  let lastMouseEvent = null;
  window.addEventListener("mousedown", (e) => { lastMouseEvent = e; }, true);
  const pickIsUsable = (event) => {
    if (!event) return false;
    const picked = view.getPickingPositionFromDepth(view.eventToViewCoords(event));
    return picked !== undefined && picked.z > 1;
  };
  const { initiateZoom, initiateSmartTravel } = view.controls;
  view.controls.initiateZoom = (event) => {
    if (pickIsUsable(event)) initiateZoom.call(view.controls, event);
  };
  view.controls.initiateSmartTravel = (event) => {
    if (pickIsUsable(event ?? lastMouseEvent)) initiateSmartTravel.call(view.controls, event);
  };
}

// Draco tiles and the DEM share the tile server's host queue, and a draco
// command holds its slot through fetch + decode + imagery drape. iTowns'
// default of 6 in-flight commands per host starves it; the dev server (and the
// API) speak HTTP/2, so a much wider queue is fine.
view.mainLoop.scheduler.maxCommandsPerHost = 24;

const dracoLayer = new DracoTileLayer("draco", { view });
dracoLayer.priority = 10;
view.addLayer(dracoLayer);

let planVisible = false;
document.getElementById("layer-toggle").addEventListener("click", () => {
  planVisible = !planVisible;

  planLayer.visible = planVisible;
  orthoLayer.visible = !planVisible;
  setMapSource(planVisible ? "plan" : "ortho");
  dracoLayer.refreshTextures();
  view.notifyChange(view.tileLayer);
});

const { setSunDate, setEnabled } = initEnvironment(view);
setBrightness(1.2);

view.addLayer(new BuildingsLayer("buildings", view));

initPoi(view);

const envEnabledInput = document.getElementById("env-enabled");
envEnabledInput.addEventListener("change", () => {
  setEnabled(envEnabledInput.checked);
});

const envPanel = document.getElementById("env-panel");
document.getElementById("env-toggle").addEventListener("click", () => {
  envPanel.classList.toggle("hidden");
});

// Help panel: shown on a first visit, hidden once dismissed, always reachable
// again through the "?" button.
const helpPanel = document.getElementById("help-panel");
const HELP_SEEN = "montagne3d.helpSeen";
helpPanel.classList.toggle("hidden", localStorage.getItem(HELP_SEEN) === "1");
document.getElementById("help-close").addEventListener("click", () => {
  helpPanel.classList.add("hidden");
  localStorage.setItem(HELP_SEEN, "1");
});
document.getElementById("help-toggle").addEventListener("click", () => {
  helpPanel.classList.toggle("hidden");
});

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

// Place search (Nominatim): animate the camera to the picked result's L93
// position via iTowns' camera travel.
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

function goToSearchResult(result) {
  hideSearchResults();
  const [xm, ym] = wgs84ToL93.forward([parseFloat(result.lon), parseFloat(result.lat)]);
  itowns.CameraUtils.animateCameraToLookAtTarget(view, view.camera3D, {
    coord: new itowns.Coordinates("EPSG:2154", xm, ym),
    range: 8000,
    tilt: 25,
    heading: 0,
  });
}

function renderSearchResults(results) {
  searchResultsEl.innerHTML = "";
  for (const result of results) {
    const item = document.createElement("div");
    item.className = "search-result";
    item.textContent = result.display_name;
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
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=${SEARCH_RESULT_LIMIT}`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);
    const data = await res.json();
    if (!data.length) { hideSearchResults(); return; }
    if (data.length === 1 && jumpOnSingleResult) {
      goToSearchResult(data[0]);
    } else {
      renderSearchResults(data);
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
