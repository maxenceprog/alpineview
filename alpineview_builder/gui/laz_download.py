"""Download the LiDAR HD LAZ inputs a WebMercatorQuad build job needs."""

from __future__ import annotations

import logging
import math
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import laspy
from laspy import CopcReader

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ogc3d_tiler"))

from geo_constants import GEO
from geo_convert import convert
from lidar_hd import TileInfo, download_tile, find_tile_lamb, tile_size

DEFAULT_CACHE_DIR = str(Path.home() / ".cache" / "poissonrecon-ign")
DEFAULT_RESOLUTION = 1

# Mirrors TILE_MARGIN_M in alpineview_builder.cpp's las_bbox(): the buffer a
# build job reads beyond its own WMQ tile, so required_l93_tiles below must
# use the same value or a rebuilt tile could read a thinner neighbour ring
# than the C++ side actually needs.
TILE_MARGIN_M = 50.0

# Above this, a full download costs more than it saves: measured on a 570 MB
# tile, full-file fetch took 12.8s vs 7.0s for a remote COPC range query at
# resolution=1 (same point count); on typical 130-220 MB tiles the full
# download wins or ties. 300 MB sits between the two. Heavy tiles are also
# denser, so resolution is capped no finer than 2 to keep the range query
# itself cheap (avoids the many-small-request 429 risk of finer levels).
HEAVY_TILE_BYTES = 300_000_000
HEAVY_TILE_MIN_RESOLUTION = 2

log = logging.getLogger("laz_download")


def _query_and_cache(
    tile: TileInfo,
    cache_dir: str,
    resolution: int,
    download_from_ign: bool = False,
) -> Path:
    """Query *tile* at *resolution* → trimmed .laz.

    Small/typical tiles are downloaded whole (one request, best bandwidth) and
    queried locally. Tiles above HEAVY_TILE_BYTES are queried remotely instead
    (range requests, resolution floored to HEAVY_TILE_MIN_RESOLUTION): they
    are also denser, so a full download would move far more data than the
    requested resolution actually needs.

    Fields alpineview_builder does not consume (intensity, user_data) are
    zeroed so the cached .laz compresses well. A .copc.laz downloaded by this
    call is deleted once the trimmed .laz is written.
    """
    dest = Path(cache_dir) / (tile.name.removesuffix(".copc.laz") + ".laz")
    if dest.exists():
        try:
            with laspy.open(dest, decompression_selection=0):
                pass
            return dest
        except laspy.errors.LaspyException:
            log.info("las read exception", exc_info=True)
    local_copc = Path(cache_dir) / tile.name
    if local_copc.exists():
        log.info("COPC query %s at %d m resolution …", tile.name, resolution)
        return _query_copc(local_copc, dest, resolution)

    if not download_from_ign:
        raise RuntimeError(f"{local_copc} is not in cache")

    size = tile_size(tile)
    if size is not None and size >= HEAVY_TILE_BYTES:
        resolution = max(resolution, HEAVY_TILE_MIN_RESOLUTION)
        log.info(
            "Heavy tile %s (%.0f MB) — remote COPC query at %d m resolution …",
            tile.name,
            size / 1e6,
            resolution,
        )
        return _query_copc(tile.url, dest, resolution)

    download_tile(tile, cache_dir)
    log.info("COPC query %s at %d m resolution …", tile.name, resolution)
    try:
        return _query_copc(local_copc, dest, resolution)
    finally:
        local_copc.unlink(missing_ok=True)


def _query_copc(source: Path | str, dest: Path, resolution: int) -> Path:
    """Query a COPC *source* (local path or remote URL) at *resolution* → dest .laz."""
    with CopcReader.open(source) as reader:
        points = reader.query(resolution=resolution)
        src_header = reader.header

    for unused in ("intensity", "user_data"):
        points.array[unused] = 0

    # laspy cannot write COPC files, so build a plain LAS header from the COPC one.
    header = laspy.LasHeader(
        point_format=src_header.point_format, version=src_header.version
    )
    header.scales = src_header.scales
    header.offsets = src_header.offsets

    tmp_dest = dest.with_name(f"{dest.stem}.{os.getpid()}.tmp.laz")
    with laspy.open(tmp_dest, mode="w", header=header) as f:
        f.write_points(points)
    os.replace(tmp_dest, dest)

    log.info("  Written %d points → %s", len(points), dest)
    return dest


