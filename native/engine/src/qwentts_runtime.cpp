#include "voxspeech/engine/qwentts_runtime.hpp"

#include <cerrno>
#include <climits>
#include <cstdlib>
#include <exception>
#include <expected>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include <unistd.h>

#include "audio-io.h"
#include "gguf.h"
#include "qwen.h"

#include "voxspeech/engine/voice_reference.hpp"

#ifndef VOXSPEECH_ENGINE_BACKEND
#error "VOXSPEECH_ENGINE_BACKEND must name the single compiled backend"
#endif

namespace voxspeech::engine {
namespace {

constexpr const char* compiledBackend = VOXSPEECH_ENGINE_BACKEND;

struct GgufDeleter {
	void operator()(gguf_context* context) const noexcept
	{
		gguf_free(context);
	}
};

struct VoiceDeleter {
	void operator()(qt_voice_ref* reference) const noexcept
	{
		qt_voice_ref_free(reference);
	}
};

struct AudioDeleter {
	void operator()(float* audio) const noexcept
	{
		std::free(audio);
	}
};

std::string lastErrorCopy()
{
	const char* error = qt_last_error();
	return error != nullptr && *error != '\0' ? std::string{error} : "qwentts.cpp returned no diagnostic";
}

bool isReadableRegularFile(const std::string& path)
{
	std::error_code error;
	const auto status = std::filesystem::status(path, error);
	return !error && std::filesystem::is_regular_file(status) && ::access(path.c_str(), R_OK) == 0;
}

std::expected<std::string, std::string> readModelType(const std::string& path)
{
	gguf_init_params init{.no_alloc = true, .ctx = nullptr};
	std::unique_ptr<gguf_context, GgufDeleter> metadata{gguf_init_from_file(path.c_str(), init)};
	if (!metadata) {
		return std::unexpected{"failed to read talker GGUF metadata"};
	}
	const auto architectureKey = gguf_find_key(metadata.get(), "general.architecture");
	const auto modelTypeKey = gguf_find_key(metadata.get(), "qwen3-tts.model_type");
	if (architectureKey < 0 || modelTypeKey < 0 ||
		gguf_get_kv_type(metadata.get(), architectureKey) != GGUF_TYPE_STRING ||
		gguf_get_kv_type(metadata.get(), modelTypeKey) != GGUF_TYPE_STRING) {
		return std::unexpected{"talker GGUF is missing required string metadata"};
	}
	if (std::string_view{gguf_get_val_str(metadata.get(), architectureKey)} != "qwen3-tts") {
		return std::unexpected{"talker GGUF general.architecture is not qwen3-tts"};
	}
	std::string modelType{gguf_get_val_str(metadata.get(), modelTypeKey)};
	if (modelType != "base" && modelType != "custom_voice" && modelType != "voice_design") {
		return std::unexpected{"talker GGUF has an unsupported qwen3-tts.model_type"};
	}
	return modelType;
}

const char* backendDevice()
{
	if (std::string_view{compiledBackend} == "cuda") return "CUDA0";
	if (std::string_view{compiledBackend} == "vulkan") return "Vulkan0";
	return "CPU";
}

RuntimeError mapSynthesisError(const qt_status status, std::string details)
{
	if (status == QT_STATUS_CANCELLED) {
		return {RuntimeFailure::cancelled, std::move(details)};
	}
	if (status == QT_STATUS_INVALID_PARAMS || status == QT_STATUS_MODE_INVALID) {
		return {RuntimeFailure::invalid_params, std::move(details)};
	}
	return {RuntimeFailure::synthesis_failed, std::move(details)};
}

struct CallbackState {
	CancellationToken& cancellation;
	AudioSink& sink;
	std::exception_ptr sinkFailure;
};

bool cancelCallback(void* userData)
{
	return static_cast<CallbackState*>(userData)->cancellation.cancelled();
}

bool audioCallback(const float* samples, const int sampleCount, void* userData)
{
	auto& state = *static_cast<CallbackState*>(userData);
	if (state.cancellation.cancelled()) return false;
	try {
		if (samples != nullptr && sampleCount > 0) {
			state.sink.submit({samples, static_cast<std::size_t>(sampleCount)});
		}
		return true;
	}
	catch (...) {
		state.sinkFailure = std::current_exception();
		return false;
	}
}

} // namespace

QwenTtsRuntime::QwenTtsRuntime() = default;
QwenTtsRuntime::~QwenTtsRuntime() = default;

void QwenTtsRuntime::ContextDeleter::operator()(qt_context* context) const noexcept
{
	qt_free(context);
}

RuntimeStatusReport QwenTtsRuntime::status()
{
	return {
		.backend = context_ ? std::optional{backend_} : std::nullopt,
		.modelType = context_ ? std::optional{modelType_} : std::nullopt,
		.runtimeVersion = qt_version(),
	};
}

RuntimeOutcome<RuntimeLoadReport> QwenTtsRuntime::load(const protocol::EngineLoadParams& params)
{
	if (context_ || params.maxBatch != 1 ||
		(params.backend != "auto" && params.backend != compiledBackend)) {
		return std::unexpected{RuntimeError{RuntimeFailure::model_load_failed, "requested backend does not match this engine build"}};
	}
	if (!isReadableRegularFile(params.talkerPath) || !isReadableRegularFile(params.codecPath)) {
		return std::unexpected{RuntimeError{RuntimeFailure::model_load_failed, "talkerPath and codecPath must be readable regular files"}};
	}
	auto modelType = readModelType(params.talkerPath);
	if (!modelType) {
		return std::unexpected{RuntimeError{RuntimeFailure::model_load_failed, modelType.error()}};
	}
	if (::setenv("GGML_BACKEND", backendDevice(), 1) != 0) {
		return std::unexpected{RuntimeError{RuntimeFailure::model_load_failed, "failed to select the compiled GGML backend"}};
	}

	qt_init_params init;
	qt_init_default_params(&init);
	init.talker_path = params.talkerPath.c_str();
	init.codec_path = params.codecPath.c_str();
	init.max_batch = 1;
	context_.reset(qt_init(&init));
	if (!context_) {
		return std::unexpected{RuntimeError{RuntimeFailure::model_load_failed, lastErrorCopy()}};
	}
	backend_ = params.backend;
	modelType_ = std::move(*modelType);
	return RuntimeLoadReport{backend_, modelType_, qt_version()};
}

RuntimeOutcome<void> QwenTtsRuntime::synthesize(
	const protocol::SpeechSynthesizeParams& params,
	CancellationToken& cancellation,
	AudioSink& sink)
{
	if (!context_) {
		return std::unexpected{RuntimeError{RuntimeFailure::synthesis_failed, "model is not loaded"}};
	}
	if (params.sampling.maxNewTokens == 0 || params.sampling.maxNewTokens > INT_MAX) {
		return std::unexpected{RuntimeError{RuntimeFailure::invalid_params, "maxNewTokens is outside the qwentts range"}};
	}

	std::optional<VoiceReferenceData> reference;
	if (params.reference) {
		const int codebookCount = qt_num_codebooks(context_.get());
		if (codebookCount <= 0) {
			return std::unexpected{RuntimeError{RuntimeFailure::synthesis_failed, lastErrorCopy()}};
		}
		auto loaded = readVoiceReference(
			params.reference->speakerPath,
			params.reference->codesPath,
			static_cast<std::uint64_t>(codebookCount));
		if (!loaded) {
			return std::unexpected{RuntimeError{RuntimeFailure::invalid_params, loaded.error()}};
		}
		reference.emplace(std::move(*loaded));
	}

	qt_tts_params synthesis;
	qt_tts_default_params(&synthesis);
	synthesis.text = params.text.c_str();
	synthesis.lang = params.language.c_str();
	synthesis.speaker = params.speaker ? params.speaker->c_str() : nullptr;
	synthesis.instruct = params.instruct ? params.instruct->c_str() : nullptr;
	synthesis.seed = params.sampling.seed;
	synthesis.max_new_tokens = static_cast<int>(params.sampling.maxNewTokens);
	if (reference) {
		synthesis.ref_spk_emb = reference->speaker.data();
		synthesis.ref_spk_dim = static_cast<int>(reference->speaker.size());
		synthesis.ref_codes = reference->codes.data();
		synthesis.ref_T = static_cast<int>(reference->frameCount);
		synthesis.ref_text = params.reference->text.c_str();
	}
	CallbackState callback{cancellation, sink, nullptr};
	synthesis.cancel = cancelCallback;
	synthesis.cancel_user_data = &callback;
	synthesis.on_chunk = audioCallback;
	synthesis.on_chunk_user_data = &callback;

	const qt_status result = qt_synthesize(context_.get(), &synthesis, nullptr);
	const std::string details = lastErrorCopy();
	if (callback.sinkFailure) {
		return std::unexpected{RuntimeError{RuntimeFailure::synthesis_failed, "audio sink rejected a qwentts chunk"}};
	}
	if (result != QT_STATUS_OK) {
		return std::unexpected{mapSynthesisError(result, details)};
	}
	return {};
}

RuntimeOutcome<RuntimeVoiceExtractionReport> QwenTtsRuntime::extractVoice(
	const protocol::VoiceExtractParams& params)
{
	if (!context_) {
		return std::unexpected{RuntimeError{RuntimeFailure::voice_extraction_failed, "model is not loaded"}};
	}
	int sampleCount = 0;
	std::unique_ptr<float, AudioDeleter> audio{audio_read_mono(params.audioPath.c_str(), 24000, &sampleCount)};
	if (!audio || sampleCount <= 0) {
		return std::unexpected{RuntimeError{RuntimeFailure::invalid_params, "failed to decode reference WAV"}};
	}
	qt_voice_ref rawReference{};
	std::unique_ptr<qt_voice_ref, VoiceDeleter> reference{&rawReference};
	const qt_status result = qt_extract_voice_ref(context_.get(), audio.get(), sampleCount, reference.get());
	if (result != QT_STATUS_OK) {
		return std::unexpected{RuntimeError{RuntimeFailure::voice_extraction_failed, lastErrorCopy()}};
	}
	if (rawReference.ref_spk_dim <= 0 || rawReference.ref_T <= 0 || rawReference.num_codebooks <= 0) {
		return std::unexpected{RuntimeError{RuntimeFailure::voice_extraction_failed, "qwentts returned an empty voice reference"}};
	}
	const auto codeCount = static_cast<std::size_t>(rawReference.ref_T) * static_cast<std::size_t>(rawReference.num_codebooks);
	auto written = writeVoiceReference(
		params.speakerOutputPath,
		params.codesOutputPath,
		{rawReference.ref_spk_emb, static_cast<std::size_t>(rawReference.ref_spk_dim)},
		{rawReference.ref_codes, codeCount});
	if (!written) {
		return std::unexpected{RuntimeError{RuntimeFailure::voice_extraction_failed, written.error()}};
	}
	return RuntimeVoiceExtractionReport{
		static_cast<std::uint64_t>(rawReference.ref_spk_dim),
		static_cast<std::uint64_t>(rawReference.num_codebooks),
		static_cast<std::uint64_t>(rawReference.ref_T),
	};
}

void QwenTtsRuntime::shutdown()
{
	context_.reset();
	backend_.clear();
	modelType_.clear();
}

} // namespace voxspeech::engine
