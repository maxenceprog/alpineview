"""Fetches every cell's local_tileset.json back from the cloud and
aggregates them into the one committed pack.
"""

import base64
import json
import struct
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from ..core.geo_constants import GEO
from .subtree_writer import pack_subtree
from .tiler_io import PACK_PATH, BitStream, ImplicitTilingSubtree, demorton

LOCAL_TILESET_NAME = "local_tileset.json"

S3_ENDPOINT = "https://s3.sbg.io.cloud.ovh.net"
S3_BUCKET = "lidalps3d"
S3_PREFIX = "pm/"

CELL_LEVEL = GEO.cell_level
WORK_EXTENT = GEO.work_extent
HD_LEVEL = GEO.lod_level0
LOD_LOCAL_LEVEL = HD_LEVEL - CELL_LEVEL

ROOT_GEOMETRIC_ERROR = 4096
CELL_GEOMETRIC_ERROR = 512

COARSE_SUBTREE_LEVELS = LOD_LOCAL_LEVEL
HD_SUBTREE_LEVELS = 5
MAX_HD_LEVEL = HD_LEVEL + HD_SUBTREE_LEVELS - 1

CELL_Z_LO = 0.0


def cell_bounds(cx, cy):
    size = 2.0 * WORK_EXTENT / 2.0**CELL_LEVEL
    x0 = -WORK_EXTENT + cx * size
    y1 = WORK_EXTENT - cy * size
    return x0, y1 - size, x0 + size, y1


def translate_transform(ox, oy):
    return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, ox, oy, 0.0, 1.0]


def make_box(centre, half):
    return [centre[0], centre[1], centre[2], half[0], 0, 0, 0, -half[1], 0, 0, 0, half[2]]


def coarse_subtree_bytes(hd_local_xy):
    dummy = ImplicitTilingSubtree(tile_path_format="", max_level=COARSE_SUBTREE_LEVELS)

    tile_bits = BitStream()
    content_bits = BitStream()
    for level in range(COARSE_SUBTREE_LEVELS):
        for _key, _path in demorton(level, dummy):
            tile_bits.append_bit(True)
            content_bits.append_bit(True)
    tile_bits.finish()
    content_bits.finish()

    child_bits = BitStream()
    for (_level, x, y), _path in demorton(COARSE_SUBTREE_LEVELS, dummy):
        child_bits.append_bit((x, y) in hd_local_xy)
    child_bits.finish()

    return pack_subtree(tile_bits.content, content_bits.content, child_bits.content)


def hd_subtree_bytes(depth):
    dummy = ImplicitTilingSubtree(tile_path_format="", max_level=COARSE_SUBTREE_LEVELS)

    tile_bits = BitStream()
    content_bits = BitStream()
    for level in range(COARSE_SUBTREE_LEVELS):
        available = level < depth
        for _key, _path in demorton(level, dummy):
            tile_bits.append_bit(available)
            content_bits.append_bit(available)
    tile_bits.finish()
    content_bits.finish()

    needs_leaf_tier = depth > COARSE_SUBTREE_LEVELS
    return pack_subtree(tile_bits.content, content_bits.content, needs_leaf_tier)


def leaf_subtree_bytes():
    dummy = ImplicitTilingSubtree(tile_path_format="", max_level=COARSE_SUBTREE_LEVELS)

    tile_bits = BitStream()
    content_bits = BitStream()
    for level in range(COARSE_SUBTREE_LEVELS):
        available = level == 0
        for _key, _path in demorton(level, dummy):
            tile_bits.append_bit(available)
            content_bits.append_bit(available)
    tile_bits.finish()
    content_bits.finish()

    return pack_subtree(tile_bits.content, content_bits.content)


HD_SUBTREE_BLOBS = [
    base64.b64encode(hd_subtree_bytes(depth)).decode()
    for depth in range(1, HD_SUBTREE_LEVELS + 1)
]

LEAF_SUBTREE_BLOB = base64.b64encode(leaf_subtree_bytes()).decode()


FETCH_WORKERS = 16


def list_cell_prefixes():
    prefixes = []
    token = None
    while True:
        cmd = [
            "aws",
            "s3api",
            "list-objects-v2",
            "--bucket",
            S3_BUCKET,
            "--prefix",
            S3_PREFIX,
            "--delimiter",
            "/",
            "--endpoint-url",
            S3_ENDPOINT,
        ]
        if token:
            cmd += ["--starting-token", token]
        out = json.loads(
            subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
        )
        prefixes.extend(p["Prefix"] for p in out.get("CommonPrefixes", []))
        token = out.get("NextContinuationToken")
        if not token:
            break
    return prefixes


def fetch_local_tilesets(dest_dir):
    def fetch_one(prefix):
        dest = dest_dir / Path(prefix).name / LOCAL_TILESET_NAME
        dest.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            [
                "aws",
                "s3",
                "cp",
                f"s3://{S3_BUCKET}/{prefix}{LOCAL_TILESET_NAME}",
                str(dest),
                "--endpoint-url",
                S3_ENDPOINT,
            ],
            capture_output=True,
            check=False,
        )
        return dest if result.returncode == 0 else None

    with ThreadPoolExecutor(FETCH_WORKERS) as pool:
        results = pool.map(fetch_one, list_cell_prefixes())
    return sorted(p for p in results if p is not None)


