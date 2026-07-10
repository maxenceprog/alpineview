#include "las_downsample.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>

#include <unordered_map>
#include <vector>

/* Spatial hash for a 3D voxel index (Teschner et al.). */
struct VoxelKey {
	int32_t i, j, k;
	bool operator==(const VoxelKey &o) const
	{
		return i == o.i && j == o.j && k == o.k;
	}
};
struct VoxelKeyHash {
	size_t operator()(const VoxelKey &v) const
	{
		return (size_t)(v.i * 73856093) ^ (size_t)(v.j * 19349663) ^
		       (size_t)(v.k * 83492791);
	}
};

size_t normal_space_thin(Vec3 *pos, Vec3 *nml, size_t point_num, float voxel,
			 float cone_deg, int min_pts, bool verbose)
{
	if (voxel <= 0.f || point_num == 0)
		return point_num;

	std::unordered_map<VoxelKey, std::vector<uint32_t>, VoxelKeyHash> voxels;
	voxels.reserve(point_num / 4 + 1);
	for (size_t i = 0; i < point_num; ++i) {
		VoxelKey key{(int32_t)floorf(pos[i].x / voxel),
			     (int32_t)floorf(pos[i].y / voxel),
			     (int32_t)floorf(pos[i].z / voxel)};
		voxels[key].push_back((uint32_t)i);
	}

	std::vector<bool> keep(point_num, true);
	const float cos_cone = cosf(cone_deg * (float)M_PI / 180.f);
	std::vector<std::vector<uint32_t>> clusters;
	std::vector<Vec3> cluster_nml_sum;
	for (const auto &kv : voxels) {
		const std::vector<uint32_t> &idx = kv.second;
		if ((int)idx.size() <= min_pts)
			continue; /* density floor: keep the whole voxel */

		/* Greedy normal clustering: join the first cluster whose mean
		 * normal is within cone_deg, else start a new one. */
		clusters.clear();
		cluster_nml_sum.clear();
		for (uint32_t i : idx) {
			const Vec3 &n = nml[i];
			bool placed = false;
			for (size_t c = 0; c < clusters.size(); ++c) {
				const Vec3 &s = cluster_nml_sum[c];
				float slen = sqrtf(dot(s, s));
				if (slen > 0.f && dot(s, n) / slen > cos_cone) {
					clusters[c].push_back(i);
					cluster_nml_sum[c] = s + n;
					placed = true;
					break;
				}
			}
			if (!placed) {
				clusters.push_back({i});
				cluster_nml_sum.push_back(n);
			}
		}

		for (uint32_t i : idx)
			keep[i] = false;
		for (const std::vector<uint32_t> &cluster : clusters) {
			Vec3 centroid{0.f, 0.f, 0.f};
			for (uint32_t i : cluster)
				centroid = centroid + pos[i];
			centroid = centroid * (1.f / cluster.size());
			uint32_t best = cluster[0];
			float best_d2 = dot(pos[best] - centroid,
					    pos[best] - centroid);
			for (uint32_t i : cluster) {
				float d2 = dot(pos[i] - centroid,
					       pos[i] - centroid);
				if (d2 < best_d2) {
					best = i;
					best_d2 = d2;
				}
			}
			keep[best] = true;
		}
	}

	size_t out = 0;
	for (size_t i = 0; i < point_num; ++i) {
		if (keep[i]) {
			pos[out] = pos[i];
			nml[out] = nml[i];
			out++;
		}
	}

	if (verbose) {
		printf("Normal-space thinning      : voxel %g cone %.0f deg "
		       "floor %d : %zu -> %zu pts (%.1f%%)\n",
		       voxel, cone_deg, min_pts, point_num, out,
		       point_num ? 100.0 * out / point_num : 0.0);
	}

	return out;
}
