import * as THREE from "three";
import { setActiveTraces } from "./gpxPainter.js";
import { wgs84ToWebMercator } from "./proj.js";
import { mercToLocal } from "./workFrame.js";

const SPEED = 15;
const EYE_HEIGHT = 50;
const LOOK_AHEAD = 15;
const SMOOTH_ROTATION_COEFF = 1.;
const SMOOTH_HEIGHT_COEFF = 0.5;
const CAST_STEP = 3;
const RAY_START_Z = 5000;
const FIXED_PITCH = THREE.MathUtils.degToRad(0);

export function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("GPX illisible");
  const groups = [...doc.querySelectorAll("trkseg")];
  if (!groups.length) groups.push(...doc.querySelectorAll("rte"));
  if (!groups.length) groups.push(doc.documentElement);
  return groups
    .map((g) => [...g.querySelectorAll("trkpt, rtept, wpt")].map((pt) => ({
      lon: parseFloat(pt.getAttribute("lon")),
      lat: parseFloat(pt.getAttribute("lat")),
      ele: parseFloat(pt.querySelector("ele")?.textContent ?? "0") || 0,
    })).filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat)))
    .filter((seg) => seg.length > 1);
}

function toTrack(seg) {
  return seg.map(({ lon, lat, ele }) => {
    const merc = wgs84ToWebMercator.forward([lon, lat]);
    const [x, y] = mercToLocal(merc);
    return { merc, pos: new THREE.Vector3(x, y, ele) };
  });
}

export function cumulativeDist(points) {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    out.push(out[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return out;
}

export function pointAt(points, cumDist, d) {
  d = THREE.MathUtils.clamp(d, 0, cumDist[cumDist.length - 1]);
  let i = 1;
  while (i < cumDist.length - 1 && cumDist[i] < d) i++;
  const t = (d - cumDist[i - 1]) / Math.max(cumDist[i] - cumDist[i - 1], 1e-6);
  return points[i - 1].clone().lerp(points[i], t);
}

export function initGpsCamera(view, tilesLayer) {
  const status = document.getElementById("gpx-status");
  const playBtn = document.getElementById("gpx-play");
  const posInput = document.getElementById("gpx-pos");
  const speedInput = document.getElementById("gpx-speed");
  const fileInput = document.getElementById("gpx-file");
  const followGroundInput = document.getElementById("gpx-follow-ground");

  let path = [];
  let dist = [];
  let travelled = 0;
  let playing = false;
  let lastT = 0;

  const sampleAt = (d) => pointAt(path, dist, d);

  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, 0, -1);
  let groundZ = null;
  let castD = null;

  function groundAt(p, d) {
    if (castD === null || Math.abs(d - castD) >= CAST_STEP) {
      ray.set(new THREE.Vector3(p.x, p.y, RAY_START_Z), down);
      const hit = ray.intersectObject(tilesLayer.object3d, true)[0];
      if (hit) {
        groundZ = hit.point.z;
        castD = d;
      }
    }
    return groundZ;
  }

  const aim = new THREE.Quaternion();
  const aimEuler = new THREE.Euler(Math.PI / 2 + FIXED_PITCH, 0, 0, "ZYX");
  let aimed = false;
  let smoothZ = null;

  function place(d, dt) {
    if (path.length < 2) return;
    posInput.value = Math.round((d / dist[dist.length - 1]) * posInput.max);
    const p = sampleAt(d);
    const ahead = sampleAt(d + LOOK_AHEAD);
    const run = Math.hypot(ahead.x - p.x, ahead.y - p.y);
    if (!dt) castD = null;
    const g = groundAt(p, d) ?? p.z;
    const targetZ = (followGroundInput.checked ? g : Math.max(p.z, g)) + EYE_HEIGHT;
    const kz = smoothZ !== null && dt ? 1 - Math.exp(-dt / SMOOTH_HEIGHT_COEFF) : 1;
    smoothZ = smoothZ === null ? targetZ : smoothZ + (targetZ - smoothZ) * kz;
    p.z = smoothZ;
    view.camera3D.position.copy(p);
    if (run > 1e-3) {
      aimEuler.z = Math.atan2(p.x - ahead.x, ahead.y - p.y);
      aim.setFromEuler(aimEuler);
      const kq = aimed && dt ? 1 - Math.exp(-dt / SMOOTH_ROTATION_COEFF) : 1;
      view.camera3D.quaternion.slerp(aim, kq);
      aimed = true;
    }
    view.camera3D.updateMatrixWorld(true);
    view.notifyChange(view.camera3D);
  }

  function tick(t) {
    if (!playing) return;
    const dt = Math.min((t - lastT) / 1000, 0.1);
    travelled += dt * SPEED * Number(speedInput.value);
    lastT = t;
    place(travelled, dt);
    if (travelled >= dist[dist.length - 1]) { setPlaying(false); return; }
    requestAnimationFrame(tick);
  }

  function setPlaying(on) {
    playing = on;
    playBtn.textContent = on ? "⏸" : "▶";
    view.controls.enabled = !on;
    if (!on) return;
    if (travelled >= dist[dist.length - 1]) travelled = 0;
    lastT = performance.now();
    requestAnimationFrame(tick);
  }

  function load(text) {
    let segs;
    try {
      segs = parseGpx(text).map(toTrack);
    } catch (e) {
      status.textContent = e.message;
      return;
    }
    if (!segs.length) { status.textContent = "Aucune trace dans ce GPX"; return; }
    setActiveTraces(segs.map((s) => s.map((p) => p.merc)));

    path = segs.flatMap((s) => s.map((p) => p.pos));
    dist = cumulativeDist(path);
    travelled = 0;
    aimed = false;
    smoothZ = null;
    groundZ = null;
    castD = null;
    playBtn.disabled = false;
    posInput.disabled = false;
    status.textContent = `${path.length} points · ${(dist[dist.length - 1] / 1000).toFixed(1)} km`;
    place(0);
  }

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (file) load(await file.text());
  });

  posInput.addEventListener("input", () => {
    if (path.length < 2) return;
    travelled = (Number(posInput.value) / posInput.max) * dist[dist.length - 1];
    place(travelled);
  });

  playBtn.addEventListener("click", () => setPlaying(!playing));
  followGroundInput.addEventListener("change", () => { if (!playing) place(travelled); });
}
