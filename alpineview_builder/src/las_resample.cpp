#include "las_resample.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>

#include <unordered_map>
#include <vector>

static CellKey cellOf(const Vec3 &p, float gridRes) {
	return CellKey{(int32_t)floorf(p.x / gridRes),
				   (int32_t)floorf(p.y / gridRes)};
}

Grid build_grid(const Vec3 *pos, const Vec3 *nml, size_t pointNum,
				float gridRes) {
	Grid grid;
	grid.reserve(pointNum / 4 + 1);
	for (size_t i = 0; i < pointNum; ++i) {
		CellAccum &c = grid[cellOf(pos[i], gridRes)];
		c.sum_pos = c.sum_pos + pos[i];
		c.count++;
		if (dot(nml[i], nml[i]) > 0.f) {
			c.sum_nml = c.sum_nml + nml[i];
			c.nml_count++;
		}
	}
	return grid;
}

size_t flat_area_thin(Vec3 *pos, Vec3 *nml, size_t pointNum, float gridRes,
					  int neighborRadius, float slopeDeg, bool verbose) {
	if (gridRes <= 0.f || pointNum == 0)
		return pointNum;

	Grid grid = build_grid(pos, nml, pointNum, gridRes);

	std::unordered_map<CellKey, float, CellKeyHash> meanZ;
	meanZ.reserve(grid.size());
	for (const auto &kv : grid)
		meanZ[kv.first] = kv.second.sum_pos.z / kv.second.count;

	std::unordered_map<CellKey, bool, CellKeyHash> isFlat;
	isFlat.reserve(grid.size());
	for (const auto &kv : grid) {
		const CellKey &key = kv.first;
		CellKey maxKey = key, minKey = key;
		float maxZ = meanZ[key], minZ = meanZ[key];
		for (int dj = -neighborRadius; dj <= neighborRadius; ++dj) {
			for (int di = -neighborRadius; di <= neighborRadius; ++di) {
				CellKey nk{key.i + di, key.j + dj};
				auto it = meanZ.find(nk);
				if (it == meanZ.end())
					continue;
				if (it->second > maxZ) {
					maxZ = it->second;
					maxKey = nk;
				}
				if (it->second < minZ) {
					minZ = it->second;
					minKey = nk;
				}
			}
		}
		float dx = (float)(maxKey.i - minKey.i) * gridRes;
		float dy = (float)(maxKey.j - minKey.j) * gridRes;
		float horiz = sqrtf(dx * dx + dy * dy);
		float slope = horiz > 0.f ? atan2f(fabsf(maxZ - minZ), horiz) * 180.f /
										(float)M_PI
								  : 0.f;
		isFlat[key] = slope < slopeDeg;
	}

	std::vector<Vec3> outPos;
	std::vector<Vec3> outNml;
	outPos.reserve(pointNum);
	outNml.reserve(pointNum);

	for (size_t i = 0; i < pointNum; ++i) {
		CellKey key = cellOf(pos[i], gridRes);
		if (!isFlat[key]) {
			outPos.push_back(pos[i]);
			outNml.push_back(nml[i]);
		}
	}

	for (const auto &kv : grid) {
		if (!isFlat[kv.first])
			continue;
		const CellAccum &c = kv.second;
		Vec3 meanPos = c.sum_pos * (1.f / c.count);
		Vec3 meanNml = c.nml_count > 0 ? c.sum_nml * (1.f / c.nml_count)
									   : Vec3{0.f, 0.f, 0.f};
		float len = sqrtf(dot(meanNml, meanNml));
		if (len > 0.f)
			meanNml = meanNml * (1.f / len);
		outPos.push_back(meanPos);
		outNml.push_back(meanNml);
	}

	size_t out = outPos.size();
	for (size_t i = 0; i < out; ++i) {
		pos[i] = outPos[i];
		nml[i] = outNml[i];
	}

	if (verbose) {
		printf("Grid thinning               : grid %g radius %d "
			   "slope %.0f deg : %zu -> %zu pts (%.1f%%)\n",
			   gridRes, neighborRadius, slopeDeg, pointNum, out,
			   pointNum ? 100.0 * out / pointNum : 0.0);
	}

	return out;
}

size_t fix_zero_normals(const Vec3 *pos, Vec3 *nml, size_t pointNum,
						const Grid &grid, float gridRes, bool verbose) {
	size_t fixed = 0;
	size_t zeroTotal = 0;
	for (size_t i = 0; i < pointNum; ++i) {
		if (dot(nml[i], nml[i]) > 0.f)
			continue;
		++zeroTotal;

		CellKey key = cellOf(pos[i], gridRes);
		Vec3 sumNml{0.f, 0.f, 0.f};
		int nmlCount = 0;
		for (int dj = -1; dj <= 1; ++dj) {
			for (int di = -1; di <= 1; ++di) {
				auto it = grid.find(CellKey{key.i + di, key.j + dj});
				if (it == grid.end())
					continue;
				sumNml = sumNml + it->second.sum_nml;
				nmlCount += it->second.nml_count;
			}
		}
		if (nmlCount == 0)
			continue;

		Vec3 meanNml = sumNml * (1.f / nmlCount);
		float len = sqrtf(dot(meanNml, meanNml));
		if (len <= 0.f)
			continue;
		meanNml = meanNml * (1.f / len);
		if (meanNml.z < 0.f)
			meanNml = meanNml * -1.f;
		nml[i] = meanNml;
		++fixed;
	}

	if (verbose) {
		printf("Grid normal fix-up          : grid %g : %zu recovered, "
			   "%zu still zero\n",
			   gridRes, fixed, zeroTotal - fixed);
	}

	return fixed;
}
