#include <stdint.h>
#include <string.h>

#include <stdexcept>
#include <string>
#include <vector>

#include "copc-lib/geometry/box.hpp"
#include "copc-lib/hierarchy/node.hpp"
#include "copc-lib/io/copc_reader.hpp"

#include "aabb.h"

#include "copc.h"

/* COPC reading backed by copc-lib (RockRobotic), replacing the previous
 * hand-rolled octree/LAZ reader. The public interface in copc.h is unchanged:
 * set_target_bbox collects the octree nodes ("cells") overlapping the query
 * box, and read_cell returns one node's points as raw LAS point records (the
 * exact byte layout las_read_point expects). */
struct CopcReader {
	copc::FileReader reader;
	std::vector<copc::Node> cells;
	int point_size;

	explicit CopcReader(const char *path)
	    : reader(std::string(path)),
	      point_size(reader.CopcConfig().LasHeader().PointRecordLength())
	{
	}
};

static copc::Box to_box(const TAabb<double> &b)
{
	return copc::Box(b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z);
}

CopcReader *copc_init(const char *filename)
{
	try {
		return new CopcReader(filename);
	} catch (const std::exception &) {
		return nullptr;
	}
}

void copc_fini(CopcReader *copc) { delete copc; }

uint32_t copc_set_target_bbox(CopcReader *copc, const TAabb<double> &box,
			      double resolution)
{
	copc->cells = copc->reader.GetNodesIntersectBox(to_box(box), resolution);
	return (uint32_t)copc->cells.size();
}

int copc_cell_point_count(CopcReader *copc, uint32_t cell_idx)
{
	if (cell_idx < copc->cells.size())
		return copc->cells[cell_idx].point_count;
	return 0;
}

int copc_read_cell(CopcReader *copc, uint32_t cell_idx, char *dst)
{
	if (cell_idx >= copc->cells.size())
		return -1;
	std::vector<char> data = copc->reader.GetPointData(copc->cells[cell_idx]);
	memcpy(dst, data.data(), data.size());
	return 0;
}

uint32_t copc_bound_inside(CopcReader *copc, const TAabb<double> &box)
{
	std::vector<copc::Node> nodes =
	    copc->reader.GetNodesIntersectBox(to_box(box));
	uint32_t count = 0;
	for (const copc::Node &node : nodes)
		count += node.point_count;
	return count;
}

uint32_t copc_load_inside(CopcReader *copc, const TAabb<double> &box, char *buf)
{
	std::vector<copc::Node> nodes =
	    copc->reader.GetNodesIntersectBox(to_box(box));
	uint32_t count = 0;
	for (const copc::Node &node : nodes) {
		std::vector<char> data = copc->reader.GetPointData(node);
		memcpy(buf + (size_t)count * copc->point_size, data.data(),
		       data.size());
		count += node.point_count;
	}
	return count;
}
