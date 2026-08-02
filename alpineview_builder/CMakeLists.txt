cmake_minimum_required(VERSION 3.13)
cmake_policy(VERSION 3.13)

project(alpineview VERSION 0.1)

set( CMAKE_EXPORT_COMPILE_COMMANDS ON )
set( CMAKE_VERBOSE_MAKEFILE OFF )

# Draco (system libdraco-dev) for Level-of-Detail web tile compression.
find_package(draco REQUIRED)

# Build vendored deps static and without their test suites. laz-perf (3.0.0)
# and copc-lib are consumed by alpineview_builder's COPC reader; copc-lib finds no
# system laz-perf and falls back to the "compiled in tandem" path, linking the
# lazperf_s / lazperf targets we build here.
set(WITH_TESTS OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
# copc-lib sources #include <lazperf/...>; expose laz-perf's header root.
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/extern/laz-perf/cpp)

add_subdirectory(src)
add_subdirectory(extern/miniply)
add_subdirectory(extern/meshoptimizer/src)
add_subdirectory(extern/laz-perf)
# laz-perf >=3.4 only defines a single `lazperf` target (static here); copc-lib's
# "compiled in tandem" path also references `lazperf_s`, so alias it.
add_library(lazperf_s ALIAS lazperf)
add_subdirectory(extern/copc-lib)




