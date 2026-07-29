#pragma once

#include <stdint.h>
#include <vector>

#include "vec3.h"

struct TriMesh {
	std::vector<Vec3> verts;
	std::vector<Vec3> normals;
	std::vector<uint32_t> faces;

	void clear();
	void reserve_vertices(size_t num, bool with_normals = false);
	void reserve_triangles(size_t num);

	size_t vertex_count() const { return verts.size(); }
	size_t index_count() const { return faces.size(); }
	size_t triangle_count() const { return faces.size() / 3; }
	bool has_normals() const { return normals.size() == verts.size(); }
};
