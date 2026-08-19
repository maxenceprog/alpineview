"""Cells without vegetation (class 5) or buildings (class 6) points make their
tasks early-return without ever calling into the (network-bound) build step."""

import laspy
import numpy as np
import pytest
from alpineview_ewoks.core.buildings import has_building_points
from alpineview_ewoks.core.vegetation import has_vegetation_points
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


def test_vegetation_no_class5_early_returns(ground_only_laz, tmp_path, monkeypatch):
    assert has_vegetation_points(str(ground_only_laz)) is False

    def fail_if_called(*args, **kwargs):
        raise AssertionError("build_vegetation should not be called")

    monkeypatch.setattr(
        "alpineview_ewoks.tasks.vegetation.build_vegetation", fail_if_called
    )

    out = tmp_path / "veg"
    task = BuildVegetation(inputs={"laz_path": str(ground_only_laz), "out_dir": str(out)})
    task.execute()
    assert task.outputs.veg_tiles == []


def test_buildings_no_class6_early_returns(ground_only_laz, tmp_path, monkeypatch):
    assert has_building_points(str(ground_only_laz)) is False

    def fail_if_called(*args, **kwargs):
        raise AssertionError("build_buildings should not be called")

    monkeypatch.setattr(
        "alpineview_ewoks.tasks.buildings.build_buildings", fail_if_called
    )

    out = tmp_path / "buildings"
    task = BuildBuildings(inputs={"laz_path": str(ground_only_laz), "out_dir": str(out)})
    task.execute()
    assert task.outputs.city_path is None
