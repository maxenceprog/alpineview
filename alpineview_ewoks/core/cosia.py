"""COSIA land-cover build step: rasterise per-tile class textures.

COSIA (IGN "Couverture du Sol par IA") is a vector land-cover map in 10 km GPKG
blocks named NW-corner `D005_2025_{Xmin}_{Ymax}_vecto.gpkg`. This loads the
polygons once per 1 km cell and rasterises a `tile.{x}.{y}.{z}.cosia.png` (class
id per pixel) next to each already-built `.drc`.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

import fiona
import numpy as np
from PIL import Image
from rasterio.features import rasterize
from rasterio.transform import from_origin
from shapely import clip_by_rect
from shapely.geometry import shape

from .tiles import LOD_LEVEL

_REPO = Path(__file__).resolve().parents[2]
# Root holding the COSIA department drops (data/COSIA_..._D0XX_YYYY-.../). Block
# GPKGs are found by glob so any department / date works — no hard-coded folder.
DEFAULT_COSIA_DIR = str(_REPO / "data")
DEFAULT_TILES_OUT = str(_REPO / "webapp" / "public" / "tiles")
TEX_SIZE = 1024

# numero -> label, for reference / the webapp palette.
COSIA_CLASSES = {
    1: "Bâtiment",
    2: "Zone perméable",
    3: "Zone imperméable",
    4: "Piscine",
    5: "Sol nu",
    6: "Surface eau",
    7: "Neige",
    8: "Conifère",
    9: "Feuillu",
    10: "Broussaille",
    11: "Vigne",
    12: "Pelouse",
    13: "Culture",
    14: "Terre labourée",
    15: "Serre",
}

log = logging.getLogger("reconstruction.cosia")

# fiona/GDAL and rasterio log a WARNING/DEBUG per COSIA GPKG open + rasterize
# call ("non-Z geometry ... Z=2 hint", env/driver chatter) that's expected and
# swamps --debug output at cell-per-second batch scale.
logging.getLogger("fiona").setLevel(logging.ERROR)
logging.getLogger("rasterio").setLevel(logging.ERROR)


# ---------------------------------------------------------------------------
# GPKG helpers
# ---------------------------------------------------------------------------


_BLOCK_FILENAME_RE = re.compile(r"D(\d+)_(\d{4})_\d+_\d+_vecto\.gpkg$")


def _find_block_gpkgs(cosia_dir: Path, bx: int, by: int) -> list[Path]:
    """Locate the COSIA GPKG(s) for block (bx, by) under `cosia_dir`, one per dept.

    Files are named `D{dept}_{year}_{bx}_{by}_vecto.gpkg`. A 10 km block can
    straddle a department border: each department's COSIA export only holds
    polygons within its own boundary, so a border block has one file per
    department and *all* of them must be loaded — not just the first match —
    or the other department's landcover is silently dropped. When a dept has
    several dates (re-exports), keep only its most recent one.
    """
    matches = Path(cosia_dir).glob(f"**/D*_{bx}_{by}_vecto.gpkg")
    latest_by_dept: dict[str, tuple[str, Path]] = {}
    for path in matches:
        m = _BLOCK_FILENAME_RE.search(path.name)
        if not m:
            continue
        dept, year = m.group(1), m.group(2)
        prev = latest_by_dept.get(dept)
        if prev is None or year > prev[0]:
            latest_by_dept[dept] = (year, path)
    return [path for _year, path in latest_by_dept.values()]


def cosia_blocks(bbox: tuple[float, float, float, float]) -> set[tuple[int, int]]:
    """COSIA 10 km block names (km) covering an L93 metre bbox.

    NW-corner naming: X is the west edge, Y is the north (top) edge, so the block
    holding `ym` spans [Ymax-10km, Ymax] and its Y name is floor(ym/10km)+1.
    """
    minx, miny, maxx, maxy = bbox
    blocks = set()
    for xm in (minx, maxx):
        for ym in (miny, maxy):
            blocks.add((int(xm // 10000) * 10, (int(ym // 10000) + 1) * 10))
    return blocks


def load_shapes(
    bbox: tuple[float, float, float, float], cosia_dir: Path
) -> list[tuple[object, int]]:
    """(geom, numero) for every COSIA polygon intersecting `bbox`, clipped to it.

    Load once per 1 km cell and reuse for all LOD tiles: the costly fiona
    filter + shape() runs once instead of per tile. Clipping bounds the polygons
    (some span a whole 10 km block), which makes rasterising ~1000× faster.
    """
    minx, miny, maxx, maxy = bbox
    shapes = []
    for bx, by in cosia_blocks(bbox):
        for gpkg in _find_block_gpkgs(cosia_dir, bx, by):
            with fiona.open(gpkg) as src:
                for feat in src.filter(bbox=bbox):
                    geom = clip_by_rect(shape(feat["geometry"]), minx, miny, maxx, maxy)
                    if not geom.is_empty:
                        shapes.append((geom, feat["properties"]["numero"]))
    return shapes


def rasterize_shapes(
    shapes: list[tuple[object, int]],
    bbox: tuple[float, float, float, float],
    size: int,
) -> np.ndarray:
    """Rasterise preloaded (geom, numero) shapes over `bbox` to a size×size grid.

    North-up (row 0 = north edge); nodata stays 0. `bbox` may be a sub-region of
    the shapes' extent — geometries are re-clipped (cheap) so a tile only pays
    for its own footprint.
    """
    minx, miny, maxx, maxy = bbox
    clipped = [(clip_by_rect(g, minx, miny, maxx, maxy), n) for g, n in shapes]
    clipped = [(g, n) for g, n in clipped if not g.is_empty]
    if not clipped:
        return np.zeros((size, size), np.uint8)
    transform = from_origin(minx, maxy, (maxx - minx) / size, (maxy - miny) / size)
    return rasterize(
        clipped, out_shape=(size, size), transform=transform, fill=0, dtype="uint8"
    )


def rasterize_index(
    shapes: list[tuple[object, int]],
    bbox: tuple[float, float, float, float],
    size: int,
) -> np.ndarray:
    """Rasterise shapes to 1-based polygon indices (0 = nodata), uint16.

    Lets each polygon be mapped to its own colour (vs `rasterize_shapes`, which
    burns the shared class numero). Used by the satellite-colour tool.
    """
    minx, miny, maxx, maxy = bbox
    clipped = [
        (clip_by_rect(g, minx, miny, maxx, maxy), i + 1)
        for i, (g, _) in enumerate(shapes)
    ]
    clipped = [(g, v) for g, v in clipped if not g.is_empty]
    if not clipped:
        return np.zeros((size, size), np.uint16)
    transform = from_origin(minx, maxy, (maxx - minx) / size, (maxy - miny) / size)
    return rasterize(
        clipped, out_shape=(size, size), transform=transform, fill=0, dtype="uint16"
    )


# ---------------------------------------------------------------------------
# Tile textures
# ---------------------------------------------------------------------------


def tile_bbox_m(x: int, y: int, z: int) -> tuple[float, float, float, float]:
    """L93 metre footprint (minx, miny, maxx, maxy) of tile (x, y, z)."""
    s = 1000.0 / (1 << z)
    return (x * s, y * s, (x + 1) * s, (y + 1) * s)


def save_texture(grid: np.ndarray, path: Path) -> bool:
    """Write a class grid as a single-channel PNG; False (no file) if all nodata."""
    if not grid.any():
        return False
    Image.fromarray(grid, "L").save(path, optimize=True)
    return True


def build_cosia_textures(
    x_km: int,
    y_km: int,
    tiles_dir: str,
    cosia_dir: str,
    size: int = TEX_SIZE,
    zoom_max: int = LOD_LEVEL,
) -> int:
    """Write a `.cosia.png` next to each `.drc` of cell (x_km, y_km-1), for z in [0, zoom_max]."""
    cosia_path = Path(cosia_dir)
    if not cosia_path.exists():
        log.warning("COSIA dir missing: %s", cosia_dir)
        return 0
    x0, y0 = x_km, y_km - 1
    cell_bbox = (x0 * 1000.0, y0 * 1000.0, (x0 + 1) * 1000.0, (y0 + 1) * 1000.0)
    shapes = load_shapes(cell_bbox, cosia_path)
    if not shapes:
        return 0
    out = Path(tiles_dir)
    written = 0
    for z in range(zoom_max + 1):
        n = 1 << z
        for x in range(x0 * n, x0 * n + n):
            for y in range(y0 * n, y0 * n + n):
                name = f"tile.{x}.{y}.{z}"
                if not (out / f"{name}.drc").exists():
                    continue
                grid = rasterize_shapes(shapes, tile_bbox_m(x, y, z), size)
                if save_texture(grid, out / f"{name}.cosia.png"):
                    written += 1
    return written
