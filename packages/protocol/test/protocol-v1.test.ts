import { readFile } from "node:fs/promises";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
	DAEMON_METHODS,
	DAEMON_NOTIFICATIONS,
	DaemonRequestSchema,
	ENGINE_METHODS,
	ENGINE_NOTIFICATIONS,
	EngineNotificationSchema,
	EngineRequestSchema,
	EngineSuccessResponseSchema,
	ErrorResponseSchema,
	MAX_AUDIO_CHUNK_BYTES,
	MAX_MESSAGE_BYTES,
	PCM_CHANNELS,
	PCM_ENCODING,
	PCM_SAMPLE_RATE,
} from "../src/index.js";

const fixtureRoot = new URL("../../../test/fixtures/protocol/v1/", import.meta.url);

async function fixture(relativePath: string): Promise<unknown> {
	return JSON.parse(await readFile(new URL(relativePath, fixtureRoot), "utf8"));
}

describe("protocol v1 constants", () => {
	it("freezes framing and PCM limits", () => {
		expect(MAX_MESSAGE_BYTES).toBe(1_048_576);
		expect(MAX_AUDIO_CHUNK_BYTES).toBe(65_536);
		expect([PCM_ENCODING, PCM_SAMPLE_RATE, PCM_CHANNELS]).toEqual(["pcm_s16le", 24_000, 1]);
	});

	it("exports the confirmed method sets", () => {
		expect(ENGINE_METHODS).toEqual([
			"initialize",
			"engine.load",
			"engine.status",
			"speech.synthesize",
			"speech.cancel",
			"voice.extract",
			"engine.shutdown",
		]);
		expect(ENGINE_NOTIFICATIONS).toEqual(["speech.started", "speech.audio"]);
		expect(DAEMON_METHODS).toHaveLength(18);
		expect(DAEMON_NOTIFICATIONS).toEqual(["speech.started", "speech.audio", "operation.progress"]);
	});
});

describe("engine golden fixtures", () => {
	it.each([
		"messages/initialize.request.json",
		"messages/engine-load.request.json",
		"messages/engine-status.request.json",
		"messages/speech-synthesize.request.json",
		"messages/speech-cancel.request.json",
		"messages/voice-extract.request.json",
		"messages/engine-shutdown.request.json",
	])("accepts request %s", async (path) => {
		expect(Value.Check(EngineRequestSchema, await fixture(path))).toBe(true);
	});

	it.each([
		"messages/initialize.result.json",
		"messages/engine-load.result.json",
		"messages/engine-status.result.json",
		"messages/speech-synthesize.result.json",
		"messages/speech-cancel.result.json",
		"messages/voice-extract.result.json",
		"messages/engine-shutdown.result.json",
	])("accepts success response %s", async (path) => {
		expect(Value.Check(EngineSuccessResponseSchema, await fixture(path))).toBe(true);
	});

	it.each(["messages/speech-started.notification.json", "messages/speech-audio.notification.json"])(
		"accepts notification %s",
		async (path) => {
			expect(Value.Check(EngineNotificationSchema, await fixture(path))).toBe(true);
		},
	);

	it.each(["messages/standard-error.response.json", "messages/custom-error.response.json"])(
		"accepts error response %s",
		async (path) => {
			expect(Value.Check(ErrorResponseSchema, await fixture(path))).toBe(true);
		},
	);
});

