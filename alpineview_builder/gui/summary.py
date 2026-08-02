import json
import os
import subprocess

from tiles import CELL_LEVEL, tile_output_path, tiles_in_rect

FIRST_LEVEL = CELL_LEVEL + 1
LAST_LEVEL = 18


def run_tiler(tiler_dir, python="python"):
    p = subprocess.run(
        [python, "build_tileset.py"],
        cwd=tiler_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    return p.returncode, p.stdout


def pack_cells(pack_path):
    """Each cell in the pack, with the finest absolute level it declares."""
    with open(pack_path) as f:
        pack = json.load(f)
    cells = {}
    for child in pack["tileset"]["root"].get("children", ()):
        uri = child["content"]["uri"]
        cell = tuple(int(v) for v in uri.split("/")[0].split("."))
        levels = child["implicitTiling"]["availableLevels"]
        cells[cell] = CELL_LEVEL + levels - 1
    return cells


def percentile(values, q):
    if not values:
        return 0.0
    k = (len(values) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (k - lo)


def level_stats(out_dir, cells, rect, level):
    missing = 0
    sizes = []
    for x, y in tiles_in_rect(*rect, level=level):
        cell = (x >> (level - CELL_LEVEL), y >> (level - CELL_LEVEL))
        path = tile_output_path(out_dir, x, y, level)
        if cells.get(cell, -1) >= level and os.path.isfile(path):
            sizes.append(os.path.getsize(path) / 1024.0)
        else:
            missing += 1
    sizes.sort()
    return {
        "level": level,
        "total": missing + len(sizes),
        "missing": missing,
        "median": percentile(sizes, 0.5),
        "p5": percentile(sizes, 0.05),
        "p95": percentile(sizes, 0.95),
    }


def summarize(out_dir, pack_path, rect):
    cells = pack_cells(pack_path)
    return [
        level_stats(out_dir, cells, rect, lv)
        for lv in range(FIRST_LEVEL, LAST_LEVEL + 1)
    ]


def format_summary(rows):
    lines = ["level  tiles  no content   median      p5     p95   (kB)"]
    for r in rows:
        lines.append(
            "%5d  %5d  %10d  %7.1f %7.1f %7.1f"
            % (r["level"], r["total"], r["missing"], r["median"], r["p5"], r["p95"])
        )
    return "\n".join(lines)
