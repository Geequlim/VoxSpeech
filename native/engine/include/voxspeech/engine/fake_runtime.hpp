#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "voxspeech/engine/runtime.hpp"

namespace voxspeech::engine {

// Failure behaviour selected by a scenario. When a synthesis plan sets a
// failure, synthesize reports it after emitting its configured chunks.
// `model_load_failed` and `voice_extraction_failed` are selected by the
// corresponding plan's `ok` flag.
enum class FakeFailure {
	none,
	synthesis_failed,
	invalid_params,
};

struct FakeLoadPlan {
	bool ok{true};
	std::string backend{"cpu"};
	std::string modelType{"base"};
	std::string runtimeVersion{"0.1.0"};
	int delayMs{0};
};

struct FakeSynthesisPlan {
	FakeFailure failure{FakeFailure::none};
	// Explicit chunks take precedence over the generator fields.
	std::vector<std::vector<float>> chunks{};
	std::size_t chunkCount{0};
	std::size_t samplesPerChunk{0};
	float amplitude{0.5F};
	int delayMs{0};
};

struct FakeExtractPlan {
	bool ok{true};
	std::uint64_t speakerDimension{1024};
	std::uint64_t codebookCount{16};
	std::uint64_t frameCount{42};
	int delayMs{0};
};

struct FakeRuntimeConfig {
	FakeLoadPlan load{};
	FakeSynthesisPlan synthesis{};
	FakeExtractPlan extract{};
};

// Parses a deterministic fake runtime scenario: a JSON object with optional
// `load`, `synthesis` and `extract` sections mirroring the plan structs (the
// synthesis section uses `failure`: "none" | "synthesis_failed" |
// "invalid_params" plus chunk generator fields). Returns nullopt when the JSON
// is invalid or inconsistent.
[[nodiscard]] std::optional<FakeRuntimeConfig> parseFakeRuntimeScenario(std::string_view json);

// In-memory runtime used by tests and the fixture executable. It never touches
// models or GPUs: load, synthesis and extraction outcomes, chunk payloads,
// delays and cancellation behaviour are fully configured upfront.
class FakeRuntime final : public Runtime {
public:
	using Log = std::function<void(std::string_view)>;

	explicit FakeRuntime(FakeRuntimeConfig config, Log log = nullptr);

	[[nodiscard]] RuntimeStatusReport status() override;
	[[nodiscard]] RuntimeOutcome<RuntimeLoadReport> load(const protocol::EngineLoadParams& params) override;
	[[nodiscard]] RuntimeOutcome<void> synthesize(
		const protocol::SpeechSynthesizeParams& params,
		CancellationToken& cancellation,
		AudioSink& sink) override;
	[[nodiscard]] RuntimeOutcome<RuntimeVoiceExtractionReport> extractVoice(
		const protocol::VoiceExtractParams& params) override;
	void shutdown() override;

	[[nodiscard]] bool released() const noexcept
	{
		return released_.load(std::memory_order_relaxed);
	}

private:
	void sleepFor(int delayMs) const;
	void emitLog(std::string_view message) const;
	[[nodiscard]] const std::vector<float>& chunkAt(std::size_t index) const;
	[[nodiscard]] std::size_t totalChunkCount() const;

	FakeRuntimeConfig config_;
	Log log_;
	std::vector<std::vector<float>> generatedChunks_;
	mutable std::mutex stateMutex_;
	bool loaded_{false};
	std::atomic<bool> released_{false};
};

} // namespace voxspeech::engine
