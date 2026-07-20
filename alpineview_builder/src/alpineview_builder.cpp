#include <algorithm>
#include <cassert>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "meshoptimizer/src/meshoptimizer.h"

#include "array.h"
#include "chrono.h"
#include "hash_table.h"
#include "math_utils.h"
#include "sys_utils.h"

#include "mesh.h"
#include "mesh_clip.h"
#include "mesh_lod.h"
#include "mesh_ply.h"
#include "mesh_simplify.h"
#include "mesh_utils.h"
#include "vertex_table.h"

#include "copc.h"
#include "las_resample.h"
#include "las_normal_cgal.h"
#include "las_read.h"

/* Size of tile boundary buffer in cm */
#define BDY_BUFFER 10000
#define BDY_BUFFER_ADD 48000

static const double ALTITUDE_THRESHOLD = 100.0;

/******************************************************************************
 *
 * I. Args and filenames.
 *
 ******************************************************************************/

struct Cfg
{
	int x0;
	int y0;
	std::string base_dir;
	std::string out_dir;
	int depth;
	float weight;
	float trim;
	float aratio;
	int clean;
	bool verbose;
	bool optimize;
	bool encode;
	bool use_las;
	bool parallel;
	DownsampleCfg downsample;
	LodCfg lod;
};

struct Timings
{
	unsigned int read_and_filter = 0;
	unsigned int estim_nml = 0;
	unsigned int poisson_recon = 0;
	unsigned int trim = 0;		   /* surfacetrimmer */
	unsigned int coarse_recon = 0; /* coarse LOD Poisson re-runs */
	unsigned int lod = 0;		   /* load + km transform + Draco tiling */
	unsigned int total = 0;
};

static void set_default_cfg(struct Cfg &cfg)
{
	cfg.x0 = 0;
	cfg.y0 = 0;
	const char *home = getenv("HOME");
	if (home)
	{
		cfg.base_dir = std::string(home) + "/.cache/poissonrecon-ign/";
	}
	else
	{
		cfg.base_dir = ".";
	}
	cfg.out_dir = ".";
	cfg.depth = 10;
	cfg.weight = 4.f;
	cfg.trim = 0;
	cfg.parallel = false;
	cfg.aratio = 0.005f;
	cfg.clean = 2;
	cfg.verbose = true;
	cfg.optimize = true;
	cfg.encode = false;
	cfg.use_las = false;
	cfg.downsample.enabled = false;
	cfg.downsample.grid_res = 1.f;
	cfg.downsample.neighbor_radius = 5;
	cfg.downsample.slope_deg = 45.f;
	cfg.lod.max_level = 0;
	cfg.lod.skirt_depth = 50.f;
}

static void print_usage(const char *prog)
{
	printf(
		"Usage: %s X Y [options]\n"
		"\n"
		"  X, Y                 tile coordinates in km (required).\n"
		"\n"
		"Paths:\n"
		"  --base-dir DIR       input COPC directory "
		"(default: $HOME/.cache/poissonrecon-ign/)\n"
		"                       expects "
		"LHD_FXX_XXXX_YYYY_PTS_LAMB93_IGN69.copc.laz tiles\n"
		"  --out-dir DIR        output directory (default: .)\n"
		"\n"
		"Reconstruction:\n"
		"  --depth N            Poisson octree depth (default: 10)\n"
		"  --weight F           Poisson point weight (default: 4)\n"
		"  --trim F             Trim enabled if trim > 0.0"
		"  --aratio F           legacy (ignored)"
		"  --clean N            cleanup level 0/1/2 (default: 1)\n"
		"\n"
		"Toggles (prefix with --no- to disable):\n"
		"  --verbose            verbose output (default: on)\n"
		"  --optimize           optimize final mesh (default: on)\n"
		"  --encode             write encoded .bin mesh (default: off)\n"
		"\n"
		"Downsampling (grid thinning, see las_resample.h):\n"
		"  --downsample         enable thinning (default: off)\n"
		"  --ds-grid F          grid cell size, m (default: 1)\n"
		"  --ds-radius N        neighbor radius, cells (default: 5)\n"
		"  --ds-slope F         slope threshold, deg (default: 45)\n"
		"\n"
		"Input format:\n"
		"  --las                Use input .las, .laz\n"
		"\n"
		"LOD Draco tiles (web output):\n"
		"  --lod N              also write Draco LOD tiles for levels 0..N\n"
		"                       into --out-dir (default: off)\n"
		"  --skirt F            boundary skirt depth, m (default: 2; "
		"0 disables)\n"
		"\n"
		"  -h, --help           show this help and exit\n",
		prog);
}

/* Fetch the value following a flag, advancing *i. Returns NULL (and prints an
 * error) when the flag is the last token and has no value. */
static const char *flag_value(int argc, const char **argv, int *i)
{
	if (*i + 1 >= argc)
	{
		printf("Error: option '%s' expects a value.\n", argv[*i]);
		return NULL;
	}
	return argv[++(*i)];
}

/* Parse "--flag" / "--no-flag" boolean pair. Returns 1 if `arg` matched
 * `name`, in which case *out is set accordingly; 0 if no match. */
