#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "geo.h"
#include "vec3.h"

/* Tiny CLI wrapping geo.cpp's conversions, so Python tooling can reuse the
 * exact same implementation (PROJ pipelines, work-frame formula) instead of
 * re-deriving a second copy that could drift from it. */

enum class Frame
{
	L93,
	Geodetic,
	Work
};

static bool parse_frame(const char *s, Frame &f)
{
	if (!strcmp(s, "l93"))
	{
		f = Frame::L93;
		return true;
	}
	if (!strcmp(s, "geodetic"))
	{
		f = Frame::Geodetic;
		return true;
	}
	if (!strcmp(s, "work"))
	{
		f = Frame::Work;
		return true;
	}
	return false;
}

static void print_usage(const char *prog)
{
	printf("Usage: %s x y z proj_in proj_out\n"
		   "\n"
		   "  x, y, z      input point. z is never touched by any of the\n"
		   "               reprojections below (geo.cpp) -- it comes out\n"
		   "               exactly as it went in, in whatever altitude\n"
		   "               datum it started in.\n"
		   "  proj_in,\n"
		   "  proj_out     one of: l93, geodetic, work\n"
		   "\n"
		   "Prints \"x y z\" of the converted point.\n",
		   prog);
}

int main(int argc, char **argv)
{
	if (argc == 2 &&
		(!strcmp(argv[1], "-h") || !strcmp(argv[1], "--help")))
	{
		print_usage(argv[0]);
		return (0);
	}
	if (argc != 6)
	{
		print_usage(argv[0]);
		return (-1);
	}

	Vec3d p{atof(argv[1]), atof(argv[2]), atof(argv[3])};
	Frame from, to;
	if (!parse_frame(argv[4], from) || !parse_frame(argv[5], to))
	{
		printf("Error: proj_in/proj_out must be one of l93, geodetic, "
			   "work.\n");
		return (-1);
	}

	if (from == to)
	{
		printf("%.9f %.9f %.9f\n", p.x, p.y, p.z);
		return (0);
	}

	if (geo_init())
		return (-1);

	/* Pivot through geodetic, like the C++ pipeline itself never needs
	 * to: every existing caller only ever does one hop (l93<->geodetic
	 * or geodetic<->work). This CLI is the first place both hops
	 * compose, purely because it must support any pair. */
	Vec3d g = p;
	if (from == Frame::L93)
	{
		if (geo_l93_to_geodetic(&g, 1))
			return (-1);
	}
	else if (from == Frame::Work)
	{
		g = geo_work_to_geodetic(p);
	}

	Vec3d out = g;
	if (to == Frame::L93)
	{
		if (geo_geodetic_to_l93(&out, 1))
			return (-1);
	}
	else if (to == Frame::Work)
	{
		out = geo_geodetic_to_work(g);
	}

	printf("%.9f %.9f %.9f\n", out.x, out.y, out.z);
	geo_fini();
	return (0);
}
