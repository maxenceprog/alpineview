#include "mesh_simplify.h"

#include <stdint.h>

#include "Simplify.h"

void simplify_mesh_qem(TriMesh &mesh, int target, double aggressiveness,
					   bool verbose) {
	if (mesh.faces.empty())
		return;

	size_t vertexCount = mesh.verts.size();
	size_t triCount = mesh.faces.size() / 3;

	simplify::vertices.clear();
	simplify::triangles.clear();
	simplify::refs.clear();
	simplify::vertices.resize(vertexCount);
	for (size_t i = 0; i < vertexCount; ++i) {
		const Vec3 &p = mesh.verts[i];
		simplify::vertices[i].p = vec3f(p.x, p.y, p.z);
	}
	simplify::triangles.resize(triCount);
	for (size_t i = 0; i < triCount; ++i) {
		simplify::Triangle &t = simplify::triangles[i];
		t.v[0] = (int)mesh.faces[3 * i + 0];
		t.v[1] = (int)mesh.faces[3 * i + 1];
		t.v[2] = (int)mesh.faces[3 * i + 2];
		t.attr = simplify::NONE;
		t.material = -1;
		t.deleted = 0;
		t.dirty = 0;
	}

	simplify::simplifyMesh(target, aggressiveness, verbose);

	size_t newVc = simplify::vertices.size();
	size_t newTc = simplify::triangles.size();

	mesh.normals.clear();
	mesh.verts.resize(newVc);
	mesh.faces.resize(3 * newTc);

	for (size_t i = 0; i < newVc; ++i) {
		const vec3f &p = simplify::vertices[i].p;
		mesh.verts[i] = {(float)p.x, (float)p.y, (float)p.z};
	}
	for (size_t i = 0; i < newTc; ++i) {
		const simplify::Triangle &t = simplify::triangles[i];
		mesh.faces[3 * i + 0] = (uint32_t)t.v[0];
		mesh.faces[3 * i + 1] = (uint32_t)t.v[1];
		mesh.faces[3 * i + 2] = (uint32_t)t.v[2];
	}

	simplify::vertices.clear();
	simplify::vertices.shrink_to_fit();
	simplify::triangles.clear();
	simplify::triangles.shrink_to_fit();
	simplify::refs.clear();
	simplify::refs.shrink_to_fit();
}
