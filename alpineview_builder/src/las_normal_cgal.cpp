#include "las_normal_cgal.h"

#include <CGAL/Exact_predicates_inexact_constructions_kernel.h>
#include <CGAL/Kd_tree.h>
#include <CGAL/Monge_via_jet_fitting.h>
#include <CGAL/Orthogonal_k_neighbor_search.h>
#include <CGAL/Search_traits_3.h>
#include <CGAL/Search_traits_adapter.h>
#include <CGAL/estimate_scale.h>
#include <CGAL/linear_least_squares_fitting_3.h>
#include <CGAL/property_map.h>

#include <boost/iterator/counting_iterator.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>

#include "chrono.h"
#include "las_resample.h"
#include "las_source.h"

using Kernel = CGAL::Exact_predicates_inexact_constructions_kernel;
using Point_3 = Kernel::Point_3;
using Vector_3 = Kernel::Vector_3;
using Plane_3 = Kernel::Plane_3;

using Search_traits = CGAL::Search_traits_3<Kernel>;

/* Index-based search: the tree stores indices into a Point_3 vector, so
 * a query returns neighbor indices, giving access to the neighbors'
 * normals and not only their coordinates. */
using Position_map = CGAL::Pointer_property_map<Point_3>::const_type;
using Index_traits =
	CGAL::Search_traits_adapter<std::size_t, Position_map, Search_traits>;
using Index_tree = CGAL::Kd_tree<Index_traits>;
using Index_distance =
	CGAL::Distance_adapter<std::size_t, Position_map,
						   CGAL::Euclidean_distance<Search_traits>>;
using Index_search =
	CGAL::Orthogonal_k_neighbor_search<Index_traits, Index_distance>;

/* Orientation confidence gates, from the pre-CGAL pipeline (las_normal.h).
 * The margin is `tol + 2 * (1 - quality)`: the worse the plane fit, the more
 * decisive the test must be before its normal is trusted enough to flip. */
static const float SCAN_TOL = 0.25f;
static const float NML_Z_TOL = 0.55f;

enum EOrient
{
	ENone = 0,
	EOriented,
	EPositiveZ,
	EScanline
};

double cgal_estimate_scale(const Vec3 *pos, size_t point_num,
						   size_t window_target)
{
	std::vector<Point_3> window;
	if (point_num <= window_target)
	{
		window.reserve(point_num);
		for (size_t i = 0; i < point_num; ++i)
		{
			window.emplace_back(pos[i].x, pos[i].y, pos[i].z);
		}
	}
	else
	{
		float minx = pos[0].x, maxx = minx;
		float miny = pos[0].y, maxy = miny;
		for (size_t i = 0; i < point_num; ++i)
		{
			minx = std::min(minx, pos[i].x);
			maxx = std::max(maxx, pos[i].x);
			miny = std::min(miny, pos[i].y);
			maxy = std::max(maxy, pos[i].y);
		}
		float cx = 0.5f * (minx + maxx), cy = 0.5f * (miny + maxy);
		float frac = std::sqrt((float)window_target / point_num);
		float hx = 0.5f * (maxx - minx) * frac;
		float hy = 0.5f * (maxy - miny) * frac;
		for (size_t i = 0; i < point_num; ++i)
		{
			if (std::abs(pos[i].x - cx) <= hx &&
				std::abs(pos[i].y - cy) <= hy)
			{
				window.emplace_back(pos[i].x, pos[i].y, pos[i].z);
			}
		}
		if (window.size() < window_target / 8)
		{
			/* Window landed on a hole (water, cliff shadow): scale
			 * estimation needs real neighborhoods, use everything. */
			window.clear();
			window.reserve(point_num);
			for (size_t i = 0; i < point_num; ++i)
			{
				window.emplace_back(pos[i].x, pos[i].y, pos[i].z);
			}
		}
	}
	return CGAL::estimate_global_range_scale(window);
}

/* Neighborhood size cap: a PCA plane fit gains nothing past ~15 neighbors,
 * and an unbounded spherical query in dense areas would return 50-100+
 * points and dominate the run time. */
static const int K_NEIGHBORS = 15;

