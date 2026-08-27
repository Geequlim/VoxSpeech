import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "happy";
const state = process.env.FAKE_ENGINE_STATE ?? "ready";
const logPath = process.env.FAKE_ENGINE_LOG;
let activeRequestId;
const keepAlive = setInterval(() => {}, 60_000);

function log(value) {
	if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`);
}

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
	send({ jsonrpc: "2.0", id, result: value });
}

function synthesisError(id, message = "Fake synthesis failed") {
	send({
		jsonrpc: "2.0",
		id,
		error: {
			code: -32004,
			message,
			data: { code: "synthesis_failed", retryable: true, stage: "speech.synthesize" },
		},
	});
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.method === "initialize") {
		result(request.id, {
			capabilities: { streamingAudio: true, voiceExtraction: true },
			protocolVersion: 1,
			serverInfo: { name: "daemon-fake-engine", version: "0.1.0" },
		});
		return;
	}
	if (request.method === "engine.status") {
		result(request.id, { backend: "cpu", modelType: "base", runtimeVersion: "fake-1", state });
		return;
	}
	if (request.method === "engine.load") {
		result(request.id, { backend: "cpu", modelType: "base", runtimeVersion: "fake-1" });
		return;
	}
	if (request.method === "speech.synthesize") {
		activeRequestId = request.id;
		log({ method: request.method, params: request.params, requestId: request.id });
		send({
			jsonrpc: "2.0",
			method: "speech.started",
			params: { channels: 1, encoding: "pcm_s16le", requestId: request.id, sampleRate: 24000 },
		});
		if (mode === "crash") process.exit(23);
		if (mode === "failure") return synthesisError(request.id);
		if (mode === "hold") return;
		send({
			jsonrpc: "2.0",
			method: "speech.audio",
			params: { data: "AQI=", requestId: request.id, sequence: 0 },
		});
		send({
			jsonrpc: "2.0",
			method: "speech.audio",
			params: { data: "AwQ=", requestId: request.id, sequence: 1 },
		});
		result(request.id, { durationMs: 1, firstAudioMs: 1, processingMs: 2, sampleCount: 2 });
		return;
	}
	if (request.method === "speech.cancel") {
		log({ method: request.method, params: request.params });
		const accepted = request.params.requestId === activeRequestId;
		result(request.id, { accepted });
		if (accepted) synthesisError(activeRequestId, "Fake synthesis cancelled");
		return;
	}
	if (request.method === "engine.shutdown") {
		log({ method: request.method });
		result(request.id, { accepted: true });
		setImmediate(() => {
			clearInterval(keepAlive);
			process.exit(0);
		});
	}
});
