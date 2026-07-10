/**
 * 2D "slippy map" (Leaflet + OpenTopoMap) shown in place of the 3D view,
 * toggled manually via the "3D view / Open Topo Map" button in main.js.
 * This module only wraps Leaflet and the altitude<->zoom heuristic used to
 * keep the map's pan position and the 3D camera position closely connected
 * across the switch.
 */

import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Not physically exact — just a monotonic, invertible mapping between camera
// altitude and Leaflet zoom, so the two views land on roughly the same place.
const ALT_AT_ZOOM0_KM = 20000; // zoom 11 → ~9.8 km

export function altitudeFromZoom(zoom) {
  return ALT_AT_ZOOM0_KM / 2 ** zoom;
}

export function zoomFromAltitude(altKm) {
  return Math.min(17, Math.max(2, Math.round(Math.log2(ALT_AT_ZOOM0_KM / altKm))));
}

export function createSlippyMap(containerEl) {
  const map = L.map(containerEl, { attributionControl: true, zoomControl: true });
  L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    attribution:
      'Map data: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | ' +
      'Map style: © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    maxZoom: 17,
  }).addTo(map);
  map.setView([45, 6], 9); // placeholder until setViewFromCamera

  return {
    map,

    setViewFromCamera(lat, lon, altitudeKm) {
      map.setView([lat, lon], zoomFromAltitude(altitudeKm));
    },

    /** cb(lat, lon, altitudeKm) fires on every pan/zoom while the map is interactive. */
    onChange(cb) {
      const fire = () => {
        const c = map.getCenter();
        cb(c.lat, c.lng, altitudeFromZoom(map.getZoom()));
      };
      map.on("move zoom", fire);
    },

    show() {
      containerEl.style.display = "";
      map.invalidateSize(); // required by Leaflet after unhiding its container
    },

    hide() {
      containerEl.style.display = "none";
    },
  };
}
