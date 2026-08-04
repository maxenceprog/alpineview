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

static void aabb(const TriMesh &m, Vec3 &lo, Vec3 &hi) {
	lo = Vec3{1e30f, 1e30f, 1e30f};
	hi = Vec3{-1e30f, -1e30f, -1e30f};
	for (const Vec3 &v : m.verts) {
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
static void splitRange(TriMesh &m, int axis, float base, float step, int i0,
					   int i1, std::vector<TriMesh> &out) {
	if (i1 - i0 == 1) {
		out[i0] = std::move(m);
		return;
	}
	int mid = (i0 + i1) / 2;
	TriMesh loPart, hiPart;
	split_mesh(m, axis, base + mid * step, &loPart, &hiPart);
	m = TriMesh();
	splitRange(loPart, axis, base, step, i0, mid, out);
	splitRange(hiPart, axis, base, step, mid, i1, out);
}

/* Cut m into the n x n cell grid of [lo, hi]; cells[dy * n + dx] is the
 * (dx, dy)-th cell, dy increasing with y. */
static void clipGrid(const TriMesh &m, const Vec3 &lo, const Vec3 &hi, int n,
					 std::vector<TriMesh> &cells) {
	cells.assign((size_t)n * n, TriMesh());
	std::vector<TriMesh> cols(n), colCells(n);
	TriMesh work = m;
	splitRange(work, 0, lo.x, (hi.x - lo.x) / n, 0, n, cols);
	for (int dx = 0; dx < n; ++dx) {
		splitRange(cols[dx], 1, lo.y, (hi.y - lo.y) / n, 0, n, colCells);
		for (int dy = 0; dy < n; ++dy)
			cells[(size_t)dy * n + dx] = std::move(colCells[dy]);
	}
}

/******************************************************************************
 * glTF (Draco) + 3D Tiles output
 ******************************************************************************/

static std::vector<char> encodePDraco(TriMesh &m, uint32_t &numPoints,
									  uint32_t &numFaces, uint32_t &posUid) {
	size_t ntri = m.faces.size() / 3;
	if (ntri == 0)
		return {};

	draco::TriangleSoupMeshBuilder builder;
	builder.Start(ntri);
	const int posAtt = builder.AddAttribute(draco::GeometryAttribute::POSITION,
											3, draco::DT_FLOAT32);

	for (size_t f = 0; f < ntri; ++f) {
		float p[3][3];
		for (int t = 0; t < 3; ++t) {
			const Vec3 &v = m.verts[m.faces[3 * f + t]];
			p[t][0] = v.x;
			p[t][1] = v.y;
			p[t][2] = v.z;
		}
		builder.SetAttributeValuesForFace(posAtt, draco::FaceIndex(f), p[0],
										  p[1], p[2]);
	}

	std::unique_ptr<draco::Mesh> mesh = builder.Finalize();
	if (!mesh)
		return {};

	numPoints = mesh->num_points();
	numFaces = mesh->num_faces();
	posUid = mesh->attribute(posAtt)->unique_id();

	draco::Encoder encoder;
	encoder.SetAttributeQuantization(draco::GeometryAttribute::POSITION,
									 DRACO_QUANT_BITS);
	encoder.SetSpeedOptions(DRACO_SPEED, DRACO_SPEED);

	draco::EncoderBuffer buf;
	if (!encoder.EncodeMeshToBuffer(*mesh, &buf).ok())
		return {};
	return std::vector<char>(buf.data(), buf.data() + buf.size());
}

static std::string fnum(double v) {
	char b[64];
	snprintf(b, sizeof(b), "%.9g", v);
	return std::string(b);
}

static void putU32(std::vector<char> &v, uint32_t x) {
	v.push_back((char)(x & 0xff));
	v.push_back((char)((x >> 8) & 0xff));
	v.push_back((char)((x >> 16) & 0xff));
	v.push_back((char)((x >> 24) & 0xff));
}

static std::vector<char> makeGlb(const std::vector<char> &draco, uint32_t np,
								 uint32_t nf, uint32_t posUid, const Vec3 &lo,
								 const Vec3 &hi) {
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
		std::to_string(posUid) +
		"}}}}]}],"
		"\"materials\":[{\"pbrMetallicRoughness\":{\"baseColorFactor\":"
		"[0.55,0.55,0.55,1.0],\"metallicFactor\":0.0,\"roughnessFactor\":1.0},"
		"\"doubleSided\":true}],"
		"\"accessors\":["
		"{\"componentType\":5126,\"count\":" +
		std::to_string(np) + ",\"type\":\"VEC3\",\"min\":[" + fnum(lo.x) + "," +
		fnum(lo.y) + "," + fnum(lo.z) + "],\"max\":[" + fnum(hi.x) + "," +
		fnum(hi.y) + "," + fnum(hi.z) +
		"]},"
		"{\"componentType\":5125,\"count\":" +
		std::to_string(nf * 3) +
		",\"type\":\"SCALAR\"}],"
		"\"bufferViews\":[{\"buffer\":0,\"byteOffset\":0,\"byteLength\":" +
		std::to_string(draco.size()) +
		"}],"
		"\"buffers\":[{\"byteLength\":" +
		std::to_string(draco.size()) + "}]}";

	while (json.size() % 4 != 0)
		json.push_back(' ');
	std::vector<char> bin(draco);
	while (bin.size() % 4 != 0)
		bin.push_back(0);

	std::vector<char> glb;
	uint32_t total = 12 + 8 + json.size() + 8 + bin.size();
	putU32(glb, 0x46546C67);
	putU32(glb, 2);
	putU32(glb, total);
	putU32(glb, json.size());
	putU32(glb, 0x4E4F534A);
	glb.insert(glb.end(), json.begin(), json.end());
	putU32(glb, bin.size());
	putU32(glb, 0x004E4942);
	glb.insert(glb.end(), bin.begin(), bin.end());
	return glb;
}

static void makeDirs(const char *path) {
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
static bool saveGlb(const std::vector<char> &buf, const char *outDir, int cellX,
					int cellY, int localLevel, int localX, int localY) {
	if (buf.empty())
		return false;
	char dir[400];
	int base = strlen(outDir);
	bool slash = base && outDir[base - 1] == '/';
	snprintf(dir, sizeof(dir), "%s%s%d.%d/%d", outDir, slash ? "" : "/", cellX,
			 cellY, localLevel);
	char path[512];
	snprintf(path, sizeof(path), "%s/%d.%d.glb", dir, localX, localY);
	char tmpPath[520];
	snprintf(tmpPath, sizeof(tmpPath), "%s.tmp", path);
	makeDirs(path);
	FILE *f = fopen(tmpPath, "wb");
	if (!f)
		return false;
	bool ok = fwrite(buf.data(), 1, buf.size(), f) == buf.size();
	fclose(f);
	if (ok)
		ok = rename(tmpPath, path) == 0;
	if (!ok)
		remove(tmpPath);
	return ok;
}

int write_lod_level(const TriMesh &mesh, int baseLevel, int tileX, int tileY,
					int z, const char *outDir, bool verbose) {
	if (mesh.faces.empty())
		return 0;

	Timer chrono;
	unsigned int tClip = 0, tDraco = 0, tSave = 0;

	Vec3 lo{0.f, 0.f, 0.f};
	Vec3 hi{1.f, 1.f, 0.f};

	int n = 1 << z;
	int written = 0;
	int level = baseLevel + z;
	double tileSize = geo_wmq_tile_size(baseLevel);
	double jx0, jy0, jx1, jy1;
	geo_wmq_tile_bounds(baseLevel, tileX, tileY, jx0, jy0, jx1, jy1);
	int cellShift = baseLevel - geo().cell_level;
	int cellX = tileX >> cellShift;
	int cellY = tileY >> cellShift;
	double cx0, cy0, cx1, cy1;
	geo_wmq_tile_bounds(geo().cell_level, cellX, cellY, cx0, cy0, cx1, cy1);
	double ox = 0.5 * (cx0 + cx1), oy = 0.5 * (cy0 + cy1);
	std::vector<TriMesh> cells;
	chrono.start();
	clipGrid(mesh, lo, hi, n, cells);
	tClip = chrono.stop();
	for (int dy = 0; dy < n; ++dy) {
		for (int dx = 0; dx < n; ++dx) {
			TriMesh cell = std::move(cells[(size_t)dy * n + dx]);
			if (cell.faces.empty())
				continue;
			for (Vec3 &v : cell.verts) {
				v = Vec3{(float)(jx0 + (double)v.x * tileSize - ox),
						 (float)(jy0 + (double)v.y * tileSize - oy),
						 (float)((double)v.z * tileSize)};
			}
			Vec3 clo, chi;
			aabb(cell, clo, chi);
			for (Vec3 &v : cell.verts)
				v = Vec3{v.x, v.z, -v.y};
			Vec3 glo, ghi;
			aabb(cell, glo, ghi);
			chrono.start();
			uint32_t np = 0, nf = 0, posUid = 0;
			std::vector<char> draco = encodePDraco(cell, np, nf, posUid);
			std::vector<char> glb = makeGlb(draco, np, nf, posUid, glo, ghi);
			tDraco += chrono.stop();
			int tx = tileX * n + dx;
			int ty = tileY * n + (n - 1 - dy);
			int localLevel = level - geo().cell_level;
			chrono.start();
			bool ok =
				saveGlb(glb, outDir, cellX, cellY, localLevel,
						tx - (cellX << localLevel), ty - (cellY << localLevel));
			tSave += chrono.stop();
			if (ok)
				written++;
		}
	}
	if (verbose) {
		unsigned d = 1000;
		printf("  LOD z=%d : %dx%d grid, native poisson -> %d tiles "
			   "(clip %ums draco %ums save %ums)\n",
			   z, n, n, written, tClip / d, tDraco / d, tSave / d);
	}
	return written;
}