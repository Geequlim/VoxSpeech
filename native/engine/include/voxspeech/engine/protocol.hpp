#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>

#include <glaze/json.hpp>

namespace voxspeech::engine::protocol {

inline constexpr std::uint32_t version = 1;
inline constexpr std::size_t max_message_size = 1024U * 1024U;
inline constexpr std::size_t max_audio_chunk_size = 64U * 1024U;

inline constexpr glz::opts strict_json_options{
	.error_on_unknown_keys = true,
	.error_on_missing_keys = true,
};

struct ClientInfo {
	std::string name;
	std::string version;
};

struct ServerInfo {
	std::string name;
	std::string version;
};

struct Capabilities {
	bool streamingAudio;
	bool voiceExtraction;
};

struct InitializeParams {
	std::uint32_t protocolVersion;
	ClientInfo clientInfo;
};

struct InitializeResult {
	std::uint32_t protocolVersion;
	ServerInfo serverInfo;
	Capabilities capabilities;
};

struct EmptyParams {};

struct EngineLoadParams {
	std::string talkerPath;
	std::string codecPath;
	std::string backend;
	std::uint32_t maxBatch;
};

struct EngineLoadResult {
	std::string backend;
	std::string modelType;
	std::string runtimeVersion;
};

struct EngineStatusResult {
	std::string state;
	std::optional<std::string> backend;
	std::optional<std::string> modelType;
	std::string runtimeVersion;
};

struct VoiceReference {
	std::string speakerPath;
	std::string codesPath;
	std::string text;
};

struct SamplingOptions {
	std::int64_t seed;
	std::uint32_t maxNewTokens;
};

struct SpeechSynthesizeParams {
	std::string text;
	std::string language;
	std::optional<std::string> speaker;
	std::optional<std::string> instruct;
	std::optional<VoiceReference> reference;
	SamplingOptions sampling;
};

struct SpeechSynthesizeResult {
	std::uint64_t sampleCount;
	std::uint64_t durationMs;
	std::uint64_t firstAudioMs;
	std::uint64_t processingMs;
};

struct SpeechCancelParams {
	std::string requestId;
};

struct SpeechCancelResult {
	bool accepted;
};

struct VoiceExtractParams {
	std::string audioPath;
	std::string speakerOutputPath;
	std::string codesOutputPath;
};

struct VoiceExtractResult {
	std::uint64_t speakerDimension;
	std::uint64_t codebookCount;
	std::uint64_t frameCount;
};

struct EngineShutdownResult {
	bool accepted;
};

struct SpeechStartedParams {
	std::string requestId;
	std::string encoding;
	std::uint32_t sampleRate;
	std::uint32_t channels;
};

struct SpeechAudioParams {
	std::string requestId;
	std::uint64_t sequence;
	std::string data;
};

struct ErrorData {
	std::string code;
	std::string stage;
	bool retryable;
	std::optional<std::string> details;
};

struct RpcError {
	std::int32_t code;
	std::string message;
	std::optional<ErrorData> data;
};

template<typename Params>
struct Request {
	std::string jsonrpc;
	std::string id;
	std::string method;
	Params params;
};

template<typename Params>
struct RequestWithOptionalParams {
	std::string jsonrpc;
	std::string id;
	std::string method;
	std::optional<Params> params;
};

template<typename Params>
struct Notification {
	std::string jsonrpc;
	std::string method;
	Params params;
};

template<typename Result>
struct SuccessResponse {
	std::string jsonrpc;
	std::string id;
	Result result;
};

struct ErrorResponse {
	std::string jsonrpc;
	std::optional<std::string> id;
	RpcError error;
};

struct RequestEnvelope {
	std::string jsonrpc;
	std::string id;
	std::string method;
	std::optional<glz::raw_json> params;
};

using InitializeRequest = Request<InitializeParams>;
using EngineLoadRequest = Request<EngineLoadParams>;
using EngineStatusRequest = RequestWithOptionalParams<EmptyParams>;
using SpeechSynthesizeRequest = Request<SpeechSynthesizeParams>;
using SpeechCancelRequest = Request<SpeechCancelParams>;
using VoiceExtractRequest = Request<VoiceExtractParams>;
using EngineShutdownRequest = RequestWithOptionalParams<EmptyParams>;

using SpeechStartedNotification = Notification<SpeechStartedParams>;
using SpeechAudioNotification = Notification<SpeechAudioParams>;

using InitializeResponse = SuccessResponse<InitializeResult>;
using EngineLoadResponse = SuccessResponse<EngineLoadResult>;
using EngineStatusResponse = SuccessResponse<EngineStatusResult>;
using SpeechSynthesizeResponse = SuccessResponse<SpeechSynthesizeResult>;
using SpeechCancelResponse = SuccessResponse<SpeechCancelResult>;
using VoiceExtractResponse = SuccessResponse<VoiceExtractResult>;
using EngineShutdownResponse = SuccessResponse<EngineShutdownResult>;

} // namespace voxspeech::engine::protocol
