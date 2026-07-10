"""IGN LiDAR HD tile lookup and cached download.

Uses the Géoplateforme téléchargement API:
  https://data.geopf.fr/telechargement/

Key endpoints
-------------
GetResource   GET /resource/LiDARHD-NUALID[?page=N]
              Returns all ~206 LAMB93 collections.  Each entry carries a
              ``gpf_dl:bbox="minLon minLat maxLon maxLat"`` attribute that
              gives the exact geographic footprint of that collection.

Download      GET /download/LiDARHD-NUALID/{collection}/{filename}
              Direct file download.

Tile filename convention (mainland France, Lambert 93)
------------------------------------------------------
  LHD_FXX_{tile_x:04d}_{tile_y:04d}_PTS_LAMB93_IGN69.copc.laz
  where tile_x = floor(L93_x / 1000), tile_y = floor(L93_y / 1000)

Collection lookup
-----------------
Each of the ~206 LAMB93 collections covers a ~50×50 km area of France.
``find_tile`` works by:
  1. Loading the bundled catalog JSON (lidalp_tools/lidar_hd_catalog.json).
  2. Point-in-bbox to find the collection whose bbox contains (lon, lat).
  3. Computing the tile filename deterministically from L93 grid coordinates.

To refresh the bundled catalog, run ``_fetch_catalog()`` and overwrite the file.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

import requests

from .geocode import l93_to_latlon, latlon_to_l93

logger = logging.getLogger(__name__)

_RESOURCE_URL = "https://data.geopf.fr/telechargement/resource/LiDARHD-NUALID"
_DOWNLOAD_BASE = "https://data.geopf.fr/telechargement/download/LiDARHD-NUALID"
_CATALOG_PATH = Path(__file__).parent / "lidar_hd_catalog.json"


@dataclass
class TileInfo:
    name: str
    url: str


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _tile_filename(x_l93: float, y_l93: float) -> str:
    """Build the LiDAR HD tile filename from Lambert 93 coordinates (metres)."""
    tile_x = int(x_l93 // 1000)
    tile_y = int(y_l93 // 1000) + 1  # north edge convention
    return f"LHD_FXX_{tile_x:04d}_{tile_y:04d}_PTS_LAMB93_IGN69.copc.laz"


def _extract_collections(text: str) -> list[str]:
    """Extract collection names from a GetResource response (Atom XML or JSON)."""
    return list(set(re.findall(r"NUALHD_[A-Za-z0-9_-]+", text)))


def _load_catalog() -> dict[str, tuple[float, float, float, float]]:
    """Load the bundled catalog JSON."""
    data = json.loads(_CATALOG_PATH.read_text())
    return {k: tuple(v) for k, v in data.items()}  # type: ignore[misc]


def _fetch_catalog() -> dict[str, tuple[float, float, float, float]]:
    """Fetch all LAMB93 collection bboxes from the GetResource endpoint.

    Use this to regenerate lidar_hd_catalog.json when the catalog changes.
    """
    catalog: dict[str, tuple[float, float, float, float]] = {}
    page = 1
    while True:
        resp = requests.get(_RESOURCE_URL, params={"page": page}, timeout=30)
        resp.raise_for_status()
        text = resp.text

        pagecount_m = re.search(r'gpf_dl:pagecount="(\d+)"', text)
        pagecount = int(pagecount_m.group(1)) if pagecount_m else 1

        for m in re.finditer(
            r"<title>(NUALHD_1-0__LAZ_LAMB93_[^<]+)</title>"
            r'.*?gpf_dl:bbox="([^"]+)"',
            text,
            re.DOTALL,
        ):
            title, bbox_str = m.group(1), m.group(2)
            parts = tuple(float(v) for v in bbox_str.split())
            if len(parts) == 4:
                catalog[title] = parts  # type: ignore[assignment]

        logger.debug(
            "  Page %d/%d — %d collections so far", page, pagecount, len(catalog)
        )
        if page >= pagecount:
            break
        page += 1

    return catalog


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

    catalog = _load_catalog()

    matches = [
        name
        for name, (minLon, minLat, maxLon, maxLat) in catalog.items()
        if minLon <= lon <= maxLon and minLat <= lat <= maxLat
    ]
    if not matches:
        raise ValueError(
            f"No LiDAR HD collection found for lon={lon:.5f}, lat={lat:.5f}. "
            "The area may not be covered by IGN LiDAR HD yet."
        )

    collection = max(
        matches,
        key=lambda n: (re.search(r"\d{4}-\d{2}-\d{2}", n) or re.match("", "")).group(),
    )
    logger.info("  Collection: %s", collection)

    filename = _tile_filename(x, y)
    url = f"{_DOWNLOAD_BASE}/{collection}/{filename}"
    logger.info("  Tile: %s", filename)
    logger.debug("  URL: %s", url)
    return TileInfo(name=filename, url=url)


def find_tiles(x_l93: float, y_l93: float, radius_m: float) -> list[TileInfo]:
    """Return all IGN LiDAR HD tiles overlapping a square crop area.

    Parameters
    ----------
    x_l93, y_l93 :
        Centre of the crop area in Lambert 93 metres.
    radius_m :
        Half-side of the crop square in metres.
    """
    from pyproj import Transformer

    tr = Transformer.from_crs("EPSG:2154", "EPSG:4326", always_xy=True)

    tx_min = int((x_l93 - radius_m) // 1000)
    tx_max = int((x_l93 + radius_m) // 1000)
    ty_min = int((y_l93 - radius_m) // 1000) + 1
    ty_max = int((y_l93 + radius_m) // 1000) + 1

    n_tiles = (tx_max - tx_min + 1) * (ty_max - ty_min + 1)
    if n_tiles > 1:
        logger.info(
            "Crop radius %.0f m spans %d×%d tiles (%d total)",
            radius_m,
            tx_max - tx_min + 1,
            ty_max - ty_min + 1,
            n_tiles,
        )

    catalog = _load_catalog()

    tiles: list[TileInfo] = []
    for tx in range(tx_min, tx_max + 1):
        for ty in range(ty_min, ty_max + 1):
            lon, lat = tr.transform(tx * 1000 + 500.0, (ty - 1) * 1000 + 500.0)

            matches = [
                name
                for name, (minLon, minLat, maxLon, maxLat) in catalog.items()
                if minLon <= lon <= maxLon and minLat <= lat <= maxLat
            ]
            if not matches:
                logger.debug("Tile (%d, %d): not in any collection — skipped", tx, ty)
                continue

            collection = max(
                matches,
                key=lambda n: (
                    re.search(r"\d{4}-\d{2}-\d{2}", n) or re.match("", "")
                ).group(),
            )
            filename = f"LHD_FXX_{tx:04d}_{ty:04d}_PTS_LAMB93_IGN69.copc.laz"
            url = f"{_DOWNLOAD_BASE}/{collection}/{filename}"
            tiles.append(TileInfo(name=filename, url=url))
            logger.debug("  Tile (%d, %d) → %s", tx, ty, collection)

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
        status_forcelist={500, 502, 503, 504},
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