static int match_toggle(const char *arg, const char *name, bool &out)
{
	if (strcmp(arg, name) == 0)
	{
		out = true;
		return 1;
	}
	if (strncmp(arg, "--no-", 5) == 0 && strcmp(arg + 5, name + 2) == 0)
	{
		out = false;
		return 1;
	}
	return 0;
}

static int process_args(int argc, const char **argv, struct Cfg &cfg)
{
	set_default_cfg(cfg);

	/* Collect the two required positional coordinates, then flags. */
	int positional = 0;
	for (int i = 1; i < argc; ++i)
	{
		const char *arg = argv[i];

		if (strcmp(arg, "-h") == 0 || strcmp(arg, "--help") == 0)
		{
			print_usage(argv[0]);
			return (1); /* handled, ask caller to exit cleanly */
		}

		if (arg[0] != '-')
		{
			if (positional == 0)
			{
				cfg.x0 = atoi(arg);
			}
			else if (positional == 1)
			{
				cfg.y0 = atoi(arg);
			}
			else
			{
				printf("Error: unexpected argument '%s'.\n",
					   arg);
				return (-1);
			}
			++positional;
			continue;
		}

		const char *val = NULL;
		if (strcmp(arg, "--base-dir") == 0)
		{
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.base_dir = val;
		}
		else if (strcmp(arg, "--out-dir") == 0)
		{
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.out_dir = val;
		}
		else if (strcmp(arg, "--depth") == 0)
		{
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.depth = atoi(val);
		}
		else if (strcmp(arg, "--weight") == 0)
		{
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.weight = atof(val);
		}
		else if (strcmp(arg, "--trim") == 0)
		{
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.trim = atof(val);
		}
		else if (strcmp(arg, "--aratio") == 0)
		{
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.aratio = atof(val);
		}
		else if (strcmp(arg, "--clean") == 0)
		{
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.clean = atoi(val);
		}
		else if (strcmp(arg, "--ds-grid") == 0)
		{
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.downsample.grid_res = atof(val);
		}
		else if (strcmp(arg, "--ds-radius") == 0)
		{
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.downsample.neighbor_radius = atoi(val);
		}
		else if (strcmp(arg, "--ds-slope") == 0)
		{
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.downsample.slope_deg = atof(val);
		}
		else if (strcmp(arg, "--lod") == 0)
		{
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.lod.max_level = atoi(val);
		}
		else if (strcmp(arg, "--skirt") == 0)
		{
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.lod.skirt_depth = atof(val);
		}
		else if (match_toggle(arg, "--verbose", cfg.verbose) ||
				 match_toggle(arg, "--optimize", cfg.optimize) ||
				 match_toggle(arg, "--encode", cfg.encode) ||
				 match_toggle(arg, "--las", cfg.use_las) ||
				 match_toggle(arg, "--downsample",
							  cfg.downsample.enabled) ||
				 match_toggle(arg, "--parallel", cfg.parallel))
		{
			/* handled by match_toggle */
		}
		else
		{
			printf("Error: unknown option '%s'. Try --help.\n", arg);
			return (-1);
		}
	}

	if (positional < 2)
	{
		printf("Error: missing tile coordinates X Y. Try --help.\n");
		return (-1);
	}

	return (0);
}

static void print_cfg(const struct Cfg &cfg)
{
	printf("\n");
	printf("Configuration :\n");
	printf("---------------\n");
	printf("Tile coords : %d %d\n", cfg.x0, cfg.y0);
	printf("Data  dir   : %s\n", cfg.base_dir.c_str());
	printf("Output dir  : %s\n", cfg.out_dir.c_str());
	printf("Verbosity   : %d\n", cfg.verbose ? 1 : 0);
	printf("Trim        : %s (trim=%.2f aratio=%g)\n",
		   cfg.trim > 0.f ? "on" : "off", cfg.trim, cfg.aratio);
	if (cfg.downsample.enabled)
	{
		printf("Downsample  : grid=%gm radius=%d slope=%.0fdeg\n",
			   cfg.downsample.grid_res,
			   cfg.downsample.neighbor_radius,
			   cfg.downsample.slope_deg);
	}
	else
	{
		printf("Downsample  : off\n");
	}
}

static void print_timings(const Timings &tt)
{
	unsigned div = 1000000;
	unsigned int other = tt.total - tt.read_and_filter - tt.estim_nml -
						 tt.poisson_recon - tt.trim - tt.coarse_recon -
						 tt.lod;
	printf("\n");
	printf("Timings :\n");
	printf("---------\n");
	printf("Read data   : ");
	printf("%3d s (%.1f%%)\n", tt.read_and_filter / div,
		   100.f * tt.read_and_filter / tt.total);
	printf("Estim nml   : ");
	printf("%3d s (%.1f%%)\n", tt.estim_nml / div,
		   100.f * tt.estim_nml / tt.total);
	printf("Poisson     : ");
	printf("%3d s (%.1f%%)\n", tt.poisson_recon / div,
		   100.f * tt.poisson_recon / tt.total);
	printf("Trim        : ");
	printf("%3d s (%.1f%%)\n", tt.trim / div, 100.f * tt.trim / tt.total);
	printf("Coarse recon: ");
	printf("%3d s (%.1f%%)\n", tt.coarse_recon / div,
		   100.f * tt.coarse_recon / tt.total);
	printf("LOD tiling  : ");
	printf("%3d s (%.1f%%)\n", tt.lod / div, 100.f * tt.lod / tt.total);
	printf("Other       : ");
	printf("%3d s (%.1f%%)\n", other / div, 100.f * other / tt.total);
	printf("Total       : ");
	printf("%3d s \n", tt.total / div);
}

