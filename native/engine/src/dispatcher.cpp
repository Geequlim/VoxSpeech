#include "voxspeech/engine/dispatcher.hpp"

#include <array>
#include <string>

#include <glaze/json.hpp>

#include "voxspeech/engine/protocol.hpp"

namespace voxspeech::engine {
namespace {

using namespace protocol;

template<typename RequestType>
bool parsesAs(const std::string_view json)
{
	RequestType request;
	return !glz::read<strict_json_options>(request, json);
}

bool isKnownMethod(const std::string_view method)
{
	constexpr std::array methods{
		"initialize",
		"engine.load",
		"engine.status",
		"speech.synthesize",
		"speech.cancel",
		"voice.extract",
		"engine.shutdown",
	};
	for (const std::string_view candidate : methods) {
		if (candidate == method) {
			return true;
		}
	}
	return false;
}

bool hasValidParams(const std::string_view method, const std::string_view json)
{
	if (method == "initialize") {
		InitializeRequest request;
		if (glz::read<strict_json_options>(request, json)) {
			return false;
		}
		return !request.params.clientInfo.name.empty() && !request.params.clientInfo.version.empty();
	}
	if (method == "engine.load") {
		EngineLoadRequest request;
		if (glz::read<strict_json_options>(request, json)) {
			return false;
		}
		const auto& params = request.params;
		const bool validBackend = params.backend == "auto" || params.backend == "cuda" ||
			params.backend == "vulkan" || params.backend == "cpu";
		return !params.talkerPath.empty() && !params.codecPath.empty() && validBackend && params.maxBatch >= 1;
	}
	if (method == "engine.status") {
		return parsesAs<EngineStatusRequest>(json);
	}
	if (method == "speech.synthesize") {
		SpeechSynthesizeRequest request;
		if (glz::read<strict_json_options>(request, json)) {
			return false;
		}
		const auto& params = request.params;
		const bool speakerValid = !params.speaker || !params.speaker->empty();
		const bool instructValid = !params.instruct || !params.instruct->empty();
		const bool referenceValid = !params.reference ||
			(!params.reference->speakerPath.empty() && !params.reference->codesPath.empty() &&
				!params.reference->text.empty());
		return !params.text.empty() && !params.language.empty() && params.sampling.maxNewTokens > 0 && speakerValid &&
			instructValid && referenceValid && !(params.speaker && params.reference);
	}
	if (method == "speech.cancel") {
		SpeechCancelRequest request;
		return !glz::read<strict_json_options>(request, json) && !request.params.requestId.empty();
	}
	if (method == "voice.extract") {
		VoiceExtractRequest request;
		if (glz::read<strict_json_options>(request, json)) {
			return false;
		}
		return !request.params.audioPath.empty() && !request.params.speakerOutputPath.empty() &&
			!request.params.codesOutputPath.empty();
	}
	if (method == "engine.shutdown") {
		return parsesAs<EngineShutdownRequest>(json);
	}
	return false;
}

} // namespace

DispatchResult validateRequest(const std::string_view json)
{
	RequestEnvelope envelope;
	const auto parseError = glz::read<strict_json_options>(envelope, json);
	if (parseError) {
		glz::generic syntaxProbe;
		if (glz::read_json(syntaxProbe, json)) {
			return {.error = DispatchError::parse_error, .details = "invalid JSON"};
		}
		return {.error = DispatchError::invalid_request, .details = "invalid JSON-RPC request"};
	}

	DispatchResult result{.id = envelope.id, .method = envelope.method};
	if (envelope.jsonrpc != "2.0" || envelope.id.empty() || envelope.method.empty()) {
		result.error = DispatchError::invalid_request;
		result.details = "jsonrpc must be 2.0 and id/method must be non-empty strings";
		return result;
	}
	if (!isKnownMethod(envelope.method)) {
		result.error = DispatchError::method_not_found;
		result.details = "unknown engine method";
		return result;
	}
	if (!hasValidParams(envelope.method, json)) {
		result.error = DispatchError::invalid_params;
		result.details = "params do not match the method schema";
		return result;
	}
	if (envelope.method == "initialize") {
		InitializeRequest request;
		(void)glz::read<strict_json_options>(request, json);
		if (request.params.protocolVersion != version) {
			result.error = DispatchError::protocol_version_mismatch;
			result.details = "unsupported protocol version";
		}
	}
	return result;
}

} // namespace voxspeech::engine
