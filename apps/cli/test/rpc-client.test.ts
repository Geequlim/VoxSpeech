import { mkdtemp, rm } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	createFakeSynthesis,
	startDaemonServer,
	type DaemonServer,
} from "../../daemon/src/index.js";
import { afterEach, describe, expect, it } from "vitest";

import { DaemonRpcClient, type DaemonRpcError } from "../src/index.js";

const servers: DaemonServer[] = [];
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("DaemonRpcClient", () => {
	it("reports an unavailable daemon", async () => {
		const socketPath = await createSocketPath();
		await expect(DaemonRpcClient.connect({ socketPath })).rejects.toThrow(
			`Unable to connect to daemon at ${socketPath}`,
		);
	});

	it("times out while establishing a connection", async () => {
		const socket = new Socket();
		await expect(
			DaemonRpcClient.connect({
				connectTimeoutMs: 10,
				connectionFactory: () => socket,
				socketPath: "/unreachable/daemon.sock",
			}),
		).rejects.toThrow("Timed out connecting to daemon at /unreachable/daemon.sock");
		expect(socket.destroyed).toBe(true);
	});

	it("times out when the daemon does not complete initialization", async () => {
		const socketPath = await createSocketPath();
		const connections = new Set<import("node:net").Socket>();
		const silentServer = createServer((socket) => {
			connections.add(socket);
			socket.once("close", () => connections.delete(socket));
		});
		await new Promise<void>((resolve) => silentServer.listen(socketPath, resolve));
		await expect(DaemonRpcClient.connect({ requestTimeoutMs: 20, socketPath })).rejects.toThrow(
			"Daemon request timed out: initialize",
		);
		for (const socket of connections) socket.destroy();
		await new Promise<void>((resolve, reject) =>
			silentServer.close((error) => (error ? reject(error) : resolve())),
		);
	});

	it("streams deterministic PCM and returns synthesis metrics", async () => {
		const socketPath = await createSocketPath();
		servers.push(await startDaemonServer({ socketPath }));
		const client = await DaemonRpcClient.connect({ socketPath });
		const output = await client.synthesize({ input: "完成" });

		expect(output.audio.byteLength).toBe(output.result.sampleCount * 2);
		expect(output.format).toEqual({ channels: 1, encoding: "pcm_s16le", sampleRate: 24_000 });
		expect(output.result.durationMs).toBe(40);
		client.close();
	});

	it("keeps identical request IDs isolated between client connections", async () => {
		const socketPath = await createSocketPath();
		servers.push(await startDaemonServer({ socketPath }));
		const first = await DaemonRpcClient.connect({ socketPath });
		const second = await DaemonRpcClient.connect({ socketPath });

		const [firstOutput, secondOutput] = await Promise.all([
			first.synthesize({ input: "甲" }),
			second.synthesize({ input: "乙" }),
		]);
		expect(firstOutput.audio.byteLength).toBe(960);
		expect(secondOutput.audio.byteLength).toBe(960);
		first.close();
		second.close();
	});

	it("cancels an active synthesis request", async () => {
		const socketPath = await createSocketPath();
		servers.push(
			await startDaemonServer({
				socketPath,
				synthesis: createFakeSynthesis({ chunkDelayMs: 10, samplesPerCharacter: 2_400 }),
			}),
		);
		const client = await DaemonRpcClient.connect({ socketPath });
		const controller = new AbortController();
		const synthesis = client.synthesize(
			{ input: "需要取消的长文本" },
			{ signal: controller.signal },
		);
		setTimeout(() => controller.abort(), 15);

		await expect(synthesis).rejects.toEqual(
			expect.objectContaining<Partial<DaemonRpcError>>({ code: -32005 }),
		);
		client.close();
	});

	it("rejects duplicate speech.started notifications", async () => {
		const socketPath = await createSocketPath();
		const connections = new Set<import("node:net").Socket>();
		const invalidServer = createServer((socket) => {
			connections.add(socket);
			socket.once("close", () => connections.delete(socket));
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const request = JSON.parse(buffer.slice(0, newline)) as {
						id: string;
						method: string;
					};
					buffer = buffer.slice(newline + 1);
					if (request.method === "initialize") {
						socket.write(
							`${JSON.stringify({
								id: request.id,
								jsonrpc: "2.0",
								result: {
									capabilities: { operationProgress: true, streamingAudio: true },
									protocolVersion: 1,
									serverInfo: { name: "invalid-test", version: "0.1.0" },
								},
							})}\n`,
						);
					} else if (request.method === "speech.synthesize") {
						const started = `${JSON.stringify({
							jsonrpc: "2.0",
							method: "speech.started",
							params: {
								channels: 1,
								encoding: "pcm_s16le",
								requestId: request.id,
								sampleRate: 24_000,
							},
						})}\n`;
						socket.write(started + started);
					}
					newline = buffer.indexOf("\n");
				}
			});
		});
		await new Promise<void>((resolve) => invalidServer.listen(socketPath, resolve));
		const client = await DaemonRpcClient.connect({ socketPath });
		try {
			await expect(client.synthesize({ input: "测试" })).rejects.toThrow(
				"Daemon returned duplicate speech.started",
			);
		} finally {
			client.close();
			for (const socket of connections) socket.destroy();
			await new Promise<void>((resolve, reject) =>
				invalidServer.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});

async function createSocketPath(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "voxspeech-client-test-"));
	directories.push(directory);
	return path.join(directory, "daemon.sock");
}
