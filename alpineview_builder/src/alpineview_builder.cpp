#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "array.h"
#include "chrono.h"
#include "geo.h"
#include "math_utils.h"
#include "sys_utils.h"

#include "mesh.h"
#include "mesh_lod.h"
#include "mesh_ply.h"
#include "mesh_utils.h"
#include "poisson_common.h"

#include "copc.h"
#include "las_resample.h"
#include "las_normal_cgal.h"
#include "las_read.h"

/* Size of tile boundary buffer in cm */
#define BDY_BUFFER 10000

static const double ALTITUDE_THRESHOLD = 2000.0;

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
	int min_depth;
	int max_depth;
	float weight;
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
	cfg.min_depth = 7;
	cfg.max_depth = -1;
	cfg.weight = 4.f;
	cfg.parallel = false;
	cfg.clean = 2;
	cfg.verbose = true;
	cfg.optimize = false;
	cfg.encode = false;
	cfg.use_las = true;
	cfg.downsample.enabled = true;
	cfg.downsample.grid_res = 1.f;
	cfg.downsample.neighbor_radius = 5;
	cfg.downsample.slope_deg = 45.f;
	cfg.lod.max_level = -1;
}

static void print_usage(const char *prog)
{
	printf(
		"Usage: %s X Y [options]\n"
		"\n"
		"  X, Y                 WebMercatorQuad tile column and row at\n"
		"                       level 15 (required).\n"
		"\n"
		"Paths:\n"
		"  --base-dir DIR       input COPC directory "
		"(default: $HOME/.cache/poissonrecon-ign/)\n"
		"                       expects "
		"LHD_FXX_XXXX_YYYY_PTS_LAMB93_IGN69.copc.laz tiles\n"
		"  --out-dir DIR        output directory (default: .)\n"
		"\n"
		"Reconstruction:\n"
		"  --min-depth N        Poisson octree depth of LOD level 0 "
		"(default: 7)\n"
		"  --max-depth N        Poisson octree depth of the finest LOD level;\n"
		"                       -1 guesses it from altitude span and point\n"
		"                       spacing (default: -1)\n"
		"  --weight F           Poisson point weight (default: 4)\n"
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
		"  -h, --help           show this help and exit\n",
		prog);
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
		else if (strcmp(arg, "--min-depth") == 0)
		{
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.min_depth = atoi(val);
		}
		else if (strcmp(arg, "--max-depth") == 0)
		{
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.max_depth = atoi(val);
		}
		else if (strcmp(arg, "--weight") == 0)
		{
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.weight = atof(val);
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
		printf("Error: missing WebMercatorQuad tile X Y. Try --help.\n");
		return (-1);
	}

	return (0);
}

static void print_cfg(const struct Cfg &cfg)
{
	printf("\n");
	printf("Configuration :\n");
	printf("---------------\n");
	printf("WMQ tile    : %d/%d/%d\n", geo().lod_level0, cfg.x0, cfg.y0);
	{
		double x0, y0, x1, y1;
		geo_wmq_tile_bounds(geo().lod_level0, cfg.x0, cfg.y0, x0, y0, x1,
							y1);
		Vec3d nw = geo_work_to_geodetic(Vec3d{x0, y1, 0.0});
		Vec3d se = geo_work_to_geodetic(Vec3d{x1, y0, 0.0});
		printf("  extent    : lon %.6f..%.6f lat %.6f..%.6f\n", nw.x,
			   se.x, se.y, nw.y);
		printf("  side      : %.2f m (work frame)\n", x1 - x0);
	}
	printf("Data  dir   : %s\n", cfg.base_dir.c_str());
	printf("Output dir  : %s\n", cfg.out_dir.c_str());
	printf("Verbosity   : %d\n", cfg.verbose ? 1 : 0);
	if (cfg.max_depth < 0)
	{
		printf("Depths      : min=%d max=auto\n", cfg.min_depth);
	}
	else
	{
		printf("Depths      : min=%d max=%d (%d LOD levels)\n", cfg.min_depth,
			   cfg.max_depth, cfg.max_depth - cfg.min_depth + 1);
	}
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

static int write_mesh(const TriMesh &mesh, const struct Cfg &cfg,
					  const char *ext)
{

	std::string fname = get_filename(cfg.x0, cfg.y0, cfg.out_dir, ext);
	write_ply(fname.c_str(), mesh);

	return (0);
}

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

	return (p.classification == 2 || p.classification == 5 || p.classification == 9 || p.classification == 10 || p.classification == 11);
}

