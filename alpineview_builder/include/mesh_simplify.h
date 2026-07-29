#pragma once

#include "mesh.h"

/* Quadric error mesh simplification (Sven Forstmann's Simplify.h), driven
 * directly off TriMesh: no .obj/.ply round trip.
 *
 * Keeps ratio * triangle_count triangles, rewriting mesh.verts/faces in
 * place. Normals are dropped: the collapse invalidates them and nothing
 * downstream reads them. */
void simplify_mesh_qem(TriMesh &mesh, float ratio,
		       double aggressiveness = 7.0, bool verbose = false);
