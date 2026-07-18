#pragma once

#include "mesh.h"

/* Quadric error mesh simplification (Sven Forstmann's Simplify.h), driven
 * directly off Mesh/MBuf: no .obj/.ply round trip.
 *
 * Keeps ratio * index_count triangles, rewriting mesh.positions/indices in
 * place. Normals are dropped (VtxAttr::NML cleared): the collapse invalidates
 * them and nothing downstream reads them. */
void simplify_mesh_qem(Mesh &mesh, MBuf &data, float ratio,
		       double aggressiveness = 7.0, bool verbose = false);
