#include "geo.h"

#include <math.h>
#include <stdio.h>

#include <proj.h>

#include "math_utils.h"

static PJ_CONTEXT *g_ctx = NULL;
static PJ *g_l93_to_geodetic = NULL;
static PJ *g_geodetic_to_l93 = NULL;

static double geo_scale(void)
{
	return geo_work_scale();
}

int geo_init(void)
{
	if (g_l93_to_geodetic)
		return (0);

	g_ctx = proj_context_create();
	if (!g_ctx)
	{
		printf("Error: could not create a PROJ context.\n");
		return (-1);
	}

	g_l93_to_geodetic = proj_create(g_ctx, geo().proj_l93_to_geodetic);
	if (!g_l93_to_geodetic)
	{
		printf("Error: PROJ could not build the L93 -> geodetic "
			   "pipeline (%s).\n",
			   proj_context_errno_string(g_ctx,
										 proj_context_errno(g_ctx)));
		proj_context_destroy(g_ctx);
		g_ctx = NULL;
		return (-1);
	}

	g_geodetic_to_l93 = proj_create(g_ctx, geo().proj_geodetic_to_l93);
	if (!g_geodetic_to_l93)
	{
		printf("Error: PROJ could not build the geodetic -> L93 "
			   "pipeline (%s).\n",
			   proj_context_errno_string(g_ctx,
										 proj_context_errno(g_ctx)));
		proj_destroy(g_l93_to_geodetic);
		g_l93_to_geodetic = NULL;
		proj_context_destroy(g_ctx);
		g_ctx = NULL;
		return (-1);
	}

	return (0);
}

void geo_fini(void)
{
	if (g_geodetic_to_l93)
	{
		proj_destroy(g_geodetic_to_l93);
		g_geodetic_to_l93 = NULL;
	}
	if (g_l93_to_geodetic)
	{
		proj_destroy(g_l93_to_geodetic);
		g_l93_to_geodetic = NULL;
	}
	if (g_ctx)
	{
		proj_context_destroy(g_ctx);
		g_ctx = NULL;
	}
}

int geo_l93_to_geodetic(Vec3d *pts, size_t num)
{
	if (!g_l93_to_geodetic && geo_init())
		return (-1);

	size_t stride = sizeof(Vec3d);
	size_t done = proj_trans_generic(
		g_l93_to_geodetic, PJ_FWD,
		&pts[0].x, stride, num,
		&pts[0].y, stride, num,
		NULL, 0, 0,
		NULL, 0, 0);
	if (done != num)
	{
		printf("Error: PROJ transformed %zu/%zu points (%s).\n", done,
			   num,
			   proj_context_errno_string(
				   g_ctx, proj_context_errno(g_ctx)));
		return (-1);
	}
	return (0);
}

int geo_geodetic_to_l93(Vec3d *pts, size_t num)
{
	if (!g_geodetic_to_l93 && geo_init())
		return (-1);

	size_t stride = sizeof(Vec3d);
	size_t done = proj_trans_generic(
		g_geodetic_to_l93, PJ_FWD,
		&pts[0].x, stride, num,
		&pts[0].y, stride, num,
		NULL, 0, 0,
		NULL, 0, 0);
	if (done != num)
	{
		printf("Error: PROJ transformed %zu/%zu points (%s).\n", done,
			   num,
			   proj_context_errno_string(
				   g_ctx, proj_context_errno(g_ctx)));
		return (-1);
	}
	return (0);
}

Vec3d geo_geodetic_to_work(const Vec3d &geodetic)
{
	double k = geo_scale();
	double lat = deg2rad(geodetic.y);
	Vec3d w;
	w.x = geo().merc_radius * deg2rad(geodetic.x) / k;
	w.y = geo().merc_radius * log(tan(M_PI * 0.25 + lat * 0.5)) / k;
	w.z = geodetic.z;
	return (w);
}

Vec3d geo_work_to_geodetic(const Vec3d &work)
{
	double k = geo_scale();
	Vec3d g;
	g.x = (work.x * k / geo().merc_radius) * 180.0 / M_PI;
	g.y = (2.0 * atan(exp(work.y * k / geo().merc_radius)) - M_PI * 0.5) * 180.0 /
		  M_PI;
	g.z = work.z;
	return (g);
}

double geo_wmq_tile_size(int level)
{
	return 2.0 * geo().wmq_extent / geo_scale() / ldexp(1.0, level);
}

void geo_wmq_tile_of(double work_x, double work_y, int level, int &tx, int &ty)
{
	double extent = geo().wmq_extent / geo_scale();
	double size = geo_wmq_tile_size(level);
	tx = (int)floor((work_x + extent) / size);
	ty = (int)floor((extent - work_y) / size);
}

void geo_wmq_tile_bounds(int level, int tx, int ty, double &x0, double &y0,
						 double &x1, double &y1)
{
	double extent = geo().wmq_extent / geo_scale();
	double size = geo_wmq_tile_size(level);
	x0 = -extent + tx * size;
	x1 = x0 + size;
	y1 = extent - ty * size;
	y0 = y1 - size;
}
