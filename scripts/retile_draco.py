#!/usr/bin/env python3
"""Rebuild the coarse draco pyramid (z < SRC_Z) via PoissonRecon.

Source is SRC_DIR (z=SRC_Z tiles only, the pre-Poisson backup). Output is
OUT_DIR, written in place for every level in DEPTH_LEVELS.

Unit of work is one ROOT_Z cell: the square group of source tiles it covers.
Per cell:

  1. Load the source tiles present -- the cell's own, plus the one-tile ring
     around it -- compute per-vertex normals for each (PoissonRecon needs
     oriented normals), and merge them into one combined point cloud in the
     cell's frame (each tile shifted by its signed index offset -- the same
     offset math merging elsewhere uses, splitting's inverse), clipped to the
     cell grown by MARGIN_KM. That margin is why --scale is 1: Poisson sees
     real data past the cell edge rather than closing the surface there, so
     adjacent cells agree along their shared boundary. The margin is dropped
     again by the crops in step 2.
  2. Write that merged cloud to one input .ply, then run the PoissonRecon
     binary against it once per entry in DEPTH_LEVELS, at increasing octree
     depth (finer depth = more detail, since the whole cell is resolved at
     once). Each output is cropped into the 2^(z - ROOT_Z) grid of tiles at
     that level, re-localized to its own tile's [0, side] origin (Poisson
     closes the surface a little past the cell edge; the crop also trims
     that overhang) and re-encoded to .drc.

PoissonRecon crashing is isolated to its own OS process, so a plain
ProcessPoolExecutor over cells is enough -- no respawn/requeue needed.

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

SRC_DIR = Path("webapp/public/tiles")
OUT_DIR = Path("webapp/public/tiles")

POISSONRECON_BIN = (
    "/home/ruyer/gitlab/ign/third-parties/PoissonRecon/Bin/Linux/PoissonRecon"
)
POISSON_SCALE = 1.0  # margin below already pads the reconstruction domain
POISSON_PARALLEL = 2  # "none" -- all concurrency is the outer process pool
WORKERS = 8

# Band of neighbouring-cell points kept around the cell, in km. Poisson sees
# real data past the cell edge instead of closing the surface there, so the
# boundary matches the neighbour's. Must be <= SRC_TILE_KM (only the one-tile
# ring around the cell is loaded).
MARGIN_KM = 0.25

FORCE = False  # False: skip levels whose output tiles are all already on disk

SRC_Z = 0  # source level, one tile per SRC_TILE_KM square
SRC_TILE_KM = 1.0
ROOT_Z = -2  # coarsest level rebuilt == the unit of work

# PoissonRecon octree depth -> output z level. Every z must be in
# [ROOT_Z, SRC_Z]; deeper octrees belong with the finer levels.
DEPTH_LEVELS = {
    5: -2,
    6: -1,
}

DRACO_QUANT_BITS = 14  # both match mesh_lod.cpp
DRACO_COMPRESSION = 1  # DracoPy level 1 == draco speed 9

CELL_TILES = 2 ** (SRC_Z - ROOT_Z)  # source tiles per axis in one cell
CELL_KM = SRC_TILE_KM * CELL_TILES

SRC_RE = re.compile(rf"^tile\.(\d+)\.(\d+)\.{SRC_Z}\.drc$")


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


def list_cells(src_dir: Path) -> list[tuple[int, int]]:
    """Every ROOT_Z cell (cx, cy) with at least one source tile under it."""
    cells = set()
    for f in src_dir.iterdir():
        m = SRC_RE.match(f.name)
        if m:
            tx, ty = int(m.group(1)), int(m.group(2))
            cells.add((tx // CELL_TILES, ty // CELL_TILES))
    return sorted(cells)


def load_and_normal(
    src_dir: Path, tx: int, ty: int
) -> tuple[np.ndarray, np.ndarray] | None:
    """Load one source tile and compute its per-vertex normals."""
    loaded = load_tile(tile_path(src_dir, tx, ty, SRC_Z))
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
    tiles: list[tuple[int, int, np.ndarray, np.ndarray]], cx: int, cy: int
) -> tuple[np.ndarray, np.ndarray]:
    """Concatenate (tx, ty, points, normals) source tiles into cell (cx, cy)'s
    frame, keeping only what falls inside the cell plus MARGIN_KM. Ring tiles
    land at a negative or >= CELL_TILES index, hence the signed offset."""
    lo, hi = -MARGIN_KM, CELL_KM + MARGIN_KM
    pts_list, normals_list = [], []
    for tx, ty, points, normals in tiles:
        shifted = points.copy()
        shifted[:, 0] += (tx - cx * CELL_TILES) * SRC_TILE_KM
        shifted[:, 1] += (ty - cy * CELL_TILES) * SRC_TILE_KM
        keep = (
            (shifted[:, 0] >= lo)
            & (shifted[:, 0] <= hi)
            & (shifted[:, 1] >= lo)
            & (shifted[:, 1] <= hi)
        )
        if not keep.any():
            continue
        pts_list.append(shifted[keep])
        normals_list.append(normals[keep])
    if not pts_list:
        return np.empty((0, 3), np.float32), np.empty((0, 3), np.float32)
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


def level_done(cx: int, cy: int, z: int, out_dir: Path) -> bool:
    """True if every tile level z covers for this cell is already on disk.
    A level whose reconstruction legitimately yielded no tile for some crop
    never looks done, so it is rebuilt -- conservative, but the alternative
    is a sidecar marker file."""
    grid_n = 2 ** (z - ROOT_Z)
    return all(
        tile_path(out_dir, cx * grid_n + i, cy * grid_n + j, z).is_file()
        for j in range(grid_n)
        for i in range(grid_n)
    )


def process_cell(cx: int, cy: int, src_dir: Path, out_dir: Path) -> str:
    """Rebuild every DEPTH_LEVELS level for one cell. Self-contained so a
    batch can map it over a pool."""
    levels = {
        depth: z
        for depth, z in DEPTH_LEVELS.items()
        if FORCE or not level_done(cx, cy, z, out_dir)
    }
    if not levels:
        return f"cell {cx}.{cy}: skipped"

    tiles: list[tuple[int, int, np.ndarray, np.ndarray]] = []
    inner = 0
    for j in range(-1, CELL_TILES + 1):
        for i in range(-1, CELL_TILES + 1):
            tx, ty = cx * CELL_TILES + i, cy * CELL_TILES + j
            data = load_and_normal(src_dir, tx, ty)
            if data is None:
                continue
            tiles.append((tx, ty, *data))
            if 0 <= i < CELL_TILES and 0 <= j < CELL_TILES:
                inner += 1

    if not inner:
        return f"cell {cx}.{cy}: empty"

    counts = {z: 0 for z in levels.values()}
    points, normals = merge_group(tiles, cx, cy)

    with tempfile.TemporaryDirectory() as tmp:
        in_ply = os.path.join(tmp, "in.ply")
        pcd = o3d.geometry.PointCloud()
        pcd.points = o3d.utility.Vector3dVector(points.astype(np.float64))
        pcd.normals = o3d.utility.Vector3dVector(normals.astype(np.float64))
        o3d.io.write_point_cloud(in_ply, pcd)

        for depth, z in sorted(levels.items()):
            grid_n = 2 ** (z - ROOT_Z)
            side_km = CELL_KM / grid_n
            out_ply = os.path.join(tmp, f"out_{depth}.ply")
            mesh = run_poisson_ply(in_ply, out_ply, depth)
            if mesh.is_empty():
                continue
            rec_pts = np.asarray(mesh.vertices, dtype=np.float32)
            rec_faces = np.asarray(mesh.triangles, dtype=np.int32)
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
                        counts[z] += 1

    return f"cell {cx}.{cy}: " + " ".join(
        f"z{z}:{n}" for z, n in sorted(counts.items())
    )


def main() -> None:
    cells = list_cells(SRC_DIR)
    if not cells:
        print(f"no z{SRC_Z} tiles found in {SRC_DIR}", file=sys.stderr)
        sys.exit(1)
    print(
        f"rebuilding {len(cells)} z{ROOT_Z} cells "
        f"{SRC_DIR} -> {OUT_DIR} on {WORKERS} workers"
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
