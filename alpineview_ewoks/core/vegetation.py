"""Vegetation build step: per-tree crown meshes from LiDAR vegetation points.

Reads the cell LAZ, segments individual tree crowns on a canopy height model
(local maxima + watershed), reconstructs each crown as a convex hull, and
writes one Draco mesh per 250 m LOD-2 sub-tile:
<out_dir>/tile.{tx}.{ty}.2.veg.drc — vertices in km relative to the 1 km cell
origin (x=east, y=north, z=absolute altitude), same convention as terrain tiles.
"""

from __future__ import annotations

import io
import logging
from pathlib import Path

import DracoPy
import laspy
import numpy as np
import open3d as o3d
import requests
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree
from skimage.feature import peak_local_max
from skimage.segmentation import watershed

_REPO = Path(__file__).resolve().parents[2]
DEFAULT_OUT = str(_REPO / "webapp" / "public" / "vegetation")

VEG_CLASSES = (5,)
GROUND_CLASS = 2
LOD_Z = 2
TILE_SIZE_M = 250.0
CELL_SIZE_M = 1000.0
TILES_PER_SIDE = 4
QUANT_BITS = 14

MIN_HEIGHT_ABOVE_GROUND = 1.0
CHM_RESOLUTION_M = 0.5
CHM_SMOOTH_SIGMA = 1.0
TREETOP_MIN_DISTANCE = 3
DEFAULT_MIN_TREE_HEIGHT = 2.0
DEFAULT_MIN_TREE_POINTS = 20
TAUBIN_ITERATIONS = 5
TRUNK_RADIUS_M = 0.5
TRUNK_RESOLUTION = 8

SATELLITE_SIZE = 500  # px per side of the 1 km cell ortho fetch (2 m/px)
_WMS_URL = "https://data.geopf.fr/wms-r"
_ORTHO_LAYER = "HR.ORTHOIMAGERY.ORTHOPHOTOS"
BRIGHT_COEFF = 1.2
GREEN_MARGIN = 1.1  # G must exceed R and B by this factor to count as vegetation
TRUNK_COLOR = np.array([66, 40, 24], dtype=np.uint8)  # dark brown, bark
DEFAULT_GREEN = np.array([36, 87, 25], dtype=np.uint8)  # fallback, no ortho match

log = logging.getLogger("build.vegetation")


def class_points(las: laspy.LasData, classes: tuple[int, ...]) -> np.ndarray:
    mask = np.isin(np.asarray(las.classification), classes)
    return np.column_stack(
        [np.asarray(las.x)[mask], np.asarray(las.y)[mask], np.asarray(las.z)[mask]]
    )


def fetch_satellite(
    cell_origin: np.ndarray, size: int = SATELLITE_SIZE
) -> np.ndarray | None:
    """North-up (size, size, 3) uint8 IGN ortho covering the 1 km cell, or None on failure."""
    minx, miny = cell_origin
    maxx, maxy = minx + CELL_SIZE_M, miny + CELL_SIZE_M
    params = {
        "SERVICE": "WMS",
        "VERSION": "1.3.0",
        "REQUEST": "GetMap",
        "LAYERS": _ORTHO_LAYER,
        "STYLES": "",
        "CRS": "EPSG:2154",
        "BBOX": f"{minx},{miny},{maxx},{maxy}",
        "WIDTH": size,
        "HEIGHT": size,
        "FORMAT": "image/jpeg",
    }
    try:
        resp = requests.get(_WMS_URL, params=params, timeout=60)
        resp.raise_for_status()
        return np.asarray(Image.open(io.BytesIO(resp.content)).convert("RGB"))
    except Exception:
        log.warning(
            "satellite fetch failed, falling back to default crown color", exc_info=True
        )
        return None


def green_pixel_tree(
    sat: np.ndarray | None, size: int = SATELLITE_SIZE
) -> tuple[cKDTree, np.ndarray] | None:
    """(KD-tree, colors) over cell-local xy of ortho pixels where green clearly dominates."""
    if sat is None:
        return None
    r, g, b = sat[..., 0].astype(int), sat[..., 1].astype(int), sat[..., 2].astype(int)
    mask = (g >= GREEN_MARGIN * r) & (g >= GREEN_MARGIN * b)
    if not mask.any():
        return None
    rows, cols = np.nonzero(mask)
    resolution = CELL_SIZE_M / size
    xy = np.column_stack([cols * resolution, CELL_SIZE_M - rows * resolution])
    return cKDTree(xy), sat[rows, cols]


def crown_color(
    pixel_tree: tuple[cKDTree, np.ndarray] | None, centroid_local: np.ndarray
) -> np.ndarray:
    """Nearest green-dominant ortho pixel's color, brightened; DEFAULT_GREEN if none."""
    if pixel_tree is None:
        return DEFAULT_GREEN
    tree, colors = pixel_tree
    _, i = tree.query(centroid_local)
    color = colors[i].astype(np.float32) * BRIGHT_COEFF
    return np.clip(color, 0, 255).astype(np.uint8)


