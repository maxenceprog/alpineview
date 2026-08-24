import { Las } from "copc";
import { LazPerf } from "laz-perf";
import * as THREE from "three";
import { l93ToWebMercator, webMercatorToL93 } from "./proj.js";
import { localOrigin } from "./terrainPack.js";
import { localToMerc, mercToLocal } from "./workFrame.js";

const EPT_ROOT = "https://data.geopf.fr/chunk/telechargement/download/lidarhd_fxx_ept";
// IGN groups LidarHD acquisitions into named "blocs" (survey campaigns), each
// with its own EPT store at {EPT_ROOT}/{bloc name}_EPT -- this WFS layer maps
// an L93 point to the bloc covering it.
const WFS_BLOC_URL = "https://data.geopf.fr/wfs/ows";
const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_MOVE_PX = 20;
const POINT_SIZE_PX = 4;

// Runs on the main thread instead of itowns' own worker-based LASParser: that
// worker relies on the `threads` package's postMessage handshake, which never
// completes when Vite serves it unbundled. Parsing one
// EPT leaf tile (a few thousand to ~1e5 points) synchronously is cheap enough
// not to need a worker at all.
let lazPerfPromise = null;
function lazPerf() {
  lazPerfPromise ??= LazPerf.create({ locateFile: (file) => `${import.meta.env.BASE_URL}laz-perf/${file}` });
  return lazPerfPromise;
}

async function parseLaz(buffer) {
  const bytes = new Uint8Array(buffer);
  const pointData = await Las.PointData.decompressFile(bytes, lazPerf());
  const header = Las.Header.parse(bytes);
  const view = Las.View.create(pointData, header);

  const getPosition = ["X", "Y", "Z"].map(view.getter);
  const getColor = view.dimensions.Red ? ["Red", "Green", "Blue"].map(view.getter) : null;
  const colorDepth = header.majorVersion === 1 && header.minorVersion <= 2 ? 8 : 16;

  const origin = getPosition.map((f) => f(0)).map(Math.floor);
  const position = new Float32Array(view.pointCount * 3);
  const color = getColor ? new Uint8Array(view.pointCount * 3) : null;
  for (let i = 0; i < view.pointCount; i++) {
    const [x, y, z] = getPosition.map((f) => f(i));
    position[i * 3] = x - origin[0];
    position[i * 3 + 1] = y - origin[1];
    position[i * 3 + 2] = z - origin[2];
    if (getColor) {
      const [r, g, b] = getColor.map((f) => f(i));
      const scale = colorDepth === 16 ? 1 / 256 : 1;
      color[i * 3] = r * scale;
      color[i * 3 + 1] = g * scale;
      color[i * 3 + 2] = b * scale;
    }
  }
  return { position, color, origin };
}

async function eptBaseFor([x, y]) {
  const bbox = `${x - 25},${y - 25},${x + 25},${y + 25},EPSG:2154`;
  const url =
    `${WFS_BLOC_URL}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature` +
    "&TYPENAMES=IGNF_NUAGES-DE-POINTS-LIDAR-HD:bloc&SRSNAME=EPSG:2154" +
    `&BBOX=${bbox}&OUTPUTFORMAT=application/json&COUNT=1`;
  const res = await fetch(url);
  const data = await res.json();
  const name = data.features?.[0]?.properties?.name;
  if (!name) throw new Error("no LidarHD coverage here");
  return `${EPT_ROOT}/${name}_EPT`;
}

const eptMetaByBase = new Map();
function eptMeta(base) {
  if (!eptMetaByBase.has(base)) {
    eptMetaByBase.set(base, fetch(`${base}/ept.json`).then((res) => res.json()));
  }
  return eptMetaByBase.get(base);
}

function eptHierarchyChunk(base, key) {
  return fetch(`${base}/ept-hierarchy/${key}.json`).then((res) => res.json());
}

