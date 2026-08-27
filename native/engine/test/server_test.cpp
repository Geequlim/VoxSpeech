#include <array>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include <glaze/json.hpp>

#include "voxspeech/engine/fake_runtime.hpp"
#include "voxspeech/engine/pcm.hpp"
#include "voxspeech/engine/protocol.hpp"
#include "voxspeech/engine/server.hpp"

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

// Generic shape used to inspect server output lines in assertions.
struct Envelope {
	std::string jsonrpc;
	std::optional<std::string> id;
	std::optional<std::string> method;
	std::optional<glz::raw_json> params;
	std::optional<glz::raw_json> result;
	std::optional<RpcError> error;
};

constexpr glz::opts envelope_options{
	.error_on_unknown_keys = true,
	.error_on_missing_keys = false,
};

std::optional<Envelope> parseEnvelope(const std::string_view line)
{
	Envelope envelope;
	if (glz::read<envelope_options>(envelope, line)) {
		return std::nullopt;
	}
	return envelope;
}

template<typename Value>
Value parsePart(const glz::raw_json& raw)
{
	Value value;
	const auto error = glz::read<strict_json_options>(value, raw.str);
	if (error) {
		std::string message = "typed payload must parse: ";
		message += glz::format_error(error, raw.str);
		throw std::runtime_error(message);
	}
	return value;
}

std::optional<Envelope> findMessage(const std::vector<std::string>& lines, const std::string_view id)
{
	for (const auto& line : lines) {
		auto envelope = parseEnvelope(line);
		if (envelope && envelope->id == id) {
			return envelope;
		}
	}
	return std::nullopt;
}

// Feeds scripted lines to the server; `@wait` blocks until the server leaves
// loading/busy, and script exhaustion waits for idle before reporting EOF so
// successful jobs finish naturally.
class ScriptSource final : public LineSource {
public:
	ScriptSource(std::vector<std::string> lines, const EngineServer* server)
		: lines_(std::move(lines)), server_(server)
	{
	}

	[[nodiscard]] bool next(std::string& line) override
	{
		while (index_ < lines_.size()) {
			auto entry = std::move(lines_[index_++]);
			if (entry == "@wait") {
				waitForIdle();
				continue;
			}
			line = std::move(entry);
			return true;
		}
		waitForIdle();
		return false;
	}

private:
	void waitForIdle() const
	{
		while (server_->working()) {
			std::this_thread::sleep_for(std::chrono::milliseconds{1});
		}
	}

	std::vector<std::string> lines_;
	std::size_t index_{};
	const EngineServer* server_;
};

struct RunOutcome {
	int exitCode{};
	std::vector<std::string> lines;
	std::string logs;
	std::unique_ptr<FakeRuntime> runtime;
};

RunOutcome runServer(const FakeRuntimeConfig& config, const std::vector<std::string>& script)
{
	auto protocolOutput = std::make_unique<std::ostringstream>();
	auto logOutput = std::make_unique<std::ostringstream>();
	auto runtime = std::make_unique<FakeRuntime>(config, [logs = logOutput.get()](const std::string_view message) {
		*logs << "[fake-runtime] " << message << '\n';
	});
	EngineServer server{*runtime, *protocolOutput, *logOutput};
	ScriptSource source{script, &server};

	RunOutcome outcome;
	outcome.exitCode = server.run(source);
	outcome.runtime = std::move(runtime);
	outcome.logs = logOutput->str();

	std::istringstream reader{protocolOutput->str()};
	std::string line;
	while (std::getline(reader, line)) {
		outcome.lines.push_back(line);
	}
	for (const auto& output : outcome.lines) {
		require(output.starts_with('{') && output.ends_with('}'), "stdout must only contain JSON objects");
		require(parseEnvelope(output).has_value(), "stdout line must be valid protocol JSON");
	}
	return outcome;
}

std::string requestLine(const std::string_view id, const std::string_view method, const std::string_view params)
{
	std::string line = R"({"jsonrpc":"2.0","id":")" + std::string{id} + R"(","method":")" + std::string{method} + R"(")";
	if (!params.empty()) {
		line += ",\"params\":" + std::string{params};
	}
	line += "}";
	return line;
}

const std::string& initializeLine()
{
	static const std::string line = readFixture("messages/initialize.request.json");
	return line;
}

const std::string& loadLine()
{
	static const std::string line = readFixture("messages/engine-load.request.json");
	return line;
}

