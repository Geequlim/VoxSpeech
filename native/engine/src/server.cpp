#include "voxspeech/engine/server.hpp"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <variant>

#include <unistd.h>

#include <glaze/json.hpp>

#include "voxspeech/engine/dispatcher.hpp"
#include "voxspeech/engine/pcm.hpp"

namespace voxspeech::engine {
namespace {

using namespace protocol;

constexpr std::string_view serverName = "voxspeech-engine";
constexpr std::string_view serverVersion = "0.1.0";

constexpr glz::opts compact_json{};
constexpr glz::opts compact_json_nulls{.skip_null_members = false};

enum class EngineState {
	starting,
	idle,
	loading,
	ready,
	busy,
	stopping,
};

std::string_view toStateName(const EngineState state)
{
	switch (state) {
	case EngineState::starting: return "starting";
	case EngineState::idle: return "idle";
	case EngineState::loading: return "loading";
	case EngineState::ready: return "ready";
	case EngineState::busy: return "busy";
	case EngineState::stopping: return "stopping";
	}
	return "starting";
}

template<auto Opts = compact_json, typename Value>
std::string writeJson(const Value& value)
{
	std::string buffer;
	if (glz::write<Opts>(value, buffer)) {
		throw std::runtime_error("JSON-RPC serialization failed");
	}
	return buffer;
}

template<typename RequestType>
std::optional<RequestType> parseRequest(const std::string_view frame)
{
	RequestType request;
	if (glz::read<strict_json_options>(request, frame)) {
		return std::nullopt;
	}
	return request;
}

RpcError standardError(const std::int32_t code, const std::string_view message)
{
	return {.code = code, .message = std::string{message}, .data = std::nullopt};
}

RpcError customError(
	const std::int32_t code,
	const std::string_view message,
	const std::string_view stableCode,
	const std::string_view stage,
	const bool retryable,
	std::string details)
{
	if (details.empty()) {
		details = message;
	}
	return {
		.code = code,
		.message = std::string{message},
		.data = ErrorData{.code = std::string{stableCode}, .stage = std::string{stage}, .retryable = retryable, .details = std::move(details)},
	};
}

RpcError invalidStateError(const std::string_view method, const std::string_view stateText)
{
	return customError(-32002, "Invalid state", "invalid_state", method, false, "engine state is " + std::string{stateText});
}

RpcError resourceBusyError(const std::string_view method)
{
	return customError(-32007, "Resource busy", "resource_busy", method, true, "another job is currently running");
}

RpcError mapRuntimeError(const std::string_view stage, const RuntimeError& error)
{
	switch (error.kind) {
	case RuntimeFailure::invalid_params: return standardError(-32602, "Invalid params");
	case RuntimeFailure::model_load_failed:
		return customError(-32003, "Model load failed", "model_load_failed", stage, false, error.details);
	case RuntimeFailure::synthesis_failed:
		return customError(-32004, "Synthesis failed", "synthesis_failed", stage, true, error.details);
	case RuntimeFailure::cancelled:
		return customError(-32005, "Request cancelled", "request_cancelled", stage, false, error.details);
	case RuntimeFailure::voice_extraction_failed:
		return customError(-32006, "Voice extraction failed", "voice_extraction_failed", stage, false, error.details);
	}
	return standardError(-32603, "Internal error");
}

// Serializes float32 chunks into speech.audio notifications. Runs entirely on
// the worker thread; all I/O is deferred to the ordered writer queue.
class SynthesisSink final : public AudioSink {
public:
	using Emit = std::function<void(std::string)>;

	SynthesisSink(Emit emit, std::string requestId)
		: emit_(std::move(emit)), requestId_(std::move(requestId))
	{
	}

