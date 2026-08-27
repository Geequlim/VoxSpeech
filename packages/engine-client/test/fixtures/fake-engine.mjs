import { createInterface } from "node:readline";
import { closeSync } from "node:fs";

const mode = process.argv[2] ?? "happy";
process.stdin.resume();
const lines = createInterface({ input: process.stdin });
const keepAlive = setInterval(() => {}, 60_000);
let initialized = false;
let activeSynthesisId;

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
	send({ jsonrpc: "2.0", id, result: value });
}

function rpcError(id, message, code = -32005) {
	send({
		jsonrpc: "2.0",
		id,
		error: {
			code,
			message,
			data: { code: "request_cancelled", stage: "synthesis", retryable: true },
		},
	});
}

lines.on("line", (line) => {
	const request = JSON.parse(line);
	if (!initialized) {
		initialized = true;
		if (mode === "init-rpc-error") {
			process.stderr.write(`pid:${process.pid}\n`);
			send({
				jsonrpc: "2.0",
				id: request.id,
				error: {
					code: -32001,
					message: "Protocol mismatch",
					data: { code: "protocol_version_mismatch", stage: "initialize", retryable: false },
				},
			});
			return;
		}
		if (mode === "crash-init") {
			process.stderr.write("native init failed\n");
			process.exit(17);
		}
		result(request.id, {
			protocolVersion: 1,
			serverInfo: { name: "fake-engine", version: "0.1.0" },
			capabilities: { streamingAudio: true, voiceExtraction: true },
		});
		if (mode === "stdin-closed") setImmediate(() => closeSync(0));
		return;
	}

	if (request.method === "engine.status") {
		if (mode === "stderr") process.stderr.write("fake diagnostic\n");
		if (mode !== "timeout") {
			result(request.id, {
				state: "ready",
				backend: "cpu",
				modelType: "base",
				runtimeVersion: "fake-1",
			});
		}
		return;
	}

	if (request.method === "speech.synthesize") {
		activeSynthesisId = request.id;
		if (mode === "crash-synthesis") {
			process.stderr.write("native synthesis failed\n");
			process.exit(23);
		}
		send({
			jsonrpc: "2.0",
			method: mode === "bad-sequence" ? "speech.audio" : "speech.started",
			params:
				mode === "bad-sequence"
					? { requestId: request.id, sequence: 0, data: "AQI=" }
					: { requestId: request.id, encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
		});
		if (mode === "cancel" || mode === "bad-sequence") return;
		send({
			jsonrpc: "2.0",
			method: "speech.audio",
			params: { requestId: request.id, sequence: 0, data: "AQI=" },
		});
		result(request.id, { sampleCount: 1, durationMs: 1, firstAudioMs: 1, processingMs: 2 });
		return;
	}

	if (request.method === "speech.cancel") {
		result(request.id, { accepted: request.params.requestId === activeSynthesisId });
		if (request.params.requestId === activeSynthesisId)
			rpcError(activeSynthesisId, "Synthesis cancelled");
		return;
	}

	if (request.method === "engine.shutdown") {
		if (mode === "shutdown-timeout") return;
		result(request.id, { accepted: true });
		setImmediate(() => {
			clearInterval(keepAlive);
			process.exit(0);
		});
		return;
	}

	result(request.id, { backend: "cpu", modelType: "base", runtimeVersion: "fake-1" });
});
