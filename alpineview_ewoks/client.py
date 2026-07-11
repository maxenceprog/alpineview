import os
from copy import copy

from ewoksjob.client import submit

os.environ["EWOKS_CONFIG_URI"] = "alpineview_ewoks.config"


GRAPH = {
    "graph": {
        "id": "build_tile",
        "label": "Build one terrain cell (tiles + cosia + vegetation + buildings)",
    },
    "nodes": [
        {
            "id": "download",
            "task_type": "class",
            "task_identifier": "alpineview_ewoks.tasks.download_tile.DownloadTile",
        },
        {
            "id": "tiles",
            "task_type": "class",
            "task_identifier": "alpineview_ewoks.tasks.build_tile.BuildTiles",
        },
        {
            "id": "buildings",
            "task_type": "class",
            "task_identifier": "alpineview_ewoks.tasks.buildings.BuildBuildings",
        },
        {
            "id": "vegetation",
            "task_type": "class",
            "task_identifier": "alpineview_ewoks.tasks.vegetation.BuildVegetation",
        },
    ],
    "links": [
        {
            "source": "download",
            "target": "tiles",
            "data_mapping": [
                {"source_output": "x_km", "target_input": "x_km"},
                {"source_output": "y_km", "target_input": "y_km"},
                {"source_output": "laz_path", "target_input": "laz_path"},
            ],
        },
        {
            "source": "download",
            "target": "buildings",
            "data_mapping": [{"source_output": "laz_path", "target_input": "laz_path"}],
        },
        {
            "source": "download",
            "target": "vegetation",
            "data_mapping": [{"source_output": "laz_path", "target_input": "laz_path"}],
        },
    ],
}

# All values below are the task defaults (DownloadTileInputs, BuildTilesInputs,
# BuildVegetationInputs); override here only to deviate from them.
INPUTS: list = [
    # {"id": "download", "name": "resolution", "value": 2},
    # {"id": "tiles", "name": "depth", "value": 10},
    # {"id": "tiles", "name": "weight", "value": 8},
    # {"id": "tiles", "name": "lod", "value": 2},
    # {"id": "tiles", "name": "trim", "value": 5.0},
    # {"id": "tiles", "name": "parallel", "value": False},
    # {"id": "tiles", "name": "use_las", "value": True},
    # {"id": "tiles", "name": "optimize", "value": True},
    # {"id": "tiles", "name": "encode", "value": False},
    # {"id": "tiles", "name": "skirt_depth", "value": 50.0},
    # {"id": "tiles", "name": "aratio", "value": 0.05},
    # {"id": "tiles", "name": "clean", "value": 2},
    # {"id": "tiles", "name": "downsample", "value": True},
    # {"id": "tiles", "name": "ds_voxel", "value": -1.0},
    # {"id": "tiles", "name": "ds_cone", "value": 10.0},
    # {"id": "tiles", "name": "ds_min_pts", "value": 0},
    # {"id": "vegetation", "name": "min_tree_height", "value": 2.0},
    # {"id": "vegetation", "name": "min_tree_points", "value": 20},
]


def submit_build_tile(
    x: int, y: int, parallel: bool = False, download=False, force: bool = False
):
    """Submit the build graph for cell (x, y); returns the ewoksjob future.

    force: rebuild tiles/vegetation/buildings even when their outputs exist.
    """
    inputs: list = copy(INPUTS)
    inputs.extend(
        [
            {"id": "download", "name": "x_km", "value": x},
            {"id": "download", "name": "y_km", "value": y},
            {"id": "download", "name": "download_from_ign", "value": download},
            {"id": "tiles", "name": "parallel", "value": parallel},
            {"id": "tiles", "name": "force", "value": force},
            {"id": "vegetation", "name": "force", "value": force},
            {"id": "buildings", "name": "force", "value": force},
        ]
    )
    return submit(args=(GRAPH,), kwargs=dict(inputs=inputs))
