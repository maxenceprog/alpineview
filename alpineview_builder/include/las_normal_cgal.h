#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

#include "las_point_cloud.h"
#include "vec3.h"

/* CGAL-based normal pipeline, replacing las_normal.h's custom PCA +
 * scanline/z/propagation orientation passes (validated in the repo's
 * cpp_recon_standalone prototype):
 *
 *   1. cgal_estimate_scale()               -- CGAL::estimate_global_range_scale
 *      on a spatial window of the cloud;
 *   2. cgal_estimate_and_orient_normals()  -- PCA plane fit over capped
 *      spherical neighborhoods, then CGAL::scanline_orient_normals.
 *
 * Every kept point gets a unit, scanline-oriented normal. Unreliable LAS
 * classes (1 = unclassified, 3 = low vegetation) are excluded upstream by
 * alpineview_builder.cpp's filter_las_point(), so this pipeline never sees them.
 */

/* Global range scale of the cloud (same units as `pos`), estimated on a
 * spatial window of ~window_target points around the XY bbox center --
 * a spatial subset preserves local density where a random subsample would
 * dilute it and inflate the estimate. */
double cgal_estimate_scale(const Vec3 *pos, size_t point_num,
			   size_t window_target = 40000);

/* Estimate normals with CGAL::pca_estimate_normals (neighborhood = the
 * nearest neighbors within `neighbor_radius`, capped to the 15 nearest;
 * pass radius = 2 x cgal_estimate_scale()), refit non-planar
 * neighborhoods with a jet (Monge) fit, then orient the result with
 * CGAL::scanline_orient_normals using the LAS scan_angle / source_id of
 * `points`.
 *
 * `points[i]` must correspond to pos[i]/nml[i], and the whole cloud must be
 * sorted by (source_id, gps_time) so scanlines are contiguous and in
 * acquisition order. Prints per-stage timings when verbose. */
void cgal_estimate_and_orient_normals(const Vec3 *pos, size_t point_num,
				      const std::vector<LasPoint> &points,
				      double neighbor_radius, Vec3 *nml,
				      bool verbose);
