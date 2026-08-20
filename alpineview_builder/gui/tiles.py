import math
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ogc3d_tiler"))

from geo_constants import GEO

CELL_LEVEL = GEO.cell_level
LOD_LEVEL0 = GEO.lod_level0


def lonlat_to_tile(lon, lat, level):
    n = 1 << level
    x = (lon + 180.0) / 360.0 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def tile_to_lonlat(x, y, level):
    n = 1 << level
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def tiles_in_rect(lon0, lat0, lon1, lat1, level):
    west, east = min(lon0, lon1), max(lon0, lon1)
    south, north = min(lat0, lat1), max(lat0, lat1)
    n = 1 << level
    x0, y0 = lonlat_to_tile(west, north, level)
    x1, y1 = lonlat_to_tile(east, south, level)
    cx0 = max(0, min(n - 1, math.floor(x0)))
    cx1 = max(0, min(n - 1, math.ceil(x1) - 1))
    ry0 = max(0, min(n - 1, math.floor(y0)))
    ry1 = max(0, min(n - 1, math.ceil(y1) - 1))
    return [(x, y) for x in range(cx0, cx1 + 1) for y in range(ry0, ry1 + 1)]


def tiles_in_rect_aligned(lon0, lat0, lon1, lat1, level, align_level):
    """Tiles at `level` covering the rect, expanded so every tile at the
    coarser `align_level` touched by the rect has ALL of its children at
    `level` included. A plain tiles_in_rect(level) can clip a boundary
    align_level tile down to only some of its children, leaving the rest
    unbuilt -- a hole in an otherwise-complete quadrant. align_level must be
    <= level."""
    coarse = tiles_in_rect(lon0, lat0, lon1, lat1, align_level)
    shift = level - align_level
    n = 1 << shift
    return [
        (cx * n + dx, cy * n + dy)
        for cx, cy in coarse
        for dx in range(n)
        for dy in range(n)
    ]


def tile_bounds(x, y, level):
    west, north = tile_to_lonlat(x, y, level)
    east, south = tile_to_lonlat(x + 1, y + 1, level)
    return west, south, east, north


def cell_of(x, y, level):
    """The cell_level tile containing a tile of the given level."""
    shift = level - CELL_LEVEL
    return x >> shift, y >> shift


def tile_output_path(out_dir, x, y, level):
    """Tiles are stored under their cell, with level and coordinates local to
    it, because that is what a 3D Tiles implicit content template expands to."""
    shift = level - CELL_LEVEL
    n = 1 << shift
    cell = cell_of(x, y, level)
    cx, cy = cell
    return os.path.join(out_dir, f"{cx}.{cy}", str(shift), f"{x % n}.{y % n}.glb")


def is_built(out_dir, x, y, level):
    path = tile_output_path(out_dir, x, y, level)
    return os.path.isfile(path) and os.path.getsize(path) > 0


def built_tiles(out_dir, level):
    """Every tile at `level` that already has a .glb on disk, found by
    scanning out_dir directly -- independent of any rect selection, so it
    reflects everything ever built, not just the current one."""
    shift = level - CELL_LEVEL
    n = 1 << shift
    out = []
    if not os.path.isdir(out_dir):
        return out
    for cell_name in os.listdir(out_dir):
        cx, cy = _parse_pair(cell_name)
        if cx is None:
            continue
        level_dir = os.path.join(out_dir, cell_name, str(shift))
        if not os.path.isdir(level_dir):
            continue
        for fname in os.listdir(level_dir):
            if not fname.endswith(".glb"):
                continue
            lx, ly = _parse_pair(fname[: -len(".glb")])
            if lx is None:
                continue
            out.append((cx * n + lx, cy * n + ly))
    return out


def _parse_pair(name):
    parts = name.split(".")
    if len(parts) != 2 or not all(p.isdigit() for p in parts):
        return None, None
    return int(parts[0]), int(parts[1])
