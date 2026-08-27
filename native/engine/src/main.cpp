#include <csignal>
#include <iostream>

#include <unistd.h>

#include "voxspeech/engine/qwentts_runtime.hpp"
#include "voxspeech/engine/server.hpp"

int main()
{
	std::signal(SIGPIPE, SIG_IGN);
	voxspeech::engine::QwenTtsRuntime runtime;
	voxspeech::engine::FdLineSource input{STDIN_FILENO};
	voxspeech::engine::EngineServer server{runtime, std::cout, std::cerr};
	return server.run(input);
}
