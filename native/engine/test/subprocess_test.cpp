#include <sys/wait.h>
#include <unistd.h>

#include <fcntl.h>

#include <array>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include <glaze/json.hpp>

#include "voxspeech/engine/pcm.hpp"
#include "voxspeech/engine/protocol.hpp"

namespace {

using namespace voxspeech::engine::protocol;

const std::filesystem::path fixtureDirectory{VOXSPEECH_PROTOCOL_FIXTURE_DIR};
const std::string fixtureExecutable{VOXSPEECH_ENGINE_FIXTURE};

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
	require(!glz::read<strict_json_options>(value, raw.str), "typed payload must parse");
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

// Fixture process connected through real pipes. Input can be written in
// stages so tests can interleave requests with streaming progress.
class ChildProcess {
public:
	explicit ChildProcess(const std::string& scenarioPath)
	{
		require(::pipe2(stdinPipes_, O_CLOEXEC) == 0, "stdin pipe");
		require(::pipe2(stdoutPipes_, O_CLOEXEC) == 0, "stdout pipe");
		require(::pipe2(stderrPipes_, O_CLOEXEC) == 0, "stderr pipe");

		const auto pid = ::fork();
		require(pid >= 0, "fork");
		if (pid == 0) {
			runChild(scenarioPath);
		}
		pid_ = pid;
		::close(stdinPipes_[0]);
		::close(stdoutPipes_[1]);
		::close(stderrPipes_[1]);
	}

	~ChildProcess()
	{
		if (stdinPipes_[1] >= 0) {
			::close(stdinPipes_[1]);
		}
		if (!collected_) {
			::kill(pid_, SIGKILL);
			int status = 0;
			::waitpid(pid_, &status, 0);
		}
	}

	ChildProcess(const ChildProcess&) = delete;
	ChildProcess& operator=(const ChildProcess&) = delete;

	void write(const std::string_view data) const
	{
		std::size_t written = 0;
		while (written < data.size()) {
			const auto count = ::write(stdinPipes_[1], data.data() + written, data.size() - written);
			if (count < 0) {
				if (errno == EINTR) {
					continue;
				}
				// EPIPE: the fixture already exited and stopped reading.
				return;
			}
			written += static_cast<std::size_t>(count);
		}
	}

	void closeInput()
	{
		::close(stdinPipes_[1]);
		stdinPipes_[1] = -1;
	}

	// Blocks until one full NDJSON line arrived from the fixture.
	std::string readLine()
	{
		while (readBuffer_.find('\n') == std::string::npos) {
			char buffer[4096];
			const auto count = ::read(stdoutPipes_[0], buffer, sizeof buffer);
			if (count < 0) {
				if (errno == EINTR) {
					continue;
				}
				break;
			}
			if (count == 0) {
				break;
			}
			readBuffer_.append(buffer, static_cast<std::size_t>(count));
		}
		const auto newline = readBuffer_.find('\n');
		if (newline == std::string::npos) {
			throw std::runtime_error("fixture closed stdout before a full line arrived");
		}
		std::string line = readBuffer_.substr(0, newline);
		readBuffer_.erase(0, newline + 1);
		return line;
	}

	void collect()
	{
		require(!collected_, "child already collected");
		collected_ = true;
		stdoutText = readBuffer_ + readAll(stdoutPipes_[0]);
		stderrText = readAll(stderrPipes_[0]);
		int status = 0;
		require(::waitpid(pid_, &status, 0) == pid_, "waitpid");
		require(WIFEXITED(status), "fixture must exit normally");
		exitCode = WEXITSTATUS(status);
	}

	std::string stdoutText;
	std::string stderrText;
	int exitCode{-1};

private:
	[[noreturn]] void runChild(const std::string& scenarioPath) const
	{
		::dup2(stdinPipes_[0], STDIN_FILENO);
		::dup2(stdoutPipes_[1], STDOUT_FILENO);
		::dup2(stderrPipes_[1], STDERR_FILENO);
		::setenv("VOXSPEECH_ENGINE_SCENARIO", scenarioPath.c_str(), 1);
		std::array<char*, 2> argv{const_cast<char*>(fixtureExecutable.c_str()), nullptr};
		::execv(fixtureExecutable.c_str(), argv.data());
		::_exit(127);
	}

	static std::string readAll(const int fd)
	{
		std::string text;
		char buffer[4096];
		while (true) {
			const auto count = ::read(fd, buffer, sizeof buffer);
			if (count < 0) {
				if (errno == EINTR) {
					continue;
				}
				break;
			}
			if (count == 0) {
				break;
			}
			text.append(buffer, static_cast<std::size_t>(count));
		}
		return text;
	}