static const double TILE_MARGIN_M = 50.0;

static TAabb<double> las_bbox(int x0, int y0)
{
	double wx0, wy0, wx1, wy1;
	geo_wmq_tile_bounds(geo().lod_level0, x0, y0, wx0, wy0, wx1, wy1);
	wx0 -= TILE_MARGIN_M;
	wy0 -= TILE_MARGIN_M;
	wx1 += TILE_MARGIN_M;
	wy1 += TILE_MARGIN_M;

	const int SAMPLES = 5;
	Vec3d edge[4 * SAMPLES];
	int n = 0;
	for (int i = 0; i < SAMPLES; ++i)
	{
		double t = (double)i / (SAMPLES - 1);
		double x = wx0 + t * (wx1 - wx0);
		double y = wy0 + t * (wy1 - wy0);
		edge[n++] = geo_work_to_geodetic(Vec3d{x, wy0, 0.0});
		edge[n++] = geo_work_to_geodetic(Vec3d{x, wy1, 0.0});
		edge[n++] = geo_work_to_geodetic(Vec3d{wx0, y, 0.0});
		edge[n++] = geo_work_to_geodetic(Vec3d{wx1, y, 0.0});
	}
	geo_geodetic_to_l93(edge, n);

	TAabb<double> box;
	box.min.x = box.min.y = 1e30;
	box.max.x = box.max.y = -1e30;
	for (int i = 0; i < n; ++i)
	{
		box.min.x = MIN(box.min.x, edge[i].x);
		box.min.y = MIN(box.min.y, edge[i].y);
		box.max.x = MAX(box.max.x, edge[i].x);
		box.max.y = MAX(box.max.y, edge[i].y);
	}
	box.min.z = -1000;
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
	int kx0 = (int)floor(box.min.x / 1000.0);
	int kx1 = (int)floor(box.max.x / 1000.0);
	int ky0 = (int)ceil(box.min.y / 1000.0);
	int ky1 = (int)ceil(box.max.y / 1000.0);
	int wanted = (kx1 - kx0 + 1) * (ky1 - ky0 + 1);
	if (cfg.verbose)
	{
		printf("Reading L93 tiles %04d..%04d x %04d..%04d covering "
			   "WMQ tile %d/%d/%d :\n",
			   kx0, kx1, ky0, ky1, geo().lod_level0, cfg.x0, cfg.y0);
	}
	int found = 0;
	for (int i = 0; i < wanted; ++i)
	{
		int x = kx0 + i % (kx1 - kx0 + 1);
		int y = ky0 + i / (kx1 - kx0 + 1);
		const char *role = "source  ";

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
				printf("  [missing ] %04d_%04d %s\n", x, y, role);
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
			const double resolution = 1.0;
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
			printf("  [found] %04d_%04d %s : %zu pts\n", x, y, role,
				   points.size() - before);
		}
	}
	if (cfg.verbose)
	{
		printf("Found %d/%d source tiles.\n", found, wanted);
	}
	return points.size();
}

