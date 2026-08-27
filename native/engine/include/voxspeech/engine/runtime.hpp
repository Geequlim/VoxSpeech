#pragma once

#include <atomic>
#include <expected>
#include <memory>
#include <optional>
#include <span>
#include <string>

#include "voxspeech/engine/protocol.hpp"

namespace voxspeech::engine {

// Cooperative cancellation flag handed to runtime calls that support
// cancellation. The server sets it from the main thread; the runtime polls it
// inside its own generation loop.
class CancellationToken {
public:
	void cancel() noexcept
	{
		cancelled_.store(true, std::memory_order_relaxed);
	}

	[[nodiscard]] bool cancelled() const noexcept
	{
		return cancelled_.load(std::memory_order_relaxed);
	}

private:
	std::atomic<bool> cancelled_{false};
};

// Receives 24 kHz mono float32 PCM from the runtime. Implementations must copy
// the samples and return quickly; they must not block on I/O.
class AudioSink {
public:
	virtual ~AudioSink() = default;

	virtual void submit(std::span<const float> samples) = 0;
};

enum class RuntimeFailure {
	invalid_params,
	model_load_failed,
	synthesis_failed,
	cancelled,
	voice_extraction_failed,
};

struct RuntimeError {
	RuntimeFailure kind{};
	std::string details;
};

struct RuntimeStatusReport {
	std::optional<std::string> backend;
	std::optional<std::string> modelType;
	std::string runtimeVersion;
};

struct RuntimeLoadReport {
	std::string backend;
	std::string modelType;
	std::string runtimeVersion;
};

struct RuntimeVoiceExtractionReport {
	std::uint64_t speakerDimension{};
	std::uint64_t codebookCount{};
	std::uint64_t frameCount{};
};

template<typename Report>
using RuntimeOutcome = std::expected<Report, RuntimeError>;

// Replaces qwentts.cpp in the engine process shell. Implementations must not
// expose qwentts or GGML types through this interface. `status` may be called
// from the main thread at server start-up; `load`, `synthesize` and
// `extractVoice` are only invoked from the single inference worker; `shutdown`
// is called once after the worker has finished.
class Runtime {
public:
	virtual ~Runtime() = default;

	[[nodiscard]] virtual RuntimeStatusReport status() = 0;
	[[nodiscard]] virtual RuntimeOutcome<RuntimeLoadReport> load(const protocol::EngineLoadParams& params) = 0;
	[[nodiscard]] virtual RuntimeOutcome<void> synthesize(
		const protocol::SpeechSynthesizeParams& params,
		CancellationToken& cancellation,
		AudioSink& sink) = 0;
	[[nodiscard]] virtual RuntimeOutcome<RuntimeVoiceExtractionReport> extractVoice(
		const protocol::VoiceExtractParams& params) = 0;
	virtual void shutdown() = 0;
};

} // namespace voxspeech::engine
