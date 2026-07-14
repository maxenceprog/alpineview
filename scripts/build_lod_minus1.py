#!/usr/bin/env python3
"""Build a coarse terrain LOD by merging the 4 tiles of the LOD below it.

Each output tile merges the up-to-4 children of a 2x2 cell, one LOD finer:

    tile.{2px}.{2py}.{z}.drc .. tile.{2px+1}.{2py+1}.{z}.drc  ->  tile.{px}.{py}.{z-1}.drc

Vertex convention matches the existing .drc files (see CLAUDE.md): km,
x=east / y=north / z=up, relative to the tile's origin cell floor(tx / 2^z).
A level-z tile spans 2^-z km and its origin sits at tx * 2^-z km, so a child
(tx, ty) of parent (px, py) is offset by 2^-z * (tx - 2*px) km — that factor is
1 only for z=0 children; it doubles with every coarser level.

The merged mesh is decimated to 1/4 of its triangles with Open3D quadric
decimation. Seam vertices between the children are welded first (eps above
the 14-bit quantization step) so the internal seams can simplify too; outer
borders stay unwelded, same as every other tile boundary. The result is
re-encoded with Draco at the same settings as fix_tile_normals.py.

Usage:
    python scripts/build_lod_minus1.py [tiles_dir] [--source-z 0] [--force]
                                       [--limit N] [--workers N]
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import DracoPy
import numpy as np
import open3d as o3d

QUANTIZATION_BITS = 14
COMPRESSION_LEVEL = 1


def build_parent(
    px: int,
    py: int,
    child_size_km: float,
    children: list[tuple[int, int, Path]],
    out_path: Path,
) -> str:
    verts = []
    faces = []
    offset = 0
    for tx, ty, path in children:
        mesh = DracoPy.decode(path.read_bytes())
        if mesh.faces is None:
            continue
        pts = mesh.points.astype(np.float64)
        pts[:, 0] += child_size_km * (tx - 2 * px)
        pts[:, 1] += child_size_km * (ty - 2 * py)
        verts.append(pts)
        faces.append(mesh.faces.astype(np.int64) + offset)
        offset += len(pts)
    if not verts:
        return f"skip {out_path.name}: no mesh data"

    merged = o3d.geometry.TriangleMesh(
        o3d.utility.Vector3dVector(np.vstack(verts)),
        o3d.utility.Vector3iVector(np.vstack(faces)),
    )
    total = len(merged.triangles)

    simplified = merged.simplify_quadric_decimation(
        target_number_of_triangles=max(total // 4, 1)
    )

    simplified.remove_degenerate_triangles()
    simplified.remove_unreferenced_vertices()

    encoded = DracoPy.encode(
        np.asarray(simplified.vertices),
        faces=np.asarray(simplified.triangles).astype(np.uint32),
        quantization_bits=QUANTIZATION_BITS,
        compression_level=COMPRESSION_LEVEL,
    )
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    tmp.write_bytes(encoded)
    tmp.replace(out_path)
    return (
        f"{out_path.name}: {len(children)} children, "
        f"{total} -> {len(simplified.triangles)} tris, {len(encoded)} bytes"
    )


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("tiles_dir", nargs="?", default="webapp/public/tiles")
    ap.add_argument(
        "--source-z",
        type=int,
        default=0,
        help="LOD to merge from; output is source-z - 1 (default: 0)",
    )
    ap.add_argument(
        "--force", action="store_true", help="rebuild tiles whose output already exists"
    )
    ap.add_argument(
        "--limit",
        type=int,
        default=None,
        help="process at most N parent tiles (testing)",
    )
    ap.add_argument(
        "--workers", type=int, default=os.cpu_count(), help="parallel processes"
    )
    args = ap.parse_args()

    src_z = args.source_z
    dst_z = src_z - 1
    child_size_km = 2.0**-src_z
    child_re = re.compile(rf"^tile\.(\d+)\.(\d+)\.{src_z}\.drc$")

    tiles_dir = Path(args.tiles_dir)
    groups: dict[tuple[int, int], list[tuple[int, int, Path]]] = {}
    for f in sorted(tiles_dir.iterdir()):
        m = child_re.match(f.name)
        if m:
            tx, ty = int(m.group(1)), int(m.group(2))
            groups.setdefault((tx // 2, ty // 2), []).append((tx, ty, f))
    if not groups:
        print(f"no LOD {src_z} tiles found in {tiles_dir}", file=sys.stderr)
        sys.exit(1)

    jobs = []
    skipped = 0
    for (px, py), children in sorted(groups.items()):
        out_path = tiles_dir / f"tile.{px}.{py}.{dst_z}.drc"
        if out_path.exists() and not args.force:
            skipped += 1
            continue
        jobs.append((px, py, child_size_km, children, out_path))
    if args.limit:
        jobs = jobs[: args.limit]
    print(
        f"LOD {src_z} ({child_size_km:g} km) -> {dst_z}: {len(groups)} parent tiles, "
        f"{skipped} already built, {len(jobs)} to build"
    )

    done = 0
    failed = 0
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(build_parent, *job): job[4] for job in jobs}
        for future in as_completed(futures):
            try:
                print(future.result())
                done += 1
            except Exception as e:
                print(f"ERROR {futures[future].name}: {e}", file=sys.stderr)
                failed += 1
    print(f"\n{done}/{len(jobs)} built, {failed} failed")


if __name__ == "__main__":
    main()
