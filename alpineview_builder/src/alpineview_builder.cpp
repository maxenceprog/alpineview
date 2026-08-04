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

#include "las_normal_cgal.h"
#include "las_read.h"
#include "las_resample.h"

/* Size of tile boundary buffer in cm */
#define BDY_BUFFER 10000

static const double ALTITUDE_THRESHOLD = 2000.0;

/******************************************************************************
 *
 * I. Args and filenames.
 *
 ******************************************************************************/

struct Cfg {
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
	bool parallel;
	DownsampleCfg downsample;
	LodCfg lod;
};

struct Timings {
	unsigned int read_and_filter = 0;
	unsigned int estim_nml = 0;
	unsigned int poisson_recon = 0;
	unsigned int trim = 0;		   /* surfacetrimmer */
	unsigned int coarse_recon = 0; /* coarse LOD Poisson re-runs */
	unsigned int lod = 0;		   /* load + km transform + Draco tiling */
	unsigned int total = 0;
};

static void setDefaultCfg(struct Cfg &cfg) {
	cfg.x0 = 0;
	cfg.y0 = 0;
	const char *home = getenv("HOME");
	if (home) {
		cfg.base_dir = std::string(home) + "/.cache/poissonrecon-ign/";
	} else {
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
	cfg.downsample.enabled = true;
	cfg.downsample.grid_res = 1.f;
	cfg.downsample.neighbor_radius = 5;
	cfg.downsample.slope_deg = 45.f;
	cfg.lod.max_level = -1;
}

static void printUsage(const char *prog) {
	printf(
		"Usage: %s X Y [options]\n"
		"\n"
		"  X, Y                 WebMercatorQuad tile column and row at\n"
		"                       level 15 (required).\n"
		"\n"
		"Paths:\n"
		"  --base-dir DIR       input directory "
		"(default: $HOME/.cache/poissonrecon-ign/)\n"
		"                       expects "
		"LHD_FXX_XXXX_YYYY_PTS_LAMB93_IGN69.laz tiles\n"
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
		"  -h, --help           show this help and exit\n",
		prog);
}

/* Parse "--flag" / "--no-flag" boolean pair. Returns 1 if `arg` matched
 * `name`, in which case *out is set accordingly; 0 if no match. */
static int matchToggle(const char *arg, const char *name, bool &out) {
	if (strcmp(arg, name) == 0) {
		out = true;
		return 1;
	}
	if (strncmp(arg, "--no-", 5) == 0 && strcmp(arg + 5, name + 2) == 0) {
		out = false;
		return 1;
	}
	return 0;
}

static int processArgs(int argc, const char **argv, struct Cfg &cfg) {
	setDefaultCfg(cfg);

	/* Collect the two required positional coordinates, then flags. */
	int positional = 0;
	for (int i = 1; i < argc; ++i) {
		const char *arg = argv[i];

		if (strcmp(arg, "-h") == 0 || strcmp(arg, "--help") == 0) {
			printUsage(argv[0]);
			return (1); /* handled, ask caller to exit cleanly */
		}

		if (arg[0] != '-') {
			if (positional == 0) {
				cfg.x0 = atoi(arg);
			} else if (positional == 1) {
				cfg.y0 = atoi(arg);
			} else {
				printf("Error: unexpected argument '%s'.\n", arg);
				return (-1);
			}
			++positional;
			continue;
		}

		const char *val = NULL;
		if (strcmp(arg, "--base-dir") == 0) {
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.base_dir = val;
		} else if (strcmp(arg, "--out-dir") == 0) {
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.out_dir = val;
		} else if (strcmp(arg, "--min-depth") == 0) {
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.min_depth = atoi(val);
		} else if (strcmp(arg, "--max-depth") == 0) {
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.max_depth = atoi(val);
		} else if (strcmp(arg, "--weight") == 0) {
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.weight = atof(val);
		} else if (strcmp(arg, "--clean") == 0) {
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.clean = atoi(val);
		} else if (strcmp(arg, "--ds-grid") == 0) {
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.downsample.grid_res = atof(val);
		} else if (strcmp(arg, "--ds-radius") == 0) {
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.downsample.neighbor_radius = atoi(val);
		} else if (strcmp(arg, "--ds-slope") == 0) {
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.downsample.slope_deg = atof(val);
		} else if (matchToggle(arg, "--verbose", cfg.verbose) ||
				   matchToggle(arg, "--optimize", cfg.optimize) ||
				   matchToggle(arg, "--encode", cfg.encode) ||
				   matchToggle(arg, "--downsample", cfg.downsample.enabled) ||
				   matchToggle(arg, "--parallel", cfg.parallel)) {
			/* handled by match_toggle */
		} else {
			printf("Error: unknown option '%s'. Try --help.\n", arg);
			return (-1);
		}
	}

	if (positional < 2) {
		printf("Error: missing WebMercatorQuad tile X Y. Try --help.\n");
		return (-1);
	}

	return (0);
}

static void printCfg(const struct Cfg &cfg) {
	printf("\n");
	printf("Configuration :\n");
	printf("---------------\n");
	printf("WMQ tile    : %d/%d/%d\n", geo().lod_level0, cfg.x0, cfg.y0);
	{
		double x0, y0, x1, y1;
		geo_wmq_tile_bounds(geo().lod_level0, cfg.x0, cfg.y0, x0, y0, x1, y1);
		Vec3d nw = geo_work_to_geodetic(Vec3d{x0, y1, 0.0});
		Vec3d se = geo_work_to_geodetic(Vec3d{x1, y0, 0.0});
		printf("  extent    : lon %.6f..%.6f lat %.6f..%.6f\n", nw.x, se.x,
			   se.y, nw.y);
		printf("  side      : %.2f m (work frame)\n", x1 - x0);
	}
	printf("Data  dir   : %s\n", cfg.base_dir.c_str());
	printf("Output dir  : %s\n", cfg.out_dir.c_str());
	printf("Verbosity   : %d\n", cfg.verbose ? 1 : 0);
	if (cfg.max_depth < 0) {
		printf("Depths      : min=%d max=auto\n", cfg.min_depth);
	} else {
		printf("Depths      : min=%d max=%d (%d LOD levels)\n", cfg.min_depth,
			   cfg.max_depth, cfg.max_depth - cfg.min_depth + 1);
	}
	if (cfg.downsample.enabled) {
		printf("Downsample  : grid=%gm radius=%d slope=%.0fdeg\n",
			   cfg.downsample.grid_res, cfg.downsample.neighbor_radius,
			   cfg.downsample.slope_deg);
	} else {
		printf("Downsample  : off\n");
	}
}

static void printTimings(const Timings &tt) {
	unsigned div = 1000000;
	unsigned int other = tt.total - tt.read_and_filter - tt.estim_nml -
						 tt.poisson_recon - tt.trim - tt.coarse_recon - tt.lod;
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

static std::string getFilename(int x, int y, const std::string &dir,
							   const char *ext) {
	std::string fname = dir;
	if (!fname.empty() && fname.back() != '/') {
		fname += '/';
	}
	char suffix[32];
	snprintf(suffix, sizeof(suffix), "%04d_%04d.%s", x, y, ext);
	fname += suffix;

	return fname;
}

/* Build the path of an input IGN LIDAR HD tile, e.g.
 * <dir>/LHD_FXX_0965_6431_PTS_LAMB93_IGN69.laz
 * (the XXXX_YYYY in the name are the tile's km coordinates). */
static std::string getLasFilename(int x, int y, const std::string &dir,
								  const char *ext = "laz") {
	std::string fname = dir;
	if (!fname.empty() && fname.back() != '/') {
		fname += '/';
	}
	char suffix[64];
	snprintf(suffix, sizeof(suffix), "LHD_FXX_%04d_%04d_PTS_LAMB93_IGN69.%s", x,
			 y, ext);
	fname += suffix;

	return fname;
}

/******************************************************************************
 *
 * II. Utility fonctions.
 *
 ******************************************************************************/

static int writeMesh(const TriMesh &mesh, const struct Cfg &cfg,
					 const char *ext) {

	std::string fname = getFilename(cfg.x0, cfg.y0, cfg.out_dir, ext);
	write_ply(fname.c_str(), mesh);

	return (0);
}

int writeTransform(const struct Transform &t, const struct Cfg &cfg) {
	std::string fname = getFilename(cfg.x0, cfg.y0, cfg.out_dir, "transf");
	FILE *f = fopen(fname.c_str(), "w");
	if (!f) {
		return (-1);
	}
	fprintf(f, "Scale %g\n", t.scale);
	fprintf(f, "Offset %g %g %g\n", t.shift.x, t.shift.y, t.shift.z);
	fclose(f);
	return (0);
}

int readTransform(struct Transform &t, const struct Cfg &cfg) {
	std::string fname = getFilename(cfg.x0, cfg.y0, cfg.out_dir, "transf");
	FILE *f = fopen(fname.c_str(), "r");
	if (!f) {
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

static bool filterLasPoint(const LasPoint &p, const LasFileInfo &info,
						   const TAabb<double> box) {
	double pos[3];
	pos[0] = p.x * info.scale[0] + info.offset[0];
	pos[1] = p.y * info.scale[1] + info.offset[1];
	pos[2] = p.z * info.scale[2] + info.offset[2];

	/* Bbox filter */
	if ((pos[0] < box.min[0]) || (pos[0] > box.max[0]) ||
		(pos[1] < box.min[1]) || (pos[1] > box.max[1])) {
		return false;
	}

	return (p.classification == 2 || p.classification == 5 ||
			p.classification == 9 || p.classification == 10 ||
			p.classification == 11);
}

static const double TILE_MARGIN_M = 50.0;

static TAabb<double> lasBbox(int x0, int y0) {
	double wx0, wy0, wx1, wy1;
	geo_wmq_tile_bounds(geo().lod_level0, x0, y0, wx0, wy0, wx1, wy1);
	wx0 -= TILE_MARGIN_M;
	wy0 -= TILE_MARGIN_M;
	wx1 += TILE_MARGIN_M;
	wy1 += TILE_MARGIN_M;

	const int samples = 5;
	Vec3d edge[4 * samples];
	int n = 0;
	for (int i = 0; i < samples; ++i) {
		double t = (double)i / (samples - 1);
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
	for (int i = 0; i < n; ++i) {
		box.min.x = MIN(box.min.x, edge[i].x);
		box.min.y = MIN(box.min.y, edge[i].y);
		box.max.x = MAX(box.max.x, edge[i].x);
		box.max.y = MAX(box.max.y, edge[i].y);
	}
	box.min.z = -1000;
	box.max.z = 9000;
	return box;
}

static uint32_t filterAndAddPoints(std::vector<LasPoint> &points,
								   const char *src, uint32_t srcCount,
								   const LasFileInfo info,
								   const TAabb<double> box) {
	size_t initPointCount = points.size();
	size_t pointCount = initPointCount;
	points.resize(pointCount + srcCount); // Over estimate, shrink later
	for (uint32_t i = 0; i < srcCount; ++i) {
		LasPoint &p = points[pointCount];
		p = las_read_point(src, info.point_format);
		if (filterLasPoint(p, info, box)) {
			pointCount++;
		}
		src += info.point_size;
	}
	points.resize(pointCount);

	return (pointCount - initPointCount);
}

static size_t readAndFilterLasData(std::vector<struct LasPoint> &points,
								   double offset[3], double scale[3],
								   const struct Cfg &cfg) {
	TAabb<double> box = lasBbox(cfg.x0, cfg.y0);
	int kx0 = (int)floor(box.min.x / 1000.0);
	int kx1 = (int)floor(box.max.x / 1000.0);
	int ky0 = (int)ceil(box.min.y / 1000.0);
	int ky1 = (int)ceil(box.max.y / 1000.0);
	int wanted = (kx1 - kx0 + 1) * (ky1 - ky0 + 1);
	if (cfg.verbose) {
		printf("Reading L93 tiles %04d..%04d x %04d..%04d covering "
			   "WMQ tile %d/%d/%d :\n",
			   kx0, kx1, ky0, ky1, geo().lod_level0, cfg.x0, cfg.y0);
	}
	int found = 0;
	for (int i = 0; i < wanted; ++i) {
		int x = kx0 + i % (kx1 - kx0 + 1);
		int y = ky0 + i / (kx1 - kx0 + 1);
		const char *role = "source  ";

		LasFileInfo info;
		std::string fname = getLasFilename(x, y, cfg.base_dir);
		if (las_read_info(fname.c_str(), info)) {
			if (cfg.verbose) {
				printf("  [missing ] %04d_%04d %s\n", x, y, role);
			}
			continue;
		}
		size_t before = points.size();

		char *data = las_load_laz_data(fname.c_str(), info, NULL);
		if (!data) {
			if (cfg.verbose) {
				printf("  [unread  ] %s\n", fname.c_str());
			}
			continue;
		}
		filterAndAddPoints(points, data, (uint32_t)info.point_num, info, box);
		free(data);

		found++;
		if (cfg.verbose) {
			printf("  [found] %04d_%04d %s : %zu pts\n", x, y, role,
				   points.size() - before);
		}
	}
	if (cfg.verbose) {
		printf("Found %d/%d source tiles.\n", found, wanted);
	}
	return points.size();
}

static int sendPointsToUnitCube(const std::vector<struct LasPoint> &points,
								Vec3 *pos, struct Transform &t, const Cfg cfg,
								double &maxAlt) {
	size_t num = points.size();
	std::vector<Vec3d> work(num);
	for (size_t i = 0; i < num; ++i) {
		work[i].x = points[i].x * 0.01;
		work[i].y = points[i].y * 0.01;
		work[i].z = points[i].z * 0.01;
	}
	if (geo_l93_to_geodetic(work.data(), num)) {
		return (-1);
	}
	for (size_t i = 0; i < num; ++i) {
		work[i] = geo_geodetic_to_work(work[i]);
	}

	double minZ = 1e30, maxZ = -1e30;
	for (size_t i = 0; i < num; ++i) {
		minZ = MIN(minZ, work[i].z);
		maxZ = MAX(maxZ, work[i].z);
	}
	float span = (float)(maxZ - minZ);
	maxAlt = maxZ;
	printf("(Altitude span : %.0f meters, max %.0f m NGF69)\n", span, maxAlt);
	float n;
	if (span < 1250.f) {
		n = 6;
	} else if (span < 1875.f) {
		n = 2;
	} else {
		return (-1);
	}
	t.scale = (float)n / (n + 2);
	t.shift.x = t.shift.y = 1.f / (n + 2);

	double wx0, wy0, wx1, wy1;
	geo_wmq_tile_bounds(geo().lod_level0, cfg.x0, cfg.y0, wx0, wy0, wx1, wy1);
	double scal = t.scale / (wx1 - wx0);

	float mean = 0.5 * (minZ + maxZ) * scal;
	/* Round shift.z so that octree boxes match vertically to
	 * neighboors */
	t.shift.z = 0.5 - round(16 * mean) * 0.0625;
	assert(min_z * scal + t.shift.z >= 0);
	assert(max_z * scal + t.shift.z <= 1);
	for (size_t i = 0; i < num; ++i) {
		pos[i].x = (work[i].x - wx0) * scal + t.shift.x;
		pos[i].y = (work[i].y - wy0) * scal + t.shift.y;
		pos[i].z = work[i].z * scal + t.shift.z;
	}
	return (0);
}

static int guessMaxDepth(double rangeScale, double maxAlt) {
	int altCap = (maxAlt < ALTITUDE_THRESHOLD) ? 10 : 11;
	int scaleCap = (int)floor(log2(1.0 / (rangeScale * 0.75)));
	int depth = MIN(altCap, scaleCap);
	printf("Guessing max depth :\n");
	printf("  max altitude %.0f m (threshold %.0f m) -> depth <= %d\n", maxAlt,
		   ALTITUDE_THRESHOLD, altCap);
	printf("  range scale %g -> depth <= %d (cell %g >= %g)\n", rangeScale,
		   scaleCap, 1.0 / (1 << scaleCap), rangeScale);
	printf("  max depth = %d\n", depth);
	return depth;
}

static void resolveLodLevels(struct Cfg &cfg) {
	if (cfg.min_depth < geo().level0_depth) {
		printf("Warning: min depth %d below level-0 depth %d; clamping.\n",
			   cfg.min_depth, geo().level0_depth);
		cfg.min_depth = geo().level0_depth;
	}
	if (cfg.max_depth < cfg.min_depth) {
		printf("Warning: max depth %d below min depth %d; clamping to %d.\n",
			   cfg.max_depth, cfg.min_depth, cfg.min_depth);
		cfg.max_depth = cfg.min_depth;
	}
	cfg.lod.max_level = cfg.max_depth - geo().level0_depth;
	printf("LOD levels                 : z=%d..%d (Poisson depths %d..%d)\n",
		   cfg.min_depth - geo().level0_depth, cfg.lod.max_level, cfg.min_depth,
		   cfg.max_depth);
	for (int d = cfg.min_depth; d <= cfg.max_depth; ++d) {
		int z = d - geo().level0_depth;
		int n = 1 << z;
		printf("  depth %2d -> z=%d : %dx%d grid, %d tiles of %.1f m "
			   "at level %d\n",
			   d, z, n, n, n * n, geo_wmq_tile_size(geo().lod_level0 + z),
			   geo().lod_level0 + z);
	}
}

/* Gather neighboring las files to build a 100m buffer of the
 * target tile, and then compute combined position + normal point
 * set from it: CGAL scale estimate -> PCA normals -> scanline
 * orientation (las_normal_cgal.h), then optional grid
 * thinning (las_resample.h).
 */
static int buildOrientedPointSet(struct Cfg &cfg, Timings &tt) {

	/* Re-use existing output ? Only trust the cached points.ply when its
	 * companion .transf is present too; postprocess needs the transform to
	 * rescale the mesh, and a points.ply without it would later produce
	 * garbage-scaled tiles. */
	{
		std::string reconIn =
			getFilename(cfg.x0, cfg.y0, cfg.out_dir, "points.ply");
		struct Transform cached;
		FILE *f;
		if ((f = fopen(reconIn.c_str(), "rb")) != NULL) {
			fclose(f);
			if (!readTransform(cached, cfg)) {
				printf("Using cached data in %s\n", reconIn.c_str());
				if (cfg.max_depth < 0) {
					cfg.max_depth = 10;
					printf("Cached point set: cannot guess max depth, "
						   "using %d.\n",
						   cfg.max_depth);
				}
				resolveLodLevels(cfg);
				return (0);
			}
			printf("Cached %s has no transform; regenerating.\n",
				   reconIn.c_str());
		}
	}

	/* Read data */
	Timer chrono;
	chrono.start();
	std::vector<struct LasPoint> points;
	double offset[3];
	double scale[3];
	size_t lasNum = readAndFilterLasData(points, offset, scale, cfg);

	/* CGAL::scanline_orient_normals requires scanline-contiguous input in
	 * acquisition order: sort by (source_id, gps_time). */
	std::sort(points.begin(), points.end(),
			  [](const LasPoint &a, const LasPoint &b) {
				  if (a.source_id != b.source_id)
					  return a.source_id < b.source_id;
				  return a.gps_time < b.gps_time;
			  });

	tt.read_and_filter = chrono.stop();

	printf("Total Lidar points used    : %zu\n", lasNum);

	if (!lasNum) {
		printf("No data available for this tile.\n");
		return (-1);
	}

	printf("Set positions & transform  : ");
	/* Rescale and offset positions into buffer */
	TriMesh mesh;
	mesh.verts.resize(points.size() + 2); /* +2 for dummy box corners */
	mesh.normals.resize(points.size() + 2);

	struct Transform transf;
	double maxAlt = 0.0;
	if (sendPointsToUnitCube(points, mesh.verts.data(), transf, cfg, maxAlt)) {
		printf("Altitude span too large !\n");
		return (-1);
	}

	/* Normals: CGAL scale estimate (spatial window), PCA plane fit over
	 * capped spherical neighborhoods, scanline orientation. The estimated
	 * scale is in unit-cube units, like data.positions. */
	chrono.start();
	double rangeScale = cgal_estimate_scale(mesh.verts.data(), points.size());
	double nmlRadius = 2.0 * rangeScale;
	printf("Estimated range scale      : %g (radius %g)\n", rangeScale,
		   nmlRadius);
	if (cfg.max_depth < 0)
		cfg.max_depth = guessMaxDepth(rangeScale, maxAlt);
	resolveLodLevels(cfg);
	/* Grid fix-up cell size: 1 m, mapped to unit-cube units the same way as
	 * --ds-grid below (1 unit = one WMQ tile side / scale). */
	double nmlGridRes =
		1.0 * transf.scale / geo_wmq_tile_size(geo().lod_level0);
	cgal_estimate_and_orient_normals(mesh.verts.data(), points.size(), points,
									 nmlRadius, nmlGridRes, mesh.normals.data(),
									 cfg.verbose);
	size_t vertexCount = points.size();
	tt.estim_nml = chrono.stop();

	/* Optional grid thinning. --ds-grid is given in metres and
	 * mapped to unit-cube units through the transform (1 unit = one WMQ
	 * tile side / scale). */
	if (cfg.downsample.enabled) {
		float gridRes = cfg.downsample.grid_res * transf.scale /
						geo_wmq_tile_size(geo().lod_level0);
		vertexCount =
			flat_area_thin(mesh.verts.data(), mesh.normals.data(), vertexCount,
						   gridRes, cfg.downsample.neighbor_radius,
						   cfg.downsample.slope_deg, cfg.verbose);
	}

	/* Add dummy points for bounding box to perfectly match unit
	 * cube */
	mesh.verts[vertexCount] = Vec3{0.f, 0.f, 0.f};
	mesh.normals[vertexCount] = Vec3{0.f, 0.f, 0.f};
	vertexCount++;
	mesh.verts[vertexCount] = Vec3{1.f, 1.f, 1.f};
	mesh.normals[vertexCount] = Vec3{0.f, 0.f, 0.f};
	vertexCount++;
	mesh.verts.resize(vertexCount);
	mesh.normals.resize(vertexCount);

	writeMesh(mesh, cfg, "points.ply");
	writeTransform(transf, cfg);

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
static int buildCoarsePoissonInput(const std::string &inPly,
								   const std::string &outPly) {
	TriMesh mesh;
	if (load_ply(mesh, inPly.c_str(), false) || mesh.faces.empty())
		return (-1);
	compute_mesh_normals(mesh);
	mesh.verts.push_back(Vec3{0.f, 0.f, 0.f});
	mesh.normals.push_back(Vec3{0.f, 0.f, 0.f});
	mesh.verts.push_back(Vec3{1.f, 1.f, 1.f});
	mesh.normals.push_back(Vec3{0.f, 0.f, 0.f});
	mesh.faces.clear(); /* points only: Poisson ignores faces */
	write_ply(outPly.c_str(), mesh);
	mesh.clear();
	return (0);
}

static int buildSurfaceMesh(const struct Cfg &cfg, Timings &tt) {
	/* Re-use existing output ? */
	std::string reconOut =
		getFilename(cfg.x0, cfg.y0, cfg.out_dir, "poisson.ply");
	FILE *f;
	if ((f = fopen(reconOut.c_str(), "rb")) != NULL) {
		printf("Using cached data in %s\n", reconOut.c_str());
		fclose(f);
		return 0;
	}

	Timer chrono;
	chrono.start();
	std::string reconIn =
		getFilename(cfg.x0, cfg.y0, cfg.out_dir, "points.ply");
	int ret = run_poisson_recon(reconIn, reconOut, cfg.max_depth, cfg.weight,
								cfg.verbose, cfg.parallel, true);

	if (cfg.clean >= 2) {
		std::string rm = "rm -f " + reconIn;
		system(rm.c_str());
	}

	tt.poisson_recon = chrono.stop();
	return (ret);
}

int postprocessSurfaceMesh(const Cfg &cfg, Timings &tt) {
	std::string reconOut =
		getFilename(cfg.x0, cfg.y0, cfg.out_dir, "poisson.ply");
	Timer chrono;

	/* The transform maps the Poisson [0,1] cube back to km; every LOD level
	 * needs it, so read and validate it once. A missing .transf next to a
	 * cached poisson.ply would rescale with garbage (~1e9 coords, freezing any
	 * WebGL viewer), so bail rather than write bad tiles. */
	struct Transform transf;
	if (readTransform(transf, cfg)) {
		printf("Error: missing/unreadable transform for %04d_%04d; "
			   "cannot rescale mesh.\n",
			   cfg.x0, cfg.y0);
		return (-1);
	}

	const int minDepth = cfg.min_depth;
	const int maxDepth = cfg.max_depth;
	const int nlv = maxDepth - minDepth;

	/* Per-level source meshes, indexed by depth-min_depth. The finest level is
	 * the depth-cfg.max_depth reconstruction (recon_out). Each coarser level
	 * re-meshes the previous level's Poisson output one octree depth lower:
	 * normals are re-derived from that mesh's faces
	 * (build_coarse_poisson_input) and it is reconstructed at that depth. This
	 * replaces vertex-cluster decimation of the finest mesh with a native
	 * coarse reconstruction. */
	std::vector<std::string> levelPly(nlv + 1);
	levelPly[nlv] = reconOut;
	for (int i = nlv - 1; i >= 0; --i) {
		chrono.start();
		int depth = minDepth + i;
		char ext[32];
		snprintf(ext, sizeof(ext), "poisson.%d.ply", depth);
		std::string out = getFilename(cfg.x0, cfg.y0, cfg.out_dir, ext);
		std::string coarseIn =
			getFilename(cfg.x0, cfg.y0, cfg.out_dir, "coarse_points.ply");
		if (buildCoarsePoissonInput(levelPly[i + 1], coarseIn) ||
			run_poisson_recon(coarseIn, out, depth, cfg.weight, cfg.verbose,
							  cfg.parallel, true)) {
			printf("Warning: coarse Poisson at depth %d failed; "
				   "reusing depth %d source.\n",
				   depth, depth + 1);
			levelPly[i] = levelPly[i + 1];
		} else
			levelPly[i] = out;
		if (cfg.clean >= 2)
			remove(coarseIn.c_str());
		tt.coarse_recon += chrono.stop();
	}

	/* Load, transform to km and tile each level from its own mesh. The web zoom
	 * level of a depth is fixed: z = depth - level0_depth, so the grid and the
	 * tile names of a given depth never depend on the requested depth range. */
	for (int i = 0; i <= nlv; ++i) {
		chrono.start();
		int depth = minDepth + i;
		int z = depth - geo().level0_depth;
		printf("  LOD z=%d : depth %d, %dx%d grid\n", z, depth, 1 << z, 1 << z);
		TriMesh mesh;
		load_ply(mesh, levelPly[i].c_str(), false);
		if (i == nlv)
			printf("A total of %zu (%.2f M) Tri after poisson "
				   "reconstruct.\n",
				   mesh.triangle_count(), 1e-6 * mesh.triangle_count());

		postprocess_lod_level(mesh, transf, geo().lod_level0, cfg.x0, cfg.y0, z,
							  cfg.out_dir, cfg.optimize, cfg.verbose);

		if (cfg.clean >= 2 && i != nlv)
			remove(levelPly[i].c_str());
		mesh.clear();
		tt.lod += chrono.stop();
	}

	if (cfg.clean) {
		std::string cmd = "rm -f " + reconOut;
		system(cmd.c_str());
	}

	/* clean>=2 removes the intermediate .transf too (like points.ply). It is
	 * only safe here: read_transform() above has already consumed it. Leaving
	 * a stale .transf next to a cached poisson.ply is exactly what produced
	 * the uninitialised-transform garbage tiles. */
	if (cfg.clean >= 2) {
		std::string transf = getFilename(cfg.x0, cfg.y0, cfg.out_dir, "transf");
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

int main(int argc, char **argv) {
	struct Cfg cfg;
	struct Timings tt;
	Timer chrono;

	chrono.start();

	/* Process command line arguments */
	int argsRet = processArgs(argc, (const char **)argv, cfg);
	if (argsRet > 0) {
		return (0); /* --help was shown */
	}
	if (argsRet < 0) {
		return (-1);
	}

	if (geo_init()) {
		return (-1);
	}

	printf("\n------ Start of alpineview_builder for %04d %04d ------\n",
		   cfg.x0, cfg.y0);

	if (cfg.verbose) {
		printCfg(cfg);
	}

	printf("\n");
	printf("I. Building oriented point set :\n");
	printf("--------------------------------\n");
	if (buildOrientedPointSet(cfg, tt)) {
		printf("Error in building oriented point set.\n");
		return (-1);
	}

	printf("\n");
	printf("II. Building surface mesh from point set :\n");
	printf("------------------------------------------\n");

	if (buildSurfaceMesh(cfg, tt)) {
		printf("Error in Poisson reconstruction\n");
		return (-1);
	}

	printf("\n");
	printf("III. Postprocessing surface mesh.\n");
	printf("---------------------------------\n");

	if (postprocessSurfaceMesh(cfg, tt)) {
		printf("Error in Poisson reconstruction\n");
		return (-1);
	}

	tt.total = chrono.stop();

	printTimings(tt);

	printf("\n------ End of alpineview_builder for %04d %04d ------\n", cfg.x0,
		   cfg.y0);

	return (0);
}

/******************************************************************************/