	pid_t pid_{-1};
	int stdinPipes_[2]{};
	int stdoutPipes_[2]{};
	int stderrPipes_[2]{};
	bool collected_{false};
	std::string readBuffer_;
};

std::vector<std::string> splitLines(const std::string& text)
{
	std::vector<std::string> lines;
	std::string current;
	for (const char c : text) {
		if (c == '\n') {
			lines.push_back(std::move(current));
			current.clear();
		}
		else {
			current.push_back(c);
		}
	}
	if (!current.empty()) {
		lines.push_back(std::move(current));
	}
	return lines;
}

std::filesystem::path writeScenario(const std::string_view name, const std::string_view json)
{
	const auto path = std::filesystem::temp_directory_path() / ("voxspeech-engine-fixture-" + std::string{name} + ".json");
	std::ofstream output{path, std::ios::binary | std::ios::trunc};
	require(output.good(), "scenario file could not be created");
	output << json;
	require(output.good(), "scenario file could not be written");
	return path;
}

std::string requestLine(const std::string_view id, const std::string_view method, const std::string_view params)
{
	return R"({"jsonrpc":"2.0","id":")" + std::string{id} + R"(","method":")" + std::string{method} + R"(","params":)" +
		std::string{params} + "}\n";
}

void requireEveryLineIsProtocolJson(const std::vector<std::string>& lines)
{
	for (const auto& line : lines) {
		require(line.starts_with('{') && line.ends_with('}'), "stdout must only contain JSON objects");
		require(parseEnvelope(line).has_value(), "stdout must stay pure NDJSON");
	}
}

void testFullSessionOverPipes()
{
	const auto scenario = writeScenario(
		"full",
		R"({
			"load": {"ok": true, "backend": "cuda", "modelType": "base", "runtimeVersion": "0.1.0", "delayMs": 0},
			"synthesis": {"failure": "none", "chunkCount": 30, "samplesPerChunk": 1200, "amplitude": 0.5, "delayMs": 40},
			"extract": {"ok": true, "speakerDimension": 1024, "codebookCount": 16, "frameCount": 42, "delayMs": 0}
		})");

	std::vector<std::string> lines;
	ChildProcess child{scenario.string()};

	child.write(std::string{readFixture("messages/initialize.request.json")} + "\n");
	lines.push_back(child.readLine());
	child.write(readFixture("messages/engine-status.request.json") + "\n");
	lines.push_back(child.readLine());
	child.write(readFixture("messages/engine-load.request.json") + "\n");
	lines.push_back(child.readLine());
	// Reading the load response synchronizes with load completion.
	child.write(
		requestLine(
			"synth-1",
			"speech.synthesize",
			R"({"text":"你好","language":"Chinese","speaker":null,"instruct":null,"reference":null,"sampling":{"seed":-1,"maxNewTokens":2048}})"
		) +
		"\n");
	lines.push_back(child.readLine());

	require(lines.at(0) == readFixture("messages/initialize.result.json"), "initialize result");
	require(lines.at(1) == readFixture("messages/engine-status.result.json"), "idle status result");
	require(lines.at(2) == readFixture("messages/engine-load.result.json"), "load result");
	require(lines.at(3) == readFixture("messages/speech-started.notification.json"), "started notification");

	// Let a few chunks stream before the busy probe and cancellation land.
	std::this_thread::sleep_for(std::chrono::milliseconds{250});
	child.write(
		requestLine(
			"synth-2",
			"speech.synthesize",
			R"({"text":"第二段","language":"Chinese","speaker":null,"instruct":null,"reference":null,"sampling":{"seed":-1,"maxNewTokens":2048}})"
		) +
		requestLine("cancel-wrong", "speech.cancel", R"({"requestId":"nobody"})") +
		std::string{readFixture("messages/speech-cancel.request.json")} + "\n" +
		readFixture("messages/engine-shutdown.request.json") + "\n");
	child.closeInput();
	child.collect();

	const auto remainder = splitLines(child.stdoutText);
	lines.insert(lines.end(), remainder.begin(), remainder.end());

	require(child.exitCode == 0, "full session must exit 0");
	requireEveryLineIsProtocolJson(lines);
	require(lines.size() >= 8, "session must produce the full exchange");

	const auto busy = findMessage(lines, "synth-2");
	require(busy && busy->error && busy->error->code == -32007, "second synthesis must be resource_busy");

	const auto wrongCancel = findMessage(lines, "cancel-wrong");
	require(wrongCancel && wrongCancel->result && !parsePart<SpeechCancelResult>(*wrongCancel->result).accepted,
		"non-matching cancel must return false");

	auto cancelLine = std::optional<std::size_t>{};
	for (std::size_t index = 4; index < lines.size(); ++index) {
		const auto envelope = parseEnvelope(lines[index]);
		if (envelope && envelope->id == "cancel-1") {
			cancelLine = index;
		}
	}
	require(cancelLine.has_value(), "matching cancel must be answered");
	require(lines[*cancelLine] == readFixture("messages/speech-cancel.result.json"), "matching cancel must match the fixture");

