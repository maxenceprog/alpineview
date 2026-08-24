#include "wms_elevation.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <filesystem>

#include <curl/curl.h>

#include "geo_constants.h"

namespace fs = std::filesystem;

static const char *LAYER_HIGHRES = "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES";
static const char *LAYER_SRTM = "ELEVATION.ELEVATIONGRIDCOVERAGE";
static const float NODATA_THRESHOLD = -1000.f;

std::string wms_elevation_cache_dir() {
	const char *home = getenv("HOME");
	return std::string(home ? home : ".") + "/.cache/poissonrecon-ign/coarse_wms";
}

static size_t writeToString(char *ptr, size_t size, size_t nmemb, void *userdata) {
	((std::string *)userdata)->append(ptr, size * nmemb);
	return size * nmemb;
}

static bool fetchGrid(const char *layer, double wx0, double wy0, double wx1, double wy1,
					  int resolution, WmsElevationGrid &grid) {
	double k = geo_work_scale();
	char url[1024];
	snprintf(url, sizeof(url),
			"https://data.geopf.fr/wms-r?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap"
			"&LAYERS=%s&STYLES=&FORMAT=image%%2Fx-bil%%3Bbits%%3D32&CRS=EPSG%%3A3857"
			"&BBOX=%.3f,%.3f,%.3f,%.3f&WIDTH=%d&HEIGHT=%d",
			layer, wx0 * k, wy0 * k, wx1 * k, wy1 * k, resolution, resolution);

	std::string body;
	CURL *curl = curl_easy_init();
	if (!curl)
		return (false);
	curl_easy_setopt(curl, CURLOPT_URL, url);
	curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeToString);
	curl_easy_setopt(curl, CURLOPT_WRITEDATA, &body);
	curl_easy_setopt(curl, CURLOPT_TIMEOUT, 60L);
	curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
	curl_easy_setopt(curl, CURLOPT_ACCEPT_ENCODING, "");
	CURLcode res = curl_easy_perform(curl);
	long httpCode = 0;
	curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
	curl_easy_cleanup(curl);

	long wantBytes = (long)resolution * resolution * 4;
	if (res != CURLE_OK) {
		printf("Warning: WMS elevation fetch failed: %s\n", curl_easy_strerror(res));
		return (false);
	}
	if (httpCode != 200 || (long)body.size() != wantBytes) {
		printf("Warning: WMS elevation fetch: HTTP %ld, %zu bytes (wanted %ld)\n",
			   httpCode, body.size(), wantBytes);
		return (false);
	}

	grid.width = grid.height = resolution;
	grid.x0 = wx0;
	grid.y0 = wy0;
	grid.x1 = wx1;
	grid.y1 = wy1;
	grid.data.resize((size_t)resolution * resolution);
	memcpy(grid.data.data(), body.data(), body.size());
	return (true);
}

static bool fetchCached(const char *layer, double wx0, double wy0, double wx1, double wy1,
						int resolution, const char *cacheDir, const std::string &path,
						WmsElevationGrid &grid) {
	long wantBytes = (long)resolution * resolution * 4;
	std::error_code sizeEc;
	if (fs::file_size(path, sizeEc) == (uintmax_t)wantBytes && !sizeEc) {
		FILE *f = fopen(path.c_str(), "rb");
		if (f) {
			grid.width = grid.height = resolution;
			grid.x0 = wx0;
			grid.y0 = wy0;
			grid.x1 = wx1;
			grid.y1 = wy1;
			grid.data.resize((size_t)resolution * resolution);
			size_t got = fread(grid.data.data(), sizeof(float), grid.data.size(), f);
			fclose(f);
			if (got == grid.data.size())
				return (true);
		}
	}

	if (!fetchGrid(layer, wx0, wy0, wx1, wy1, resolution, grid))
		return (false);

	std::string tmp = path + ".tmp";
	FILE *f = fopen(tmp.c_str(), "wb");
	if (f) {
		fwrite(grid.data.data(), sizeof(float), grid.data.size(), f);
		fclose(f);
		rename(tmp.c_str(), path.c_str());
	}
	return (true);
}

bool wms_elevation_fetch(double wx0, double wy0, double wx1, double wy1, int resolution,
						 const char *cacheDir, const char *name, WmsElevationGrid &grid) {
	std::error_code ec;
	fs::create_directories(cacheDir, ec);
	std::string path = std::string(cacheDir) + "/" + name + ".bil";

	if (!fetchCached(LAYER_HIGHRES, wx0, wy0, wx1, wy1, resolution, cacheDir, path, grid))
		return (false);

	size_t nodata = 0;
	for (float v : grid.data)
		if (v < NODATA_THRESHOLD)
			nodata++;
	if (nodata == 0)
		return (true);

	WmsElevationGrid fallback;
	std::string fallbackPath = std::string(cacheDir) + "/" + name + "_srtm.bil";
	if (!fetchCached(LAYER_SRTM, wx0, wy0, wx1, wy1, resolution, cacheDir, fallbackPath,
					 fallback))
		return (true);

	printf("WMS elevation: %zu/%zu pixels missing from HIGHRES, patched from SRTM\n", nodata,
		   grid.data.size());
	for (size_t i = 0; i < grid.data.size(); ++i)
		if (grid.data[i] < NODATA_THRESHOLD && fallback.data[i] >= NODATA_THRESHOLD)
			grid.data[i] = fallback.data[i];
	return (true);
}

float wms_elevation_sample(const WmsElevationGrid &grid, double workX, double workY) {
	if (grid.data.empty())
		return NAN;
	if (workX < grid.x0 || workX > grid.x1 || workY < grid.y0 || workY > grid.y1)
		return NAN;

	double fcol = (workX - grid.x0) / (grid.x1 - grid.x0) * grid.width - 0.5;
	double frow = (grid.y1 - workY) / (grid.y1 - grid.y0) * grid.height - 0.5;
	int col = (int)floor(fcol);
	int row = (int)floor(frow);
	double ax = fcol - col;
	double ay = frow - row;

	auto at = [&](int c, int r) -> float {
		if (c < 0 || r < 0 || c >= grid.width || r >= grid.height)
			return NAN;
		float v = grid.data[(size_t)r * grid.width + c];
		return v < NODATA_THRESHOLD ? NAN : v;
	};

	float v00 = at(col, row);
	float v10 = at(col + 1, row);
	float v01 = at(col, row + 1);
	float v11 = at(col + 1, row + 1);
	if (isnan(v00) || isnan(v10) || isnan(v01) || isnan(v11))
		return NAN;

	double top = v00 * (1.0 - ax) + v10 * ax;
	double bot = v01 * (1.0 - ax) + v11 * ax;
	return (float)(top * (1.0 - ay) + bot * ay);
}
