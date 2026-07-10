#pragma once

#include <cstddef>

#include "vec3.h"

/* Normal-space voxel thinning (replaces the previous planarity-cell
 * downsampling and scanline collinearity thinning; validated in the repo's
 * cpp_recon_standalone prototype).
 *
 * One survivor per (voxel, normal cluster); voxels with <= min_pts points
 * are kept whole (density floor). Clustering is greedy on oriented normals:
 * a point joins the first cluster whose mean normal is within cone_deg,
 * else starts a new one. Consequences, by construction:
 *   - redundant flat ground collapses to ~1 point per voxel;
 *   - a voxel astride a ridge/crease keeps one point per face;
 *   - a sparse steep face never reaches the clustering stage at all
 *     (density floor), so low-density cliffs/overhangs are never thinned.
 * The survivor of a cluster is the *original* point closest to the cluster
 * centroid -- no synthesized positions.
 *
 * User-facing parameters (alpineview_builder CLI); the resolved voxel size is
 * computed by the caller since voxel_size is in metres while thinning runs
 * on unit-cube coordinates. */
struct DownsampleCfg {
	bool enabled;	  /* skip the whole pass when false */
	float voxel_size; /* m; <= 0 = auto (2 x estimated scale) */
	float cone_deg;	  /* normal cluster half-angle, degrees */
	int min_pts;	  /* density floor; <= 0 = auto (half the nominal
			   * per-voxel point count) */
};

/* Thin pos/nml (same units for `voxel` and `pos`) in place, preserving
 * order; returns the new point count. */
size_t normal_space_thin(Vec3 *pos, Vec3 *nml, size_t point_num, float voxel,
			 float cone_deg, int min_pts, bool verbose);