	auto lastAudioIndex = std::size_t{};
	auto audioCount = 0;
	std::uint64_t expectedSequence = 0;
	for (std::size_t index = 4; index < lines.size(); ++index) {
		const auto envelope = parseEnvelope(lines[index]);
		if (!envelope || envelope->method != "speech.audio") {
			continue;
		}
		const auto params = parsePart<SpeechAudioParams>(*envelope->params);
		require(params.requestId == "synth-1", "audio must reference the active request");
		require(params.sequence == expectedSequence, "audio sequences must be contiguous from zero");
		++expectedSequence;
		std::vector<std::uint8_t> decoded;
		require(
			voxspeech::engine::base64Decode(params.data, decoded) && !decoded.empty() && decoded.size() % 2 == 0 &&
				decoded.size() <= max_audio_chunk_size,
			"audio must decode into bounded PCM chunks");
		lastAudioIndex = index;
		++audioCount;
	}
	require(audioCount > 0 && audioCount < 30, "cancellation must stop audio early");
	require(lastAudioIndex < lines.size() - 2, "audio must precede the final response");

	const auto cancelled = findMessage(lines, "synth-1");
	require(cancelled && cancelled->error && cancelled->error->code == -32005, "cancelled synthesis error");
	require(lines.back() == readFixture("messages/engine-shutdown.result.json"), "shutdown result must be last");
	require(child.stderrText.find("fake runtime released") != std::string::npos, "runtime release must be logged to stderr");
}

void testStdinEofShutdown()
{
	const auto scenario = writeScenario(
		"eof",
		R"({
			"load": {"ok": true, "backend": "cpu", "modelType": "base", "runtimeVersion": "0.1.0", "delayMs": 0},
			"synthesis": {"failure": "none", "chunkCount": 20, "samplesPerChunk": 600, "amplitude": 0.5, "delayMs": 50}
		})");

	ChildProcess child{scenario.string()};
	child.write(std::string{readFixture("messages/initialize.request.json")} + "\n");
	require(child.readLine() == readFixture("messages/initialize.result.json"), "initialize before EOF");
	child.write(readFixture("messages/engine-load.request.json") + "\n");
	const auto loadLine = child.readLine();
	const auto loadEnvelope = parseEnvelope(loadLine);
	require(loadEnvelope && loadEnvelope->id == "load-1" && loadEnvelope->result, "load before EOF");
	require(parsePart<EngineLoadResult>(*loadEnvelope->result).backend == "cpu", "load backend before EOF");
	child.write(
		requestLine(
			"synth-1",
			"speech.synthesize",
			R"({"text":"你好","language":"Chinese","speaker":null,"instruct":null,"reference":null,"sampling":{"seed":-1,"maxNewTokens":2048}})"
		) + "\n");
	const auto startedEnvelope = parseEnvelope(child.readLine());
	require(startedEnvelope && startedEnvelope->method == "speech.started", "started before EOF");
	require(parsePart<SpeechStartedParams>(*startedEnvelope->params).requestId == "synth-1", "started request id");

	// Stream a little audio, then drop the pipe: EOF must cancel the synthesis.
	std::this_thread::sleep_for(std::chrono::milliseconds{150});
	child.closeInput();
	child.collect();

	const auto lines = splitLines(child.stdoutText);

	require(child.exitCode == 0, "EOF shutdown must exit 0");
	requireEveryLineIsProtocolJson(lines);
	require(lines.size() >= 4, "EOF session output size");
	const auto cancelled = parseEnvelope(lines.back());
	require(cancelled && cancelled->id == "synth-1" && cancelled->error && cancelled->error->code == -32005,
		"EOF must cancel the active synthesis and report it last");
	require(child.stderrText.find("fake runtime released") != std::string::npos, "EOF must release the runtime");
}

void testOversizedInputIsTerminal()
{
	const auto scenario = writeScenario("oversize", "{}");

	std::string input = std::string(1024U * 1024U + 2U, 'x');
	input += "\n";

	ChildProcess child{scenario.string()};
	child.write(std::string{readFixture("messages/initialize.request.json")} + "\n");
	require(child.readLine() == readFixture("messages/initialize.result.json"), "initialize before oversize");
	child.write(input);
	child.closeInput();
	child.collect();

	const auto lines = splitLines(child.stdoutText);

	require(child.exitCode == 1, "oversized input must exit with a failure code");
	requireEveryLineIsProtocolJson(lines);
	require(lines.empty(), "no output is allowed after a framing failure");
	require(child.stderrText.find("framing") != std::string::npos, "framing failure must be logged to stderr");
}

} // namespace

int main()
{
	std::signal(SIGPIPE, SIG_IGN);
	try {
		testFullSessionOverPipes();
		testStdinEofShutdown();
		testOversizedInputIsTerminal();
	} catch (const std::exception& error) {
		std::cerr << "subprocess test failed: " << error.what() << '\n';
		return 1;
	}
	return 0;
}
