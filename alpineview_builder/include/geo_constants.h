#pragma once

/* The constants that place the terrain on the globe, read at run time from
 * geo_constants.json at the repository root. That file, not this header, is
 * where they are defined and explained; it is also what the Python tiler and
 * the webapp read, so no value is ever written down twice.
 *
 * geo() loads on first use and never returns a partial set: a missing file, a
 * missing key or a malformed one is fatal, because every alternative is a run
 * that silently produces misplaced geometry.
 *
 * The file is looked up in this order:
 *   $ALPINEVIEW_GEO_CONSTANTS
 *   GEO_CONSTANTS_PATH, the absolute path baked in at build time
 */

struct GeoConstants {
	double lat_ref;
	double wmq_extent;
	double merc_radius;
	double grs80_a;
	double grs80_inv_f;
	int cell_level;
	int lod_level0;
	int level0_depth;
	int coarse_base_depth;
	const char *proj_l93_to_geodetic;
	const char *proj_geodetic_to_l93;
};

const GeoConstants &geo(void);

/* 1 / cos(lat_ref): the factor between Mercator metres and the working
 * frame's true-scale metres. */
double geo_work_scale(void);
