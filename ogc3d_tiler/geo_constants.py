"""Reader for geo_constants.json, the constants that place the terrain on the
globe. The C++ builders read the same file at run time; nothing anywhere keeps
a second copy of a value.

    from geo_constants import GEO          # from inside ogc3d_tiler

GEO exposes every entry's value as an attribute of the same name, plus the few
quantities derived from them. GEO.why(key) returns the entry's description, so
the reasoning is reachable from code as well as from the file.
"""

import json
import math
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / "geo_constants.json"


class Constants:
    def __init__(self, path=PATH):
        raw = json.loads(Path(path).read_text())
        self._entries = {k: v for k, v in raw.items() if not k.startswith("_")}
        for key, entry in self._entries.items():
            setattr(self, key, entry["value"])

        if self.cell_level >= self.lod_level0:
            raise ValueError(
                "cell_level (%d) must be coarser than lod_level0 (%d)"
                % (self.cell_level, self.lod_level0)
            )

        self.grs80_f = 1.0 / self.grs80_inv_f
        self.grs80_e2 = self.grs80_f * (2.0 - self.grs80_f)
        self.work_scale = 1.0 / math.cos(math.radians(self.lat_ref))
        self.work_extent = self.wmq_extent / self.work_scale

    def why(self, key):
        return "\n".join(self._entries[key]["description"])

    def unit(self, key):
        return self._entries[key]["unit"]


GEO = Constants()