	void submit(const std::span<const float> samples) override
	{
		if (samples.empty()) {
			return;
		}
		if (!firstAudioAt) {
			firstAudioAt = std::chrono::steady_clock::now();
		}
		sampleCount += samples.size();
		const auto bytes = floatsToPcm16Le(samples);
		for (std::size_t offset = 0; offset < bytes.size();) {
			const auto count = std::min(bytes.size() - offset, max_audio_chunk_size);
			const std::span<const std::uint8_t> part{bytes.data() + offset, count};
			const SpeechAudioNotification notification{
				.jsonrpc = "2.0",
				.method = "speech.audio",
				.params = {requestId_, nextSequence_++, base64Encode(part)},
			};
			emit_(writeJson(notification));
			offset += count;
		}
	}

	std::uint64_t sampleCount{};
	std::optional<std::chrono::steady_clock::time_point> firstAudioAt{};

private:
	Emit emit_;
	std::string requestId_;
	std::uint64_t nextSequence_{};
};

std::uint64_t elapsedMs(
	const std::chrono::steady_clock::time_point start, const std::chrono::steady_clock::time_point end)
{
	return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count());
}

struct LoadJob {
	EngineLoadParams params;
};

struct SynthesisJob {
	SpeechSynthesizeParams params;
	std::shared_ptr<CancellationToken> token;
};

struct ExtractionJob {
	VoiceExtractParams params;
};

struct Job {
	std::string requestId;
	std::variant<LoadJob, SynthesisJob, ExtractionJob> work;
};

} // namespace

FdLineSource::FdLineSource(const int fileDescriptor)
	: fileDescriptor_(fileDescriptor)
{
}

bool FdLineSource::next(std::string& line)
{
	while (pending_.empty()) {
		if (decoder_.failed()) {
			return false;
		}
		char chunk[16384];
		ssize_t readCount = 0;
		do {
			readCount = ::read(fileDescriptor_, chunk, sizeof chunk);
		} while (readCount < 0 && errno == EINTR);
		if (readCount <= 0) {
			return false;
		}
		auto batch = decoder_.push(std::string_view{chunk, static_cast<std::size_t>(readCount)});
		pending_ = std::move(batch.messages);
	}
	line = std::move(pending_.front());
	pending_.erase(pending_.begin());
	return true;
}

bool FdLineSource::failed() const
{
	return decoder_.failed();
}

struct EngineServer::Impl {
	Runtime& runtime;
	OutputChannels channels;
	std::string runtimeVersionSnapshot;

	mutable std::mutex stateMutex;
	EngineState state{EngineState::starting};
	std::string activeSynthesisId;
	std::shared_ptr<CancellationToken> activeToken;
	bool loaded{false};
	EngineLoadResult loadedReport{};

	std::mutex jobMutex;
	std::condition_variable jobCv;
	std::optional<Job> pendingJob;
	bool workerStop{false};
	std::thread workerThread;

	std::mutex writerMutex;
	std::condition_variable writerCv;
	std::deque<std::string> writerQueue;
	bool writerClosed{false};
	std::thread writerThread;

	Impl(Runtime& runtimeRef, std::ostream& protocolOutput, std::ostream& logOutput)
		: runtime(runtimeRef), channels(protocolOutput, logOutput)
	{
	}

	~Impl()
	{
		{
			std::lock_guard lock{jobMutex};
			workerStop = true;
		}
		jobCv.notify_all();
		if (workerThread.joinable()) {
			workerThread.join();
		}
		closeWriter();
	}

	void log(const std::string_view message)
	{
		channels.writeLog(std::string{"[voxspeech-engine] "} + std::string{message});
	}

	void enqueue(std::string json)
	{
		{
			std::lock_guard lock{writerMutex};
			writerQueue.push_back(std::move(json));
		}
		writerCv.notify_all();
	}

	void writerLoop()
	{
		std::unique_lock lock{writerMutex};
		while (true) {
			writerCv.wait(lock, [this] { return writerClosed || !writerQueue.empty(); });
			while (!writerQueue.empty()) {
				auto message = std::move(writerQueue.front());
				writerQueue.pop_front();
				lock.unlock();
				if (!channels.writeProtocol(message)) {
					log("protocol output rejected");
				}
				lock.lock();
			}
			if (writerClosed && writerQueue.empty()) {
				return;
			}
		}
	}

