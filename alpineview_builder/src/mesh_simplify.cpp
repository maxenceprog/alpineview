#include "mesh_simplify.h"

#include <stdint.h>

#include "Simplify.h"

void simplify_mesh_qem(TriMesh &mesh, int target, double aggressiveness,
					   bool verbose)
{
	if (mesh.faces.empty())
		return;

	size_t vertex_count = mesh.verts.size();
	size_t tri_count = mesh.faces.size() / 3;

	Simplify::vertices.clear();
	Simplify::triangles.clear();
	Simplify::refs.clear();
	Simplify::vertices.resize(vertex_count);
	for (size_t i = 0; i < vertex_count; ++i)
	{
		const Vec3 &p = mesh.verts[i];
		Simplify::vertices[i].p = vec3f(p.x, p.y, p.z);
	}
	Simplify::triangles.resize(tri_count);
	for (size_t i = 0; i < tri_count; ++i)
	{
		Simplify::Triangle &t = Simplify::triangles[i];
		t.v[0] = (int)mesh.faces[3 * i + 0];
		t.v[1] = (int)mesh.faces[3 * i + 1];
		t.v[2] = (int)mesh.faces[3 * i + 2];
		t.attr = Simplify::NONE;
		t.material = -1;
		t.deleted = 0;
		t.dirty = 0;
	}

	Simplify::simplify_mesh(target, aggressiveness, verbose);

	size_t new_vc = Simplify::vertices.size();
	size_t new_tc = Simplify::triangles.size();

	mesh.normals.clear();
	mesh.verts.resize(new_vc);
	mesh.faces.resize(3 * new_tc);

	for (size_t i = 0; i < new_vc; ++i)
	{
		const vec3f &p = Simplify::vertices[i].p;
		mesh.verts[i] = {(float)p.x, (float)p.y, (float)p.z};
	}
	for (size_t i = 0; i < new_tc; ++i)
	{
		const Simplify::Triangle &t = Simplify::triangles[i];
		mesh.faces[3 * i + 0] = (uint32_t)t.v[0];
		mesh.faces[3 * i + 1] = (uint32_t)t.v[1];
		mesh.faces[3 * i + 2] = (uint32_t)t.v[2];
	}

	Simplify::vertices.clear();
	Simplify::vertices.shrink_to_fit();
	Simplify::triangles.clear();
	Simplify::triangles.shrink_to_fit();
	Simplify::refs.clear();
	Simplify::refs.shrink_to_fit();
}
