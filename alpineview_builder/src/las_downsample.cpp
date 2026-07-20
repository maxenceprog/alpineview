#include "las_downsample.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>

#include <unordered_map>
#include <vector>

struct CellKey {
	int32_t i, j;
	bool operator==(const CellKey &o) const
	{
		return i == o.i && j == o.j;
	}
};
struct CellKeyHash {
	size_t operator()(const CellKey &c) const
	{
		return (size_t)(c.i * 73856093) ^ (size_t)(c.j * 19349663);
	}
};

struct CellAccum {
	Vec3 sum_pos{0.f, 0.f, 0.f};
	Vec3 sum_nml{0.f, 0.f, 0.f};
	int count = 0;
};

static CellKey cell_of(const Vec3 &p, float grid_res)
{
	return CellKey{(int32_t)floorf(p.x / grid_res),
		       (int32_t)floorf(p.y / grid_res)};
}

size_t flat_area_thin(Vec3 *pos, Vec3 *nml, size_t point_num, float grid_res,
		      int neighbor_radius, float slope_deg, bool verbose)
{
	if (grid_res <= 0.f || point_num == 0)
		return point_num;

	std::unordered_map<CellKey, CellAccum, CellKeyHash> grid;
	grid.reserve(point_num / 4 + 1);
	for (size_t i = 0; i < point_num; ++i) {
		CellAccum &c = grid[cell_of(pos[i], grid_res)];
		c.sum_pos = c.sum_pos + pos[i];
		c.sum_nml = c.sum_nml + nml[i];
		c.count++;
	}

	std::unordered_map<CellKey, float, CellKeyHash> mean_z;
	mean_z.reserve(grid.size());
	for (const auto &kv : grid)
		mean_z[kv.first] = kv.second.sum_pos.z / kv.second.count;

	std::unordered_map<CellKey, bool, CellKeyHash> is_flat;
	is_flat.reserve(grid.size());
	for (const auto &kv : grid) {
		const CellKey &key = kv.first;
		CellKey max_key = key, min_key = key;
		float max_z = mean_z[key], min_z = mean_z[key];
		for (int dj = -neighbor_radius; dj <= neighbor_radius; ++dj) {
			for (int di = -neighbor_radius; di <= neighbor_radius;
			     ++di) {
				CellKey nk{key.i + di, key.j + dj};
				auto it = mean_z.find(nk);
				if (it == mean_z.end())
					continue;
				if (it->second > max_z) {
					max_z = it->second;
					max_key = nk;
				}
				if (it->second < min_z) {
					min_z = it->second;
					min_key = nk;
				}
			}
		}
		float dx = (float)(max_key.i - min_key.i) * grid_res;
		float dy = (float)(max_key.j - min_key.j) * grid_res;
		float horiz = sqrtf(dx * dx + dy * dy);
		float slope = horiz > 0.f
				  ? atan2f(fabsf(max_z - min_z), horiz) *
					180.f / (float)M_PI
				  : 0.f;
		is_flat[key] = slope < slope_deg;
	}

	std::vector<Vec3> out_pos;
	std::vector<Vec3> out_nml;
	out_pos.reserve(point_num);
	out_nml.reserve(point_num);

	for (size_t i = 0; i < point_num; ++i) {
		CellKey key = cell_of(pos[i], grid_res);
		if (!is_flat[key]) {
			out_pos.push_back(pos[i]);
			out_nml.push_back(nml[i]);
		}
	}

	for (const auto &kv : grid) {
		if (!is_flat[kv.first])
			continue;
		const CellAccum &c = kv.second;
		Vec3 mean_pos = c.sum_pos * (1.f / c.count);
		Vec3 mean_nml = c.sum_nml * (1.f / c.count);
		float len = sqrtf(dot(mean_nml, mean_nml));
		if (len > 0.f)
			mean_nml = mean_nml * (1.f / len);
		out_pos.push_back(mean_pos);
		out_nml.push_back(mean_nml);
	}

	size_t out = out_pos.size();
	for (size_t i = 0; i < out; ++i) {
		pos[i] = out_pos[i];
		nml[i] = out_nml[i];
	}

	if (verbose) {
		printf("Grid thinning               : grid %g radius %d "
		       "slope %.0f deg : %zu -> %zu pts (%.1f%%)\n",
		       grid_res, neighbor_radius, slope_deg, point_num, out,
		       point_num ? 100.0 * out / point_num : 0.0);
	}

	return out;
}
