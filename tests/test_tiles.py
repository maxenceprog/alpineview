"""Unit tests for the trimmed-LAZ cache pipeline (tiles.py).

Network-free: CopcReader, download_tile and find_tile_lamb are faked.
"""

import numpy as np
import laspy
import pytest

import alpineview_ewoks.core.tiles as tiles
from alpineview_ewoks.core.lidar_hd import TileInfo
from alpineview_ewoks.core.tiles import (
    ElevationUnderThreshold,
    download_cell_and_neighbours,
    download_cell_laz,
)

TILE_NAME = "LHD_FXX_0959_6433_PTS_LAMB93_IGN69.copc.laz"


def make_las(z_min=1000.0, z_max=1400.0, n=100):
    header = laspy.LasHeader(point_format=6, version="1.4")
    las = laspy.LasData(header)
    rng = np.random.default_rng(0)
    las.x = rng.uniform(959000, 960000, n)
    las.y = rng.uniform(6432000, 6433000, n)
    las.z = np.linspace(z_min, z_max, n)
    las.intensity = rng.integers(1, 60000, n).astype(np.uint16)
    las.user_data = rng.integers(1, 200, n).astype(np.uint8)
    las.classification = rng.integers(1, 9, n).astype(np.uint8)
    las.gps_time = rng.uniform(3e8, 3.1e8, n)
    las.point_source_id = rng.integers(5000, 6000, n).astype(np.uint16)
    las.update_header()
    return las


class FakeCopcReader:
    las = make_las()
    queried_resolutions: list[int] = []

    def __init__(self, las):
        self.header = las.header

    @classmethod
    def open(cls, source, **_kw):
        return cls(cls.las)

    def query(self, resolution=None, **_kw):
        FakeCopcReader.queried_resolutions.append(resolution)
        return self.las.points

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def fake_ign(monkeypatch, tmp_path):
    FakeCopcReader.las = make_las()
    FakeCopcReader.queried_resolutions = []
    downloads = []

    def fake_find_tile_lamb(x, y):
        name = f"LHD_FXX_{int(x) // 1000:04d}_{int(y) // 1000 + 1:04d}_PTS_LAMB93_IGN69.copc.laz"
        return TileInfo(name=name, url=f"https://example.invalid/{name}")

    def fake_download_tile(tile, cache_dir, session=None):
        downloads.append(tile.name)
        dest = tmp_path / tile.name
        dest.write_bytes(b"fake copc")
        return dest

    monkeypatch.setattr(tiles, "CopcReader", FakeCopcReader)
    monkeypatch.setattr(tiles, "find_tile_lamb", fake_find_tile_lamb)
    monkeypatch.setattr(tiles, "download_tile", fake_download_tile)
    return downloads


def test_download_trims_and_deletes_copc(fake_ign, tmp_path):
    path = download_cell_laz(959, 6433, str(tmp_path), download_from_ign=True)

    assert fake_ign == [TILE_NAME]
    assert not (tmp_path / TILE_NAME).exists()

    las = laspy.read(path)
    src = FakeCopcReader.las
    assert len(las.points) == len(src.points)
    assert np.count_nonzero(las.intensity) == 0
    assert np.count_nonzero(las.user_data) == 0
    assert np.array_equal(las.classification, src.classification)
    assert np.array_equal(las.gps_time, src.gps_time)
    assert np.array_equal(las.point_source_id, src.point_source_id)
    with laspy.open(path) as f:
        assert f.header.are_points_compressed


def test_no_tmp_files_left(fake_ign, tmp_path):
    download_cell_laz(959, 6433, str(tmp_path), download_from_ign=True)
    assert not list(tmp_path.glob("*.tmp*"))


def test_cache_hit_skips_download(fake_ign, tmp_path):
    first = download_cell_laz(959, 6433, str(tmp_path), download_from_ign=True)
    second = download_cell_laz(959, 6433, str(tmp_path), download_from_ign=True)
    assert first == second
    assert fake_ign == [TILE_NAME]


def test_missing_cache_raises_without_flag(fake_ign, tmp_path):
    with pytest.raises(RuntimeError, match="not in cache"):
        download_cell_laz(959, 6433, str(tmp_path), download_from_ign=False)
    assert fake_ign == []


def test_preexisting_copc_is_kept(fake_ign, tmp_path):
    (tmp_path / TILE_NAME).write_bytes(b"pre-existing copc")
    download_cell_laz(959, 6433, str(tmp_path), download_from_ign=True)
    assert fake_ign == []
    assert (tmp_path / TILE_NAME).exists()


def test_min_elevation_raises_and_cleans_up(fake_ign, tmp_path):
    with pytest.raises(ElevationUnderThreshold):
        download_cell_laz(
            959, 6433, str(tmp_path), min_elevation=9999.0, download_from_ign=True
        )
    assert not (tmp_path / TILE_NAME).exists()


def test_low_elevation_diff_lowers_resolution(fake_ign, tmp_path):
    FakeCopcReader.las = make_las(z_min=1000.0, z_max=1050.0)
    download_cell_laz(959, 6433, str(tmp_path), resolution=1, download_from_ign=True)
    assert FakeCopcReader.queried_resolutions == [2]


def test_neighbours_downloads_five_cells(fake_ign, tmp_path):
    centre = download_cell_and_neighbours(
        959, 6433, str(tmp_path), download_from_ign=True
    )
    assert centre.endswith("LHD_FXX_0959_6433_PTS_LAMB93_IGN69.laz")
    assert sorted(fake_ign) == sorted(
        f"LHD_FXX_{x:04d}_{y:04d}_PTS_LAMB93_IGN69.copc.laz"
        for x, y in [(959, 6433), (958, 6433), (960, 6433), (959, 6432), (959, 6434)]
    )
    assert len(list(tmp_path.glob("*.laz"))) == 5


def test_neighbours_centre_elevation_error_propagates(fake_ign, tmp_path):
    with pytest.raises(ElevationUnderThreshold):
        download_cell_and_neighbours(
            959, 6433, str(tmp_path), min_elevation=9999.0, download_from_ign=True
        )
