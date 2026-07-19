#include "mesh_lod.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <unordered_map>
#include <utility>
#include <vector>

#include "chrono.h"
#include "mesh_clip.h"

#include <draco/compression/encode.h>
#include <draco/mesh/triangle_soup_mesh_builder.h>

/* Match DracoPy.encode_mesh_to_buffer defaults so the C++ output is
 * interchangeable with the existing Python-built webapp tiles. */
static const int DRACO_QUANT_BITS = 14; /* quantization_bits=14 */
static const int DRACO_SPEED = 9;		/* compression_level=1 -> 10-1 */

/******************************************************************************
 * Conversion + bounds
 ******************************************************************************/

static TriMesh to_trimesh(const Mesh &mesh, const MBuf &data)
{
	TriMesh m;
	const Vec3 *pos = data.positions + mesh.vertex_offset;
	const uint32_t *idx = data.indices + mesh.index_offset;
	m.verts.reserve(mesh.vertex_count);
	for (uint32_t i = 0; i < mesh.vertex_count; ++i)
	{
		m.verts.push_back(Vec3d{pos[i].x, pos[i].y, pos[i].z});
	}
	m.faces.assign(idx, idx + mesh.index_count);
	return m;
}

static void aabb(const TriMesh &m, Vec3d &lo, Vec3d &hi)
{
	lo = Vec3d{1e30, 1e30, 1e30};
	hi = Vec3d{-1e30, -1e30, -1e30};
	for (const Vec3d &v : m.verts)
	{
		lo.x = v.x < lo.x ? v.x : lo.x;
		lo.y = v.y < lo.y ? v.y : lo.y;
		lo.z = v.z < lo.z ? v.z : lo.z;
		hi.x = v.x > hi.x ? v.x : hi.x;
		hi.y = v.y > hi.y ? v.y : hi.y;
		hi.z = v.z > hi.z ? v.z : hi.z;
	}
}

/* Ideal (x0,y0,x1,y1) of the (dx,dy)-th cell of an n x n XY grid. */
static void cell_bounds(const Vec3d &lo, const Vec3d &hi, int dx, int dy, int n,
						double &x0, double &y0, double &x1, double &y1)
{
	double xs = (hi.x - lo.x) / n;
	double ys = (hi.y - lo.y) / n;
	x0 = lo.x + dx * xs;
	y0 = lo.y + dy * ys;
	x1 = lo.x + (dx + 1) * xs;
	y1 = lo.y + (dy + 1) * ys;
}

/******************************************************************************
 * Vertex-clustering simplification (Open3D simplify_vertex_clustering, average)
 ******************************************************************************/

struct GridKey
{
	int32_t i, j, k;
	bool operator==(const GridKey &o) const
	{
		return i == o.i && j == o.j && k == o.k;
	}
};
struct GridKeyHash
{
	size_t operator()(const GridKey &v) const
	{
		return (size_t)(v.i * 73856093) ^ (size_t)(v.j * 19349663) ^
			   (size_t)(v.k * 83492791);
	}
};

