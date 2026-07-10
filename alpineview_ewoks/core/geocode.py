"""Geocoding and coordinate conversion utilities."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
_USER_AGENT = "poissonrecon-ign/0.1 (open-source LiDAR reconstruction tool)"


def geocode(query: str) -> tuple[float, float]:
    """Resolve a place name to (lat, lon) via Nominatim (OpenStreetMap).

    Parameters
    ----------
    query :
        Free-form place name, e.g. ``"Refuge de l'Olan"`` or ``"Mont Blanc"``.

    Returns
    -------
    (lat, lon) in WGS84 degrees.

    Raises
    ------
    ValueError
        If Nominatim returns no results for the query.
    """
    import requests

    logger.info("Geocoding %r ...", query)
    resp = requests.get(
        _NOMINATIM_URL,
        params={"q": query, "format": "json", "limit": 1},
        headers={"User-Agent": _USER_AGENT},
        timeout=10,
    )
    resp.raise_for_status()
    results = resp.json()
    logger.debug("Nominatim returned %d result(s)", len(results))

    if not results:
        raise ValueError(
            f"No geocoding results for {query!r}. "
            "Try a more specific name or check spelling."
        )

    r = results[0]
    lat, lon = float(r["lat"]), float(r["lon"])
    display = r.get("display_name", "")
    logger.info("  → %s", display)
    logger.info("  → lat=%.6f  lon=%.6f", lat, lon)
    return lat, lon


def latlon_to_l93(lat: float, lon: float) -> tuple[float, float]:
    """Convert WGS84 (lat, lon) to Lambert 93 (x, y) in metres (EPSG:2154).

    Lambert 93 is the native CRS of IGN LiDAR HD data.

    Returns
    -------
    (x, y) in metres.
    """
    from pyproj import Transformer

    transformer = Transformer.from_crs("EPSG:4326", "EPSG:2154", always_xy=True)
    x, y = transformer.transform(lon, lat)
    logger.debug("Lambert 93: x=%.1f  y=%.1f", x, y)
    return float(x), float(y)


def l93_to_latlon(x: float, y: float) -> tuple[float, float]:
    """Convert WGS84 (lat, lon) to Lambert 93 (x, y) in metres (EPSG:2154).

    Lambert 93 is the native CRS of IGN LiDAR HD data.

    Returns
    -------
    (x, y) in metres.
    """
    from pyproj import Transformer

    transformer = Transformer.from_crs("EPSG:2154", "EPSG:4326", always_xy=True)
    lon, lat = transformer.transform(x, y)
    return lat, lon
