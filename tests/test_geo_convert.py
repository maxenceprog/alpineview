"""Tests for geo_convert (alpineview_builder/src/geo_convert.cpp) and the
Python GUI wrapper around it (alpineview_builder/gui/geo_convert.py,
geocode.py). Replaces the old geo_selftest C++ self-test, moved here so both
the binary and its Python callers are exercised from one place.

Skipped unless alpineview_builder has been built (./cmake.sh && ./make.sh in
alpineview_builder/), same convention as the network-gated tests in this
directory.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

_BUILDER_ROOT = Path(__file__).resolve().parents[1] / "alpineview_builder"
_GUI_DIR = _BUILDER_ROOT / "gui"

sys.path.insert(0, str(_GUI_DIR))


def _find_binary() -> Path | None:
    for build in ("build/release/src/geo_convert", "build/debug/src/geo_convert"):
        path = _BUILDER_ROOT / build
        if path.exists():
            return path
    return None


_BINARY = _find_binary()

needs_binary = pytest.mark.skipif(
    _BINARY is None,
    reason="geo_convert not built; run ./cmake.sh && ./make.sh in alpineview_builder/",
)


def _convert(x: float, y: float, z: float, proj_in: str, proj_out: str) -> tuple[float, float, float]:
    out = subprocess.run(
        [str(_BINARY), str(x), str(y), str(z), proj_in, proj_out],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    ox, oy, oz = (float(v) for v in out.split())
    return ox, oy, oz


@needs_binary
def test_identity_is_a_passthrough():
    for frame in ("l93", "geodetic", "work"):
        assert _convert(1.0, 2.0, 3.0, frame, frame) == pytest.approx((1.0, 2.0, 3.0))


@needs_binary
@pytest.mark.parametrize(
    "x,y,z",
    [
        (915000.0, 6450000.0, 1000.0),
        (930000.0, 6470000.0, 2500.0),
        (960000.0, 6430000.0, 300.0),
    ],
)
def test_l93_to_geodetic_leaves_z_untouched(x, y, z):
    # l93<->geodetic is horizontal-only in both directions: no geoid
    # correction, z passes straight through.
    _lon, _lat, out_z = _convert(x, y, z, "l93", "geodetic")
    assert out_z == pytest.approx(z)


@needs_binary
def test_geodetic_work_round_trip():
    lon, lat, z = 5.7, 45.1, 1000.0
    wx, wy, wz = _convert(lon, lat, z, "geodetic", "work")
    lon2, lat2, z2 = _convert(wx, wy, wz, "work", "geodetic")
    assert (lon2, lat2, z2) == pytest.approx((lon, lat, z), abs=1e-9)


@needs_binary
def test_l93_work_round_trip():
    # z is a passthrough in every frame, so the full point round-trips.
    x, y, z = 915000.0, 6450000.0, 1000.0
    wx, wy, wz = _convert(x, y, z, "l93", "work")
    x2, y2, z2 = _convert(wx, wy, wz, "work", "l93")
    assert (x2, y2, z2) == pytest.approx((x, y, z), abs=1e-3)


@needs_binary
def test_gui_geocode_round_trip():
    import geocode

    lat, lon = 45.5, 3.0
    x, y = geocode.latlon_to_l93(lat, lon)
    lat2, lon2 = geocode.l93_to_latlon(x, y)
    assert (lat2, lon2) == pytest.approx((lat, lon), abs=1e-9)


@needs_binary
def test_gui_laz_download_required_l93_tiles():
    import laz_download

    # A known WMQ level-15 tile: a real build job's tile, straddling more
    # than one L93 km cell (the case this function exists to handle).
    tiles = laz_download.required_l93_tiles(16905, 11983)
    assert len(tiles) in (4, 6)
