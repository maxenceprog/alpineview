import * as THREE from "three";
import { searchWaypoints } from "./camptocampApi.js";
import { initCompass } from "./compass.js";
import { IS_MOBILE } from "./deviceInfo.js";
import { initHdAvailability } from "./hdAvailability.js";
import { initGpsCamera } from "./gpsCamera.js";
import { setShadowLift } from "./layers.js";
import { showPoiPanel } from "./poiLayer.js";
import { setMapSource } from "./wmtsTextures.js";

const SEARCH_RESULT_LIMIT = 5;
const SEARCH_DEBOUNCE_MS = 400;
const SEARCH_MIN_CHARS = 3;
const SEARCH_RANGE = 3000;
const SEARCH_PITCH = Math.PI / 4;

const DATA_USAGE_PRESETS = [
  { label: "très élevée", sse: 6 },
  { label: "élevée", sse: 10 },
  { label: "moyenne", sse: 14 },
  { label: "basse", sse: 18 },
];

const _exclusivePanels = new Set();

function initTogglePanel(toggleId, panelId) {
  const panel = document.getElementById(panelId);
  _exclusivePanels.add(panel);
  document.getElementById(toggleId).addEventListener("click", () => {
    const willOpen = panel.classList.contains("hidden");
    for (const p of _exclusivePanels) p.classList.add("hidden");
    if (willOpen) panel.classList.remove("hidden");
  });
  return panel;
}

function initLayerPanel(view, refreshTextures) {
  const layerPanel = initTogglePanel("layer-toggle", "layer-panel");
  const inputs = layerPanel.querySelectorAll("input[name=layer-source]");
  for (const input of inputs) {
    input.addEventListener("change", () => {
      setMapSource(input.value);
      refreshTextures();
      view.notifyChange(view.camera3D);
    });
  }

  const checked = [...inputs].find((input) => input.checked);
  if (checked && checked.value !== "ortho") {
    setMapSource(checked.value);
    refreshTextures();
    view.notifyChange(view.camera3D);
  }
}

function initEnvPanel(view, { setSunDate, setEnabled, setShadowsEnabled }) {
  const envEnabledInput = document.getElementById("env-enabled");
  envEnabledInput.addEventListener("change", () => {
    setEnabled(envEnabledInput.checked);
  });

  const shadowsInput = document.getElementById("shadows-enabled");
  shadowsInput.addEventListener("change", () => {
    setShadowsEnabled(shadowsInput.checked);
  });

  const envPanel = initTogglePanel("env-toggle", "env-panel");
  if (IS_MOBILE) envPanel.classList.add("hidden");

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

  const brightnessInput = document.getElementById("shadowLift");
  const brightnessValue = document.getElementById("shadowLift-value");
  setShadowLift(parseFloat(brightnessInput.value));
  brightnessInput.addEventListener("input", () => {
    const v = parseFloat(brightnessInput.value);
    setShadowLift(v);
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
}

function initHelpPanel(view) {
  const helpPanel = document.getElementById("help-panel");
  document.getElementById("help-close").addEventListener("click", () => {
    helpPanel.classList.add("hidden");
  });
  document.getElementById("help-toggle").addEventListener("click", () => {
    helpPanel.classList.toggle("hidden");
  });
  initHdAvailability(helpPanel, view);
}

function initSearch(view) {
  const searchInput = document.getElementById("search-input");
  const searchBtn = document.getElementById("search-btn");
  const searchResultsEl = document.getElementById("search-results");
  let searchDebounceTimer = null;

  function hideSearchResults() {
    searchResultsEl.classList.remove("visible");
    searchResultsEl.innerHTML = "";
  }

  function goToSearchResult(result) {
    hideSearchResults();
    showPoiPanel(result);
    const target = new THREE.Vector3(result.x, result.y, result.elevation ?? 0);
    const camPos = target.clone();
    camPos.z += SEARCH_RANGE * Math.sin(SEARCH_PITCH);
    camPos.y -= SEARCH_RANGE * Math.cos(SEARCH_PITCH);
    view.camera3D.position.copy(camPos);
    view.camera3D.lookAt(target);
    view.camera3D.updateMatrixWorld(true);
    view.notifyChange(view.camera3D);

    const searchParams = new URLSearchParams(location.search);
    searchParams.set("x", (result.x / 1000).toFixed(3));
    searchParams.set("y", (result.y / 1000).toFixed(3));
    history.replaceState(null, "", `?${searchParams}`);
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
}

/**
 * Wires index.html's chrome — map toggle, sun/light panel, help, search — to a
 * view. `refreshTextures` re-drapes whatever carries the WMTS imagery in this
 * view, which differs between the Draco terrain and the 3D Tiles one.
 */
function initSettingsPanel(view, tilesLayer) {
  initTogglePanel("settings-toggle", "settings-panel");

  const fovInput = document.getElementById("fov");
  const fovValue = document.getElementById("fov-value");
  fovInput.value = view.camera3D.fov;
  fovValue.textContent = `${view.camera3D.fov}°`;
  fovInput.addEventListener("input", () => {
    view.camera3D.fov = Number(fovInput.value);
    view.camera3D.updateProjectionMatrix();
    fovValue.textContent = `${fovInput.value}°`;
    view.notifyChange(view.camera3D);
  });

  const dataUsageInput = document.getElementById("data-usage");
  const dataUsageValue = document.getElementById("data-usage-value");
  dataUsageInput.addEventListener("input", () => {
    const preset = DATA_USAGE_PRESETS[Number(dataUsageInput.value)];
    dataUsageValue.textContent = preset.label;
    tilesLayer.sseThreshold = preset.sse;
    view.notifyChange(tilesLayer);
  });
}

// Browsers restore form-control values across a reload, so an input can come
// back holding a value nothing in the app ever applied — the panel's label and
// the view then disagree with the slider. Replaying each control's own handler
// once at startup reconciles them. The layer panel applies its restored radio
// itself, and re-firing it would re-drape every tile for nothing.
function syncRestoredControls() {
  for (const el of document.querySelectorAll(".tool-panel input, .tool-panel select")) {
    if (el.type === "file" || el.type === "radio") continue;
    el.dispatchEvent(new Event("input"));
    el.dispatchEvent(new Event("change"));
  }
}

export function initUi(view, { setSunDate, setEnabled, setShadowsEnabled, refreshTextures, tilesLayer }) {
  initLayerPanel(view, refreshTextures);
  initEnvPanel(view, { setSunDate, setEnabled, setShadowsEnabled });
  initSettingsPanel(view, tilesLayer);
  initTogglePanel("gpx-toggle", "gpx-panel");
  initGpsCamera(view, tilesLayer);
  initHelpPanel(view);
  initSearch(view);
  initCompass(view);
  syncRestoredControls();

  import("./consoleControls.js").then(({ initConsoleControls }) => initConsoleControls(view));
  if (__TEST_CONTROLS__) {
    import("./testControls.js").then(({ initTestControls }) => initTestControls(view));
  }
}