	void closeWriter()
	{
		{
			std::lock_guard lock{writerMutex};
			writerClosed = true;
		}
		writerCv.notify_all();
		if (writerThread.joinable()) {
			writerThread.join();
		}
	}

	[[nodiscard]] std::string errorResponseKnownId(const std::string& id, const RpcError& error)
	{
		return writeJson(ErrorResponse{.jsonrpc = "2.0", .id = id, .error = error});
	}

	// Error responses whose request id could not be determined must carry an
	// explicit null id while still omitting an absent error.data, so the error
	// member is serialized on its own.
	[[nodiscard]] std::string errorResponseNullId(const RpcError& error)
	{
		std::string errorPart;
		if (glz::write<compact_json>(error, errorPart)) {
			throw std::runtime_error("JSON-RPC serialization failed");
		}
		return std::string{R"({"jsonrpc":"2.0","id":null,"error":)"} + errorPart + "}";
	}

	void postJob(Job&& job)
	{
		{
			std::lock_guard lock{jobMutex};
			if (pendingJob) {
				log("internal error: a job was posted while the worker was occupied");
				return;
			}
			pendingJob.emplace(std::move(job));
		}
		jobCv.notify_all();
	}

	void workerLoop()
	{
		std::unique_lock lock{jobMutex};
		while (true) {
			jobCv.wait(lock, [this] { return workerStop || pendingJob.has_value(); });
			if (!pendingJob.has_value()) {
				return;
			}
			Job job = std::move(*pendingJob);
			pendingJob.reset();
			lock.unlock();
			executeJob(job);
			lock.lock();
		}
	}

	void executeJob(const Job& job)
	{
		if (std::holds_alternative<LoadJob>(job.work)) {
			executeLoad(job);
		}
		else if (std::holds_alternative<SynthesisJob>(job.work)) {
			executeSynthesis(job);
		}
		else {
			executeExtraction(job);
		}
	}

	void executeLoad(const Job& job)
	{
		const auto outcome = runtime.load(std::get<LoadJob>(job.work).params);
		std::lock_guard lock{stateMutex};
		if (outcome) {
			const EngineLoadResult result{outcome->backend, outcome->modelType, outcome->runtimeVersion};
			enqueue(writeJson(EngineLoadResponse{.jsonrpc = "2.0", .id = job.requestId, .result = result}));
			loadedReport = result;
			loaded = true;
			leaveBusy(EngineState::ready);
			log("engine.load completed");
		}
		else {
			enqueue(errorResponseKnownId(job.requestId, mapRuntimeError("engine.load", outcome.error())));
			leaveBusy(EngineState::idle);
			log("engine.load failed");
		}
	}

	void executeSynthesis(const Job& job)
	{
		const auto& work = std::get<SynthesisJob>(job.work);
		const auto startedAt = std::chrono::steady_clock::now();
		SynthesisSink sink{
			[this](std::string json) { enqueue(std::move(json)); },
			job.requestId,
		};
		const auto outcome = runtime.synthesize(work.params, *work.token, sink);
		const auto finishedAt = std::chrono::steady_clock::now();
		const auto processingMs = elapsedMs(startedAt, finishedAt);

		std::lock_guard lock{stateMutex};
		if (outcome) {
			const auto firstAudioMs = sink.firstAudioAt ? elapsedMs(startedAt, *sink.firstAudioAt) : processingMs;
			const SpeechSynthesizeResult result{
				.sampleCount = sink.sampleCount,
				.durationMs = sink.sampleCount * 1000 / 24000,
				.firstAudioMs = firstAudioMs,
				.processingMs = processingMs,
			};
			enqueue(writeJson(SpeechSynthesizeResponse{.jsonrpc = "2.0", .id = job.requestId, .result = result}));
			log("speech.synthesize completed");
		}
		else {
			enqueue(errorResponseKnownId(job.requestId, mapRuntimeError("speech.synthesize", outcome.error())));
			log("speech.synthesize failed");
		}
		leaveBusy(EngineState::ready);
		activeSynthesisId.clear();
		activeToken.reset();
	}

