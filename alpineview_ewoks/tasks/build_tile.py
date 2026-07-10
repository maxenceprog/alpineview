"""ewoks Tasks for the tiles build step (download + alpineview_builder)."""

from ewoks import BaseInputModel, Task
from ewokscore.model import BaseOutputModel
from pydantic import Field

from ..core.tiles import (
    DEFAULT_CACHE_DIR,
    DEFAULT_TILES_OUT,
    LOD_LEVEL,
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
    # Every default below is alpineview_builder's own default (see set_default_cfg()
    # in third-parties/LidarTerrainMesh/src/alpineview_builder.cpp) and lives only
    # here — run_alpineview_builder() itself takes all of these as required
    # arguments, so this is their single source of truth.
    depth: int = Field(default=10, description="Poisson reconstruction octree depth")
    weight: float = Field(default=4.0, description="Poisson point-weight parameter")
    lod: int = Field(
        default=LOD_LEVEL, description="Highest Draco LOD level to write (0..lod)"
    )
    trim: float = Field(default=0.0, description="Poisson mesh density trim threshold")
    parallel: bool = Field(
        default=False, description="Run PoissonRecon with parallel octree construction"
    )
    use_las: bool = Field(
        default=True, description="Read input as plain .las/.laz (no COPC)"
    )
    optimize: bool = Field(default=True, description="Optimize the final mesh")
    encode: bool = Field(default=False, description="Write an encoded .bin mesh")
    skirt_depth: float = Field(default=50.0, description="LOD tile skirt depth, metres")
    aratio: float = Field(
        default=0.005, description="Mesh simplification aspect-ratio threshold"
    )
    clean: int = Field(
        default=2, description="Mesh cleanup level (small-component removal)"
    )
    downsample: bool = Field(
        default=True, description="Enable normal-space voxel thinning before meshing"
    )
    ds_voxel: float = Field(
        default=-1.0,
        description="Thinning voxel size in metres; <= 0 = auto (2x estimated point-cloud scale)",
    )
    ds_cone: float = Field(
        default=35.0, description="Thinning normal-cluster half-angle, degrees"
    )
    ds_min_pts: int = Field(
        default=0, description="Thinning density floor (points per voxel); <= 0 = auto"
    )


class BuildTilesOutputs(BaseOutputModel):
    x_km: int = Field(description="Pass-through cell X")
    y_km: int = Field(description="Pass-through cell Y")
    tiles_dir: str = Field(description="Directory containing the .drc LOD tiles")
    stdout: str = Field(description="alpineview_builder stdout")


class BuildTiles(Task, input_model=BuildTilesInputs, output_model=BuildTilesOutputs):
    """Mesh one cell into Draco LOD tiles with alpineview_builder."""

    def run(self):
        self.outputs.stdout = run_alpineview_builder(
            self.inputs.x_km,
            self.inputs.y_km,
            self.inputs.cache_dir,
            self.inputs.out_dir,
            depth=self.inputs.depth,
            weight=self.inputs.weight,
            lod=self.inputs.lod,
            trim=self.inputs.trim,
            parallel=self.inputs.parallel,
            use_las=self.inputs.use_las,
            optimize=self.inputs.optimize,
            encode=self.inputs.encode,
            skirt_depth=self.inputs.skirt_depth,
            aratio=self.inputs.aratio,
            clean=self.inputs.clean,
            downsample=self.inputs.downsample,
            ds_voxel=self.inputs.ds_voxel,
            ds_cone=self.inputs.ds_cone,
            ds_min_pts=self.inputs.ds_min_pts,
        )
        self.outputs.x_km = self.inputs.x_km
        self.outputs.y_km = self.inputs.y_km
        self.outputs.tiles_dir = self.inputs.out_dir
