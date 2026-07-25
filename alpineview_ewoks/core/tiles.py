"""Tiles build step: download a LiDAR HD LAZ and mesh it with alpineview_builder.

alpineview_builder writes the Draco LOD tiles directly:
    z=0 1km ÷16 → 1 file   z=1 500m ÷4 → 4 files   z=2 250m full → 16 files
    tile.{x}.{y}.{z}.drc

Each build also appends one line to a shared `{out_dir}/meta.jsonl` (build
command, stdout, inputs, repo commit) — see read_meta.py.
"""

from __future__ import annotations

import fcntl
import json
import logging
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

import laspy
from laspy import CopcReader

from alpineview_ewoks.core.lidar_hd import (
    TileInfo,
    download_tile,
    find_tile_lamb,
    tile_size,
)

_REPO = Path(__file__).resolve().parents[2]
_ALPINEVIEW_BUILDER = str(
    _REPO / "alpineview_builder" / "build" / "release" / "src" / "alpineview_builder"
)
_POISSONRECON_DIR = str(_REPO / "third-parties" / "PoissonRecon" / "Bin" / "Linux")
DEFAULT_CACHE_DIR = str(Path.home() / ".cache" / "poissonrecon-ign")
DEFAULT_TILES_OUT = str(_REPO / "webapp" / "public" / "tiles")
DEFAULT_VEGETATION_OUT = str(_REPO / "webapp" / "public" / "vegetation")

# LOD_LEVEL/DEFAULT_RESOLUTION are shared with non-task callers (cosia.py,
# cosia_satellite.py, pipeline.py's CLI defaults) so stay module constants.
LOD_LEVEL = 2
DEFAULT_RESOLUTION = 1
_NEIGHBOUR_OFFSETS = ((-1, 0), (1, 0), (0, -1), (0, 1))

# Above this, a full download costs more than it saves: measured on a 570 MB
# tile, full-file fetch took 12.8s vs 7.0s for a remote COPC range query at
# resolution=1 (same point count); on typical 130-220 MB tiles the full
# download wins or ties. 300 MB sits between the two. Heavy tiles are also
# denser, so resolution is capped no finer than 2 to keep the range query
# itself cheap (avoids the many-small-request 429 risk of finer levels).
HEAVY_TILE_BYTES = 300_000_000
HEAVY_TILE_MIN_RESOLUTION = 2

log = logging.getLogger("reconstruction.tiles")


class ElevationUnderThreshold(Exception):
    """Raised when a tile's maximum Z is below the required elevation threshold."""


class AlpineviewBuilderError(Exception):
    """Raised when alpineview_builder exits with a non-zero code."""


def _check_elevation(laz_file, min_elevation: float | None):
    if min_elevation is not None and laz_file.header.z_max < min_elevation:
        raise ElevationUnderThreshold(
            f"z_max={laz_file.header.z_max:.1f} m < threshold {min_elevation:.1f} m"
        )


def check_elevation(x_km: int, y_km: int, min_elevation: float | None, cache_dir: str):
    if min_elevation is None:
        return
    tile: TileInfo = find_tile_lamb(x_km * 1000, (y_km - 1) * 1000)
    dest = Path(cache_dir) / (tile.name.removesuffix(".copc.laz") + ".laz")
    if dest.exists():
        with laspy.open(dest, decompression_selection=0) as laz_file:
            _check_elevation(laz_file, min_elevation)
    else:
        with CopcReader.open(tile.url) as reader:
            _check_elevation(reader, min_elevation)


def _query_and_cache(
    tile: TileInfo,
    cache_dir: str,
    resolution: int,
    min_elevation: float | None,
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
            pass
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
    check_elevation(x_km, y_km, min_elevation, cache_dir)

    with ThreadPoolExecutor(max_workers=5) as pool:
        centre_future = pool.submit(
            download_cell_laz,
            x_km,
            y_km,
            cache_dir,
            resolution=resolution,
            min_elevation=min_elevation,
            download_from_ign=download_from_ign,
        )
        neighbour_futures = [
            pool.submit(
                download_cell_laz,
                x_km + dx,
                y_km + dy,
                cache_dir,
                resolution=resolution,
                download_from_ign=download_from_ign,
            )
            for dx, dy in _NEIGHBOUR_OFFSETS
        ]
        centre_path = centre_future.result()
        for fut in neighbour_futures:
            fut.result()
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


def _repo_commit() -> str | None:
    """Current HEAD commit of the alpineview repo, or None if not a git checkout."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=_REPO,
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def run_alpineview_builder(
    x_km: int,
    y_km: int,
    cache_dir: str,
    out_dir: str,
    builder_options: Sequence[str] = tuple([]),
) -> str:
    """Run alpineview_builder for cell (x_km, y_km); .drc LODs land in `out_dir`.

    Appends one JSON line (command, stdout, repo commit, *inputs*) to
    `{out_dir}/meta.jsonl` under an flock, and returns that path.
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
        *(str(o) for o in builder_options),
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

    metadata = {
        "date": datetime.now(timezone.utc).isoformat(),
        "cell": {"x_km": x_km, "y_km": y_km},
        "build": {
            "command": cmd,
            "returncode": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
        },
        "repo_commit": _repo_commit(),
    }
    metadata_path = Path(out_dir) / "meta.jsonl"
    with open(metadata_path, "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            f.write(json.dumps(metadata) + "\n")
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)
    return str(metadata_path)
