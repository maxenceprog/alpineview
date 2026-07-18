#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

#include "las_point_cloud.h"
#include "vec3.h"

/* CGAL-based normal pipeline:
 *
 *   1. cgal_estimate_scale()               -- CGAL::estimate_global_range_scale
 *      on a spatial window of the cloud;
 *   2. cgal_estimate_and_orient_normals()  -- PCA plane fit over capped
 *      spherical neighborhoods, then a beam pass for orientation.
 *
 * The estimation is CGAL's; the orientation is the pre-CGAL pipeline's beam
 * test (las_source.h), which CGAL::scanline_orient_normals cannot replace here
 * -- see cgal_estimate_and_orient_normals below.
 *
 * Every kept point gets a unit, beam-oriented normal. Unreliable LAS
 * classes (1 = unclassified, 3 = low vegetation) are excluded upstream by
 * alpineview_builder.cpp's filter_las_point(), so this pipeline never sees them.
 */

/* Global range scale of the cloud (same units as `pos`), estimated on a
 * spatial window of ~window_target points around the XY bbox center --
 * a spatial subset preserves local density where a random subsample would
 * dilute it and inflate the estimate. */
double cgal_estimate_scale(const Vec3 *pos, size_t point_num,
			   size_t window_target = 40000);

/* Estimate normals by PCA plane fit (neighborhood = the nearest neighbors
 * within `neighbor_radius`, capped to the 15 nearest; pass radius =
 * 2 x cgal_estimate_scale()), refit non-planar neighborhoods with a jet
 * (Monge) fit, then orient the result from the LAS scan_angle / source_id of
 * `points`.
 *
 * `points[i]` must correspond to pos[i]/nml[i]; source_idx is filled in place.
 * Prints per-stage timings when verbose.
 *
 * Orientation builds each point's beam from its flight line's across-track
 * azimuth (las_source.h) and its own scan angle, and flips the normal to face
 * the scanner. This replaces CGAL::scanline_orient_normals, which was fed
 * source_id as a scanline id -- a flight line, not a scanline. CGAL then
 * PCA-fit a single line through a whole strip, yielding the along-track axis
 * instead of the across-track one (measured on 0963_6423: 125.7 deg vs 13.9
 * deg for the real scanlines), which flips the sign of dot(normal, beam) on
 * steep faces and mis-orients them.
 *
 * Both the beam pass and the +Z pass that follows it are confidence-gated:
 * they abstain rather than guess when the test is too close to zero (on a
 * cliff the beam grazes the surface, so dot(normal, beam) ~ 0 and its sign is
 * noise). A point that clears neither gate, or whose flight line came out
 * degenerate, still carries the PCA's arbitrary sign; those points are
 * dropped -- feeding a coin-flipped normal to Poisson is worse than feeding
 * nothing. The pre-CGAL pipeline instead recovered them by majority-vote
 * propagation from oriented neighbors (see las_normal.cpp).
 *
 * `pos` and `nml` are compacted in place; returns the surviving point count,
 * which no longer matches `points`. */
size_t cgal_estimate_and_orient_normals(Vec3 *pos, size_t point_num,
					std::vector<LasPoint> &points,
					double neighbor_radius, Vec3 *nml,
					bool verbose);
