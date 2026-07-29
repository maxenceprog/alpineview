#include "mesh_lod.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "chrono.h"
#include "mesh_clip.h"

#include <draco/compression/encode.h>
#include <draco/mesh/mesh.h>
#include <draco/mesh/triangle_soup_mesh_builder.h>

/* Match DracoPy.encode_mesh_to_buffer defaults so the C++ output is
 * interchangeable with the existing Python-built webapp tiles. */
static const int DRACO_QUANT_BITS = 14; /* quantization_bits=14 */
static const int DRACO_SPEED = 9;		/* compression_level=1 -> 10-1 */
static const int DRACO_NORMAL_BITS = 10;

static const float KM = 1000.f;
static const int CELL_KM = 16;

/* Content tiles are named tile.{x}.{y}.{level}.glb in 3D Tiles 1.1 implicit
 * quadtree coordinates, anchored on a declared 512 km EPSG:2154 zone covering
 * the whole French Alps rather than a box fitted to what happens to be built,
 * so tile names survive every expansion of the build. Must match
 * build_root_tileset.py's constants of the same name. */
static const double ROOT_X0_KM = 768.0;
static const double ROOT_Y0_KM = 6144.0;
static const int IMPLICIT_LEVEL0 = 9;

void implicit_coords(int tx, int ty, int z, int &ilevel, int &ix,
					 int &iy)
{
	ilevel = IMPLICIT_LEVEL0 + z;
	double scale = ldexp(1.0, z); /* 2^z */
	ix = tx - (int)lround(ROOT_X0_KM * scale);
	iy = ty - (int)lround(ROOT_Y0_KM * scale);
}

/******************************************************************************
 * Bounds
 ******************************************************************************/

