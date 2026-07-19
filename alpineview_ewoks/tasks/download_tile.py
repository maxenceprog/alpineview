from ewoks import BaseInputModel, Task
from ewokscore.model import BaseOutputModel
from pydantic import Field

from ..core.tiles import (
    DEFAULT_CACHE_DIR,
    DEFAULT_RESOLUTION,
    download_cell_and_neighbours,
    download_cell_laz,
)


class DownloadTileInputs(BaseInputModel):
    x_km: int = Field(description="Cell X in km (LAZ NW-corner west edge)")
    y_km: int = Field(description="Cell Y in km (LAZ NW-corner north edge)")
    download_from_ign: bool = False
    cache_dir: str = Field(default=DEFAULT_CACHE_DIR, description="LAZ cache directory")
    resolution: int = Field(
        default=DEFAULT_RESOLUTION, description="COPC fetch resolution in metres"
    )
    download_neighbor: bool = Field(
        default=False,
        description="Also fetch the 4 neighbouring cells into cache_dir (needed by alpineview_builder's buffer)",
    )


class DownloadTileOutputs(BaseOutputModel):
    x_km: int = Field(description="Pass-through cell X")
    y_km: int = Field(description="Pass-through cell Y")
    laz_path: str = Field(description="Path to the downloaded LAZ")


class DownloadTile(
    Task, input_model=DownloadTileInputs, output_model=DownloadTileOutputs
):
    """Download the LiDAR HD LAZ for one 1 km cell."""

    def run(self):
        self.outputs.x_km = self.inputs.x_km
        self.outputs.y_km = self.inputs.y_km
        download = (
            download_cell_and_neighbours
            if self.inputs.download_neighbor
            else download_cell_laz
        )
        self.outputs.laz_path = download(
            self.inputs.x_km,
            self.inputs.y_km,
            self.inputs.cache_dir,
            resolution=self.inputs.resolution,
            download_from_ign=self.inputs.download_from_ign,
        )
