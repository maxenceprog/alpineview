#pragma once

#include <cstddef>

#include "vec3.h"

/* Grid downsampling: keeps detail on steep terrain, reduces it where the
 * terrain is less steep. grid_res is in metres; resolved by the caller. */
struct DownsampleCfg {
	bool enabled;
	float grid_res;
	int neighbor_radius;
	float slope_deg;
};


size_t flat_area_thin(Vec3 *pos, Vec3 *nml, size_t point_num, float grid_res,
		      int neighbor_radius, float slope_deg, bool verbose);
