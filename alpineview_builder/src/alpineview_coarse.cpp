#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <string>
#include <vector>

#include "asc_grid.h"
#include "chrono.h"
#include "geo.h"
#include "mesh.h"
#include "mesh_lod.h"
#include "mesh_ply.h"
#include "poisson_common.h"

/* Coarse pyramid from RGE ALTI 5 m, the counterpart of alpineview_builder for
 * the levels above lod_level0, where LiDAR HD is both unnecessary and
 * absent outside its own footprint.
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

static const double L93_MARGIN_M = 500.0;

struct Cfg {
	int x0 = 0;
	int y0 = 0;
	int min_z = 1;
	int max_z = 3;
	std::string data_dir = "data";
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
		   "  --data-dir DIR       RGE ALTI .asc tree (default: data)\n"
		   "  --out-dir DIR        output directory (default: .)\n"
		   "  --min-z N            coarsest output level offset (default: 1)\n"
		   "  --max-z N            finest output level offset (default: 3)\n"
		   "                       output level = %d + z\n"
		   "  --weight F           Poisson point weight (default: 4)\n"
		   "  --clean N            0 keeps the intermediate .ply (default: 2)\n"
		   "  --no-verbose         quieter\n"
		   "  -h, --help           show this help and exit\n",
		   prog, geo().cell_level, geo().cell_level);
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
		if (strcmp(arg, "--data-dir") == 0) {
			if (!(val = flag_value(argc, argv, &i)))
				return (-1);
			cfg.data_dir = val;
		} else if (strcmp(arg, "--out-dir") == 0) {
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

/* L93 bounding box of the cube, by sampling the work-frame boundary: the two
 * grids are not affine to each other, so the corners alone are not safe. */
static void cubeL93Bbox(double wx0, double wy0, double wx1, double wy1,
						double &x0, double &y0, double &x1, double &y1) {
	const int steps = 8;
	std::vector<Vec3d> pts;
	for (int i = 0; i <= steps; ++i) {
		double t = (double)i / steps;
		double wx = wx0 + t * (wx1 - wx0);
		double wy = wy0 + t * (wy1 - wy0);
		pts.push_back(geo_work_to_geodetic(Vec3d{wx, wy0, 0.0}));
		pts.push_back(geo_work_to_geodetic(Vec3d{wx, wy1, 0.0}));
		pts.push_back(geo_work_to_geodetic(Vec3d{wx0, wy, 0.0}));
		pts.push_back(geo_work_to_geodetic(Vec3d{wx1, wy, 0.0}));
	}
	geo_geodetic_to_l93(pts.data(), pts.size());

	x0 = y0 = 1e30;
	x1 = y1 = -1e30;
	for (const Vec3d &p : pts) {
		x0 = fmin(x0, p.x);
		x1 = fmax(x1, p.x);
		y0 = fmin(y0, p.y);
		y1 = fmax(y1, p.y);
	}
	x0 -= L93_MARGIN_M;
	y0 -= L93_MARGIN_M;
	x1 += L93_MARGIN_M;
	y1 += L93_MARGIN_M;
}

/* Sample the heightfield on a regular grid over the cube, in the work frame.
 * Fills z with NGF69 altitude (NAN where the source has no data). */
static int sampleGrid(const Cfg &cfg, std::vector<AscTile> &tiles, int n,
					  double wx0, double wy0, double step,
					  std::vector<double> &z) {
	std::vector<Vec3d> geo((size_t)n * n);
	for (int j = 0; j < n; ++j) {
		for (int i = 0; i < n; ++i) {
			double wx = wx0 + (i + 0.5) * step;
			double wy = wy0 + (j + 0.5) * step;
			geo[(size_t)j * n + i] = geo_work_to_geodetic(Vec3d{wx, wy, 0.0});
		}
	}

	std::vector<Vec3d> l93 = geo;
	if (geo_geodetic_to_l93(l93.data(), l93.size()))
		return (-1);

	z.assign((size_t)n * n, NAN);
	size_t found = 0;
	for (size_t k = 0; k < z.size(); ++k) {
		float h = asc_sample(tiles, l93[k].x, l93[k].y);
		if (isnan(h))
			continue;
		z[k] = (double)h;
		found++;
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

	std::vector<AscTile> tiles;
	if (asc_index(cfg.data_dir.c_str(), tiles) == 0) {
		printf("Error: no .asc under %s\n", cfg.data_dir.c_str());
		return (-1);
	}

	double bx0, by0, bx1, by1;
	cubeL93Bbox(wx0, wy0, wx0 + cube, wy0 + cube, bx0, by0, bx1, by1);
	int loaded = asc_load_overlapping(tiles, bx0, by0, bx1, by1);
	printf("Source      : %zu .asc indexed, %d loaded for L93 "
		   "%.0f..%.0f x %.0f..%.0f\n",
		   tiles.size(), loaded, bx0, bx1, by0, by1);
	if (!loaded) {
		printf("No source data covers this tile.\n");
		return (0);
	}

	int n = 1 << (geo().coarse_base_depth + cfg.max_z);
	double step = cube / n;
	printf("Grid        : %d x %d, %.2f m spacing\n", n, n, step);

	std::vector<double> z;
	if (sampleGrid(cfg, tiles, n, wx0, wy0, step, z))
		return (-1);
	tiles.clear();

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