static TriMesh vertex_cluster(const TriMesh &m, const Vec3d &lo,
							  const Vec3d &hi, int n, double voxel)
{
	/* Map each vertex to a voxel; each occupied voxel becomes one output
	 * vertex at the centroid of its members (average pooling). */
	std::unordered_map<GridKey, uint32_t, GridKeyHash> voxel_of;
	voxel_of.reserve(m.verts.size());
	std::vector<uint32_t> remap(m.verts.size());
	TriMesh out;
	std::vector<uint32_t> counts;

	/* Vertices within one voxel of an n x n cell-grid line (in x or y) are
	 * left exactly where they are, each as its own singleton cluster.
	 * Moving them would shift the shared cell edge and open cracks against
	 * the neighbouring cell, which may be tessellated at a different LOD
	 * (this includes the outer tile boundary, shared with adjacent km tiles). */
	const double sx = (hi.x - lo.x) / n;
	const double sy = (hi.y - lo.y) / n;
	auto near_grid_line = [&](double v, double origin, double step)
	{
		if (step <= 0)
			return false;
		double f = (v - origin) / step;
		return fabs(f - round(f)) * step <= voxel;
	};
	auto on_boundary = [&](const Vec3d &v)
	{
		return near_grid_line(v.x, lo.x, sx) || near_grid_line(v.y, lo.y, sy);
	};

	for (size_t i = 0; i < m.verts.size(); ++i)
	{
		const Vec3d &v = m.verts[i];
		if (on_boundary(v))
		{
			remap[i] = out.verts.size();
			out.verts.push_back(v);
			counts.push_back(1);
			continue;
		}
		GridKey key{(int32_t)floor((v.x - lo.x) / voxel),
					(int32_t)floor((v.y - lo.y) / voxel),
					(int32_t)floor((v.z - lo.z) / voxel)};
		auto it = voxel_of.find(key);
		uint32_t ci;
		if (it == voxel_of.end())
		{
			ci = out.verts.size();
			voxel_of.emplace(key, ci);
			out.verts.push_back(v);
			counts.push_back(1);
		}
		else
		{
			ci = it->second;
			out.verts[ci] += v;
			counts[ci] += 1;
		}
		remap[i] = ci;
	}
	for (size_t c = 0; c < out.verts.size(); ++c)
	{
		out.verts[c] /= (double)counts[c];
	}

	/* Remap triangles, dropping those collapsed into a single voxel. */
	for (size_t f = 0; f < m.faces.size(); f += 3)
	{
		uint32_t a = remap[m.faces[f + 0]];
		uint32_t b = remap[m.faces[f + 1]];
		uint32_t c = remap[m.faces[f + 2]];
		if (a == b || b == c || a == c)
			continue;
		out.faces.push_back(a);
		out.faces.push_back(b);
		out.faces.push_back(c);
	}
	return out;
}

/* Binary subdivision of [i0, i1) along one axis: each recursion level walks the
 * triangles once, so an n-way split costs O(|m| log n) instead of O(|m| n). */
static void split_range(TriMesh &m, int axis, double base, double step, int i0,
						int i1, std::vector<TriMesh> &out)
{
	if (i1 - i0 == 1)
	{
		out[i0] = std::move(m);
		return;
	}
	int mid = (i0 + i1) / 2;
	TriMesh lo_part, hi_part;
	split_mesh(m, axis, base + mid * step, &lo_part, &hi_part);
	m = TriMesh();
	split_range(lo_part, axis, base, step, i0, mid, out);
	split_range(hi_part, axis, base, step, mid, i1, out);
}

/* Cut m into the n x n cell grid of [lo, hi]; cells[dy * n + dx] matches
 * cell_bounds(lo, hi, dx, dy, n). */
static void clip_grid(const TriMesh &m, const Vec3d &lo, const Vec3d &hi, int n,
					  std::vector<TriMesh> &cells)
{
	cells.assign((size_t)n * n, TriMesh());
	std::vector<TriMesh> cols(n), col_cells(n);
	TriMesh work = m;
	split_range(work, 0, lo.x, (hi.x - lo.x) / n, 0, n, cols);
	for (int dx = 0; dx < n; ++dx)
	{
		split_range(cols[dx], 1, lo.y, (hi.y - lo.y) / n, 0, n,
					col_cells);
		for (int dy = 0; dy < n; ++dy)
			cells[(size_t)dy * n + dx] = std::move(col_cells[dy]);
	}
}

/******************************************************************************
 * Skirt: extrude the open boundary straight down to hide cracks between
 * differently-tessellated neighbours (port of _add_skirt).
 ******************************************************************************/

