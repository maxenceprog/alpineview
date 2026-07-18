#include <float.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>

#include <unordered_map>

#include "math_utils.h"

#include "las_point_cloud.h"
#include "las_source.h"

int las_get_sources(std::vector<LasPoint> &points)
{
	uint16_t source_num = 0;
	std::unordered_map<uint16_t, uint16_t> id_to_idx;

	for (size_t i = 0; i < points.size(); ++i) {
		uint16_t id = points[i].source_id;
		auto it = id_to_idx.find(id);
		if (it != id_to_idx.end()) {
			points[i].source_idx = it->second;
		} else {
			id_to_idx.emplace(id, source_num);
			points[i].source_idx = source_num++;
		}
	}

	return (source_num);
}

void las_stat_sources(const std::vector<LasPoint> &points,
		      std::vector<SourceStat> &stats)
{
	for (size_t i = 0; i < stats.size(); ++i) {
		stats[i].point_num = 0;
		stats[i].min_gps = DBL_MAX;
		stats[i].max_gps = -DBL_MAX;
		stats[i].min_angle = 90;
		stats[i].max_angle = -90;
	}

	for (size_t i = 0; i < points.size(); ++i) {
		struct SourceStat &s = stats[points[i].source_idx];
		s.point_num++;
		s.min_angle = MIN(s.min_angle, points[i].scan_angle);
		s.max_angle = MAX(s.max_angle, points[i].scan_angle);
		s.min_gps = MIN(s.min_gps, points[i].gps_time);
		s.max_gps = MAX(s.max_gps, points[i].gps_time);
	}
}

static int set_repr_angle(int min, int max)
{
	int repr_angle;
	if ((max - min) <= 10) {
		repr_angle = (max + min) / 2;
	} else {
		/* get 5 deg security from flight line edge */
		min += 5;
		max -= 5;
		if (min <= 0 && max >= 0) {
			repr_angle = 0;
		} else if (min >= 0) {
			repr_angle = min;
		} else {
			repr_angle = max;
		}
	}
	return (repr_angle);
}

struct AlongFLSearch {
	double min_gps, max_gps;
	int repr_angle, angle_tol;
	int idx_of_min, idx_of_max;
};

struct AcrossFLSearch {
	double repr_gps, gps_tol;
	int min_angle, max_angle;
	int idx_of_min, idx_of_max;
};

static void init_along(const struct SourceStat &s, struct AlongFLSearch &al)
{
	al.repr_angle = set_repr_angle(s.min_angle, s.max_angle);
	al.angle_tol = 2;
	al.idx_of_min = al.idx_of_max = -1;
	al.min_gps = DBL_MAX;
	al.max_gps = -DBL_MAX;
}

static void init_across(const struct SourceStat &s, struct AcrossFLSearch &ac)
{
	ac.repr_gps = (s.max_gps + s.min_gps) / 2.0;
	ac.gps_tol = (s.max_gps - s.min_gps) / 100.0;
	ac.idx_of_min = ac.idx_of_max = -1;
	ac.min_angle = 90;
	ac.max_angle = -90;
}

static inline void update_along(const struct LasPoint &pt,
				struct AlongFLSearch &al, int i)
{
	if (abs(pt.scan_angle - al.repr_angle) <= al.angle_tol) {
		if (pt.gps_time > al.max_gps) {
			al.max_gps = pt.gps_time;
			al.idx_of_max = i;
		}
		if (pt.gps_time < al.min_gps) {
			al.min_gps = pt.gps_time;
			al.idx_of_min = i;
		}
	}
}

static inline void update_across(const struct LasPoint &pt,
				 struct AcrossFLSearch &ac, int i)
{
	if (fabs(pt.gps_time - ac.repr_gps) <= ac.gps_tol) {
		if (pt.scan_angle > ac.max_angle) {
			ac.max_angle = pt.scan_angle;
			ac.idx_of_max = i;
		}
		if (pt.scan_angle < ac.min_angle) {
			ac.min_angle = pt.scan_angle;
			ac.idx_of_min = i;
		}
	}
}

int las_approx_flight_lines(const std::vector<LasPoint> &points,
			    const double *scale,
			    const std::vector<SourceStat> &stats,
			    std::vector<SourceFlightLine> &fls)
{
	int source_num = (int)stats.size();
	int point_num = (int)points.size();
	std::vector<AlongFLSearch> along(source_num);
	std::vector<AcrossFLSearch> across(source_num);

	for (int i = 0; i < source_num; ++i) {
		init_along(stats[i], along[i]);
		init_across(stats[i], across[i]);
	}

	for (int i = 0; i < point_num; ++i) {
		const struct LasPoint &pt = points[i];
		update_along(pt, along[pt.source_idx], i);
		update_across(pt, across[pt.source_idx], i);
	}

	int ret = 0;
	for (int i = 0; i < source_num; ++i) {
		const struct AlongFLSearch &al = along[i];
		const struct AcrossFLSearch &ac = across[i];
		struct SourceFlightLine &fl = fls[i];

		fl.is_valid = false;
		if (al.idx_of_min == -1 || al.idx_of_max == -1) {
			continue;
		}
		if (ac.idx_of_min == -1 || ac.idx_of_max == -1) {
			continue;
		}

		const struct LasPoint &p0 = points[al.idx_of_min];
		const struct LasPoint &p1 = points[al.idx_of_max];
		const struct LasPoint &p2 = points[ac.idx_of_min];
		const struct LasPoint &p3 = points[ac.idx_of_max];
		if ((p0.x == p1.x && p0.y == p1.y) ||
		    (p2.x == p3.x && p2.y == p3.y)) {
			continue;
		}

		double dx, dy, theta_al, theta_ac;

		dx = (p1.x - p0.x) * scale[0];
		dy = (p1.y - p0.y) * scale[1];
		theta_al = atan2(dy, dx);
		dx = (p3.x - p2.x) * scale[0];
		dy = (p3.y - p2.y) * scale[1];
		theta_ac = atan2(dy, dx);
		/* sin(theta_ac - theta_al): reject near-parallel axes, where
		 * the across-track direction is not actually resolved. */
		double check = cos(theta_al) * sin(theta_ac) -
			       cos(theta_ac) * sin(theta_al);
		if (fabs(check) >= 0.5) {
			fl.is_valid = true;
			fl.theta_along = theta_al;
			fl.theta_across = theta_ac;
			ret++;
		}
	}
	return (ret);
}
