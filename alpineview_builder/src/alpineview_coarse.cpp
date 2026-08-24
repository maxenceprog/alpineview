#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <string>
#include <vector>

#include "chrono.h"
#include "geo.h"
#include "mesh.h"
#include "mesh_lod.h"
#include "mesh_ply.h"
#include "poisson_common.h"
#include "wms_elevation.h"

/* Coarse pyramid from IGN's elevation WMS, the counterpart of
 * alpineview_builder for the levels above lod_level0, where LiDAR HD is both
 * unnecessary and absent outside its own footprint.
 *
 * The job unit is one cell_level tile -- the same cell that owns the ENU
 * frame and the subtree -- so a job never straddles two cells and its output
 * levels are all finer than the cell.
 *
 * Unlike the LiDAR path there is no point cloud to gather: the source is a
 * regular heightfield, so the cell is sampled directly on a regular grid in
 * the work frame. That sidesteps reprojecting normals -- the grid is regular
 * in the frame the mesh is built in, so the analytic gradient is exact -- and
 * it makes the sample spacing a choice rather than a property of the input. */

/* Poisson buffer, as the fine builder's: the cube is the tile grown by
 * 1/(N+2) on each side, so the reconstruction sees real data past the tile
 * edge and neighbours agree along it. recut_mesh drops the buffer again. */
static const float CUBE_N = 6.f;

static const int WMS_RESOLUTION = 1024;

struct Cfg {
	int x0 = 0;
	int y0 = 0;
	int min_z = 0;
	int max_z = 3;
	std::string out_dir = ".";
	float weight = 4.f;
	bool parallel = false;
	bool verbose = true;
	int clean = 2;
};

static void printUsage(const char *prog) {
	printf("Usage: %s X Y [options]\n"
		   "\n"
		   "  X, Y                 WebMercatorQuad tile column and row at\n"
		   "                       level %d (required).\n"
		   "\n"
		   "  --out-dir DIR        output directory (default: .)\n"
		   "  --min-z N            coarsest output level offset (default: 1)\n"
		   "  --max-z N            finest output level offset (default: 3)\n"
		   "                       output level = %d + z\n"
		   "  --weight F           Poisson point weight (default: 4)\n"
		   "  --clean N            0 keeps the intermediate .ply (default: 2)\n"
		   "  --no-verbose         quieter\n"
		   "  -h, --help           show this help and exit\n"
		   "\n"
		   "Elevation is fetched from IGN's elevation WMS as needed and\n"
		   "cached in %s.\n",
		   prog, geo().cell_level, geo().cell_level,
		   wms_elevation_cache_dir().c_str());
}

static int processArgs(int argc, const char **argv, Cfg &cfg) {
	int positional = 0;
	for (int i = 1; i < argc; ++i) {
		const char *arg = argv[i];
		const char *val = NULL;

		if (strcmp(arg, "-h") == 0 || strcmp(arg, "--help") == 0) {
			printUsage(argv[0]);
			return (1);
		}
		if (arg[0] != '-') {
			if (positional == 0)
				cfg.x0 = atoi(arg);
			else if (positional == 1)
				cfg.y0 = atoi(arg);
			else {
				printf("Error: unexpected argument '%s'.\n", arg);
				return (-1);
			}
			++positional;
			continue;
		}
		if (strcmp(arg, "--out-dir") == 0) {
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.out_dir = val;
		} else if (strcmp(arg, "--min-z") == 0) {
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.min_z = atoi(val);
		} else if (strcmp(arg, "--max-z") == 0) {
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.max_z = atoi(val);
		} else if (strcmp(arg, "--weight") == 0) {
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.weight = atof(val);
		} else if (strcmp(arg, "--clean") == 0) {
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.clean = atoi(val);
		} else if (strcmp(arg, "--parallel") == 0) {
			cfg.parallel = true;
		} else if (strcmp(arg, "--no-verbose") == 0) {
			cfg.verbose = false;
		} else {
			printf("Error: unknown option '%s'. Try --help.\n", arg);
			return (-1);
		}
	}
	if (positional < 2) {
		printf("Error: missing WebMercatorQuad tile X Y. Try --help.\n");
		return (-1);
	}
	if (cfg.max_z < cfg.min_z) {
		printf("Error: --max-z below --min-z.\n");
		return (-1);
	}
	return (0);
}

