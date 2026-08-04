#include "poisson_common.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "meshoptimizer/src/meshoptimizer.h"

#include "geo_constants.h"
#include "mesh_clip.h"
#include "mesh_lod.h"
#include "mesh_simplify.h"
#include "mesh_utils.h"

const char *flag_value(int argc, const char **argv, int *i) {
	if (*i + 1 >= argc) {
		printf("Error: option '%s' expects a value.\n", argv[*i]);
		return NULL;
	}
	return argv[++(*i)];
}

int run_poisson_recon(const std::string &reconIn, const std::string &reconOut,
					  int depth, float weight, bool verbose, bool parallel,
					  bool performance) {
	const char *verboseFlag = verbose ? "--verbose" : "";
	const char *performanceFlag = performance ? "--performance" : "";
	const char *format =
		"poissonrecon --in %s --out %s --scale 1.0 --depth %d "
		"--pointWeight %.1f %s --parallel %d --samplesPerNode 2.0 %s";
	size_t len = reconIn.size() + reconOut.size() + strlen(format) + 64;
	std::string cmd(len, '\0');
	int written =
		snprintf(&cmd[0], len, format, reconIn.c_str(), reconOut.c_str(), depth,
				 weight, verboseFlag, parallel ? 0 : 2, performanceFlag);
	cmd.resize(written);
	return system(cmd.c_str());
}

void recut_mesh(TriMesh &mesh, const Transform &transf) {
	float sx = transf.shift.x, sy = transf.shift.y;
	TriMesh a, b, c, d;
	split_mesh(mesh, 0, sx, nullptr, &a);
	split_mesh(a, 0, 1.f - sx, &b, nullptr);
	a = TriMesh();
	split_mesh(b, 1, sy, nullptr, &c);
	b = TriMesh();
	split_mesh(c, 1, 1.f - sy, &d, nullptr);
	mesh = std::move(d);
}

void rescale_mesh(TriMesh &mesh, const Transform &transf) {
	float invscale = 1.f / transf.scale;
	for (Vec3 &p : mesh.verts) {
		p = p - transf.shift;
		p *= invscale;
	}
}

static void optimizeMesh(TriMesh &mesh) {
	uint32_t indexCount = mesh.faces.size();
	uint32_t *indices = mesh.faces.data();
	uint32_t vertexCount = mesh.verts.size();
	float *vertices = (float *)mesh.verts.data();
	size_t vertexSize = sizeof(Vec3);
	meshopt_optimizeVertexCache(indices, indices, indexCount, vertexCount);
	mesh.verts.resize(meshopt_optimizeVertexFetch(
		vertices, indices, indexCount, vertices, vertexCount, vertexSize));
}

int postprocess_lod_level(TriMesh &mesh, const Transform &transf, int level0,
						  int x, int y, int z, const std::string &outDir,
						  bool optimize, bool verbose) {
	size_t triBefore = mesh.triangle_count();
	uint32_t numCc = select_principal_connected_component(mesh);
	if (numCc > 1)
		printf("  LOD z=%d : %u components, kept %zu/%zu Tri\n", z, numCc,
			   mesh.triangle_count(), triBefore);

	triBefore = mesh.triangle_count();
	int target = (int)(DEFAULT_TRIANGLE_TARGET_COUNT * pow(4, z));
	simplify_mesh_qem(mesh, target, 2.0, verbose);
	size_t triAfter = mesh.triangle_count();
	printf("Simplify QEM: %zu -> %zu Tri (ratio %.3f)\n", triBefore, triAfter,
		   triBefore ? (float)triAfter / triBefore : 0.f);

	recut_mesh(mesh, transf);
	rescale_mesh(mesh, transf);

	compact_mesh(mesh);

	if (optimize) {
		optimizeMesh(mesh);
	}

	return write_lod_level(mesh, level0, x, y, z, outDir.c_str(), verbose);
}
