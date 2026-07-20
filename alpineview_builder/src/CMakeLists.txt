include_directories(
	${swiss_lidar_SOURCE_DIR}/include/
	${swiss_lidar_SOURCE_DIR}/extern/
	)

# miniply and meshoptimizer are built as libraries via add_subdirectory() in
# the top-level CMakeLists.txt; alpineview_builder links against them below.

# CGAL + Eigen for las_normal_cgal.cpp (scale estimation, PCA normals,
# scanline orientation); provided by the conda "lidalp" env.
find_package(CGAL REQUIRED)
find_package(Eigen3 REQUIRED NO_MODULE) # force Config mode: CGAL's bundled
                                         # FindEigen3.cmake misparses conda's
                                         # eigen3 version string.

add_executable(alpineview_builder
	chrono.cpp
	las_read.cpp
	las_normal_cgal.cpp
	las_source.cpp
	las_resample.cpp
	copc.cpp
	mesh.cpp
	mesh_clip.cpp
	mesh_ply.cpp
	mesh_simplify.cpp
	mesh_lod.cpp
	vertex_remap.cpp
	mesh_utils.cpp
	alpineview_builder.cpp
	)
target_compile_definitions(alpineview_builder PRIVATE CGAL_EIGEN3_ENABLED)
target_compile_features(alpineview_builder PRIVATE cxx_std_17)
target_compile_options(alpineview_builder PRIVATE -Wall)
target_link_libraries(alpineview_builder miniply meshoptimizer copc-lib-s lazperf draco::draco CGAL::CGAL Eigen3::Eigen)
