#include <csignal>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>
#include <string_view>
#include <utility>

#include <unistd.h>

#include "voxspeech/engine/fake_runtime.hpp"
#include "voxspeech/engine/server.hpp"

int main()
{
	std::signal(SIGPIPE, SIG_IGN);

	voxspeech::engine::FakeRuntimeConfig config;
	if (const char* scenarioPath = std::getenv("VOXSPEECH_ENGINE_SCENARIO"); scenarioPath != nullptr) {
		std::ifstream scenarioFile{scenarioPath, std::ios::binary};
		if (!scenarioFile) {
			std::cerr << "[voxspeech-engine-fixture] scenario file could not be opened\n";
			return 2;
		}
		std::string contents{std::istreambuf_iterator<char>{scenarioFile}, std::istreambuf_iterator<char>{}};
		auto parsed = voxspeech::engine::parseFakeRuntimeScenario(contents);
		if (!parsed) {
			std::cerr << "[voxspeech-engine-fixture] scenario file is invalid\n";
			return 2;
		}
		config = std::move(*parsed);
	}

	voxspeech::engine::FakeRuntime runtime{config, [](const std::string_view message) {
		std::cerr << "[fake-runtime] " << message << '\n';
	}};
	voxspeech::engine::FdLineSource input{STDIN_FILENO};
	voxspeech::engine::EngineServer server{runtime, std::cout, std::cerr};
	return server.run(input);
}