std::string synthesizeLine(const std::string_view id)
{
	return requestLine(
		id,
		"speech.synthesize",
		R"({"text":"你好","language":"Chinese","speaker":null,"instruct":null,"reference":null,"sampling":{"seed":-1,"maxNewTokens":2048}})");
}

std::string extractLine(const std::string_view id)
{
	return requestLine(
		id,
		"voice.extract",
		R"({"audioPath":"/tmp/ref.wav","speakerOutputPath":"/tmp/speaker.spk.new","codesOutputPath":"/tmp/reference.rvq.new"})");
}

std::vector<float> constantChunk(const std::size_t samples, const float value)
{
	return std::vector<float>(samples, value);
}

FakeRuntimeConfig loadedConfig()
{
	FakeRuntimeConfig config;
	config.synthesis.chunks = {constantChunk(1200, 0.5F)};
	return config;
}

void testGoldenSession()
{
	FakeRuntimeConfig config = loadedConfig();
	config.load.backend = "cuda";

	const auto run = runServer(
		config,
		{initializeLine(),
		 readFixture("messages/engine-status.request.json"),
		 loadLine(),
		 "@wait",
		 synthesizeLine("synth-1"),
		 "@wait",
		 readFixture("messages/voice-extract.request.json"),
		 "@wait",
		 readFixture("messages/engine-shutdown.request.json")});

	require(run.exitCode == 0, "golden session must exit 0");
	require(run.lines.at(0) == readFixture("messages/initialize.result.json"), "initialize result must match fixture");
	require(run.lines.at(1) == readFixture("messages/engine-status.result.json"), "idle status must match fixture");
	require(run.lines.at(2) == readFixture("messages/engine-load.result.json"), "load result must match fixture");
	require(run.lines.at(3) == readFixture("messages/speech-started.notification.json"), "started must match fixture");

	const auto audio = parseEnvelope(run.lines.at(4));
	require(audio && audio->method == "speech.audio", "audio notification expected");
	const auto audioParams = parsePart<SpeechAudioParams>(*audio->params);
	require(audioParams.requestId == "synth-1" && audioParams.sequence == 0, "audio params must match request");
	std::vector<std::uint8_t> decoded;
	require(base64Decode(audioParams.data, decoded) && decoded.size() == 2400, "audio payload must decode to 1200 samples");

	const auto result = parseEnvelope(run.lines.at(5));
	require(result && result->id == "synth-1" && result->result, "synthesis result expected");
	const auto resultPayload = parsePart<SpeechSynthesizeResult>(*result->result);
	require(resultPayload.sampleCount == 1200, "sampleCount must count sink samples");
	require(resultPayload.durationMs == 50, "durationMs must use integer division");

	require(run.lines.at(6) == readFixture("messages/voice-extract.result.json"), "voice extract result must match fixture");
	require(run.lines.back() == readFixture("messages/engine-shutdown.result.json"), "shutdown result must be last and match fixture");
	require(run.runtime->released(), "runtime must be released after shutdown");
}

void testValidationErrors()
{
	const auto run = runServer(
		loadedConfig(),
		{"definitely not json",
		 "123",
		 R"({"jsonrpc":"2.0","id":"","method":"engine.status"})",
		 requestLine("early-1", "engine.status", ""),
		 initializeLine(),
		 initializeLine(),
		 readFixture("cases/unknown-method.request.json"),
		 readFixture("cases/invalid-params.request.json"),
		 R"({"jsonrpc":"2.0","id":"batch-1","method":"engine.load","params":{"talkerPath":"/t.gguf","codecPath":"/c.gguf","backend":"cpu","maxBatch":2}})",
		 readFixture("cases/invalid-version.request.json"),
		 readFixture("messages/engine-shutdown.request.json")});

	require(run.exitCode == 0, "validation session must exit 0");
	require(run.lines.at(0) == R"({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}})", "parse error shape");
	require(run.lines.at(1) == R"({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid request"}})", "invalid request shape");

	const auto emptyId = parseEnvelope(run.lines.at(2));
	require(emptyId && emptyId->error && emptyId->error->code == -32600, "empty id must be an invalid request");

	const auto earlyStatus = parseEnvelope(run.lines.at(3));
	require(earlyStatus && earlyStatus->error && earlyStatus->error->code == -32002, "status before initialize must be invalid_state");
	require(
		earlyStatus->error->data && earlyStatus->error->data->code == "invalid_state" && !earlyStatus->error->data->retryable,
		"invalid_state data");

	require(parseEnvelope(run.lines.at(4))->result.has_value(), "initialize must succeed");
	const auto twice = parseEnvelope(run.lines.at(5));
	require(twice && twice->error && twice->error->code == -32002, "second initialize must be invalid_state");
	require(run.lines.at(6) == readFixture("cases/unknown-method.response.json"), "unknown method must match fixture");
	require(run.lines.at(7) == readFixture("cases/invalid-params.response.json"), "invalid params must match fixture");

	const auto batch = parseEnvelope(run.lines.at(8));
	require(batch && batch->error && batch->error->code == -32602, "maxBatch other than 1 must be invalid params");

	require(run.lines.at(9) == readFixture("cases/invalid-version.response.json"), "version mismatch must match fixture");
	require(run.lines.back() == readFixture("messages/engine-shutdown.result.json"), "shutdown must still work");
}