def build_cell(cx, cy, cell):
    name = f"{cx}.{cy}"
    hd_x, hd_y, hd_max_level, hd_z_hi = (
        cell["hdX"],
        cell["hdY"],
        cell["hdMaxLevel"],
        cell["hdZHi"],
    )

    n = 1 << LOD_LOCAL_LEVEL
    hd_local_xy = {(x - cx * n, y - cy * n) for x, y in zip(hd_x, hd_y)}

    x0, y0, x1, y1 = cell_bounds(cx, cy)
    ox, oy = (x0 + x1) / 2, (y0 + y1) / 2
    z_hi = max(hd_z_hi, default=CELL_Z_LO)
    centre = [0.0, 0.0, (CELL_Z_LO + z_hi) / 2]
    half = [(x1 - x0) / 2, (y1 - y0) / 2, (z_hi - CELL_Z_LO) / 2]

    child = {
        "boundingVolume": {"box": make_box(centre, half)},
        "transform": translate_transform(ox, oy),
        "geometricError": CELL_GEOMETRIC_ERROR,
        "refine": "REPLACE",
        "content": {"uri": f"{name}/{{level}}/{{x}}.{{y}}.glb"},
        "implicitTiling": {
            "subdivisionScheme": "QUADTREE",
            "subtreeLevels": COARSE_SUBTREE_LEVELS,
            "availableLevels": COARSE_SUBTREE_LEVELS + HD_SUBTREE_LEVELS,
            "subtrees": {"uri": f"{name}/subtrees/{{level}}.{{x}}.{{y}}.subtree"},
        },
    }

    for max_level in hd_max_level:
        if max_level > MAX_HD_LEVEL:
            raise ValueError(
                f"cell {name}: a leaf's maxLevel {max_level} exceeds "
                f"MAX_HD_LEVEL {MAX_HD_LEVEL} -- extend HD_SUBTREE_LEVELS"
            )

    subtrees = {
        f"{name}/subtrees/0.0.0.subtree": base64.b64encode(
            coarse_subtree_bytes(hd_local_xy)
        ).decode()
    }

    return child, subtrees, [x0, y0, 0.0]


def _pack_u16(values):
    return struct.pack(f"<{len(values)}H", *values)


def assemble_pack(cells):
    children = []
    subtrees = {}
    root_lo = [1e30, 1e30, 1e30]
    root_hi = [-1e30, -1e30, -1e30]
    hd_x, hd_y, hd_max_level, hd_z_hi = [], [], [], []

    for cx, cy, cell in cells:
        child, cell_subtrees, root_corner = build_cell(cx, cy, cell)
        children.append(child)
        subtrees.update(cell_subtrees)
        hd_x.extend(cell["hdX"])
        hd_y.extend(cell["hdY"])
        hd_max_level.extend(cell["hdMaxLevel"])
        hd_z_hi.extend(cell["hdZHi"])
        for i, v in enumerate(root_corner):
            root_lo[i] = min(root_lo[i], v)
            root_hi[i] = max(root_hi[i], v)

    if not children:
        return None

    centre = [(a + b) / 2 for a, b in zip(root_lo, root_hi)]
    radius = max(b - a for a, b in zip(root_lo, root_hi)) / 2 + 20000.0

    tileset = {
        "asset": {"version": "1.1"},
        "geometricError": ROOT_GEOMETRIC_ERROR,
        "root": {
            "boundingVolume": {"sphere": centre + [radius]},
            "geometricError": ROOT_GEOMETRIC_ERROR,
            "refine": "REPLACE",
            "children": children,
        },
    }

    return {
        "tileset": tileset,
        "subtrees": subtrees,
        "hdSubtreeBlobs": HD_SUBTREE_BLOBS,
        "leafSubtreeBlob": LEAF_SUBTREE_BLOB,
        "hdLevel": HD_LEVEL,
        "x15": base64.b64encode(_pack_u16(hd_x)).decode(),
        "y15": base64.b64encode(_pack_u16(hd_y)).decode(),
        "maxLevel15": base64.b64encode(bytes(hd_max_level)).decode(),
        "zHi15": base64.b64encode(_pack_u16(hd_z_hi)).decode(),
    }


def main():
    with tempfile.TemporaryDirectory(prefix="alpineview-local-tilesets-") as tmp:
        paths = fetch_local_tilesets(Path(tmp))
        print(len(paths), "local_tileset.json fetched from", f"s3://{S3_BUCKET}/{S3_PREFIX}")
        cells = []
        for p in paths:
            cx, cy = (int(v) for v in p.parent.name.split("."))
            cell = json.loads(p.read_text())
            cells.append((cx, cy, cell))

    pack = assemble_pack(cells)
    if pack is None:
        print("no cells found")
        return

    PACK_PATH.write_text(json.dumps(pack))
    size = PACK_PATH.stat().st_size
    print(
        "done,",
        len(pack["tileset"]["root"]["children"]),
        "cells,",
        len(pack["subtrees"]),
        "subtrees ->",
        PACK_PATH,
        "(%.1f kB)" % (size / 1024),
    )


if __name__ == "__main__":
    main()
