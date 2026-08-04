#pragma once

#include <stdint.h>

#include "aabb.h"
#include "mesh.h"
#include "vec3.h"

Aabb compute_mesh_bounds(const Vec3 *positions, size_t vertex_count);

Aabb compute_mesh_bounds(const TriMesh &mesh);

/* Maps every vertex to the first vertex sharing its exact position. Returns
 * the number of distinct positions. remap must hold mesh.verts.size() items. */
uint32_t build_position_remap(const TriMesh &mesh, uint32_t *remap);

void compute_mesh_normals(TriMesh &mesh);

/* Drop every edge-connected component but the largest one (by triangle count).
 * Only the index buffer is updated; orphaned vertices are left for
 * compact_mesh. Returns the number of components found. */
uint32_t select_principal_connected_component(TriMesh &mesh);

/* Weld vertices sharing a position, drop the triangles that collapse and the
 * vertices no triangle references. */
void compact_mesh(TriMesh &mesh);