static void aabb(const TriMesh &m, Vec3 &lo, Vec3 &hi)
{
	lo = Vec3{1e30f, 1e30f, 1e30f};
	hi = Vec3{-1e30f, -1e30f, -1e30f};
	for (const Vec3 &v : m.verts)
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
static void cell_bounds(const Vec3 &lo, const Vec3 &hi, int dx, int dy, int n,
						float &x0, float &y0, float &x1, float &y1)
{
	float xs = (hi.x - lo.x) / n;
	float ys = (hi.y - lo.y) / n;
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

static TriMesh vertex_cluster(const TriMesh &m, const Vec3 &lo,
							  const Vec3 &hi, int n, float voxel)
{
	/* Map each vertex to a voxel; each occupied voxel becomes one output
	 * vertex at the centroid of its members (average pooling). */
	std::unordered_map<GridKey, uint32_t, GridKeyHash> voxel_of;
	voxel_of.reserve(m.verts.size());
	std::vector<uint32_t> remap(m.verts.size());
	TriMesh out;
	std::vector<uint32_t> counts;
	std::vector<Vec3d> accum;

	/* Vertices within one voxel of an n x n cell-grid line (in x or y) are
	 * left exactly where they are, each as its own singleton cluster.
	 * Moving them would shift the shared cell edge and open cracks against
	 * the neighbouring cell, which may be tessellated at a different LOD
	 * (this includes the outer tile boundary, shared with adjacent km tiles). */
	const float sx = (hi.x - lo.x) / n;
	const float sy = (hi.y - lo.y) / n;
	auto near_grid_line = [&](float v, float origin, float step)
	{
		if (step <= 0)
			return false;
		float f = (v - origin) / step;
		return fabsf(f - roundf(f)) * step <= voxel;
	};
	auto on_boundary = [&](const Vec3 &v)
	{
		return near_grid_line(v.x, lo.x, sx) || near_grid_line(v.y, lo.y, sy);
	};

	for (size_t i = 0; i < m.verts.size(); ++i)
	{
		const Vec3 &v = m.verts[i];
		Vec3d vd{v.x, v.y, v.z};
		if (on_boundary(v))
		{
			remap[i] = accum.size();
			accum.push_back(vd);
			counts.push_back(1);
			continue;
		}
		GridKey key{(int32_t)floorf((v.x - lo.x) / voxel),
					(int32_t)floorf((v.y - lo.y) / voxel),
					(int32_t)floorf((v.z - lo.z) / voxel)};
		auto it = voxel_of.find(key);
		uint32_t ci;
		if (it == voxel_of.end())
		{
			ci = accum.size();
			voxel_of.emplace(key, ci);
			accum.push_back(vd);
			counts.push_back(1);
		}
		else
		{
			ci = it->second;
			accum[ci] += vd;
			counts[ci] += 1;
		}
		remap[i] = ci;
	}
	out.reserve_vertices(accum.size());
	for (size_t c = 0; c < accum.size(); ++c)
	{
		Vec3d p = accum[c] / (double)counts[c];
		out.verts.push_back(Vec3{(float)p.x, (float)p.y, (float)p.z});
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
static void split_range(TriMesh &m, int axis, float base, float step, int i0,
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
static void clip_grid(const TriMesh &m, const Vec3 &lo, const Vec3 &hi, int n,
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
			const Vec3 &v = m.verts[m.faces[3 * f + t]];
			p[t][0] = v.x;
			p[t][1] = v.y;
			p[t][2] = v.z;
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
 * glTF (Draco) + 3D Tiles output
 ******************************************************************************/

static void compute_normals(TriMesh &m)
{
	m.normals.assign(m.verts.size(), Vec3{0.f, 0.f, 0.f});
	for (size_t f = 0; f < m.faces.size(); f += 3)
	{
		uint32_t ia = m.faces[f], ib = m.faces[f + 1], ic = m.faces[f + 2];
		const Vec3 &a = m.verts[ia];
		const Vec3 &b = m.verts[ib];
		const Vec3 &c = m.verts[ic];
		Vec3 n = cross(b - a, c - a);
		m.normals[ia] += n;
		m.normals[ib] += n;
		m.normals[ic] += n;
	}
	double zsum = 0.0;
	for (const Vec3 &n : m.normals)
		zsum += n.z;
	const float gflip = zsum < 0.0 ? -1.f : 1.f;
	for (Vec3 &n : m.normals)
	{
		n *= gflip;
		float len = norm(n);
		n = (len == 0.f) ? Vec3{0.f, 0.f, 1.f} : n / len;
	}
}

static std::vector<char> encode_pn_draco(TriMesh &m, uint32_t &num_points,
										 uint32_t &num_faces, uint32_t &pos_uid,
										 uint32_t &nrm_uid)
{
	size_t ntri = m.faces.size() / 3;
	if (ntri == 0)
		return {};
	if (m.normals.size() != m.verts.size())
		compute_normals(m);

	draco::TriangleSoupMeshBuilder builder;
	builder.Start(ntri);
	const int pos_att = builder.AddAttribute(
		draco::GeometryAttribute::POSITION, 3, draco::DT_FLOAT32);
	const int nrm_att = builder.AddAttribute(
		draco::GeometryAttribute::NORMAL, 3, draco::DT_FLOAT32);

	for (size_t f = 0; f < ntri; ++f)
	{
		float p[3][3];
		float nml[3][3];
		for (int t = 0; t < 3; ++t)
		{
			uint32_t vi = m.faces[3 * f + t];
			const Vec3 &v = m.verts[vi];
			const Vec3 &n = m.normals[vi];
			p[t][0] = v.x;
			p[t][1] = v.y;
			p[t][2] = v.z;
			nml[t][0] = n.x;
			nml[t][1] = n.y;
			nml[t][2] = n.z;
		}
		builder.SetAttributeValuesForFace(pos_att, draco::FaceIndex(f),
										  p[0], p[1], p[2]);
		builder.SetAttributeValuesForFace(nrm_att, draco::FaceIndex(f),
										  nml[0], nml[1], nml[2]);
	}

	std::unique_ptr<draco::Mesh> mesh = builder.Finalize();
	if (!mesh)
		return {};

	num_points = mesh->num_points();
	num_faces = mesh->num_faces();
	pos_uid = mesh->attribute(pos_att)->unique_id();
	nrm_uid = mesh->attribute(nrm_att)->unique_id();

	draco::Encoder encoder;
	encoder.SetAttributeQuantization(draco::GeometryAttribute::POSITION,
									 DRACO_QUANT_BITS);
	encoder.SetAttributeQuantization(draco::GeometryAttribute::NORMAL,
									 DRACO_NORMAL_BITS);
	encoder.SetSpeedOptions(DRACO_SPEED, DRACO_SPEED);

	draco::EncoderBuffer buf;
	if (!encoder.EncodeMeshToBuffer(*mesh, &buf).ok())
		return {};
	return std::vector<char>(buf.data(), buf.data() + buf.size());
}

static std::string fnum(double v)
{
	char b[64];
	snprintf(b, sizeof(b), "%.9g", v);
	return std::string(b);
}

static void put_u32(std::vector<char> &v, uint32_t x)
{
	v.push_back((char)(x & 0xff));
	v.push_back((char)((x >> 8) & 0xff));
	v.push_back((char)((x >> 16) & 0xff));
	v.push_back((char)((x >> 24) & 0xff));
}

static std::vector<char> make_glb(const std::vector<char> &draco, uint32_t np,
								  uint32_t nf, uint32_t pos_uid,
								  uint32_t nrm_uid, const Vec3 &lo,
								  const Vec3 &hi)
{
	std::string json =
		"{\"asset\":{\"version\":\"2.0\"},"
		"\"extensionsUsed\":[\"KHR_draco_mesh_compression\"],"
		"\"extensionsRequired\":[\"KHR_draco_mesh_compression\"],"
		"\"scene\":0,\"scenes\":[{\"nodes\":[0]}],"
		"\"nodes\":[{\"mesh\":0}],"
		"\"meshes\":[{\"primitives\":[{\"attributes\":{\"POSITION\":0,"
		"\"NORMAL\":1},\"indices\":2,\"material\":0,\"mode\":4,"
		"\"extensions\":{\"KHR_draco_mesh_compression\":{\"bufferView\":0,"
		"\"attributes\":{\"POSITION\":" +
		std::to_string(pos_uid) + ",\"NORMAL\":" + std::to_string(nrm_uid) +
		"}}}}]}],"
		"\"materials\":[{\"pbrMetallicRoughness\":{\"baseColorFactor\":"
		"[0.55,0.55,0.55,1.0],\"metallicFactor\":0.0,\"roughnessFactor\":1.0},"
		"\"doubleSided\":true}],"
		"\"accessors\":["
		"{\"componentType\":5126,\"count\":" +
		std::to_string(np) + ",\"type\":\"VEC3\",\"min\":[" + fnum(lo.x) + "," +
		fnum(lo.y) + "," + fnum(lo.z) + "],\"max\":[" + fnum(hi.x) + "," +
		fnum(hi.y) + "," + fnum(hi.z) + "]},"
										"{\"componentType\":5126,\"count\":" +
		std::to_string(np) + ",\"type\":\"VEC3\"},"
							 "{\"componentType\":5125,\"count\":" +
		std::to_string(nf * 3) + ",\"type\":\"SCALAR\"}],"
								 "\"bufferViews\":[{\"buffer\":0,\"byteOffset\":0,\"byteLength\":" +
		std::to_string(draco.size()) + "}],"
									   "\"buffers\":[{\"byteLength\":" +
		std::to_string(draco.size()) + "}]}";

	while (json.size() % 4 != 0)
		json.push_back(' ');
	std::vector<char> bin(draco);
	while (bin.size() % 4 != 0)
		bin.push_back(0);

	std::vector<char> glb;
	uint32_t total = 12 + 8 + json.size() + 8 + bin.size();
	put_u32(glb, 0x46546C67);
	put_u32(glb, 2);
	put_u32(glb, total);
	put_u32(glb, json.size());
	put_u32(glb, 0x4E4F534A);
	glb.insert(glb.end(), json.begin(), json.end());
	put_u32(glb, bin.size());
	put_u32(glb, 0x004E4942);
	glb.insert(glb.end(), bin.begin(), bin.end());
	return glb;
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

static bool save_glb(const std::vector<char> &buf, const char *out_dir, int x,
					 int y, int z)
{
	if (buf.empty())
		return false;
	char path[512];
	int base = strlen(out_dir);
	bool slash = base && out_dir[base - 1] == '/';
	snprintf(path, sizeof(path), "%s%stile.%d.%d.%d.glb", out_dir,
			 slash ? "" : "/", x, y, z);
	FILE *f = fopen(path, "wb");
	if (!f)
		return false;
	bool ok = fwrite(buf.data(), 1, buf.size(), f) == buf.size();
	fclose(f);
	return ok;
}

int write_lod_level(const TriMesh &mesh, int x_km, int y_km, int z, const char *out_dir, bool verbose)
{
	if (mesh.faces.empty())
		return 0;

	Timer chrono;
	unsigned int t_clip = 0, t_draco = 0, t_save = 0;

	chrono.start();

	const TriMesh &level = mesh;
	Vec3 lo, hi;
	aabb(level, lo, hi);
	lo.x = 0.0;
	lo.y = 0.0;
	hi.x = 1.0;
	hi.y = 1.0;
	unsigned int t_prep = chrono.stop();

	int n = 1 << z;
	int written = 0;
	int cell_x0 = (x_km / CELL_KM) * CELL_KM;
	int cell_y0 = ((y_km - 1) / CELL_KM) * CELL_KM;
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
			for (Vec3 &v : cell.verts)
			{
				v.x = (x_km + v.x - cell_x0) * KM;
				v.y = (y_km - 1 + v.y - cell_y0) * KM;
				v.z = v.z * KM;
			}
			Vec3 clo, chi;
			aabb(cell, clo, chi);
			chrono.start();
			uint32_t np = 0, nf = 0, pos_uid = 0, nrm_uid = 0;
			std::vector<char> draco =
				encode_pn_draco(cell, np, nf, pos_uid, nrm_uid);
			std::vector<char> glb =
				make_glb(draco, np, nf, pos_uid, nrm_uid, clo, chi);
			t_draco += chrono.stop();
			int y_south = y_km - 1;
			int tx = x_km * n + dx;
			int ty = y_south * n + dy;
			int ilevel, ix, iy;
			implicit_coords(tx, ty, z, ilevel, ix, iy);
			chrono.start();
			bool ok = save_glb(glb, out_dir, ix, iy, ilevel);
			t_save += chrono.stop();
			if (ok)
				written++;
		}
	}
	if (verbose)
	{
		unsigned d = 1000;
		printf("  LOD z=%d : %dx%d grid, native poisson -> %d tiles "
			   "(prep %ums clip %ums draco %ums save %ums)\n",
			   z, n, n, written, t_prep / d, t_clip / d, t_draco / d,
			   t_save / d);
	}
	return written;
}

int write_lod_tiles(const TriMesh &mesh, int x_km, int y_km, int z,
					const LodCfg &cfg, const char *out_dir, bool verbose)
{
	if (cfg.max_level < 0 || mesh.faces.empty())
		return 0;

	const TriMesh &full = mesh;
	Vec3 lo, hi;
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
			float ex = (hi.x - lo.x) / n;
			float ey = (hi.y - lo.y) / n;
			float ez = hi.z - lo.z;
			float sub_diag = sqrtf(ex * ex + ey * ey + ez * ez);
			float voxel = sub_diag * sqrtf((float)factor) / 1000.f;
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
				float x0, y0, x1, y1;
				cell_bounds(lo, hi, dx, dy, n, x0, y0, x1, y1);
				TriMesh cell = std::move(cells[(size_t)dy * n + dx]);
				if (cell.faces.empty())
					continue;
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
