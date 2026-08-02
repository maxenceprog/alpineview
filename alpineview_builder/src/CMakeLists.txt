include_directories(
	${PROJECT_SOURCE_DIR}/include/
	${PROJECT_SOURCE_DIR}/extern/
	)

# miniply and meshoptimizer are built as libraries via add_subdirectory() in
# the top-level CMakeLists.txt; alpineview_builder links against them below.

# CGAL + Eigen for las_normal_cgal.cpp (scale estimation, PCA normals,
# scanline orientation); provided by the conda "lidalp" env.
find_package(CGAL REQUIRED)
find_package(Eigen3 REQUIRED NO_MODULE) # force Config mode: CGAL's bundled
                                         # FindEigen3.cmake misparses conda's
                                         # eigen3 version string.

find_package(PROJ REQUIRED)

# The projection constants are read at run time from geo_constants.json at the
# repository root -- the same file the Python tiler and the GUI read. Only its
# default location is baked in; $ALPINEVIEW_GEO_CONSTANTS overrides it, which
# is what makes a relocated or installed binary work.
get_filename_component(GEO_CONSTANTS_JSON
	"${PROJECT_SOURCE_DIR}/../geo_constants.json" ABSOLUTE)
if(NOT EXISTS ${GEO_CONSTANTS_JSON})
	message(FATAL_ERROR "geo_constants.json not found at ${GEO_CONSTANTS_JSON}")
endif()

add_executable(alpineview_builder
	chrono.cpp
	geo.cpp
	geo_constants.cpp
	las_read.cpp
	las_normal_cgal.cpp
	las_source.cpp
	las_resample.cpp
	mesh.cpp
	mesh_clip.cpp
	mesh_ply.cpp
	mesh_simplify.cpp
	mesh_lod.cpp
	mesh_utils.cpp
	poisson_common.cpp
	alpineview_builder.cpp
	)
target_compile_definitions(alpineview_builder PRIVATE CGAL_EIGEN3_ENABLED
	GEO_CONSTANTS_PATH="${GEO_CONSTANTS_JSON}")
target_compile_features(alpineview_builder PRIVATE cxx_std_17)
target_compile_options(alpineview_builder PRIVATE -Wall)
target_link_libraries(alpineview_builder miniply meshoptimizer lazperf draco::draco CGAL::CGAL Eigen3::Eigen PROJ::proj)

add_executable(alpineview_coarse
	chrono.cpp
	geo.cpp
	geo_constants.cpp
	asc_grid.cpp
	mesh.cpp
	mesh_clip.cpp
	mesh_ply.cpp
	mesh_simplify.cpp
	mesh_lod.cpp
	mesh_utils.cpp
	poisson_common.cpp
	alpineview_coarse.cpp
	)
target_compile_definitions(alpineview_coarse PRIVATE
	GEO_CONSTANTS_PATH="${GEO_CONSTANTS_JSON}")
target_compile_features(alpineview_coarse PRIVATE cxx_std_17)
target_compile_options(alpineview_coarse PRIVATE -Wall)
target_link_libraries(alpineview_coarse miniply meshoptimizer draco::draco PROJ::proj)

add_executable(geo_convert
	geo.cpp
	geo_constants.cpp
	geo_convert.cpp
	)
target_compile_definitions(geo_convert PRIVATE
	GEO_CONSTANTS_PATH="${GEO_CONSTANTS_JSON}")
target_compile_features(geo_convert PRIVATE cxx_std_17)
target_compile_options(geo_convert PRIVATE -Wall)
target_link_libraries(geo_convert PROJ::proj)
