"""Buildings build step: reconstruct LoD2.2 buildings with roofer.

Fetches BDTOPO footprints (WFS) for a cell, runs roofer on the cell's LAZ +
footprints, and places the resulting CityJSONSequence at
<out_dir>/<lazStem>.city.jsonl (the webapp overlay fetches by lazStem).
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
from pathlib import Path

import fiona
import laspy
import numpy as np
import requests
from fiona.crs import from_epsg

_REPO = Path(__file__).resolve().parents[2]
DEFAULT_OUT = str(_REPO / "webapp" / "public" / "buildings")
DEFAULT_ROOFER = str(Path.home() / ".local" / "bin" / "roofer")
_WFS_URL = "https://data.geopf.fr/wfs"
_LAYER = "BDTOPO_V3:batiment"
_PAGE_SIZE = 2000
_FOOTPRINT_PAD_M = 50.0
BUILDING_CLASS = 6

log = logging.getLogger("reconstruction.buildings")


def has_building_points(laz_path: str) -> bool:
    """Whether the LAZ has any building-classified (class 6) points."""
    selection = (
        laspy.DecompressionSelection.base()
        | laspy.DecompressionSelection.CLASSIFICATION
    )
    classification = laspy.read(
        str(laz_path), decompression_selection=selection
    ).classification
    return bool(np.any(np.asarray(classification) == BUILDING_CLASS))


def fetch_footprints(x0: float, y0: float, x1: float, y1: float) -> list[dict]:
    """BDTOPO building footprints (GeoJSON features) within an L93 metre bbox."""
    features: list[dict] = []
    start = 0
    session = requests.Session()
    while True:
        url = (
            f"{_WFS_URL}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature"
            f"&TYPENAMES={_LAYER}&BBOX={x0},{y0},{x1},{y1},EPSG:2154"
            f"&OUTPUTFORMAT=application/json&SRSNAME=EPSG:2154"
            f"&COUNT={_PAGE_SIZE}&STARTINDEX={start}"
        )
        resp = session.get(url, timeout=30)
        resp.raise_for_status()
        page = resp.json().get("features", [])
        features.extend(page)
        if len(page) < _PAGE_SIZE:
            break
        start += _PAGE_SIZE
    return features


def _to_multipolygon(geom: dict) -> dict:
    if geom["type"] == "Polygon":
        return {"type": "MultiPolygon", "coordinates": [geom["coordinates"]]}
    return geom


def _f(v):
    return float(v) if v is not None else None


def _i(v):
    return int(v) if v is not None else None


def write_gpkg(path: Path, features: list[dict]) -> int:
    """Write BDTOPO footprints to a roofer-ready GPKG; returns count."""
    schema = {
        "geometry": "MultiPolygon",
        "properties": {
            "cleabs": "str",
            "hauteur": "float",
            "altitude_minimale_sol": "float",
            "altitude_maximale_toit": "float",
            "nombre_d_etages": "int",
            "usage_1": "str",
        },
    }
    written = 0
    with fiona.open(
        str(path), "w", driver="GPKG", crs=from_epsg(2154), schema=schema
    ) as f:
        for feat in features:
            geom = feat.get("geometry")
            if geom is None:
                continue
            props = feat.get("properties", {})
            f.write(
                {
                    "geometry": _to_multipolygon(geom),
                    "properties": {
                        "cleabs": props.get("cleabs") or "",
                        "hauteur": _f(props.get("hauteur")),
                        "altitude_minimale_sol": _f(props.get("altitude_minimale_sol")),
                        "altitude_maximale_toit": _f(
                            props.get("altitude_maximale_toit")
                        ),
                        "nombre_d_etages": _i(props.get("nombre_d_etages")),
                        "usage_1": props.get("usage_1") or "",
                    },
                }
            )
            written += 1
    return written


def _cell_bbox_padded(x_km: int, y_km: int) -> tuple[float, float, float, float]:
    x0, y0 = x_km * 1000.0, (y_km - 1) * 1000.0
    p = _FOOTPRINT_PAD_M
    return (x0 - p, y0 - p, x0 + 1000.0 + p, y0 + 1000.0 + p)


def build_buildings(
    laz_path: str, out_dir: str, roofer_bin: str = DEFAULT_ROOFER
) -> str | None:
    """Footprints + roofer → <out_dir>/<lazStem>.city.jsonl.

    Returns None if the cell has no reconstructable buildings.
    """
    laz = Path(laz_path)
    stem = laz.name.replace(".copc.laz", "").replace(".laz", "")
    x_km, y_km = (int(p) for p in stem.split("_")[2:4])
    final = Path(out_dir) / f"{stem}.city.jsonl"

    features = fetch_footprints(*_cell_bbox_padded(x_km, y_km))
    if not features:
        log.info("%s: no BDTOPO footprints", laz.name)
        return None

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        gpkg = tmp / f"{stem}.gpkg"
        write_gpkg(gpkg, features)
        roofer_out = tmp / "roofer"
        roofer_out.mkdir()
        proc = subprocess.run(
            [roofer_bin, "-j", "1", "--lod22", str(laz), str(gpkg), str(roofer_out)],
            capture_output=True,
            text=True,
        )
        if proc.stdout:
            log.debug("roofer stdout:\n%s", proc.stdout)
        if proc.returncode != 0:
            raise subprocess.CalledProcessError(
                proc.returncode, roofer_bin, proc.stdout, proc.stderr
            )
        produced = sorted(roofer_out.glob("*.city.jsonl"))
        if not produced:
            log.info("%s: roofer produced no buildings", laz.name)
            return None
        shutil.move(str(produced[0]), final)
    return str(final)
