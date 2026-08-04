// This file is part of meshoptimizer library; see meshoptimizer.h for version/license details
#include "meshoptimizer.h"

#include <assert.h>
#include <string.h>

// This work is based on:
// Tom Forsyth. Linear-Speed Vertex Cache Optimisation. 2006
// Pedro Sander, Diego Nehab and Joshua Barczak. Fast Triangle Reordering for Vertex Locality and Reduced Overdraw. 2007
namespace meshopt
{

const size_t K_CACHE_SIZE_MAX = 16;
const size_t K_VALENCE_MAX = 8;

struct VertexScoreTable
{
	float cache[1 + K_CACHE_SIZE_MAX];
	float live[1 + K_VALENCE_MAX];
};

// Tuned to minimize the ACMR of a GPU that has a cache profile similar to NVidia and AMD
static const VertexScoreTable K_VERTEX_SCORE_TABLE = {
    {0.f, 0.779f, 0.791f, 0.789f, 0.981f, 0.843f, 0.726f, 0.847f, 0.882f, 0.867f, 0.799f, 0.642f, 0.613f, 0.600f, 0.568f, 0.372f, 0.234f},
    {0.f, 0.995f, 0.713f, 0.450f, 0.404f, 0.059f, 0.005f, 0.147f, 0.006f},
};

// Tuned to minimize the encoded index buffer size
static const VertexScoreTable K_VERTEX_SCORE_TABLE_STRIP = {
    {0.f, 1.000f, 1.000f, 1.000f, 0.453f, 0.561f, 0.490f, 0.459f, 0.179f, 0.526f, 0.000f, 0.227f, 0.184f, 0.490f, 0.112f, 0.050f, 0.131f},
    {0.f, 0.956f, 0.786f, 0.577f, 0.558f, 0.618f, 0.549f, 0.499f, 0.489f},
};

struct TriangleAdjacency
{
	unsigned int* counts;
	unsigned int* offsets;
	unsigned int* data;
};

static void buildTriangleAdjacency(TriangleAdjacency& adjacency, const unsigned int* indices, size_t indexCount, size_t vertexCount, meshopt_Allocator& allocator)
{
	size_t faceCount = indexCount / 3;

	// allocate arrays
	adjacency.counts = allocator.allocate<unsigned int>(vertexCount);
	adjacency.offsets = allocator.allocate<unsigned int>(vertexCount);
	adjacency.data = allocator.allocate<unsigned int>(indexCount);

	// fill triangle counts
	memset(adjacency.counts, 0, vertexCount * sizeof(unsigned int));

	for (size_t i = 0; i < indexCount; ++i)
	{
		assert(indices[i] < vertex_count);

		adjacency.counts[indices[i]]++;
	}

	// fill offset table
	unsigned int offset = 0;

	for (size_t i = 0; i < vertexCount; ++i)
	{
		adjacency.offsets[i] = offset;
		offset += adjacency.counts[i];
	}

	assert(offset == index_count);

	// fill triangle data
	for (size_t i = 0; i < faceCount; ++i)
	{
		unsigned int a = indices[i * 3 + 0], b = indices[i * 3 + 1], c = indices[i * 3 + 2];

		adjacency.data[adjacency.offsets[a]++] = unsigned(i);
		adjacency.data[adjacency.offsets[b]++] = unsigned(i);
		adjacency.data[adjacency.offsets[c]++] = unsigned(i);
	}

	// fix offsets that have been disturbed by the previous pass
	for (size_t i = 0; i < vertexCount; ++i)
	{
		assert(adjacency.offsets[i] >= adjacency.counts[i]);

		adjacency.offsets[i] -= adjacency.counts[i];
	}
}

static unsigned int getNextVertexDeadEnd(const unsigned int* deadEnd, unsigned int& deadEndTop, unsigned int& inputCursor, const unsigned int* liveTriangles, size_t vertexCount)
{
	// check dead-end stack
	while (deadEndTop)
	{
		unsigned int vertex = deadEnd[--deadEndTop];

		if (liveTriangles[vertex] > 0)
			return vertex;
	}

	// input order
	while (inputCursor < vertexCount)
	{
		if (liveTriangles[inputCursor] > 0)
			return inputCursor;

		++inputCursor;
	}

	return ~0u;
}

static unsigned int getNextVertexNeighbor(const unsigned int* nextCandidatesBegin, const unsigned int* nextCandidatesEnd, const unsigned int* liveTriangles, const unsigned int* cacheTimestamps, unsigned int timestamp, unsigned int cacheSize)
{
	unsigned int bestCandidate = ~0u;
	int bestPriority = -1;

	for (const unsigned int* nextCandidate = nextCandidatesBegin; nextCandidate != nextCandidatesEnd; ++nextCandidate)
	{
		unsigned int vertex = *nextCandidate;

		// otherwise we don't need to process it
		if (liveTriangles[vertex] > 0)
		{
			int priority = 0;

			// will it be in cache after fanning?
			if (2 * liveTriangles[vertex] + timestamp - cacheTimestamps[vertex] <= cacheSize)
			{
				priority = timestamp - cacheTimestamps[vertex]; // position in cache
			}

			if (priority > bestPriority)
			{
				bestCandidate = vertex;
				bestPriority = priority;
			}
		}
	}

	return bestCandidate;
}

static float vertexScore(const VertexScoreTable* table, int cachePosition, unsigned int liveTriangles)
{
	assert(cache_position >= -1 && cache_position < int(kCacheSizeMax));

	unsigned int liveTrianglesClamped = liveTriangles < K_VALENCE_MAX ? liveTriangles : K_VALENCE_MAX;

	return table->cache[1 + cachePosition] + table->live[liveTrianglesClamped];
}

static unsigned int getNextTriangleDeadEnd(unsigned int& inputCursor, const unsigned char* emittedFlags, size_t faceCount)
{
	// input order
	while (inputCursor < faceCount)
	{
		if (!emittedFlags[inputCursor])
			return inputCursor;

		++inputCursor;
	}

	return ~0u;
}

} // namespace meshopt