static std::string get_filename(int x, int y, const std::string &dir,
								const char *ext)
{
	std::string fname = dir;
	if (!fname.empty() && fname.back() != '/')
	{
		fname += '/';
	}
	char suffix[32];
	snprintf(suffix, sizeof(suffix), "%04d_%04d.%s", x, y, ext);
	fname += suffix;

	return fname;
}

/* Build the path of an input IGN LIDAR HD tile, e.g.
 * <dir>/LHD_FXX_0965_6431_PTS_LAMB93_IGN69.copc.laz
 * (the XXXX_YYYY in the name are the tile's km coordinates). */
static std::string get_las_filename(int x, int y, const std::string &dir,
									const char *ext = "copc.laz")
{
	std::string fname = dir;
	if (!fname.empty() && fname.back() != '/')
	{
		fname += '/';
	}
	char suffix[64];
	snprintf(suffix, sizeof(suffix),
			 "LHD_FXX_%04d_%04d_PTS_LAMB93_IGN69.%s", x, y, ext);
	fname += suffix;

	return fname;
}

/******************************************************************************
 *
 * II. Utility fonctions.
 *
 ******************************************************************************/

static int write_mesh(const Mesh &mesh, const MBuf &data, const struct Cfg &cfg,
					  const char *ext)
{

	std::string fname = get_filename(cfg.x0, cfg.y0, cfg.out_dir, ext);
	write_ply(fname.c_str(), mesh, data);

	return (0);
}

static void compact_mesh(Mesh &mesh, MBuf &data)
{
	/* TODO Avoid this copy and swap of mesh/buffers, this requires
	 * implementing vertex swaps in join_mesh_from_indices */
	Mesh mesh2 = mesh;
	MBuf data2;
	data2.vtx_attr = VtxAttr::POS;
	data2.reserve_indices(mesh.index_count);
	data2.reserve_vertices(mesh.vertex_count);

	copy_indices(data2, 0, data, 0, mesh.index_count);
	copy_vertices(data2, 0, data, 0, mesh.vertex_count);

	/* Compact mesh (useless vertices and degenerate triangles removed) */
	mesh.clear();
	data.update_vtx_attr(VtxAttr::POS);
	VertexTable vtx_table(mesh2.vertex_count, &data, data.vtx_attr);
	join_mesh_from_indices(mesh, data, mesh2, data2, vtx_table, NULL);
	skip_degenerate_tris(mesh, data);

	printf("A total of %d (%.2f M) Tri after compacting.\n",
		   mesh.index_count / 3, 1e-6 * mesh.index_count / 3);
}

static void optimize_mesh(Mesh &mesh, MBuf &data)
{
	uint32_t index_count = mesh.index_count;
	uint32_t *indices = data.indices + mesh.index_offset;
	uint32_t vertex_count = mesh.vertex_count;
	float *vertices = (float *)(data.positions + mesh.vertex_offset);
	size_t vertex_size = sizeof(Vec3);
	meshopt_optimizeVertexCache(indices, indices, mesh.index_count,
								mesh.vertex_count);
	/* TODO This only work for POS only meshes, use
	 * meshopt_optimizeVertexFetchRemap instead
	 * */
	mesh.vertex_count =
		meshopt_optimizeVertexFetch(vertices, indices, index_count,
									vertices, vertex_count, vertex_size);
}

struct Transform
{
	float scale;
	Vec3 shift;
};

int write_transform(const struct Transform &t, const struct Cfg &cfg)
{
	std::string fname = get_filename(cfg.x0, cfg.y0, cfg.out_dir, "transf");
	FILE *f = fopen(fname.c_str(), "w");
	if (!f)
	{
		return (-1);
	}
	fprintf(f, "Scale %g\n", t.scale);
	fprintf(f, "Offset %g %g %g\n", t.shift.x, t.shift.y, t.shift.z);
	fclose(f);
	return (0);
}

int read_transform(struct Transform &t, const struct Cfg &cfg)
{
	std::string fname = get_filename(cfg.x0, cfg.y0, cfg.out_dir, "transf");
	FILE *f = fopen(fname.c_str(), "r");
	if (!f)
	{
		return (-1);
	}
	fscanf(f, "Scale %g\n", &t.scale);
	fscanf(f, "Offset %g %g %g\n", &t.shift.x, &t.shift.y, &t.shift.z);
	fclose(f);
	return (0);
}

/******************************************************************************
 *
 * II. Functions related to creation of the oriented point set.
 *
 ******************************************************************************/

static bool filter_las_point(const LasPoint &p, const LasFileInfo &info,
							 const TAabb<double> box)
{
	double pos[3];
	pos[0] = p.x * info.scale[0] + info.offset[0];
	pos[1] = p.y * info.scale[1] + info.offset[1];
	pos[2] = p.z * info.scale[2] + info.offset[2];

	/* Bbox filter */
	if ((pos[0] < box.min[0]) || (pos[0] > box.max[0]) ||
		(pos[1] < box.min[1]) || (pos[1] > box.max[1]))
	{
		return false;
	}

	return (p.classification == 2 || p.classification == 9 || p.classification == 10 || p.classification == 11);
}

