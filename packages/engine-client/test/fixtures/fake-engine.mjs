import { createInterface } from "node:readline";
import { closeSync } from "node:fs";

const mode = process.argv[2] ?? "happy";
process.stdin.resume();
const lines = createInterface({ input: process.stdin });
const keepAlive = setInterval(() => {}, 60_000);
let initialized = false;
let activeSynthesisId;
let flooded = false;

if (mode === "shutdown-hang") process.on("SIGTERM", () => {});

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

function startedNotification(requestId) {
	send({
		jsonrpc: "2.0",
		method: "speech.started",
		params: { requestId, encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
	});
}

function audioNotification(requestId, sequence, data) {
	send({ jsonrpc: "2.0", method: "speech.audio", params: { requestId, sequence, data } });
}

const statusResult = {
	state: "ready",
	backend: "cpu",
	modelType: "base",
	runtimeVersion: "fake-1",
};

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

	if (mode === "crash-on-request") {
		process.stderr.write("native crash\n");
		process.exit(23);
	}

	if (request.method === "engine.status") {
		if (mode === "stderr") process.stderr.write("fake diagnostic\n");
		if (mode === "unknown-response-id") {
			send({ jsonrpc: "2.0", id: "does-not-exist", result: statusResult });
			return;
		}
		if (mode === "late-response") {
			setTimeout(() => {
				result(request.id, statusResult);
				process.stderr.write("late-response-sent\n");
			}, 300);
			return;
		}
		if (mode === "stderr-flood") {
			if (!flooded) {
				flooded = true;
				process.stderr.write(`${"x".repeat(63)}\n`.repeat(16384));
				process.stderr.write("flood-done\n");
			}
			result(request.id, statusResult);
			return;
		}
		if (mode === "utf8-split") {
			const bytes = Buffer.from(
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: request.id,
					result: { ...statusResult, runtimeVersion: "引擎-🚀-fake-1" },
				})}\n`,
				"utf8",
			);
			for (let offset = 0; offset < bytes.length; offset += 2) {
				process.stdout.write(bytes.subarray(offset, Math.min(offset + 2, bytes.length)));
			}
			return;
		}
		if (mode !== "timeout") {
			result(request.id, statusResult);
		}
		return;
	}

	if (request.method === "speech.synthesize") {
		activeSynthesisId = request.id;
		if (mode === "crash-synthesis") {
			process.stderr.write("native synthesis failed\n");
			process.exit(23);
		}
		if (mode === "wrong-notification-request-id") {
			startedNotification("someone-else");
			return;
		}
		if (mode === "duplicate-started") {
			startedNotification(request.id);
			startedNotification(request.id);
			return;
		}
		if (mode === "result-before-started") {
			result(request.id, { sampleCount: 1, durationMs: 1, firstAudioMs: 1, processingMs: 2 });
			return;
		}
		if (mode === "bad-sequence") {
			audioNotification(request.id, 0, "AQI=");
			return;
		}
		startedNotification(request.id);
		if (mode === "cancel") return;
		if (mode === "sequence-gap") {
			audioNotification(request.id, 0, "AQI=");
			audioNotification(request.id, 2, "AQI=");
			return;
		}
		if (mode === "duplicate-sequence") {
			audioNotification(request.id, 0, "AQI=");
			audioNotification(request.id, 0, "AQI=");
			return;
		}
		const invalidAudio = {
			"audio-noncanonical": "AB==",
			"audio-empty": "",
			"audio-odd-bytes": "AQID",
		};
		if (mode in invalidAudio) {
			audioNotification(request.id, 0, invalidAudio[mode]);
			return;
		}
		if (mode === "audio-oversize") {
			audioNotification(request.id, 0, Buffer.alloc(65538, 7).toString("base64"));
			return;
		}
		audioNotification(request.id, 0, "AQI=");
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
		if (mode === "shutdown-hang") return;
		setImmediate(() => {
			clearInterval(keepAlive);
			process.exit(0);
		});
		return;
	}

	result(request.id, { backend: "cpu", modelType: "base", runtimeVersion: "fake-1" });
});
