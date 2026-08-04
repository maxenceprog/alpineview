#include "asc_grid.h"

#include <dirent.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <algorithm>

static int readKeyValue(FILE *f, const char *want, double &out) {
	char key[64];
	double value;
	if (fscanf(f, "%63s %lf", key, &value) != 2)
		return (-1);
	for (char *p = key; *p; ++p)
		*p = tolower(*p);
	if (strcmp(key, want) != 0) {
		printf("Error: expected '%s' in the .asc header, got '%s'.\n", want,
			   key);
		return (-1);
	}
	out = value;
	return (0);
}

int asc_read_header(const char *path, AscHeader &hdr) {
	FILE *f = fopen(path, "r");
	if (!f)
		return (-1);

	double ncols, nrows, xll, yll, cellsize, nodata;
	int ret = readKeyValue(f, "ncols", ncols) ||
			  readKeyValue(f, "nrows", nrows) ||
			  readKeyValue(f, "xllcorner", xll) ||
			  readKeyValue(f, "yllcorner", yll) ||
			  readKeyValue(f, "cellsize", cellsize) ||
			  readKeyValue(f, "nodata_value", nodata);
	fclose(f);
	if (ret)
		return (-1);

	hdr.ncols = (int)ncols;
	hdr.nrows = (int)nrows;
	hdr.xll = xll;
	hdr.yll = yll;
	hdr.cellsize = cellsize;
	hdr.nodata = nodata;
	return (0);
}

static void indexDir(const char *dir, std::vector<AscTile> &tiles) {
	DIR *d = opendir(dir);
	if (!d)
		return;

	struct dirent *e;
	while ((e = readdir(d)) != NULL) {
		if (e->d_name[0] == '.')
			continue;
		std::string path = std::string(dir) + "/" + e->d_name;

		if (e->d_type == DT_DIR) {
			indexDir(path.c_str(), tiles);
			continue;
		}

		size_t len = strlen(e->d_name);
		if (len < 4 || strcmp(e->d_name + len - 4, ".asc") != 0)
			continue;

		AscTile tile;
		if (asc_read_header(path.c_str(), tile.hdr))
			continue;
		tile.path = path;
		tiles.push_back(std::move(tile));
	}
	closedir(d);
}

int asc_index(const char *dir, std::vector<AscTile> &tiles) {
	indexDir(dir, tiles);
	std::sort(
		tiles.begin(), tiles.end(),
		[](const AscTile &a, const AscTile &b) { return a.path < b.path; });
	return (int)tiles.size();
}

static void tileExtent(const AscHeader &h, double &x0, double &y0, double &x1,
					   double &y1) {
	x0 = h.xll;
	y0 = h.yll;
	x1 = h.xll + h.ncols * h.cellsize;
	y1 = h.yll + h.nrows * h.cellsize;
}

static int loadTile(AscTile &tile) {
	FILE *f = fopen(tile.path.c_str(), "r");
	if (!f)
		return (-1);

	char key[64];
	double value;
	for (int i = 0; i < 6; ++i) {
		if (fscanf(f, "%63s %lf", key, &value) != 2) {
			fclose(f);
			return (-1);
		}
	}

	size_t num = (size_t)tile.hdr.ncols * tile.hdr.nrows;
	tile.z.resize(num);
	for (size_t i = 0; i < num; ++i) {
		double v;
		if (fscanf(f, "%lf", &v) != 1) {
			fclose(f);
			printf("Error: %s ended after %zu of %zu samples.\n",
				   tile.path.c_str(), i, num);
			tile.z.clear();
			return (-1);
		}
		tile.z[i] = (v == tile.hdr.nodata) ? NAN : (float)v;
	}
	fclose(f);
	return (0);
}

int asc_load_overlapping(std::vector<AscTile> &tiles, double x0, double y0,
						 double x1, double y1) {
	int loaded = 0;
	for (AscTile &tile : tiles) {
		double tx0, ty0, tx1, ty1;
		tileExtent(tile.hdr, tx0, ty0, tx1, ty1);
		if (tx1 <= x0 || tx0 >= x1 || ty1 <= y0 || ty0 >= y1)
			continue;
		if (!tile.z.empty()) {
			loaded++;
			continue;
		}
		if (loadTile(tile) == 0)
			loaded++;
	}
	return loaded;
}

/* Value at the (col, row) sample centre, row 0 being the north row. */
static float cellValue(const AscTile &t, int col, int row) {
	if (col < 0 || row < 0 || col >= t.hdr.ncols || row >= t.hdr.nrows)
		return NAN;
	return t.z[(size_t)row * t.hdr.ncols + col];
}

float asc_sample(const std::vector<AscTile> &tiles, double x, double y) {
	for (const AscTile &t : tiles) {
		if (t.z.empty())
			continue;
		double tx0, ty0, tx1, ty1;
		tileExtent(t.hdr, tx0, ty0, tx1, ty1);
		if (x < tx0 || x >= tx1 || y < ty0 || y >= ty1)
			continue;

		double cs = t.hdr.cellsize;
		double fcol = (x - tx0) / cs - 0.5;
		double frow = (ty1 - y) / cs - 0.5;
		int col = (int)floor(fcol);
		int row = (int)floor(frow);
		double ax = fcol - col;
		double ay = frow - row;

		float v00 = cellValue(t, col, row);
		float v10 = cellValue(t, col + 1, row);
		float v01 = cellValue(t, col, row + 1);
		float v11 = cellValue(t, col + 1, row + 1);
		if (isnan(v00) || isnan(v10) || isnan(v01) || isnan(v11))
			return NAN;

		double top = v00 * (1.0 - ax) + v10 * ax;
		double bot = v01 * (1.0 - ax) + v11 * ax;
		return (float)(top * (1.0 - ay) + bot * ay);
	}
	return NAN;
}