static int send_points_to_unit_cube(const std::vector<struct LasPoint> &points,
									Vec3 *pos, struct Transform &t,
									const Cfg cfg, double &max_alt)
{
	size_t num = points.size();
	std::vector<Vec3d> work(num);
	for (size_t i = 0; i < num; ++i)
	{
		work[i].x = points[i].x * 0.01;
		work[i].y = points[i].y * 0.01;
		work[i].z = points[i].z * 0.01;
	}
	if (geo_l93_to_geodetic(work.data(), num))
	{
		return (-1);
	}
	for (size_t i = 0; i < num; ++i)
	{
		work[i] = geo_geodetic_to_work(work[i]);
	}

	double min_z = 1e30, max_z = -1e30;
	for (size_t i = 0; i < num; ++i)
	{
		min_z = MIN(min_z, work[i].z);
		max_z = MAX(max_z, work[i].z);
	}
	float span = (float)(max_z - min_z);
	max_alt = max_z;
	printf("(Altitude span : %.0f meters, max %.0f m NGF69)\n", span,
		   max_alt);
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

	double wx0, wy0, wx1, wy1;
	geo_wmq_tile_bounds(geo().lod_level0, cfg.x0, cfg.y0, wx0, wy0, wx1, wy1);
	double scal = t.scale / (wx1 - wx0);

	float mean = 0.5 * (min_z + max_z) * scal;
	/* Round shift.z so that octree boxes match vertically to
	 * neighboors */
	t.shift.z = 0.5 - round(16 * mean) * 0.0625;
	assert(min_z * scal + t.shift.z >= 0);
	assert(max_z * scal + t.shift.z <= 1);
	for (size_t i = 0; i < num; ++i)
	{
		pos[i].x = (work[i].x - wx0) * scal + t.shift.x;
		pos[i].y = (work[i].y - wy0) * scal + t.shift.y;
		pos[i].z = work[i].z * scal + t.shift.z;
	}
	return (0);
}

static int guess_max_depth(double range_scale, double max_alt)
{
	int alt_cap = (max_alt < ALTITUDE_THRESHOLD) ? 10 : 11;
	int scale_cap = (int)floor(log2(1.0 / (range_scale * 0.75)));
	int depth = MIN(alt_cap, scale_cap);
	printf("Guessing max depth :\n");
	printf("  max altitude %.0f m (threshold %.0f m) -> depth <= %d\n", max_alt,
		   ALTITUDE_THRESHOLD, alt_cap);
	printf("  range scale %g -> depth <= %d (cell %g >= %g)\n", range_scale,
		   scale_cap, 1.0 / (1 << scale_cap), range_scale);
	printf("  max depth = %d\n", depth);
	return depth;
}

static void resolve_lod_levels(struct Cfg &cfg)
{
	if (cfg.min_depth < geo().level0_depth)
	{
		printf("Warning: min depth %d below level-0 depth %d; clamping.\n",
			   cfg.min_depth, geo().level0_depth);
		cfg.min_depth = geo().level0_depth;
	}
	if (cfg.max_depth < cfg.min_depth)
	{
		printf("Warning: max depth %d below min depth %d; clamping to %d.\n",
			   cfg.max_depth, cfg.min_depth, cfg.min_depth);
		cfg.max_depth = cfg.min_depth;
	}
	cfg.lod.max_level = cfg.max_depth - geo().level0_depth;
	printf("LOD levels                 : z=%d..%d (Poisson depths %d..%d)\n",
		   cfg.min_depth - geo().level0_depth, cfg.lod.max_level, cfg.min_depth,
		   cfg.max_depth);
	for (int d = cfg.min_depth; d <= cfg.max_depth; ++d)
	{
		int z = d - geo().level0_depth;
		int n = 1 << z;
		printf("  depth %2d -> z=%d : %dx%d grid, %d tiles of %.1f m "
			   "at level %d\n",
			   d, z, n, n, n * n,
			   geo_wmq_tile_size(geo().lod_level0 + z), geo().lod_level0 + z);
	}
}

/* Gather neighboring las files to build a 100m buffer of the
 * target tile, and then compute combined position + normal point
 * set from it: CGAL scale estimate -> PCA normals -> scanline
 * orientation (las_normal_cgal.h), then optional grid
 * thinning (las_resample.h).
 */
