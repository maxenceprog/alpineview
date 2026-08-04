// This file is part of meshoptimizer library; see meshoptimizer.h for
// version/license details
#include "meshoptimizer.h"

#include <assert.h>
#include <float.h>
#include <math.h>
#include <string.h>

#include <stdio.h>

#ifndef TRACE
#define TRACE 1
#endif

#if TRACE
#include <stdio.h>
#endif

#if TRACE
#define TRACESTATS(i) stats[i]++;
#else
#define TRACESTATS(i) (void)0
#endif

// This work is based on:
// Michael Garland and Paul S. Heckbert. Surface simplification using quadric
// error metrics. 1997 Michael Garland. Quadric-based polygonal surface
// simplification. 1999 Peter Lindstrom. Out-of-Core Simplification of Large
// Polygonal Models. 2000 Matthias Teschner, Bruno Heidelberger, Matthias
// Mueller, Danat Pomeranets, Markus Gross. Optimized Spatial Hashing for
// Collision Detection of Deformable Objects. 2003 Peter Van Sandt, Yannis
// Chronis, Jignesh M. Patel. Efficiently Searching In-Memory Sorted Arrays:
// Revenge of the Interpolation Search? 2019
namespace meshopt
{

struct EdgeAdjacency {
	struct Edge {
		unsigned int next;
		unsigned int prev;
	};

	unsigned int *counts;
	unsigned int *offsets;
	Edge *data;
};

static void prepareEdgeAdjacency(EdgeAdjacency &adjacency, size_t indexCount,
				 size_t vertexCount,
				 meshopt_Allocator &allocator)
{
	adjacency.counts = allocator.allocate<unsigned int>(vertexCount);
	adjacency.offsets = allocator.allocate<unsigned int>(vertexCount);
	adjacency.data = allocator.allocate<EdgeAdjacency::Edge>(indexCount);
}

static void updateEdgeAdjacency(EdgeAdjacency &adjacency,
				const unsigned int *indices, size_t indexCount,
				size_t vertexCount, const unsigned int *remap)
{
	size_t faceCount = indexCount / 3;

	// fill edge counts
	memset(adjacency.counts, 0, vertexCount * sizeof(unsigned int));

	for (size_t i = 0; i < indexCount; ++i) {
		unsigned int v = remap ? remap[indices[i]] : indices[i];
		assert(v < vertex_count);

		adjacency.counts[v]++;
	}

	// fill offset table
	unsigned int offset = 0;

	for (size_t i = 0; i < vertexCount; ++i) {
		adjacency.offsets[i] = offset;
		offset += adjacency.counts[i];
	}

	assert(offset == index_count);

	// fill edge data
	for (size_t i = 0; i < faceCount; ++i) {
		unsigned int a = indices[i * 3 + 0], b = indices[i * 3 + 1],
			     c = indices[i * 3 + 2];

		if (remap) {
			a = remap[a];
			b = remap[b];
			c = remap[c];
		}

		adjacency.data[adjacency.offsets[a]].next = b;
		adjacency.data[adjacency.offsets[a]].prev = c;
		adjacency.offsets[a]++;

		adjacency.data[adjacency.offsets[b]].next = c;
		adjacency.data[adjacency.offsets[b]].prev = a;
		adjacency.offsets[b]++;

		adjacency.data[adjacency.offsets[c]].next = a;
		adjacency.data[adjacency.offsets[c]].prev = b;
		adjacency.offsets[c]++;
	}

	// fix offsets that have been disturbed by the previous pass
	for (size_t i = 0; i < vertexCount; ++i) {
		assert(adjacency.offsets[i] >= adjacency.counts[i]);

		adjacency.offsets[i] -= adjacency.counts[i];
	}
}

struct PositionHasher {
	const float *vertex_positions;
	size_t vertex_stride_float;

	size_t hash(unsigned int index) const
	{
		const unsigned int *key =
		    reinterpret_cast<const unsigned int *>(
			vertex_positions + index * vertex_stride_float);

		// scramble bits to make sure that integer coordinates have
		// entropy in lower bits
		unsigned int x = key[0] ^ (key[0] >> 17);
		unsigned int y = key[1] ^ (key[1] >> 17);
		unsigned int z = key[2] ^ (key[2] >> 17);

		// Optimized Spatial Hashing for Collision Detection of
		// Deformable Objects
		return (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
	}

	bool equal(unsigned int lhs, unsigned int rhs) const
	{
		return memcmp(vertex_positions + lhs * vertex_stride_float,
			      vertex_positions + rhs * vertex_stride_float,
			      sizeof(float) * 3) == 0;
	}
};

static size_t hashBuckets2(size_t count)
{
	size_t buckets = 1;
	while (buckets < count + count / 4)
		buckets *= 2;

	return buckets;
}

template <typename T, typename Hash>
static T *hashLookup2(T *table, size_t buckets, const Hash &hash, const T &key,
		      const T &empty)
{
	assert(buckets > 0);
	assert((buckets & (buckets - 1)) == 0);

	size_t hashmod = buckets - 1;
	size_t bucket = hash.hash(key) & hashmod;

	for (size_t probe = 0; probe <= hashmod; ++probe) {
		T &item = table[bucket];

		if (item == empty)
			return &item;

		if (hash.equal(item, key))
			return &item;

		// hash collision, quadratic probing
		bucket = (bucket + probe + 1) & hashmod;
	}

	assert(false && "Hash table is full"); // unreachable
	return 0;
}

static void buildPositionRemap(unsigned int *remap, unsigned int *wedge,
			       const float *vertexPositionsData,
			       size_t vertexCount,
			       size_t vertexPositionsStride,
			       meshopt_Allocator &allocator)
{
	PositionHasher hasher = {vertexPositionsData,
				 vertexPositionsStride / sizeof(float)};

	size_t tableSize = hashBuckets2(vertexCount);
	unsigned int *table = allocator.allocate<unsigned int>(tableSize);
	memset(table, -1, tableSize * sizeof(unsigned int));

	// build forward remap: for each vertex, which other (canonical) vertex
	// does it map to? we use position equivalence for this, and remap
	// vertices to other existing vertices
	for (size_t i = 0; i < vertexCount; ++i) {
		unsigned int index = unsigned(i);
		unsigned int *entry =
		    hashLookup2(table, tableSize, hasher, index, ~0u);

		if (*entry == ~0u)
			*entry = index;

		remap[index] = *entry;
	}

	// build wedge table: for each vertex, which other vertex is the next
	// wedge that also maps to the same vertex? entries in table form a
	// (cyclic) wedge loop per vertex; for manifold vertices, wedge[i] ==
	// remap[i] == i
	for (size_t i = 0; i < vertexCount; ++i)
		wedge[i] = unsigned(i);

	for (size_t i = 0; i < vertexCount; ++i)
		if (remap[i] != i) {
			unsigned int r = remap[i];

			wedge[i] = wedge[r];
			wedge[r] = unsigned(i);
		}
}

enum VertexKind {
	Kind_Manifold, // not on an attribute seam, not on any boundary
	Kind_Border,   // not on an attribute seam, has exactly two open edges
	Kind_Seam, // on an attribute seam with exactly two attribute seam edges
	Kind_Complex, // none of the above; these vertices can move as long as
		      // all wedges move to the target vertex
	Kind_Locked,  // none of the above; these vertices can't move

