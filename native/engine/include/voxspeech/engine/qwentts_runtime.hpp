#pragma once

#include <memory>
#include <string>

#include "voxspeech/engine/runtime.hpp"

struct qt_context;

namespace voxspeech::engine {

class QwenTtsRuntime final : public Runtime {
public:
	QwenTtsRuntime();
	~QwenTtsRuntime() override;

	QwenTtsRuntime(const QwenTtsRuntime&) = delete;
	QwenTtsRuntime& operator=(const QwenTtsRuntime&) = delete;

	[[nodiscard]] RuntimeStatusReport status() override;
	[[nodiscard]] RuntimeOutcome<RuntimeLoadReport> load(const protocol::EngineLoadParams& params) override;
	[[nodiscard]] RuntimeOutcome<void> synthesize(
		const protocol::SpeechSynthesizeParams& params,
		CancellationToken& cancellation,
		AudioSink& sink) override;
	[[nodiscard]] RuntimeOutcome<RuntimeVoiceExtractionReport> extractVoice(
		const protocol::VoiceExtractParams& params) override;
	void shutdown() override;

private:
	struct ContextDeleter {
		void operator()(qt_context* context) const noexcept;
	};

	std::unique_ptr<qt_context, ContextDeleter> context_;
	std::string backend_;
	std::string modelType_;
};

} // namespace voxspeech::engine
