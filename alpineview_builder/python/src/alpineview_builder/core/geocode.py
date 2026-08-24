from __future__ import annotations

import logging

from .geo_convert import convert

logger = logging.getLogger(__name__)


def latlon_to_l93(lat: float, lon: float) -> tuple[float, float]:
    """Convert WGS84 (lat, lon) to Lambert 93 (x, y) in metres (EPSG:2154)."""
    x, y, _z = convert(lon, lat, 0.0, "geodetic", "l93")
    return x, y


def l93_to_latlon(x: float, y: float) -> tuple[float, float]:
    """Convert Lambert 93 (x, y) in metres (EPSG:2154) to WGS84 (lat, lon)."""
    lon, lat, _z = convert(x, y, 0.0, "l93", "geodetic")
    return lat, lon
