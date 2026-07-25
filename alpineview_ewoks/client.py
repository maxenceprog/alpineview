import json
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

_config_path = os.environ.get("ALPINEVIEW_LOCAL_CONFIG")
if _config_path and os.path.exists(_config_path):
    with open(_config_path) as _f:
        _config = json.load(_f)
else:
    raise ValueError(f"No config found at path {_config_path}")

BUILDER_OPTIONS: list = _config.get("BUILDER_OPTIONS", [])
OTHER_INPUTS: list = _config.get("OTHER_INPUTS", [])

print(BUILDER_OPTIONS)
print(OTHER_INPUTS)


def submit_build_tile(
    x: int, y: int, parallel: bool = False, download=False, force: bool = False
):
    """Submit the build graph for cell (x, y); returns the ewoksjob future.

    force: rebuild tiles/vegetation/buildings even when their outputs exist.
    """
    build_opts = copy(BUILDER_OPTIONS)
    if parallel:
        build_opts.append("--parallel")
    merged: dict = {
        (item["id"], item["name"]): item
        for item in [
            {"id": "download", "name": "x_km", "value": x},
            {"id": "download", "name": "y_km", "value": y},
            {"id": "download", "name": "download_from_ign", "value": download},
            {"id": "tiles", "name": "builder_options", "value": build_opts},
            {"id": "tiles", "name": "force", "value": True},
            {"id": "vegetation", "name": "force", "value": force},
            {"id": "buildings", "name": "force", "value": force},
        ]
    }
    for item in OTHER_INPUTS:
        merged[(item["id"], item["name"])] = item
    return submit(args=(GRAPH,), kwargs={"inputs": list(merged.values())})
