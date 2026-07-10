"""ewoks Task for the buildings build step."""

from ewoks import BaseInputModel, Task
from ewokscore.model import BaseOutputModel
from pydantic import Field

from ..core.buildings import DEFAULT_OUT, DEFAULT_ROOFER, build_buildings


class BuildBuildingsInputs(BaseInputModel):
    laz_path: str = Field(description="Downloaded LAZ for the cell")
    out_dir: str = Field(
        default=DEFAULT_OUT, description="Where the .city.jsonl is written"
    )
    roofer_bin: str = Field(
        default=DEFAULT_ROOFER, description="Path to the roofer binary"
    )


class BuildBuildingsOutputs(BaseOutputModel):
    city_path: str | None = Field(
        default=None, description="Path to the .city.jsonl, or None"
    )


class BuildBuildings(
    Task, input_model=BuildBuildingsInputs, output_model=BuildBuildingsOutputs
):
    """Reconstruct a cell's buildings with roofer."""

    def run(self):
        self.outputs.city_path = build_buildings(
            self.inputs.laz_path, self.inputs.out_dir, self.inputs.roofer_bin
        )
