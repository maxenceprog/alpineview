#include "mesh_lod.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include <string>
#include <utility>
#include <vector>

#include "chrono.h"
#include "geo.h"
#include "mesh_clip.h"

#include <draco/compression/encode.h>
#include <draco/mesh/mesh.h>
#include <draco/mesh/triangle_soup_mesh_builder.h>

/* Match DracoPy.encode_mesh_to_buffer defaults so the C++ output is
 * interchangeable with the existing Python-built webapp tiles. */
static const int DRACO_QUANT_BITS = 14; /* quantization_bits=14 */
static const int DRACO_SPEED = 9;		/* compression_level=1 -> 10-1 */

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

/* Cut m into the n x n cell grid of [lo, hi]; cells[dy * n + dx] is the
 * (dx, dy)-th cell, dy increasing with y. */
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
 * glTF (Draco) + 3D Tiles output
 ******************************************************************************/

static std::vector<char> encode_p_draco(TriMesh &m, uint32_t &num_points,
									   uint32_t &num_faces, uint32_t &pos_uid)
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

	num_points = mesh->num_points();
	num_faces = mesh->num_faces();
	pos_uid = mesh->attribute(pos_att)->unique_id();

	draco::Encoder encoder;
	encoder.SetAttributeQuantization(draco::GeometryAttribute::POSITION,
									 DRACO_QUANT_BITS);
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
								  uint32_t nf, uint32_t pos_uid, const Vec3 &lo,
								  const Vec3 &hi)
{
	std::string json =
		"{\"asset\":{\"version\":\"2.0\"},"
		"\"extensionsUsed\":[\"KHR_draco_mesh_compression\"],"
		"\"extensionsRequired\":[\"KHR_draco_mesh_compression\"],"
		"\"scene\":0,\"scenes\":[{\"nodes\":[0]}],"
		"\"nodes\":[{\"mesh\":0}],"
		"\"meshes\":[{\"primitives\":[{\"attributes\":{\"POSITION\":0},"
		"\"indices\":1,\"material\":0,\"mode\":4,"
		"\"extensions\":{\"KHR_draco_mesh_compression\":{\"bufferView\":0,"
		"\"attributes\":{\"POSITION\":" +
		std::to_string(pos_uid) +
		"}}}}]}],"
		"\"materials\":[{\"pbrMetallicRoughness\":{\"baseColorFactor\":"
		"[0.55,0.55,0.55,1.0],\"metallicFactor\":0.0,\"roughnessFactor\":1.0},"
		"\"doubleSided\":true}],"
		"\"accessors\":["
		"{\"componentType\":5126,\"count\":" +
		std::to_string(np) + ",\"type\":\"VEC3\",\"min\":[" + fnum(lo.x) + "," +
		fnum(lo.y) + "," + fnum(lo.z) + "],\"max\":[" + fnum(hi.x) + "," +
		fnum(hi.y) + "," + fnum(hi.z) + "]},"
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

static void make_dirs(const char *path)
{
	char buf[512];
	snprintf(buf, sizeof(buf), "%s", path);
	for (char *p = buf + 1; *p; ++p) {
		if (*p != '/')
			continue;
		*p = 0;
		mkdir(buf, 0755);
		*p = '/';
	}
}

/* {cell_x}.{cell_y}/{level}/{x}.{y}.glb, all three indices relative to the
 * cell_level cell: a 3D Tiles content URI template is expanded with
 * coordinates local to the tile carrying implicitTiling, which is the cell.
 * The global WebMercatorQuad key -- and so the WMTS imagery key -- is
 * cell * 2^level + local, at global level cell_level + level. */
static bool save_glb(const std::vector<char> &buf, const char *out_dir,
					 int cell_x, int cell_y, int local_level, int local_x,
					 int local_y)
{
	if (buf.empty())
		return false;
	char dir[400];
	int base = strlen(out_dir);
	bool slash = base && out_dir[base - 1] == '/';
	snprintf(dir, sizeof(dir), "%s%s%d.%d/%d", out_dir, slash ? "" : "/",
			 cell_x, cell_y, local_level);
	char path[512];
	snprintf(path, sizeof(path), "%s/%d.%d.glb", dir, local_x, local_y);
	make_dirs(path);
	FILE *f = fopen(path, "wb");
	if (!f)
		return false;
	bool ok = fwrite(buf.data(), 1, buf.size(), f) == buf.size();
	fclose(f);
	return ok;
}

int write_lod_level(const TriMesh &mesh, int base_level, int tile_x,
					int tile_y, int z, const char *out_dir, bool verbose)
{
	if (mesh.faces.empty())
		return 0;

	Timer chrono;
	unsigned int t_clip = 0, t_draco = 0, t_save = 0;

	Vec3 lo{0.f, 0.f, 0.f};
	Vec3 hi{1.f, 1.f, 0.f};

	int n = 1 << z;
	int written = 0;
	int level = base_level + z;
	double tile_size = geo_wmq_tile_size(base_level);
	double jx0, jy0, jx1, jy1;
	geo_wmq_tile_bounds(base_level, tile_x, tile_y, jx0, jy0, jx1, jy1);
	int cell_shift = base_level - geo().cell_level;
	int cell_x = tile_x >> cell_shift;
	int cell_y = tile_y >> cell_shift;
	double cx0, cy0, cx1, cy1;
	geo_wmq_tile_bounds(geo().cell_level, cell_x, cell_y, cx0, cy0, cx1, cy1);
	double ox = 0.5 * (cx0 + cx1), oy = 0.5 * (cy0 + cy1);
	std::vector<TriMesh> cells;
	chrono.start();
	clip_grid(mesh, lo, hi, n, cells);
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
				v = Vec3{(float)(jx0 + (double)v.x * tile_size - ox),
						 (float)(jy0 + (double)v.y * tile_size - oy),
						 (float)((double)v.z * tile_size)};
			}
			Vec3 clo, chi;
			aabb(cell, clo, chi);
			for (Vec3 &v : cell.verts)
				v = Vec3{v.x, v.z, -v.y};
			Vec3 glo, ghi;
			aabb(cell, glo, ghi);
			chrono.start();
			uint32_t np = 0, nf = 0, pos_uid = 0;
			std::vector<char> draco = encode_p_draco(cell, np, nf, pos_uid);
			std::vector<char> glb = make_glb(draco, np, nf, pos_uid, glo, ghi);
			t_draco += chrono.stop();
			int tx = tile_x * n + dx;
			int ty = tile_y * n + (n - 1 - dy);
			int local_level = level - geo().cell_level;
			chrono.start();
			bool ok = save_glb(glb, out_dir, cell_x, cell_y, local_level,
							   tx - (cell_x << local_level),
							   ty - (cell_y << local_level));
			t_save += chrono.stop();
			if (ok)
				written++;
		}
	}
	if (verbose)
	{
		unsigned d = 1000;
		printf("  LOD z=%d : %dx%d grid, native poisson -> %d tiles "
			   "(clip %ums draco %ums save %ums)\n",
			   z, n, n, written, t_clip / d, t_draco / d, t_save / d);
	}
	return written;
}