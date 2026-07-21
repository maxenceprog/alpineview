"""ewoks Task for the vegetation build step."""

from ewoks import BaseInputModel, Task
from ewokscore.model import BaseOutputModel
from pydantic import Field

from pathlib import Path

from ..core.vegetation import (
    DEFAULT_MIN_TREE_HEIGHT,
    DEFAULT_MIN_TREE_POINTS,
    DEFAULT_OUT,
    build_vegetation,
    has_vegetation_points,
    vegetation_outputs,
)


class BuildVegetationInputs(BaseInputModel):
    laz_path: str = Field(description="Downloaded LAZ for the cell")
    out_dir: str = Field(
        default=DEFAULT_OUT, description="Where the .veg.drc tiles are written"
    )
    min_tree_height: float = Field(
        default=DEFAULT_MIN_TREE_HEIGHT,
        description="Discard crowns shorter than this above ground (metres)",
    )
    min_tree_points: int = Field(
        default=DEFAULT_MIN_TREE_POINTS,
        description="Discard crowns with fewer points than this",
    )
    force: bool = Field(
        default=False, description="Rebuild even if the cell's .veg.drc tiles exist"
    )


class BuildVegetationOutputs(BaseOutputModel):
    veg_tiles: list[str] = Field(
        default_factory=list, description="Written LOD-2 .veg.drc tile paths"
    )


class BuildVegetation(
    Task, input_model=BuildVegetationInputs, output_model=BuildVegetationOutputs
):
    """Segment a cell's tree crowns and mesh them into LOD-2 Draco tiles."""

    def run(self):
        if not self.inputs.force:
            stem = Path(self.inputs.laz_path).name
            x_km, y_km = (int(p) for p in stem.split("_")[2:4])
            existing = vegetation_outputs(x_km, y_km, self.inputs.out_dir)
            if existing:
                self.outputs.veg_tiles = existing
                return
        if not has_vegetation_points(self.inputs.laz_path):
            return
        self.outputs.veg_tiles = build_vegetation(
            self.inputs.laz_path,
            self.inputs.out_dir,
            self.inputs.min_tree_height,
            self.inputs.min_tree_points,
        )
