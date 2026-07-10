#include "mesh_clip.h"

#include <limits.h>
#include <stdint.h>
#include <vector>

static double axis_coord(const Vec3d &v, int axis)
{
	return axis == 0 ? v.x : v.y;
}

static Vec3d interp_cut(const Vec3d &a, const Vec3d &b, double ca, double cb,
			double cut)
{
	double t = (cut - ca) / (cb - ca);
	return {a.x + t * (b.x - a.x), a.y + t * (b.y - a.y),
		a.z + t * (b.z - a.z)};
}

void split_mesh(const TriMesh &m, int axis, double coord, TriMesh *lo,
		TriMesh *hi)
{
	bool has_nml = !m.normals.empty();
	std::vector<uint32_t> remap_lo(lo ? m.verts.size() : 0, UINT32_MAX);
	std::vector<uint32_t> remap_hi(hi ? m.verts.size() : 0, UINT32_MAX);

	for (size_t f = 0; f < m.faces.size(); f += 3) {
		const uint32_t idx[3] = {m.faces[f], m.faces[f + 1],
					 m.faces[f + 2]};
		const Vec3d *v[3] = {&m.verts[idx[0]], &m.verts[idx[1]],
				     &m.verts[idx[2]]};
		const double c[3] = {axis_coord(*v[0], axis),
				     axis_coord(*v[1], axis),
				     axis_coord(*v[2], axis)};

		for (int side = 0; side < 2; ++side) {
			TriMesh *out = side == 0 ? lo : hi;
			if (!out)
				continue;
			std::vector<uint32_t> &remap =
			    side == 0 ? remap_lo : remap_hi;
			bool in[3] = {
			    side == 0 ? c[0] <= coord : c[0] >= coord,
			    side == 0 ? c[1] <= coord : c[1] >= coord,
			    side == 0 ? c[2] <= coord : c[2] >= coord};
			int n_in = (int)in[0] + (int)in[1] + (int)in[2];
			if (n_in == 0)
				continue;

			/* Emit an original vertex (deduplicated via remap). */
			auto add_orig = [&](int t) -> uint32_t {
				uint32_t i = idx[t];
				if (remap[i] == UINT32_MAX) {
					remap[i] = out->verts.size();
					out->verts.push_back(*v[t]);
					if (has_nml)
						out->normals.push_back(
						    m.normals[i]);
				}
				return remap[i];
			};
			/* Emit an interpolated vertex on the cut edge ta→tb. */
			auto add_cut = [&](int ta, int tb) -> uint32_t {
				uint32_t i = out->verts.size();
				out->verts.push_back(interp_cut(*v[ta], *v[tb],
								c[ta], c[tb],
								coord));
				if (has_nml)
					out->normals.push_back(normalized(
					    interp_cut(m.normals[idx[ta]],
						      m.normals[idx[tb]],
						      c[ta], c[tb], coord)));
				return i;
			};

			if (n_in == 3) {
				out->faces.push_back(add_orig(0));
				out->faces.push_back(add_orig(1));
				out->faces.push_back(add_orig(2));
				continue;
			}

			if (n_in == 1) {
				/* 1 vertex inside → 1 clipped triangle */
				int pin = in[0] ? 0 : (in[1] ? 1 : 2);
				uint32_t iA = add_orig(pin);
				uint32_t iD = add_cut(pin, (pin + 1) % 3);
				uint32_t iE = add_cut(pin, (pin + 2) % 3);
				out->faces.push_back(iA);
				out->faces.push_back(iD);
				out->faces.push_back(iE);
			} else { /* n_in == 2 */
				/* 2 vertices inside → quad split into 2 triangles */
				int pout = !in[0] ? 0 : (!in[1] ? 1 : 2);
				int pa = (pout + 1) % 3;
				int pb = (pout + 2) % 3;
				uint32_t iA = add_orig(pa);
				uint32_t iB = add_orig(pb);
				uint32_t iD = add_cut(pa, pout);
				uint32_t iE = add_cut(pb, pout);
				out->faces.push_back(iA);
				out->faces.push_back(iB);
				out->faces.push_back(iE);
				out->faces.push_back(iA);
				out->faces.push_back(iE);
				out->faces.push_back(iD);
			}
		}
	}
}
