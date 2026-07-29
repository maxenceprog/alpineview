#include "mesh_utils.h"

#include <assert.h>
#include <stdint.h>
#include <string.h>

#include <unordered_map>
#include <vector>

#include "aabb.h"
#include "mesh.h"
#include "vec3.h"

Aabb compute_mesh_bounds(const Vec3 *positions, size_t vertex_count)
{
	Vec3 min = positions[0];
	Vec3 max = positions[0];

	for (size_t i = 1; i < vertex_count; ++i) {
		const Vec3 &pos = positions[i];

		for (size_t j = 0; j < 3; ++j) {
			min[j] = (pos[j] < min[j]) ? pos[j] : min[j];
			max[j] = (pos[j] > max[j]) ? pos[j] : max[j];
		}
	}

	return {min, max};
}

Aabb compute_mesh_bounds(const TriMesh &mesh)
{
	return (compute_mesh_bounds(mesh.verts.data(), mesh.verts.size()));
}

namespace
{

struct PosKey {
	uint32_t x, y, z;
	bool operator==(const PosKey &o) const
	{
		return x == o.x && y == o.y && z == o.z;
	}
};

struct PosKeyHash {
	size_t operator()(const PosKey &k) const
	{
		return (size_t)(k.x * 73856093) ^ (size_t)(k.y * 19349663) ^
		       (size_t)(k.z * 83492791);
	}
};

PosKey pos_key(const Vec3 &v)
{
	PosKey k;
	memcpy(&k.x, &v.x, sizeof(uint32_t));
	memcpy(&k.y, &v.y, sizeof(uint32_t));
	memcpy(&k.z, &v.z, sizeof(uint32_t));
	return k;
}

} // namespace

uint32_t build_position_remap(const TriMesh &mesh, uint32_t *remap)
{
	std::unordered_map<PosKey, uint32_t, PosKeyHash> seen;
	seen.reserve(mesh.verts.size());

	uint32_t num = 0;
	for (size_t i = 0; i < mesh.verts.size(); ++i) {
		auto res = seen.emplace(pos_key(mesh.verts[i]), (uint32_t)i);
		remap[i] = res.first->second;
		if (res.second)
			num++;
	}
	return (num);
}

void compute_mesh_normals(TriMesh &mesh)
{
	size_t vertex_count = mesh.verts.size();

	mesh.normals.assign(vertex_count, Vec3::Zero);

	std::vector<uint32_t> remap(vertex_count);
	build_position_remap(mesh, &remap[0]);

	for (size_t i = 0; i < mesh.faces.size(); i += 3) {
		const Vec3 v1 = mesh.verts[mesh.faces[i + 0]];
		const Vec3 v2 = mesh.verts[mesh.faces[i + 1]];
		const Vec3 v3 = mesh.verts[mesh.faces[i + 2]];

		/* Weight normals by triangle area */
		Vec3 n = cross(v2 - v1, v3 - v1);

		/* Accumulate normals of remap targets */
		mesh.normals[remap[mesh.faces[i + 0]]] += n;
		mesh.normals[remap[mesh.faces[i + 1]]] += n;
		mesh.normals[remap[mesh.faces[i + 2]]] += n;
	}

	/* Normalize remap targets and copy them to remap sources */
	for (size_t i = 0; i < vertex_count; ++i) {
		if (remap[i] == i) {
			mesh.normals[i] = normalized(mesh.normals[i]);
		} else {
			assert(remap[i] < i);
			mesh.normals[i] = mesh.normals[remap[i]];
		}
	}
}

static uint32_t uf_find(std::vector<uint32_t> &parent, uint32_t i)
{
	while (parent[i] != i) {
		parent[i] = parent[parent[i]];
		i = parent[i];
	}
	return (i);
}

static void uf_union(std::vector<uint32_t> &parent, uint32_t a, uint32_t b)
{
	a = uf_find(parent, a);
	b = uf_find(parent, b);
	if (a != b)
		parent[b] = a;
}

uint32_t select_principal_connected_component(TriMesh &mesh)
{
	size_t tri_count = mesh.faces.size() / 3;
	if (tri_count == 0)
		return (0);

	const uint32_t *indices = mesh.faces.data();

	/* Union triangles sharing an (undirected) edge. */
	std::vector<uint32_t> parent(tri_count);
	for (size_t i = 0; i < tri_count; ++i)
		parent[i] = i;

	std::unordered_map<uint64_t, uint32_t> edge_owner;
	edge_owner.reserve(3 * tri_count);
	for (size_t i = 0; i < tri_count; ++i) {
		for (int e = 0; e < 3; ++e) {
			uint32_t a = indices[3 * i + e];
			uint32_t b = indices[3 * i + (e + 1) % 3];
			uint64_t key = a < b ? ((uint64_t)a << 32) | b
					     : ((uint64_t)b << 32) | a;
			auto it = edge_owner.find(key);
			if (it == edge_owner.end())
				edge_owner.emplace(key, (uint32_t)i);
			else
				uf_union(parent, it->second, (uint32_t)i);
		}
	}

	std::unordered_map<uint32_t, uint32_t> counts;
	for (size_t i = 0; i < tri_count; ++i)
		counts[uf_find(parent, (uint32_t)i)]++;

	uint32_t num_cc = (uint32_t)counts.size();
	if (num_cc <= 1)
		return (num_cc);

	uint32_t root_max = counts.begin()->first;
	for (const auto &kv : counts) {
		if (kv.second > counts[root_max])
			root_max = kv.first;
	}

	size_t new_index_count = 0;
	for (size_t i = 0; i < tri_count; ++i) {
		if (uf_find(parent, (uint32_t)i) != root_max)
			continue;
		mesh.faces[new_index_count++] = mesh.faces[3 * i + 0];
		mesh.faces[new_index_count++] = mesh.faces[3 * i + 1];
		mesh.faces[new_index_count++] = mesh.faces[3 * i + 2];
	}
	mesh.faces.resize(new_index_count);

	return (num_cc);
}

void compact_mesh(TriMesh &mesh)
{
	std::vector<uint32_t> remap(mesh.verts.size());
	build_position_remap(mesh, &remap[0]);

	std::vector<uint32_t> new_idx(mesh.verts.size(), UINT32_MAX);
	std::vector<Vec3> verts;
	verts.reserve(mesh.verts.size());

	size_t total_indices = 0;
	for (size_t i = 0; i < mesh.faces.size(); i += 3) {
		uint32_t t[3] = {remap[mesh.faces[i + 0]],
				 remap[mesh.faces[i + 1]],
				 remap[mesh.faces[i + 2]]};
		if (t[0] == t[1] || t[0] == t[2] || t[1] == t[2])
			continue;
		for (int k = 0; k < 3; ++k) {
			if (new_idx[t[k]] == UINT32_MAX) {
				new_idx[t[k]] = (uint32_t)verts.size();
				verts.push_back(mesh.verts[t[k]]);
			}
			mesh.faces[total_indices++] = new_idx[t[k]];
		}
	}
	mesh.faces.resize(total_indices);
	mesh.verts = std::move(verts);
	mesh.normals.clear();
}
