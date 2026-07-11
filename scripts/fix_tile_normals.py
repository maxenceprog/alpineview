#!/usr/bin/env python3
"""Bake the client's Y-up rotation into terrain .drc tiles.

webapp/src/tileManager.js currently does this on the main thread for every
tile, on every load (loadDraco()):

    geometry.rotateX(-Math.PI / 2)   # LAZ Z-up -> three.js Y-up

Pure per-vertex math with no dependency on the live scene or the layer
applied to the tile — baking it into the file at build time removes that
work from the client for free (verified: re-encoding at the same
quantization/compression settings reproduces the original file size almost
exactly, no bandwidth cost).

Vertex normals are deliberately NOT baked in here. DracoPy's `encode(...,
normals=...)` does not apply Draco's octahedral normal quantization the C++
encoder uses — regardless of `quantization_bits` the normal attribute comes
out close to raw float, ballooning file size ~4-5x (measured: a 194 KB tile
grew to 740-895 KB). Baking normals belongs in alpineview_builder (the C++
tool, which has proper access to Draco's per-attribute-type quantization),
or normal computation should move to a client-side Web Worker instead —
either removes the main-thread cost without this bandwidth regression.

Usage:
    python scripts/fix_tile_normals.py [tiles_dir] [--dry-run] [--limit N]

Defaults to webapp/public/tiles. Rewrites each .drc file in place (atomic
replace via a .tmp sibling). Point clouds (no faces — shouldn't occur in
this directory) are skipped, not rewritten.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import DracoPy
import numpy as np

# Matches the original encoder closely enough that re-encoding at these
# settings reproduces ~the same file size (measured on existing tiles).
QUANTIZATION_BITS = 14
COMPRESSION_LEVEL = 1


def rotate_x_minus_90(points: np.ndarray) -> np.ndarray:
    """(x, y, z) -> (x, z, -y): closed form of three.js `geometry.rotateX(-Math.PI / 2)`."""
    out = np.empty_like(points)
    out[:, 0] = points[:, 0]
    out[:, 1] = points[:, 2]
    out[:, 2] = -points[:, 1]
    return out


def fix_tile(path: Path, *, dry_run: bool) -> bool:
    raw = path.read_bytes()
    mesh = DracoPy.decode(raw)
    if mesh.faces is None:
        print(f"skip (point cloud, no faces): {path}")
        return False

    points = rotate_x_minus_90(mesh.points.astype(np.float64))

    encoded = DracoPy.encode(
        points,
        faces=mesh.faces,
        quantization_bits=QUANTIZATION_BITS,
        compression_level=COMPRESSION_LEVEL,
    )

    if dry_run:
        print(f"[dry-run] {path.name}: {len(raw)} -> {len(encoded)} bytes")
        return True

    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(encoded)
    tmp.replace(path)
    print(f"fixed {path.name}: {len(raw)} -> {len(encoded)} bytes")
    return True


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tiles_dir", nargs="?", default="webapp/public/tiles")
    ap.add_argument("--dry-run", action="store_true", help="report sizes without writing")
    ap.add_argument("--limit", type=int, default=None, help="process at most N files (testing)")
    args = ap.parse_args()

    tiles_dir = Path(args.tiles_dir)
    files = sorted(tiles_dir.glob("*.drc"))
    if not files:
        print(f"no .drc files found in {tiles_dir}", file=sys.stderr)
        sys.exit(1)
    if args.limit:
        files = files[: args.limit]

    fixed = 0
    for f in files:
        try:
            if fix_tile(f, dry_run=args.dry_run):
                fixed += 1
        except Exception as e:
            print(f"ERROR {f}: {e}", file=sys.stderr)

    print(f"\n{fixed}/{len(files)} tiles processed{' (dry run)' if args.dry_run else ''}")


if __name__ == "__main__":
    main()