static int build_oriented_point_set(struct Cfg &cfg, Timings &tt)
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
				if (cfg.max_depth < 0)
				{
					cfg.max_depth = 10;
					printf("Cached point set: cannot guess max depth, "
						   "using %d.\n",
						   cfg.max_depth);
				}
				resolve_lod_levels(cfg);
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
	TriMesh mesh;
	mesh.verts.resize(points.size() + 2); /* +2 for dummy box corners */
	mesh.normals.resize(points.size() + 2);

	struct Transform transf;
	double max_alt = 0.0;
	if (send_points_to_unit_cube(points, mesh.verts.data(), transf, cfg, max_alt))
	{
		printf("Altitude span too large !\n");
		return (-1);
	}

	/* Normals: CGAL scale estimate (spatial window), PCA plane fit over
	 * capped spherical neighborhoods, scanline orientation. The estimated
	 * scale is in unit-cube units, like data.positions. */
	chrono.start();
	double range_scale = cgal_estimate_scale(mesh.verts.data(), points.size());
	double nml_radius = 2.0 * range_scale;
	printf("Estimated range scale      : %g (radius %g)\n", range_scale,
		   nml_radius);
	if (cfg.max_depth < 0)
		cfg.max_depth = guess_max_depth(range_scale, max_alt);
	resolve_lod_levels(cfg);
	/* Grid fix-up cell size: 1 m, mapped to unit-cube units the same way as
	 * --ds-grid below (1 unit = one WMQ tile side / scale). */
	double nml_grid_res =
		1.0 * transf.scale / geo_wmq_tile_size(geo().lod_level0);
	cgal_estimate_and_orient_normals(mesh.verts.data(), points.size(), points,
									 nml_radius, nml_grid_res,
									 mesh.normals.data(), cfg.verbose);
	size_t vertex_count = points.size();
	tt.estim_nml = chrono.stop();

	/* Optional grid thinning. --ds-grid is given in metres and
	 * mapped to unit-cube units through the transform (1 unit = one WMQ
	 * tile side / scale). */
	if (cfg.downsample.enabled)
	{
		float grid_res = cfg.downsample.grid_res * transf.scale /
						 geo_wmq_tile_size(geo().lod_level0);
		vertex_count = flat_area_thin(
			mesh.verts.data(), mesh.normals.data(), vertex_count, grid_res,
			cfg.downsample.neighbor_radius, cfg.downsample.slope_deg,
			cfg.verbose);
	}

	/* Add dummy points for bounding box to perfectly match unit
	 * cube */
	mesh.verts[vertex_count] = Vec3{0.f, 0.f, 0.f};
	mesh.normals[vertex_count] = Vec3{0.f, 0.f, 0.f};
	vertex_count++;
	mesh.verts[vertex_count] = Vec3{1.f, 1.f, 1.f};
	mesh.normals[vertex_count] = Vec3{0.f, 0.f, 0.f};
	vertex_count++;
	mesh.verts.resize(vertex_count);
	mesh.normals.resize(vertex_count);

	write_mesh(mesh, cfg, "points.ply");
	write_transform(transf, cfg);

	return (0);
}

/******************************************************************************
 *
 * III. Functions related to surface mesh (post)processing.
 *
 ******************************************************************************/

/* Turn a Poisson output mesh into a points-only PLY usable as the input of a
 * coarser Poisson run: derive per-vertex normals from the mesh faces
 * (compute_mesh_normals) and re-add the two [0,1] cube corners as zero-normal
 * points so the re-run keeps the same tile-consistent unit cube (Poisson's
 * IsValid drops the zero-normal corners after they have fixed the box). */