void testLoadLifecycle()
{
	FakeRuntimeConfig failing = loadedConfig();
	failing.load.ok = false;
	const auto failed = runServer(failing, {initializeLine(), loadLine(), "@wait"});
	require(failed.lines.size() == 2, "failed load session output size");
	const auto error = parseEnvelope(failed.lines.at(1));
	require(error && error->error, "load failure must produce an error response");
	require(error->error->code == -32003, "load failure code");
	require(error->error->message == "Model load failed", "load failure message");
	require(error->error->data && error->error->data->code == "model_load_failed", "load failure stable code");
	require(error->error->data->stage == "engine.load" && !error->error->data->retryable, "load failure data");

	FakeRuntimeConfig slow = loadedConfig();
	slow.load.delayMs = 200;
	const auto slowRun = runServer(
		slow,
		{initializeLine(),
		 loadLine(),
		 requestLine("status-loading", "engine.status", ""),
		 "@wait",
		 requestLine("status-ready", "engine.status", "")});

	const auto loading = findMessage(slowRun.lines, "status-loading");
	require(loading && loading->result, "status during load must succeed");
	auto loadingPayload = parsePart<EngineStatusResult>(*loading->result);
	require(loadingPayload.state == "loading", "state must be loading while the worker loads");

	const auto ready = findMessage(slowRun.lines, "status-ready");
	require(ready && ready->result, "status after load must succeed");
	auto readyPayload = parsePart<EngineStatusResult>(*ready->result);
	require(readyPayload.state == "ready", "state must be ready after load");
	require(readyPayload.backend && *readyPayload.backend == "cpu", "backend must be reported after load");
	require(readyPayload.modelType && *readyPayload.modelType == "base", "modelType must be reported after load");
	require(readyPayload.runtimeVersion == "0.1.0", "runtime version must be reported");
}

void testStreamingSequenceAndTiming()
{
	FakeRuntimeConfig config = loadedConfig();
	config.synthesis.delayMs = 5;
	config.synthesis.chunks = {constantChunk(4800, 0.25F), constantChunk(2400, -0.5F), constantChunk(1200, 0.0F)};

	const auto run = runServer(config, {initializeLine(), loadLine(), "@wait", synthesizeLine("synth-1")});
	require(run.lines.size() == 7, "handshake + started + three audio + result");

	const auto started = parseEnvelope(run.lines.at(2));
	require(started && started->method == "speech.started", "first synthesis message must be started");
	const auto startedParams = parsePart<SpeechStartedParams>(*started->params);
	require(
		startedParams.requestId == "synth-1" && startedParams.encoding == "pcm_s16le" && startedParams.sampleRate == 24000 &&
			startedParams.channels == 1,
		"started params");

	std::uint64_t expectedSequence = 0;
	std::size_t totalDecoded = 0;
	for (std::size_t index = 3; index < 6; ++index) {
		const auto audio = parseEnvelope(run.lines.at(index));
		require(audio && audio->method == "speech.audio", "audio notification expected");
		const auto params = parsePart<SpeechAudioParams>(*audio->params);
		require(params.requestId == "synth-1", "audio must reference the request");
		require(params.sequence == expectedSequence, "audio sequence must be contiguous from zero");
		++expectedSequence;
		std::vector<std::uint8_t> decoded;
		require(base64Decode(params.data, decoded) && !decoded.empty() && decoded.size() % 2 == 0, "audio must decode to PCM bytes");
		require(decoded.size() <= max_audio_chunk_size, "audio chunks must respect the 64 KiB limit");
		require(base64Encode(decoded) == params.data, "audio base64 must be canonical");
		totalDecoded += decoded.size();
	}
	require(totalDecoded == (4800 + 2400 + 1200) * 2, "all sink samples must be streamed");

	const auto result = parseEnvelope(run.lines.at(6));
	const auto payload = parsePart<SpeechSynthesizeResult>(*result->result);
	require(payload.sampleCount == 8400, "sampleCount");
	require(payload.durationMs == 8400 * 1000 / 24000, "durationMs");
	require(payload.firstAudioMs <= payload.processingMs, "firstAudioMs must not exceed processingMs");
}

