#!/usr/bin/env python3
"""Diagnose and clean a Draco terrain tile with Open3D.

Reports the defects a mesh can carry after vertex clustering + Draco 14-bit
quantization (which can collapse distinct vertices onto the same point), runs an
Open3D cleanup pipeline, and reports again. Optionally writes the cleaned tile
and PLYs for visual comparison (see scripts/view_tile.py).

Usage:
    python scripts/clean_tile.py 965 6430 0
    python scripts/clean_tile.py 965 6430 0 --write-ply /tmp/ecrins
    python scripts/clean_tile.py 965 6430 0 --out webapp/public/tiles
"""

from __future__ import annotations

import argparse
from pathlib import Path

import DracoPy
import numpy as np
import open3d as o3d

QUANTIZATION_BITS = 14
COMPRESSION_LEVEL = 1

# Draco quantizes positions over the tile's bbox: ~1 km / 2^14 ≈ 6 cm. Anything
# thinner than that is noise the encoder cannot even represent.
DEGENERATE_AREA_KM2 = 1e-12  # ~1 mm² — a triangle this thin is not geometry


def load(path: Path) -> o3d.geometry.TriangleMesh:
    m = DracoPy.decode(path.read_bytes())
    return o3d.geometry.TriangleMesh(
        o3d.utility.Vector3dVector(m.points.astype(np.float64)),
        o3d.utility.Vector3iVector(m.faces.astype(np.int32)),
    )


def triangle_areas(mesh: o3d.geometry.TriangleMesh) -> np.ndarray:
    v = np.asarray(mesh.vertices)
    f = np.asarray(mesh.triangles)
    if len(f) == 0:
        return np.zeros(0)
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    return 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)


def report(mesh: o3d.geometry.TriangleMesh, label: str) -> None:
    areas = triangle_areas(mesh)
    zero = int((areas == 0).sum())
    tiny = int(((areas > 0) & (areas < DEGENERATE_AREA_KM2)).sum())

    clusters, counts, _ = mesh.cluster_connected_triangles()
    counts = np.asarray(counts)
    islands = int((counts < 10).sum())

    print(f"\n=== {label}")
    print(f"  vertices              {len(mesh.vertices):8d}")
    print(f"  triangles             {len(mesh.triangles):8d}")
    print(f"  aires nulles          {zero:8d}")
    print(f"  aires < 1 mm2         {tiny:8d}")
    print(f"  vertices dupliques    {count_duplicate_vertices(mesh):8d}")
    print(f"  aretes non-manifold   {len(mesh.get_non_manifold_edges(allow_boundary_edges=True)):8d}")
    print(f"  vertices non-manifold {len(mesh.get_non_manifold_vertices()):8d}")
    print(f"  composantes           {len(counts):8d}  (dont {islands} de <10 tris)")
    print(f"  aire XY               {xy_area(mesh):8.4f} km2  (attendu ~1.0)")


def count_duplicate_vertices(mesh: o3d.geometry.TriangleMesh) -> int:
    v = np.asarray(mesh.vertices)
    return len(v) - len(np.unique(v, axis=0))


def xy_area(mesh: o3d.geometry.TriangleMesh) -> float:
    v = np.asarray(mesh.vertices)
    f = np.asarray(mesh.triangles)
    if len(f) == 0:
        return 0.0
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    cross = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
    return float(np.abs(cross).sum() / 2)


def clean(mesh: o3d.geometry.TriangleMesh, drop_islands: int) -> o3d.geometry.TriangleMesh:
    m = o3d.geometry.TriangleMesh(mesh)
    # Order matters: merging coincident vertices is what turns the collapsed
    # triangles into detectable degenerates (same index twice).
    m.remove_duplicated_vertices()
    m.remove_degenerate_triangles()
    m.remove_duplicated_triangles()
    m.remove_unreferenced_vertices()

    if drop_islands > 0:
        clusters, counts, _ = m.cluster_connected_triangles()
        counts = np.asarray(counts)
        small = counts[np.asarray(clusters)] < drop_islands
        m.remove_triangles_by_mask(small)
        m.remove_unreferenced_vertices()
    return m


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tx", type=int)
    ap.add_argument("ty", type=int)
    ap.add_argument("z", type=int, nargs="?", default=0)
    ap.add_argument("--tiles-dir", default="webapp/public/tiles")
    ap.add_argument(
        "--drop-islands",
        type=int,
        default=10,
        help="remove connected components smaller than N triangles (0 = keep all)",
    )
    ap.add_argument("--write-ply", metavar="PREFIX", help="write PREFIX.before.ply / PREFIX.after.ply")
    ap.add_argument("--out", metavar="DIR", help="re-encode the cleaned tile into DIR")
    args = ap.parse_args()

    src = Path(args.tiles_dir) / f"tile.{args.tx}.{args.ty}.{args.z}.drc"
    mesh = load(src)
    print(f"{src}  ({src.stat().st_size / 1024:.0f} Ko)")
    report(mesh, "AVANT")

    cleaned = clean(mesh, args.drop_islands)
    report(cleaned, "APRES")

    if args.write_ply:
        prefix = Path(args.write_ply)
        o3d.io.write_triangle_mesh(f"{prefix}.before.ply", mesh)
        o3d.io.write_triangle_mesh(f"{prefix}.after.ply", cleaned)
        print(f"\nPLY: {prefix}.before.ply / {prefix}.after.ply")

    if args.out:
        encoded = DracoPy.encode(
            np.asarray(cleaned.vertices),
            faces=np.asarray(cleaned.triangles).astype(np.uint32),
            quantization_bits=QUANTIZATION_BITS,
            compression_level=COMPRESSION_LEVEL,
        )
        dst = Path(args.out) / src.name
        dst.write_bytes(encoded)
        print(f"\necrit {dst} ({len(encoded) / 1024:.0f} Ko)")


if __name__ == "__main__":
    main()
