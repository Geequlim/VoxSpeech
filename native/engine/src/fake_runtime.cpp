#include "voxspeech/engine/fake_runtime.hpp"

#include <chrono>
#include <cmath>
#include <thread>
#include <utility>

#include <glaze/json.hpp>

namespace voxspeech::engine {
namespace {

constexpr glz::opts scenario_options{
	.error_on_unknown_keys = true,
	.error_on_missing_keys = false,
};

struct ScenarioLoad {
	bool ok{true};
	std::string backend{"cpu"};
	std::string modelType{"base"};
	std::string runtimeVersion{"0.1.0"};
	int delayMs{0};
};

struct ScenarioSynthesis {
	std::string failure{"none"};
	std::uint64_t chunkCount{0};
	std::uint64_t samplesPerChunk{0};
	double amplitude{0.5};
	int delayMs{0};
};

struct ScenarioExtract {
	bool ok{true};
	std::uint64_t speakerDimension{1024};
	std::uint64_t codebookCount{16};
	std::uint64_t frameCount{42};
	int delayMs{0};
};

struct Scenario {
	ScenarioLoad load{};
	ScenarioSynthesis synthesis{};
	ScenarioExtract extract{};
};

} // namespace

std::optional<FakeRuntimeConfig> parseFakeRuntimeScenario(std::string_view json)
{
	Scenario scenario;
	if (glz::read<scenario_options>(scenario, json)) {
		return std::nullopt;
	}
	if (scenario.synthesis.chunkCount > 0 && scenario.synthesis.samplesPerChunk == 0) {
		return std::nullopt;
	}
	FakeFailure synthesisFailure = FakeFailure::none;
	if (scenario.synthesis.failure == "none") {
		synthesisFailure = FakeFailure::none;
	}
	else if (scenario.synthesis.failure == "synthesis_failed") {
		synthesisFailure = FakeFailure::synthesis_failed;
	}
	else if (scenario.synthesis.failure == "invalid_params") {
		synthesisFailure = FakeFailure::invalid_params;
	}
	else {
		return std::nullopt;
	}
	FakeRuntimeConfig config;
	config.load = FakeLoadPlan{
		.ok = scenario.load.ok,
		.backend = scenario.load.backend,
		.modelType = scenario.load.modelType,
		.runtimeVersion = scenario.load.runtimeVersion,
		.delayMs = scenario.load.delayMs,
	};
	config.synthesis = FakeSynthesisPlan{
		.failure = synthesisFailure,
		.chunks = {},
		.chunkCount = static_cast<std::size_t>(scenario.synthesis.chunkCount),
		.samplesPerChunk = static_cast<std::size_t>(scenario.synthesis.samplesPerChunk),
		.amplitude = static_cast<float>(scenario.synthesis.amplitude),
		.delayMs = scenario.synthesis.delayMs,
	};
	config.extract = FakeExtractPlan{
		.ok = scenario.extract.ok,
		.speakerDimension = scenario.extract.speakerDimension,
		.codebookCount = scenario.extract.codebookCount,
		.frameCount = scenario.extract.frameCount,
		.delayMs = scenario.extract.delayMs,
	};
	return config;
}

FakeRuntime::FakeRuntime(FakeRuntimeConfig config, Log log)
	: config_(std::move(config)), log_(std::move(log))
{
	if (config_.synthesis.chunks.empty() && config_.synthesis.chunkCount > 0) {
		generatedChunks_.reserve(config_.synthesis.chunkCount);
		for (std::size_t index = 0; index < config_.synthesis.chunkCount; ++index) {
			generatedChunks_.emplace_back(config_.synthesis.samplesPerChunk, config_.synthesis.amplitude);
		}
	}
}

void FakeRuntime::sleepFor(const int delayMs) const
{
	if (delayMs > 0) {
		std::this_thread::sleep_for(std::chrono::milliseconds{delayMs});
	}
}

void FakeRuntime::emitLog(const std::string_view message) const
{
	if (log_) {
		log_(message);
	}
}

const std::vector<float>& FakeRuntime::chunkAt(const std::size_t index) const
{
	if (!config_.synthesis.chunks.empty()) {
		return config_.synthesis.chunks.at(index);
	}
	return generatedChunks_.at(index);
}

std::size_t FakeRuntime::totalChunkCount() const
{
	if (!config_.synthesis.chunks.empty()) {
		return config_.synthesis.chunks.size();
	}
	return generatedChunks_.size();
}

RuntimeStatusReport FakeRuntime::status()
{
	std::lock_guard lock{stateMutex_};
	if (!loaded_) {
		return {.backend = std::nullopt, .modelType = std::nullopt, .runtimeVersion = config_.load.runtimeVersion};
	}
	return {.backend = config_.load.backend, .modelType = config_.load.modelType, .runtimeVersion = config_.load.runtimeVersion};
}

RuntimeOutcome<RuntimeLoadReport> FakeRuntime::load(const protocol::EngineLoadParams& params)
{
	(void)params;
	sleepFor(config_.load.delayMs);
	if (!config_.load.ok) {
		emitLog("fake runtime load failed");
		return std::unexpected(RuntimeError{RuntimeFailure::model_load_failed, "fake runtime failed to load the model"});
	}
	{
		std::lock_guard lock{stateMutex_};
		loaded_ = true;
	}
	emitLog("fake runtime loaded");
	return RuntimeLoadReport{config_.load.backend, config_.load.modelType, config_.load.runtimeVersion};
}

RuntimeOutcome<void> FakeRuntime::synthesize(
	const protocol::SpeechSynthesizeParams& params, CancellationToken& cancellation, AudioSink& sink)
{
	(void)params;
	const auto count = totalChunkCount();
	for (std::size_t index = 0; index < count; ++index) {
		if (cancellation.cancelled()) {
			emitLog("fake synthesis cancelled");
			return std::unexpected(RuntimeError{RuntimeFailure::cancelled, "fake synthesis was cancelled"});
		}
		sleepFor(config_.synthesis.delayMs);
		if (cancellation.cancelled()) {
			emitLog("fake synthesis cancelled");
			return std::unexpected(RuntimeError{RuntimeFailure::cancelled, "fake synthesis was cancelled"});
		}
		sink.submit(chunkAt(index));
	}
	if (config_.synthesis.failure != FakeFailure::none) {
		const auto kind = config_.synthesis.failure == FakeFailure::invalid_params
			? RuntimeFailure::invalid_params
			: RuntimeFailure::synthesis_failed;
		emitLog("fake synthesis failed");
		return std::unexpected(RuntimeError{kind, "fake synthesis failed (configured)"});
	}
	emitLog("fake synthesis completed");
	return {};
}

RuntimeOutcome<RuntimeVoiceExtractionReport> FakeRuntime::extractVoice(const protocol::VoiceExtractParams& params)
{
	(void)params;
	sleepFor(config_.extract.delayMs);
	if (!config_.extract.ok) {
		emitLog("fake voice extraction failed");
		return std::unexpected(RuntimeError{RuntimeFailure::voice_extraction_failed, "fake voice extraction failed (configured)"});
	}
	emitLog("fake voice extraction completed");
	return RuntimeVoiceExtractionReport{
		config_.extract.speakerDimension,
		config_.extract.codebookCount,
		config_.extract.frameCount,
	};
}

void FakeRuntime::shutdown()
{
	released_.store(true, std::memory_order_relaxed);
	emitLog("fake runtime released");
}

} // namespace voxspeech::engine
