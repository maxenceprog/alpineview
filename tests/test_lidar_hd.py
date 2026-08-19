"""Tests for the WFS tile lookup and download session.

Tests hitting data.geopf.fr are skipped unless ALPINEVIEW_NETWORK_TESTS=1.
"""

import os

import pytest
from alpineview_ewoks.core.lidar_hd import _make_session, find_tile_lamb, find_tiles

network = pytest.mark.skipif(
    not os.environ.get("ALPINEVIEW_NETWORK_TESTS"),
    reason="set ALPINEVIEW_NETWORK_TESTS=1 to run tests against data.geopf.fr",
)


def test_session_retries_on_429():
    session = _make_session()
    retry = session.get_adapter("https://data.geopf.fr").max_retries
    assert 429 in retry.status_forcelist


@network
def test_find_tile_lamb_on_block_boundary():
    # (959000, 6432000) sits exactly on the QM/QN block boundary; the old
    # bbox-catalog lookup wrongly returned QM (404), the WFS returns QN.
    tile = find_tile_lamb(959000, 6432000)
    assert tile.name == "LHD_FXX_0959_6433_PTS_LAMB93_IGN69.copc.laz"
    assert "_QN_" in tile.url


@network
def test_find_tiles_straddling_two_blocks():
    tiles = find_tiles(959500, 6432500, 600)
    assert len(tiles) == 9
    collections = {t.url.split("/")[-2] for t in tiles}
    assert any("_QM_" in c for c in collections)
    assert any("_QN_" in c for c in collections)


@network
def test_find_tile_outside_coverage_raises():
    with pytest.raises(ValueError):
        find_tile_lamb(51_000, 6_001_000)