void testPcmClampAndChunkSplit()
{
	FakeRuntimeConfig config = loadedConfig();
	config.synthesis.chunks = {
		{1.0F, -1.0F, 0.0F, 0.5F, 2.0F, -2.0F, std::numeric_limits<float>::quiet_NaN()},
		constantChunk(40000, 0.25F),
	};

	const auto run = runServer(config, {initializeLine(), loadLine(), "@wait", synthesizeLine("synth-1")});
	// handshake + started + clamp chunk + two split chunks + result
	require(run.lines.size() == 7, "large chunks must split at the 64 KiB boundary");

	std::vector<std::uint8_t> allBytes;
	for (std::size_t index = 3; index < 6; ++index) {
		const auto audio = parseEnvelope(run.lines.at(index));
		const auto params = parsePart<SpeechAudioParams>(*audio->params);
		require(params.sequence == index - 3, "split chunks must keep contiguous sequences");
		std::vector<std::uint8_t> decoded;
		require(base64Decode(params.data, decoded), "audio must decode");
		require(decoded.size() <= max_audio_chunk_size, "no chunk may exceed 64 KiB decoded");
		allBytes.insert(allBytes.end(), decoded.begin(), decoded.end());
	}

	static constexpr std::array<std::uint8_t, 14> expectedHead{
		0xFF, 0x7F, // 1.0 -> 32767
		0x01, 0x80, // -1.0 -> -32767
		0x00, 0x00, // 0.0
		0x00, 0x40, // 0.5 -> 16384 (round to nearest even)
		0xFF, 0x7F, // 2.0 clamped
		0x01, 0x80, // -2.0 clamped
		0x00, 0x00, // NaN treated as silence
	};
	require(allBytes.size() == 14 + 80000, "total PCM bytes");
	require(std::equal(expectedHead.begin(), expectedHead.end(), allBytes.begin()), "clamp and PCM16 little-endian conversion");
	for (std::size_t index = 14; index < allBytes.size(); index += 2) {
		require(allBytes[index] == 0x00 && allBytes[index + 1] == 0x20, "0.25 must convert to 8192");
	}

	const auto result = parseEnvelope(run.lines.at(6));
	const auto payload = parsePart<SpeechSynthesizeResult>(*result->result);
	require(payload.sampleCount == 40007, "sampleCount counts every submitted sample");
}

void testBusyRejectsSecondWork()
{
	FakeRuntimeConfig config = loadedConfig();
	config.synthesis.chunks.clear();
	config.synthesis.chunkCount = 12;
	config.synthesis.samplesPerChunk = 100;
	config.synthesis.delayMs = 60;

	const auto run = runServer(
		config,
		{initializeLine(),
		 loadLine(),
		 "@wait",
		 synthesizeLine("first-1"),
		 synthesizeLine("second-1"),
		 extractLine("extract-1"),
		 requestLine("load-2", "engine.load", R"({"talkerPath":"/t.gguf","codecPath":"/c.gguf","backend":"cpu","maxBatch":1})"),
		 requestLine("status-1", "engine.status", ""),
		 requestLine("cancel-x", "speech.cancel", R"({"requestId":"nobody"})"),
		 "@wait"});

	for (const auto* const id : {"second-1", "extract-1", "load-2"}) {
		const auto rejection = findMessage(run.lines, id);
		require(rejection && rejection->error, "busy work must be rejected");
		require(rejection->error->code == -32007, "busy work must return resource_busy");
		require(rejection->error->data && rejection->error->data->code == "resource_busy", "stable code");
		require(rejection->error->data->retryable, "resource_busy must be retryable");
	}

	const auto status = findMessage(run.lines, "status-1");
	require(status && status->result, "status must stay available while busy");
	require(parsePart<EngineStatusResult>(*status->result).state == "busy", "status during synthesis must report busy");

	const auto cancel = findMessage(run.lines, "cancel-x");
	require(cancel && cancel->result, "cancel must stay available while busy");
	require(!parsePart<SpeechCancelResult>(*cancel->result).accepted, "non-matching cancel must not be accepted");

	auto startedCount = 0;
	for (const auto& line : run.lines) {
		const auto envelope = parseEnvelope(line);
		if (envelope && envelope->method == "speech.started") {
			++startedCount;
		}
	}
	require(startedCount == 1, "only the accepted synthesis may emit started");

	const auto first = parseEnvelope(run.lines.back());
	require(first && first->id == "first-1" && first->result, "first synthesis must finish last");
}

