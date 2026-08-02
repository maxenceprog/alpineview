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
import threading
from dataclasses import dataclass
from pathlib import Path

import requests

from geocode import l93_to_latlon

logger = logging.getLogger(__name__)

_WFS_URL = "https://data.geopf.fr/wfs/ows"
_WFS_LAYER = "IGNF_NUAGES-DE-POINTS-LIDAR-HD:dalle"


@dataclass
class TileInfo:
    name: str
    url: str


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
    resp = _shared_session().get(_WFS_URL, params=params, timeout=30)
    resp.raise_for_status()
    features = resp.json().get("features", [])

    tiles = []
    for feat in features:
        url = feat["properties"]["url"]
        name = url.split("/")[-1]
        tiles.append(TileInfo(name=name, url=url))
    return tiles


def find_tile_lamb(x: float, y: float) -> TileInfo:
    lat, lon = l93_to_latlon(x, y)
    return _find_tile(x, y, lon, lat)


def _find_tile(x: float, y: float, lon: float, lat: float) -> TileInfo:
    if not (50_000 <= x <= 1_250_000 and 6_000_000 <= y <= 7_200_000):
        raise ValueError(
            f"lon={lon:.5f}, lat={lat:.5f} is outside mainland France "
            f"(L93: x={x:.0f}, y={y:.0f}). "
            "Overseas territories are not yet supported."
        )

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
    return tile


_shared: requests.Session | None = None
_shared_lock = threading.Lock()


def _shared_session() -> requests.Session:
    """Process-wide session: keep-alive connections reused across WFS lookups
    and tile downloads (urllib3's pool is thread-safe)."""
    global _shared
    with _shared_lock:
        if _shared is None:
            _shared = _make_session()
        return _shared


def _make_session():
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry

    session = requests.Session()
    retry = Retry(
        total=4,
        backoff_factor=2,
        status_forcelist={429, 500, 502, 503, 504},
        allowed_methods={"GET", "HEAD"},
    )
    session.mount("https://", HTTPAdapter(max_retries=retry))
    session.mount("http://", HTTPAdapter(max_retries=retry))
    return session


def tile_size(tile: TileInfo, session: requests.Session | None = None) -> int | None:
    """Remote file size in bytes (HEAD request), or None if unavailable."""
    session = session or _shared_session()
    resp = session.head(tile.url, timeout=30, allow_redirects=True)
    resp.raise_for_status()
    total = resp.headers.get("content-length")
    return int(total) if total is not None else None


def download_tile(
    tile: TileInfo, cache_dir: str | Path, session: requests.Session | None = None
) -> Path:
    """Download a tile to *cache_dir*, skipping if already present."""
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)

    filename = tile.url.split("/")[-1].split("?")[0] or tile.name
    dest = cache_dir / filename

    if dest.exists():
        logger.info("Cache hit: %s", dest)
        return dest

    logger.info("Downloading tile %s ...", tile.name)

    if session is None:
        session = _shared_session()
    resp = session.get(tile.url, stream=True, timeout=(10, 60))
    resp.raise_for_status()

    tmp_dest = dest.with_suffix(".tmp")
    try:
        with open(tmp_dest, "wb") as f:
            for chunk in resp.iter_content(chunk_size=512 * 1024):
                f.write(chunk)
        tmp_dest.rename(dest)
    except Exception:
        tmp_dest.unlink(missing_ok=True)
        raise

    logger.info("  Saved → %s (%.0f MB)", dest, dest.stat().st_size / 1024**2)
    return dest