	Kind_Count
};

// manifold vertices can collapse onto anything
// border/seam vertices can only be collapsed onto border/seam respectively
// complex vertices can collapse onto complex/locked
// a rule of thumb is that collapsing kind A into kind B preserves the kind B in
// the target vertex for example, while we could collapse Complex into Manifold,
// this would mean the target vertex isn't Manifold anymore
const unsigned char K_CAN_COLLAPSE[Kind_Count][Kind_Count] = {
    {1, 1, 1, 1, 1}, {0, 1, 0, 0, 0}, {0, 0, 1, 0, 0},
    {0, 0, 0, 1, 1}, {0, 0, 0, 0, 0},
};

// if a vertex is manifold or seam, adjoining edges are guaranteed to have an
// opposite edge note that for seam edges, the opposite edge isn't present in
// the attribute-based topology but is present if you consider a position-only
// mesh variant
const unsigned char K_HAS_OPPOSITE[Kind_Count][Kind_Count] = {
    {1, 1, 1, 0, 1}, {1, 0, 1, 0, 0}, {1, 1, 1, 0, 1},
    {0, 0, 0, 0, 0}, {1, 0, 1, 0, 0},
};

static bool hasEdge(const EdgeAdjacency &adjacency, unsigned int a,
		    unsigned int b)
{
	unsigned int count = adjacency.counts[a];
	const EdgeAdjacency::Edge *edges =
	    adjacency.data + adjacency.offsets[a];

	for (size_t i = 0; i < count; ++i)
		if (edges[i].next == b)
			return true;

	return false;
}

static void classifyVertices(unsigned char *result, unsigned int *loop,
			     unsigned int *loopback, size_t vertexCount,
			     const EdgeAdjacency &adjacency,
			     const unsigned int *remap,
			     const unsigned int *wedge, unsigned int options)
{
	memset(loop, -1, vertexCount * sizeof(unsigned int));
	memset(loopback, -1, vertexCount * sizeof(unsigned int));

	// incoming & outgoing open edges: ~0u if no open edges, i if there are
	// more than 1 note that this is the same data as required in loop[]
	// arrays; loop[] data is only valid for border/seam but here it's okay
	// to fill the data out for other types of vertices as well
	unsigned int *openinc = loopback;
	unsigned int *openout = loop;

	for (size_t i = 0; i < vertexCount; ++i) {
		unsigned int vertex = unsigned(i);

		unsigned int count = adjacency.counts[vertex];
		const EdgeAdjacency::Edge *edges =
		    adjacency.data + adjacency.offsets[vertex];

		for (size_t j = 0; j < count; ++j) {
			unsigned int target = edges[j].next;

			if (target == vertex) {
				// degenerate triangles have two distinct edges
				// instead of three, and the self edge is
				// bi-directional by definition; this can break
				// border/seam classification by "closing" the
				// open edge from another triangle and falsely
				// marking the vertex as manifold instead we
				// mark the vertex as having >1 open edges which
				// turns it into locked/complex
				openinc[vertex] = openout[vertex] = vertex;
			} else if (!hasEdge(adjacency, target, vertex)) {
				openinc[target] =
				    (openinc[target] == ~0u) ? vertex : target;
				openout[vertex] =
				    (openout[vertex] == ~0u) ? target : vertex;
			}
		}
	}

#if TRACE
	size_t stats[4] = {};
#endif

	for (size_t i = 0; i < vertexCount; ++i) {
		if (remap[i] == i) {
			if (wedge[i] == i) {
				// no attribute seam, need to check if it's
				// manifold
				unsigned int openi = openinc[i],
					     openo = openout[i];

				// note: we classify any vertices with no open
				// edges as manifold this is technically
				// incorrect - if 4 triangles share an edge,
				// we'll classify vertices as manifold it's
				// unclear if this is a problem in practice
				if (openi == ~0u && openo == ~0u) {
					result[i] = Kind_Manifold;
				} else if (openi != i && openo != i) {
					result[i] = Kind_Border;
				} else {
					result[i] = Kind_Locked;
					TRACESTATS(0);
				}
			} else if (wedge[wedge[i]] == i) {
				// attribute seam; need to distinguish between
				// Seam and Locked
				unsigned int w = wedge[i];
				unsigned int openiv = openinc[i],
					     openov = openout[i];
				unsigned int openiw = openinc[w],
					     openow = openout[w];

				// seam should have one open half-edge for each
				// vertex, and the edges need to "connect" -
				// point to the same vertex post-remap
				if (openiv != ~0u && openiv != i &&
				    openov != ~0u && openov != i &&
				    openiw != ~0u && openiw != w &&
				    openow != ~0u && openow != w) {
					if (remap[openiv] == remap[openow] &&
					    remap[openov] == remap[openiw]) {
						result[i] = Kind_Seam;
					} else {
						result[i] = Kind_Locked;
						TRACESTATS(1);
					}
				} else {
					result[i] = Kind_Locked;
					TRACESTATS(2);
				}
			} else {
				// more than one vertex maps to this one; we
				// don't have classification available
				result[i] = Kind_Locked;
				TRACESTATS(3);
			}
		} else {
			assert(remap[i] < i);

			result[i] = result[remap[i]];
		}
	}

	if (options & meshopt_SimplifyLockBorder)
		for (size_t i = 0; i < vertexCount; ++i)
			if (result[i] == Kind_Border)
				result[i] = Kind_Locked;

#if TRACE
	printf("locked: many open edges %d, disconnected seam %d, many seam "
	       "edges %d, many wedges %d\n",
	       int(stats[0]), int(stats[1]), int(stats[2]), int(stats[3]));
#endif
}

struct Vector3 {
	float x, y, z;
};

static float rescalePositions(Vector3 *result,
			      const float *vertexPositionsData,
			      size_t vertexCount,
			      size_t vertexPositionsStride)
{
	size_t vertexStrideFloat = vertexPositionsStride / sizeof(float);

	float minv[3] = {FLT_MAX, FLT_MAX, FLT_MAX};
	float maxv[3] = {-FLT_MAX, -FLT_MAX, -FLT_MAX};

	for (size_t i = 0; i < vertexCount; ++i) {
		const float *v =
		    vertexPositionsData + i * vertexStrideFloat;

		if (result) {
			result[i].x = v[0];
			result[i].y = v[1];
			result[i].z = v[2];
		}

		for (int j = 0; j < 3; ++j) {
			float vj = v[j];

			minv[j] = minv[j] > vj ? vj : minv[j];
			maxv[j] = maxv[j] < vj ? vj : maxv[j];
		}
	}

	float extent = 0.f;

	extent = (maxv[0] - minv[0]) < extent ? extent : (maxv[0] - minv[0]);
	extent = (maxv[1] - minv[1]) < extent ? extent : (maxv[1] - minv[1]);
	extent = (maxv[2] - minv[2]) < extent ? extent : (maxv[2] - minv[2]);

	if (result) {
		float scale = extent == 0 ? 0.f : 1.f / extent;

		for (size_t i = 0; i < vertexCount; ++i) {
			result[i].x = (result[i].x - minv[0]) * scale;
			result[i].y = (result[i].y - minv[1]) * scale;
			result[i].z = (result[i].z - minv[2]) * scale;
		}

		printf("Scale : %e, Min : %e %e %e\n", scale, minv[0], minv[1],
		       minv[2]);
	}

	return extent;
}

struct Quadric {
	float a00, a11, a22;
	float a10, a20, a21;
	float b0, b1, b2, c;
	float w;
};

struct Collapse {
	unsigned int v0;
	unsigned int v1;

