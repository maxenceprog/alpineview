#pragma once

#include <string>
#include <vector>

/* ESRI ASCII grid (RGE ALTI 5 m), one file per IGN download square, in
 * Lambert-93 with NGF-IGN69 altitudes.
 *
 * xllcorner / yllcorner is the lower-left CORNER of the lower-left cell, so a
 * cell's value sits half a cell further in; row 0 of the data is the NORTH
 * row. */

struct AscHeader {
	int ncols;
	int nrows;
	double xll;
	double yll;
	double cellsize;
	double nodata;
};

struct AscTile {
	AscHeader hdr;
	std::string path;
	std::vector<float> z;
};

int asc_read_header(const char *path, AscHeader &hdr);

/* Every *.asc under dir, headers only. */
int asc_index(const char *dir, std::vector<AscTile> &tiles);

/* Load the grid of every tile whose extent meets [x0,x1] x [y0,y1] in L93
 * metres; leaves the others unloaded. Returns how many were loaded. */
int asc_load_overlapping(std::vector<AscTile> &tiles, double x0, double y0,
						 double x1, double y1);

/* Bilinear height at an L93 position, NAN outside every loaded tile or on
 * NODATA. */
float asc_sample(const std::vector<AscTile> &tiles, double x, double y);
