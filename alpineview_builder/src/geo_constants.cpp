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

namespace
{

	struct Reader
	{
		const char *p;
		const char *end;
		const char *path;

		void fail(const char *what) const
		{
			printf("Error: %s while reading %s\n", what, path);
			exit(1);
		}

		void skip_space(void)
		{
			while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' ||
							   *p == '\r' || *p == ','))
				p++;
		}

		bool at(char c)
		{
			skip_space();
			return p < end && *p == c;
		}

		void expect(char c)
		{
			skip_space();
			if (p >= end || *p != c)
				fail("unexpected character");
			p++;
		}

		std::string read_string(void)
		{
			expect('"');
			std::string s;
			while (p < end && *p != '"')
			{
				if (*p == '\\' && p + 1 < end)
				{
					p++;
					if (*p == 'n')
						s.push_back('\n');
					else if (*p == 't')
						s.push_back('\t');
					else
						s.push_back(*p);
				}
				else
				{
					s.push_back(*p);
				}
				p++;
			}
			if (p >= end)
				fail("unterminated string");
			p++;
			return s;
		}

		double read_number(void)
		{
			skip_space();
			char *stop = NULL;
			double v = strtod(p, &stop);
			if (stop == p)
				fail("malformed number");
			p = stop;
			return v;
		}

		void skip_value(void)
		{
			skip_space();
			if (p >= end)
				fail("truncated file");
			if (*p == '"')
			{
				read_string();
			}
			else if (*p == '{' || *p == '[')
			{
				char open = *p;
				char close = open == '{' ? '}' : ']';
				int depth = 0;
				while (p < end)
				{
					if (*p == '"')
					{
						read_string();
						continue;
					}
					if (*p == open)
						depth++;
					else if (*p == close && --depth == 0)
					{
						p++;
						return;
					}
					p++;
				}
				fail("unterminated object or array");
			}
			else
			{
				while (p < end && *p != ',' && *p != '}' && *p != ']')
					p++;
			}
		}
	};

	struct Entry
	{
		bool is_string;
		double number;
		std::string text;
	};

	std::map<std::string, Entry> g_entries;
	GeoConstants g_geo;
	bool g_loaded;

	const Entry &entry(const char *key)
	{
		std::map<std::string, Entry>::const_iterator it = g_entries.find(key);
		if (it == g_entries.end())
		{
			printf("Error: geo_constants.json has no \"%s\"\n", key);
			exit(1);
		}
		return it->second;
	}

	double number_of(const char *key)
	{
		const Entry &e = entry(key);
		if (e.is_string)
		{
			printf("Error: geo_constants.json \"%s\" is not a number\n", key);
			exit(1);
		}
		return e.number;
	}

	const char *string_of(const char *key)
	{
		const Entry &e = entry(key);
		if (!e.is_string)
		{
			printf("Error: geo_constants.json \"%s\" is not a string\n", key);
			exit(1);
		}
		return e.text.c_str();
	}

	const char *constants_path(void)
	{
		const char *env = getenv("ALPINEVIEW_GEO_CONSTANTS");
		if (env && *env)
			return env;
		return GEO_CONSTANTS_PATH;
	}

	void load(void)
	{
		const char *path = constants_path();
		FILE *f = fopen(path, "rb");
		if (!f)
		{
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
		while (!r.at('}'))
		{
			std::string key = r.read_string();
			r.expect(':');
			if (!r.at('{'))
			{
				r.skip_value();
				continue;
			}
			r.expect('{');
			Entry found;
			bool has_value = false;
			while (!r.at('}'))
			{
				std::string field = r.read_string();
				r.expect(':');
				if (field != "value")
				{
					r.skip_value();
					continue;
				}
				if (r.at('"'))
				{
					found.is_string = true;
					found.text = r.read_string();
				}
				else
				{
					found.is_string = false;
					found.number = r.read_number();
				}
				has_value = true;
			}
			r.expect('}');
			if (has_value)
				g_entries[key] = found;
		}

		g_geo.lat_ref = number_of("lat_ref");
		g_geo.wmq_extent = number_of("wmq_extent");
		g_geo.merc_radius = number_of("merc_radius");
		g_geo.grs80_a = number_of("grs80_a");
		g_geo.grs80_inv_f = number_of("grs80_inv_f");
		g_geo.cell_level = (int)number_of("cell_level");
		g_geo.lod_level0 = (int)number_of("lod_level0");
		g_geo.level0_depth = (int)number_of("level0_depth");
		g_geo.coarse_base_depth = (int)number_of("coarse_base_depth");
		g_geo.proj_l93_to_geodetic = string_of("proj_pipeline_l93_to_geodetic");
		g_geo.proj_geodetic_to_l93 = string_of("proj_pipeline_geodetic_to_l93");

		if (g_geo.cell_level >= g_geo.lod_level0)
		{
			printf("Error: geo_constants.json cell_level (%d) must be "
				   "coarser than lod_level0 (%d).\n",
				   g_geo.cell_level, g_geo.lod_level0);
			exit(1);
		}
		g_loaded = true;
	}

} /* namespace */

const GeoConstants &geo(void)
{
	if (!g_loaded)
		load();
	return g_geo;
}

double geo_work_scale(void)
{
	return 1.0 / cos(geo().lat_ref * M_PI / 180.0);
}