static TAabb<double> las_bbox(int x0, int y0)
{
	TAabb<double> box;
	box.min.x = 1000 * x0 - 50;
	box.min.y = 1000 * y0 - 1050;
	box.min.z = -1000;
	box.max.x = 1000 * x0 + 1050;
	box.max.y = 1000 * y0 + 50;
	box.max.z = 9000;
	return box;
}

static uint32_t filter_and_add_points(std::vector<LasPoint> &points, const char *src,
									  uint32_t src_count,
									  const LasFileInfo info,
									  const TAabb<double> box)
{
	size_t init_point_count = points.size();
	size_t point_count = init_point_count;
	points.resize(point_count + src_count); // Over estimate, shrink later
	for (uint32_t i = 0; i < src_count; ++i)
	{
		LasPoint &p = points[point_count];
		p = las_read_point(src, info.point_format);
		if (filter_las_point(p, info, box))
		{
			point_count++;
		}
		src += info.point_size;
	}
	points.resize(point_count);

	return (point_count - init_point_count);
}

static size_t read_and_filter_las_data(std::vector<struct LasPoint> &points,
									   double offset[3], double scale[3],
									   const struct Cfg &cfg)
{
	TAabb<double> box = las_bbox(cfg.x0, cfg.y0);
	std::vector<char> buf;
	if (cfg.verbose)
	{
		printf("Reading tile and neighbourhood around %04d_%04d :\n",
			   cfg.x0, cfg.y0);
	}
	int found = 0;
	for (int i = 0; i < 9; ++i)
	{
		int dx = (i % 3) - 1;
		int dy = (i / 3) - 1;
		if (dx != 0 && dy != 0)
		{
			continue;
		}
		int x = cfg.x0 + dx;
		int y = cfg.y0 + dy;
		const char *role = (dx == 0 && dy == 0) ? "center  " : "neighbor";

		/* With --las, look for las / laz. Without --las, only .copc.laz
		 * is looked up (unchanged behaviour). */
		LasFileInfo info;
		std::string fname;
		bool found_las = false;
		{
			static const char *las_exts[] = {"las", "laz"};
			static const char *copc_exts[] = {"copc.laz"};
			const char **exts = cfg.use_las ? las_exts : copc_exts;
			int next = cfg.use_las ? 3 : 1;
			for (int e = 0; e < next; ++e)
			{
				fname = get_las_filename(x, y, cfg.base_dir, exts[e]);
				if (!las_read_info(fname.c_str(), info))
				{
					found_las = true;
					break;
				}
			}
		}
		if (!found_las)
		{
			if (cfg.verbose)
			{
				printf("  [missing ] %04d_%04d (%+d,%+d) %s\n", x,
					   y, dx, dy, role);
			}
			continue;
		}
		size_t before = points.size();

		/* Decide the read path from the tile's actual encoding rather than
		 * cfg.use_las: a --las run may have fallen back to a compressed
		 * tile above and must still go through the matching decoder. */
		if (info.compressed && info.copc)
		{
			struct CopcReader *copc = copc_init(fname.c_str());
			if (!copc)
			{
				if (cfg.verbose)
				{
					printf("  [unread  ] %s\n", fname.c_str());
				}
				continue;
			}
			double alt_span = info.max[2] - info.min[2];
			double resolution = (alt_span < ALTITUDE_THRESHOLD) ? 1.0 : 0.0;
			uint32_t cell_count = copc_set_target_bbox(copc, box, resolution);
			for (uint32_t k = 0; k < cell_count; ++k)
			{
				int cell_points = copc_cell_point_count(copc, k);
				assert(cell_points);
				buf.reserve(cell_points * info.point_size);
				copc_read_cell(copc, k, &buf[0]);
				filter_and_add_points(points, &buf[0], cell_points,
									  info, box);
			}
			copc_fini(copc);
		}
		else
		{
			/* Plain .las, or a non-COPC .laz: no octree, load every point
			 * (decompressing first if needed) and filter by bbox. */
			char *data = info.compressed
							 ? las_load_laz_data(fname.c_str(), info, NULL)
							 : las_load_data(fname.c_str(), info, NULL);
			if (!data)
			{
				if (cfg.verbose)
				{
					printf("  [unread  ] %s\n", fname.c_str());
				}
				continue;
			}
			filter_and_add_points(points, data, (uint32_t)info.point_num,
								  info, box);
			free(data);
		}

		found++;
		if (cfg.verbose)
		{
			printf("  [found] %04d_%04d (%+d,%+d) %s : %zu pts\n",
				   x, y, dx, dy, role, points.size() - before);
		}
	}
	if (cfg.verbose)
	{
		printf("Found %d/5 tiles in neighbourhood.\n", found);
	}
	return points.size();
}