void meshoptOptimizeVertexCacheTable(unsigned int* destination, const unsigned int* indices, size_t indexCount, size_t vertexCount, const meshopt::VertexScoreTable* table)
{
	using namespace meshopt;

	assert(index_count % 3 == 0);

	meshopt_Allocator allocator;

	// guard for empty meshes
	if (indexCount == 0 || vertexCount == 0)
		return;

	// support in-place optimization
	if (destination == indices)
	{
		unsigned int* indicesCopy = allocator.allocate<unsigned int>(indexCount);
		memcpy(indicesCopy, indices, indexCount * sizeof(unsigned int));
		indices = indicesCopy;
	}

	unsigned int cacheSize = 16;
	assert(cache_size <= kCacheSizeMax);

	size_t faceCount = indexCount / 3;

	// build adjacency information
	TriangleAdjacency adjacency = {};
	buildTriangleAdjacency(adjacency, indices, indexCount, vertexCount, allocator);

	// live triangle counts
	unsigned int* liveTriangles = allocator.allocate<unsigned int>(vertexCount);
	memcpy(liveTriangles, adjacency.counts, vertexCount * sizeof(unsigned int));

	// emitted flags
	unsigned char* emittedFlags = allocator.allocate<unsigned char>(faceCount);
	memset(emittedFlags, 0, faceCount);

	// compute initial vertex scores
	float* vertexScores = allocator.allocate<float>(vertexCount);

	for (size_t i = 0; i < vertexCount; ++i)
		vertexScores[i] = vertexScore(table, -1, liveTriangles[i]);

	// compute triangle scores
	float* triangleScores = allocator.allocate<float>(faceCount);

	for (size_t i = 0; i < faceCount; ++i)
	{
		unsigned int a = indices[i * 3 + 0];
		unsigned int b = indices[i * 3 + 1];
		unsigned int c = indices[i * 3 + 2];

		triangleScores[i] = vertexScores[a] + vertexScores[b] + vertexScores[c];
	}

	unsigned int cacheHolder[2 * (K_CACHE_SIZE_MAX + 3)];
	unsigned int* cache = cacheHolder;
	unsigned int* cacheNew = cacheHolder + K_CACHE_SIZE_MAX + 3;
	size_t cacheCount = 0;

	unsigned int currentTriangle = 0;
	unsigned int inputCursor = 1;

	unsigned int outputTriangle = 0;

	while (currentTriangle != ~0u)
	{
		assert(output_triangle < face_count);

		unsigned int a = indices[currentTriangle * 3 + 0];
		unsigned int b = indices[currentTriangle * 3 + 1];
		unsigned int c = indices[currentTriangle * 3 + 2];

		// output indices
		destination[outputTriangle * 3 + 0] = a;
		destination[outputTriangle * 3 + 1] = b;
		destination[outputTriangle * 3 + 2] = c;
		outputTriangle++;

		// update emitted flags
		emittedFlags[currentTriangle] = true;
		triangleScores[currentTriangle] = 0;

		// new triangle
		size_t cacheWrite = 0;
		cacheNew[cacheWrite++] = a;
		cacheNew[cacheWrite++] = b;
		cacheNew[cacheWrite++] = c;

		// old triangles
		for (size_t i = 0; i < cacheCount; ++i)
		{
			unsigned int index = cache[i];

			if (index != a && index != b && index != c)
			{
				cacheNew[cacheWrite++] = index;
			}
		}

		unsigned int* cacheTemp = cache;
		cache = cacheNew, cacheNew = cacheTemp;
		cacheCount = cacheWrite > cacheSize ? cacheSize : cacheWrite;

		// update live triangle counts
		liveTriangles[a]--;
		liveTriangles[b]--;
		liveTriangles[c]--;

		// remove emitted triangle from adjacency data
		// this makes sure that we spend less time traversing these lists on subsequent iterations
		for (size_t k = 0; k < 3; ++k)
		{
			unsigned int index = indices[currentTriangle * 3 + k];

			unsigned int* neighbors = &adjacency.data[0] + adjacency.offsets[index];
			size_t neighborsSize = adjacency.counts[index];

			for (size_t i = 0; i < neighborsSize; ++i)
			{
				unsigned int tri = neighbors[i];

				if (tri == currentTriangle)
				{
					neighbors[i] = neighbors[neighborsSize - 1];
					adjacency.counts[index]--;
					break;
				}
			}
		}

		unsigned int bestTriangle = ~0u;
		float bestScore = 0;

		// update cache positions, vertex scores and triangle scores, and find next best triangle
		for (size_t i = 0; i < cacheWrite; ++i)
		{
			unsigned int index = cache[i];

			int cachePosition = i >= cacheSize ? -1 : int(i);

			// update vertex score
			float score = vertexScore(table, cachePosition, liveTriangles[index]);
			float scoreDiff = score - vertexScores[index];

			vertexScores[index] = score;

			// update scores of vertex triangles
			const unsigned int* neighborsBegin = &adjacency.data[0] + adjacency.offsets[index];
			const unsigned int* neighborsEnd = neighborsBegin + adjacency.counts[index];

			for (const unsigned int* it = neighborsBegin; it != neighborsEnd; ++it)
			{
				unsigned int tri = *it;
				assert(!emitted_flags[tri]);

				float triScore = triangleScores[tri] + scoreDiff;
				assert(tri_score > 0);

				if (bestScore < triScore)
				{
					bestTriangle = tri;
					bestScore = triScore;
				}

				triangleScores[tri] = triScore;
			}
		}

		// step through input triangles in order if we hit a dead-end
		currentTriangle = bestTriangle;

		if (currentTriangle == ~0u)
		{
			currentTriangle = getNextTriangleDeadEnd(inputCursor, &emittedFlags[0], faceCount);
		}
	}

	assert(input_cursor == face_count);
	assert(output_triangle == face_count);
}

