"""ewoks Tasks for the tiles build step (download + alpineview_builder)."""

from typing import Sequence

from ewoks import BaseInputModel, Task
from ewokscore.model import BaseOutputModel
from pydantic import Field

from ..core.tiles import (
    DEFAULT_CACHE_DIR,
    DEFAULT_TILES_OUT,
    LOD_LEVEL,
    cell_outputs_exist,
    run_alpineview_builder,
)


class BuildTilesInputs(BaseInputModel):
    x_km: int = Field(description="Cell X in km")
    y_km: int = Field(description="Cell Y in km")
    laz_path: str = Field(description="Downloaded LAZ (ensures download ran first)")
    cache_dir: str = Field(default=DEFAULT_CACHE_DIR, description="LAZ cache directory")
    out_dir: str = Field(
        default=DEFAULT_TILES_OUT, description="Where .drc tiles are written"
    )
    builder_options: Sequence[str] = Field(
        default=(),
        description="alpineview_builder tuning knobs",
    )
    force: bool = Field(
        default=False, description="Rebuild even if the cell's tiles already exist"
    )


class BuildTilesOutputs(BaseOutputModel):
    x_km: int = Field(description="Pass-through cell X")
    y_km: int = Field(description="Pass-through cell Y")
    tiles_dir: str = Field(description="Directory containing the .drc LOD tiles")


class BuildTiles(Task, input_model=BuildTilesInputs, output_model=BuildTilesOutputs):
    """Mesh one cell into Draco LOD tiles with alpineview_builder."""

    def run(self):
        self.outputs.x_km = self.inputs.x_km
        self.outputs.y_km = self.inputs.y_km
        self.outputs.tiles_dir = self.inputs.out_dir
        if not self.inputs.force and cell_outputs_exist(
            self.inputs.x_km,
            self.inputs.y_km,
            self.inputs.out_dir,
            LOD_LEVEL,
        ):
            return
        run_alpineview_builder(
            self.inputs.x_km,
            self.inputs.y_km,
            self.inputs.cache_dir,
            self.inputs.out_dir,
            self.inputs.builder_options,
        )
