#!/usr/bin/env python3
"""View an alpineview_builder points.ply (position + normal), colored by a
normal component. SPACE cycles the axis (x/y/z), R toggles the matching
cached LiDAR HD raw points (green) on top.

    python scripts/view_points_ply.py webapp/public/tiles/0955_6435.points.ply
"""

import re
import sys
from pathlib import Path

import laspy
import numpy as np
import open3d as o3d

sys.path.insert(0, str(Path(__file__).parent.parent))

from alpineview_ewoks.core.tiles import (  # noqa: E402
    DEFAULT_CACHE_DIR,
    DEFAULT_RESOLUTION,
    download_cell_laz,
)

CACHE_DIR = DEFAULT_CACHE_DIR
RESOLUTION = DEFAULT_RESOLUTION
DOWNLOAD_FROM_IGN = True
AXIS_NAMES = "xyz"
GROUND_CLASS = 2

ply_path = Path(sys.argv[1])
x0, y0 = (int(v) for v in re.search(r"(\d{4})_(\d{4})", ply_path.stem).groups())

transf_path = ply_path.with_name(ply_path.stem.removesuffix(".points") + ".transf")
transf_lines = transf_path.read_text().splitlines()
scale = float(transf_lines[0].split()[1])
shift = np.array([float(v) for v in transf_lines[1].split()[1:4]])

pcd = o3d.io.read_point_cloud(str(ply_path))
normals = np.asarray(pcd.normals)

axis = [2]


def recolor():
    t = np.clip((normals[:, axis[0]] + 1) / 2, 0, 1)
    colors = np.stack([t, np.zeros_like(t), 1 - t], axis=1)
    pcd.colors = o3d.utility.Vector3dVector(colors)


laz_pc = None
laz_added = [False]


def load_laz():
    global laz_pc
    if laz_pc is None:
        laz_path = download_cell_laz(
            x0,
            y0,
            CACHE_DIR,
            resolution=RESOLUTION,
            download_from_ign=DOWNLOAD_FROM_IGN,
        )
        las = laspy.read(laz_path)
        pts_m = np.stack(
            [np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)], axis=1
        )
        pts_m = pts_m[np.asarray(las.classification) == GROUND_CLASS]
        origin_m = np.array([x0 * 1000.0, (y0 - 1) * 1000.0, 0.0])
        pts = (pts_m - origin_m) * 1e-3 * scale + shift
        laz_pc = o3d.geometry.PointCloud()
        laz_pc.points = o3d.utility.Vector3dVector(pts)
        laz_pc.paint_uniform_color([0.0, 1.0, 0.0])
    return laz_pc


def key_space(vis):
    axis[0] = (axis[0] + 1) % 3
    recolor()
    vis.update_geometry(pcd)
    print(f"color by normal.{AXIS_NAMES[axis[0]]}")
    return False


def key_r(vis):
    cloud = load_laz()
    if laz_added[0]:
        vis.remove_geometry(cloud, reset_bounding_box=False)
    else:
        vis.add_geometry(cloud, reset_bounding_box=False)
    laz_added[0] = not laz_added[0]
    return False


recolor()
vis = o3d.visualization.VisualizerWithKeyCallback()
vis.create_window()
vis.add_geometry(pcd)
vis.register_key_callback(ord(" "), key_space)
vis.register_key_callback(ord("R"), key_r)
vis.run()
vis.destroy_window()
