import glob
import json
import os
import struct

import numpy as np

OUT_DIR = "webapp/public/tiled3d"
BASE_GEOMETRIC_ERROR = 256.0
ORIGIN = (900000.0, 6400000.0, 0.0)
SUBTREE_LEVELS = 4


def geometric_error(z):
    return BASE_GEOMETRIC_ERROR / (2.0 ** z)


def box(lo, hi):
    c = (lo + hi) / 2.0
    h = (hi - lo) / 2.0
    return [float(c[0]), float(c[1]), float(c[2]),
            float(h[0]), 0.0, 0.0,
            0.0, float(h[1]), 0.0,
            0.0, 0.0, float(h[2])]


def load_bom():
    tiles = {}
    for path in sorted(glob.glob(os.path.join(OUT_DIR, "bom*.jsonl"))):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                r = json.loads(line)
                tx, ty, z = r["tx"], r["ty"], r["z"]
                lo = np.array(r["lo"], dtype=float)
                hi = np.array(r["hi"], dtype=float)
                tiles[(tx, ty, z)] = {"_lo": lo, "_hi": hi}
    return tiles


def pack_bits(bools):
    n = len(bools)
    data = bytearray((n + 7) // 8)
    for i, b in enumerate(bools):
        if b:
            data[i // 8] |= 1 << (i % 8)
    return bytes(data)


def write_subtree(path, available_tiles):
    tile_avail = pack_bits([True] * 5)
    content_avail = pack_bits(available_tiles[:5])
    child_subtree_avail = pack_bits([True] * 16)

    buffer = tile_avail + content_avail + child_subtree_avail
    subtree_json = {
        "buffers": [{"byteLength": len(buffer)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(tile_avail)},
            {"buffer": 0, "byteOffset": len(tile_avail), "byteLength": len(content_avail)},
            {"buffer": 0, "byteOffset": len(tile_avail) + len(content_avail),
             "byteLength": len(child_subtree_avail)},
        ],
        "tileAvailability": {"bitstream": 0},
        "contentAvailability": [{"bitstream": 1}],
        "childSubtreeAvailability": {"bitstream": 2},
    }
    json_bytes = json.dumps(subtree_json).encode("utf-8")
    pad = (-len(json_bytes)) % 8
    json_bytes += b" " * pad

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"subt")
        f.write(struct.pack("<I", 1))
        f.write(struct.pack("<Q", len(json_bytes)))
        f.write(struct.pack("<Q", len(buffer)))
        f.write(json_bytes)
        f.write(buffer)


def main():
    tiles = load_bom()
    coarsest = min(z for _, _, z in tiles)
    finest = max(z for _, _, z in tiles)

    root_lo = np.array([1e30, 1e30, 1e30])
    root_hi = np.array([-1e30, -1e30, -1e30])
    for lo, hi in tiles.values():
        root_lo = np.minimum(root_lo, lo)
        root_hi = np.maximum(root_hi, hi)

    subtree_dir = os.path.join(OUT_DIR, "subtrees")
    os.makedirs(subtree_dir, exist_ok=True)

    subtree_tiles = {}
    for (tx, ty, z) in tiles:
        if z < coarsest + SUBTREE_LEVELS:
            key = (z - coarsest, tx >> (finest - z), ty >> (finest - z))
            if key not in subtree_tiles:
                subtree_tiles[key] = set()
            subtree_tiles[key].add((tx, ty, z))

    for (sl, sx, sy), tile_coords in subtree_tiles.items():
        available = [(tx, ty, sl + coarsest) in tile_coords
                     for tx in range(sx * 2**SUBTREE_LEVELS, (sx + 1) * 2**SUBTREE_LEVELS)
                     for ty in range(sy * 2**SUBTREE_LEVELS, (sy + 1) * 2**SUBTREE_LEVELS)]
        available += [False] * (5 - len(available))
        path = os.path.join(subtree_dir, "{}.{}.{}.subtree".format(sl, sx, sy))
        write_subtree(path, available)

    tileset = {
        "asset": {"version": "1.1"},
        "geometricError": geometric_error(coarsest - 1),
        "root": {
            "boundingVolume": {"box": box(root_lo, root_hi)},
            "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
                         ORIGIN[0], ORIGIN[1], ORIGIN[2], 1],
            "geometricError": geometric_error(coarsest),
            "refine": "REPLACE",
            "implicitTiling": {
                "subdivisionScheme": "QUADTREE",
                "subtreeLevels": SUBTREE_LEVELS,
                "availableLevels": finest - coarsest + SUBTREE_LEVELS,
                "subtrees": {"uri": f"subtrees/{{level}}.{{x}}.{{y}}.subtree"},
            },
            "content": {"uri": f"tile.{{x}}.{{y}}.{{level}}.glb"},
        },
    }
    with open(os.path.join(OUT_DIR, "tileset.json"), "w") as f:
        json.dump(tileset, f)
    print(f"wrote implicit tileset for {len(tiles)} tiles (levels {coarsest}..{finest})")


if __name__ == "__main__":
    main()
