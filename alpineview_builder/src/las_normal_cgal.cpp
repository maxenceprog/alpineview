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
#include <CGAL/scanline_orient_normals.h>

#include <boost/iterator/counting_iterator.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>

#include "chrono.h"

using Kernel = CGAL::Exact_predicates_inexact_constructions_kernel;
using Point_3 = Kernel::Point_3;
using Vector_3 = Kernel::Vector_3;
using Plane_3 = Kernel::Plane_3;
using Pwn = std::pair<Point_3, Vector_3>;
using Point_map = CGAL::First_of_pair_property_map<Pwn>;
using Normal_map = CGAL::Second_of_pair_property_map<Pwn>;

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

/* Read-only property map over a flat side array, indexed by pointer offset
 * from a Pwn vector's data(). Lets scanline_orient_normals' named-parameter
 * maps (scan_angle_map, scanline_id_map) reach into plain arrays without
 * bundling them into the Pwn struct. Only valid while the Pwn vector is not
 * reordered, which holds for scanline_orient_normals. */
template <typename ValueT>
struct ArrayPropertyMap
{
	using key_type = Pwn;
	using value_type = ValueT;
	using reference = ValueT;
	using category = boost::readable_property_map_tag;

	const Pwn *base = nullptr;
	const ValueT *data = nullptr;
};

template <typename ValueT>
ValueT get(const ArrayPropertyMap<ValueT> &m, const Pwn &key)
{
	return m.data[&key - m.base];
}

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
static const double JET_QUALITY = 0.95;

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

void cgal_estimate_and_orient_normals(const Vec3 *pos, size_t point_num,
				      const std::vector<LasPoint> &points,
				      double neighbor_radius, Vec3 *nml,
				      bool verbose)
{
	Timer chrono;

	/* Kd-tree */
	chrono.start();
	std::vector<Pwn> pwn(point_num);
	for (size_t i = 0; i < point_num; ++i)
	{
		pwn[i] = {Point_3(pos[i].x, pos[i].y, pos[i].z),
			  Vector_3(0, 0, 0)};
	}
	std::vector<Point_3> positions;
	positions.reserve(point_num);
	for (size_t i = 0; i < point_num; ++i)
	{
		positions.push_back(pwn[i].first);
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
	 * poor -- noisy or curved. Orientation is fixed later by the
	 * scanline pass. */
	chrono.start();
	const int min_jet_nb = (JET_ORDER + 1) * (JET_ORDER + 2) / 2;
	size_t refit = 0;
	std::vector<std::size_t> nbhd;
	std::vector<Point_3> nbhd_pts;
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
		pwn[i].second = n;
	}
	if (verbose)
	{
		printf("Eval. normal directions    : %zu pts, jet refit "
		       "%zu (quality < %g, order %d), %.2f s\n",
		       point_num, refit, JET_QUALITY, JET_ORDER,
		       1e-6 * chrono.stop());
	}

	/* Scanline orientation. scan_angle / source_id live in LasPoint, not
	 * in the Pwn vector CGAL iterates over: side arrays + pointer-offset
	 * property maps bridge the two. */
	chrono.start();
	std::vector<double> scan_angle(point_num);
	std::vector<int32_t> source_id(point_num);
	for (size_t i = 0; i < point_num; ++i)
	{
		scan_angle[i] = (double)points[i].scan_angle;
		source_id[i] = (int32_t)points[i].source_id;
	}
	ArrayPropertyMap<double> scan_angle_map{pwn.data(), scan_angle.data()};
	ArrayPropertyMap<int32_t> scanline_id_map{pwn.data(), source_id.data()};
	CGAL::scanline_orient_normals(
	    pwn, CGAL::parameters::point_map(Point_map())
		     .normal_map(Normal_map())
		     .scan_angle_map(scan_angle_map)
		     .scanline_id_map(scanline_id_map));
	if (verbose)
	{
		printf("Eval. normal orientations  : %.2f s\n",
		       1e-6 * chrono.stop());
	}

	for (size_t i = 0; i < point_num; ++i)
	{
		const Vector_3 &n = pwn[i].second;
		nml[i].x = (float)n.x();
		nml[i].y = (float)n.y();
		nml[i].z = (float)n.z();
	}
}
