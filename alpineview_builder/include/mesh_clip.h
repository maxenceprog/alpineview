#pragma once

#include <stdint.h>
#include <vector>

#include "vec3.h"

typedef TVec3<double> Vec3d;

/* Position (+ optional normal) triangle mesh in double precision.
 * Used as intermediate representation for axis-aligned clipping. */
struct TriMesh {
	std::vector<Vec3d> verts;
	std::vector<Vec3d> normals; /* optional; when non-empty, parallel to verts */
	std::vector<uint32_t> faces; /* 3 indices per triangle */
};

/* Split m at axis (0=X, 1=Y) == coord into lo (axis <= coord) and hi
 * (axis >= coord). Triangles crossing the cut are clipped with new vertices
 * interpolated on the cut edge. Normals are interpolated when m.normals is
 * non-empty. Pass nullptr for a side to skip building it. */
void split_mesh(const TriMesh &m, int axis, double coord, TriMesh *lo,
		TriMesh *hi);
