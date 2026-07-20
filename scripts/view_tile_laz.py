#!/usr/bin/env python3
"""Show a Draco terrain tile next to its cached LiDAR HD ground points (class 2).

    python scripts/view_tile_laz.py 955.6434.0
"""

import sys
from pathlib import Path

import DracoPy
import laspy
import numpy as np
import open3d as o3d

sys.path.insert(0, str(Path(__file__).parent.parent))

from alpineview_ewoks.core.tiles import (  # noqa: E402
    DEFAULT_CACHE_DIR,
    DEFAULT_RESOLUTION,
    download_cell_laz,
)

TILES_DIR = Path("webapp/public/tiles")
CACHE_DIR = DEFAULT_CACHE_DIR
RESOLUTION = DEFAULT_RESOLUTION
DOWNLOAD_FROM_IGN = True
GROUND_CLASS = 2

tx, ty, z = (int(a) for a in sys.argv[1].split("."))
ox, oy = tx // 2**z, ty // 2**z  # parent 1 km cell origin, LAZ NW-corner naming
x_km, y_km = ox, oy + 1

tile_path = TILES_DIR / f"tile.{tx}.{ty}.{z}.drc"
d = DracoPy.decode(tile_path.read_bytes())
mesh = o3d.geometry.TriangleMesh()
mesh.vertices = o3d.utility.Vector3dVector(np.asarray(d.points, np.float64))
mesh.triangles = o3d.utility.Vector3iVector(np.asarray(d.faces, np.int32))
mesh.compute_vertex_normals()
mesh.paint_uniform_color([0.6, 0.6, 0.6])

laz_path = download_cell_laz(
    x_km, y_km, CACHE_DIR, resolution=RESOLUTION, download_from_ign=DOWNLOAD_FROM_IGN
)
las = laspy.read(laz_path)
pts = np.stack([np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)], axis=1)
pts = pts[np.asarray(las.classification) == GROUND_CLASS]
pts /= 1000.0  # m -> km, tile frame
pts[:, 0] -= ox
pts[:, 1] -= oy

cloud = o3d.geometry.PointCloud()
cloud.points = o3d.utility.Vector3dVector(pts)
cloud.paint_uniform_color([1.0, 0.0, 0.0])

print(f"{tile_path.name}: {len(mesh.vertices)} verts, {len(pts)} ground points")
o3d.visualization.draw_geometries([mesh, cloud])
