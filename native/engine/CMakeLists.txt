cmake_minimum_required(VERSION 3.25)

project(voxspeech_engine LANGUAGES CXX)

option(VOXSPEECH_ENGINE_BUILD_TESTS "Build native engine protocol tests" ON)
option(VOXSPEECH_ENGINE_ENABLE_QWENTTS "Build the real qwentts.cpp engine executable" OFF)
set(VOXSPEECH_ENGINE_BACKEND "cpu" CACHE STRING "Single backend compiled into voxspeech-engine")
set_property(CACHE VOXSPEECH_ENGINE_BACKEND PROPERTY STRINGS cpu cuda vulkan)

set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Threads REQUIRED)

# Shared include directories and compile settings for engine targets.
function(voxspeech_engine_target target)
	target_include_directories(${target}
		PUBLIC
			${CMAKE_CURRENT_SOURCE_DIR}/include
	)
	target_include_directories(${target} SYSTEM PUBLIC
		${CMAKE_CURRENT_SOURCE_DIR}/../third_party/glaze/include
	)
	target_compile_features(${target} PUBLIC cxx_std_23)
endfunction()

# Protocol baseline: NDJSON codec, output separation and request validation.
add_library(voxspeech_engine_protocol STATIC
	src/codec.cpp
	src/dispatcher.cpp
)
voxspeech_engine_target(voxspeech_engine_protocol)

# Server/runtime boundary: engine process shell without any concrete runtime.
# The future qwentts runtime links against this target and implements
# voxspeech/engine/runtime.hpp.
add_library(voxspeech_engine_server STATIC
	src/pcm.cpp
	src/server.cpp
	src/voice_reference.cpp
)
voxspeech_engine_target(voxspeech_engine_server)
target_link_libraries(voxspeech_engine_server
	PUBLIC
		voxspeech_engine_protocol
		Threads::Threads
)

if(VOXSPEECH_ENGINE_ENABLE_QWENTTS)
	if(NOT VOXSPEECH_ENGINE_BACKEND MATCHES "^(cpu|cuda|vulkan)$")
		message(FATAL_ERROR "VOXSPEECH_ENGINE_BACKEND must be cpu, cuda, or vulkan")
	endif()
	if(VOXSPEECH_ENGINE_BACKEND STREQUAL "cuda" AND NOT GGML_CUDA)
		message(FATAL_ERROR "The CUDA profile requires GGML_CUDA=ON")
	endif()
	if(VOXSPEECH_ENGINE_BACKEND STREQUAL "vulkan" AND NOT GGML_VULKAN)
		message(FATAL_ERROR "The Vulkan profile requires GGML_VULKAN=ON")
	endif()
	if(VOXSPEECH_ENGINE_BACKEND STREQUAL "cpu" AND (GGML_CUDA OR GGML_VULKAN))
		message(FATAL_ERROR "The CPU profile requires GGML_CUDA=OFF and GGML_VULKAN=OFF")
	endif()

	add_library(voxspeech_engine_qwentts_runtime STATIC src/qwentts_runtime.cpp)
	voxspeech_engine_target(voxspeech_engine_qwentts_runtime)
	target_compile_definitions(voxspeech_engine_qwentts_runtime PRIVATE
		VOXSPEECH_ENGINE_BACKEND="${VOXSPEECH_ENGINE_BACKEND}"
	)
	target_link_libraries(voxspeech_engine_qwentts_runtime
		PUBLIC
			voxspeech_engine_server
		PRIVATE
			qwen-core
	)

	add_executable(voxspeech-engine src/main.cpp)
	target_link_libraries(voxspeech-engine PRIVATE voxspeech_engine_qwentts_runtime)
endif()

# Deterministic in-memory runtime for tests; never linked by the real engine.
add_library(voxspeech_engine_fake_runtime STATIC
	src/fake_runtime.cpp
)
voxspeech_engine_target(voxspeech_engine_fake_runtime)
target_link_libraries(voxspeech_engine_fake_runtime
	PUBLIC
		voxspeech_engine_server
)

if(VOXSPEECH_ENGINE_BUILD_TESTS)
	enable_testing()

	add_executable(voxspeech_engine_protocol_tests test/protocol_test.cpp)
	target_link_libraries(voxspeech_engine_protocol_tests PRIVATE voxspeech_engine_protocol)
	target_compile_definitions(voxspeech_engine_protocol_tests PRIVATE
		VOXSPEECH_PROTOCOL_FIXTURE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../test/fixtures/protocol/v1"
	)
	add_test(NAME voxspeech_engine_protocol COMMAND voxspeech_engine_protocol_tests)

	add_executable(voxspeech_engine_voice_reference_tests test/voice_reference_test.cpp)
	target_link_libraries(voxspeech_engine_voice_reference_tests PRIVATE voxspeech_engine_server)
	add_test(NAME voxspeech_engine_voice_reference COMMAND voxspeech_engine_voice_reference_tests)

	# Fixture executable driving the server with the fake runtime over real
	# pipes; used by the subprocess tests.
	add_executable(voxspeech_engine_fixture test/fixture_main.cpp)
	target_link_libraries(voxspeech_engine_fixture PRIVATE voxspeech_engine_fake_runtime)

	add_executable(voxspeech_engine_server_tests test/server_test.cpp)
	target_link_libraries(voxspeech_engine_server_tests PRIVATE voxspeech_engine_fake_runtime)
	target_compile_definitions(voxspeech_engine_server_tests PRIVATE
		VOXSPEECH_PROTOCOL_FIXTURE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../test/fixtures/protocol/v1"
	)
	add_test(NAME voxspeech_engine_server COMMAND voxspeech_engine_server_tests)

	add_executable(voxspeech_engine_subprocess_tests test/subprocess_test.cpp)
	target_link_libraries(voxspeech_engine_subprocess_tests PRIVATE voxspeech_engine_fake_runtime)
	target_compile_definitions(voxspeech_engine_subprocess_tests PRIVATE
		VOXSPEECH_PROTOCOL_FIXTURE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../test/fixtures/protocol/v1"
		VOXSPEECH_ENGINE_FIXTURE="$<TARGET_FILE:voxspeech_engine_fixture>"
	)
	add_test(NAME voxspeech_engine_subprocess COMMAND voxspeech_engine_subprocess_tests)
endif()
