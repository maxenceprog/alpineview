#!/usr/bin/env python3
"""Rebuild the level 8/9/10 (z-2/z-1/z0) draco pyramid via PoissonRecon.

Source is SRC_DIR (level-10 / z0 tiles only, the pre-Poisson backup). Output
is OUT_DIR, written in place for all three levels.

Unit of work is one z-2 cell: the 4x4 group of z0 tiles it covers (level 8
tile side = 4 km, z0 side = 1 km). Per cell:

  1. Load the (up to) 16 z0 tiles present, compute per-vertex normals for
     each (PoissonRecon needs oriented normals), and merge all 16 into one
     combined point cloud spanning the full [0,4]x[0,4] km cell (each tile
     shifted by (tx%4, ty%4)*1km into the cell's frame -- the same offset
     math merging elsewhere uses, splitting's inverse).
  2. Write that single merged cloud to one input .ply, then run the
     PoissonRecon binary against it three times, at increasing octree depth
     (finer depth = more detail, since the whole 4x4 km cell is being
     resolved at once):
       depth 5 -> crop to the full [0,4]x[0,4] km cell (1 tile)  -> z-2
       depth 6 -> crop into a 2x2 grid of [0,2]x[0,2] km tiles   -> z-1
       depth 7 -> crop into a 4x4 grid of [0,1]x[0,1] km tiles   -> z0
     Each crop is re-localized to its own tile's [0, side] origin (Poisson
     closes the surface a little past the cell edge; the crop also trims
     that overhang) and re-encoded to .drc.

PoissonRecon crashing is isolated to its own OS process, so a plain
ProcessPoolExecutor over z-2 cells is enough -- no respawn/requeue needed.

    python scripts/retile_draco.py
"""

from __future__ import annotations

import multiprocessing
import os
import re
import subprocess
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

# Keeps the 8 concurrent open3d calls (compute_vertex_normals, crop) from
# oversubscribing the CPU. Must be set before the numeric libraries import.
os.environ.setdefault("OMP_NUM_THREADS", "1")

import DracoPy  # noqa: E402
import numpy as np  # noqa: E402
import open3d as o3d  # noqa: E402
from tqdm import tqdm  # noqa: E402

SRC_DIR = Path("webapp/public/tiles_")  # level-10 (z0) source tiles
OUT_DIR = Path("webapp/public/tiles")  # levels 8/9/10 written here in place

POISSONRECON_BIN = (
    "/home/ruyer/gitlab/ign/third-parties/PoissonRecon/Bin/Linux/PoissonRecon"
)
POISSON_SCALE = 1.1
POISSON_PARALLEL = 2  # "none" -- all concurrency is the outer process pool
WORKERS = 8

# depth -> (output z level, tiles per axis, tile side in km). The z-2 cell is
# 4 km per side, so side_km * grid_n == 4 for every depth.
DEPTH_LEVELS = {
    5: (-2, 1, 4.0),
    6: (-1, 2, 2.0),
    7: (0, 4, 1.0),
}

DRACO_QUANT_BITS = 14  # both match mesh_lod.cpp
DRACO_COMPRESSION = 1  # DracoPy level 1 == draco speed 9

LOD0_RE = re.compile(r"^tile\.(\d+)\.(\d+)\.0\.drc$")


def tile_path(root: Path, tx: int, ty: int, z: int) -> Path:
    return root / f"tile.{tx}.{ty}.{z}.drc"


def load_tile(path: Path) -> tuple[np.ndarray, np.ndarray] | None:
    if not path.is_file():
        return None
    mesh = DracoPy.decode(path.read_bytes())
    faces = np.asarray(mesh.faces)
    if faces.size == 0:
        return None
    return np.asarray(mesh.points, dtype=np.float32), faces.astype(np.int32)