	union {
		unsigned int bidi;
		float error;
		unsigned int errorui;
	};
};

static float normalize(Vector3 &v)
{
	float length = sqrtf(v.x * v.x + v.y * v.y + v.z * v.z);

	if (length > 0) {
		v.x /= length;
		v.y /= length;
		v.z /= length;
	}

	return length;
}

static void quadricAdd(Quadric &q, const Quadric &r)
{
	q.a00 += r.a00;
	q.a11 += r.a11;
	q.a22 += r.a22;
	q.a10 += r.a10;
	q.a20 += r.a20;
	q.a21 += r.a21;
	q.b0 += r.b0;
	q.b1 += r.b1;
	q.b2 += r.b2;
	q.c += r.c;
	q.w += r.w;
}

static float quadricError(const Quadric &q, const Vector3 &v)
{
	float rx = q.b0;
	float ry = q.b1;
	float rz = q.b2;

	rx += q.a10 * v.y;
	ry += q.a21 * v.z;
	rz += q.a20 * v.x;

	rx *= 2;
	ry *= 2;
	rz *= 2;

	rx += q.a00 * v.x;
	ry += q.a11 * v.y;
	rz += q.a22 * v.z;

	float r = q.c;
	r += rx * v.x;
	r += ry * v.y;
	r += rz * v.z;

	float s = q.w == 0.f ? 0.f : 1.f / q.w;

	return fabsf(r) * s;
}

static void quadricFromPlane(Quadric &q, float a, float b, float c, float d,
			     float w)
{
	float aw = a * w;
	float bw = b * w;
	float cw = c * w;
	float dw = d * w;

	q.a00 = a * aw;
	q.a11 = b * bw;
	q.a22 = c * cw;
	q.a10 = a * bw;
	q.a20 = a * cw;
	q.a21 = b * cw;
	q.b0 = a * dw;
	q.b1 = b * dw;
	q.b2 = c * dw;
	q.c = d * dw;
	q.w = w;
}

static void quadricFromPoint(Quadric &q, float x, float y, float z, float w)
{
	// we need to encode (x - X) ^ 2 + (y - Y)^2 + (z - Z)^2 into the
	// quadric
	q.a00 = w;
	q.a11 = w;
	q.a22 = w;
	q.a10 = 0.f;
	q.a20 = 0.f;
	q.a21 = 0.f;
	q.b0 = -2.f * x * w;
	q.b1 = -2.f * y * w;
	q.b2 = -2.f * z * w;
	q.c = (x * x + y * y + z * z) * w;
	q.w = w;
}

static void quadricFromTriangle(Quadric &q, const Vector3 &p0,
				const Vector3 &p1, const Vector3 &p2,
				float weight)
{
	Vector3 p10 = {p1.x - p0.x, p1.y - p0.y, p1.z - p0.z};
	Vector3 p20 = {p2.x - p0.x, p2.y - p0.y, p2.z - p0.z};

	// normal = cross(p1 - p0, p2 - p0)
	Vector3 normal = {p10.y * p20.z - p10.z * p20.y,
			  p10.z * p20.x - p10.x * p20.z,
			  p10.x * p20.y - p10.y * p20.x};
	float area = normalize(normal);

	float distance = normal.x * p0.x + normal.y * p0.y + normal.z * p0.z;

	// we use sqrtf(area) so that the error is scaled linearly; this tends
	// to improve silhouettes
	quadricFromPlane(q, normal.x, normal.y, normal.z, -distance,
			 sqrtf(area) * weight);
}

static void quadricFromTriangleEdge(Quadric &q, const Vector3 &p0,
				    const Vector3 &p1, const Vector3 &p2,
				    float weight)
{
	Vector3 p10 = {p1.x - p0.x, p1.y - p0.y, p1.z - p0.z};
	float length = normalize(p10);

	// p20p = length of projection of p2-p0 onto normalize(p1 - p0)
	Vector3 p20 = {p2.x - p0.x, p2.y - p0.y, p2.z - p0.z};
	float p20p = p20.x * p10.x + p20.y * p10.y + p20.z * p10.z;

	// normal = altitude of triangle from point p2 onto edge p1-p0
	Vector3 normal = {p20.x - p10.x * p20p, p20.y - p10.y * p20p,
			  p20.z - p10.z * p20p};
	normalize(normal);

	float distance = normal.x * p0.x + normal.y * p0.y + normal.z * p0.z;

	// note: the weight is scaled linearly with edge length; this has to
	// match the triangle weight
	quadricFromPlane(q, normal.x, normal.y, normal.z, -distance,
			 length * weight);
}

static void fillFaceQuadrics(Quadric *vertexQuadrics,
			     const unsigned int *indices, size_t indexCount,
			     const Vector3 *vertexPositions,
			     const unsigned int *remap)
{
	for (size_t i = 0; i < indexCount; i += 3) {
		unsigned int i0 = indices[i + 0];
		unsigned int i1 = indices[i + 1];
		unsigned int i2 = indices[i + 2];

		Quadric q;
		quadricFromTriangle(q, vertexPositions[i0],
				    vertexPositions[i1], vertexPositions[i2],
				    1.f);

		quadricAdd(vertexQuadrics[remap[i0]], q);
		quadricAdd(vertexQuadrics[remap[i1]], q);
		quadricAdd(vertexQuadrics[remap[i2]], q);
	}
}

static void
fillEdgeQuadrics(Quadric *vertexQuadrics, const unsigned int *indices,
		 size_t indexCount, const Vector3 *vertexPositions,
		 const unsigned int *remap, const unsigned char *vertexKind,
		 const unsigned int *loop, const unsigned int *loopback)
{
	for (size_t i = 0; i < indexCount; i += 3) {
		static const int next[3] = {1, 2, 0};

		for (int e = 0; e < 3; ++e) {
			unsigned int i0 = indices[i + e];
			unsigned int i1 = indices[i + next[e]];

			unsigned char k0 = vertexKind[i0];
			unsigned char k1 = vertexKind[i1];

			// check that either i0 or i1 are border/seam and are on
			// the same edge loop note that we need to add the error
			// even for edged that connect e.g. border & locked if
			// we don't do that, the adjacent border->border edge
			// won't have correct errors for corners
			if (k0 != Kind_Border && k0 != Kind_Seam &&
			    k1 != Kind_Border && k1 != Kind_Seam)
				continue;

			if ((k0 == Kind_Border || k0 == Kind_Seam) &&
			    loop[i0] != i1)
				continue;

			if ((k1 == Kind_Border || k1 == Kind_Seam) &&
			    loopback[i1] != i0)
				continue;

			// seam edges should occur twice (i0->i1 and i1->i0) -
			// skip redundant edges
			if (K_HAS_OPPOSITE[k0][k1] && remap[i1] > remap[i0])
				continue;

			unsigned int i2 = indices[i + next[next[e]]];

			// we try hard to maintain border edge geometry; seam
			// edges can move more freely due to topological
			// restrictions on collapses, seam quadrics slightly
			// improves collapse structure but aren't critical
			const float kEdgeWeightSeam = 1.f;
			const float kEdgeWeightBorder = 10.f;

			float edgeWeight =
			    (k0 == Kind_Border || k1 == Kind_Border)
				? kEdgeWeightBorder
				: kEdgeWeightSeam;

			Quadric q;
			quadricFromTriangleEdge(
			    q, vertexPositions[i0], vertexPositions[i1],
			    vertexPositions[i2], edgeWeight);

			quadricAdd(vertexQuadrics[remap[i0]], q);
			quadricAdd(vertexQuadrics[remap[i1]], q);
		}
	}
}

// does triangle ABC flip when C is replaced with D?
static bool hasTriangleFlip(const Vector3 &a, const Vector3 &b,
			    const Vector3 &c, const Vector3 &d)
{
	Vector3 eb = {b.x - a.x, b.y - a.y, b.z - a.z};
	Vector3 ec = {c.x - a.x, c.y - a.y, c.z - a.z};
	Vector3 ed = {d.x - a.x, d.y - a.y, d.z - a.z};

	Vector3 nbc = {eb.y * ec.z - eb.z * ec.y, eb.z * ec.x - eb.x * ec.z,
		       eb.x * ec.y - eb.y * ec.x};
	Vector3 nbd = {eb.y * ed.z - eb.z * ed.y, eb.z * ed.x - eb.x * ed.z,
		       eb.x * ed.y - eb.y * ed.x};

	return nbc.x * nbd.x + nbc.y * nbd.y + nbc.z * nbd.z < 0;
}

static bool hasTriangleFlips(const EdgeAdjacency &adjacency,
			     const Vector3 *vertexPositions,
			     const unsigned int *collapseRemap,
			     unsigned int i0, unsigned int i1)
{
	assert(collapse_remap[i0] == i0);
	assert(collapse_remap[i1] == i1);

	const Vector3 &v0 = vertexPositions[i0];
	const Vector3 &v1 = vertexPositions[i1];

	const EdgeAdjacency::Edge *edges =
	    &adjacency.data[adjacency.offsets[i0]];
	size_t count = adjacency.counts[i0];

	for (size_t i = 0; i < count; ++i) {
		unsigned int a = collapseRemap[edges[i].next];
		unsigned int b = collapseRemap[edges[i].prev];

		// skip triangles that get collapsed
		// note: this is mathematically redundant as if either of these
		// is true, the dot product in hasTriangleFlip should be 0
		if (a == i1 || b == i1)
			continue;

		// early-out when at least one triangle flips due to a collapse
		if (hasTriangleFlip(vertexPositions[a], vertexPositions[b],
				    v0, v1))
			return true;
	}

	return false;
}

static size_t pickEdgeCollapses(Collapse *collapses,
				const unsigned int *indices, size_t indexCount,
				const unsigned int *remap,
				const unsigned char *vertexKind,
				const unsigned int *loop)
{
	size_t collapseCount = 0;

	for (size_t i = 0; i < indexCount; i += 3) {
		static const int next[3] = {1, 2, 0};

		for (int e = 0; e < 3; ++e) {
			unsigned int i0 = indices[i + e];
			unsigned int i1 = indices[i + next[e]];

			// this can happen either when input has a zero-length
			// edge, or when we perform collapses for complex
			// topology w/seams and collapse a manifold vertex that
			// connects to both wedges onto one of them we leave
			// edges like this alone since they may be important for
			// preserving mesh integrity
			if (remap[i0] == remap[i1])
				continue;

			unsigned char k0 = vertexKind[i0];
			unsigned char k1 = vertexKind[i1];

			// the edge has to be collapsible in at least one
			// direction
			if (!(K_CAN_COLLAPSE[k0][k1] | K_CAN_COLLAPSE[k1][k0]))
				continue;

			// manifold and seam edges should occur twice (i0->i1
			// and i1->i0) - skip redundant edges
			if (K_HAS_OPPOSITE[k0][k1] && remap[i1] > remap[i0])
				continue;

			// two vertices are on a border or a seam, but there's
			// no direct edge between them this indicates that they
			// belong to two different edge loops and we should not
			// collapse this edge loop[] tracks half edges so we
			// only need to check i0->i1
			if (k0 == k1 &&
			    (k0 == Kind_Border || k0 == Kind_Seam) &&
			    loop[i0] != i1)
				continue;

			// edge can be collapsed in either direction - we will
			// pick the one with minimum error note: we evaluate
			// error later during collapse ranking, here we just tag
			// the edge as bidirectional
			if (K_CAN_COLLAPSE[k0][k1] & K_CAN_COLLAPSE[k1][k0]) {
				Collapse c = {i0, i1, {/* bidi= */ 1}};
				collapses[collapseCount++] = c;
			} else {
				// edge can only be collapsed in one direction
				unsigned int e0 =
				    K_CAN_COLLAPSE[k0][k1] ? i0 : i1;
				unsigned int e1 =
				    K_CAN_COLLAPSE[k0][k1] ? i1 : i0;

				Collapse c = {e0, e1, {/* bidi= */ 0}};
				collapses[collapseCount++] = c;
			}
		}
	}

	return collapseCount;
}

static void rankEdgeCollapses(Collapse *collapses, size_t collapseCount,
			      const Vector3 *vertexPositions,
			      const Quadric *vertexQuadrics,
			      const unsigned int *remap)
{
	for (size_t i = 0; i < collapseCount; ++i) {
		Collapse &c = collapses[i];

		unsigned int i0 = c.v0;
		unsigned int i1 = c.v1;

		// most edges are bidirectional which means we need to evaluate
		// errors for two collapses to keep this code branchless we just
		// use the same edge for unidirectional edges
		unsigned int j0 = c.bidi ? i1 : i0;
		unsigned int j1 = c.bidi ? i0 : i1;

		const Quadric &qi = vertexQuadrics[remap[i0]];
		const Quadric &qj = vertexQuadrics[remap[j0]];

		float ei = quadricError(qi, vertexPositions[i1]);
		float ej = quadricError(qj, vertexPositions[j1]);

		// pick edge direction with minimal error
		c.v0 = ei <= ej ? i0 : j0;
		c.v1 = ei <= ej ? i1 : j1;
		c.error = ei <= ej ? ei : ej;
	}
}

#if TRACE > 1
static void dumpEdgeCollapses(const Collapse *collapses, size_t collapse_count,
			      const unsigned char *vertex_kind)
{
	size_t ckinds[Kind_Count][Kind_Count] = {};
	float cerrors[Kind_Count][Kind_Count] = {};

	for (int k0 = 0; k0 < Kind_Count; ++k0)
		for (int k1 = 0; k1 < Kind_Count; ++k1)
			cerrors[k0][k1] = FLT_MAX;

	for (size_t i = 0; i < collapse_count; ++i) {
		unsigned int i0 = collapses[i].v0;
		unsigned int i1 = collapses[i].v1;

		unsigned char k0 = vertex_kind[i0];
		unsigned char k1 = vertex_kind[i1];

		ckinds[k0][k1]++;
		cerrors[k0][k1] = (collapses[i].error < cerrors[k0][k1])
				      ? collapses[i].error
				      : cerrors[k0][k1];
	}

	for (int k0 = 0; k0 < Kind_Count; ++k0)
		for (int k1 = 0; k1 < Kind_Count; ++k1)
			if (ckinds[k0][k1])
				printf("collapses %d -> %d: %d, min error %e\n",
				       k0, k1, int(ckinds[k0][k1]),
				       ckinds[k0][k1] ? sqrtf(cerrors[k0][k1])
						      : 0.f);
}

static void dumpLockedCollapses(const unsigned int *indices, size_t index_count,
				const unsigned char *vertex_kind)
{
	size_t locked_collapses[Kind_Count][Kind_Count] = {};

	for (size_t i = 0; i < index_count; i += 3) {
		static const int next[3] = {1, 2, 0};

		for (int e = 0; e < 3; ++e) {
			unsigned int i0 = indices[i + e];
			unsigned int i1 = indices[i + next[e]];

			unsigned char k0 = vertex_kind[i0];
			unsigned char k1 = vertex_kind[i1];

			locked_collapses[k0][k1] +=
			    !kCanCollapse[k0][k1] && !kCanCollapse[k1][k0];
		}
	}

	for (int k0 = 0; k0 < Kind_Count; ++k0)
		for (int k1 = 0; k1 < Kind_Count; ++k1)
			if (locked_collapses[k0][k1])
				printf("locked collapses %d -> %d: %d\n", k0,
				       k1, int(locked_collapses[k0][k1]));
}
#endif

static void sortEdgeCollapses(unsigned int *sortOrder,
			      const Collapse *collapses, size_t collapseCount)
{
	const int sortBits = 11;

	// fill histogram for counting sort
	unsigned int histogram[1 << sortBits];
	memset(histogram, 0, sizeof(histogram));

	for (size_t i = 0; i < collapseCount; ++i) {
		// skip sign bit since error is non-negative
		unsigned int key =
		    (collapses[i].errorui << 1) >> (32 - sortBits);

		histogram[key]++;
	}

	// compute offsets based on histogram data
	size_t histogramSum = 0;

	for (size_t i = 0; i < 1 << sortBits; ++i) {
		size_t count = histogram[i];
		histogram[i] = unsigned(histogramSum);
		histogramSum += count;
	}

	assert(histogram_sum == collapse_count);

	// compute sort order based on offsets
	for (size_t i = 0; i < collapseCount; ++i) {
		// skip sign bit since error is non-negative
		unsigned int key =
		    (collapses[i].errorui << 1) >> (32 - sortBits);

		sortOrder[histogram[key]++] = unsigned(i);
	}
}

static size_t performEdgeCollapses(
    unsigned int *collapseRemap, unsigned char *collapseLocked,
    Quadric *vertexQuadrics, const Collapse *collapses, size_t collapseCount,
    const unsigned int *collapseOrder, const unsigned int *remap,
    const unsigned int *wedge, const unsigned char *vertexKind,
    const Vector3 *vertexPositions, const EdgeAdjacency &adjacency,
    size_t triangleCollapseGoal, float errorLimit, float &resultError)
{
	size_t edgeCollapses = 0;
	size_t triangleCollapses = 0;

	// most collapses remove 2 triangles; use this to establish a bound on
	// the pass in terms of error limit note that edge_collapse_goal is an
	// estimate; triangle_collapse_goal will be used to actually limit
	// collapses
	size_t edgeCollapseGoal = triangleCollapseGoal / 2;

#if TRACE
	size_t stats[4] = {};
#endif

	for (size_t i = 0; i < collapseCount; ++i) {
		const Collapse &c = collapses[collapseOrder[i]];

		TRACESTATS(0);

		// printf("Collapse error : %g\n", c.error);
		if (c.error > errorLimit)
			break;

		if (triangleCollapses >= triangleCollapseGoal)
			break;

		// we limit the error in each pass based on the error of optimal
		// last collapse; since many collapses will be locked as they
		// will share vertices with other successfull collapses, we need
		// to increase the acceptable error by some factor
		float errorGoal =
		    edgeCollapseGoal < collapseCount
			? 1.5f * collapses[collapseOrder[edgeCollapseGoal]]
				     .error
			: FLT_MAX;

		// on average, each collapse is expected to lock 6 other
		// collapses; to avoid degenerate passes on meshes with odd
		// topology, we only abort if we got over 1/6 collapses
		// accordingly.
		if (c.error > errorGoal &&
		    triangleCollapses > triangleCollapseGoal / 6)
			break;

		unsigned int i0 = c.v0;
		unsigned int i1 = c.v1;

		unsigned int r0 = remap[i0];
		unsigned int r1 = remap[i1];

		// we don't collapse vertices that had source or target vertex
		// involved in a collapse it's important to not move the
		// vertices twice since it complicates the tracking/remapping
		// logic it's important to not move other vertices towards a
		// moved vertex to preserve error since we don't re-rank
		// collapses mid-pass
		if (collapseLocked[r0] | collapseLocked[r1]) {
			TRACESTATS(1);
			continue;
		}

		if (hasTriangleFlips(adjacency, vertexPositions,
				     collapseRemap, r0, r1)) {
			// adjust collapse goal since this collapse is invalid
			// and shouldn't factor into error goal
			edgeCollapseGoal++;

			TRACESTATS(2);
			continue;
		}

		assert(collapse_remap[r0] == r0);
		assert(collapse_remap[r1] == r1);

		quadricAdd(vertexQuadrics[r1], vertexQuadrics[r0]);

		if (vertexKind[i0] == Kind_Complex) {
			unsigned int v = i0;

			do {
				collapseRemap[v] = r1;
				v = wedge[v];
			} while (v != i0);
		} else if (vertexKind[i0] == Kind_Seam) {
			// remap v0 to v1 and seam pair of v0 to seam pair of v1
			unsigned int s0 = wedge[i0];
			unsigned int s1 = wedge[i1];

			assert(s0 != i0 && s1 != i1);
			assert(wedge[s0] == i0 && wedge[s1] == i1);

			collapseRemap[i0] = i1;
			collapseRemap[s0] = s1;
		} else {
			assert(wedge[i0] == i0);

			collapseRemap[i0] = i1;
		}

		collapseLocked[r0] = 1;
		collapseLocked[r1] = 1;

		// border edges collapse 1 triangle, other edges collapse 2 or
		// more
		triangleCollapses += (vertexKind[i0] == Kind_Border) ? 1 : 2;
		edgeCollapses++;

		resultError = resultError < c.error ? c.error : resultError;
	}

#if TRACE
	float errorGoalPerfect =
	    edgeCollapseGoal < collapseCount
		? collapses[collapseOrder[edgeCollapseGoal]].error
		: 0.f;

	printf("removed %d triangles, error %e (goal %e); evaluated %d/%d "
	       "collapses (done %d, skipped %d, invalid %d)\n",
	       int(triangleCollapses), sqrtf(resultError),
	       sqrtf(errorGoalPerfect), int(stats[0]), int(collapseCount),
	       int(edgeCollapses), int(stats[1]), int(stats[2]));
#endif

	return edgeCollapses;
}

static size_t remapIndexBuffer(unsigned int *indices, size_t indexCount,
			       const unsigned int *collapseRemap)
{
	size_t write = 0;

	for (size_t i = 0; i < indexCount; i += 3) {
		unsigned int v0 = collapseRemap[indices[i + 0]];
		unsigned int v1 = collapseRemap[indices[i + 1]];
		unsigned int v2 = collapseRemap[indices[i + 2]];

		// we never move the vertex twice during a single pass
		assert(collapse_remap[v0] == v0);
		assert(collapse_remap[v1] == v1);
		assert(collapse_remap[v2] == v2);

		if (v0 != v1 && v0 != v2 && v1 != v2) {
			indices[write + 0] = v0;
			indices[write + 1] = v1;
			indices[write + 2] = v2;
			write += 3;
		}
	}

	return write;
}

static void remapEdgeLoops(unsigned int *loop, size_t vertexCount,
			   const unsigned int *collapseRemap)
{
	for (size_t i = 0; i < vertexCount; ++i) {
		if (loop[i] != ~0u) {
			unsigned int l = loop[i];
			unsigned int r = collapseRemap[l];

			// i == r is a special case when the seam edge is
			// collapsed in a direction opposite to where loop goes
			loop[i] = (i == r) ? loop[l] : r;
		}
	}
}

struct CellHasher {
	const unsigned int *vertex_ids;

