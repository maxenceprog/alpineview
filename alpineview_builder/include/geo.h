#pragma once

#include <stddef.h>

#include "geo_constants.h"
#include "vec3.h"

int geo_init(void);
void geo_fini(void);

int geo_l93_to_geodetic(Vec3d *pts, size_t num);
int geo_geodetic_to_l93(Vec3d *pts, size_t num);

Vec3d geo_geodetic_to_work(const Vec3d &geodetic);
Vec3d geo_work_to_geodetic(const Vec3d &work);

double geo_wmq_tile_size(int level);
void geo_wmq_tile_of(double work_x, double work_y, int level, int &tx, int &ty);
void geo_wmq_tile_bounds(int level, int tx, int ty, double &x0, double &y0,
						 double &x1, double &y1);
