#include "mesh_simplify.h"

#include <stdint.h>

#include "Simplify.h"

void simplify_mesh_qem(Mesh &mesh, MBuf &data, float ratio,
		       double aggressiveness, bool verbose)
{
	if (!mesh.index_count || ratio <= 0.f || ratio >= 1.f)
		return;

	const Vec3 *pos = data.positions + mesh.vertex_offset;
	const uint32_t *idx = data.indices + mesh.index_offset;

	Simplify::vertices.clear();
	Simplify::triangles.clear();
	Simplify::refs.clear();
	Simplify::vertices.resize(mesh.vertex_count);
	for (uint32_t i = 0; i < mesh.vertex_count; ++i)
	{
		Simplify::vertices[i].p = vec3f(pos[i].x, pos[i].y, pos[i].z);
	}
	Simplify::triangles.resize(mesh.index_count / 3);
	for (uint32_t i = 0; i < mesh.index_count / 3; ++i)
	{
		Simplify::Triangle &t = Simplify::triangles[i];
		t.v[0] = (int)idx[3 * i + 0];
		t.v[1] = (int)idx[3 * i + 1];
		t.v[2] = (int)idx[3 * i + 2];
		t.attr = Simplify::NONE;
		t.material = -1;
		t.deleted = 0;
		t.dirty = 0;
	}

	int target = (int)(ratio * Simplify::triangles.size());
	Simplify::simplify_mesh(target, aggressiveness, verbose);

	uint32_t new_vc = (uint32_t)Simplify::vertices.size();
	uint32_t new_ic = (uint32_t)Simplify::triangles.size() * 3;
	data.update_vtx_attr(data.vtx_attr & ~VtxAttr::NML);
	data.reserve_vertices(mesh.vertex_offset + new_vc);
	data.reserve_indices(mesh.index_offset + new_ic);

	Vec3 *out_pos = data.positions + mesh.vertex_offset;
	uint32_t *out_idx = data.indices + mesh.index_offset;
	for (uint32_t i = 0; i < new_vc; ++i)
	{
		const vec3f &p = Simplify::vertices[i].p;
		out_pos[i] = {(float)p.x, (float)p.y, (float)p.z};
	}
	for (uint32_t i = 0; i < new_ic / 3; ++i)
	{
		const Simplify::Triangle &t = Simplify::triangles[i];
		out_idx[3 * i + 0] = (uint32_t)t.v[0];
		out_idx[3 * i + 1] = (uint32_t)t.v[1];
		out_idx[3 * i + 2] = (uint32_t)t.v[2];
	}
	mesh.vertex_count = new_vc;
	mesh.index_count = new_ic;

	Simplify::vertices.clear();
	Simplify::vertices.shrink_to_fit();
	Simplify::triangles.clear();
	Simplify::triangles.shrink_to_fit();
	Simplify::refs.clear();
	Simplify::refs.shrink_to_fit();
}
