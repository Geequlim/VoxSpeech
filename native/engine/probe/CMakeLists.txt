add_executable(voxspeech-native-probe qwentts_probe.cpp)

target_compile_features(voxspeech-native-probe PRIVATE cxx_std_23)
target_include_directories(voxspeech-native-probe PRIVATE
	${CMAKE_SOURCE_DIR}/src
)
target_link_libraries(voxspeech-native-probe PRIVATE qwen-core)

if(MSVC)
	target_compile_options(voxspeech-native-probe PRIVATE /W4)
else()
	target_compile_options(voxspeech-native-probe PRIVATE -Wall -Wextra -Wpedantic -Wno-unused-function)
endif()
