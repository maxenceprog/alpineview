"""Python wrapper around the geo_convert CLI (../../src/geo_convert.cpp), so
coordinate conversions reuse the exact same PROJ pipelines and work-frame
formula as the C++ builders, instead of a second, hand-ported implementation
that could drift from it.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

_BUILDER_ROOT = Path(__file__).resolve().parents[4]


def _binary() -> str:
    override = os.environ.get("ALPINEVIEW_GEO_CONVERT")
    if override:
        return override
    for build in ("build/release/src/geo_convert", "build/debug/src/geo_convert"):
        path = _BUILDER_ROOT / build
        if path.exists():
            return str(path)
    raise FileNotFoundError(
        "geo_convert binary not found; build alpineview_builder "
        "(./cmake.sh && ./make.sh) or set ALPINEVIEW_GEO_CONVERT"
    )


def convert(
    x: float, y: float, z: float, proj_in: str, proj_out: str
) -> tuple[float, float, float]:
    """Run `geo_convert x y z proj_in proj_out` -> (x, y, z) in proj_out.

    proj_in/proj_out: one of "l93", "geodetic", "work" (see geo_convert.cpp).
    """
    result = subprocess.run(
        [_binary(), str(x), str(y), str(z), proj_in, proj_out],
        check=True,
        capture_output=True,
        text=True,
    )
    ox, oy, oz = (float(v) for v in result.stdout.split())
    return ox, oy, oz
