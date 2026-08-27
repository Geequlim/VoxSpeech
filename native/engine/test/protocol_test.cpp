#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>

#include <glaze/json.hpp>

#include "voxspeech/engine/codec.hpp"
#include "voxspeech/engine/dispatcher.hpp"
#include "voxspeech/engine/protocol.hpp"

namespace {

using namespace voxspeech::engine;
using namespace voxspeech::engine::protocol;

const std::filesystem::path fixtureDirectory{VOXSPEECH_PROTOCOL_FIXTURE_DIR};

void require(const bool condition, const std::string_view message)
{
	if (!condition) {
		throw std::runtime_error(std::string{message});
	}
}

std::string readFixture(const std::string_view relativePath)
{
	std::ifstream input{fixtureDirectory / relativePath, std::ios::binary};
	require(input.good(), "fixture could not be opened");
	std::string contents{std::istreambuf_iterator<char>{input}, std::istreambuf_iterator<char>{}};
	while (contents.ends_with('\n') || contents.ends_with('\r')) {
		contents.pop_back();
	}
	return contents;
}

template<typename Type>
void requireFixtureParses(const std::string_view relativePath)
{
	Type value;
	const auto json = readFixture(relativePath);
	require(!glz::read<strict_json_options>(value, json), relativePath);
}

void testGoldenMessages()
{
	requireFixtureParses<InitializeRequest>("messages/initialize.request.json");
	requireFixtureParses<InitializeResponse>("messages/initialize.result.json");
	requireFixtureParses<EngineLoadRequest>("messages/engine-load.request.json");
	requireFixtureParses<EngineLoadResponse>("messages/engine-load.result.json");
	requireFixtureParses<EngineStatusRequest>("messages/engine-status.request.json");
	requireFixtureParses<EngineStatusResponse>("messages/engine-status.result.json");
	requireFixtureParses<SpeechSynthesizeRequest>("messages/speech-synthesize.request.json");
	requireFixtureParses<SpeechStartedNotification>("messages/speech-started.notification.json");
	requireFixtureParses<SpeechAudioNotification>("messages/speech-audio.notification.json");
	requireFixtureParses<SpeechSynthesizeResponse>("messages/speech-synthesize.result.json");
	requireFixtureParses<SpeechCancelRequest>("messages/speech-cancel.request.json");
	requireFixtureParses<SpeechCancelResponse>("messages/speech-cancel.result.json");
	requireFixtureParses<VoiceExtractRequest>("messages/voice-extract.request.json");
	requireFixtureParses<VoiceExtractResponse>("messages/voice-extract.result.json");
	requireFixtureParses<EngineShutdownRequest>("messages/engine-shutdown.request.json");
	requireFixtureParses<EngineShutdownResponse>("messages/engine-shutdown.result.json");
	requireFixtureParses<ErrorResponse>("messages/standard-error.response.json");
	requireFixtureParses<ErrorResponse>("messages/custom-error.response.json");

	for (const std::string_view request : {
			"messages/initialize.request.json",
			"messages/engine-load.request.json",
			"messages/engine-status.request.json",
			"messages/speech-synthesize.request.json",
			"messages/speech-cancel.request.json",
			"messages/voice-extract.request.json",
			"messages/engine-shutdown.request.json",
		}) {
		require(static_cast<bool>(validateRequest(readFixture(request))), request);
	}
}

void testErrorCases()
{
	require(
		validateRequest(readFixture("cases/invalid-version.request.json")).error ==
			DispatchError::protocol_version_mismatch,
		"invalid version must be rejected");
	require(
		validateRequest(readFixture("cases/invalid-params.request.json")).error == DispatchError::invalid_params,
		"invalid params must be rejected");
	require(
		validateRequest(readFixture("cases/unknown-method.request.json")).error == DispatchError::method_not_found,
		"unknown method must be rejected");
	require(validateRequest("{").error == DispatchError::parse_error, "malformed JSON must be a parse error");
	require(
		validateRequest(R"({"jsonrpc":"2.0","id":1,"method":"engine.status"})").error ==
			DispatchError::invalid_request,
		"numeric request IDs must be rejected");
	require(
		validateRequest(R"({"jsonrpc":"2.0","id":"","method":"engine.status"})").error ==
			DispatchError::invalid_request,
		"empty request IDs must be rejected");
	require(
		validateRequest(R"({"jsonrpc":"2.0","id":"1","method":"engine.status","extra":true})").error ==
			DispatchError::invalid_request,
		"unknown request fields must be rejected");
	require(
		validateRequest(
			R"({"jsonrpc":"2.0","id":"1","method":"speech.synthesize","params":{"text":"hello","language":"English","speaker":"aiden","reference":{"speakerPath":"/speaker.spk","codesPath":"/reference.rvq","text":"reference"},"sampling":{"seed":-1,"maxNewTokens":128}}})")
			.error == DispatchError::invalid_params,
		"speaker and reference conditioning must be mutually exclusive");
}

void testFraming()
{
	NdjsonDecoder fragmented;
	auto first = fragmented.push("{\"id\":\"1");
	require(first.messages.empty() && fragmented.bufferedSize() > 0, "partial frame must be buffered");
	auto second = fragmented.push("\"}\n");
	require(second.messages.size() == 1 && second.messages.front() == R"({"id":"1"})", "frame must reassemble");

	NdjsonDecoder multiple;
	auto batch = multiple.push("{\"id\":\"1\"}\n{\"id\":\"2\"}\n");
	require(batch.messages.size() == 2, "multiple frames must be emitted in order");
	require(batch.messages[0] == R"({"id":"1"})" && batch.messages[1] == R"({"id":"2"})", "frame order");

	NdjsonDecoder exact{4};
	require(exact.push("1234\n").error == FrameError::none, "message at size limit must pass");
	NdjsonDecoder oversized{4};
	require(oversized.push("12345").error == FrameError::message_too_large, "buffer over limit must fail");
	require(oversized.failed(), "oversize failure must be terminal");
	require(oversized.push("\n").error == FrameError::message_too_large, "failed decoder must remain failed");

	NdjsonDecoder lateOversized{4};
	require(lateOversized.push("12345\n").error == FrameError::message_too_large, "complete oversized frame must fail");

	NdjsonDecoder protocolLimit;
	const std::string maximum(protocol::max_message_size, 'x');
	require(protocolLimit.push(maximum + "\n").error == FrameError::none, "1 MiB frame must pass");
	NdjsonDecoder aboveProtocolLimit;
	require(
		aboveProtocolLimit.push(maximum + "x").error == FrameError::message_too_large,
		"frame above 1 MiB must fail");
}

void testOutputSeparation()
{
	std::ostringstream protocolOutput;
	std::ostringstream logOutput;
	OutputChannels channels{protocolOutput, logOutput};
	require(channels.writeProtocol(R"({"jsonrpc":"2.0"})"), "valid protocol output must be written");
	channels.writeLog("engine diagnostic");
	require(protocolOutput.str() == "{\"jsonrpc\":\"2.0\"}\n", "stdout channel must contain protocol only");
	require(logOutput.str() == "engine diagnostic\n", "log channel must be separate");
	require(!channels.writeProtocol("{}\n{}"), "embedded LF must be rejected");
	require(!channels.writeProtocol("engine diagnostic"), "non-JSON output must be rejected");
	require(!channels.writeProtocol("{broken}"), "malformed JSON output must be rejected");
}

} // namespace

int main()
{
	try {
		testGoldenMessages();
		testErrorCases();
		testFraming();
		testOutputSeparation();
	} catch (const std::exception& error) {
		std::cerr << "protocol test failed: " << error.what() << '\n';
		return 1;
	}
	return 0;
}
