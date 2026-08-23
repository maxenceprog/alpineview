"""Standalone: for every z0 (level 11) cell directory under the local terrain
root, compute that cell's contribution to the pack and write it as
local_tileset.json inside the cell directory, then sync the terrain root to
the cloud (.glb files + the local_tileset.json files).

Height ranges etc. are read from real local files here -- the whole point is
to do that work locally, once, instead of an S3 range-GET per tile later.
build_tileset_from_cloud.py is the counterpart that aggregates every cell's
local_tileset.json (fetched back from the cloud) into the one committed pack.

Deliberately does not import ogc3d_tiler/build_tileset.py: that script is the
local full-build path and is free to evolve on its own; this one owns its own
copy of the per-cell computation.
"""

import base64
import json
import struct
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
TERRAIN = REPO / "webapp" / "public" / "pm"

sys.path.insert(0, str(REPO / "ogc3d_tiler"))
from geo_constants import GEO
from subtree_writer import subtree_bytes
from tiler_io import ImplicitTilingSubtree

CELL_LEVEL = GEO.cell_level
WORK_EXTENT = GEO.work_extent
LOD_LOCAL_LEVEL = GEO.lod_level0 - CELL_LEVEL
CELL_GEOMETRIC_ERROR = 512

LOCAL_TILESET_NAME = "local_tileset.json"

S3_ENDPOINT = "https://s3.sbg.io.cloud.ovh.net"
S3_BUCKET = "lidalps3d"
S3_PREFIX = "pm/"


def cell_bounds(cx, cy):
    size = 2.0 * WORK_EXTENT / 2.0**CELL_LEVEL
    x0 = -WORK_EXTENT + cx * size
    y1 = WORK_EXTENT - cy * size
    return x0, y1 - size, x0 + size, y1


def cell_origin(cx, cy):
    x0, y0, x1, y1 = cell_bounds(cx, cy)
    return (x0 + x1) / 2, (y0 + y1) / 2


def translate_transform(ox, oy):
    """Column-major 4x4, identity rotation, as 3D Tiles wants it."""
    return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, ox, oy, 0.0, 1.0]


def glb_bounds(path):
    """The tile's work-frame AABB, from the accessor min/max, rotated back
    out of the glTF Y-up frame (work = x, -z, y)."""
    with open(path, "rb") as f:
        header = f.read(20)
        if header[:4] != b"glTF":
            return None
        json_length = struct.unpack("<I", header[12:16])[0]
        document = json.loads(f.read(json_length))

    for accessor in document.get("accessors", ()):
        if accessor.get("type") != "VEC3" or "min" not in accessor:
            continue
        lo, hi = accessor["min"], accessor["max"]
        return ([lo[0], -hi[2], lo[1]], [hi[0], -lo[2], hi[1]])
    return None


def cell_extent(cell_dir):
    """Every tile's work-frame AABB, their union, and the cell's level count."""
    lo = [1e30, 1e30, 1e30]
    hi = [-1e30, -1e30, -1e30]
    levels = []
    tiles = []

    for level_dir in sorted(cell_dir.iterdir()):
        if not level_dir.is_dir() or not level_dir.name.isdigit():
            continue
        glbs = sorted(level_dir.glob("*.glb"))
        if not glbs:
            continue
        level = int(level_dir.name)
        levels.append(level)
        for glb in glbs:
            found = glb_bounds(glb)
            if found is None:
                continue
            x, y = (int(v) for v in glb.name.split(".")[:2])
            tiles.append((level, x, y, found[0], found[1]))
            for i in range(3):
                lo[i] = min(lo[i], found[0][i])
                hi[i] = max(hi[i], found[1][i])

    if not levels or lo[0] > hi[0]:
        return None
    return lo, hi, max(levels) + 1, tiles


def make_box(centre, half):
    """The y half-axis points SOUTH -- see build_tileset.make_box."""
    return [centre[0], centre[1], centre[2], half[0], 0, 0, 0, -half[1], 0, 0, 0, half[2]]


def cell_work_box(cx, cy, z_lo, z_hi):
    x0, y0, x1, y1 = cell_bounds(cx, cy)
    centre = [0.0, 0.0, (z_lo + z_hi) / 2]
    half = [(x1 - x0) / 2, (y1 - y0) / 2, (z_hi - z_lo) / 2]
    return centre, half


