#pragma once

#include "mesh.h"

/* Level-of-detail tiling + Draco compression.
 *
 * C++ port of the final stage of scripts/tile_build_batch.py::_build_tile.
 * Given the final 1 km surface mesh (positions in km: x,y in [0,1] relative to
 * the tile's west/south edge, z absolute altitude in km), this writes Draco
 * (.drc) web tiles for every zoom level 0..max_level into out_dir:
 *
 *   level z -> n = 2^z grid of (1km / n) sub-tiles, vertex-cluster simplified
 *   (factor 16, 4, then full res for z >= 2), each cropped, skirted and
 *   Draco-encoded as tile.{x_km*n+dx}.{(y_km-1)*n+dy}.{z}.drc
 *
 * Simplification per level is done ONCE on a shared voxel grid before cropping
 * so adjacent sub-tiles decimate identically and their seams match.
 */
struct LodCfg {
	int max_level;	  /* highest zoom level to emit; < 0 disables the stage */
	float skirt_depth; /* boundary skirt extrusion (m); 0 disables skirts   */
};

/* Write the LOD Draco tiles. Returns the number of .drc files written, or 0
 * when disabled (cfg.max_level < 0) or the mesh is empty. */
int write_lod_tiles(const Mesh &mesh, const MBuf &data, int x_km, int y_km,
		    const LodCfg &cfg, const char *out_dir, bool verbose);

/* Write the Draco tiles for a single zoom level `z` from `mesh`, at full
 * resolution (no vertex-cluster simplification): the mesh is cropped into the
 * 2^z x 2^z sub-tile grid, skirted and Draco-encoded. Used when each level is
 * sourced from its own native (coarse) Poisson reconstruction rather than by
 * decimating the finest mesh. Returns the number of .drc files written. */
int write_lod_level(const Mesh &mesh, const MBuf &data, int x_km, int y_km,
		    int z, float skirt_depth, const char *out_dir, bool verbose);