static void add_skirt(TriMesh &m, double x0, double y0, double x1, double y1,
					  double depth)
{
	if (m.faces.empty() || depth <= 0)
		return;

	/* Count undirected edges; boundary edges occur exactly once. Keep the
	 * directed boundary edges to wind the skirt consistently. */
	std::unordered_map<uint64_t, int> edge_count;
	edge_count.reserve(m.faces.size());
	auto ukey = [](uint32_t a, uint32_t b)
	{
		uint32_t lo = a < b ? a : b;
		uint32_t hi = a < b ? b : a;
		return ((uint64_t)lo << 32) | hi;
	};
	for (size_t f = 0; f < m.faces.size(); f += 3)
	{
		uint32_t v[3] = {m.faces[f], m.faces[f + 1], m.faces[f + 2]};
		for (int e = 0; e < 3; ++e)
			edge_count[ukey(v[e], v[(e + 1) % 3])]++;
	}
	std::vector<std::pair<uint32_t, uint32_t>> bedges;
	for (size_t f = 0; f < m.faces.size(); f += 3)
	{
		uint32_t v[3] = {m.faces[f], m.faces[f + 1], m.faces[f + 2]};
		for (int e = 0; e < 3; ++e)
		{
			uint32_t a = v[e];
			uint32_t b = v[(e + 1) % 3];
			if (edge_count[ukey(a, b)] == 1)
				bedges.emplace_back(a, b);
		}
	}
	if (bedges.empty())
		return;

	/* copy of each so adjacent tiles' curtains overlap. */

	std::unordered_map<uint32_t, uint32_t> low_of; /* orig vtx -> low copy */
	for (auto &be : bedges)
	{
		for (uint32_t orig : {be.first, be.second})
		{
			if (low_of.count(orig))
				continue;
			Vec3d low = m.verts[orig];
			low.z -= depth;
			low_of[orig] = m.verts.size();
			m.verts.push_back(low);
		}
	}

	/* Two triangles per boundary edge, wound outward-front-facing. */
	for (auto &be : bedges)
	{
		uint32_t v0 = be.first, v1 = be.second;
		uint32_t l0 = low_of[v0], l1 = low_of[v1];
		m.faces.push_back(v0);
		m.faces.push_back(l1);
		m.faces.push_back(v1);
		m.faces.push_back(v0);
		m.faces.push_back(l0);
		m.faces.push_back(l1);
	}
}

/******************************************************************************
 * Draco encoding
 ******************************************************************************/

static std::vector<char> encode_draco(const TriMesh &m)
{
	size_t ntri = m.faces.size() / 3;
	if (ntri == 0)
		return {};

	draco::TriangleSoupMeshBuilder builder;
	builder.Start(ntri);
	const int pos_att = builder.AddAttribute(
		draco::GeometryAttribute::POSITION, 3, draco::DT_FLOAT32);

	for (size_t f = 0; f < ntri; ++f)
	{
		float p[3][3];
		for (int t = 0; t < 3; ++t)
		{
			const Vec3d &v = m.verts[m.faces[3 * f + t]];
			p[t][0] = (float)v.x;
			p[t][1] = (float)v.y;
			p[t][2] = (float)v.z;
		}
		builder.SetAttributeValuesForFace(pos_att, draco::FaceIndex(f),
										  p[0], p[1], p[2]);
	}

	std::unique_ptr<draco::Mesh> mesh = builder.Finalize();
	if (!mesh)
		return {};

	draco::Encoder encoder;
	encoder.SetAttributeQuantization(draco::GeometryAttribute::POSITION,
									 DRACO_QUANT_BITS);
	encoder.SetSpeedOptions(DRACO_SPEED, DRACO_SPEED);

	draco::EncoderBuffer buf;
	draco::Status status = encoder.EncodeMeshToBuffer(*mesh, &buf);
	if (!status.ok())
		return {};

	return std::vector<char>(buf.data(), buf.data() + buf.size());
}

/******************************************************************************
 * Driver
 ******************************************************************************/

static int simplify_factor(int z)
{
	/* 16, 4 then full resolution (matches z=0/1/2 of the Python pipeline). */
	int f = 1;
	for (int e = z; e < 2; ++e)
		f *= 4;
	return f;
}

static bool save_buf(const std::vector<char> &buf, const char *out_dir, int x,
					 int y, int z)
{
	if (buf.empty())
		return false;
	char path[512];
	int base = strlen(out_dir);
	bool slash = base && out_dir[base - 1] == '/';
	snprintf(path, sizeof(path), "%s%stile.%d.%d.%d.drc", out_dir,
			 slash ? "" : "/", x, y, z);
	FILE *f = fopen(path, "wb");
	if (!f)
		return false;
	bool ok = fwrite(buf.data(), 1, buf.size(), f) == buf.size();
	fclose(f);
	return ok;
}