static int send_points_to_unit_cube(const std::vector<struct LasPoint> &points,
									Vec3 *pos, struct Transform &t,
									const Cfg cfg)
{
	int min_z = INT_MAX, max_z = -INT_MAX;
	for (size_t i = 0; i < points.size(); ++i)
	{
		min_z = MIN(min_z, points[i].z);
		max_z = MAX(max_z, points[i].z);
	}
	float span = (max_z - min_z) * 0.01f;
	printf("(Altitude span : %.0f meters)\n", span);
	float n;
	if (span < 1250.f)
	{
		n = 6;
	}
	else if (span < 1875.f)
	{
		n = 2;
	}
	else
	{
		return (-1);
	}
	t.scale = (float)n / (n + 2);
	t.shift.x = t.shift.y = 1.f / (n + 2);
	float mean = 0.5 * (min_z + max_z) * 1e-5 * t.scale;
	/* Round shift.z so that octree boxes match vertically to
	 * neighboors */
	t.shift.z = 0.5 - round(16 * mean) * 0.0625;
	assert(min_z * 1e-5 * t.scale + t.shift.z >= 0);
	assert(max_z * 1e-5 * t.scale + t.shift.z <= 1);
	for (size_t i = 0; i < points.size(); ++i)
	{
		double scal = 1e-5 * t.scale;
		/* IGN tile (x0,y0) is named by its NW corner: x0 is the WEST (min)
		 * edge, but y0 is the NORTH (max) edge, so the tile covers L93 north
		 * [y0-1, y0]. Local coords are referenced to the tile's min corner,
		 * hence x0 for east but (y0-1) for north. */
		pos[i].x = (points[i].x - 100000 * cfg.x0) * scal + t.shift.x;
		pos[i].y =
			(points[i].y - 100000 * (cfg.y0 - 1)) * scal + t.shift.y;
		pos[i].z = points[i].z * scal + t.shift.z;
		// printf("%lf %lf %lf\n", pos[i].x, pos[i].y, pos[i].z);
	}
	return (0);
}

/* Gather neighboring las files to build a 100m buffer of the
 * target tile, and then compute combined position + normal point
 * set from it: CGAL scale estimate -> PCA normals -> scanline
 * orientation (las_normal_cgal.h), then optional grid
 * thinning (las_resample.h).
 */
static int build_oriented_point_set(const struct Cfg &cfg, Timings &tt)
{

	/* Re-use existing output ? Only trust the cached points.ply when its
	 * companion .transf is present too; postprocess needs the transform to
	 * rescale the mesh, and a points.ply without it would later produce
	 * garbage-scaled tiles. */
	{
		std::string recon_in =
			get_filename(cfg.x0, cfg.y0, cfg.out_dir, "points.ply");
		struct Transform cached;
		FILE *f;
		if ((f = fopen(recon_in.c_str(), "rb")) != NULL)
		{
			fclose(f);
			if (!read_transform(cached, cfg))
			{
				printf("Using cached data in %s\n", recon_in.c_str());
				return (0);
			}
			printf("Cached %s has no transform; regenerating.\n",
				   recon_in.c_str());
		}
	}

	/* Read data */
	Timer chrono;
	chrono.start();
	std::vector<struct LasPoint> points;
	double offset[3];
	double scale[3];
	size_t las_num = read_and_filter_las_data(points,
											  offset, scale, cfg);

	/* CGAL::scanline_orient_normals requires scanline-contiguous input in
	 * acquisition order: sort by (source_id, gps_time). */
	std::sort(points.begin(), points.end(),
			  [](const LasPoint &a, const LasPoint &b)
			  {
				  if (a.source_id != b.source_id)
					  return a.source_id < b.source_id;
				  return a.gps_time < b.gps_time;
			  });

	tt.read_and_filter = chrono.stop();

	printf("Total Lidar points used    : %zu\n", las_num);

	if (!las_num)
	{
		printf("No data available for this tile.\n");
		return (-1);
	}

	printf("Set positions & transform  : ");
	/* Rescale and offset positions into buffer */
	Mesh mesh;
	MBuf data;
	data.vtx_attr = VtxAttr::PN;
	data.reserve_vertices(points.size() + 2); /* +2 for dummy box corners */

	struct Transform transf;
	if (send_points_to_unit_cube(points, data.positions, transf, cfg))
	{
		printf("Altitude span too large !\n");
		return (-1);
	}

	/* Normals: CGAL scale estimate (spatial window), PCA plane fit over
	 * capped spherical neighborhoods, scanline orientation. The estimated
	 * scale is in unit-cube units, like data.positions. */
	chrono.start();
	double range_scale = cgal_estimate_scale(data.positions, points.size());
	double nml_radius = 2.0 * range_scale;
	printf("Estimated range scale      : %g (radius %g)\n", range_scale,
		   nml_radius);
	/* Grid fix-up cell size: 1 m, mapped to unit-cube units the same way as
	 * --ds-grid below (1 unit = 100000 cm / scale). */
	double nml_grid_res = 1.0 * 100.f * 1e-5f * transf.scale;
	cgal_estimate_and_orient_normals(data.positions, points.size(), points,
									 nml_radius, nml_grid_res, data.normals,
									 cfg.verbose);
	mesh.vertex_count = points.size();
	tt.estim_nml = chrono.stop();

	/* Optional grid thinning. --ds-grid is given in metres and
	 * mapped to unit-cube units through the transform (1 unit = 100000 cm
	 * / scale). */
	if (cfg.downsample.enabled)
	{
		float grid_res = cfg.downsample.grid_res * 100.f * 1e-5f *
						 transf.scale;
		mesh.vertex_count = flat_area_thin(
			data.positions, data.normals, mesh.vertex_count, grid_res,
			cfg.downsample.neighbor_radius, cfg.downsample.slope_deg,
			cfg.verbose);
	}

	/* Add dummy points for bounding box to perfectly match unit
	 * cube */
	data.positions[mesh.vertex_count] = Vec3{0.f, 0.f, 0.f};
	data.normals[mesh.vertex_count] = Vec3{0.f, 0.f, 0.f};
	mesh.vertex_count++;
	data.positions[mesh.vertex_count] = Vec3{1.f, 1.f, 1.f};
	data.normals[mesh.vertex_count] = Vec3{0.f, 0.f, 0.f};
	mesh.vertex_count++;

	write_mesh(mesh, data, cfg, "points.ply");
	write_transform(transf, cfg);

	return (0);
}