static std::string outFile(const Cfg &cfg, const char *ext) {
	std::string name = cfg.out_dir;
	if (!name.empty() && name.back() != '/')
		name += '/';
	char suffix[64];
	snprintf(suffix, sizeof(suffix), "coarse_%d_%d.%s", cfg.x0, cfg.y0, ext);
	return name + suffix;
}

/* Sample the heightfield on a regular grid over the cube, in the work frame.
 * Fills z with NGF69 altitude (NAN where the WMS source has no data). */
static int sampleGrid(const Cfg &cfg, const WmsElevationGrid &grid, int n, double wx0,
					  double wy0, double step, std::vector<double> &z) {
	z.assign((size_t)n * n, NAN);
	size_t found = 0;
	for (int j = 0; j < n; ++j) {
		for (int i = 0; i < n; ++i) {
			double wx = wx0 + (i + 0.5) * step;
			double wy = wy0 + (j + 0.5) * step;
			float h = wms_elevation_sample(grid, wx, wy);
			if (isnan(h))
				continue;
			z[(size_t)j * n + i] = (double)h;
			found++;
		}
	}
	if (cfg.verbose)
		printf("Sampled %zu/%zu grid nodes with data (%.1f%%)\n", found,
			   z.size(), 100.0 * found / z.size());
	return found ? 0 : -1;
}

/* Oriented point cloud in the unit cube, from the sampled heightfield.
 * Normals come from the analytic gradient, exact because the grid is regular
 * in the frame the points live in. */
static int buildCloud(const std::vector<double> &z, int n, double step,
					  TriMesh &cloud, Transform &t) {
	double zmin = 1e30, zmax = -1e30;
	for (double v : z) {
		if (isnan(v))
			continue;
		zmin = fmin(zmin, v);
		zmax = fmax(zmax, v);
	}
	if (zmin > zmax)
		return (-1);

	double spanXy = n * step;
	t.scale = CUBE_N / (CUBE_N + 2.f);
	t.shift.x = t.shift.y = 1.f / (CUBE_N + 2.f);

	/* The cube already includes the buffer, so the horizontal scale is
	 * simply 1 / its side; scale/shift describe where the tile sits in it
	 * and are what recut_mesh and the rescale below consume. */
	double scal = 1.0 / spanXy;
	double mean = 0.5 * (zmin + zmax) * scal;
	t.shift.z = 0.5 - round(16 * mean) * 0.0625;

	if (zmin * scal + t.shift.z < 0.0 || zmax * scal + t.shift.z > 1.0) {
		printf("Altitude span too large for the cube (%.0f m over "
			   "%.0f m).\n",
			   zmax - zmin, spanXy);
		return (-1);
	}

	cloud.clear();
	cloud.verts.reserve(z.size());
	cloud.normals.reserve(z.size());
	for (int j = 0; j < n; ++j) {
		for (int i = 0; i < n; ++i) {
			double v = z[(size_t)j * n + i];
			if (isnan(v))
				continue;

			int im = i > 0 ? i - 1 : i;
			int ip = i < n - 1 ? i + 1 : i;
			int jm = j > 0 ? j - 1 : j;
			int jp = j < n - 1 ? j + 1 : j;
			double zxm = z[(size_t)j * n + im];
			double zxp = z[(size_t)j * n + ip];
			double zym = z[(size_t)jm * n + i];
			double zyp = z[(size_t)jp * n + i];
			if (isnan(zxm) || isnan(zxp) || isnan(zym) || isnan(zyp))
				continue;

			double dzdx = (zxp - zxm) / ((ip - im) * step);
			double dzdy = (zyp - zym) / ((jp - jm) * step);
			Vec3 nml{(float)-dzdx, (float)-dzdy, 1.f};
			nml = nml / norm(nml);

			cloud.verts.push_back(Vec3{(float)((i + 0.5) * step * scal),
									   (float)((j + 0.5) * step * scal),
									   (float)(v * scal + t.shift.z)});
			cloud.normals.push_back(nml);
		}
	}
	return cloud.verts.empty() ? -1 : 0;
}

