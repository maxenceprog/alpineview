#pragma once

#include "mesh.h"

/* Split m at axis (0=X, 1=Y) == coord into lo (axis <= coord) and hi
 * (axis >= coord). Triangles crossing the cut are clipped with new vertices
 * interpolated on the cut edge. Normals are interpolated when m.normals is
 * non-empty. Pass nullptr for a side to skip building it. */
void split_mesh(const TriMesh &m, int axis, float coord, TriMesh *lo,
				TriMesh *hi);