/******************************************************************************
 *
 * III. Functions related to surface mesh (post)processing.
 *
 ******************************************************************************/

static void recut_mesh(Mesh &mesh, MBuf &data, const struct Transform &transf)
{
	/* Clip to the central tile, discarding the Poisson buffer strip.
	 * Note: here we have all offsets 0 so forget about them. */
	bool has_nml = (data.vtx_attr & VtxAttr::NML) != 0;

	TriMesh m;
	m.verts.resize(mesh.vertex_count);
	if (has_nml)
		m.normals.resize(mesh.vertex_count);
	for (uint32_t i = 0; i < mesh.vertex_count; ++i)
	{
		const Vec3 &p = data.positions[i];
		m.verts[i] = {p.x, p.y, p.z};
		if (has_nml)
		{
			const Vec3 &n = data.normals[i];
			m.normals[i] = {n.x, n.y, n.z};
		}
	}
	m.faces.assign(data.indices, data.indices + mesh.index_count);

	double sx = transf.shift.x, sy = transf.shift.y;
	TriMesh a, b, c, d;
	split_mesh(m, 0, sx, nullptr, &a);
	split_mesh(a, 0, 1.0 - sx, &b, nullptr);
	split_mesh(b, 1, sy, nullptr, &c);
	split_mesh(c, 1, 1.0 - sy, &d, nullptr);

	uint32_t new_vc = (uint32_t)d.verts.size();
	uint32_t new_ic = (uint32_t)d.faces.size();
	data.reserve_vertices(new_vc);
	data.reserve_indices(new_ic);
	for (uint32_t i = 0; i < new_vc; ++i)
	{
		data.positions[i] = {(float)d.verts[i].x, (float)d.verts[i].y,
							 (float)d.verts[i].z};
		if (has_nml)
			data.normals[i] = {(float)d.normals[i].x,
							   (float)d.normals[i].y,
							   (float)d.normals[i].z};
	}
	for (uint32_t i = 0; i < new_ic; ++i)
		data.indices[i] = d.faces[i];
	mesh.vertex_count = new_vc;
	mesh.index_count = new_ic;
}

static void rescale_and_offset_mesh(Mesh &mesh, MBuf &data,
									const struct Transform &transf,
									const struct Cfg &cfg)
{
	/* Inverse transform points + shift relative to base */
	/* TODO : should be eventually removed and use scene
	 *        object placement and scaling instead
	 */
	float invscale = 1. / transf.scale;
	for (size_t i = 0; i < mesh.vertex_count; ++i)
	{
		data.positions[i] = data.positions[i] - transf.shift;
		data.positions[i] *= invscale;
	}
}

/* Run the PoissonRecon binary.*/
static int run_poisson_recon(const std::string &recon_in,
							 const std::string &recon_out, int depth, const struct Cfg &cfg)
{
	const char *verbose = cfg.verbose ? "--verbose" : "";
	const char *format =
		"poissonrecon --in %s --out %s --scale 1.0 --depth %d "
		"--pointWeight %.1f %s --parallel %d --samplesPerNode 2.0 "
		"--performance";
	size_t len = recon_in.size() + recon_out.size() + strlen(format) + 64;
	std::string cmd(len, '\0');
	int written = snprintf(&cmd[0], len, format, recon_in.c_str(),
						   recon_out.c_str(), depth, cfg.weight, verbose,
						   cfg.parallel ? 0 : 2);
	cmd.resize(written);
	return system(cmd.c_str());
}

/* Turn a Poisson output mesh into a points-only PLY usable as the input of a
 * coarser Poisson run: derive per-vertex normals from the mesh faces
 * (compute_mesh_normals) and re-add the two [0,1] cube corners as zero-normal
 * points so the re-run keeps the same tile-consistent unit cube (Poisson's
 * IsValid drops the zero-normal corners after they have fixed the box). */