def height_above_ground(xyz: np.ndarray, ground_xyz: np.ndarray) -> np.ndarray:
    """Height of each point above the nearest (in XY) ground-class point."""
    _, nearest = cKDTree(ground_xyz[:, :2]).query(xyz[:, :2])
    return xyz[:, 2] - ground_xyz[nearest, 2]


def segment_tree_crowns(
    xy: np.ndarray,
    heights: np.ndarray,
    min_tree_height: float,
    resolution: float = CHM_RESOLUTION_M,
    smooth_sigma: float = CHM_SMOOTH_SIGMA,
    min_distance: int = TREETOP_MIN_DISTANCE,
) -> tuple[np.ndarray, int]:
    """Per-point crown id (0 = outside any crown) and crown count, via a
    canopy height model: treetops as local maxima, crowns grown by watershed."""
    origin = xy.min(axis=0)
    col = ((xy[:, 0] - origin[0]) / resolution).astype(int)
    row = ((xy[:, 1] - origin[1]) / resolution).astype(int)
    chm = np.zeros((row.max() + 1, col.max() + 1))
    np.maximum.at(chm, (row, col), heights)

    chm_smooth = ndimage.gaussian_filter(chm, sigma=smooth_sigma)
    treetops = peak_local_max(
        chm_smooth, min_distance=min_distance, threshold_abs=min_tree_height
    )
    markers = np.zeros(chm.shape, dtype=int)
    markers[tuple(treetops.T)] = np.arange(1, len(treetops) + 1)
    labels_grid = watershed(-chm_smooth, markers, mask=chm > 0)
    return labels_grid[row, col], int(labels_grid.max())


def convex_hull_mesh(xyz: np.ndarray) -> o3d.geometry.TriangleMesh:
    """Crown mesh as the convex hull of its points (fast, qhull-based)."""
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(xyz)
    mesh, _ = pcd.compute_convex_hull()
    return mesh


def postprocess_mesh(
    mesh: o3d.geometry.TriangleMesh, taubin_iterations: int = TAUBIN_ITERATIONS
) -> o3d.geometry.TriangleMesh:
    mesh.remove_degenerate_triangles()
    mesh.remove_duplicated_triangles()
    mesh.remove_duplicated_vertices()
    mesh.remove_non_manifold_edges()
    mesh.remove_unreferenced_vertices()
    return mesh


def encode_mesh(
    vertices_local_m: np.ndarray, faces: np.ndarray, colors: np.ndarray
) -> bytes:
    """Draco mesh, vertices converted to km (terrain-tile convention)."""
    return DracoPy.encode(
        (vertices_local_m / 1000.0).astype(np.float32),
        faces=faces.astype(np.uint32),
        colors=colors.astype(np.uint8),
        quantization_bits=QUANT_BITS,
        compression_level=10,
    )


def trunk_mesh(
    tree: np.ndarray, heights: np.ndarray
) -> o3d.geometry.TriangleMesh | None:
    """Cylinder from the ground up to the crown centre (le tronc)."""
    ground_z = float((tree[:, 2] - heights).mean())
    top_z = float(tree[:, 2].mean())
    height = top_z - ground_z
    if height <= 0:
        return None
    cyl = o3d.geometry.TriangleMesh.create_cylinder(
        TRUNK_RADIUS_M, height, resolution=TRUNK_RESOLUTION, split=1
    )
    cx, cy = tree[:, :2].mean(axis=0)
    cyl.translate((float(cx), float(cy), ground_z + height / 2))
    return cyl


def vegetation_outputs(
    x_km: int, y_km: int, out_dir: str = DEFAULT_OUT
) -> list[str]:
    """Existing .veg.drc tile paths for cell (x_km, y_km); empty if none."""
    y0 = y_km - 1
    paths = []
    for i in range(TILES_PER_SIDE):
        for j in range(TILES_PER_SIDE):
            tx = x_km * TILES_PER_SIDE + i
            ty = y0 * TILES_PER_SIDE + j
            path = Path(out_dir) / f"tile.{tx}.{ty}.{LOD_Z}.veg.drc"
            if path.exists():
                paths.append(str(path))
    return paths