	void executeExtraction(const Job& job)
	{
		const auto outcome = runtime.extractVoice(std::get<ExtractionJob>(job.work).params);
		std::lock_guard lock{stateMutex};
		if (outcome) {
			const VoiceExtractResult result{outcome->speakerDimension, outcome->codebookCount, outcome->frameCount};
			enqueue(writeJson(VoiceExtractResponse{.jsonrpc = "2.0", .id = job.requestId, .result = result}));
			log("voice.extract completed");
		}
		else {
			enqueue(errorResponseKnownId(job.requestId, mapRuntimeError("voice.extract", outcome.error())));
			log("voice.extract failed");
		}
		leaveBusy(EngineState::ready);
	}

	// Worker-side state transition back from loading/busy; keeps the terminal
	// stopping state sticky so post-shutdown input is never processed.
	void leaveBusy(const EngineState next) noexcept
	{
		if (state != EngineState::stopping) {
			state = next;
		}
	}

	void handleFrame(const std::string& frame)
	{
		const auto validation = validateRequest(frame);
		switch (validation.error) {
		case DispatchError::parse_error:
			enqueue(errorResponseNullId(standardError(-32700, "Parse error")));
			return;
		case DispatchError::invalid_request:
			if (validation.id.empty()) {
				enqueue(errorResponseNullId(standardError(-32600, "Invalid request")));
			}
			else {
				enqueue(errorResponseKnownId(validation.id, standardError(-32600, "Invalid request")));
			}
			return;
		case DispatchError::method_not_found:
			enqueue(errorResponseKnownId(validation.id, standardError(-32601, "Method not found")));
			return;
		case DispatchError::invalid_params:
			enqueue(errorResponseKnownId(validation.id, standardError(-32602, "Invalid params")));
			return;
		case DispatchError::protocol_version_mismatch:
			enqueue(errorResponseKnownId(
				validation.id,
				customError(
					-32001,
					"Protocol version mismatch",
					"protocol_version_mismatch",
					"initialize",
					false,
					"Supported protocol version is 1")));
			return;
		case DispatchError::none:
			break;
		}

		if (validation.method == "initialize") {
			handleInitialize(validation.id);
		}
		else if (validation.method == "engine.load") {
			handleLoad(validation.id, frame);
		}
		else if (validation.method == "engine.status") {
			handleStatus(validation.id);
		}
		else if (validation.method == "speech.synthesize") {
			handleSynthesize(validation.id, frame);
		}
		else if (validation.method == "speech.cancel") {
			handleCancel(validation.id, frame);
		}
		else if (validation.method == "voice.extract") {
			handleExtract(validation.id, frame);
		}
		else if (validation.method == "engine.shutdown") {
			finishShutdown(validation.id);
		}
		else {
			enqueue(errorResponseKnownId(validation.id, standardError(-32603, "Internal error")));
		}
	}

	void handleInitialize(const std::string& id)
	{
		auto alreadyInitialized = false;
		std::string stateText;
		{
			std::lock_guard lock{stateMutex};
			alreadyInitialized = state != EngineState::starting;
			if (alreadyInitialized) {
				stateText = toStateName(state);
			}
			else {
				state = EngineState::idle;
			}
		}
		if (alreadyInitialized) {
			enqueue(errorResponseKnownId(id, invalidStateError("initialize", stateText)));
			return;
		}
		const InitializeResult result{
			.protocolVersion = version,
			.serverInfo = {std::string{serverName}, std::string{serverVersion}},
			.capabilities = {.streamingAudio = true, .voiceExtraction = true},
		};
		enqueue(writeJson(InitializeResponse{.jsonrpc = "2.0", .id = id, .result = result}));
		log("initialize accepted");
	}

