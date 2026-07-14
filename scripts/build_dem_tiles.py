#!/usr/bin/env python3
"""Build DEM elevation tiles for the iTowns app from the LOD 0 terrain meshes.

The iTowns app has no IGN elevation layer anymore — the quadtree planes are
displaced with our own DEM so that depth picking, SSE subdivision and OBB
culling follow the real lidar surface. Tiles are raw float32 (little-endian)
256x256 grids in meters, north row first — exactly what iTowns'
Fetcher.textureFloat expects for `image/x-bil;bits=32` — named on the view's
TMS grid (EPSG:2154 square 256000..1280000 / 5952000..6976000, level z has
2^z tiles, row 0 at north):

    webapp/public/dem/{z}/{col}/{row}.bil

Level 10 + z is rasterized from the tile.{tx}.{ty}.{z}.drc meshes by casting
vertical rays with Open3D; misses get NO_DATA (-99999). --source-z selects
which mesh LODs to rasterize (default 0 1 2, i.e. levels 10, 11 and 12 — the
view's maxSubdivisionLevel). Coarser levels below 10 are built by mosaicking
and 2x2 downsampling children (ignoring NO_DATA).

Usage:
    python scripts/build_dem_tiles.py [tiles_dir] [--out DIR] [--source-z 0 1 2]
                                      [--limit N] [--workers N]
"""

from __future__ import annotations

import argparse
import multiprocessing
import os
import re
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import DracoPy
import numpy as np
import open3d as o3d

DIM = 256
NO_DATA = np.float32(-99999)
VIEW_WEST_KM = 256
VIEW_NORTH_KM = 6976
BASE_LEVEL = 10  # 1 km tiles on the view grid
RAY_ORIGIN_Z_KM = 10.0
SUPERSAMPLE = 4  # rays per pixel side; the pixel keeps the highest hit


def lod_re(z: int) -> re.Pattern:
    return re.compile(rf"^tile\.(\d+)\.(\d+)\.{z}\.drc$")


def rasterize_tile(
    path: Path, out_path: Path, tx: int, ty: int, z: int, supersample: int = SUPERSAMPLE
) -> str:
    mesh = DracoPy.decode(path.read_bytes())
    if mesh.faces is None or len(mesh.faces) == 0:
        return f"skip {path.name}: no faces"

    tmesh = o3d.t.geometry.TriangleMesh()
    tmesh.vertex.positions = o3d.core.Tensor(mesh.points.astype(np.float32))
    tmesh.triangle.indices = o3d.core.Tensor(mesh.faces.astype(np.int64))
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(tmesh)

    # Vertices are in km relative to the enclosing 1 km cell, so a z>0 tile
    # covers only a 1/2^z sub-square of it, offset from that cell's corner.
    scale = 2**z
    side = 1.0 / scale
    x0 = tx / scale - tx // scale
    y0 = ty / scale - ty // scale

    # One ray per pixel would sample the surface only at pixel centers and miss
    # any summit that falls between them. Cast a supersample^2 grid inside each
    # pixel and keep the highest hit, so a peak is never dropped, only rounded
    # up to its pixel.
    dim = DIM * supersample
    step = side / dim
    xs = x0 + (np.arange(dim) + 0.5) * step
    ys = y0 + side - (np.arange(dim) + 0.5) * step
    gx, gy = np.meshgrid(xs, ys)
    rays = np.zeros((dim * dim, 6), dtype=np.float32)
    rays[:, 0] = gx.ravel()
    rays[:, 1] = gy.ravel()
    rays[:, 2] = RAY_ORIGIN_Z_KM
    rays[:, 5] = -1.0
    t_hit = scene.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy()

    fine = ((RAY_ORIGIN_Z_KM - t_hit) * 1000.0).astype(np.float32)
    fine[~np.isfinite(t_hit)] = -np.inf
    fine = fine.reshape(dim, dim)

    blocks = fine.reshape(DIM, supersample, DIM, supersample).transpose(0, 2, 1, 3)
    elev = blocks.reshape(DIM, DIM, supersample**2).max(axis=2)
    elev = np.where(np.isfinite(elev), elev, NO_DATA).astype(np.float32)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_name(out_path.name + ".tmp")
    tmp.write_bytes(elev.tobytes())
    tmp.replace(out_path)
    covered = 100.0 * np.count_nonzero(elev != NO_DATA) / (DIM * DIM)
    return f"{out_path.relative_to(out_path.parents[2])}: {covered:.0f}% covered"