/* Minimum neighborhood for a stable plane fit; when fewer points fall
 * inside the radius (sparse regions), the nearest ones are used regardless
 * of distance. */
static const int MIN_NEIGHBORS = 12;

/* Fitting polynomial degree of the jet refit; a degree-d jet fit is
 * under-determined below (d+1)(d+2)/2 points. The Monge output degree is
 * kept at 1: only the normal is used. */
static const int JET_ORDER = 2;

/* Plane-fit quality (1 - lambda_min/lambda_max of the neighborhood
 * covariance, as returned by linear_least_squares_fitting_3: 1 = perfect
 * plane, 0 = isotropic) below which the PCA normal is re-estimated with
 * a jet (Monge) fit. */
static const double JET_QUALITY = 0.8;

/* Neighborhood of `query`: the indices of its K_NEIGHBORS nearest
 * neighbors, restricted to `radius`. The query point itself is
 * included. */
static void gather_neighborhood(const Index_tree &tree,
								const Position_map &pos_map,
								const Point_3 &query, double radius,
								std::vector<std::size_t> &nbhd)
{
	nbhd.clear();
	Index_search knn(tree, query, K_NEIGHBORS, 0.0, true,
					 Index_distance(pos_map));
	const double r2 = radius * radius;
	for (const auto &r : knn) /* sorted by increasing distance */
	{
		if ((int)nbhd.size() < MIN_NEIGHBORS || r.second <= r2)
		{
			nbhd.push_back(r.first);
		}
	}
}

