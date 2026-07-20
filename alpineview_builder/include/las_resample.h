#pragma once

#include <cstddef>
#include <cstdint>
#include <unordered_map>

#include "vec3.h"

/* Grid downsampling: keeps detail on steep terrain, reduces it where the
 * terrain is less steep. grid_res is in metres; resolved by the caller. */
struct DownsampleCfg {
	bool enabled;
	float grid_res;
	int neighbor_radius;
	float slope_deg;
};

struct CellKey
{
	int32_t i, j;
	bool operator==(const CellKey &o) const
	{
		return i == o.i && j == o.j;
	}
};
struct CellKeyHash
{
	size_t operator()(const CellKey &c) const
	{
		return (size_t)(c.i * 73856093) ^ (size_t)(c.j * 19349663);
	}
};

struct CellAccum
{
	Vec3 sum_pos{0.f, 0.f, 0.f};
	Vec3 sum_nml{0.f, 0.f, 0.f};
	int count = 0;     /* all points in the cell */
	int nml_count = 0; /* points with a non-zero (resolved) normal */
};
using Grid = std::unordered_map<CellKey, CellAccum, CellKeyHash>;

/* Bins pos[]/nml[] into an XY grid of grid_res-sized cells (same units as
 * pos). A point's normal only counts towards a cell's nml_count/sum_nml
 * when it's non-zero, so callers can average resolved normals only, without
 * an unresolved (zero-normal) point dragging the average down. */
Grid build_grid(const Vec3 *pos, const Vec3 *nml, size_t point_num,
				float grid_res);

size_t flat_area_thin(Vec3 *pos, Vec3 *nml, size_t point_num, float grid_res,
					  int neighbor_radius, float slope_deg, bool verbose);

/* For every point whose normal is (0,0,0) -- undetermined by
 * cgal_estimate_and_orient_normals -- average the valid (non-zero) normals
 * in the 3x3 grid-cell block around it and orient the result to face up
 * (+Z). Terrain is assumed tight (single-valued, no overhangs) at this
 * scale, so no confidence gating is applied here unlike the beam/+Z passes.
 * Points with no valid neighbor normal are left at (0,0,0). Returns the
 * number of normals recovered. */
size_t fix_zero_normals(const Vec3 *pos, Vec3 *nml, size_t point_num,
						const Grid &grid, float grid_res, bool verbose);
