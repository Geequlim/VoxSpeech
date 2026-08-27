cmake_minimum_required(VERSION 3.25)

project(voxspeech_engine LANGUAGES CXX)

option(VOXSPEECH_ENGINE_BUILD_TESTS "Build native engine protocol tests" ON)

set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(voxspeech_engine_protocol
	src/codec.cpp
	src/dispatcher.cpp
)

target_include_directories(voxspeech_engine_protocol
	PUBLIC
		${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_include_directories(voxspeech_engine_protocol SYSTEM PUBLIC
	${CMAKE_CURRENT_SOURCE_DIR}/../third_party/glaze/include
)

target_compile_features(voxspeech_engine_protocol PUBLIC cxx_std_23)

if(VOXSPEECH_ENGINE_BUILD_TESTS)
	enable_testing()

	add_executable(voxspeech_engine_protocol_tests test/protocol_test.cpp)
	target_link_libraries(voxspeech_engine_protocol_tests PRIVATE voxspeech_engine_protocol)
	target_compile_definitions(voxspeech_engine_protocol_tests PRIVATE
		VOXSPEECH_PROTOCOL_FIXTURE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../test/fixtures/protocol/v1"
	)

	add_test(NAME voxspeech_engine_protocol COMMAND voxspeech_engine_protocol_tests)
endif()
