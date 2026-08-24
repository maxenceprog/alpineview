#pragma once

#include <string>
#include <vector>

/* IGN's elevation WMS, fetched as one raster per coarse cell. */

struct WmsElevationGrid {
	int width = 0, height = 0;
	double x0 = 0, y0 = 0, x1 = 0, y1 = 0;
	std::vector<float> data;
};

std::string wms_elevation_cache_dir();

bool wms_elevation_fetch(double wx0, double wy0, double wx1, double wy1,
						 int resolution, const char *cacheDir, const char *name,
						 WmsElevationGrid &grid);

float wms_elevation_sample(const WmsElevationGrid &grid, double workX, double workY);
