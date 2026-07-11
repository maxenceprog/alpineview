"""IGN LiDAR HD tile lookup and cached download.

Tile lookup uses the official tableau d'assemblage exposed as WFS on the
Géoplateforme:

  GET https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature
      &TYPENAMES=IGNF_NUAGES-DE-POINTS-LIDAR-HD:dalle
      &OUTPUTFORMAT=application/json&SRSNAME=EPSG:2154
      &BBOX=<xmin>,<ymin>,<xmax>,<ymax>,EPSG:2154

Each ``dalle`` feature is a 1×1 km tile carrying the authoritative download
``url`` property, so no collection/bbox guessing is needed.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import requests

from .geocode import l93_to_latlon, latlon_to_l93

logger = logging.getLogger(__name__)

_WFS_URL = "https://data.geopf.fr/wfs/ows"
_WFS_LAYER = "IGNF_NUAGES-DE-POINTS-LIDAR-HD:dalle"


@dataclass
class TileInfo:
    name: str
    url: str


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _wfs_dalles(
    xmin: float, ymin: float, xmax: float, ymax: float, count: int = 1000
) -> list[TileInfo]:
    """Query the WFS tableau d'assemblage for dalles intersecting a L93 bbox."""
    params = {
        "SERVICE": "WFS",
        "VERSION": "2.0.0",
        "REQUEST": "GetFeature",
        "TYPENAMES": _WFS_LAYER,
        "OUTPUTFORMAT": "application/json",
        "SRSNAME": "EPSG:2154",
        "BBOX": f"{xmin},{ymin},{xmax},{ymax},EPSG:2154",
        "COUNT": str(count),
    }
    resp = _make_session().get(_WFS_URL, params=params, timeout=30)
    resp.raise_for_status()
    features = resp.json().get("features", [])

    tiles = []
    for feat in features:
        url = feat["properties"]["url"]
        name = url.split("/")[-1]
        tiles.append(TileInfo(name=name, url=url))
    return tiles


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def find_tile_lamb(x: float, y: float) -> TileInfo:

    lat, lon = l93_to_latlon(x, y)
    return _find_tile(x, y, lon, lat)


def find_tile(lon: float, lat: float) -> TileInfo:
    """Find the IGN LiDAR HD tile that covers (lon, lat).

    Parameters
    ----------
    lon, lat :
        Point of interest in WGS84 degrees.

    Returns
    -------
    TileInfo with the tile filename and its direct download URL.

    Raises
    ------
    ValueError
        If the point is outside the mainland France L93 bounding box, or if
        no collection covers the point (area not yet in the LiDAR HD programme).
    """

    logger.info("Looking up LiDAR HD tile (lon=%.5f, lat=%.5f) ...", lon, lat)

    x, y = latlon_to_l93(lat, lon)
    return _find_tile(x, y, lon, lat)


def _find_tile(x: float, y: float, lon: float, lat: float) -> TileInfo:
    if not (50_000 <= x <= 1_250_000 and 6_000_000 <= y <= 7_200_000):
        raise ValueError(
            f"lon={lon:.5f}, lat={lat:.5f} is outside mainland France "
            f"(L93: x={x:.0f}, y={y:.0f}). "
            "Overseas territories are not yet supported."
        )
    logger.info("L93: x=%.0f  y=%.0f (lon=%.5f, lat=%.5f)", x, y, lon, lat)

    xc = x // 1000 * 1000 + 500
    yc = y // 1000 * 1000 + 500
    tiles = _wfs_dalles(xc - 1, yc - 1, xc + 1, yc + 1)
    if not tiles:
        raise ValueError(
            f"No LiDAR HD tile found for lon={lon:.5f}, lat={lat:.5f}. "
            "The area may not be covered by IGN LiDAR HD yet."
        )

    tile = tiles[0]
    logger.info("  Tile: %s", tile.name)
    logger.debug("  URL: %s", tile.url)
    return tile


def find_tiles(x_l93: float, y_l93: float, radius_m: float) -> list[TileInfo]:
    """Return all IGN LiDAR HD tiles overlapping a square crop area.

    Parameters
    ----------
    x_l93, y_l93 :
        Centre of the crop area in Lambert 93 metres.
    radius_m :
        Half-side of the crop square in metres.
    """
    tiles = _wfs_dalles(
        x_l93 - radius_m, y_l93 - radius_m, x_l93 + radius_m, y_l93 + radius_m
    )
    if len(tiles) > 1:
        logger.info("Crop radius %.0f m covers %d tiles", radius_m, len(tiles))

    if not tiles:
        raise ValueError(
            f"No LiDAR HD tiles found for x={x_l93:.0f}, y={y_l93:.0f}, "
            f"r={radius_m:.0f} m. The area may not be covered by IGN LiDAR HD yet."
        )
    return tiles


def _make_session():
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry

    session = requests.Session()
    retry = Retry(
        total=4,
        backoff_factor=2,
        status_forcelist={429, 500, 502, 503, 504},
        allowed_methods={"GET"},
    )
    session.mount("https://", HTTPAdapter(max_retries=retry))
    session.mount("http://", HTTPAdapter(max_retries=retry))
    return session


def download_tile(
    tile: TileInfo, cache_dir: str | Path, session: requests.Session | None = None
) -> Path:
    """Download a tile to *cache_dir*, skipping if already present.

    Pass a shared *session* to reuse keep-alive connections across many
    downloads; otherwise a one-shot session is created.
    """
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)

    filename = tile.url.split("/")[-1].split("?")[0] or tile.name
    dest = cache_dir / filename

    if dest.exists():
        logger.info("Cache hit: %s", dest)
        return dest

    logger.info("Downloading tile %s ...", tile.name)
    logger.debug("  from %s", tile.url)
    logger.debug("  to   %s", dest)

    if session is None:
        session = _make_session()
    resp = session.get(tile.url, stream=True, timeout=(10, 60))
    resp.raise_for_status()
    total = int(resp.headers.get("content-length", 0))
    if total:
        logger.info("  File size: %.1f MB", total / 1024**2)

    downloaded = 0
    last_logged_pct = -1
    tmp_dest = dest.with_suffix(".tmp")

    try:
        with open(tmp_dest, "wb") as f:
            for chunk in resp.iter_content(chunk_size=512 * 1024):
                f.write(chunk)
                downloaded += len(chunk)
                if total:
                    pct = int(downloaded / total * 100)
                    if pct >= last_logged_pct + 10:
                        logger.debug(
                            "  %d%%  (%d / %d MB)",
                            pct,
                            downloaded // 1024**2,
                            total // 1024**2,
                        )
                        last_logged_pct = pct
        tmp_dest.rename(dest)
        logger.info("  Done → %s (%.1f MB)", dest.name, downloaded / 1024**2)
    except Exception:
        tmp_dest.unlink(missing_ok=True)
        raise

    logger.info("  Saved → %s (%.0f MB)", dest, dest.stat().st_size / 1024**2)
    return dest