int write_lod_level(const Mesh &mesh, const MBuf &data, int x_km, int y_km,
					int z, float skirt_depth, const char *out_dir, bool verbose)
{
	if (mesh.index_count == 0)
		return 0;

	Timer chrono;
	unsigned int t_clip = 0, t_skirt = 0, t_draco = 0, t_save = 0;

	chrono.start();
	const double skirt_km = skirt_depth / 1000.0;
	TriMesh level = to_trimesh(mesh, data);
	Vec3d lo, hi;
	aabb(level, lo, hi);
	unsigned int t_prep = chrono.stop();

	int n = 1 << z;
	int written = 0;
	std::vector<TriMesh> cells;
	chrono.start();
	clip_grid(level, lo, hi, n, cells);
	t_clip = chrono.stop();
	for (int dy = 0; dy < n; ++dy)
	{
		for (int dx = 0; dx < n; ++dx)
		{
			TriMesh cell = std::move(cells[(size_t)dy * n + dx]);
			if (cell.faces.empty())
				continue;
			chrono.start();
			std::vector<char> buf = encode_draco(cell);
			t_draco += chrono.stop();
			int y_south = y_km - 1;
			int tx = x_km * n + dx;
			int ty = y_south * n + dy;
			chrono.start();
			bool ok = save_buf(buf, out_dir, tx, ty, z);
			t_save += chrono.stop();
			if (ok)
				written++;
		}
	}
	if (verbose)
	{
		unsigned d = 1000; /* us -> ms */
		printf("  LOD z=%d : %dx%d grid, native poisson -> %d tiles "
			   "(prep %ums clip %ums skirt %ums draco %ums save %ums)\n",
			   z, n, n, written, t_prep / d, t_clip / d, t_skirt / d,
			   t_draco / d, t_save / d);
	}
	return written;
}

int write_lod_tiles(const Mesh &mesh, const MBuf &data, int x_km, int y_km,
					const LodCfg &cfg, const char *out_dir, bool verbose)
{
	if (cfg.max_level < 0 || mesh.index_count == 0)
		return 0;

	const double skirt_km = cfg.skirt_depth / 1000.0;
	TriMesh full = to_trimesh(mesh, data);
	Vec3d lo, hi;
	aabb(full, lo, hi);

	int written = 0;
	for (int z = 0; z <= cfg.max_level; ++z)
	{
		int n = 1 << z;
		int factor = simplify_factor(z);

		/* Simplify once on a shared grid, then crop into n x n cells. */
		TriMesh level;
		if (factor > 1)
		{
			double ex = (hi.x - lo.x) / n;
			double ey = (hi.y - lo.y) / n;
			double ez = hi.z - lo.z;
			double sub_diag = sqrt(ex * ex + ey * ey + ez * ez);
			double voxel = sub_diag * sqrt((double)factor) / 1000.0;
			level = vertex_cluster(full, lo, hi, n, voxel);
		}
		else
		{
			level = full;
		}

		int level_written = 0;
		std::vector<TriMesh> cells;
		clip_grid(level, lo, hi, n, cells);
		for (int dy = 0; dy < n; ++dy)
		{
			for (int dx = 0; dx < n; ++dx)
			{
				double x0, y0, x1, y1;
				cell_bounds(lo, hi, dx, dy, n, x0, y0, x1, y1);
				TriMesh cell = std::move(cells[(size_t)dy * n + dx]);
				if (cell.faces.empty())
					continue;
				if (skirt_km > 0.0000001)
					add_skirt(cell, x0, y0, x1, y1, skirt_km);
				std::vector<char> buf = encode_draco(cell);
				/* IGN names a tile by its NW corner: x_km is the WEST
				 * (min) edge but y_km is the NORTH (max) edge, so the
				 * tile spans L93 north [y_km-1, y_km]. The web tile grid
				 * indexes every tile by its south (min-Y) edge, so here
				 * we convert the IGN north edge to that south-edge index
				 * (hence y_km-1). x needs no shift since x_km already is
				 * the west/min edge. */
				int y_south = y_km - 1;
				int tx = x_km * n + dx;
				int ty = y_south * n + dy;
				if (save_buf(buf, out_dir, tx, ty, z))
				{
					written++;
					level_written++;
				}
			}
		}
		if (verbose)
		{
			printf("  LOD z=%d : %dx%d grid, factor /%d -> %d tiles\n",
				   z, n, n, factor, level_written);
		}
	}
	if (verbose)
		printf("Wrote %d Draco LOD tiles.\n", written);
	return written;
}