def downsample(
    children: dict[tuple[int, int], np.ndarray], reduce: str = "max"
) -> np.ndarray:
    """Mosaic 4 children into their parent, 2x2 reducing each block.

    `max` keeps summits: averaging shaves a bit off every peak at every level of
    the pyramid, and since these tiles drive depth picking (wheel zoom / smart
    travel) and OBB culling — never the rendering — a slightly too high terrain
    is the safe error. `mean` is the smoother, lower alternative.
    """
    parent = np.full((DIM, DIM), NO_DATA, dtype=np.float32)
    half = DIM // 2
    for (dc, dr), grid in children.items():
        blocks = (
            grid.reshape(half, 2, half, 2).transpose(0, 2, 1, 3).reshape(half, half, 4)
        )

        if reduce == "max":
            small = blocks.max(axis=2)
        else:
            small = blocks.mean(axis=2)

        small[small < 0] = 0

        parent[dr * half : (dr + 1) * half, dc * half : (dc + 1) * half] = small.astype(
            np.float32
        )
    return parent


def build_pyramid(out_dir: Path, reduce: str) -> None:
    print(f"building pyramid ({reduce})...")
    for z in range(BASE_LEVEL - 1, -1, -1):
        child_dir = out_dir / str(z + 1)
        groups: dict[tuple[int, int], dict[tuple[int, int], np.ndarray]] = {}
        for f in sorted(child_dir.glob("*/*.bil")):
            col, row = int(f.parent.name), int(f.stem)
            grid = np.frombuffer(f.read_bytes(), dtype=np.float32).reshape(DIM, DIM)
            groups.setdefault((col // 2, row // 2), {})[(col % 2, row % 2)] = grid
        for (col, row), children in sorted(groups.items()):
            out_path = out_dir / str(z) / str(col) / f"{row}.bil"
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(downsample(children, reduce).tobytes())
        print(f"level {z}: {len(groups)} tiles")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("tiles_dir", nargs="?", default="webapp/public/tiles")
    ap.add_argument("--out", default="webapp/public/dem")
    ap.add_argument(
        "--source-z",
        type=int,
        nargs="+",
        default=[0, 1, 2],
        help="mesh LODs to rasterize; level = 10 + z (default: 0 1 2)",
    )
    ap.add_argument(
        "--reduce",
        choices=("max", "mean"),
        default="max",
        help="how the pyramid reduces each 2x2 block (default: max, keeps summits)",
    )
    ap.add_argument(
        "--supersample",
        type=int,
        default=SUPERSAMPLE,
        help=f"rays per pixel side, max-reduced into the pixel (default: {SUPERSAMPLE})",
    )
    ap.add_argument(
        "--pyramid-only",
        action="store_true",
        help="rebuild levels below 10 from the existing tiles, skip rasterizing",
    )
    ap.add_argument(
        "--limit",
        type=int,
        default=None,
        help="rasterize at most N base tiles (testing)",
    )
    ap.add_argument(
        "--workers", type=int, default=os.cpu_count(), help="parallel processes"
    )
    args = ap.parse_args()

    tiles_dir = Path(args.tiles_dir)
    out_dir = Path(args.out)

    if args.pyramid_only:
        build_pyramid(out_dir, args.reduce)
        return

    jobs = []
    for z in args.source_z:
        level = BASE_LEVEL + z
        scale = 2**z
        pattern = lod_re(z)
        found = 0
        for f in sorted(tiles_dir.iterdir()):
            m = pattern.match(f.name)
            if not m:
                continue
            tx, ty = int(m.group(1)), int(m.group(2))
            col = tx - VIEW_WEST_KM * scale
            row = VIEW_NORTH_KM * scale - 1 - ty
            if not (0 <= col < 2**level and 0 <= row < 2**level):
                print(f"skip {f.name}: outside view extent", file=sys.stderr)
                continue
            jobs.append((f, out_dir / str(level) / str(col) / f"{row}.bil", tx, ty, z))
            found += 1
        print(f"LOD {z} -> level {level}: {found} tiles")
    if not jobs:
        print(f"no source tiles found in {tiles_dir}", file=sys.stderr)
        sys.exit(1)
    if args.limit:
        jobs = jobs[: args.limit]
    print(f"rasterizing {len(jobs)} tiles")

    failed = 0
    # spawn: open3d's threads deadlock in fork()ed children
    ctx = multiprocessing.get_context("spawn")
    with ProcessPoolExecutor(max_workers=args.workers, mp_context=ctx) as pool:
        futures = {pool.submit(rasterize_tile, *job): job[0] for job in jobs}
        for future in as_completed(futures):
            try:
                print(future.result(), flush=True)
            except Exception as e:
                print(f"ERROR {futures[future].name}: {e}", file=sys.stderr)
                failed += 1

    build_pyramid(out_dir, args.reduce)

    print(f"\ndone, {failed} base tiles failed")


if __name__ == "__main__":
    main()
