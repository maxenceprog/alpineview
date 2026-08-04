#include "geo_constants.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <map>
#include <string>

#ifndef GEO_CONSTANTS_PATH
#define GEO_CONSTANTS_PATH "geo_constants.json"
#endif

/* Just enough JSON for the one shape geo_constants.json has: an object whose
 * entries are objects carrying a "value" that is a number or a string. Nested
 * arrays and every other key are skipped whole. A dependency on a real parser
 * would buy nothing here and cost a submodule. */

namespace {

struct Reader {
	const char *p;
	const char *end;
	const char *path;

	void fail(const char *what) const {
		printf("Error: %s while reading %s\n", what, path);
		exit(1);
	}

	void skipSpace(void) {
		while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' ||
						   *p == '\r' || *p == ','))
			p++;
	}

	bool at(char c) {
		skipSpace();
		return p < end && *p == c;
	}

	void expect(char c) {
		skipSpace();
		if (p >= end || *p != c)
			fail("unexpected character");
		p++;
	}

	std::string readString(void) {
		expect('"');
		std::string s;
		while (p < end && *p != '"') {
			if (*p == '\\' && p + 1 < end) {
				p++;
				if (*p == 'n')
					s.push_back('\n');
				else if (*p == 't')
					s.push_back('\t');
				else
					s.push_back(*p);
			} else {
				s.push_back(*p);
			}
			p++;
		}
		if (p >= end)
			fail("unterminated string");
		p++;
		return s;
	}

	double readNumber(void) {
		skipSpace();
		char *stop = NULL;
		double v = strtod(p, &stop);
		if (stop == p)
			fail("malformed number");
		p = stop;
		return v;
	}

	void skipValue(void) {
		skipSpace();
		if (p >= end)
			fail("truncated file");
		if (*p == '"') {
			readString();
		} else if (*p == '{' || *p == '[') {
			char open = *p;
			char close = open == '{' ? '}' : ']';
			int depth = 0;
			while (p < end) {
				if (*p == '"') {
					readString();
					continue;
				}
				if (*p == open)
					depth++;
				else if (*p == close && --depth == 0) {
					p++;
					return;
				}
				p++;
			}
			fail("unterminated object or array");
		} else {
			while (p < end && *p != ',' && *p != '}' && *p != ']')
				p++;
		}
	}
};

struct Entry {
	bool is_string;
	double number;
	std::string text;
};

std::map<std::string, Entry> gEntries;
GeoConstants gGeo;
bool gLoaded;

const Entry &entry(const char *key) {
	std::map<std::string, Entry>::const_iterator it = gEntries.find(key);
	if (it == gEntries.end()) {
		printf("Error: geo_constants.json has no \"%s\"\n", key);
		exit(1);
	}
	return it->second;
}

double numberOf(const char *key) {
	const Entry &e = entry(key);
	if (e.is_string) {
		printf("Error: geo_constants.json \"%s\" is not a number\n", key);
		exit(1);
	}
	return e.number;
}

const char *stringOf(const char *key) {
	const Entry &e = entry(key);
	if (!e.is_string) {
		printf("Error: geo_constants.json \"%s\" is not a string\n", key);
		exit(1);
	}
	return e.text.c_str();
}

const char *constantsPath(void) {
	const char *env = getenv("ALPINEVIEW_GEO_CONSTANTS");
	if (env && *env)
		return env;
	return GEO_CONSTANTS_PATH;
}

void load(void) {
	const char *path = constantsPath();
	FILE *f = fopen(path, "rb");
	if (!f) {
		printf("Error: could not open %s\n", path);
		printf("       set ALPINEVIEW_GEO_CONSTANTS to its location.\n");
		exit(1);
	}
	std::string text;
	char buf[4096];
	size_t n;
	while ((n = fread(buf, 1, sizeof(buf), f)) > 0)
		text.append(buf, n);
	fclose(f);

	Reader r{text.c_str(), text.c_str() + text.size(), path};
	r.expect('{');
	while (!r.at('}')) {
		std::string key = r.readString();
		r.expect(':');
		if (!r.at('{')) {
			r.skipValue();
			continue;
		}
		r.expect('{');
		Entry found;
		bool hasValue = false;
		while (!r.at('}')) {
			std::string field = r.readString();
			r.expect(':');
			if (field != "value") {
				r.skipValue();
				continue;
			}
			if (r.at('"')) {
				found.is_string = true;
				found.text = r.readString();
			} else {
				found.is_string = false;
				found.number = r.readNumber();
			}
			hasValue = true;
		}
		r.expect('}');
		if (hasValue)
			gEntries[key] = found;
	}

	gGeo.lat_ref = numberOf("lat_ref");
	gGeo.wmq_extent = numberOf("wmq_extent");
	gGeo.merc_radius = numberOf("merc_radius");
	gGeo.grs80_a = numberOf("grs80_a");
	gGeo.grs80_inv_f = numberOf("grs80_inv_f");
	gGeo.cell_level = (int)numberOf("cell_level");
	gGeo.lod_level0 = (int)numberOf("lod_level0");
	gGeo.level0_depth = (int)numberOf("level0_depth");
	gGeo.coarse_base_depth = (int)numberOf("coarse_base_depth");
	gGeo.proj_l93_to_geodetic = stringOf("proj_pipeline_l93_to_geodetic");
	gGeo.proj_geodetic_to_l93 = stringOf("proj_pipeline_geodetic_to_l93");

	if (gGeo.cell_level >= gGeo.lod_level0) {
		printf("Error: geo_constants.json cell_level (%d) must be "
			   "coarser than lod_level0 (%d).\n",
			   gGeo.cell_level, gGeo.lod_level0);
		exit(1);
	}
	gLoaded = true;
}

} /* namespace */

const GeoConstants &geo(void) {
	if (!gLoaded)
		load();
	return gGeo;
}

double geo_work_scale(void) { return 1.0 / cos(geo().lat_ref * M_PI / 180.0); }
