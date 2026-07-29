#!/usr/bin/env python3
"""Build the coarse draco pyramid (z=-2, z=-1) directly from local RGE ALTI
5m ASC tiles, via PoissonRecon -- no dependency on any z=0 .drc tile existing.

Source is every `*.asc` file found (recursively) under DATA_DIR -- ESRI ASCII
grids, one per IGN department download, each covering its own 5km x 5km
square at 5m resolution (see data/RGEALTI_MNT_5M_ASC_LAMB93_IGN69_D005/*.asc).
Output is OUT_DIR, written in place for every level in DEPTH_LEVELS, same
convention as scripts/retile_draco.py: CELL_KM (4km, z=-2) is the unit of
work, and it also produces the four z=-1 (2km) sub-tiles inside it.

5km source tiles don't align to the 4km/2km output grid, so unlike
retile_draco.py (whose z=0 source tiles ARE the z=-2 cell, split evenly) this
indexes every .asc file's own extent first, then -- for each 4km cell that
any file overlaps -- gathers points from every file overlapping that cell
(+ MARGIN_KM), possibly several when a cell straddles a source-tile boundary.
Per cell:

  1. Parse each overlapping .asc file's header + grid once (cached per
     worker process -- LRU_CACHE_SIZE files -- since one 5km file is shared by
     several neighbouring 4km cells), turn it into oriented points (PoissonRecon
     needs normals: analytic heightfield gradient, normalize((-dz/dx, -dz/dy, 1))),
     crop to the cell + MARGIN_KM, and merge into one cloud in the cell's own
     [-MARGIN, CELL_KM + MARGIN] frame. The margin is why --scale is 1: Poisson
     sees real data past the cell edge instead of closing the surface there, so
     adjacent cells agree along their shared boundary; the crop in step 2 drops
     it again.
  2. Write that merged cloud to one input .ply, then run the PoissonRecon
     binary against it once per entry in DEPTH_LEVELS. Each output is cropped
     into the 2^(z - ROOT_Z) grid of tiles at that level, re-localized to its
     own tile's [0, side] origin, and re-encoded to .drc.

PoissonRecon crashing is isolated to its own OS process, so a plain
ProcessPoolExecutor over cells is enough -- no respawn/requeue needed.

    python scripts/build_coarse_from_rgealti.py
    python scripts/build_coarse_from_rgealti.py --limit 20   # try on 20 cells
"""

from __future__ import annotations

import argparse
import multiprocessing
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from functools import lru_cache
from pathlib import Path

import DracoPy  # noqa: E402
import numpy as np  # noqa: E402
import open3d as o3d  # noqa: E402
from tqdm import tqdm  # noqa: E402

DATA_DIR = Path("data")
OUT_DIR = Path("webapp/public/tiles")

POISSONRECON_BIN = "poissonrecon"
POISSON_SCALE = 1.0  # margin below already pads the reconstruction domain
POISSON_PARALLEL = 2  # "none" -- all concurrency is the outer process pool
WORKERS = 8

# Band of neighbouring-tile points kept around the cell, in km. Poisson sees
# real data past the cell edge instead of closing the surface there, so the
# boundary matches the neighbour's. Must be <= (5km source tile - CELL_KM)/2
# or a cell could need a file beyond the immediate neighbours (not checked for).
MARGIN_KM = 0.1

ROOT_Z = -2  # coarsest level built == the unit of work
CELL_KM = 4.0  # our convention: z=-2 is a 4km cell

# PoissonRecon octree depth -> output z level. Every z must be in
# [ROOT_Z, 0]; deeper octrees belong with the finer levels.
DEPTH_LEVELS = {
    6: -2,
    7: -1,
}

DRACO_QUANT_BITS = 14  # both match mesh_lod.cpp / retile_draco.py
DRACO_COMPRESSION = 1  # DracoPy level 1 == draco speed 9

ASC_CACHE_SIZE = 16  # parsed .asc grids kept in memory per worker process


def tile_path(root: Path, tx: int, ty: int, z: int) -> Path:
    return root / f"tile.{tx}.{ty}.{z}.drc"


