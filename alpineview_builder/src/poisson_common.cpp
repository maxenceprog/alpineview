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

const char *flag_value(int argc, const char **argv, int *i)
{
	if (*i + 1 >= argc)
	{
		printf("Error: option '%s' expects a value.\n", argv[*i]);
		return NULL;
	}
	return argv[++(*i)];
}

int run_poisson_recon(const std::string &recon_in, const std::string &recon_out,
					  int depth, float weight, bool verbose, bool parallel,
					  bool performance)
{
	const char *verbose_flag = verbose ? "--verbose" : "";
	const char *performance_flag = performance ? "--performance" : "";
	const char *format =
		"poissonrecon --in %s --out %s --scale 1.0 --depth %d "
		"--pointWeight %.1f %s --parallel %d --samplesPerNode 2.0 %s";
	size_t len = recon_in.size() + recon_out.size() + strlen(format) + 64;
	std::string cmd(len, '\0');
	int written = snprintf(&cmd[0], len, format, recon_in.c_str(),
						   recon_out.c_str(), depth, weight, verbose_flag,
						   parallel ? 0 : 2, performance_flag);
	cmd.resize(written);
	return system(cmd.c_str());
}

void recut_mesh(TriMesh &mesh, const Transform &transf)
{
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

void rescale_mesh(TriMesh &mesh, const Transform &transf)
{
	float invscale = 1.f / transf.scale;
	for (Vec3 &p : mesh.verts)
	{
		p = p - transf.shift;
		p *= invscale;
	}
}

static void optimize_mesh(TriMesh &mesh)
{
	uint32_t index_count = mesh.faces.size();
	uint32_t *indices = mesh.faces.data();
	uint32_t vertex_count = mesh.verts.size();
	float *vertices = (float *)mesh.verts.data();
	size_t vertex_size = sizeof(Vec3);
	meshopt_optimizeVertexCache(indices, indices, index_count, vertex_count);
	mesh.verts.resize(
		meshopt_optimizeVertexFetch(vertices, indices, index_count, vertices,
									vertex_count, vertex_size));
}

int postprocess_lod_level(TriMesh &mesh, const Transform &transf, int level0,
						  int x, int y, int z, const std::string &out_dir,
						  bool optimize, bool verbose)
{
	size_t tri_before = mesh.triangle_count();
	uint32_t num_cc = select_principal_connected_component(mesh);
	if (num_cc > 1)
		printf("  LOD z=%d : %u components, kept %zu/%zu Tri\n", z, num_cc,
			   mesh.triangle_count(), tri_before);

	tri_before = mesh.triangle_count();
	int target = (int)(DEFAULT_TRIANGLE_TARGET_COUNT *
					   pow(4, z));
	simplify_mesh_qem(mesh, target, 2.0, verbose);
	size_t tri_after = mesh.triangle_count();
	printf("Simplify QEM: %zu -> %zu Tri (ratio %.3f)\n", tri_before, tri_after,
		   tri_before ? (float)tri_after / tri_before : 0.f);

	recut_mesh(mesh, transf);
	rescale_mesh(mesh, transf);

	compact_mesh(mesh);

	if (optimize)
	{
		optimize_mesh(mesh);
	}

	return write_lod_level(mesh, level0, x, y, z, out_dir.c_str(), verbose);
}
