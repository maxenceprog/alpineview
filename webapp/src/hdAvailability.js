// Small info box, tucked at the end of the help panel: a Leaflet map of the
// built extent, with each built lod_level0 WMQ tile lit up wherever LiDAR HD
// terrain is actually built (pack.x15/y15 — see terrainPack.js), over a WMS
// Plan IGN backdrop.
// The bbox is computed from the tiles themselves (their extent + a margin),
// not hardcoded, so it tracks whatever's actually been built. Clicking the
// map starts a fast travel to that spot in the 3D scene.
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import * as THREE from "three";
import { webMercatorToWgs84, wgs84ToWebMercator } from "./proj.js";
import { hdLevelTiles } from "./terrainPack.js";
import { itownsPlacement } from "./utils.js";
import { mercBounds } from "./wmts.js";
import { localToMerc, mercToLocal } from "./workFrame.js";

const MARGIN_M = 20_000;
const DISPLAY_WIDTH = 300;
const DISPLAY_HEIGHT = 260;
const MAX_ZOOM = 12;
const CAMERA_MARKER_INTERVAL_MS = 200;

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

// bbox: {xmin, xmax, ymin, ymax}, Web Mercator metres, half-open on the max
// side.
function computeBbox(level, xs, ys) {
  let xmin = Infinity;
  let xmax = -Infinity;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const { x0, y0, s } = mercBounds(level, xs[i], ys[i]);
    if (x0 < xmin) xmin = x0;
    if (x0 + s > xmax) xmax = x0 + s;
    if (y0 < ymin) ymin = y0;
    if (y0 + s > ymax) ymax = y0 + s;
  }
  return padToAspect({
    xmin: xmin - MARGIN_M,
    xmax: xmax + MARGIN_M,
    ymin: ymin - MARGIN_M,
    ymax: ymax + MARGIN_M,
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

// Web Mercator metres -> Leaflet [lat, lng].
function latLng(x, y) {
  const [lng, lat] = webMercatorToWgs84.forward([x, y]);
  return [lat, lng];
}

function shadeForLevel(level, minLevel, maxLevel) {
  if (maxLevel === minLevel) {
    return "#654ade";
  }
  const t = (level - minLevel) / (maxLevel - minLevel);
  const lightness = 60 - t * 30;
  return `hsl(255, 60%, ${lightness}%)`;
}

function drawMap(mapEl, container, view) {
  const { level, x: xs, y: ys, maxLevel: levels } = hdLevelTiles();
  if (!xs.length) {
    return;
  }
  let minLv = 18;
  let maxLv = 19;


  const bbox = computeBbox(level, xs, ys);
  const bounds = L.latLngBounds(
    latLng(bbox.xmin, bbox.ymin),
    latLng(bbox.xmax, bbox.ymax),
  );

  const map = L.map(mapEl, {
    attributionControl: false,
    zoomControl: false,
    scrollWheelZoom: true,
  });
  // padding so edge cells aren't flush against the panel border, maxZoom so
  // a small/sparse coverage doesn't zoom in past what the WMS layer usefully renders.
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
    const merc = wgs84ToWebMercator.forward([e.latlng.lng, e.latlng.lat]);
    const [x, y] = mercToLocal(merc);
    travelTo(view, x, y);
    container.classList.add("hidden");
  });

  const cameraMarker = L.circleMarker(bounds.getCenter(), {
    radius: 5,
    color: "#fff",
    weight: 2,
    fillColor: "#e63946",
    fillOpacity: 1,
  }).addTo(map);
  const updateCameraMarker = () => {
    const { x, y } = view.camera.camera3D.position;
    const merc = localToMerc(x, y);
    cameraMarker.setLatLng(latLng(merc[0], merc[1]));
  };
  updateCameraMarker();
  setInterval(updateCameraMarker, CAMERA_MARKER_INTERVAL_MS);

  const MIN_TILE_RADIUS_PX = 2;
  const renderer = L.canvas();
  const tileMarkers = [];
  for (let i = 0; i < xs.length; i++) {
    const { x0, y0, s } = mercBounds(level, xs[i], ys[i]);
    const fillColor = shadeForLevel(levels[i], minLv, maxLv);
    const marker = L.rectangle(
      L.latLngBounds(latLng(x0, y0), latLng(x0 + s, y0 + s)),
      {
        renderer,
        color: fillColor,
        weight: 0,
        fillColor,
        fillOpacity: 0.6,
      },
    ).addTo(map);
    tileMarkers.push({ marker, x0, y0, s });
  }

  const updateTileBounds = () => {
    for (const { marker, x0, y0, s } of tileMarkers) {
      const p0 = map.latLngToLayerPoint(latLng(x0, y0));
      const p1 = map.latLngToLayerPoint(latLng(x0 + s, y0));
      const metersPerPx = s / (Math.abs(p1.x - p0.x) || 1e-6);
      const half = Math.max(s / 2, MIN_TILE_RADIUS_PX * metersPerPx);
      const cx = x0 + s / 2;
      const cy = y0 + s / 2;
      marker.setBounds(
        L.latLngBounds(latLng(cx - half, cy - half), latLng(cx + half, cy + half)),
      );
    }
  };
  updateTileBounds();
  map.on("zoomend", updateTileBounds);
}

export function initHdAvailability(container, view) {
  const wrapper = document.createElement("div");
  Object.assign(wrapper.style, { marginTop: "14px" });

  const title = document.createElement("h2");
  title.textContent = "Zone disponible en HD";
  Object.assign(title.style, { marginBottom: "2px" });

  const subtitle = document.createElement("p");
  subtitle.textContent = "Nuage LiDAR HD reconstruit — zones en violet. Cliquer pour s'y rendre. Zones plus foncées = plus haute résolution.";

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
