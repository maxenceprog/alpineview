"""Batch-build every cell of a metadonnees.json catalogue.

Downloads run here (with back-pressure), builds run on the ewoksjob worker:
    source ~/miniconda3/etc/profile.d/conda.sh; conda activate lidalp
    python -m alpineview_ewoks.build_tiles metadonnees.json
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import time
from pathlib import Path

from . import build_tiles_utils, client
from .core.lidar_hd import TileInfo
from .core.tiles import (
    DEFAULT_CACHE_DIR,
    DEFAULT_RESOLUTION,
    DEFAULT_TILES_OUT,
    download_cell_and_neighbours,
)
from .read_meta import built_cells, cells_built_at

DEFAULT_MIN_ELEVATION = 1000.0

MAX_PENDING = 7

_LAZ_RE = re.compile(r"LHD_FXX_(\d{4})_(\d{4})_PTS_LAMB93_IGN69")

log = logging.getLogger("alpineview_ewoks.build_tiles")


def parse_km(laz_name: str) -> tuple[int, int]:
    match = _LAZ_RE.search(laz_name)
    if not match:
        raise ValueError(f"Cannot parse tile coords from {laz_name!r}")
    return int(match.group(1)), int(match.group(2))


def tiles_from_metadonnees(path: Path) -> list[TileInfo]:
    """LAZ tiles listed in a metadonnees.json catalogue file."""
    data = json.loads(path.read_text())
    tiles = []
    for key, entry in data.items():
        if "_PTS_" not in key:
            continue
        url = entry.get("url", "")
        if url:
            tiles.append(TileInfo(name=url.split("/")[-1], url=url))
    log.info("Found %d LAZ tiles in %s", len(tiles), path.name)
    return tiles


def _check_pendings(pendings: dict) -> int:
    for xy in list(pendings.keys()):
        future = pendings[xy]
        if future.done():
            del pendings[xy]
            try:
                future.result()
                print(f"✓  built ({xy})")
            except Exception as error:  # noqa: BLE001
                log.error("build failed for %s: %s", xy, error)
                print(f"✗  ({xy})")

    return len(pendings)


def _wait(pendings: dict):
    while _check_pendings(pendings) > MAX_PENDING:
        time.sleep(0.1)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("metadonnees", type=Path, help="metadonnees.json catalogue")
    parser.add_argument(
        "--cache", default=DEFAULT_CACHE_DIR, help="LAZ cache directory"
    )
    parser.add_argument("--resolution", type=int, default=DEFAULT_RESOLUTION)
    parser.add_argument("--tiles-dir", default=DEFAULT_TILES_OUT)
    parser.add_argument(
        "--min-elevation",
        type=float,
        default=DEFAULT_MIN_ELEVATION,
        help="Skip cells whose LAZ z_max is below this (metres)",
    )
    parser.add_argument(
        "--rebuild",
        nargs="?",
        const="",
        default=None,
        metavar="DATE",
        help="Rebuild cells already present in meta.jsonl; with an argument "
        "'>aaaa/mm/dd[:hh:mm]' or '<aaaa/mm/dd[:hh:mm]', only those whose last "
        "build is after / before that date",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO)

    tiles = tiles_from_metadonnees(args.metadonnees)
    if not tiles:
        log.info("No tiles to process.")
        return

    print(f"TILES TO BUILD : {len(tiles)}")

    done = built_cells(args.tiles_dir)
    if args.rebuild == "":
        done = set()
    elif args.rebuild is not None:
        done -= cells_built_at(args.rebuild, args.tiles_dir)
    if done:
        log.info("Skipping %d cells already built", len(done))

    filtered_tiles = []

    for tile in tiles:
        x, y = parse_km(tile.name)
        if (x, y) not in done:
            filtered_tiles.append(tile)

    print(f"TILES TO BUILD (ALREADY BUILDED EXLUDED) : {len(filtered_tiles)}")

    build_tiles_utils.run_servers()

    pendings: dict = {}
    for i, tile in enumerate(filtered_tiles, 1):
        t0 = time.time()
        _wait(pendings)
        x, y = parse_km(tile.name)
        try:
            download_cell_and_neighbours(
                x,
                y,
                args.cache,
                resolution=args.resolution,
                min_elevation=args.min_elevation,
                download_from_ign=True,
            )
        except Exception as error:  # noqa: BLE001
            log.error("download failed for (%d, %d): %s", x, y, error)
            continue

        print(
            f"⬇  downloaded #{i}/{len(filtered_tiles)}  {tile.name} in {time.time() - t0}s"
        )
        pendings[(x, y)] = client.submit_build_tile(x, y)

    _wait(pendings)
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
