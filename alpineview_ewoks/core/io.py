"""LAS / LAZ / COPC file reading."""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)


def read_laz(
    path: str | Path,
    classifications: list[int] | None = None,
    max_points: int | None = None,
) -> np.ndarray:
    """Read x, y, z from a LAS / LAZ / COPC file.

    Parameters
    ----------
    classifications :
        LAS codes to keep (None = all).
        Common IGN codes: 2=ground, 3=low_veg, 4=med_veg, 5=high_veg,
        6=building, 9=water.
    max_points :
        Random subsample ceiling applied after filtering.

    Returns
    -------
    ndarray (N, 3) float64 — coordinates in the file's CRS (e.g. Lambert 93).
    """
    import laspy

    logger.info("Reading %s", path)
    las = laspy.read(str(path))
    pts = np.stack([np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)], axis=1)
    logger.info("  %s points loaded", f"{len(pts):,}")

    if classifications is not None:
        mask = np.isin(np.asarray(las.classification), classifications)
        pts = pts[mask]
        logger.info(
            "  After classification filter %s: %s points",
            classifications,
            f"{len(pts):,}",
        )

    if max_points is not None and len(pts) > max_points:
        idx = np.random.choice(len(pts), max_points, replace=False)
        pts = pts[idx]
        logger.info("  Random subsample → %s points", f"{len(pts):,}")

    return pts