int main(int argc, char **argv) {
	Cfg cfg;
	int argsRet = processArgs(argc, (const char **)argv, cfg);
	if (argsRet > 0)
		return (0);
	if (argsRet < 0)
		return (-1);

	if (geo_init())
		return (-1);

	Timer chrono;
	chrono.start();

	double tx0, ty0, tx1, ty1;
	geo_wmq_tile_bounds(geo().cell_level, cfg.x0, cfg.y0, tx0, ty0, tx1, ty1);
	double tileSize = geo_wmq_tile_size(geo().cell_level);

	/* Grow the tile into the cube the reconstruction runs in. */
	double margin = tileSize / CUBE_N;
	double wx0 = tx0 - margin, wy0 = ty0 - margin;
	double cube = tileSize + 2 * margin;

	printf("\n------ alpineview_coarse %d/%d/%d ------\n", geo().cell_level,
		   cfg.x0, cfg.y0);
	Vec3d nw = geo_work_to_geodetic(Vec3d{tx0, ty1, 0.0});
	Vec3d se = geo_work_to_geodetic(Vec3d{tx1, ty0, 0.0});
	printf("Tile        : %.0f m, lon %.5f..%.5f lat %.5f..%.5f\n", tileSize,
		   nw.x, se.x, se.y, nw.y);
	printf("Levels      : %d..%d (z=%d..%d)\n", geo().cell_level + cfg.min_z,
		   geo().cell_level + cfg.max_z, cfg.min_z, cfg.max_z);

	int n = 1 << (geo().coarse_base_depth + cfg.max_z);
	if (2 * n > WMS_RESOLUTION) {
		printf("Warning: sample grid (%d) is not comfortably below "
			   "WMS_RESOLUTION (%d) -- bump WMS_RESOLUTION.\n",
			   n, WMS_RESOLUTION);
	}

	std::string cacheDir = wms_elevation_cache_dir();
	char cellName[32];
	snprintf(cellName, sizeof(cellName), "%d.%d", cfg.x0, cfg.y0);

	WmsElevationGrid grid;
	bool fetched = wms_elevation_fetch(wx0, wy0, wx0 + cube, wy0 + cube, WMS_RESOLUTION,
									   cacheDir.c_str(), cellName, grid);
	printf("Source      : WMS elevation %s (cache: %s)\n",
		   fetched ? "fetched" : "unavailable", cacheDir.c_str());
	if (!fetched) {
		printf("No source data covers this tile.\n");
		return (0);
	}

	double step = cube / n;
	printf("Grid        : %d x %d, %.2f m spacing\n", n, n, step);

	std::vector<double> z;
	if (sampleGrid(cfg, grid, n, wx0, wy0, step, z))
		return (-1);

	TriMesh cloud;
	Transform transf;
	if (buildCloud(z, n, step, cloud, transf))
		return (-1);
	z.clear();
	printf("Cloud       : %zu oriented points\n", cloud.vertex_count());

	std::string inPly = outFile(cfg, "points.ply");
	write_ply(inPly.c_str(), cloud);
	cloud.clear();

	int written = 0;
	for (int zl = cfg.min_z; zl <= cfg.max_z; ++zl) {
		int depth = geo().coarse_base_depth + zl;
		char ext[32];
		snprintf(ext, sizeof(ext), "poisson.%d.ply", depth);
		std::string outPly = outFile(cfg, ext);

		printf("\n  level %d (z=%d) : depth %d, %dx%d grid\n",
			   geo().cell_level + zl, zl, depth, 1 << zl, 1 << zl);
		if (run_poisson_recon(inPly, outPly, depth, cfg.weight, cfg.verbose,
							  cfg.parallel, false)) {
			printf("  Poisson failed at depth %d, skipping.\n", depth);
			continue;
		}

		TriMesh mesh;
		if (load_ply(mesh, outPly.c_str(), false) || mesh.faces.empty()) {
			printf("  no mesh at depth %d, skipping.\n", depth);
			continue;
		}
		written +=
			postprocess_lod_level(mesh, transf, geo().cell_level, cfg.x0,
								  cfg.y0, zl, cfg.out_dir, false, cfg.verbose);
		if (cfg.clean >= 2)
			remove(outPly.c_str());
	}

	if (cfg.clean >= 2)
		remove(inPly.c_str());

	printf("\nWrote %d tiles in %.1f s\n", written, 1e-6 * chrono.stop());
	geo_fini();
	return (0);
}