void testCancelAcceptedOnlyForActiveSynthesis()
{
	FakeRuntimeConfig config = loadedConfig();
	config.synthesis.chunks.clear();
	config.synthesis.chunkCount = 10;
	config.synthesis.samplesPerChunk = 50;
	config.synthesis.delayMs = 60;

	const auto run = runServer(
		config,
		{initializeLine(),
		 loadLine(),
		 "@wait",
		 synthesizeLine("synth-1"),
		 requestLine("cancel-wrong", "speech.cancel", R"({"requestId":"other"})"),
		 requestLine("cancel-1", "speech.cancel", R"({"requestId":"synth-1"})"),
		 "@wait"});

	const auto wrong = findMessage(run.lines, "cancel-wrong");
	require(wrong && wrong->result && !parsePart<SpeechCancelResult>(*wrong->result).accepted, "non-matching cancel returns false");
	const auto right = findMessage(run.lines, "cancel-1");
	require(right && right->result && parsePart<SpeechCancelResult>(*right->result).accepted, "matching cancel returns true");

	const auto finalLine = parseEnvelope(run.lines.back());
	require(finalLine && finalLine->id == "synth-1" && finalLine->error, "cancelled synthesis must end with an error");
	require(finalLine->error->code == -32005, "cancelled code");
	require(finalLine->error->data && finalLine->error->data->code == "request_cancelled", "cancelled stable code");
	require(finalLine->error->data->stage == "speech.synthesize" && !finalLine->error->data->retryable, "cancelled data");

	auto audioCount = 0;
	for (const auto& line : run.lines) {
		const auto envelope = parseEnvelope(line);
		if (envelope && envelope->method == "speech.audio") {
			++audioCount;
		}
	}
	require(audioCount < 10, "cancellation must stop audio early");
}

void testSynthesisFailureMappings()
{
	FakeRuntimeConfig failed = loadedConfig();
	failed.synthesis.chunks = {constantChunk(10, 0.5F)};
	failed.synthesis.failure = FakeFailure::synthesis_failed;
	const auto failedRun = runServer(failed, {initializeLine(), loadLine(), "@wait", synthesizeLine("synth-1")});
	require(failedRun.lines.size() == 5, "started + audio + error plus handshake");
	const auto failure = parseEnvelope(failedRun.lines.at(4));
	require(failure && failure->error && failure->error->code == -32004, "synthesis failure code");
	require(failure->error->data && failure->error->data->code == "synthesis_failed" && failure->error->data->retryable,
		"synthesis failure must be retryable");

	FakeRuntimeConfig invalid = loadedConfig();
	invalid.synthesis.failure = FakeFailure::invalid_params;
	invalid.synthesis.chunks.clear();
	const auto invalidRun = runServer(invalid, {initializeLine(), loadLine(), "@wait", synthesizeLine("synth-1")});
	require(invalidRun.lines.size() == 4, "started then error without audio");
	require(parseEnvelope(invalidRun.lines.at(2))->method == "speech.started", "started must still be emitted");
	const auto invalidError = parseEnvelope(invalidRun.lines.at(3));
	require(invalidError && invalidError->error && invalidError->error->code == -32602, "runtime invalid params must map to -32602");

	FakeRuntimeConfig silent = loadedConfig();
	silent.synthesis.failure = FakeFailure::none;
	silent.synthesis.chunks.clear();
	const auto silentRun = runServer(silent, {initializeLine(), loadLine(), "@wait", synthesizeLine("synth-1")});
	require(silentRun.lines.size() == 4, "started + result plus handshake");
	const auto payload = parsePart<SpeechSynthesizeResult>(*parseEnvelope(silentRun.lines.at(3))->result);
	require(payload.sampleCount == 0 && payload.durationMs == 0, "no-audio result counts");
	require(payload.firstAudioMs == payload.processingMs, "no-audio result reuses processingMs as firstAudioMs");
}

