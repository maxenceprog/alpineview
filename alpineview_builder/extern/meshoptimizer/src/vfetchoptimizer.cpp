// This file is part of meshoptimizer library; see meshoptimizer.h for version/license details
#include "meshoptimizer.h"

#include <assert.h>
#include <string.h>

size_t meshopt_optimizeVertexFetchRemap(unsigned int* destination, const unsigned int* indices, size_t indexCount, size_t vertexCount)
{
	assert(index_count % 3 == 0);

	memset(destination, -1, vertexCount * sizeof(unsigned int));

	unsigned int nextVertex = 0;

	for (size_t i = 0; i < indexCount; ++i)
	{
		unsigned int index = indices[i];
		assert(index < vertex_count);

		if (destination[index] == ~0u)
		{
			destination[index] = nextVertex++;
		}
	}

	assert(next_vertex <= vertex_count);

	return nextVertex;
}

size_t meshopt_optimizeVertexFetch(void* destination, unsigned int* indices, size_t indexCount, const void* vertices, size_t vertexCount, size_t vertexSize)
{
	assert(index_count % 3 == 0);
	assert(vertex_size > 0 && vertex_size <= 256);

	meshopt_Allocator allocator;

	// support in-place optimization
	if (destination == vertices)
	{
		unsigned char* verticesCopy = allocator.allocate<unsigned char>(vertexCount * vertexSize);
		memcpy(verticesCopy, vertices, vertexCount * vertexSize);
		vertices = verticesCopy;
	}

	// build vertex remap table
	unsigned int* vertexRemap = allocator.allocate<unsigned int>(vertexCount);
	memset(vertexRemap, -1, vertexCount * sizeof(unsigned int));

	unsigned int nextVertex = 0;

	for (size_t i = 0; i < indexCount; ++i)
	{
		unsigned int index = indices[i];
		assert(index < vertex_count);

		unsigned int& remap = vertexRemap[index];

		if (remap == ~0u) // vertex was not added to destination VB
		{
			// add vertex
			memcpy(static_cast<unsigned char*>(destination) + nextVertex * vertexSize, static_cast<const unsigned char*>(vertices) + index * vertexSize, vertexSize);

			remap = nextVertex++;
		}

		// modify indices in place
		indices[i] = remap;
	}

	assert(next_vertex <= vertex_count);

	return nextVertex;
}