	void handleLoad(const std::string& id, const std::string& frame)
	{
		const auto request = parseRequest<EngineLoadRequest>(frame);
		if (!request) {
			enqueue(errorResponseKnownId(id, standardError(-32603, "Internal error")));
			return;
		}
		if (request->params.maxBatch != 1) {
			enqueue(errorResponseKnownId(id, standardError(-32602, "Invalid params")));
			return;
		}
		auto accepted = false;
		auto busy = false;
		std::string stateText;
		{
			std::lock_guard lock{stateMutex};
			if (state == EngineState::busy) {
				busy = true;
			}
			else if (state != EngineState::idle) {
				stateText = toStateName(state);
			}
			else {
				state = EngineState::loading;
				accepted = true;
			}
		}
		if (busy) {
			enqueue(errorResponseKnownId(id, resourceBusyError("engine.load")));
			return;
		}
		if (!accepted) {
			enqueue(errorResponseKnownId(id, invalidStateError("engine.load", stateText)));
			return;
		}
		postJob(Job{.requestId = id, .work = LoadJob{request->params}});
		log("engine.load accepted");
	}

	void handleStatus(const std::string& id)
	{
		auto rejected = false;
		std::string stateText;
		std::optional<std::string> backend;
		std::optional<std::string> modelType;
		{
			std::lock_guard lock{stateMutex};
			rejected = state == EngineState::starting;
			stateText = toStateName(state);
			if (!rejected && loaded) {
				backend = loadedReport.backend;
				modelType = loadedReport.modelType;
			}
		}
		if (rejected) {
			enqueue(errorResponseKnownId(id, invalidStateError("engine.status", stateText)));
			return;
		}
		const EngineStatusResult result{stateText, backend, modelType, runtimeVersionSnapshot};
		enqueue(writeJson<compact_json_nulls>(EngineStatusResponse{.jsonrpc = "2.0", .id = id, .result = result}));
	}

	void handleSynthesize(const std::string& id, const std::string& frame)
	{
		const auto request = parseRequest<SpeechSynthesizeRequest>(frame);
		if (!request) {
			enqueue(errorResponseKnownId(id, standardError(-32603, "Internal error")));
			return;
		}
		auto token = std::make_shared<CancellationToken>();
		auto accepted = false;
		auto busy = false;
		std::string stateText;
		{
			std::lock_guard lock{stateMutex};
			if (state == EngineState::busy) {
				busy = true;
			}
			else if (state != EngineState::ready) {
				stateText = toStateName(state);
			}
			else {
				state = EngineState::busy;
				activeSynthesisId = id;
				activeToken = token;
				accepted = true;
			}
		}
		if (busy) {
			enqueue(errorResponseKnownId(id, resourceBusyError("speech.synthesize")));
			return;
		}
		if (!accepted) {
			enqueue(errorResponseKnownId(id, invalidStateError("speech.synthesize", stateText)));
			return;
		}
		const SpeechStartedParams started{id, "pcm_s16le", 24000, 1};
		enqueue(writeJson(SpeechStartedNotification{.jsonrpc = "2.0", .method = "speech.started", .params = started}));
		postJob(Job{.requestId = id, .work = SynthesisJob{request->params, std::move(token)}});
		log("speech.synthesize accepted");
	}

	void handleCancel(const std::string& id, const std::string& frame)
	{
		const auto request = parseRequest<SpeechCancelRequest>(frame);
		if (!request) {
			enqueue(errorResponseKnownId(id, standardError(-32603, "Internal error")));
			return;
		}
		std::shared_ptr<CancellationToken> token;
		auto accepted = false;
		{
			std::lock_guard lock{stateMutex};
			accepted = state == EngineState::busy && activeSynthesisId == request->params.requestId && activeToken != nullptr;
			if (accepted) {
				token = activeToken;
			}
		}
		if (token) {
			token->cancel();
		}
		enqueue(writeJson(SpeechCancelResponse{.jsonrpc = "2.0", .id = id, .result = {accepted}}));
		log(accepted ? "speech.cancel accepted" : "speech.cancel not accepted");
	}