def write_empty_tiles(x_km: int, y_km: int, out_dir: str = DEFAULT_OUT) -> list[str]:
    """Mark cell (x_km, y_km) as built with no trees: 16 zero-byte .veg.drc.

    The webapp rejects them at the DRACO magic-bytes check and silently skips
    them, while vegetation_outputs() sees the cell as done.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    y0 = y_km - 1
    paths = []
    for i in range(TILES_PER_SIDE):
        for j in range(TILES_PER_SIDE):
            tx = x_km * TILES_PER_SIDE + i
            ty = y0 * TILES_PER_SIDE + j
            path = out / f"tile.{tx}.{ty}.{LOD_Z}.veg.drc"
            path.touch()
            paths.append(str(path))
    return paths


def build_vegetation(
    laz_path: str,
    out_dir: str = DEFAULT_OUT,
    min_tree_height: float = DEFAULT_MIN_TREE_HEIGHT,
    min_tree_points: int = DEFAULT_MIN_TREE_POINTS,
) -> list[str]:
    """Segment and mesh a cell's trees → LOD-2 .veg.drc tile paths.

    A cell without exploitable vegetation still succeeds: it gets zero-byte
    .veg.drc tiles so later runs see it as built.
    """
    name = Path(laz_path).name
    cell_x_km, cell_y_km = (int(p) for p in name.split("_")[2:4])

    las = laspy.read(str(laz_path))
    veg = class_points(las, VEG_CLASSES)
    ground = class_points(las, (GROUND_CLASS,))
    if len(veg) == 0 or len(ground) == 0:
        log.info("%s: no vegetation or no ground points", name)
        return write_empty_tiles(cell_x_km, cell_y_km, out_dir)
    log.info("%s: %d veg points, %d ground points", name, len(veg), len(ground))

    heights = height_above_ground(veg, ground)
    keep = heights >= MIN_HEIGHT_ABOVE_GROUND
    veg, heights = veg[keep], heights[keep]
    if len(veg) == 0:
        log.info("%s: nothing above %.1f m", name, MIN_HEIGHT_ABOVE_GROUND)
        return write_empty_tiles(cell_x_km, cell_y_km, out_dir)

    # Local metres relative to the 1 km cell origin: needed for Draco (float32)
    # and keeps every later step in small, well-conditioned coordinates.
    cell_origin = np.floor(np.median(veg[:, :2], axis=0) / CELL_SIZE_M) * CELL_SIZE_M
    local = veg - np.array([cell_origin[0], cell_origin[1], 0.0])

    pixel_tree = green_pixel_tree(fetch_satellite(cell_origin))

    tree_id, n_crowns = segment_tree_crowns(local[:, :2], heights, min_tree_height)
    log.info("%s: %d crowns detected", name, n_crowns)

    # Group point indices by crown id in one sorted pass instead of scanning
    # the whole array per crown (O(n log n) vs O(n_crowns * n_points)).
    order = np.argsort(tree_id, kind="stable")
    sorted_ids = tree_id[order]
    starts = np.searchsorted(sorted_ids, np.arange(1, n_crowns + 1))
    ends = np.searchsorted(sorted_ids, np.arange(1, n_crowns + 1), side="right")

    tile_meshes: dict[tuple[int, int], o3d.geometry.TriangleMesh] = {}
    kept = 0
    for tid in range(1, n_crowns + 1):
        idx = order[starts[tid - 1] : ends[tid - 1]]
        if len(idx) < min_tree_points or heights[idx].max() < min_tree_height:
            continue
        tree = local[idx]
        bbox_min, bbox_max = tree.min(axis=0), tree.max(axis=0)
        bbox_height = bbox_max[2] - bbox_min[2]
        bbox_width = max(bbox_max[0] - bbox_min[0], bbox_max[1] - bbox_min[1])
        if bbox_height <= bbox_width:
            continue
        mesh = convex_hull_mesh(tree)
        if len(mesh.triangles) == 0:
            continue
        centroid = tree[:, :2].mean(axis=0)
        crown_rgb = crown_color(pixel_tree, centroid)
        mesh.vertex_colors = o3d.utility.Vector3dVector(
            np.tile(crown_rgb / 255.0, (len(mesh.vertices), 1))
        )
        trunk = trunk_mesh(tree, heights[idx])
        if trunk is not None:
            trunk.vertex_colors = o3d.utility.Vector3dVector(
                np.tile(TRUNK_COLOR / 255.0, (len(trunk.vertices), 1))
            )
            mesh += trunk
        i = int(np.clip(centroid[0] // TILE_SIZE_M, 0, TILES_PER_SIDE - 1))
        j = int(np.clip(centroid[1] // TILE_SIZE_M, 0, TILES_PER_SIDE - 1))
        tile_meshes.setdefault((i, j), o3d.geometry.TriangleMesh())
        tile_meshes[(i, j)] += mesh
        kept += 1
    log.info("%s: %d/%d crowns reconstructed", name, kept, n_crowns)

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    origin_x_km = int(cell_origin[0] // CELL_SIZE_M)
    origin_y_km = int(cell_origin[1] // CELL_SIZE_M)
    paths = []
    for (i, j), mesh in sorted(tile_meshes.items()):
        mesh = postprocess_mesh(mesh)
        vertices = np.asarray(mesh.vertices)
        faces = np.asarray(mesh.triangles)
        colors = np.asarray(mesh.vertex_colors) * 255.0
        if len(faces) == 0:
            continue
        tx = origin_x_km * TILES_PER_SIDE + i
        ty = origin_y_km * TILES_PER_SIDE + j
        path = out / f"tile.{tx}.{ty}.{LOD_Z}.veg.drc"
        path.write_bytes(encode_mesh(vertices, faces, colors))
        paths.append(str(path))
    if not paths:
        log.info("%s: no crowns reconstructed", name)
        return write_empty_tiles(cell_x_km, cell_y_km, out_dir)
    log.info("%s: wrote %d LOD-%d tiles", name, len(paths), LOD_Z)
    return paths