	size_t hash(unsigned int i) const
	{
		unsigned int h = vertex_ids[i];

		// MurmurHash2 finalizer
		h ^= h >> 13;
		h *= 0x5bd1e995;
		h ^= h >> 15;
		return h;
	}

	bool equal(unsigned int lhs, unsigned int rhs) const
	{
		return vertex_ids[lhs] == vertex_ids[rhs];
	}
};

struct IdHasher {
	size_t hash(unsigned int id) const
	{
		unsigned int h = id;

		// MurmurHash2 finalizer
		h ^= h >> 13;
		h *= 0x5bd1e995;
		h ^= h >> 15;
		return h;
	}

	bool equal(unsigned int lhs, unsigned int rhs) const
	{
		return lhs == rhs;
	}
};

struct TriangleHasher {
	const unsigned int *indices;

	size_t hash(unsigned int i) const
	{
		const unsigned int *tri = indices + i * 3;

		// Optimized Spatial Hashing for Collision Detection of
		// Deformable Objects
		return (tri[0] * 73856093) ^ (tri[1] * 19349663) ^
		       (tri[2] * 83492791);
	}

	bool equal(unsigned int lhs, unsigned int rhs) const
	{
		const unsigned int *lt = indices + lhs * 3;
		const unsigned int *rt = indices + rhs * 3;

		return lt[0] == rt[0] && lt[1] == rt[1] && lt[2] == rt[2];
	}
};

static void computeVertexIds(unsigned int *vertexIds,
			     const Vector3 *vertexPositions,
			     size_t vertexCount, int gridSize)
{
	assert(grid_size >= 1 && grid_size <= 1024);
	float cellScale = float(gridSize - 1);

	for (size_t i = 0; i < vertexCount; ++i) {
		const Vector3 &v = vertexPositions[i];

		int xi = int(v.x * cellScale + 0.5f);
		int yi = int(v.y * cellScale + 0.5f);
		int zi = int(v.z * cellScale + 0.5f);

		vertexIds[i] = (xi << 20) | (yi << 10) | zi;
	}
}

static size_t countTriangles(const unsigned int *vertexIds,
			     const unsigned int *indices, size_t indexCount)
{
	size_t result = 0;

	for (size_t i = 0; i < indexCount; i += 3) {
		unsigned int id0 = vertexIds[indices[i + 0]];
		unsigned int id1 = vertexIds[indices[i + 1]];
		unsigned int id2 = vertexIds[indices[i + 2]];

		result += (id0 != id1) & (id0 != id2) & (id1 != id2);
	}

	return result;
}

static size_t fillVertexCells(unsigned int *table, size_t tableSize,
			      unsigned int *vertexCells,
			      const unsigned int *vertexIds,
			      size_t vertexCount)
{
	CellHasher hasher = {vertexIds};

	memset(table, -1, tableSize * sizeof(unsigned int));

	size_t result = 0;

	for (size_t i = 0; i < vertexCount; ++i) {
		unsigned int *entry =
		    hashLookup2(table, tableSize, hasher, unsigned(i), ~0u);

		if (*entry == ~0u) {
			*entry = unsigned(i);
			vertexCells[i] = unsigned(result++);
		} else {
			vertexCells[i] = vertexCells[*entry];
		}
	}

	return result;
}

static size_t countVertexCells(unsigned int *table, size_t tableSize,
			       const unsigned int *vertexIds,
			       size_t vertexCount)
{
	IdHasher hasher;

	memset(table, -1, tableSize * sizeof(unsigned int));

	size_t result = 0;

	for (size_t i = 0; i < vertexCount; ++i) {
		unsigned int id = vertexIds[i];
		unsigned int *entry =
		    hashLookup2(table, tableSize, hasher, id, ~0u);

		result += (*entry == ~0u);
		*entry = id;
	}

	return result;
}

static void fillCellQuadrics(Quadric *cellQuadrics,
			     const unsigned int *indices, size_t indexCount,
			     const Vector3 *vertexPositions,
			     const unsigned int *vertexCells)
{
	for (size_t i = 0; i < indexCount; i += 3) {
		unsigned int i0 = indices[i + 0];
		unsigned int i1 = indices[i + 1];
		unsigned int i2 = indices[i + 2];

		unsigned int c0 = vertexCells[i0];
		unsigned int c1 = vertexCells[i1];
		unsigned int c2 = vertexCells[i2];

		bool singleCell = (c0 == c1) & (c0 == c2);

		Quadric q;
		quadricFromTriangle(q, vertexPositions[i0],
				    vertexPositions[i1], vertexPositions[i2],
				    singleCell ? 3.f : 1.f);

		if (singleCell) {
			quadricAdd(cellQuadrics[c0], q);
		} else {
			quadricAdd(cellQuadrics[c0], q);
			quadricAdd(cellQuadrics[c1], q);
			quadricAdd(cellQuadrics[c2], q);
		}
	}
}

static void fillCellQuadrics(Quadric *cellQuadrics,
			     const Vector3 *vertexPositions,
			     size_t vertexCount,
			     const unsigned int *vertexCells)
{
	for (size_t i = 0; i < vertexCount; ++i) {
		unsigned int c = vertexCells[i];
		const Vector3 &v = vertexPositions[i];

		Quadric q;
		quadricFromPoint(q, v.x, v.y, v.z, 1.f);

		quadricAdd(cellQuadrics[c], q);
	}
}

static void fillCellRemap(unsigned int *cellRemap, float *cellErrors,
			  size_t cellCount, const unsigned int *vertexCells,
			  const Quadric *cellQuadrics,
			  const Vector3 *vertexPositions, size_t vertexCount)
{
	memset(cellRemap, -1, cellCount * sizeof(unsigned int));

	for (size_t i = 0; i < vertexCount; ++i) {
		unsigned int cell = vertexCells[i];
		float error =
		    quadricError(cellQuadrics[cell], vertexPositions[i]);

		if (cellRemap[cell] == ~0u || cellErrors[cell] > error) {
			cellRemap[cell] = unsigned(i);
			cellErrors[cell] = error;
		}
	}
}

static size_t filterTriangles(unsigned int *destination, unsigned int *tritable,
			      size_t tritableSize, const unsigned int *indices,
			      size_t indexCount,
			      const unsigned int *vertexCells,
			      const unsigned int *cellRemap)
{
	TriangleHasher hasher = {destination};

	memset(tritable, -1, tritableSize * sizeof(unsigned int));

	size_t result = 0;

	for (size_t i = 0; i < indexCount; i += 3) {
		unsigned int c0 = vertexCells[indices[i + 0]];
		unsigned int c1 = vertexCells[indices[i + 1]];
		unsigned int c2 = vertexCells[indices[i + 2]];

		if (c0 != c1 && c0 != c2 && c1 != c2) {
			unsigned int a = cellRemap[c0];
			unsigned int b = cellRemap[c1];
			unsigned int c = cellRemap[c2];

			if (b < a && b < c) {
				unsigned int t = a;
				a = b, b = c, c = t;
			} else if (c < a && c < b) {
				unsigned int t = c;
				c = b, b = a, a = t;
			}

			destination[result * 3 + 0] = a;
			destination[result * 3 + 1] = b;
			destination[result * 3 + 2] = c;

			unsigned int *entry =
			    hashLookup2(tritable, tritableSize, hasher,
					unsigned(result), ~0u);

			if (*entry == ~0u)
				*entry = unsigned(result++);
		}
	}

	return result * 3;
}

static float interpolate(float y, float x0, float y0, float x1, float y1,
			 float x2, float y2)
{
	// three point interpolation from "revenge of interpolation search"
	// paper
	float num = (y1 - y) * (x1 - x2) * (x1 - x0) * (y2 - y0);
	float den =
	    (y2 - y) * (x1 - x2) * (y0 - y1) + (y0 - y) * (x1 - x0) * (y1 - y2);
	return x1 + num / den;
}

} // namespace meshopt

#ifndef NDEBUG
// Note: this is only exposed for debug visualization purposes; do *not* use
// these in debug builds
MESHOPTIMIZER_API unsigned char *meshopt_simplifyDebugKind = 0;
MESHOPTIMIZER_API unsigned int *meshopt_simplifyDebugLoop = 0;
MESHOPTIMIZER_API unsigned int *meshopt_simplifyDebugLoopBack = 0;
#endif

size_t meshopt_simplify(unsigned int *destination, const unsigned int *indices,
			size_t indexCount, const float *vertexPositionsData,
			size_t vertexCount, size_t vertexPositionsStride,
			size_t targetIndexCount, float targetError,
			unsigned int options, float *outResultError)
{
	using namespace meshopt;

	assert(index_count % 3 == 0);
	assert(vertex_positions_stride >= 12 && vertex_positions_stride <= 256);
	assert(vertex_positions_stride % sizeof(float) == 0);
	assert(target_index_count <= index_count);
	assert((options & ~(meshopt_SimplifyLockBorder)) == 0);

	meshopt_Allocator allocator;

	unsigned int *result = destination;

	// build adjacency information
	EdgeAdjacency adjacency = {};
	prepareEdgeAdjacency(adjacency, indexCount, vertexCount, allocator);
	updateEdgeAdjacency(adjacency, indices, indexCount, vertexCount,
			    NULL);

	// build position remap that maps each vertex to the one with identical
	// position
	unsigned int *remap = allocator.allocate<unsigned int>(vertexCount);
	unsigned int *wedge = allocator.allocate<unsigned int>(vertexCount);
	buildPositionRemap(remap, wedge, vertexPositionsData, vertexCount,
			   vertexPositionsStride, allocator);

	// classify vertices; vertex kind determines collapse rules, see
	// kCanCollapse
	unsigned char *vertexKind =
	    allocator.allocate<unsigned char>(vertexCount);
	unsigned int *loop = allocator.allocate<unsigned int>(vertexCount);
	unsigned int *loopback = allocator.allocate<unsigned int>(vertexCount);
	classifyVertices(vertexKind, loop, loopback, vertexCount, adjacency,
			 remap, wedge, options);

#if TRACE
	size_t uniquePositions = 0;
	for (size_t i = 0; i < vertexCount; ++i)
		uniquePositions += remap[i] == i;

	printf("position remap: %d vertices => %d positions\n",
	       int(vertexCount), int(uniquePositions));

	size_t kinds[Kind_Count] = {};
	for (size_t i = 0; i < vertexCount; ++i)
		kinds[vertexKind[i]] += remap[i] == i;

	printf(
	    "kinds: manifold %d, border %d, seam %d, complex %d, locked %d\n",
	    int(kinds[Kind_Manifold]), int(kinds[Kind_Border]),
	    int(kinds[Kind_Seam]), int(kinds[Kind_Complex]),
	    int(kinds[Kind_Locked]));
#endif

	Vector3 *vertexPositions = allocator.allocate<Vector3>(vertexCount);
	rescalePositions(vertexPositions, vertexPositionsData, vertexCount,
			 vertexPositionsStride);

	Quadric *vertexQuadrics = allocator.allocate<Quadric>(vertexCount);
	memset(vertexQuadrics, 0, vertexCount * sizeof(Quadric));

	fillFaceQuadrics(vertexQuadrics, indices, indexCount,
			 vertexPositions, remap);
	fillEdgeQuadrics(vertexQuadrics, indices, indexCount,
			 vertexPositions, remap, vertexKind, loop, loopback);

	if (result != indices)
		memcpy(result, indices, indexCount * sizeof(unsigned int));

#if TRACE
	size_t passCount = 0;
#endif

	Collapse *edgeCollapses = allocator.allocate<Collapse>(indexCount);
	unsigned int *collapseOrder =
	    allocator.allocate<unsigned int>(indexCount);
	unsigned int *collapseRemap =
	    allocator.allocate<unsigned int>(vertexCount);
	unsigned char *collapseLocked =
	    allocator.allocate<unsigned char>(vertexCount);

	size_t resultCount = indexCount;
	float resultError = 0;

	// target_error input is linear; we need to adjust it to match
	// quadricError units
	float errorLimit = targetError * targetError;

	while (resultCount > targetIndexCount) {
		// note: throughout the simplification process adjacency
		// structure reflects welded topology for result-in-progress
		updateEdgeAdjacency(adjacency, result, resultCount,
				    vertexCount, remap);

		size_t edgeCollapseCount =
		    pickEdgeCollapses(edgeCollapses, result, resultCount,
				      remap, vertexKind, loop);

		// no edges can be collapsed any more due to topology
		// restrictions
		if (edgeCollapseCount == 0)
			break;

		rankEdgeCollapses(edgeCollapses, edgeCollapseCount,
				  vertexPositions, vertexQuadrics, remap);

#if TRACE > 1
		dumpEdgeCollapses(edge_collapses, edge_collapse_count,
				  vertex_kind);
#endif

		sortEdgeCollapses(collapseOrder, edgeCollapses,
				  edgeCollapseCount);

		size_t triangleCollapseGoal =
		    (resultCount - targetIndexCount) / 3;

		for (size_t i = 0; i < vertexCount; ++i)
			collapseRemap[i] = unsigned(i);

		memset(collapseLocked, 0, vertexCount);

#if TRACE
		printf("pass %d: ", int(passCount++));
#endif

		size_t collapses = performEdgeCollapses(
		    collapseRemap, collapseLocked, vertexQuadrics,
		    edgeCollapses, edgeCollapseCount, collapseOrder, remap,
		    wedge, vertexKind, vertexPositions, adjacency,
		    triangleCollapseGoal, errorLimit, resultError);

		// no edges can be collapsed any more due to hitting the error
		// limit or triangle collapse limit
		if (collapses == 0)
			break;

		remapEdgeLoops(loop, vertexCount, collapseRemap);
		remapEdgeLoops(loopback, vertexCount, collapseRemap);

		size_t newCount =
		    remapIndexBuffer(result, resultCount, collapseRemap);
		assert(new_count < result_count);

		resultCount = newCount;
	}

#if TRACE
	printf("result: %d triangles, error: %e; total %d passes\n",
	       int(resultCount), sqrtf(resultError), int(passCount));
#endif

#if TRACE > 1
	dumpLockedCollapses(result, result_count, vertex_kind);
#endif

#ifndef NDEBUG
	if (meshopt_simplifyDebugKind)
		memcpy(meshopt_simplifyDebugKind, vertex_kind, vertex_count);

	if (meshopt_simplifyDebugLoop)
		memcpy(meshopt_simplifyDebugLoop, loop,
		       vertex_count * sizeof(unsigned int));

	if (meshopt_simplifyDebugLoopBack)
		memcpy(meshopt_simplifyDebugLoopBack, loopback,
		       vertex_count * sizeof(unsigned int));
#endif

	// result_error is quadratic; we need to remap it back to linear
	if (outResultError)
		*outResultError = sqrtf(resultError);

	return resultCount;
}

size_t meshopt_simplifySloppy(unsigned int *destination,
			      const unsigned int *indices, size_t indexCount,
			      const float *vertexPositionsData,
			      size_t vertexCount,
			      size_t vertexPositionsStride,
			      size_t targetIndexCount, float targetError,
			      float *outResultError)
{
	using namespace meshopt;

	assert(index_count % 3 == 0);
	assert(vertex_positions_stride >= 12 && vertex_positions_stride <= 256);
	assert(vertex_positions_stride % sizeof(float) == 0);
	assert(target_index_count <= index_count);

	// we expect to get ~2 triangles/vertex in the output
	size_t targetCellCount = targetIndexCount / 6;

	meshopt_Allocator allocator;

	Vector3 *vertexPositions = allocator.allocate<Vector3>(vertexCount);
	rescalePositions(vertexPositions, vertexPositionsData, vertexCount,
			 vertexPositionsStride);

	// find the optimal grid size using guided binary search
#if TRACE
	printf("source: %d vertices, %d triangles\n", int(vertexCount),
	       int(indexCount / 3));
	printf("target: %d cells, %d triangles\n", int(targetCellCount),
	       int(targetIndexCount / 3));
#endif

	unsigned int *vertexIds =
	    allocator.allocate<unsigned int>(vertexCount);

	const int kInterpolationPasses = 5;

	// invariant: # of triangles in min_grid <= target_count
	int minGrid = int(1.f / (targetError < 1e-3f ? 1e-3f : targetError));
	int maxGrid = 1025;
	size_t minTriangles = 0;
	size_t maxTriangles = indexCount / 3;

	// when we're error-limited, we compute the triangle count for the min.
	// size; this accelerates convergence and provides the correct answer
	// when we can't use a larger grid
	if (minGrid > 1) {
		computeVertexIds(vertexIds, vertexPositions, vertexCount,
				 minGrid);
		minTriangles =
		    countTriangles(vertexIds, indices, indexCount);
	}

	// instead of starting in the middle, let's guess as to what the answer
	// might be! triangle count usually grows as a square of grid size...
	int nextGridSize = int(sqrtf(float(targetCellCount)) + 0.5f);

	for (int pass = 0; pass < 10 + kInterpolationPasses; ++pass) {
		if (minTriangles >= targetIndexCount / 3 ||
		    maxGrid - minGrid <= 1)
			break;

		// we clamp the prediction of the grid size to make sure that
		// the search converges
		int gridSize = nextGridSize;
		gridSize = (gridSize <= minGrid)   ? minGrid + 1
			    : (gridSize >= maxGrid) ? maxGrid - 1
						      : gridSize;

		computeVertexIds(vertexIds, vertexPositions, vertexCount,
				 gridSize);
		size_t triangles =
		    countTriangles(vertexIds, indices, indexCount);

#if TRACE
		printf("pass %d (%s): grid size %d, triangles %d, %s\n", pass,
		       (pass == 0)			? "guess"
		       : (pass <= kInterpolationPasses) ? "lerp"
							: "binary",
		       gridSize, int(triangles),
		       (triangles <= targetIndexCount / 3) ? "under"
							     : "over");
#endif

		float tip = interpolate(float(targetIndexCount / 3),
					float(minGrid), float(minTriangles),
					float(gridSize), float(triangles),
					float(maxGrid), float(maxTriangles));

		if (triangles <= targetIndexCount / 3) {
			minGrid = gridSize;
			minTriangles = triangles;
		} else {
			maxGrid = gridSize;
			maxTriangles = triangles;
		}

		// we start by using interpolation search - it usually converges
		// faster however, interpolation search has a worst case of O(N)
		// so we switch to binary search after a few iterations which
		// converges in O(logN)
		nextGridSize = (pass < kInterpolationPasses)
				     ? int(tip + 0.5f)
				     : (minGrid + maxGrid) / 2;
	}

	if (minTriangles == 0) {
		if (outResultError)
			*outResultError = 1.f;

		return 0;
	}

	// build vertex->cell association by mapping all vertices with the same
	// quantized position to the same cell
	size_t tableSize = hashBuckets2(vertexCount);
	unsigned int *table = allocator.allocate<unsigned int>(tableSize);

	unsigned int *vertexCells =
	    allocator.allocate<unsigned int>(vertexCount);

	computeVertexIds(vertexIds, vertexPositions, vertexCount, minGrid);
	size_t cellCount = fillVertexCells(table, tableSize, vertexCells,
					    vertexIds, vertexCount);

	// build a quadric for each target cell
	Quadric *cellQuadrics = allocator.allocate<Quadric>(cellCount);
	memset(cellQuadrics, 0, cellCount * sizeof(Quadric));

	fillCellQuadrics(cellQuadrics, indices, indexCount, vertexPositions,
			 vertexCells);

	// for each target cell, find the vertex with the minimal error
	unsigned int *cellRemap = allocator.allocate<unsigned int>(cellCount);
	float *cellErrors = allocator.allocate<float>(cellCount);

	fillCellRemap(cellRemap, cellErrors, cellCount, vertexCells,
		      cellQuadrics, vertexPositions, vertexCount);

	// compute error
	float resultError = 0.f;

	for (size_t i = 0; i < cellCount; ++i)
		resultError = resultError < cellErrors[i] ? cellErrors[i]
							     : resultError;

	// collapse triangles!
	// note that we need to filter out triangles that we've already output
	// because we very frequently generate redundant triangles between cells
	// :(
	size_t tritableSize = hashBuckets2(minTriangles);
	unsigned int *tritable =
	    allocator.allocate<unsigned int>(tritableSize);

	size_t write =
	    filterTriangles(destination, tritable, tritableSize, indices,
			    indexCount, vertexCells, cellRemap);

#if TRACE
	printf("result: %d cells, %d triangles (%d unfiltered), error %e\n",
	       int(cellCount), int(write / 3), int(minTriangles),
	       sqrtf(resultError));
#endif

	if (outResultError)
		*outResultError = sqrtf(resultError);

	return write;
}

size_t meshopt_simplifyPoints(unsigned int *destination,
			      const float *vertexPositionsData,
			      size_t vertexCount,
			      size_t vertexPositionsStride,
			      size_t targetVertexCount)
{
	using namespace meshopt;

	assert(vertex_positions_stride >= 12 && vertex_positions_stride <= 256);
	assert(vertex_positions_stride % sizeof(float) == 0);
	assert(target_vertex_count <= vertex_count);

	size_t targetCellCount = targetVertexCount;

	if (targetCellCount == 0)
		return 0;

	meshopt_Allocator allocator;

	Vector3 *vertexPositions = allocator.allocate<Vector3>(vertexCount);
	rescalePositions(vertexPositions, vertexPositionsData, vertexCount,
			 vertexPositionsStride);

	// find the optimal grid size using guided binary search
#if TRACE
	printf("source: %d vertices\n", int(vertexCount));
	printf("target: %d cells\n", int(targetCellCount));
#endif

	unsigned int *vertexIds =
	    allocator.allocate<unsigned int>(vertexCount);

	size_t tableSize = hashBuckets2(vertexCount);
	unsigned int *table = allocator.allocate<unsigned int>(tableSize);

	const int kInterpolationPasses = 5;

	// invariant: # of vertices in min_grid <= target_count
	int minGrid = 0;
	int maxGrid = 1025;
	size_t minVertices = 0;
	size_t maxVertices = vertexCount;

	// instead of starting in the middle, let's guess as to what the answer
	// might be! triangle count usually grows as a square of grid size...
	int nextGridSize = int(sqrtf(float(targetCellCount)) + 0.5f);

	for (int pass = 0; pass < 10 + kInterpolationPasses; ++pass) {
		assert(min_vertices < target_vertex_count);
		assert(max_grid - min_grid > 1);

		// we clamp the prediction of the grid size to make sure that
		// the search converges
		int gridSize = nextGridSize;
		gridSize = (gridSize <= minGrid)   ? minGrid + 1
			    : (gridSize >= maxGrid) ? maxGrid - 1
						      : gridSize;

		computeVertexIds(vertexIds, vertexPositions, vertexCount,
				 gridSize);
		size_t vertices = countVertexCells(table, tableSize,
						   vertexIds, vertexCount);

#if TRACE
		printf("pass %d (%s): grid size %d, vertices %d, %s\n", pass,
		       (pass == 0)			? "guess"
		       : (pass <= kInterpolationPasses) ? "lerp"
							: "binary",
		       gridSize, int(vertices),
		       (vertices <= targetVertexCount) ? "under" : "over");
#endif

		float tip = interpolate(float(targetVertexCount),
					float(minGrid), float(minVertices),
					float(gridSize), float(vertices),
					float(maxGrid), float(maxVertices));

		if (vertices <= targetVertexCount) {
			minGrid = gridSize;
			minVertices = vertices;
		} else {
			maxGrid = gridSize;
			maxVertices = vertices;
		}

		if (vertices == targetVertexCount || maxGrid - minGrid <= 1)
			break;

		// we start by using interpolation search - it usually converges
		// faster however, interpolation search has a worst case of O(N)
		// so we switch to binary search after a few iterations which
		// converges in O(logN)
		nextGridSize = (pass < kInterpolationPasses)
				     ? int(tip + 0.5f)
				     : (minGrid + maxGrid) / 2;
	}

	if (minVertices == 0)
		return 0;

	// build vertex->cell association by mapping all vertices with the same
	// quantized position to the same cell
	unsigned int *vertexCells =
	    allocator.allocate<unsigned int>(vertexCount);

	computeVertexIds(vertexIds, vertexPositions, vertexCount, minGrid);
	size_t cellCount = fillVertexCells(table, tableSize, vertexCells,
					    vertexIds, vertexCount);

	// build a quadric for each target cell
	Quadric *cellQuadrics = allocator.allocate<Quadric>(cellCount);
	memset(cellQuadrics, 0, cellCount * sizeof(Quadric));

	fillCellQuadrics(cellQuadrics, vertexPositions, vertexCount,
			 vertexCells);

	// for each target cell, find the vertex with the minimal error
	unsigned int *cellRemap = allocator.allocate<unsigned int>(cellCount);
	float *cellErrors = allocator.allocate<float>(cellCount);

	fillCellRemap(cellRemap, cellErrors, cellCount, vertexCells,
		      cellQuadrics, vertexPositions, vertexCount);

	// copy results to the output
	assert(cell_count <= target_vertex_count);
	memcpy(destination, cellRemap, sizeof(unsigned int) * cellCount);

#if TRACE
	printf("result: %d cells\n", int(cellCount));
#endif

	return cellCount;
}

float meshopt_simplifyScale(const float *vertexPositions, size_t vertexCount,
			    size_t vertexPositionsStride)
{
	using namespace meshopt;

	assert(vertex_positions_stride >= 12 && vertex_positions_stride <= 256);
	assert(vertex_positions_stride % sizeof(float) == 0);

	float extent = rescalePositions(NULL, vertexPositions, vertexCount,
					vertexPositionsStride);

	return extent;
}