def build_cell_tile(name, cx, cy, centre, half, level_count):
    ox, oy = cell_origin(cx, cy)
    return {
        "boundingVolume": {"box": make_box(centre, half)},
        "transform": translate_transform(ox, oy),
        "geometricError": CELL_GEOMETRIC_ERROR,
        "refine": "REPLACE",
        "content": {"uri": f"{name}/{{level}}/{{x}}.{{y}}.glb"},
        "implicitTiling": {
            "subdivisionScheme": "QUADTREE",
            "subtreeLevels": level_count,
            "availableLevels": level_count,
            "subtrees": {"uri": f"{name}/subtrees/{{level}}.{{x}}.{{y}}.subtree"},
        },
    }


def build_cell_subtree(name, level_count):
    subtree = ImplicitTilingSubtree(
        tile_path_format=f"{name}/{{level}}/{{x}}.{{y}}.glb",
        max_level=level_count,
    )
    return base64.b64encode(subtree_bytes(subtree)).decode()


def max_descendant_level(existing, level, x, y):
    """Deepest local level reached by recursively refining (level, x, y),
    following only children whose glb actually exists."""
    best = level
    for dx in (0, 1):
        for dy in (0, 1):
            child = (level + 1, 2 * x + dx, 2 * y + dy)
            if child in existing:
                best = max(best, max_descendant_level(existing, *child))
    return best


def is_cell_directory(path):
    if not path.is_dir():
        return False
    parts = path.name.split(".")
    return len(parts) == 2 and all(p.isdigit() for p in parts)


def compute_cell(cell_dir):
    """Everything this one cell contributes to the pack, computed from its
    own tiles only -- no other cell's data is read."""
    cx, cy = (int(v) for v in cell_dir.name.split("."))
    found = cell_extent(cell_dir)
    if found is None:
        return None
    lo, hi, level_count, tiles = found
    centre, half = cell_work_box(cx, cy, lo[2], hi[2])

    hd_x, hd_y, hd_max_level, hd_z_hi = [], [], [], []
    existing = {(tl, tx, ty) for tl, tx, ty, _, _ in tiles}
    for level, x, y, _, thi in tiles:
        if level == LOD_LOCAL_LEVEL:
            hd_x.append(cx * (1 << LOD_LOCAL_LEVEL) + x)
            hd_y.append(cy * (1 << LOD_LOCAL_LEVEL) + y)
            hd_max_level.append(
                GEO.lod_level0
                + max_descendant_level(existing, level, x, y)
                - LOD_LOCAL_LEVEL
            )
            hd_z_hi.append(round(thi[2]))

    x0, y0, _, _ = cell_bounds(cx, cy)

    return {
        "name": cell_dir.name,
        "tileCount": len(tiles),
        "levels": f"{CELL_LEVEL}..{CELL_LEVEL + level_count - 1}",
        "zRange": [lo[2], hi[2]],
        "child": build_cell_tile(cell_dir.name, cx, cy, centre, half, level_count),
        "subtreeB64": build_cell_subtree(cell_dir.name, level_count),
        "hdX": hd_x,
        "hdY": hd_y,
        "hdMaxLevel": hd_max_level,
        "hdZHi": hd_z_hi,
        # The corner every cell's root sphere is fitted around, in
        # build_tileset_from_cloud.py -- deliberately just this one point per
        # cell, matching build_tileset.py's own single-pass computation.
        "rootCorner": [x0, y0, 0.0],
    }


def sync_to_cloud(out_dir):
    subprocess.run(
        [
            "aws",
            "s3",
            "sync",
            str(out_dir),
            f"s3://{S3_BUCKET}/{S3_PREFIX}",
            "--acl",
            "public-read",
            "--endpoint-url",
            S3_ENDPOINT,
            "--exclude",
            "*",
            "--include",
            "*.glb",
            "--include",
            f"*/{LOCAL_TILESET_NAME}",
        ],
        check=True,
    )


def main():
    cells = sorted(p for p in TERRAIN.iterdir() if is_cell_directory(p))

    written = 0
    for cell_dir in cells:
        cell = compute_cell(cell_dir)
        if cell is None:
            print("skipping", cell_dir.name, "(no glb)")
            continue
        (cell_dir / LOCAL_TILESET_NAME).write_text(json.dumps(cell))
        print("wrote", cell_dir.name, "/", LOCAL_TILESET_NAME)
        written += 1

    print(written, "cell(s) written, syncing to", f"s3://{S3_BUCKET}/{S3_PREFIX}", "...")
    sync_to_cloud(TERRAIN)
    print("done")


if __name__ == "__main__":
    main()