	void handleExtract(const std::string& id, const std::string& frame)
	{
		const auto request = parseRequest<VoiceExtractRequest>(frame);
		if (!request) {
			enqueue(errorResponseKnownId(id, standardError(-32603, "Internal error")));
			return;
		}
		auto accepted = false;
		auto busy = false;
		std::string stateText;
		{
			std::lock_guard lock{stateMutex};
			if (state == EngineState::busy) {
				busy = true;
			}
			else if (state != EngineState::ready) {
				stateText = toStateName(state);
			}
			else {
				state = EngineState::busy;
				accepted = true;
			}
		}
		if (busy) {
			enqueue(errorResponseKnownId(id, resourceBusyError("voice.extract")));
			return;
		}
		if (!accepted) {
			enqueue(errorResponseKnownId(id, invalidStateError("voice.extract", stateText)));
			return;
		}
		postJob(Job{.requestId = id, .work = ExtractionJob{request->params}});
		log("voice.extract accepted");
	}

	// Cancels the active synthesis, waits for the worker to finish and write
	// its final response, releases the runtime, then optionally writes the
	// shutdown response. Idempotent; only the first call has an effect.
	void finishShutdown(const std::optional<std::string> requestId)
	{
		{
			std::lock_guard lock{stateMutex};
			if (state == EngineState::stopping) {
				return;
			}
			state = EngineState::stopping;
			if (activeToken) {
				activeToken->cancel();
			}
		}
		{
			std::lock_guard lock{jobMutex};
			workerStop = true;
		}
		jobCv.notify_all();
		if (workerThread.joinable()) {
			workerThread.join();
		}
		runtime.shutdown();
		if (requestId) {
			enqueue(writeJson(EngineShutdownResponse{.jsonrpc = "2.0", .id = *requestId, .result = {true}}));
		}
		closeWriter();
		log(requestId ? "engine.shutdown completed" : "engine shutdown after input end");
	}

	[[nodiscard]] std::string stateNameSnapshot() const
	{
		std::lock_guard lock{stateMutex};
		return std::string{toStateName(state)};
	}

	[[nodiscard]] bool workingSnapshot() const
	{
		std::lock_guard lock{stateMutex};
		return state == EngineState::loading || state == EngineState::busy;
	}

	[[nodiscard]] bool stoppingSnapshot() const
	{
		std::lock_guard lock{stateMutex};
		return state == EngineState::stopping;
	}
};

EngineServer::EngineServer(Runtime& runtime, std::ostream& protocolOutput, std::ostream& logOutput)
	: impl_(std::make_unique<Impl>(runtime, protocolOutput, logOutput))
{
}

EngineServer::~EngineServer() = default;

int EngineServer::run(LineSource& input)
{
	impl_->runtimeVersionSnapshot = impl_->runtime.status().runtimeVersion;
	impl_->workerThread = std::thread{[this] { impl_->workerLoop(); }};
	impl_->writerThread = std::thread{[this] { impl_->writerLoop(); }};
	impl_->log("engine server started");

	std::string line;
	while (!impl_->stoppingSnapshot() && input.next(line)) {
		impl_->handleFrame(line);
	}

	const bool framingFailure = input.failed();
	if (!impl_->stoppingSnapshot()) {
		impl_->finishShutdown(std::nullopt);
	}
	if (framingFailure) {
		impl_->log("input framing failed; engine exiting");
	}
	return framingFailure ? 1 : 0;
}

std::string EngineServer::stateName() const
{
	return impl_->stateNameSnapshot();
}

bool EngineServer::working() const
{
	return impl_->workingSnapshot();
}

} // namespace voxspeech::engine
