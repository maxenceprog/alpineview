"""Pack the WebMercatorQuad terrain into one committed JSON.

Same transport trick as the L93 tiler it replaces -- one file holding the
root tileset with every cell inlined plus every subtree base64'd, so only
.glb ever hits the network. Geometry stays in the same lat_ref-scaled
Mercator "work" frame the builder reconstructs in: cells are WebMercatorQuad
tiles at CELL_LEVEL, tile positions are work-frame metres relative to the
cell's own origin, and each cell's transform is a plain translation by that
origin. There is no ECEF/ENU hop -- this tileset is only ever read by this
project's own bespoke webapp loader, never a generic 3D-Tiles viewer, so
real WGS84 georeferencing buys nothing and was costing a full reprojection
reimplemented independently in three languages.

Nothing is read from the builder but the .glb files themselves: the cell key
comes from the directory name, the level and local coordinates from the file
path, the transform from the cell's own work-frame origin, and the
tile-frame AABB from the glTF accessor min/max (un-rotated out of the Y-up
the 3D Tiles spec requires of glb content).
"""

import base64
import json
import struct

from geo_constants import GEO
from subtree_writer import subtree_bytes
from tiler_io import DEFAULT_PATH as TERRAIN
from tiler_io import PACK_PATH, ImplicitTilingSubtree

# Every constant here comes from ../geo_constants.json, the same file the C++
# builders read at run time. Do not write any of them down again: a divergence
# does not fail loudly, it shifts the whole terrain.
CELL_LEVEL = GEO.cell_level
WORK_EXTENT = GEO.work_extent

# Screen-space error budget, in metres of geometric error. A cell's children
# halve it per level, so this sets when the root refines into cells at all.
ROOT_GEOMETRIC_ERROR = 4096
CELL_GEOMETRIC_ERROR = 512


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
    return [
        1.0,
        0.0,
        0.0,
        0.0,
        0.0,
        1.0,
        0.0,
        0.0,
        0.0,
        0.0,
        1.0,
        0.0,
        ox,
        oy,
        0.0,
        1.0,
    ]


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
        return (
            [lo[0], -hi[2], lo[1]],
            [hi[0], -lo[2], hi[1]],
        )
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
    """The y half-axis points SOUTH. Implicit subdivision steps the centre
    along +y as the local y index grows, but that index is the
    WebMercatorQuad row, which grows southward, while work-frame +y is
    north. Negating the axis vector reconciles the two -- without it every
    cell's boxes are mirrored north-south, which no numeric check would
    catch."""
    return [
        centre[0],
        centre[1],
        centre[2],
        half[0],
        0,
        0,
        0,
        -half[1],
        0,
        0,
        0,
        half[2],
    ]


def cell_work_box(cx, cy, z_lo, z_hi):
    """The cell's own extent, centred on its own transform origin: x/y
    directly from the grid (the box IS the frame here, nothing to reconcile
    against Mercator curvature the way an ENU frame would need), z from the
    terrain.

    This has to be the grid footprint, not a box fitted to the geometry:
    implicit tiling derives a child's volume by halving its parent's, so the
    parent must describe exactly the area the tile grid covers."""
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


def is_cell_directory(path):
    if not path.is_dir():
        return False
    parts = path.name.split(".")
    return len(parts) == 2 and all(p.isdigit() for p in parts)


def main():
    cells = sorted(p for p in TERRAIN.iterdir() if is_cell_directory(p))

    children = []
    subtrees = {}
    root_lo = [1e30, 1e30, 1e30]
    root_hi = [-1e30, -1e30, -1e30]

    for cell_dir in cells:
        cx, cy = (int(v) for v in cell_dir.name.split("."))
        found = cell_extent(cell_dir)
        if found is None:
            print("skipping", cell_dir.name, "(no glb)")
            continue
        lo, hi, level_count, tiles = found
        centre, half = cell_work_box(cx, cy, lo[2], hi[2])

        print(
            "building",
            cell_dir.name,
            "levels %d..%d" % (CELL_LEVEL, CELL_LEVEL + level_count - 1),
            "z %.0f..%.0f" % (lo[2], hi[2]),
            "%d tiles" % len(tiles),
        )

        children.append(
            build_cell_tile(cell_dir.name, cx, cy, centre, half, level_count)
        )
        subtrees[f"{cell_dir.name}/subtrees/0.0.0.subtree"] = build_cell_subtree(
            cell_dir.name, level_count
        )

        x0, y0, _, _ = cell_bounds(cx, cy)
        for i, v in enumerate((x0, y0, 0.0)):
            root_lo[i] = min(root_lo[i], v)
            root_hi[i] = max(root_hi[i], v)

    if not children:
        print("no cells found under", TERRAIN)
        return

    # The root has no transform, so its bounding volume is plain work-frame
    # coordinates; a sphere avoids pretending an axis-aligned box means
    # anything there.
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

    PACK_PATH.write_text(json.dumps({"tileset": tileset, "subtrees": subtrees}))
    size = PACK_PATH.stat().st_size
    print(
        "done,",
        len(children),
        "cells,",
        len(subtrees),
        "subtrees ->",
        PACK_PATH,
        "(%.1f kB)" % (size / 1024),
    )


if __name__ == "__main__":
    main()
