"""Cells without vegetation (class 5) or buildings (class 6) succeed with
info-level logs and produce empty marker outputs so re-runs skip them."""

import json
import logging

import laspy
import numpy as np
import pytest

from alpineview_ewoks.core.buildings import build_buildings
from alpineview_ewoks.core.vegetation import build_vegetation, vegetation_outputs
from alpineview_ewoks.tasks.buildings import BuildBuildings
from alpineview_ewoks.tasks.vegetation import BuildVegetation

LAZ_NAME = "LHD_FXX_0959_6433_PTS_LAMB93_IGN69.laz"


@pytest.fixture
def ground_only_laz(tmp_path):
    header = laspy.LasHeader(point_format=6, version="1.4")
    las = laspy.LasData(header)
    rng = np.random.default_rng(0)
    n = 200
    las.x = rng.uniform(959000, 960000, n)
    las.y = rng.uniform(6432000, 6433000, n)
    las.z = rng.uniform(1000, 1010, n)
    las.classification = np.full(n, 2, dtype=np.uint8)
    las.update_header()
    path = tmp_path / LAZ_NAME
    las.write(path)
    return path


def test_vegetation_no_class5_succeeds(ground_only_laz, tmp_path, caplog):
    out = tmp_path / "veg"
    with caplog.at_level(logging.INFO, logger="reconstruction.vegetation"):
        paths = build_vegetation(str(ground_only_laz), str(out))

    assert len(paths) == 16
    assert all(p.endswith(".veg.drc") for p in paths)
    assert all((out / p.split("/")[-1]).stat().st_size == 0 for p in paths)
    assert not [r for r in caplog.records if r.levelno > logging.INFO]
    assert vegetation_outputs(959, 6433, str(out)) == paths

    task = BuildVegetation(inputs=dict(laz_path=str(ground_only_laz), out_dir=str(out)))
    task.execute()
    assert sorted(task.outputs.veg_tiles) == sorted(paths)


def test_buildings_no_class6_succeeds(ground_only_laz, tmp_path, caplog):
    out = tmp_path / "buildings"
    with caplog.at_level(logging.INFO, logger="reconstruction.buildings"):
        city_path = build_buildings(str(ground_only_laz), str(out))

    assert city_path.endswith(".city.jsonl")
    lines = [line for line in open(city_path).read().split("\n") if line.strip()]
    assert len(lines) == 1
    assert json.loads(lines[0])["type"] == "CityJSON"
    assert not [r for r in caplog.records if r.levelno > logging.INFO]

    task = BuildBuildings(inputs=dict(laz_path=str(ground_only_laz), out_dir=str(out)))
    task.execute()
    assert task.outputs.city_path == city_path
