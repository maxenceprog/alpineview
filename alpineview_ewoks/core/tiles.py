"""Tiles build step: download a LiDAR HD LAZ and mesh it with alpineview_builder.

alpineview_builder writes the Draco LOD tiles directly:
    z=0 1km ÷16 → 1 file   z=1 500m ÷4 → 4 files   z=2 250m full → 16 files
    tile.{x}.{y}.{z}.drc
"""

from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path

import laspy
from laspy import CopcReader

from alpineview_ewoks.core.lidar_hd import TileInfo, find_tile_lamb

_REPO = Path(__file__).resolve().parents[2]
_ALPINEVIEW_BUILDER = str(
    _REPO
    / "alpineview_builder"
    / "build"
    / "release"
    / "src"
    / "alpineview_builder"
)
_POISSONRECON_DIR = str(_REPO / "third-parties" / "PoissonRecon" / "Bin" / "Linux")
DEFAULT_CACHE_DIR = str(Path.home() / ".cache" / "poissonrecon-ign")
DEFAULT_TILES_OUT = str(_REPO / "webapp" / "public" / "tiles")
DEFAULT_VEGETATION_OUT = str(_REPO / "webapp" / "public" / "vegetation")

# LOD_LEVEL/DEFAULT_RESOLUTION are shared with non-task callers (cosia.py,
# cosia_satellite.py, pipeline.py's CLI defaults) so stay module constants.
# alpineview_builder's own tuning knobs (depth, weight, trim, downsample, ...) do
# not: run_alpineview_builder() below takes them as required arguments, and their
# only default lives in BuildTilesInputs (tasks/tiles.py) — the ewoks task.
LOD_LEVEL = 2
DEFAULT_RESOLUTION = 1

_NEIGHBOUR_OFFSETS = ((-1, 0), (1, 0), (0, -1), (0, 1))

log = logging.getLogger("reconstruction.tiles")


class ElevationUnderThreshold(Exception):
    """Raised when a tile's maximum Z is below the required elevation threshold."""


class AlpineviewBuilderError(Exception):
    """Raised when alpineview_builder exits with a non-zero code."""


def _query_and_cache(
    tile: TileInfo,
    cache_dir: str,
    resolution: int,
    min_elevation: float | None,
    download_from_ign: bool = False,
) -> Path:
    """Query *tile* at *resolution* (from a cached COPC if present, else the IGN URL) → compressed .laz."""
    dest = Path(cache_dir) / (tile.name.removesuffix(".copc.laz") + ".laz")
    if dest.exists():
        try:
            # try open header
            laspy.open(dest, decompression_selection=0)
            return dest
        except laspy.errors.LaspyException:
            log.info("las read", exc_info=True)
            pass
    local_copc = Path(cache_dir) / tile.name
    if not local_copc.exists() and not download_from_ign:
        raise RuntimeError(f"{local_copc} is not in cache")
    source = str(local_copc) if local_copc.exists() else tile.url
    log.info(
        "COPC query %s at %d m resolution (%s) …",
        tile.name,
        resolution,
        "cache" if local_copc.exists() else "remote",
    )

    with CopcReader.open(source) as reader:
        if min_elevation is not None and reader.header.z_max < min_elevation:
            raise ElevationUnderThreshold(
                f"Tile {tile.name} z_max={reader.header.z_max:.1f} m < threshold {min_elevation:.1f} m"
            )
        elevation_diff = reader.header.z_max - reader.header.z_min
        if elevation_diff < 200:
            log.info(
                "Lower resolution because elevation_diff is low: %.1f", elevation_diff
            )
            resolution += 1

        points = reader.query(resolution=resolution)
        src_header = reader.header

    Path(cache_dir).mkdir(parents=True, exist_ok=True)

    # laspy cannot write COPC files, so build a plain LAS header from the COPC one.
    header = laspy.LasHeader(
        point_format=src_header.point_format, version=src_header.version
    )
    header.scales = src_header.scales
    header.offsets = src_header.offsets

    tmp_dest = dest.with_name(f"{dest.name}.{os.getpid()}.tmp")
    with laspy.open(tmp_dest, mode="w", header=header) as f:
        f.write_points(points)
    os.replace(tmp_dest, dest)

    log.info("  Written %d points → %s", len(points), dest)
    return dest


def download_cell_laz(
    x_km: int,
    y_km: int,
    cache_dir: str,
    *,
    resolution: int = DEFAULT_RESOLUTION,
    min_elevation: float | None = None,
    download_from_ign: bool = False,
) -> str:
    """COPC-query the LiDAR HD LAZ for cell (x_km, y_km) at *resolution* → compressed .laz.

    Reads from a locally cached full .copc.laz if present, else range-fetches
    from the IGN URL. Only the octree levels whose spacing is at or below
    *resolution* are fetched (no full download).

    Raises ElevationUnderThreshold if the tile's Z-max is below *min_elevation*.
    """
    tile: TileInfo = find_tile_lamb(x_km * 1000, (y_km - 1) * 1000)
    return str(
        _query_and_cache(tile, cache_dir, resolution, min_elevation, download_from_ign)
    )