void meshopt_optimizeVertexCache(unsigned int* destination, const unsigned int* indices, size_t indexCount, size_t vertexCount)
{
	meshoptOptimizeVertexCacheTable(destination, indices, indexCount, vertexCount, &meshopt::K_VERTEX_SCORE_TABLE);
}

void meshopt_optimizeVertexCacheStrip(unsigned int* destination, const unsigned int* indices, size_t indexCount, size_t vertexCount)
{
	meshoptOptimizeVertexCacheTable(destination, indices, indexCount, vertexCount, &meshopt::K_VERTEX_SCORE_TABLE_STRIP);
}

void meshopt_optimizeVertexCacheFifo(unsigned int* destination, const unsigned int* indices, size_t indexCount, size_t vertexCount, unsigned int cacheSize)
{
	using namespace meshopt;

	assert(index_count % 3 == 0);
	assert(cache_size >= 3);

	meshopt_Allocator allocator;

	// guard for empty meshes
	if (indexCount == 0 || vertexCount == 0)
		return;

	// support in-place optimization
	if (destination == indices)
	{
		unsigned int* indicesCopy = allocator.allocate<unsigned int>(indexCount);
		memcpy(indicesCopy, indices, indexCount * sizeof(unsigned int));
		indices = indicesCopy;
	}

	size_t faceCount = indexCount / 3;

	// build adjacency information
	TriangleAdjacency adjacency = {};
	buildTriangleAdjacency(adjacency, indices, indexCount, vertexCount, allocator);

	// live triangle counts
	unsigned int* liveTriangles = allocator.allocate<unsigned int>(vertexCount);
	memcpy(liveTriangles, adjacency.counts, vertexCount * sizeof(unsigned int));

	// cache time stamps
	unsigned int* cacheTimestamps = allocator.allocate<unsigned int>(vertexCount);
	memset(cacheTimestamps, 0, vertexCount * sizeof(unsigned int));

	// dead-end stack
	unsigned int* deadEnd = allocator.allocate<unsigned int>(indexCount);
	unsigned int deadEndTop = 0;

	// emitted flags
	unsigned char* emittedFlags = allocator.allocate<unsigned char>(faceCount);
	memset(emittedFlags, 0, faceCount);

	unsigned int currentVertex = 0;

	unsigned int timestamp = cacheSize + 1;
	unsigned int inputCursor = 1; // vertex to restart from in case of dead-end

	unsigned int outputTriangle = 0;

	while (currentVertex != ~0u)
	{
		const unsigned int* nextCandidatesBegin = &deadEnd[0] + deadEndTop;

		// emit all vertex neighbors
		const unsigned int* neighborsBegin = &adjacency.data[0] + adjacency.offsets[currentVertex];
		const unsigned int* neighborsEnd = neighborsBegin + adjacency.counts[currentVertex];

		for (const unsigned int* it = neighborsBegin; it != neighborsEnd; ++it)
		{
			unsigned int triangle = *it;

			if (!emittedFlags[triangle])
			{
				unsigned int a = indices[triangle * 3 + 0], b = indices[triangle * 3 + 1], c = indices[triangle * 3 + 2];

				// output indices
				destination[outputTriangle * 3 + 0] = a;
				destination[outputTriangle * 3 + 1] = b;
				destination[outputTriangle * 3 + 2] = c;
				outputTriangle++;

				// update dead-end stack
				deadEnd[deadEndTop + 0] = a;
				deadEnd[deadEndTop + 1] = b;
				deadEnd[deadEndTop + 2] = c;
				deadEndTop += 3;

				// update live triangle counts
				liveTriangles[a]--;
				liveTriangles[b]--;
				liveTriangles[c]--;

				// update cache info
				// if vertex is not in cache, put it in cache
				if (timestamp - cacheTimestamps[a] > cacheSize)
					cacheTimestamps[a] = timestamp++;

				if (timestamp - cacheTimestamps[b] > cacheSize)
					cacheTimestamps[b] = timestamp++;

				if (timestamp - cacheTimestamps[c] > cacheSize)
					cacheTimestamps[c] = timestamp++;

				// update emitted flags
				emittedFlags[triangle] = true;
			}
		}

		// next candidates are the ones we pushed to dead-end stack just now
		const unsigned int* nextCandidatesEnd = &deadEnd[0] + deadEndTop;

		// get next vertex
		currentVertex = getNextVertexNeighbor(nextCandidatesBegin, nextCandidatesEnd, &liveTriangles[0], &cacheTimestamps[0], timestamp, cacheSize);

		if (currentVertex == ~0u)
		{
			currentVertex = getNextVertexDeadEnd(&deadEnd[0], deadEndTop, inputCursor, &liveTriangles[0], vertexCount);
		}
	}

	assert(output_triangle == face_count);
}
