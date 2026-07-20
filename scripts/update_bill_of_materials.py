#!/usr/bin/env python3
"""Rebuild the bill-of-materials files the webapp uses to know what's built,
without probing the server tile by tile.

Each bom_*.txt is one "x.y" line per built 1 km cell (bom_ld.txt: 4 km cell,
its own z=-2 grid). Scans the actual output directories, so it's always a
truthful rebuild rather than an incremental log -- safe to rerun any time
(cron, after a build batch, ...).

Vegetation and buildings both mark a cell "built, nothing there" (16
zero-byte .veg.drc tiles / a header-only .city.jsonl) rather than leaving no
output at all, so their scans filter those back out: presence in the bom is
meant to mean "worth fetching", not merely "processed".

    python scripts/update_bill_of_materials.py
"""

import re
from pathlib import Path

TILES_DIR = Path("webapp/public/tiles")
VEGETATION_DIR = Path("webapp/public/vegetation")
BUILDINGS_DIR = Path("webapp/public/buildings")

HD_RE = re.compile(r"^tile\.(\d+)\.(\d+)\.0\.drc$")
LD_RE = re.compile(r"^tile\.(-?\d+)\.(-?\d+)\.-2\.drc$")
VEG_RE = re.compile(r"^tile\.(\d+)\.(\d+)\.2\.veg\.drc$")
BUILDINGS_RE = re.compile(r"^LHD_FXX_(\d+)_(\d+)_PTS_LAMB93_IGN69\.city\.jsonl$")
VEG_GRID = 4  # z=2 tiles per 1 km cell side


def write_bom(path: Path, cells: set[tuple[int, int]]) -> None:
    lines = [f"{x}.{y}" for x, y in sorted(cells)]
    path.write_text("\n".join(lines) + ("\n" if lines else ""))
    print(f"{path}: {len(lines)} cells")


def has_content(path: Path) -> bool:
    return path.stat().st_size > 0


def has_buildings(path: Path) -> bool:
    """More than the header line: a real building, not the empty-cell marker."""
    with path.open() as f:
        return sum(1 for line in f if line.strip()) >= 2


def scan(
    directory: Path, pattern: re.Pattern, predicate=has_content
) -> set[tuple[int, int]]:
    if not directory.is_dir():
        return set()
    cells = set()
    for f in directory.iterdir():
        m = pattern.match(f.name)
        if m and predicate(f):
            cells.add((int(m.group(1)), int(m.group(2))))
    return cells


def main() -> None:
    # HD/LD terrain tiles never get a placeholder for a missing cell -- existence
    # alone means built -- so the default (non-empty file) predicate is enough.
    write_bom(TILES_DIR / "bom_hd.txt", scan(TILES_DIR, HD_RE))
    write_bom(TILES_DIR / "bom_ld.txt", scan(TILES_DIR, LD_RE))

    veg_tiles = scan(VEGETATION_DIR, VEG_RE)
    veg_cells = {(tx // VEG_GRID, ty // VEG_GRID) for tx, ty in veg_tiles}
    write_bom(VEGETATION_DIR / "bom_vegetation.txt", veg_cells)

    # LAZ NW-corner naming (y = north edge); web tile grid indexes the south edge.
    building_cells = {
        (x, y - 1) for x, y in scan(BUILDINGS_DIR, BUILDINGS_RE, has_buildings)
    }
    write_bom(BUILDINGS_DIR / "bom_buildings.txt", building_cells)


if __name__ == "__main__":
    main()