// Walks the EPT octree along the single branch containing `point`, following
// the hierarchy's chunk boundaries (a `-1` entry means "fetch the next
// hierarchy file"), and stops at the deepest node actually present there.
async function deepestNodeAt(base, bounds, point) {
  let [minx, miny, minz, maxx, maxy, maxz] = bounds;
  let node = { depth: 0, x: 0, y: 0, z: 0 };
  let hierarchy = await eptHierarchyChunk(base, "0-0-0-0");
  for (;;) {
    const midx = (minx + maxx) / 2;
    const midy = (miny + maxy) / 2;
    const midz = (minz + maxz) / 2;
    const cx = point[0] >= midx ? 1 : 0;
    const cy = point[1] >= midy ? 1 : 0;
    const cz = point[2] >= midz ? 1 : 0;
    const child = { depth: node.depth + 1, x: node.x * 2 + cx, y: node.y * 2 + cy, z: node.z * 2 + cz };
    const key = `${child.depth}-${child.x}-${child.y}-${child.z}`;
    const count = hierarchy[key];
    if (count === undefined) return node;
    if (count === -1) hierarchy = await eptHierarchyChunk(base, key);
    minx = cx ? midx : minx;
    maxx = cx ? maxx : midx;
    miny = cy ? midy : miny;
    maxy = cy ? maxy : midy;
    minz = cz ? midz : minz;
    maxz = cz ? maxz : midz;
    node = child;
  }
}

function sceneToL93(scenePos) {
  const merc = localToMerc(scenePos.x, scenePos.y);
  const [x, y] = webMercatorToL93.forward(merc);
  return [x, y, scenePos.z + localOrigin.z];
}

function l93ToScene(x, y, z) {
  const merc = l93ToWebMercator.forward([x, y]);
  const [lx, ly] = mercToLocal(merc);
  return [lx, ly, z - localOrigin.z];
}

export function initPointCloudPicker(view) {
  const dom = view.domElement;
  let points = null;
  let lastClick = null;
  let busy = false;

  const clear = () => {
    if (!points) return;
    view.scene.remove(points);
    points.geometry.dispose();
    points.material.dispose();
    points = null;
  };

  const show = async (scenePos) => {
    if (busy) return;
    busy = true;
    try {
      const point = sceneToL93(scenePos);
      const base = await eptBaseFor(point);
      const meta = await eptMeta(base);
      const node = await deepestNodeAt(base, meta.bounds, point);
      const res = await fetch(`${base}/ept-data/${node.depth}-${node.x}-${node.y}-${node.z}.laz`);
      if (!res.ok) return;
      const { position, color, origin } = await parseLaz(await res.arrayBuffer());

      for (let i = 0; i < position.length; i += 3) {
        const [lx, ly, lz] = l93ToScene(position[i] + origin[0], position[i + 1] + origin[1], position[i + 2] + origin[2]);
        position[i] = lx;
        position[i + 1] = ly;
        position[i + 2] = lz;
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
      if (color) geometry.setAttribute("color", new THREE.BufferAttribute(color, 3, true));
      geometry.computeBoundingSphere();

      const material = new THREE.PointsMaterial({
        size: POINT_SIZE_PX,
        sizeAttenuation: false,
        vertexColors: !!color,
        color: color ? 0xffffff : 0xffcc00,
      });

      clear();
      points = new THREE.Points(geometry, material);
      view.scene.add(points);
      view.notifyChange(view.camera3D);
    } catch (e) {
      console.warn("point-cloud", e);
    } finally {
      busy = false;
    }
  };

  dom.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const now = e.timeStamp;
    const isDouble =
      lastClick &&
      now - lastClick.t < DOUBLE_CLICK_MS &&
      Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < DOUBLE_CLICK_MOVE_PX;
    lastClick = isDouble ? null : { x: e.clientX, y: e.clientY, t: now };
    if (!isDouble) return;

    const picked = view.getPickingPositionFromDepth(view.eventToViewCoords(e));
    if (picked) show(picked);
  });
}
