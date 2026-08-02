#pragma once

#include <vector>

#include "mesh.h"
#include "mesh_clip.h"

/* Level-of-detail tiling + Draco compression.
 *
 * Given one level's surface mesh of a WebMercatorQuad job tile (positions in
 * tile-side units: x,y in [0,1] relative to the tile's west/south edge, z
 * absolute ellipsoidal height over that same scale), this crops it into the
 * 2^z x 2^z sub-tiles of that tile and writes each as a Draco-compressed .glb.
 *
 * Each level's mesh comes from its own Poisson reconstruction, so no
 * decimation happens here; the shared grid the levels are cut on is what keeps
 * their seams matching.
 */
struct LodCfg
{
	int max_level; /* highest zoom level to emit; < 0 disables the stage */
};

/* Tile the mesh of the WebMercatorQuad tile (tile_x, tile_y) at base_level
 * into its 2^z x 2^z sub-tiles at level base_level + z,
 * named {cell_x}.{cell_y}/{level}/{x}.{y}.glb, every index relative to the
 * cell_level cell so a 3D Tiles implicit content template resolves them.
 *
 * Vertices are ENU metres about the geodetic centre of the enclosing
 * cell_level cell, written into the glTF Y-up as 3D Tiles requires
 * (gltf_xyz = enu_x, enu_z, -enu_y) so a renderer's Y-up -> Z-up rotation
 * lands them back in ENU.
 *
 * Nothing else is written: the tiler recovers the cell from the tile key
 * (key >> (level - cell_level)), the ENU -> ECEF transform from the cell's
 * centre by the same closed-form geodesy, and the tile-frame AABB from the
 * glTF accessor min/max (rotating it back out of Y-up). */
int write_lod_level(const TriMesh &mesh, int base_level, int tile_x,
					int tile_y, int z, const char *out_dir, bool verbose);
