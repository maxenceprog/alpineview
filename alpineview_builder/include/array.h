#pragma once

/* Historically this header provided a hand-rolled POD-only dynamic array
 * (TArray, backed by malloc/realloc). It has been replaced by std::vector;
 * this header now only pulls in <vector> so existing includes keep working. */
#include <vector>