static int build_coarse_poisson_input(const std::string &in_ply,
									  const std::string &out_ply)
{
	TriMesh mesh;
	if (load_ply(mesh, in_ply.c_str(), false) || mesh.faces.empty())
		return (-1);
	compute_mesh_normals(mesh);
	mesh.verts.push_back(Vec3{0.f, 0.f, 0.f});
	mesh.normals.push_back(Vec3{0.f, 0.f, 0.f});
	mesh.verts.push_back(Vec3{1.f, 1.f, 1.f});
	mesh.normals.push_back(Vec3{0.f, 0.f, 0.f});
	mesh.faces.clear(); /* points only: Poisson ignores faces */
	write_ply(out_ply.c_str(), mesh);
	mesh.clear();
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
	int ret = run_poisson_recon(recon_in, recon_out, cfg.max_depth, cfg.weight,
								cfg.verbose, cfg.parallel, true);

	if (cfg.clean >= 2)
	{
		std::string rm = "rm -f " + recon_in;
		system(rm.c_str());
	}

	tt.poisson_recon = chrono.stop();
	return (ret);
}

int postprocess_surface_mesh(const Cfg &cfg, Timings &tt)
{
	std::string recon_out =
		get_filename(cfg.x0, cfg.y0, cfg.out_dir, "poisson.ply");
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

	const int min_depth = cfg.min_depth;
	const int max_depth = cfg.max_depth;
	const int nlv = max_depth - min_depth;

	/* Per-level source meshes, indexed by depth-min_depth. The finest level is
	 * the depth-cfg.max_depth reconstruction (recon_out). Each coarser level
	 * re-meshes the previous level's Poisson output one octree depth lower:
	 * normals are re-derived from that mesh's faces
	 * (build_coarse_poisson_input) and it is reconstructed at that depth. This
	 * replaces vertex-cluster decimation of the finest mesh with a native
	 * coarse reconstruction. */
	std::vector<std::string> level_ply(nlv + 1);
	level_ply[nlv] = recon_out;
	for (int i = nlv - 1; i >= 0; --i)
	{
		chrono.start();
		int depth = min_depth + i;
		char ext[32];
		snprintf(ext, sizeof(ext), "poisson.%d.ply", depth);
		std::string out = get_filename(cfg.x0, cfg.y0, cfg.out_dir, ext);
		std::string coarse_in =
			get_filename(cfg.x0, cfg.y0, cfg.out_dir, "coarse_points.ply");
		if (build_coarse_poisson_input(level_ply[i + 1], coarse_in) ||
			run_poisson_recon(coarse_in, out, depth, cfg.weight, cfg.verbose,
							  cfg.parallel, true))
		{
			printf("Warning: coarse Poisson at depth %d failed; "
				   "reusing depth %d source.\n",
				   depth, depth + 1);
			level_ply[i] = level_ply[i + 1];
		}
		else
			level_ply[i] = out;
		if (cfg.clean >= 2)
			remove(coarse_in.c_str());
		tt.coarse_recon += chrono.stop();
	}

	/* Load, transform to km and tile each level from its own mesh. The web zoom
	 * level of a depth is fixed: z = depth - level0_depth, so the grid and the
	 * tile names of a given depth never depend on the requested depth range. */
	for (int i = 0; i <= nlv; ++i)
	{
		chrono.start();
		int depth = min_depth + i;
		int z = depth - geo().level0_depth;
		printf("  LOD z=%d : depth %d, %dx%d grid\n", z, depth, 1 << z,
			   1 << z);
		TriMesh mesh;
		load_ply(mesh, level_ply[i].c_str(), false);
		if (i == nlv)
			printf("A total of %zu (%.2f M) Tri after poisson "
				   "reconstruct.\n",
				   mesh.triangle_count(), 1e-6 * mesh.triangle_count());

		postprocess_lod_level(mesh, transf, geo().lod_level0, cfg.x0, cfg.y0,
							  z, cfg.out_dir, cfg.optimize, cfg.verbose);

		if (cfg.clean >= 2 && i != nlv)
			remove(level_ply[i].c_str());
		mesh.clear();
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

	if (geo_init())
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
