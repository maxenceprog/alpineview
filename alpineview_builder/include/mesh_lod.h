#pragma once

#include <vector>

#include "mesh.h"
#include "mesh_clip.h"

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

/* One emitted 3D Tiles content tile: its web-grid index (tx,ty,z) and its
 * axis-aligned bounds in the cell-local km content frame (x,y in [0,1], z in
 * km). Collected across levels then written into the per-cell tileset.json. */
struct CellTile {
	int tx, ty, z;
	Vec3d lo, hi;
};

/* Write the LOD glTF tiles for a single zoom level `z` from `mesh`, at full
 * resolution (no vertex-cluster simplification): the mesh is cropped into the
 * 2^z x 2^z sub-tile grid, skirted and Draco-glTF-encoded. Each written tile is
 * appended to `tiles`. Returns the number of .glb files written. */
int write_lod_level(const Mesh &mesh, const MBuf &data, int x_km, int y_km,
		    int z, float skirt_depth, const char *out_dir, bool verbose,
		    std::vector<CellTile> &tiles);

/* Write the per-cell bill-of-materials sidecar (bom.{x_km}.{y_km}.jsonl): one
 * JSON line per emitted tile with its web-grid index (tx,ty,z) and local km
 * bounds. The 3D Tiles tree (transforms, geometricError, hierarchy) is built
 * from these on the Python side. Returns 0 on success. */
int write_cell_index(int x_km, int y_km, const std::vector<CellTile> &tiles,
		     const char *out_dir);