def wmq_tile_bounds(level: int, tx: int, ty: int) -> tuple[float, float, float, float]:
    """Mirrors geo_wmq_tile_bounds() in geo.cpp: a WMQ tile's box in "work"
    (rescaled Web Mercator) metres. Plain index arithmetic, not real
    geodesy, so kept as a local formula rather than round-tripped through
    geo_convert."""
    extent = GEO.wmq_extent / GEO.work_scale
    size = 2.0 * extent / (1 << level)
    x0 = -extent + tx * size
    x1 = x0 + size
    y1 = extent - ty * size
    y0 = y1 - size
    return x0, y0, x1, y1


def required_l93_tiles(pm_x: int, pm_y: int) -> list[tuple[int, int]]:
    """The L93 km cells whose LAZ a WebMercatorQuad job needs, buffer included.

    A level-15 tile is 857 m and does not align to the km grid, so the set is
    4 or 6 cells depending on where the tile falls. Mirrors las_bbox() /
    read_and_filter_las_data() in alpineview_builder.cpp: buffer the tile by
    TILE_MARGIN_M in work-Mercator space, sample its edges, reproject to L93,
    and take the enclosing km cell range.
    """
    wx0, wy0, wx1, wy1 = wmq_tile_bounds(GEO.lod_level0, pm_x, pm_y)
    wx0 -= TILE_MARGIN_M
    wy0 -= TILE_MARGIN_M
    wx1 += TILE_MARGIN_M
    wy1 += TILE_MARGIN_M

    samples = 5
    edge_l93 = []
    for i in range(samples):
        t = i / (samples - 1)
        x = wx0 + t * (wx1 - wx0)
        y = wy0 + t * (wy1 - wy0)
        for wx, wy in ((x, wy0), (x, wy1), (wx0, y), (wx1, y)):
            x93, y93, _z = convert(wx, wy, 0.0, "work", "l93")
            edge_l93.append((x93, y93))

    min_x = min(p[0] for p in edge_l93)
    max_x = max(p[0] for p in edge_l93)
    min_y = min(p[1] for p in edge_l93)
    max_y = max(p[1] for p in edge_l93)

    kx0, kx1 = math.floor(min_x / 1000.0), math.floor(max_x / 1000.0)
    ky0, ky1 = math.ceil(min_y / 1000.0), math.ceil(max_y / 1000.0)
    return [(x, y) for x in range(kx0, kx1 + 1) for y in range(ky0, ky1 + 1)]


def download_cell_laz(
    x_km: int,
    y_km: int,
    cache_dir: str,
    *,
    resolution: int = DEFAULT_RESOLUTION,
    download_from_ign: bool = False,
) -> str:
    """COPC-query the LiDAR HD LAZ for cell (x_km, y_km) at *resolution* → compressed .laz.

    Reads from a locally cached full .copc.laz if present, else range-fetches
    from the IGN URL. Only the octree levels whose spacing is at or below
    *resolution* are fetched (no full download).

    """
    tile: TileInfo = find_tile_lamb(x_km * 1000, (y_km - 1) * 1000)
    return str(_query_and_cache(tile, cache_dir, resolution, download_from_ign))


def download_for_pm_tile(
    pm_x: int,
    pm_y: int,
    cache_dir: str,
    *,
    resolution: int = DEFAULT_RESOLUTION,
    download_from_ign: bool = False,
) -> list[str]:
    """Fetch every LAZ a WebMercatorQuad job needs, in parallel."""
    required = required_l93_tiles(pm_x, pm_y)
    if not required:
        return []

    with ThreadPoolExecutor(max_workers=len(required)) as pool:
        futures = [
            pool.submit(
                download_cell_laz,
                x,
                y,
                cache_dir,
                resolution=resolution,
                download_from_ign=download_from_ign,
            )
            for x, y in required
        ]
        paths = []
        errors = []
        for fut in futures:
            try:
                paths.append(str(fut.result()))
            except Exception as error:  # noqa: BLE001
                errors.append(error)

    if not paths and errors:
        raise errors[0]
    return paths