void cgal_estimate_and_orient_normals(Vec3 *pos, size_t point_num,
									  std::vector<LasPoint> &points,
									  double neighbor_radius, double grid_res,
									  Vec3 *nml, bool verbose)
{
	Timer chrono;

	/* Kd-tree */
	chrono.start();
	std::vector<Point_3> positions;
	positions.reserve(point_num);
	for (size_t i = 0; i < point_num; ++i)
	{
		positions.push_back(Point_3(pos[i].x, pos[i].y, pos[i].z));
	}
	const std::vector<Point_3> &positions_c = positions;
	Position_map pos_map = CGAL::make_property_map(positions_c);
	Index_tree tree(boost::counting_iterator<std::size_t>(0),
					boost::counting_iterator<std::size_t>(point_num),
					Index_tree::Splitter(), Index_traits(pos_map));
	tree.build();
	if (verbose)
	{
		printf("Kd-tree build              : %.2f s\n",
			   1e-6 * chrono.stop());
	}

	/* Normals, one neighborhood gather per point: PCA plane fit (the
	 * low-level primitive behind CGAL::pca_estimate_normals, whose
	 * quality = 1 - lambda_min/lambda_max comes for free), then a jet
	 * (Monge) refit over the same neighborhood wherever the plane fit is
	 * poor -- noisy or curved. Orientation is fixed later by the beam
	 * pass. */
	chrono.start();
	const int min_jet_nb = (JET_ORDER + 1) * (JET_ORDER + 2) / 2;
	size_t refit = 0;
	std::vector<std::size_t> nbhd;
	std::vector<Point_3> nbhd_pts;
	std::vector<Vector_3> nmls(point_num);
	std::vector<float> qual(point_num);
	CGAL::Monge_via_jet_fitting<Kernel> monge_fit;
	for (size_t i = 0; i < point_num; ++i)
	{
		gather_neighborhood(tree, pos_map, positions[i],
							neighbor_radius, nbhd);
		nbhd_pts.clear();
		for (std::size_t j : nbhd)
		{
			nbhd_pts.push_back(positions[j]);
		}

		Plane_3 plane;
		double quality = CGAL::linear_least_squares_fitting_3(
			nbhd_pts.begin(), nbhd_pts.end(), plane,
			CGAL::Dimension_tag<0>());
		Vector_3 n = plane.orthogonal_vector();

		if (quality < JET_QUALITY &&
			(int)nbhd.size() >= min_jet_nb)
		{
			auto monge_form = monge_fit(nbhd_pts.begin(),
										nbhd_pts.end(), JET_ORDER,
										1);
			Vector_3 jn = monge_form.normal_direction();
			if (jn * n < 0)
			{
				jn = -jn;
			}
			n = jn;
			++refit;
		}
		nmls[i] = n;
		qual[i] = (float)quality;
	}
	if (verbose)
	{
		printf("Eval. normal directions    : %zu pts, jet refit "
			   "%zu (quality < %g, order %d), %.2f s\n",
			   point_num, refit, JET_QUALITY, JET_ORDER,
			   1e-6 * chrono.stop());
	}

	/* Orientation cascade (pre-CGAL pipeline's, las_normal.cpp):
	 *   1. beam  -- the flight line's across-track azimuth plus the point's
	 *      scan angle give its beam; the normal must oppose it (face the
	 *      scanner). Decided only when the beam is not grazing the surface.
	 *   2. +Z    -- for what the beam left open, when clearly non-vertical.
	 * Both gates abstain rather than guess, so a point that clears neither
	 * still carries the PCA's arbitrary sign and gets a placeholder normal
	 * below instead. */
	chrono.start();
	int source_num = las_get_sources(points);
	std::vector<SourceStat> stats(source_num);
	las_stat_sources(points, stats);
	std::vector<SourceFlightLine> fls(source_num);
	/* theta only depends on dy/dx, and LAS x/y share a scale. */
	const double scale[3] = {1.0, 1.0, 1.0};
	int valid = las_approx_flight_lines(points, scale, stats, fls);

	std::vector<EOrient> oriented(point_num, ENone);
	size_t by_scan = 0;
	for (size_t i = 0; i < point_num; ++i)
	{
		const SourceFlightLine &fl = fls[points[i].source_idx];
		if (!fl.is_valid)
		{
			continue;
		}
		double a = points[i].scan_angle * M_PI / 180.0;
		double th = fl.theta_across;
		Vector_3 beam(cos(th) * sin(a), sin(th) * sin(a), -cos(a));
		double test = nmls[i] * beam;
		if (fabs(test) > SCAN_TOL + 2 * (1 - qual[i]))
		{
			oriented[i] = EScanline;
			if (test > 0)
			{
				nmls[i] = -nmls[i];
			}
			by_scan++;
		}
	}

	size_t by_z = 0;
	for (size_t i = 0; i < point_num; ++i)
	{
		if (oriented[i] >= EPositiveZ)
		{
			continue;
		}
		if (fabs(nmls[i].z()) > NML_Z_TOL + 2 * (1 - qual[i]))
		{
			oriented[i] = EPositiveZ;
			if (nmls[i].z() < 0)
			{
				nmls[i] = -nmls[i];
			}
			by_z++;
		}
	}

	/* What neither gate settled still carries the PCA/jet fit's arbitrary
	 * sign; write a (0,0,0) placeholder instead -- feeding a coin-flipped
	 * normal to Poisson is worse than feeding nothing. No compaction: every
	 * point stays, so pos/nml/points all stay index-aligned. */
	for (size_t i = 0; i < point_num; ++i)
	{
		if (oriented[i] >= EOriented)
		{
			nml[i].x = (float)nmls[i].x();
			nml[i].y = (float)nmls[i].y();
			nml[i].z = (float)nmls[i].z();
		}
		else
		{
			nml[i] = Vec3{0.f, 0.f, 0.f};
		}
	}

	/* Recover what's left from nearby resolved normals via the grid
	 * (las_resample.h) built over this pass's result, on the hypothesis
	 * that the terrain is tight (single-valued, no overhangs) within a few
	 * cells. */
	Grid grid = build_grid(pos, nml, point_num, (float)grid_res);
	size_t recovered = fix_zero_normals(pos, nml, point_num, grid,
										(float)grid_res, verbose);

	if (verbose)
	{
		printf("Eval. normal orientations  : %d/%d flight lines valid, "
			   "%zu by beam + %zu by +Z, %zu recovered by grid, %zu still "
			   "zero, %.2f s\n",
			   valid, source_num, by_scan, by_z, recovered,
			   point_num - by_scan - by_z - recovered,
			   1e-6 * chrono.stop());
	}
}
