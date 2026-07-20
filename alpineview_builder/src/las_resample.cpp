#include "las_resample.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>

#include <unordered_map>
#include <vector>

static CellKey cell_of(const Vec3 &p, float grid_res)
{
	return CellKey{(int32_t)floorf(p.x / grid_res),
		       (int32_t)floorf(p.y / grid_res)};
}

Grid build_grid(const Vec3 *pos, const Vec3 *nml, size_t point_num,
		float grid_res)
{
	Grid grid;
	grid.reserve(point_num / 4 + 1);
	for (size_t i = 0; i < point_num; ++i) {
		CellAccum &c = grid[cell_of(pos[i], grid_res)];
		c.sum_pos = c.sum_pos + pos[i];
		c.count++;
		if (dot(nml[i], nml[i]) > 0.f) {
			c.sum_nml = c.sum_nml + nml[i];
			c.nml_count++;
		}
	}
	return grid;
}

size_t flat_area_thin(Vec3 *pos, Vec3 *nml, size_t point_num, float grid_res,
		      int neighbor_radius, float slope_deg, bool verbose)
{
	if (grid_res <= 0.f || point_num == 0)
		return point_num;

	Grid grid = build_grid(pos, nml, point_num, grid_res);

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
		Vec3 mean_nml = c.nml_count > 0
					? c.sum_nml * (1.f / c.nml_count)
					: Vec3{0.f, 0.f, 0.f};
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

size_t fix_zero_normals(const Vec3 *pos, Vec3 *nml, size_t point_num,
			const Grid &grid, float grid_res, bool verbose)
{
	size_t fixed = 0;
	size_t zero_total = 0;
	for (size_t i = 0; i < point_num; ++i) {
		if (dot(nml[i], nml[i]) > 0.f)
			continue;
		++zero_total;

		CellKey key = cell_of(pos[i], grid_res);
		Vec3 sum_nml{0.f, 0.f, 0.f};
		int nml_count = 0;
		for (int dj = -1; dj <= 1; ++dj) {
			for (int di = -1; di <= 1; ++di) {
				auto it = grid.find(
					CellKey{key.i + di, key.j + dj});
				if (it == grid.end())
					continue;
				sum_nml = sum_nml + it->second.sum_nml;
				nml_count += it->second.nml_count;
			}
		}
		if (nml_count == 0)
			continue;

		Vec3 mean_nml = sum_nml * (1.f / nml_count);
		float len = sqrtf(dot(mean_nml, mean_nml));
		if (len <= 0.f)
			continue;
		mean_nml = mean_nml * (1.f / len);
		if (mean_nml.z < 0.f)
			mean_nml = mean_nml * -1.f;
		nml[i] = mean_nml;
		++fixed;
	}

	if (verbose) {
		printf("Grid normal fix-up          : grid %g : %zu recovered, "
		       "%zu still zero\n",
		       grid_res, fixed, zero_total - fixed);
	}

	return fixed;
}