def save_tile(path: Path, points: np.ndarray, faces: np.ndarray) -> int:
    buf = DracoPy.encode(
        points.astype(np.float32),
        faces.astype(np.int32),
        quantization_bits=DRACO_QUANT_BITS,
        compression_level=DRACO_COMPRESSION,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_bytes(buf)
    tmp.replace(path)
    return len(buf)


def parse_asc_header(path: Path) -> dict[str, float]:
    header = {}
    with open(path) as f:
        for _ in range(6):
            k, v = f.readline().split()
            header[k.lower()] = float(v)
    return header


def build_index(data_dir: Path) -> dict[Path, tuple[float, float, float]]:
    """path -> (west_km, south_km, side_km) for every .asc file under data_dir."""
    index = {}
    for path in sorted(data_dir.rglob("*.asc")):
        h = parse_asc_header(path)
        side_km = h["ncols"] * h["cellsize"] / 1000.0
        index[path] = (h["xllcorner"] / 1000.0, h["yllcorner"] / 1000.0, side_km)
    return index


def cells_from_index(
    index: dict[Path, tuple[float, float, float]],
) -> list[tuple[int, int]]:
    """Every CELL_KM cell (cx, cy) that at least one indexed .asc file overlaps."""
    cells = set()
    for west_km, south_km, side_km in index.values():
        cx0 = int(west_km // CELL_KM)
        cx1 = int((west_km + side_km - 1e-6) // CELL_KM)
        cy0 = int(south_km // CELL_KM)
        cy1 = int((south_km + side_km - 1e-6) // CELL_KM)
        for cx in range(cx0, cx1 + 1):
            for cy in range(cy0, cy1 + 1):
                cells.add((cx, cy))
    return sorted(cells)


@lru_cache(maxsize=ASC_CACHE_SIZE)
def load_asc_points(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """Parse one .asc file -> oriented (points_km, normals) in GLOBAL km
    coordinates, full resolution, NODATA dropped. Cached per worker process --
    a file can be shared by several neighbouring cells.

    ESRI ASCII grid convention: xllcorner/yllcorner is the lower-left CORNER
    of the lower-left cell (add half a cell to get that cell's center, which
    is the value's actual position); row 0 of the data is the north row.
    Verified against RGEALTI_FXX_0935_6415...: xllcorner=934997.5 -> first
    column center at exactly 935.000 km, matching the filename.
    """
    h = parse_asc_header(path)
    ncols, nrows = int(h["ncols"]), int(h["nrows"])
    cellsize_km = h["cellsize"] / 1000.0
    nodata = h["nodata_value"]
    west_km, south_km = h["xllcorner"] / 1000.0, h["yllcorner"] / 1000.0

    data = np.loadtxt(path, dtype=np.float32, skiprows=6)
    data[data == nodata] = np.nan
    gz = data / 1000.0  # metres -> km, matching the .drc convention

    # np.gradient defaults to unit spacing per axis; row increases southward
    # (row 0 = north), so d/dy = -d/d(row) / cellsize.
    dz_drow, dz_dcol = np.gradient(gz)
    dzdx = dz_dcol / cellsize_km
    dzdy = -dz_drow / cellsize_km
    normals = np.stack([-dzdx, -dzdy, np.ones_like(gz)], axis=-1)
    normals /= np.linalg.norm(normals, axis=-1, keepdims=True)

    rows, cols = np.indices((nrows, ncols))
    gx = west_km + (cols + 0.5) * cellsize_km
    gy = south_km + (nrows - 1 - rows + 0.5) * cellsize_km

    valid = np.isfinite(gz)
    points = np.stack([gx[valid], gy[valid], gz[valid]], axis=1).astype(np.float32)
    return points, normals[valid].astype(np.float32)


def points_for_cell(
    cx: int, cy: int, index: dict[Path, tuple[float, float, float]]
) -> tuple[np.ndarray, np.ndarray] | None:
    """Merge every .asc file overlapping cell (cx, cy) + MARGIN_KM into one
    oriented point cloud in the cell's own [-MARGIN, CELL_KM + MARGIN] frame."""
    lo, hi = -MARGIN_KM, CELL_KM + MARGIN_KM
    west_km, south_km = cx * CELL_KM, cy * CELL_KM

    pts_list, normals_list = [], []
    for path, (fwest, fsouth, fside) in index.items():
        if fwest + fside <= west_km + lo or fwest >= west_km + hi:
            continue
        if fsouth + fside <= south_km + lo or fsouth >= south_km + hi:
            continue
        points, normals = load_asc_points(path)
        local = points.copy()
        local[:, 0] -= west_km
        local[:, 1] -= south_km
        keep = (
            (local[:, 0] >= lo)
            & (local[:, 0] <= hi)
            & (local[:, 1] >= lo)
            & (local[:, 1] <= hi)
        )
        if not keep.any():
            continue
        pts_list.append(local[keep])
        normals_list.append(normals[keep])

    if not pts_list:
        return None
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


def process_cell(
    cx: int, cy: int, index: dict[Path, tuple[float, float, float]], out_dir: Path
) -> str:
    """Rebuild every DEPTH_LEVELS level for one cell. Self-contained so a
    batch can map it over a pool."""
    merged = points_for_cell(cx, cy, index)
    if merged is None:
        return f"cell {cx}.{cy}: empty"
    points, normals = merged

    counts = {z: 0 for z in DEPTH_LEVELS.values()}
    with tempfile.TemporaryDirectory() as tmp:
        in_ply = os.path.join(tmp, "in.ply")
        pcd = o3d.geometry.PointCloud()
        pcd.points = o3d.utility.Vector3dVector(points.astype(np.float64))
        pcd.normals = o3d.utility.Vector3dVector(normals.astype(np.float64))
        o3d.io.write_point_cloud(in_ply, pcd)

        for depth, z in sorted(DEPTH_LEVELS.items()):
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


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Process only the first N cells (for a quick try). Default: no limit.",
    )
    return p.parse_args()


def main() -> None:
    args = parse_args()

    index = build_index(DATA_DIR)
    if not index:
        print(f"no .asc files found under {DATA_DIR}", file=sys.stderr)
        sys.exit(1)

    cells = cells_from_index(index)
    if args.limit is not None:
        cells = cells[: args.limit]

    print(
        f"{len(index)} .asc files -> {len(cells)} z{ROOT_Z} cells "
        f"{DATA_DIR} -> {OUT_DIR} on {WORKERS} workers"
        + (f" (limited to {args.limit})" if args.limit is not None else "")
    )

    failed = 0
    ctx = multiprocessing.get_context("spawn")
    with ProcessPoolExecutor(max_workers=WORKERS, mp_context=ctx) as pool:
        futures = {
            pool.submit(process_cell, cx, cy, index, OUT_DIR): (cx, cy)
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
