#pragma once

#include <stdio.h>

#include "las_point_cloud.h"

int las_read_info(const char *filename, struct LasFileInfo &info);

void las_print_info(const struct LasFileInfo &info);

char *las_load_data(const char *filename, const struct LasFileInfo &info,
		    char *buf);

/* Decompress a plain (non-COPC) .laz file sequentially into a raw point
 * buffer, in the same layout las_load_data() produces for .las. */
char *las_load_laz_data(const char *filename, const struct LasFileInfo &info,
			 char *buf);

struct LasPoint las_read_point(const char *buf, unsigned char point_format);

void las_print_point(const struct LasPoint &P);