static int build_coarse_poisson_input(const std::string &in_ply,
									  const std::string &out_ply)
{
	Mesh mesh;
	MBuf data;
	if (load_ply(mesh, data, in_ply.c_str()) || mesh.index_count == 0)
		return (-1);
	data.reserve_vertices(mesh.vertex_count + 2);
	compute_mesh_normals(mesh, data);
	uint32_t c = mesh.vertex_count;
	data.positions[c] = Vec3{0.f, 0.f, 0.f};
	data.normals[c] = Vec3{0.f, 0.f, 0.f};
	data.positions[c + 1] = Vec3{1.f, 1.f, 1.f};
	data.normals[c + 1] = Vec3{0.f, 0.f, 0.f};
	mesh.vertex_count = c + 2;
	mesh.index_count = 0; /* points only: Poisson ignores faces */
	write_ply(out_ply.c_str(), mesh, data);
	data.clear();
	return (0);
}

static int build_surface_mesh(const struct Cfg &cfg, Timings &tt)
{
	/* Re-use existing output ? */
	std::string recon_out =
		get_filename(cfg.x0, cfg.y0, cfg.out_dir, "poisson.ply");
	FILE *f;
	if ((f = fopen(recon_out.c_str(), "rb")) != NULL)
	{
		printf("Using cached data in %s\n", recon_out.c_str());
		fclose(f);
		return 0;
	}

	Timer chrono;
	chrono.start();
	std::string recon_in =
		get_filename(cfg.x0, cfg.y0, cfg.out_dir, "points.ply");
	int ret = run_poisson_recon(recon_in, recon_out, cfg.depth, cfg);

	if (cfg.clean >= 2)
	{
		std::string rm = "rm -f " + recon_in;
		system(rm.c_str());
	}

	tt.poisson_recon = chrono.stop();
	return (ret);
}

int write_encoded_mesh(const Mesh &mesh, const MBuf &data, const Cfg &cfg,
					   const char *ext)
{
	uint32_t index_count = mesh.index_count;
	uint32_t vertex_count = mesh.vertex_count;
	std::vector<TVec3<uint16_t>> qpos(vertex_count);
	for (size_t i = 0; i < vertex_count; ++i)
	{
		Vec3 pos = data.positions[i + mesh.vertex_offset];
		qpos[i].x = pos.x * (1 << 15) + (1 << 14);
		qpos[i].y = pos.y * (1 << 15) + (1 << 14);
		qpos[i].z = pos.z * (1 << 14); /* TODO : scale in z */
	}
	uint32_t *indices = data.indices + mesh.index_offset;
	// void *vertices = qpos.data();
	// size_t vertex_size = sizeof(TVec3<uint16_t>);
	void *vertices = data.positions + mesh.vertex_offset;
	size_t vertex_size = sizeof(Vec3);
	std::vector<uint8_t> vbuf(
		meshopt_encodeVertexBufferBound(vertex_count, vertex_size));
	vbuf.resize(meshopt_encodeVertexBuffer(&vbuf[0], vbuf.size(), vertices,
										   vertex_count, vertex_size));
	printf("Bytes per vertex : %.1f\n", (float)vbuf.size() / vertex_count);
	std::vector<uint8_t> ibuf(
		meshopt_encodeIndexBufferBound(index_count, vertex_count));
	ibuf.resize(meshopt_encodeIndexBuffer(&ibuf[0], ibuf.size(), indices,
										  index_count));
	printf("Index bytes per triangle : %.1f\n",
		   3 * (float)ibuf.size() / index_count);

	std::string fname = get_filename(cfg.x0, cfg.y0, cfg.out_dir, ext);
	FILE *f = fopen(fname.c_str(), "wb");
	int ret = (f == NULL) || fwrite(vbuf.data(), vbuf.size(), 1, f) != 1 ||
					  fwrite(ibuf.data(), ibuf.size(), 1, f) != 1
				  ? -1
				  : 0;
	fclose(f);
	return (ret);
}

