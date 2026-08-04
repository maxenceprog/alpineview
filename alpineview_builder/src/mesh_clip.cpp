#include "mesh_clip.h"

#include <limits.h>
#include <stdint.h>
#include <vector>

static float axisCoord(const Vec3 &v, int axis) {
	return axis == 0 ? v.x : v.y;
}

static Vec3 interpCut(const Vec3 &a, const Vec3 &b, float ca, float cb,
					  float cut) {
	float t = (cut - ca) / (cb - ca);
	return {a.x + t * (b.x - a.x), a.y + t * (b.y - a.y),
			a.z + t * (b.z - a.z)};
}

void split_mesh(const TriMesh &m, int axis, float coord, TriMesh *lo,
				TriMesh *hi) {
	bool hasNml = !m.normals.empty();
	std::vector<uint32_t> remapLo(lo ? m.verts.size() : 0, UINT32_MAX);
	std::vector<uint32_t> remapHi(hi ? m.verts.size() : 0, UINT32_MAX);

	for (size_t f = 0; f < m.faces.size(); f += 3) {
		const uint32_t idx[3] = {m.faces[f], m.faces[f + 1], m.faces[f + 2]};
		const Vec3 *v[3] = {&m.verts[idx[0]], &m.verts[idx[1]],
							&m.verts[idx[2]]};
		const double c[3] = {axisCoord(*v[0], axis), axisCoord(*v[1], axis),
							 axisCoord(*v[2], axis)};

		for (int side = 0; side < 2; ++side) {
			TriMesh *out = side == 0 ? lo : hi;
			if (!out)
				continue;
			std::vector<uint32_t> &remap = side == 0 ? remapLo : remapHi;
			bool in[3] = {side == 0 ? c[0] <= coord : c[0] >= coord,
						  side == 0 ? c[1] <= coord : c[1] >= coord,
						  side == 0 ? c[2] <= coord : c[2] >= coord};
			int nIn = (int)in[0] + (int)in[1] + (int)in[2];
			if (nIn == 0)
				continue;

			/* Emit an original vertex (deduplicated via remap). */
			auto addOrig = [&](int t) -> uint32_t {
				uint32_t i = idx[t];
				if (remap[i] == UINT32_MAX) {
					remap[i] = out->verts.size();
					out->verts.push_back(*v[t]);
					if (hasNml)
						out->normals.push_back(m.normals[i]);
				}
				return remap[i];
			};
			/* Emit an interpolated vertex on the cut edge ta→tb. */
			auto addCut = [&](int ta, int tb) -> uint32_t {
				uint32_t i = out->verts.size();
				out->verts.push_back(
					interpCut(*v[ta], *v[tb], c[ta], c[tb], coord));
				if (hasNml)
					out->normals.push_back(normalized(
						interpCut(m.normals[idx[ta]], m.normals[idx[tb]], c[ta],
								  c[tb], coord)));
				return i;
			};

			if (nIn == 3) {
				out->faces.push_back(addOrig(0));
				out->faces.push_back(addOrig(1));
				out->faces.push_back(addOrig(2));
				continue;
			}

			if (nIn == 1) {
				/* 1 vertex inside → 1 clipped triangle */
				int pin = in[0] ? 0 : (in[1] ? 1 : 2);
				uint32_t iA = addOrig(pin);
				uint32_t iD = addCut(pin, (pin + 1) % 3);
				uint32_t iE = addCut(pin, (pin + 2) % 3);
				out->faces.push_back(iA);
				out->faces.push_back(iD);
				out->faces.push_back(iE);
			} else { /* n_in == 2 */
				/* 2 vertices inside → quad split into 2 triangles */
				int pout = !in[0] ? 0 : (!in[1] ? 1 : 2);
				int pa = (pout + 1) % 3;
				int pb = (pout + 2) % 3;
				uint32_t iA = addOrig(pa);
				uint32_t iB = addOrig(pb);
				uint32_t iD = addCut(pa, pout);
				uint32_t iE = addCut(pb, pout);
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
