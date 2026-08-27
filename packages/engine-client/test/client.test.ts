import { fileURLToPath } from "node:url";

import type { EngineSpeechSynthesizeParams } from "@voxspeech/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
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

async function spawnFake(mode = "happy", requestTimeoutMs = 1_000): Promise<EngineClient> {
	const client = await EngineClient.spawn({
		command: process.execPath,
		args: [fakeEnginePath, mode],
		requestTimeoutMs,
		shutdownTimeoutMs: 1_000,
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
});