def save_tile(path: Path, points: np.ndarray, faces: np.ndarray) -> int:
    buf = DracoPy.encode(
        points.astype(np.float32),
        faces.astype(np.int32),
        quantization_bits=DRACO_QUANT_BITS,
        compression_level=DRACO_COMPRESSION,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(buf)
    tmp.replace(path)
    return len(buf)


def list_z0_cells(src_dir: Path) -> list[tuple[int, int]]:
    """Every z-2 cell (cx, cy) with at least one z0 tile under it."""
    cells = set()
    for f in src_dir.iterdir():
        m = LOD0_RE.match(f.name)
        if m:
            tx, ty = int(m.group(1)), int(m.group(2))
            cells.add((tx // 4, ty // 4))
    return sorted(cells)


def load_and_normal(
    src_dir: Path, tx: int, ty: int
) -> tuple[np.ndarray, np.ndarray] | None:
    """Load one z0 tile and compute its per-vertex normals."""
    loaded = load_tile(tile_path(src_dir, tx, ty, 0))
    if loaded is None:
        return None
    points, faces = loaded
    mesh = o3d.geometry.TriangleMesh(
        o3d.utility.Vector3dVector(points.astype(np.float64)),
        o3d.utility.Vector3iVector(faces.astype(np.int32)),
    )
    mesh.compute_vertex_normals()
    return points, np.asarray(mesh.vertex_normals, dtype=np.float32)


def merge_group(
    tiles: list[tuple[int, int, np.ndarray, np.ndarray]], mask: int, child_km: float
) -> tuple[np.ndarray, np.ndarray]:
    """Concatenate (tx, ty, points, normals) tiles, each shifted into its
    parent's frame by (tx & mask, ty & mask) * child_km."""
    pts_list, normals_list = [], []
    for tx, ty, points, normals in tiles:
        shifted = points.copy()
        shifted[:, 0] += (tx & mask) * child_km
        shifted[:, 1] += (ty & mask) * child_km
        pts_list.append(shifted)
        normals_list.append(normals)
    return np.concatenate(pts_list), np.concatenate(normals_list)


def run_poisson_ply(
    in_ply: str, out_ply: str, depth: int
) -> "o3d.geometry.TriangleMesh":
    subprocess.run(
        [
            POISSONRECON_BIN,
            "--in",
            in_ply,
            "--out",
            out_ply,
            "--depth",
            str(depth),
            "--scale",
            str(POISSON_SCALE),
            "--parallel",
            str(POISSON_PARALLEL),
        ],
        check=True,
        capture_output=True,
    )
    return o3d.io.read_triangle_mesh(out_ply)


def crop_subtile(
    points: np.ndarray, faces: np.ndarray, ox: float, oy: float, side_km: float
) -> tuple[np.ndarray, np.ndarray] | None:
    """Cut the [ox, ox+side] x [oy, oy+side] km box out of (points, faces) and
    re-localize it to the subtile's own [0, side] origin.

    Plane-clips (not an AABB vertex-selection crop): a legacy
    TriangleMesh.crop keeps only triangles whose vertices are ALL inside the
    box and drops any triangle straddling the boundary whole, leaving a gap
    along every tile edge. clip_plane instead cuts straddling triangles
    exactly on the boundary, so adjacent tiles share identical edge geometry.
    """
    mesh = o3d.t.geometry.TriangleMesh()
    mesh.vertex.positions = o3d.core.Tensor(points.astype(np.float32))
    mesh.triangle.indices = o3d.core.Tensor(faces.astype(np.int32))
    planes = (
        ((ox, 0.0, 0.0), (1.0, 0.0, 0.0)),
        ((ox + side_km, 0.0, 0.0), (-1.0, 0.0, 0.0)),
        ((0.0, oy, 0.0), (0.0, 1.0, 0.0)),
        ((0.0, oy + side_km, 0.0), (0.0, -1.0, 0.0)),
    )
    for point, normal in planes:
        if mesh.is_empty():
            return None
        mesh = mesh.clip_plane(
            o3d.core.Tensor(point, o3d.core.float32),
            o3d.core.Tensor(normal, o3d.core.float32),
        )
    if mesh.is_empty() or "positions" not in mesh.vertex:
        return None
    out_faces = mesh.triangle.indices.numpy()
    if len(out_faces) == 0:
        return None
    out_pts = mesh.vertex.positions.numpy().copy()
    out_pts[:, 0] -= ox
    out_pts[:, 1] -= oy
    return out_pts, out_faces


def process_cell(cx: int, cy: int, src_dir: Path, out_dir: Path) -> str:
    """Rebuild levels 10/9/8 for one z-2 cell. Self-contained so a batch can
    map it over a pool."""
    tiles: list[tuple[int, int, np.ndarray, np.ndarray]] = []
    for j in range(4):
        for i in range(4):
            tx, ty = cx * 4 + i, cy * 4 + j
            data = load_and_normal(src_dir, tx, ty)
            if data is not None:
                tiles.append((tx, ty, *data))

    counts = {"z0": 0, "z-1": 0, "z-2": 0}
    if not tiles:
        return f"cell {cx}.{cy}: empty"

    points, normals = merge_group(tiles, 3, 1.0)

    with tempfile.TemporaryDirectory() as tmp:
        in_ply = os.path.join(tmp, "in.ply")
        pcd = o3d.geometry.PointCloud()
        pcd.points = o3d.utility.Vector3dVector(points.astype(np.float64))
        pcd.normals = o3d.utility.Vector3dVector(normals.astype(np.float64))
        o3d.io.write_point_cloud(in_ply, pcd)

        for depth, (z, grid_n, side_km) in DEPTH_LEVELS.items():
            out_ply = os.path.join(tmp, f"out_{depth}.ply")
            mesh = run_poisson_ply(in_ply, out_ply, depth)
            if mesh.is_empty():
                continue
            rec_pts = np.asarray(mesh.vertices, dtype=np.float32)
            rec_faces = np.asarray(mesh.triangles, dtype=np.int32)
            label = "z0" if z == 0 else f"z{z}"
            for j in range(grid_n):
                for i in range(grid_n):
                    result = crop_subtile(
                        rec_pts, rec_faces, i * side_km, j * side_km, side_km
                    )
                    if result is not None:
                        save_tile(
                            tile_path(out_dir, cx * grid_n + i, cy * grid_n + j, z),
                            *result,
                        )
                        counts[label] += 1

    return f"cell {cx}.{cy}: " + " ".join(f"{k}:{v}" for k, v in counts.items())


def main() -> None:
    cells = list_z0_cells(SRC_DIR)
    if not cells:
        print(f"no LOD 0 tiles found in {SRC_DIR}", file=sys.stderr)
        sys.exit(1)
    print(
        f"rebuilding {len(cells)} z-2 cells {SRC_DIR} -> {OUT_DIR} on {WORKERS} workers"
    )

    failed = 0
    ctx = multiprocessing.get_context("spawn")
    with ProcessPoolExecutor(max_workers=WORKERS, mp_context=ctx) as pool:
        futures = {
            pool.submit(process_cell, cx, cy, SRC_DIR, OUT_DIR): (cx, cy)
            for cx, cy in cells
        }
        for future in tqdm(as_completed(futures), total=len(cells), unit="cell"):
            cx, cy = futures[future]
            try:
                future.result()
            except Exception as e:
                tqdm.write(f"ERROR cell {cx}.{cy}: {e}", file=sys.stderr)
                failed += 1

    print(f"\ndone, {failed} cells failed")


if __name__ == "__main__":
    main()
