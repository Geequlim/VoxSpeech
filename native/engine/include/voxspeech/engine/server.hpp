#pragma once

#include <memory>
#include <ostream>
#include <string>
#include <vector>

#include "voxspeech/engine/codec.hpp"
#include "voxspeech/engine/runtime.hpp"

namespace voxspeech::engine {

// Source of NDJSON frames; each `next` call fills `line` with one message
// without the trailing LF and returns true, or returns false at EOF. A source
// reports `failed` when the framing itself is broken (for example an oversized
// message), which is terminal for the connection.
class LineSource {
public:
	virtual ~LineSource() = default;

	[[nodiscard]] virtual bool next(std::string& line) = 0;
	[[nodiscard]] virtual bool failed() const
	{
		return false;
	}
};

// Reads whole frames from a file descriptor using the incremental NDJSON
// decoder, so oversized messages are rejected before a full line arrives.
class FdLineSource final : public LineSource {
public:
	explicit FdLineSource(int fileDescriptor);

	[[nodiscard]] bool next(std::string& line) override;
	[[nodiscard]] bool failed() const override;

private:
	int fileDescriptor_;
	NdjsonDecoder decoder_;
	std::vector<std::string> pending_;
};

// Drives one engine process: stdin NDJSON dispatch, the frozen state machine,
// a single inference worker and one ordered stdout writer.
class EngineServer {
public:
	EngineServer(Runtime& runtime, std::ostream& protocolOutput, std::ostream& logOutput);
	~EngineServer();

	EngineServer(const EngineServer&) = delete;
	EngineServer& operator=(const EngineServer&) = delete;

	// Runs until shutdown, stdin EOF or a framing failure. Returns the process
	// exit code: 0 for an orderly shutdown or EOF, 1 for a framing failure.
	int run(LineSource& input);

	// Thread-safe snapshot for diagnostics and tests.
	[[nodiscard]] std::string stateName() const;
	[[nodiscard]] bool working() const;

private:
	struct Impl;
	std::unique_ptr<Impl> impl_;
};

} // namespace voxspeech::engine
