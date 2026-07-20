#!/usr/bin/env python3
"""
List all LiDAR HD 1km×1km tile filenames that intersect a named mountain massif,
using the Camptocamp API for massif boundaries and the IGN WFS tableau
d'assemblage (via alpineview_ewoks.core.lidar_hd) for tile coverage + URLs.

Workflow:
  1. Search the massif by name via the C2C API (filtered to area_type=range).
  2. Fetch its polygon (EPSG:3857) and reproject it to Lambert 93 (EPSG:2154).
  3. Query the IGN WFS for every dalle in the polygon's bounding box.
  4. Keep only dalles whose 1km cell actually intersects the polygon.

Output: JSON file named <massif>.json (same structure as metadonnees.json, without the
metadata field), written next to the script or at --output.

Usage:
    python scripts/search_massif.py --massif Chartreuse
    python scripts/search_massif.py --massif Belledonne --output tiles.json
    python scripts/search_massif.py --massif Vercors --id 14410
"""

import argparse
import json
import re
import sys
from pathlib import Path

import requests
from pyproj import Transformer
from shapely.geometry import box, shape
from shapely.ops import transform

sys.path.insert(0, str(Path(__file__).parent.parent))

from alpineview_ewoks.core.lidar_hd import TileInfo, _wfs_dalles  # noqa: E402

C2C_BASE = "https://api.camptocamp.org"

_TILE_NAME_RE = re.compile(r"_(\d{4})_(\d{4})_")


# ---------------------------------------------------------------------------
# C2C
# ---------------------------------------------------------------------------


def search_massif(name: str) -> tuple[int, str]:
    """Return (document_id, title) for the first C2C range area matching *name*."""
    r = requests.get(
        f"{C2C_BASE}/areas", params={"q": name, "type": "range"}, timeout=15
    )
    r.raise_for_status()
    docs = r.json().get("documents", [])
    if not docs:
        raise SystemExit(f"No area found for '{name}'")
    doc = docs[0]
    title = doc.get("locales", [{}])[0].get("title", str(doc["document_id"]))
    return doc["document_id"], title


def fetch_massif_polygon_l93(doc_id: int) -> object:
    """Fetch the C2C area polygon and return it as a Shapely geometry in L93."""
    r = requests.get(f"{C2C_BASE}/areas/{doc_id}", params={"cook": "fr"}, timeout=15)
    r.raise_for_status()
    data = r.json()
    geom_str = data.get("geometry", {}).get("geom_detail")
    if not geom_str:
        raise SystemExit(f"Area {doc_id} has no geom_detail polygon")

    geom_3857 = shape(json.loads(geom_str))
    tr = Transformer.from_crs("EPSG:3857", "EPSG:2154", always_xy=True)
    return transform(tr.transform, geom_3857)


# ---------------------------------------------------------------------------
# Tile enumeration
# ---------------------------------------------------------------------------


def tiles_intersecting(polygon) -> list[TileInfo]:
    """Return the IGN LiDAR HD tiles (name + url) intersecting *polygon*.

    Queries the WFS tableau d'assemblage over the polygon's bbox, then keeps
    only the dalles whose 1x1 km cell actually intersects the polygon (the
    WFS bbox query is a rectangular superset).
    """
    minx, miny, maxx, maxy = polygon.bounds
    candidates = _wfs_dalles(minx, miny, maxx, maxy, count=5000)

    tiles = []
    for tile in candidates:
        m = _TILE_NAME_RE.search(tile.name)
        if not m:
            continue
        tx, ty = int(m.group(1)), int(m.group(2))
        tile_box = box(tx * 1000, (ty - 1) * 1000, (tx + 1) * 1000, ty * 1000)
        if polygon.intersects(tile_box):
            tiles.append(tile)

    return sorted(tiles, key=lambda t: t.name)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--massif", required=True, help="Massif name (e.g. Chartreuse)")
    parser.add_argument(
        "--id",
        type=int,
        dest="doc_id",
        default=None,
        help="C2C document ID (skip search if already known)",
    )
    parser.add_argument(
        "--output", type=Path, default=None, help="Write to file instead of stdout"
    )
    args = parser.parse_args()

    if args.doc_id:
        doc_id, title = args.doc_id, args.massif
    else:
        print(f"Searching C2C for '{args.massif}'...", file=sys.stderr)
        doc_id, title = search_massif(args.massif)
        print(f"  → {title} (id={doc_id})", file=sys.stderr)

    print(f"Fetching polygon for '{title}'...", file=sys.stderr)
    polygon = fetch_massif_polygon_l93(doc_id)
    print(f"  → bounds L93: {tuple(round(v) for v in polygon.bounds)}", file=sys.stderr)

    tiles = tiles_intersecting(polygon)
    print(f"  → {len(tiles)} tiles available in IGN LiDAR HD", file=sys.stderr)

    result = {t.name.removesuffix(".copc.laz"): {"url": t.url} for t in tiles}
    output = json.dumps(result, indent=2, ensure_ascii=False) + "\n"

    out_path = args.output or Path(f"{title.lower().replace(' ', '_')}.json")
    out_path.write_text(output)
    print(f"Written to {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
