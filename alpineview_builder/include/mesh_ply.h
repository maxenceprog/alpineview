#pragma once

#include "mesh.h"

int load_ply(TriMesh &mesh, const char *fname, bool with_normals = true);

int write_ply(const char *fname, const TriMesh &mesh);
