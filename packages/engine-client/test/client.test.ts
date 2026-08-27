import { fileURLToPath } from "node:url";

import type { EngineSpeechSynthesizeParams } from "@voxspeech/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	type EngineClientOptions,
	EngineClient,
	EngineClientError,
	EngineExitedError,
	EngineProtocolError,
	EngineRpcError,
	EngineTimeoutError,
} from "../src/index.js";

const fakeEnginePath = fileURLToPath(new URL("./fixtures/fake-engine.mjs", import.meta.url));
const synthesisParams: EngineSpeechSynthesizeParams = {
	text: "测试",
	language: "Chinese",
	sampling: { seed: -1, maxNewTokens: 32 },
};
const clients: EngineClient[] = [];

async function spawnFake(
	mode = "happy",
	requestTimeoutMs = 1_000,
	overrides: Partial<EngineClientOptions> = {},
): Promise<EngineClient> {
	const client = await EngineClient.spawn({
		command: process.execPath,
		args: [fakeEnginePath, mode],
		requestTimeoutMs,
		shutdownTimeoutMs: 1_000,
		...overrides,
	});
	clients.push(client);
	return client;
}

afterEach(async () => {
	await Promise.allSettled(clients.splice(0).map((client) => client.shutdown()));
});

describe("EngineClient", () => {
	it("initializes a child process and sends string request ids", async () => {
		const client = await spawnFake();

		expect(client.pid).toBeTypeOf("number");
		await expect(client.status()).resolves.toEqual({
			state: "ready",
			backend: "cpu",
			modelType: "base",
			runtimeVersion: "fake-1",
		});
	});

	it("delivers started and decoded PCM in protocol order", async () => {
		const client = await spawnFake();
		const events: string[] = [];
		const handle = client.startSynthesis(synthesisParams, {
			onStarted: () => events.push("started"),
			onAudio: (audio, params) => events.push(`audio:${params.sequence}:${audio.toString("hex")}`),
		});

		await expect(handle.result).resolves.toEqual({
			sampleCount: 1,
			durationMs: 1,
			firstAudioMs: 1,
			processingMs: 2,
		});
		expect(handle.requestId).toMatch(/^\d+$/);
		expect(events).toEqual(["started", "audio:0:0102"]);
	});

	it("cancels an active synthesis and surfaces its RPC error", async () => {
		const client = await spawnFake("cancel");
		const handle = client.startSynthesis(synthesisParams);

		await expect(handle.cancel()).resolves.toEqual({ accepted: true });
		await expect(handle.result).rejects.toMatchObject({
			name: "EngineRpcError",
			code: -32005,
			data: { code: "request_cancelled", stage: "synthesis", retryable: true },
		} satisfies Partial<EngineRpcError>);
	});

	it("captures stderr without mixing it into protocol messages", async () => {
		const chunks: string[] = [];
		const stderrReceived = Promise.withResolvers<void>();
		const client = await EngineClient.spawn({
			command: process.execPath,
			args: [fakeEnginePath, "stderr"],
			requestTimeoutMs: 1_000,
			onStderr: (text) => {
				chunks.push(text);
				stderrReceived.resolve();
			},
		});
		clients.push(client);

		await expect(client.status()).resolves.toMatchObject({ state: "ready" });
		await stderrReceived.promise;
		expect(client.stderr).toBe("fake diagnostic\n");
		expect(chunks).toEqual(["fake diagnostic\n"]);
	});

	it("times out a pending request", async () => {
		const client = await spawnFake("timeout", 30);

		await expect(client.status()).rejects.toBeInstanceOf(EngineTimeoutError);
	});

	it("rejects pending work when the engine exits abnormally", async () => {
		const client = await spawnFake("crash-synthesis");
		const handle = client.startSynthesis(synthesisParams);

		await expect(handle.result).rejects.toMatchObject({
			name: "EngineExitedError",
			exitCode: 23,
			stderr: "native synthesis failed\n",
		} satisfies Partial<EngineExitedError>);
	});

	it("rejects initialization when the engine exits", async () => {
		await expect(
			EngineClient.spawn({ command: process.execPath, args: [fakeEnginePath, "crash-init"] }),
		).rejects.toBeInstanceOf(EngineExitedError);
	});

	it("terminates the child when initialization returns an RPC error", async () => {
		const pidReceived = Promise.withResolvers<number>();

		await expect(
			EngineClient.spawn({
				command: process.execPath,
				args: [fakeEnginePath, "init-rpc-error"],
				shutdownTimeoutMs: 1_000,
				onStderr: (text) => pidReceived.resolve(Number(text.trim().slice(4))),
			}),
		).rejects.toBeInstanceOf(EngineRpcError);
		const pid = await pidReceived.promise;
		expect(() => process.kill(pid, 0)).toThrow();
	});

	it("terminates the child when shutdown times out", async () => {
		const client = await spawnFake("shutdown-timeout");
		const pid = client.pid;

		await expect(client.shutdown()).rejects.toBeInstanceOf(EngineTimeoutError);
		expect(pid).toBeTypeOf("number");
		expect(() => process.kill(pid!, 0)).toThrow();
	});

	it("handles a closed engine stdin without an unhandled stream error", async () => {
		const client = await spawnFake("stdin-closed");
		await new Promise((resolve) => setTimeout(resolve, 20));

		await expect(client.status()).rejects.toBeInstanceOf(EngineClientError);
	});

	it("terminates the session when audio arrives before speech.started", async () => {
		const client = await spawnFake("bad-sequence");
		const handle = client.startSynthesis(synthesisParams);

		await expect(handle.result).rejects.toBeInstanceOf(EngineProtocolError);
	});

	it("performs graceful shutdown idempotently", async () => {
		const client = await spawnFake();

		await expect(Promise.all([client.shutdown(), client.shutdown()])).resolves.toEqual([
			undefined,
			undefined,
		]);
	});

	it("rejects spawn when the engine command does not exist", async () => {
		await expect(
			EngineClient.spawn({ command: "/nonexistent/voxspeech-engine", requestTimeoutMs: 1_000 }),
		).rejects.toBeInstanceOf(EngineClientError);
	});

	it("fails the session when a response references an unknown request ID", async () => {
		const client = await spawnFake("unknown-response-id");

		await expect(client.status()).rejects.toBeInstanceOf(EngineProtocolError);
		await expect(client.status()).rejects.toMatchObject({ message: "Engine is not running" });
	});

	it("terminates the session when a notification references an unknown synthesis ID", async () => {
		const client = await spawnFake("wrong-notification-request-id");
		const handle = client.startSynthesis(synthesisParams);

		await expect(handle.result).rejects.toBeInstanceOf(EngineProtocolError);
	});

	it("terminates the session on duplicate speech.started", async () => {
		const client = await spawnFake("duplicate-started");
		const handle = client.startSynthesis(synthesisParams);

		await expect(handle.result).rejects.toBeInstanceOf(EngineProtocolError);
	});

	it("terminates the session when the audio sequence skips ahead", async () => {
		const client = await spawnFake("sequence-gap");
		const handle = client.startSynthesis(synthesisParams);

		await expect(handle.result).rejects.toBeInstanceOf(EngineProtocolError);
	});

	it("terminates the session when the audio sequence repeats", async () => {
		const client = await spawnFake("duplicate-sequence");
		const handle = client.startSynthesis(synthesisParams);

		await expect(handle.result).rejects.toBeInstanceOf(EngineProtocolError);
	});

	it("rejects non-canonical, empty, odd-byte and oversized audio payloads", async () => {
		for (const mode of ["audio-noncanonical", "audio-empty", "audio-odd-bytes", "audio-oversize"]) {
			const client = await spawnFake(mode);
			const handle = client.startSynthesis(synthesisParams);
			await expect(handle.result, mode).rejects.toBeInstanceOf(EngineProtocolError);
		}
	});

	it("rejects a synthesis result that arrives before speech.started", async () => {
		const client = await spawnFake("result-before-started");
		const handle = client.startSynthesis(synthesisParams);

		await expect(handle.result).rejects.toBeInstanceOf(EngineProtocolError);
	});

	it("fails the session when a late response for a timed-out request arrives", async () => {
		const lateResponseSent = Promise.withResolvers<void>();
		const client = await EngineClient.spawn({
			command: process.execPath,
			args: [fakeEnginePath, "late-response"],
			requestTimeoutMs: 50,
			shutdownTimeoutMs: 1_000,
			onStderr: (text) => {
				if (text.includes("late-response-sent")) lateResponseSent.resolve();
			},
		});
		clients.push(client);
		const pid = client.pid;

		await expect(client.status()).rejects.toBeInstanceOf(EngineTimeoutError);
		await lateResponseSent.promise;
		await expect(client.status()).rejects.toBeInstanceOf(EngineClientError);
		await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow());
	});

	it("keeps only the 256 KiB stderr tail while onStderr receives everything", async () => {
		const floodDone = Promise.withResolvers<void>();
		const chunks: string[] = [];
		const client = await EngineClient.spawn({
			command: process.execPath,
			args: [fakeEnginePath, "stderr-flood"],
			requestTimeoutMs: 1_000,
			shutdownTimeoutMs: 1_000,
			onStderr: (text) => {
				chunks.push(text);
				if (text.includes("flood-done")) floodDone.resolve();
			},
		});
		clients.push(client);

		await expect(client.status()).resolves.toMatchObject({ state: "ready" });
		await floodDone.promise;
		const fullOutput = `${"x".repeat(63)}\n`.repeat(16384) + "flood-done\n";
		expect(chunks.join("")).toBe(fullOutput);
		expect(Buffer.byteLength(client.stderr, "utf8")).toBeLessThanOrEqual(256 * 1024);
		expect(client.stderr).toBe(fullOutput.slice(-client.stderr.length));
	});

	it("reassembles stdout messages split inside multi-byte UTF-8 characters", async () => {
		const client = await spawnFake("utf8-split");

		await expect(client.status()).resolves.toMatchObject({
			runtimeVersion: "引擎-🚀-fake-1",
		});
	});

	it("forces the child to close when it ignores shutdown after responding", async () => {
		const client = await spawnFake("shutdown-hang", 1_000, { shutdownTimeoutMs: 100 });
		const pid = client.pid;

		await expect(client.shutdown()).resolves.toBeUndefined();
		expect(pid).toBeTypeOf("number");
		expect(() => process.kill(pid!, 0)).toThrow();
	});

	it("rejects every pending request when the engine crashes", async () => {
		const client = await spawnFake("crash-on-request");
		const first = client.status();
		const second = client.extractVoice({
			audioPath: "/tmp/voxspeech/reference.wav",
			speakerOutputPath: "/tmp/voxspeech/speaker.spk.new",
			codesOutputPath: "/tmp/voxspeech/reference.rvq.new",
		});

		await expect(first).rejects.toMatchObject({
			name: "EngineExitedError",
			exitCode: 23,
			stderr: "native crash\n",
		} satisfies Partial<EngineExitedError>);
		await expect(second).rejects.toBeInstanceOf(EngineExitedError);
	});
});
