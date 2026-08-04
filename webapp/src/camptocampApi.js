import { localToMerc, mercToLocal } from "./workFrame.js";

export const KIND_CLASS = { summit: "poi-peak", pass: "poi-pass", hut: "poi-hut", access: "poi-parking" };

const WAYPOINTS_URL = "https://api.camptocamp.org/waypoints";
const SEARCH_URL = "https://api.camptocamp.org/search";
const IMAGES_URL = "https://api.camptocamp.org/images";
const MEDIA_BASE = "https://media.camptocamp.org/c2corg-active";
const IMG_TAG_RE = /\[img=(\d+)[^\]]*\]([^[]*)\[\/img\]/g;
const PAGE_LIMIT = 100;

function cellBboxWebMercator(x0, y0, sizeKm = 1) {
  const corners = [
    [x0, y0], [x0 + sizeKm, y0], [x0, y0 + sizeKm], [x0 + sizeKm, y0 + sizeKm],
  ].map(([x, y]) => localToMerc(x * 1000, y * 1000));
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export async function fetchCellPois(x0, y0, sizeKm = 1) {
  const bbox = cellBboxWebMercator(x0, y0, sizeKm).join(",");
  const wtyp = Object.keys(KIND_CLASS).join(",");
  const docs = [];
  let offset = 0;
  for (; ;) {
    const url = `${WAYPOINTS_URL}?bbox=${bbox}&wtyp=${wtyp}&pl=fr&limit=${PAGE_LIMIT}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Camptocamp API returned ${res.status}`);
    const data = await res.json();
    const page = data.documents ?? [];
    docs.push(...page);
    offset += PAGE_LIMIT;
    if (page.length < PAGE_LIMIT || docs.length >= (data.total ?? 0)) break;
  }
  return docs.filter((doc) => doc.locales?.[0]?.title);
}

export async function searchWaypoints(q, limit = 5) {
  const res = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(q)}&t=w&pl=fr&limit=${limit * 5}`);
  if (!res.ok) throw new Error(`Camptocamp API returned ${res.status}`);
  const data = await res.json();
  return (data.waypoints?.documents ?? [])
    .filter((doc) => doc.waypoint_type in KIND_CLASS && doc.locales?.[0]?.title && doc.geometry?.geom)
    .slice(0, limit)
    .map((doc) => {
      const [x, y] = mercToLocal(JSON.parse(doc.geometry.geom).coordinates);
      return {
        id: doc.document_id,
        title: doc.locales[0].title,
        wtyp: doc.waypoint_type,
        elevation: doc.elevation ?? null,
        area: doc.areas?.find((a) => a.area_type === "range")?.locales?.[0]?.title ?? null,
        x,
        y,
      };
    });
}

export async function fetchDocDetail(kind, documentId) {
  const res = await fetch(`https://api.camptocamp.org/${kind}/${documentId}?l=fr`);
  if (!res.ok) throw new Error(`Camptocamp API returned ${res.status}`);
  return res.json();
}

export async function fetchWaypointDetail(documentId) {
  return fetchDocDetail("waypoints", documentId);
}

export function imageUrl(filename, size = "MI") {
  return `${MEDIA_BASE}/${filename.replace(/\.([a-zA-Z0-9]+)$/, `${size}.$1`)}`;
}

export async function resolveEmbeddedImages(rawText) {
  const ids = [...new Set([...rawText.matchAll(IMG_TAG_RE)].map((m) => m[1]))];
  if (!ids.length) return rawText;

  const urlById = new Map(await Promise.all(ids.map(async (id) => {
    try {
      const res = await fetch(`${IMAGES_URL}/${id}?l=fr`);
      if (!res.ok) throw new Error(`Camptocamp API returned ${res.status}`);
      const doc = await res.json();
      return [id, doc.filename ? imageUrl(doc.filename) : null];
    } catch {
      return [id, null];
    }
  })));

  return rawText.replace(IMG_TAG_RE, (_match, id, caption) => {
    const url = urlById.get(id);
    const alt = caption.trim();
    return url ? `\n\n![${alt}](${url})\n\n` : alt;
  });
}
