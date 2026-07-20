// Small info box, tucked at the end of the help panel: a Leaflet map of the
// built extent, with a 1 km L93 cell lit up wherever LiDAR HD terrain is
// actually built (bom_hd.txt — see bom.js), over a WMS Plan IGN backdrop.
// The bbox is computed from the bom itself (its extent + a margin), not
// hardcoded, so it tracks whatever's actually been built. Clicking the map
// starts a fast travel to that spot in the 3D scene.
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import * as THREE from "three";
import { API_BASE_URL } from "./apiConfig.js";
import { loadBom } from "./bom.js";
import { l93ToWgs84, wgs84ToL93 } from "./proj.js";
import { itownsPlacement } from "./utils.js";

const MARGIN_KM = 20;
const DISPLAY_WIDTH = 300;
const DISPLAY_HEIGHT = 260;
const MAX_ZOOM = 12;

const WMS_URL = "https://data.geopf.fr/wms-r/wms";
const WMS_LAYER = "GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2";

// Same travel shape as main.js's search-result "go to" (approach from the
// south-east at a fixed pitch, no known elevation to aim for so target z=0).
const TRAVEL_RANGE = 3000;
const TRAVEL_PITCH = Math.PI / 4;

function travelTo(view, x, y) {
  const target = new THREE.Vector3(x, y, 0);
  const camPos = target.clone();
  camPos.z += TRAVEL_RANGE * Math.sin(TRAVEL_PITCH);
  camPos.y -= TRAVEL_RANGE * Math.cos(TRAVEL_PITCH);
  itownsPlacement(view, x, y);
}

// bbox: {xmin, xmax, ymin, ymax}, L93 km, half-open on the max side (a cell
// "x.y" covers [x, x+1) x [y, y+1)).
function computeBbox(bom) {
  let xmin = Infinity;
  let xmax = -Infinity;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const cell of bom) {
    const [xStr, yStr] = cell.split(".");
    const x = Number(xStr);
    const y = Number(yStr);
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  return padToAspect({
    xmin: xmin - MARGIN_KM,
    xmax: xmax + 1 + MARGIN_KM,
    ymin: ymin - MARGIN_KM,
    ymax: ymax + 1 + MARGIN_KM,
  });
}

// Stretch the shorter side, centred, so the bbox matches the map div's aspect
// ratio -- otherwise fitBounds shrinks to the constraining dimension and
// leaves the other one letterboxed (a lot of empty WMS backdrop either side).
function padToAspect(bbox) {
  const targetRatio = DISPLAY_WIDTH / DISPLAY_HEIGHT;
  const width = bbox.xmax - bbox.xmin;
  const height = bbox.ymax - bbox.ymin;
  const ratio = width / height;

  if (ratio < targetRatio) {
    const wantedWidth = height * targetRatio;
    const grow = (wantedWidth - width) / 2;
    return { ...bbox, xmin: bbox.xmin - grow, xmax: bbox.xmax + grow };
  }
  const wantedHeight = width / targetRatio;
  const grow = (wantedHeight - height) / 2;
  return { ...bbox, ymin: bbox.ymin - grow, ymax: bbox.ymax + grow };
}

// L93 km corner -> Leaflet [lat, lng].
function latLng(xKm, yKm) {
  const [lng, lat] = l93ToWgs84.forward([xKm * 1000, yKm * 1000]);
  return [lat, lng];
}

async function drawMap(mapEl, container, view) {
  const bom = await loadBom(`${API_BASE_URL}/tiles/bom_hd.txt`);
  if (!bom || bom.size === 0) {
    return;
  }

  const bbox = computeBbox(bom);
  const bounds = L.latLngBounds(
    latLng(bbox.xmin, bbox.ymin),
    latLng(bbox.xmax, bbox.ymax),
  );

  const map = L.map(mapEl, {
    attributionControl: false,
    zoomControl: false,
    scrollWheelZoom: false,
  });
  // padding so edge cells aren't flush against the panel border, maxZoom so
  // a small/sparse bom doesn't zoom in past what the WMS layer usefully renders.
  const fit = () => map.fitBounds(bounds, { padding: [12, 12], maxZoom: MAX_ZOOM });
  fit();

  // The help panel starts (or toggles) display:none -- Leaflet measures a
  // 0x0 container in that state and lays out tiles wrong forever after, so
  // re-measure and re-fit every time the panel actually becomes visible.
  new MutationObserver(() => {
    if (!container.classList.contains("hidden")) {
      map.invalidateSize();
      fit();
    }
  }).observe(container, { attributes: true, attributeFilter: ["class"] });

  L.tileLayer.wms(WMS_URL, {
    layers: WMS_LAYER,
    version: "1.3.0",
    format: "image/jpeg",
    transparent: false,
  }).addTo(map);

  map.on("click", (e) => {
    const [x, y] = wgs84ToL93.forward([e.latlng.lng, e.latlng.lat]);
    travelTo(view, x, y);
    container.classList.add("hidden");
  });

  const renderer = L.canvas();
  for (const cell of bom) {
    const [xStr, yStr] = cell.split(".");
    const x = Number(xStr);
    const y = Number(yStr);
    L.rectangle(L.latLngBounds(latLng(x, y), latLng(x + 1, y + 1)), {
      renderer,
      fillColor: "#654ade",
    }).addTo(map);
  }
}

export function initHdAvailability(container, view) {
  const wrapper = document.createElement("div");
  Object.assign(wrapper.style, { marginTop: "14px" });

  const title = document.createElement("h2");
  title.textContent = "Zone disponible en HD";
  Object.assign(title.style, { marginBottom: "2px" });

  const subtitle = document.createElement("p");
  subtitle.textContent = "Nuage LiDAR HD reconstruit — zones en violet. Cliquer pour s'y rendre.";

  const mapEl = document.createElement("div");
  Object.assign(mapEl.style, {
    width: `${DISPLAY_WIDTH}px`,
    height: `${DISPLAY_HEIGHT}px`,
    borderRadius: "4px",
  });

  wrapper.append(title, subtitle, mapEl);
  container.append(wrapper);

  drawMap(mapEl, container, view);
}
