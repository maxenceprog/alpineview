#ifdef DEBUG
#include <stdio.h>
#endif
#include <string.h>

/* For reading fast */
#include "miniply/miniply.h"

/* For writing */
#include <fstream>
#define TINYPLY_IMPLEMENTATION
#include "tinyply/tinyply.h"

#include "mesh.h"
#include "mesh_ply.h"

int load_ply(TriMesh &mesh, const char *fname, bool withNormals) {

	using namespace miniply;
	PLYReader reader(fname);
	if (!reader.valid()) {
		return (EXIT_FAILURE);
	}

	bool gotVerts = false;
	bool gotFaces = false;

	while (reader.has_element() && (!gotVerts || !gotFaces)) {
		if (reader.element_is(kPLYVertexElement)) {

			reader.load_element();
			uint32_t vertexCount = reader.num_rows();

			uint32_t posIdx[3];
			if (!reader.find_pos(posIdx)) {
				return (EXIT_FAILURE);
			}
			mesh.verts.resize(vertexCount);
			reader.extract_properties(posIdx, 3, PLYPropertyType::Float,
									  mesh.verts.data());

			uint32_t nmlIdx[3];
			if (withNormals && reader.find_normal(nmlIdx)) {
				mesh.normals.resize(vertexCount);
				reader.extract_properties(nmlIdx, 3, PLYPropertyType::Float,
										  mesh.normals.data());
			}
			gotVerts = true;
		} else if (reader.element_is(kPLYFaceElement)) {
			uint32_t idx[1];
			reader.load_element();
			reader.find_indices(idx);
			bool polys = reader.requires_triangulation(idx[0]);
			if (polys && !gotVerts) {
				fprintf(stderr, "PLY read error in %s: need vertex \
					positions to triangulate faces.\n",
						fname);
				break;
			}
			uint32_t indexCount;
			if (polys) {
				indexCount = reader.num_triangles(idx[0]) * 3;
				mesh.faces.resize(indexCount);
				reader.extract_triangles(
					idx[0], (const float *)mesh.verts.data(), mesh.verts.size(),
					PLYPropertyType::Int, mesh.faces.data());
			} else {
				indexCount = reader.num_rows() * 3;
				mesh.faces.resize(indexCount);
				reader.extract_list_property(idx[0], PLYPropertyType::Int,
											 mesh.faces.data());
			}
			gotFaces = true;
		}
		if (gotVerts && gotFaces) {
			break;
		}
		reader.next_element();
	}

	if (!gotVerts) {
		return (EXIT_FAILURE);
	}

	return (EXIT_SUCCESS);
}

int write_ply(const char *fname, const TriMesh &mesh) {
	std::filebuf fbuf;

	fbuf.open(fname, std::ios::out | std::ios::binary);

	std::ostream osb(&fbuf);
	tinyply::PlyFile ply;

	if (!mesh.verts.empty()) {
		ply.add_properties_to_element(
			"vertex", {"x", "y", "z"}, tinyply::Type::FLOAT32,
			mesh.verts.size(),
			reinterpret_cast<const uint8_t *>(mesh.verts.data()),
			tinyply::Type::INVALID, 0);
	}
	if (!mesh.normals.empty()) {
		ply.add_properties_to_element(
			"vertex", {"nx", "ny", "nz"}, tinyply::Type::FLOAT32,
			mesh.normals.size(),
			reinterpret_cast<const uint8_t *>(mesh.normals.data()),
			tinyply::Type::INVALID, 0);
	}
	if (!mesh.faces.empty()) {
		ply.add_properties_to_element(
			"face", {"vertex_indices"}, tinyply::Type::UINT32,
			mesh.faces.size() / 3,
			reinterpret_cast<const uint8_t *>(mesh.faces.data()),
			tinyply::Type::UINT8, 3);
	}

	ply.write(osb, true);

	fbuf.close();
	return (0);
}