void testVoiceExtractResults()
{
	const auto okRun = runServer(loadedConfig(), {initializeLine(), loadLine(), "@wait", extractLine("extract-1"), "@wait"});
	const auto result = findMessage(okRun.lines, "extract-1");
	require(result && result->result, "extract must succeed");
	const auto payload = parsePart<VoiceExtractResult>(*result->result);
	require(payload.speakerDimension == 1024 && payload.codebookCount == 16 && payload.frameCount == 42, "extract result");

	FakeRuntimeConfig failing = loadedConfig();
	failing.extract.ok = false;
	const auto failedRun = runServer(failing, {initializeLine(), loadLine(), "@wait", extractLine("extract-1"), "@wait"});
	const auto error = findMessage(failedRun.lines, "extract-1");
	require(error && error->error && error->error->code == -32006, "extraction failure code");
	require(error->error->data && error->error->data->code == "voice_extraction_failed", "extraction stable code");
	require(error->error->data->stage == "voice.extract" && !error->error->data->retryable, "extraction failure data");
}

void testShutdownOrderingAndInputStop()
{
	FakeRuntimeConfig config = loadedConfig();
	config.synthesis.chunks.clear();
	config.synthesis.chunkCount = 15;
	config.synthesis.samplesPerChunk = 100;
	config.synthesis.delayMs = 50;

	const auto run = runServer(
		config,
		{initializeLine(),
		 loadLine(),
		 "@wait",
		 synthesizeLine("synth-1"),
		 readFixture("messages/engine-shutdown.request.json"),
		 requestLine("ignored-1", "engine.status", "")});

	const auto& lines = run.lines;
	require(run.exitCode == 0, "shutdown session must exit 0");
	require(lines.back() == readFixture("messages/engine-shutdown.result.json"), "shutdown response must be last");

	auto cancelledIndex = std::size_t{};
	auto foundCancelled = false;
	for (std::size_t index = 0; index + 1 < lines.size(); ++index) {
		const auto envelope = parseEnvelope(lines[index]);
		if (envelope && envelope->id == "synth-1" && envelope->error) {
			require(envelope->error->code == -32005, "shutdown must cancel the active synthesis");
			cancelledIndex = index;
			foundCancelled = true;
		}
	}
	require(foundCancelled, "active synthesis must receive a cancelled error");

	auto startedSeen = false;
	for (std::size_t index = 0; index < cancelledIndex; ++index) {
		const auto envelope = parseEnvelope(lines[index]);
		if (envelope && envelope->method == "speech.started") {
			startedSeen = true;
		}
		if (envelope && envelope->method == "speech.audio") {
			require(startedSeen, "audio must follow started");
		}
	}

	const auto ignored = findMessage(lines, "ignored-1");
	require(!ignored.has_value(), "input after shutdown must not be processed");
	require(run.runtime->released(), "shutdown must release the runtime");
	require(run.logs.find("fake runtime released") != std::string::npos, "release must be logged to stderr");
}

void testStdinEofReleasesRuntime()
{
	const auto run = runServer(loadedConfig(), {initializeLine(), loadLine()});
	require(run.exitCode == 0, "EOF shutdown must exit 0");
	require(run.lines.size() == 2, "EOF shutdown must not add responses");
	require(run.runtime->released(), "EOF must release the runtime");
	require(run.logs.find("fake runtime released") != std::string::npos, "release must be logged");
}

} // namespace

int main()
{
	try {
		testGoldenSession();
		testValidationErrors();
		testLoadLifecycle();
		testStreamingSequenceAndTiming();
		testPcmClampAndChunkSplit();
		testBusyRejectsSecondWork();
		testCancelAcceptedOnlyForActiveSynthesis();
		testSynthesisFailureMappings();
		testVoiceExtractResults();
		testShutdownOrderingAndInputStop();
		testStdinEofReleasesRuntime();
	} catch (const std::exception& error) {
		std::cerr << "server test failed: " << error.what() << '\n';
		return 1;
	}
	return 0;
}
