#pragma once

#include <cstddef>
#include <vector>

#include "las_point_cloud.h"

/* Per-flight-line geometry, derived from the LAS source_id / scan_angle /
 * gps_time. Used to orient normals: the across-track azimuth plus a point's
 * scan angle give the beam direction, and a normal must face the scanner.
 *
 * theta_across is taken from a narrow gps_time window (~1% of the flight
 * line's span), i.e. a *single* scanline -- the one place the across-track
 * direction is actually measurable. Deriving it from the whole flight line
 * instead yields the along-track axis, which is what
 * CGAL::scanline_orient_normals does when handed source_id as a scanline id. */

struct SourceStat {
	int point_num;
	double min_gps;
	double max_gps;
	int8_t min_angle;
	int8_t max_angle;
};

struct SourceFlightLine {
	bool is_valid;
	float theta_along;
	float theta_across;
};

/* Fills points[i].source_idx with a dense index; returns the source count. */
int las_get_sources(std::vector<LasPoint> &points);

void las_stat_sources(const std::vector<LasPoint> &points,
		      std::vector<SourceStat> &stats);

/* Sets fls[i].theta_along / theta_across per source. A source whose two
 * azimuths are near-parallel (degenerate) is left is_valid = false and must
 * not be used for orientation. Returns the number of valid sources. */
int las_approx_flight_lines(const std::vector<LasPoint> &points,
			    const double *scale,
			    const std::vector<SourceStat> &stats,
			    std::vector<SourceFlightLine> &fls);
