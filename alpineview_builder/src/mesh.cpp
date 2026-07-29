#include "mesh.h"

void TriMesh::clear()
{
	verts.clear();
	verts.shrink_to_fit();
	normals.clear();
	normals.shrink_to_fit();
	faces.clear();
	faces.shrink_to_fit();
}

void TriMesh::reserve_vertices(size_t num, bool with_normals)
{
	verts.reserve(num);
	if (with_normals)
		normals.reserve(num);
}

void TriMesh::reserve_triangles(size_t num)
{
	faces.reserve(3 * num);
}
