#pragma once

#include <string>

#include "mesh.h"
#include "vec3.h"

/* Shared between alpineview_builder (fine, LiDAR-driven) and
 * alpineview_coarse (coarse, RGE ALTI-driven): both reconstruct a Poisson
 * mesh per LOD level and then run the same "reconstructed mesh -> written
 * tile" tail. */

/* Maps the Poisson [0,1] cube back to the tile: scale is the tile-to-cube
 * factor, shift is the tile's origin inside the cube. */
struct Transform {
	float scale;
	Vec3 shift;
};

/* Fetch the value following a flag, advancing *i. Returns NULL (and prints an
 * error) when the flag is the last token and has no value. */
const char *flag_value(int argc, const char **argv, int *i);

/* Triangle budget to have median file size of maximum 90kB */
inline constexpr int DEFAULT_TRIANGLE_TARGET_COUNT = 45000;

/* Run the PoissonRecon binary. */
int run_poisson_recon(const std::string &recon_in, const std::string &recon_out,
					  int depth, float weight, bool verbose, bool parallel,
					  bool performance);

/* Clip to the central tile, discarding the Poisson reconstruction buffer. */
void recut_mesh(TriMesh &mesh, const Transform &transf);

/* Inverse-transform points from the Poisson [0,1] cube back to tile-relative
 * metres. */
void rescale_mesh(TriMesh &mesh, const Transform &transf);

/* Post process a mesh then write .glb files */
int postprocess_lod_level(TriMesh &mesh, const Transform &transf, int level0,
						  int x, int y, int z, const std::string &out_dir,
						  bool optimize, bool verbose);
