import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EngineClient } from "@voxspeech/engine-client";
import { afterEach, describe, expect, it } from "vitest";

import {
	EngineSynthesisService,
	startDaemonServer,
	type DaemonServer,
	type SynthesisServiceError,
} from "../src/index.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-engine.mjs", import.meta.url));
const clients: EngineClient[] = [];
const directories: string[] = [];
const servers: DaemonServer[] = [];

afterEach(async () => {
	await Promise.allSettled(clients.splice(0).map((client) => client.shutdown()));
	await Promise.allSettled(servers.splice(0).map((server) => server.close()));
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("EngineSynthesisService", () => {
	it("maps frozen daemon parameters and preserves engine chunk order", async () => {
		const { logPath } = await createEnvironment();
		const service = new EngineSynthesisService(await spawnEngine("happy", logPath));
		const events: string[] = [];

		await expect(
			service.run(
				{ input: "映射测试", instruct: "自然", language: null },
				new AbortController().signal,
				(chunk) => events.push(`${chunk.sequence}:${chunk.data.toString("hex")}`),
			),
		).resolves.toEqual({ durationMs: 1, firstAudioMs: 1, processingMs: 2, sampleCount: 2 });
		expect(events).toEqual(["0:0102", "1:0304"]);
		expect(await readSynthesisParams(logPath)).toEqual({
			instruct: "自然",
			language: "auto",
			reference: null,
			sampling: { maxNewTokens: 2048, seed: -1 },
			speaker: null,
			text: "映射测试",
		});
	});

	it("resolves voice IDs to a leased engine reference", async () => {
		const { logPath } = await createEnvironment();
		let released = false;
		const service = new EngineSynthesisService(await spawnEngine("happy", logPath), {
			resolveVoice: async (id) => {
				expect(id).toBe("profile-id");
				return {
					reference: {
						codesPath: "/profiles/profile-id/reference.rvq",
						speakerPath: "/profiles/profile-id/speaker.spk",
						text: "参考文本",
					},
					release: () => {
						released = true;
					},
				};
			},
		});

		await expect(
			service.run(
				{ input: "测试", voice: "profile-id" },
				new AbortController().signal,
				() => undefined,
			),
		).resolves.toMatchObject({ sampleCount: 2 });
		expect(released).toBe(true);
		expect(await readSynthesisParams(logPath)).toMatchObject({
			reference: {
				codesPath: "/profiles/profile-id/reference.rvq",
				speakerPath: "/profiles/profile-id/speaker.spk",
				text: "参考文本",
			},
		});
	});

	it("cancels the EngineClient request only once when its signal aborts", async () => {
		const { logPath } = await createEnvironment();
		const service = new EngineSynthesisService(await spawnEngine("hold", logPath));
		const controller = new AbortController();
		const synthesis = service.run({ input: "长文本" }, controller.signal, () => undefined);
		controller.abort(new Error("cancel"));
		controller.abort(new Error("cancel again"));

		await expect(synthesis).rejects.toMatchObject({ code: "synthesis_failed" });
		expect((await readFile(logPath, "utf8")).match(/"speech\.cancel"/g)).toHaveLength(1);
	});

	it.each(["failure", "crash"])("maps engine %s to a retryable synthesis failure", async (mode) => {
		const { logPath } = await createEnvironment();
		const service = new EngineSynthesisService(await spawnEngine(mode, logPath));

		await expect(
			service.run({ input: "失败" }, new AbortController().signal, () => undefined),
		).rejects.toMatchObject({
			code: "synthesis_failed",
			retryable: true,
		} satisfies Partial<SynthesisServiceError>);
	});

	it("forwards the injected engine state and shuts the client down", async () => {
		const { logPath } = await createEnvironment();
		const service = new EngineSynthesisService(await spawnEngine("happy", logPath, "busy"));

		await expect(service.status()).resolves.toMatchObject({ backend: "cpu", state: "busy" });
		await service.close();
		expect((await readFile(logPath, "utf8")).match(/"engine\.shutdown"/g)).toHaveLength(1);
	});

	it("forwards EngineClient streaming, socket cancellation, and engine status", async () => {
		const { directory, logPath } = await createEnvironment();
		const service = new EngineSynthesisService(await spawnEngine("hold", logPath));
		const server = await startDaemonServer({
			socketPath: path.join(directory, "daemon.sock"),
			synthesis: service,
		});
		servers.push(server);
		const session = await connectSession(server.socketPath);
		await initialize(session);

		session.send({
			id: "synth-1",
			jsonrpc: "2.0",
			method: "speech.synthesize",
			params: { input: "取消" },
		});
		await session.until((message) => isNotification(message, "speech.started"));
		session.send({
			id: "cancel-1",
			jsonrpc: "2.0",
			method: "speech.cancel",
			params: { requestId: "synth-1" },
		});
		const cancelled = await session.until((message) => hasResponseId(message, "synth-1"));
		expect(cancelled.map(messageKind)).toEqual(["response:cancel-1", "error:synth-1"]);
		expect((await readFile(logPath, "utf8")).match(/"speech\.cancel"/g)).toHaveLength(1);

		session.send({ id: "status-1", jsonrpc: "2.0", method: "daemon.status", params: {} });
		const status = await session.next();
		expect(status).toMatchObject({
			id: "status-1",
			result: { engine: { backend: "cpu", state: "ready" } },
		});
		session.close();
	});

	it("cancels an EngineClient request after socket disconnect and during daemon close", async () => {
		const { directory, logPath } = await createEnvironment();
		const service = new EngineSynthesisService(await spawnEngine("hold", logPath));
		const server = await startDaemonServer({
			socketPath: path.join(directory, "daemon.sock"),
			synthesis: service,
		});
		const session = await connectSession(server.socketPath);
		await initialize(session);
		session.send({
			id: "synth-1",
			jsonrpc: "2.0",
			method: "speech.synthesize",
			params: { input: "断开" },
		});
		await session.until((message) => isNotification(message, "speech.started"));
		session.close();
		await waitForLog(logPath, "speech.cancel");

		await server.close();
		expect((await readFile(logPath, "utf8")).match(/"speech\.cancel"/g)).toHaveLength(1);
		expect((await readFile(logPath, "utf8")).match(/"engine\.shutdown"/g)).toHaveLength(1);
	});

	it("keeps the daemon responsive after an engine synthesis timeout", async () => {
		const { directory, logPath } = await createEnvironment();
		const service = new EngineSynthesisService(await spawnEngine("hold", logPath));
		const server = await startDaemonServer({
			socketPath: path.join(directory, "daemon.sock"),
			synthesis: service,
		});
		servers.push(server);
		const session = await connectSession(server.socketPath);
		await initialize(session);

		session.send({
			id: "synth-1",
			jsonrpc: "2.0",
			method: "speech.synthesize",
			params: { input: "超时" },
		});
		const timeout = await session.until((message) => hasResponseId(message, "synth-1"));
		expect(timeout.at(-1)).toMatchObject({
			error: { code: -32004, data: { code: "synthesis_failed", retryable: true } },
			id: "synth-1",
		});
		session.send({ id: "status-1", jsonrpc: "2.0", method: "daemon.status", params: {} });
		expect(await session.next()).toMatchObject({
			id: "status-1",
			result: { daemon: { state: "ready" }, engine: { state: "ready" } },
		});
		session.close();
	});
});

async function spawnEngine(mode: string, logPath: string, state?: string): Promise<EngineClient> {
	const client = await EngineClient.spawn({
		args: [fixturePath, mode],
		command: process.execPath,
		env: {
			...process.env,
			FAKE_ENGINE_LOG: logPath,
			...(state ? { FAKE_ENGINE_STATE: state } : {}),
		},
		requestTimeoutMs: 100,
		shutdownTimeoutMs: 1_000,
	});
	await client.load({
		backend: "cpu",
		codecPath: "/fake/codec.gguf",
		maxBatch: 1,
		talkerPath: "/fake/talker.gguf",
	});
	clients.push(client);
	return client;
}

async function createEnvironment(): Promise<{ directory: string; logPath: string }> {
	const directory = await mkdtemp(path.join(tmpdir(), "voxspeech-daemon-engine-test-"));
	directories.push(directory);
	return { directory, logPath: path.join(directory, "engine.log") };
}

async function readSynthesisParams(logPath: string): Promise<unknown> {
	const entries = (await readFile(logPath, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { method: string; params: unknown });
	return entries.find((entry) => entry.method === "speech.synthesize")?.params;
}

interface RpcSession {
	close(): void;
	next(): Promise<unknown>;
	send(message: unknown): void;
	until(predicate: (message: unknown) => boolean): Promise<unknown[]>;
}

async function connectSession(socketPath: string): Promise<RpcSession> {
	const socket = await new Promise<Socket>((resolve, reject) => {
		const connection = createConnection(socketPath);
		connection.once("connect", () => resolve(connection));
		connection.once("error", reject);
	});
	const messages: unknown[] = [];
	const waiters: Array<(message: unknown) => void> = [];
	let buffer = "";
	socket.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const message = JSON.parse(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			const waiter = waiters.shift();
			if (waiter) waiter(message);
			else messages.push(message);
			newline = buffer.indexOf("\n");
		}
	});
	const next = () =>
		messages.length > 0
			? Promise.resolve(messages.shift())
			: new Promise<unknown>((resolve) => waiters.push(resolve));
	return {
		close: () => socket.destroy(),
		next,
		send: (message) => socket.write(`${JSON.stringify(message)}\n`),
		async until(predicate) {
			const received: unknown[] = [];
			while (true) {
				const message = await next();
				received.push(message);
				if (predicate(message)) return received;
			}
		},
	};
}

async function initialize(session: RpcSession): Promise<void> {
	session.send({
		id: "init-1",
		jsonrpc: "2.0",
		method: "initialize",
		params: { clientInfo: { name: "test", version: "0.1.0" }, protocolVersion: 1 },
	});
	await session.until((message) => hasResponseId(message, "init-1"));
}

function hasResponseId(message: unknown, id: string): boolean {
	return typeof message === "object" && message !== null && "id" in message && message.id === id;
}

function isNotification(message: unknown, method: string): boolean {
	return (
		typeof message === "object" &&
		message !== null &&
		"method" in message &&
		message.method === method
	);
}

function messageKind(message: unknown): string {
	if (typeof message !== "object" || message === null || !("id" in message)) return "notification";
	return "error" in message ? `error:${message.id}` : `response:${message.id}`;
}

async function waitForLog(logPath: string, method: string): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const contents = await readFile(logPath, "utf8").catch(() => "");
		if (contents.includes(method)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${method}`);
}
