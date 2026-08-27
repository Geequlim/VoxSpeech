import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startDaemonServer, type DaemonServer } from "../src/index.js";

const servers: DaemonServer[] = [];
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("daemon socket server", () => {
	it("requires initialize as the first request", async () => {
		const socketPath = await createSocketPath();
		servers.push(await startDaemonServer({ socketPath }));
		const socket = await connect(socketPath);
		const response = await send(socket, {
			jsonrpc: "2.0",
			id: "status-1",
			method: "daemon.status",
			params: {},
		});

		expect(response).toMatchObject({
			error: { code: -32002, data: { code: "invalid_state" } },
			id: "status-1",
		});
		socket.destroy();
	});

	it("reports the frozen daemon status after initialization", async () => {
		const socketPath = await createSocketPath();
		servers.push(await startDaemonServer({ socketPath }));
		const socket = await connect(socketPath);
		await initialize(socket);

		expect(
			await send(socket, { jsonrpc: "2.0", id: "status-1", method: "daemon.status", params: {} }),
		).toEqual({
			id: "status-1",
			jsonrpc: "2.0",
			result: {
				api: { enabled: true, host: "127.0.0.1", port: 8080 },
				daemon: { state: "ready", version: "0.1.0" },
				engine: { backend: null, modelId: null, state: "stopped" },
				model: { defaultId: null },
				voice: { defaultId: null },
			},
		});
		socket.destroy();
	});

	it("returns method not found for an unknown method", async () => {
		const socketPath = await createSocketPath();
		servers.push(await startDaemonServer({ socketPath }));
		const socket = await connect(socketPath);

		await initialize(socket);
		await expect(
			send(socket, {
				jsonrpc: "2.0",
				id: "unknown-1",
				method: "unknown.method",
				params: {},
			}),
		).resolves.toMatchObject({
			error: { code: -32601 },
			id: "unknown-1",
		});
		socket.destroy();
	});

	it("rejects an incompatible protocol version", async () => {
		const socketPath = await createSocketPath();
		servers.push(await startDaemonServer({ socketPath }));
		const socket = await connect(socketPath);

		expect(
			await send(socket, {
				jsonrpc: "2.0",
				id: "init-1",
				method: "initialize",
				params: { clientInfo: { name: "test", version: "0.1.0" }, protocolVersion: 2 },
			}),
		).toMatchObject({
			error: { code: -32001, data: { code: "protocol_version_mismatch" } },
			id: "init-1",
		});
		socket.destroy();
	});

	it("creates a private socket and removes it on close", async () => {
		const socketPath = await createSocketPath();
		const server = await startDaemonServer({ socketPath });
		const stat = await lstat(socketPath);
		expect(stat.isSocket()).toBe(true);
		expect(stat.mode & 0o777).toBe(0o600);

		await expect(startDaemonServer({ socketPath })).rejects.toThrow("already active");
		await server.close();
		await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses to replace a non-socket path", async () => {
		const socketPath = await createSocketPath();
		await mkdir(path.dirname(socketPath), { recursive: true });
		await writeFile(socketPath, "keep");
		await expect(startDaemonServer({ socketPath })).rejects.toThrow("non-socket path");
	});
});

async function createSocketPath(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "voxspeech-daemon-test-"));
	directories.push(directory);
	return path.join(directory, "runtime", "daemon.sock");
}

function connect(socketPath: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

async function initialize(socket: Socket): Promise<unknown> {
	return send(socket, {
		jsonrpc: "2.0",
		id: "init-1",
		method: "initialize",
		params: { clientInfo: { name: "test", version: "0.1.0" }, protocolVersion: 1 },
	});
}

function send(socket: Socket, request: unknown): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			socket.off("data", onData);
			resolve(JSON.parse(buffer.slice(0, newline)));
		};
		socket.on("data", onData);
		socket.once("error", reject);
		socket.write(`${JSON.stringify(request)}\n`);
	});
}
