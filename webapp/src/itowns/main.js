import * as itowns from "itowns";
import { setBrightness, setMapSource } from "../layers.js";
import { DracoTileLayer } from "./dracoLayer.js";
import { initEnvironment, TileLightingLayer } from "./environment.js";

itowns.CRS.defs(
  "EPSG:2154",
  "+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs",
);

const extent = new itowns.Extent("EPSG:2154", 256000, 1280000, 5952000, 6976000);

const viewerDiv = document.getElementById("viewerDiv");
const params = new URLSearchParams(location.search);
const x = 1000 * (parseFloat(params.get("x")) || 965.5);
const y = 1000 * (parseFloat(params.get("y")) || 6430.5);

const view = new itowns.PlanarView(viewerDiv, extent, {
  maxSubdivisionLevel: 12,
  placement: {
    coord: new itowns.Coordinates("EPSG:2154", x, y),
    range: 8000,
    tilt: 25,
    heading: 0,
  },
});

const orthoSource = new itowns.WMSSource({
  url: "https://data.geopf.fr/wms-r/wms",
  name: "ORTHOIMAGERY.ORTHOPHOTOS",
  crs: "EPSG:2154",
  extent,
  version: "1.3.0",
  format: "image/jpeg",
});
const orthoLayer = new itowns.ColorLayer("ortho", { source: orthoSource });
view.addLayer(orthoLayer);

const planSource = new itowns.WMSSource({
  url: "https://data.geopf.fr/wms-r/wms",
  name: "GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2",
  crs: "EPSG:2154",
  extent,
  version: "1.3.0",
  format: "image/jpeg",
});
const planLayer = new itowns.ColorLayer("plan", { source: planSource, visible: false });
view.addLayer(planLayer);

const demSource = new itowns.WMSSource({
  url: "https://data.geopf.fr/wms-r/wms",
  name: "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES",
  crs: "EPSG:2154",
  extent,
  version: "1.3.0",
  width: 256,
  format: "image/x-bil;bits=32",
});
view.addLayer(
  new itowns.ElevationLayer("dem", {
    source: demSource,
    noDataValue: -99999,
    clampValues: { min: 0 },
  }),
);

const dracoLayer = new DracoTileLayer("draco", view);
view.addLayer(dracoLayer);
view.addLayer(new TileLightingLayer("tile-lighting"));

let planVisible = false;
document.getElementById("layer-toggle").addEventListener("click", () => {
  planVisible = !planVisible;
  orthoLayer.visible = !planVisible;
  planLayer.visible = planVisible;
  setMapSource(planVisible ? "plan" : "ortho");
  dracoLayer.refreshTextures();
  view.notifyChange(view.tileLayer);
});

const { setSunDate, setEnabled } = initEnvironment(view);
setBrightness(1.2);

const envEnabledInput = document.getElementById("env-enabled");
envEnabledInput.addEventListener("change", () => {
  setEnabled(envEnabledInput.checked);
});

const envPanel = document.getElementById("env-panel");
document.getElementById("env-toggle").addEventListener("click", () => {
  envPanel.classList.toggle("hidden");
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