int postprocess_surface_mesh(const Cfg &cfg, Timings &tt)
{
	std::string recon_out =
		get_filename(cfg.x0, cfg.y0, cfg.out_dir, "poisson.ply");
	const bool do_trim = cfg.trim > 0.f;
	Timer chrono;

	/* The transform maps the Poisson [0,1] cube back to km; every LOD level
	 * needs it, so read and validate it once. A missing .transf next to a
	 * cached poisson.ply would rescale with garbage (~1e9 coords, freezing any
	 * WebGL viewer), so bail rather than write bad tiles. */
	struct Transform transf;
	if (read_transform(transf, cfg))
	{
		printf("Error: missing/unreadable transform for %04d_%04d; "
			   "cannot rescale mesh.\n",
			   cfg.x0, cfg.y0);
		return (-1);
	}

	const int maxlv = cfg.lod.max_level;

	/* Per-level source meshes. The finest level (maxlv) is the depth-cfg.depth
	 * reconstruction (recon_out). Each coarser level re-meshes the previous
	 * level's Poisson output one octree depth lower: normals are re-derived
	 * from that mesh's faces (build_coarse_poisson_input) and it is
	 * reconstructed at depth cfg.depth-(maxlv-z). This replaces vertex-cluster
	 * decimation of the finest mesh with a native coarse reconstruction. */
	std::vector<std::string> level_ply(maxlv >= 0 ? maxlv + 1 : 0);
	if (maxlv >= 0)
		level_ply[maxlv] = recon_out;
	for (int z = maxlv - 1; z >= 0; --z)
	{
		chrono.start();
		char ext[32];
		snprintf(ext, sizeof(ext), "poisson.%d.ply", z);
		std::string out = get_filename(cfg.x0, cfg.y0, cfg.out_dir, ext);
		std::string coarse_in =
			get_filename(cfg.x0, cfg.y0, cfg.out_dir, "coarse_points.ply");
		int depth = cfg.depth - (maxlv - z) - 1;
		if (build_coarse_poisson_input(level_ply[z + 1], coarse_in) ||
			run_poisson_recon(coarse_in, out, depth, cfg))
		{
			printf("Warning: coarse Poisson for z=%d (depth %d) failed; "
				   "reusing z=%d source.\n",
				   z, depth, z + 1);
			level_ply[z] = level_ply[z + 1];
		}
		else
			level_ply[z] = out;
		if (cfg.clean >= 2)
			remove(coarse_in.c_str());
		tt.coarse_recon += chrono.stop();
	}

	/* Load, transform to km and tile each level from its own mesh. */
	for (int z = 0; z <= maxlv; ++z)
	{
		chrono.start();
		Mesh mesh;
		MBuf data;
		load_ply(mesh, data, level_ply[z].c_str());
		if (z == maxlv)
			printf("A total of %d (%.2f M) Tri after poisson "
				   "reconstruct.\n",
				   mesh.index_count / 3, 1e-6 * mesh.index_count / 3);

		recut_mesh(mesh, data, transf);

		if (z == maxlv)
		{
			if (do_trim)
			{
				Timer trim;
				trim.start();
				uint32_t tri_before = mesh.index_count / 3;
				uint32_t num_cc =
					select_principal_connected_component(mesh, data);
				tt.trim += trim.stop();
				if (num_cc > 1)
					printf("  LOD z=%d : %u components, kept %u/%u Tri\n", z,
						   num_cc, mesh.index_count / 3, tri_before);
			}
			uint32_t tri_before = mesh.index_count / 3;
			Timer simp;
			simp.start();
			simplify_mesh_qem(mesh, data, 0.8f, 2.0, cfg.verbose);
			unsigned int simp_us = simp.stop();
			uint32_t tri_after = mesh.index_count / 3;
			printf("Simplify QEM: %u -> %u Tri (ratio %.3f, target 0.5) "
				   "in %.2f s\n",
				   tri_before, tri_after,
				   tri_before ? (float)tri_after / tri_before : 0.f,
				   1e-6 * simp_us);
		}

		rescale_and_offset_mesh(mesh, data, transf, cfg);

		if (cfg.optimize)
		{
			Timer opt;
			opt.start();
			compact_mesh(mesh, data);
			optimize_mesh(mesh, data);
			printf("  LOD z=%d : compact+optimize in %.2f s\n", z,
				   1e-6 * opt.stop());
		}

		write_lod_level(mesh, data, cfg.x0, cfg.y0, z, cfg.lod.skirt_depth,
						cfg.out_dir.c_str(), cfg.verbose);

		if (cfg.clean >= 2 && z != maxlv)
			remove(level_ply[z].c_str());
		data.clear();
		tt.lod += chrono.stop();
	}

	if (cfg.clean)
	{
		std::string cmd = "rm -f " + recon_out;
		system(cmd.c_str());
	}

	/* clean>=2 removes the intermediate .transf too (like points.ply). It is
	 * only safe here: read_transform() above has already consumed it. Leaving
	 * a stale .transf next to a cached poisson.ply is exactly what produced
	 * the uninitialised-transform garbage tiles. */
	if (cfg.clean >= 2)
	{
		std::string transf =
			get_filename(cfg.x0, cfg.y0, cfg.out_dir, "transf");
		std::string cmd = "rm -f " + transf;
		system(cmd.c_str());
	}

	return (0);
}

/******************************************************************************
 *
 * IV. Main.
 *
 ******************************************************************************/

int main(int argc, char **argv)
{
	struct Cfg cfg;
	struct Timings tt;
	Timer chrono;

	chrono.start();

	/* Process command line arguments */
	int args_ret = process_args(argc, (const char **)argv, cfg);
	if (args_ret > 0)
	{
		return (0); /* --help was shown */
	}
	if (args_ret < 0)
	{
		return (-1);
	}

	printf("\n------ Start of alpineview_builder for %04d %04d ------\n", cfg.x0,
		   cfg.y0);

	if (cfg.verbose)
	{
		print_cfg(cfg);
	}

	printf("\n");
	printf("I. Building oriented point set :\n");
	printf("--------------------------------\n");
	if (build_oriented_point_set(cfg, tt))
	{
		printf("Error in building oriented point set.\n");
		return (-1);
	}

	printf("\n");
	printf("II. Building surface mesh from point set :\n");
	printf("------------------------------------------\n");

	if (build_surface_mesh(cfg, tt))
	{
		printf("Error in Poisson reconstruction\n");
		return (-1);
	}

	printf("\n");
	printf("III. Postprocessing surface mesh.\n");
	printf("---------------------------------\n");

	if (postprocess_surface_mesh(cfg, tt))
	{
		printf("Error in Poisson reconstruction\n");
		return (-1);
	}

	tt.total = chrono.stop();

	print_timings(tt);

	printf("\n------ End of alpineview_builder for %04d %04d ------\n", cfg.x0,
		   cfg.y0);

	return (0);
}

/******************************************************************************/