describe("strict validation", () => {
	it.each([
		"cases/invalid-version.request.json",
		"cases/invalid-params.request.json",
		"cases/unknown-method.request.json",
	])("rejects invalid request %s", async (path) => {
		expect(Value.Check(EngineRequestSchema, await fixture(path))).toBe(false);
	});

	it.each([
		"cases/invalid-version.response.json",
		"cases/invalid-params.response.json",
		"cases/unknown-method.response.json",
	])("accepts specified error response %s", async (path) => {
		expect(Value.Check(ErrorResponseSchema, await fixture(path))).toBe(true);
	});

	it("rejects numeric and empty request IDs", () => {
		const valid = {
			jsonrpc: "2.0",
			id: "status-1",
			method: "engine.status",
		};
		expect(Value.Check(EngineRequestSchema, { ...valid, id: 1 })).toBe(false);
		expect(Value.Check(EngineRequestSchema, { ...valid, id: "" })).toBe(false);
	});

	it("rejects unknown fields at every defined object boundary", () => {
		expect(
			Value.Check(EngineRequestSchema, {
				jsonrpc: "2.0",
				id: "load-1",
				method: "engine.load",
				params: {
					talkerPath: "/talker.gguf",
					codecPath: "/codec.gguf",
					backend: "cpu",
					maxBatch: 1,
					unexpected: true,
				},
			}),
		).toBe(false);
	});

	it("accepts omitted or null optional synthesis values", () => {
		const params = {
			text: "hello",
			language: "English",
			sampling: { seed: -1, maxNewTokens: 128 },
		};
		const request = { jsonrpc: "2.0", id: "synth-1", method: "speech.synthesize" };
		expect(Value.Check(EngineRequestSchema, { ...request, params })).toBe(true);
		expect(
			Value.Check(EngineRequestSchema, {
				...request,
				params: { ...params, speaker: null, instruct: null, reference: null },
			}),
		).toBe(true);
	});

	it("rejects simultaneous speaker and reference conditioning", () => {
		expect(
			Value.Check(EngineRequestSchema, {
				jsonrpc: "2.0",
				id: "synth-1",
				method: "speech.synthesize",
				params: {
					text: "hello",
					language: "English",
					speaker: "aiden",
					reference: {
						speakerPath: "/speaker.spk",
						codesPath: "/reference.rvq",
						text: "reference",
					},
					sampling: { seed: -1, maxNewTokens: 128 },
				},
			}),
		).toBe(false);
	});

	it("rejects malformed Base64 audio", () => {
		expect(
			Value.Check(EngineNotificationSchema, {
				jsonrpc: "2.0",
				method: "speech.audio",
				params: { requestId: "synth-1", sequence: 0, data: "not base64" },
			}),
		).toBe(false);
	});

	it("rejects an audio chunk larger than 64 KiB", () => {
		expect(
			Value.Check(EngineNotificationSchema, {
				jsonrpc: "2.0",
				method: "speech.audio",
				params: {
					requestId: "synth-1",
					sequence: 0,
					data: Buffer.alloc(MAX_AUDIO_CHUNK_BYTES + 1).toString("base64"),
				},
			}),
		).toBe(false);
	});
});

describe("daemon request dispatch", () => {
	it.each(DAEMON_METHODS)("accepts the minimal %s request", (method) => {
		const config = {
			version: 1,
			engine: { backend: "auto", idleTimeout: "10m", maxBatch: 1 },
			model: { default: null },
			voice: { default: null },
			download: { hubUrl: null, proxy: null, connections: null },
			api: { enabled: true, host: "127.0.0.1", port: 8080 },
			audio: { format: "wav" },
		};
		const paramsByMethod: Partial<Record<(typeof DAEMON_METHODS)[number], unknown>> = {
			initialize: {
				protocolVersion: 1,
				clientInfo: { name: "voxspeech-cli", version: "0.1.0" },
			},
			"speech.synthesize": { input: "hello" },
			"speech.cancel": { requestId: "synth-1" },
			"model.install": {
				id: "model",
				hubUrl: "https://hf-mirror.example",
				proxy: "http://127.0.0.1:7890",
				connections: 8,
			},
			"model.verify": { id: "model" },
			"model.use": { id: "model" },
			"model.remove": { id: "model" },
			"voice.clone": { id: "voice", audioPath: "/ref.wav", transcript: "hello" },
			"voice.show": { id: "voice" },
			"voice.use": { id: "voice" },
			"voice.remove": { id: "voice" },
			"config.validate": { config },
			"config.update": { config },
		};
		const params = paramsByMethod[method];
		expect(
			Value.Check(DaemonRequestSchema, {
				jsonrpc: "2.0",
				id: `request-${method}`,
				method,
				...(params === undefined ? {} : { params }),
			}),
		).toBe(true);
	});
});