def download_cell_and_neighbours(
    x_km: int,
    y_km: int,
    cache_dir: str,
    *,
    resolution: int = DEFAULT_RESOLUTION,
    min_elevation: float | None = None,
    download_from_ign: bool = False,
) -> str:
    """COPC-query cell (x_km, y_km) and its 4 neighbours into cache_dir, in parallel.

    Returns the centre cell's LAZ path. *min_elevation* is enforced only on the
    centre cell, whose ElevationUnderThreshold propagates so callers can skip
    the tile. Waits for every download to finish before raising, so a failure
    doesn't cut off downloads already in flight.
    """
    centre_path = download_cell_laz(
        x_km,
        y_km,
        cache_dir,
        resolution=resolution,
        min_elevation=min_elevation,
        download_from_ign=download_from_ign,
    )
    for dx, dy in _NEIGHBOUR_OFFSETS:
        download_cell_laz(
            x_km + dx,
            y_km + dy,
            cache_dir,
            resolution=resolution,
            download_from_ign=download_from_ign,
        )

    return str(centre_path)


def delete_cell_outputs(
    x_km: int,
    y_km: int,
    tiles_dir: str = DEFAULT_TILES_OUT,
    vegetation_dir: str = DEFAULT_VEGETATION_OUT,
    lod: int = LOD_LEVEL,
) -> int:
    """Remove a cell's existing .drc tiles and vegetation files; returns count.

    The web tile grid indexes the south edge, so cell (x_km, y_km) — LAZ
    NW-corner naming, y = north edge — covers web row y_km - 1.
    """
    removed = 0
    y0 = y_km - 1
    for z in range(lod + 1):
        n = 1 << z
        for i in range(n):
            for j in range(n):
                prefix = f"tile.{x_km * n + i}.{y0 * n + j}.{z}"
                targets = [Path(tiles_dir) / f"{prefix}.drc"]
                if z == lod:  # vegetation exists only at the deepest LOD
                    targets.append(Path(vegetation_dir) / f"{prefix}.veg.drc")
                for target in targets:
                    if target.exists():
                        target.unlink()
                        removed += 1
    if removed:
        log.info("Deleted %d existing files for cell (%d, %d)", removed, x_km, y_km)
    return removed


def cell_outputs_exist(
    x_km: int,
    y_km: int,
    tiles_dir: str = DEFAULT_TILES_OUT,
    lod: int = LOD_LEVEL,
) -> bool:
    """True if the cell's deepest-LOD .drc tiles are already built."""
    y0 = y_km - 1
    n = 1 << lod
    for i in range(n):
        for j in range(n):
            prefix = f"tile.{x_km * n + i}.{y0 * n + j}.{lod}"
            if not (Path(tiles_dir) / f"{prefix}.drc").exists():
                return False
    return True


def run_alpineview_builder(
    x_km: int,
    y_km: int,
    cache_dir: str,
    out_dir: str,
    *,
    depth: int,
    weight: float,
    lod: int,
    trim: float,
    parallel: bool,
    use_las: bool,
    optimize: bool,
    encode: bool,
    skirt_depth: float,
    aratio: float,
    clean: int,
    downsample: bool,
    ds_voxel: float,
    ds_cone: float,
    ds_min_pts: int,
) -> str:
    """Run alpineview_builder for cell (x_km, y_km); .drc LODs land in `out_dir`, returns its stdout.

    No defaults: every alpineview_builder tuning knob is required here so it has
    exactly one default, in BuildTilesInputs (tasks/tiles.py).
    """
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["PATH"] = _POISSONRECON_DIR + ":" + env["PATH"]
    cmd = [
        _ALPINEVIEW_BUILDER,
        str(x_km),
        str(y_km),
        "--base-dir",
        cache_dir,
        "--out-dir",
        out_dir,
        "--depth",
        str(depth),
        "--weight",
        str(weight),
        "--lod",
        str(lod),
        "--trim",
        str(trim),
        "--aratio",
        str(aratio),
        "--clean",
        str(clean),
        "--skirt",
        str(skirt_depth),
        "--verbose",
        "--optimize" if optimize else "--no-optimize",
        "--encode" if encode else "--no-encode",
    ]
    if use_las:
        cmd.append("--las")
    if parallel:
        cmd.append("--parallel")
    if downsample:
        cmd += [
            "--downsample",
            "--ds-voxel",
            str(ds_voxel),
            "--ds-cone",
            str(ds_cone),
            "--ds-min-pts",
            str(ds_min_pts),
        ]
    cmd_str = " ".join(cmd)
    log.info(cmd_str)
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        raise AlpineviewBuilderError(
            f"Process {_ALPINEVIEW_BUILDER} exit with {proc.returncode}\n"
            f"\ncommand:\n{cmd_str}\n"
            f"\nstdout before crash:\n{proc.stdout}"
        )
    return f"command:\n{cmd_str}\n\nstdout:\n{proc.stdout}"
