import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import path from "node:path";

import { Value } from "@sinclair/typebox/value";
import {
	DAEMON_METHODS,
	DaemonRequestSchema,
	JSON_RPC_VERSION,
	MAX_MESSAGE_BYTES,
	PROTOCOL_VERSION,
	type DaemonSpeechSynthesizeParams,
	type DaemonStatusResult,
} from "@voxspeech/protocol";

import { createFakeSynthesis, type FakeSynthesis } from "./fake-synthesis.js";

const VERSION = "0.1.0";
const DAEMON_METHOD_SET = new Set<string>(DAEMON_METHODS);

interface RpcRequest {
	readonly id: string;
	readonly jsonrpc: typeof JSON_RPC_VERSION;
	readonly method: string;
	readonly params?: unknown;
}

export interface DaemonServerOptions {
	readonly socketPath: string;
	readonly synthesis?: FakeSynthesis;
}

export interface DaemonServer {
	readonly socketPath: string;
	close(): Promise<void>;
}

interface ActiveSynthesis {
	readonly controller: AbortController;
}

type ActiveSyntheses = Map<Socket, Map<string, ActiveSynthesis>>;

export async function startDaemonServer(options: DaemonServerOptions): Promise<DaemonServer> {
	await prepareSocketPath(options.socketPath);
	const synthesis = options.synthesis ?? createFakeSynthesis();
	const active: ActiveSyntheses = new Map();
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		handleConnection(socket, synthesis, active);
		socket.once("close", () => {
			sockets.delete(socket);
			for (const task of active.get(socket)?.values() ?? [])
				task.controller.abort(new Error("Client disconnected"));
			active.delete(socket);
		});
	});

	await listen(server, options.socketPath);
	await chmod(options.socketPath, 0o600);

	let closed = false;
	return {
		socketPath: options.socketPath,
		async close() {
			if (closed) return;
			closed = true;
			for (const tasks of active.values())
				for (const task of tasks.values()) task.controller.abort(new Error("Daemon stopped"));
			active.clear();
			for (const socket of sockets) socket.destroy();
			await closeServer(server);
			await unlink(options.socketPath).catch((error: unknown) => {
				if (!isNodeError(error, "ENOENT")) throw error;
			});
		},
	};
}

function handleConnection(socket: Socket, synthesis: FakeSynthesis, active: ActiveSyntheses): void {
	const state = { initialized: false };
	let buffer = Buffer.alloc(0);
	let writes = Promise.resolve();
	const write = (message: unknown) => {
		writes = writes.then(
			() =>
				new Promise<void>((resolve, reject) => {
					socket.write(`${JSON.stringify(message)}\n`, (error) =>
						error ? reject(error) : resolve(),
					);
				}),
		);
		return writes;
	};

	socket.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		if (buffer.byteLength > MAX_MESSAGE_BYTES && !buffer.includes(0x0a)) {
			void write(errorResponse(null, -32600, "Message exceeds maximum size")).finally(() =>
				socket.destroy(),
			);
			return;
		}

		let newline = buffer.indexOf(0x0a);
		while (newline >= 0) {
			const line = buffer.subarray(0, newline);
			buffer = buffer.subarray(newline + 1);
			if (line.byteLength > MAX_MESSAGE_BYTES) {
				void write(errorResponse(null, -32600, "Message exceeds maximum size")).finally(() =>
					socket.destroy(),
				);
				return;
			}
			void dispatchLine(line, socket, write, synthesis, active, state).then((result) => {
				if (result === "close") socket.end();
			});
			newline = buffer.indexOf(0x0a);
		}
	});
}

async function dispatchLine(
	line: Buffer,
	socket: Socket,
	write: (message: unknown) => Promise<void>,
	synthesis: FakeSynthesis,
	active: ActiveSyntheses,
	state: { initialized: boolean },
): Promise<"close" | undefined> {
	let value: unknown;
	try {
		value = JSON.parse(line.toString("utf8"));
	} catch {
		await write(errorResponse(null, -32700, "Parse error"));
		return;
	}
	const request = parseRequest(value);
	if (!request) {
		await write(errorResponse(null, -32600, "Invalid request"));
		return;
	}

	if (!state.initialized) {
		if (request.method !== "initialize") {
			await write(
				errorResponse(request.id, -32002, "initialize must be the first request", {
					code: "invalid_state",
					details: "Open a new connection and initialize it before sending requests",
					retryable: true,
					stage: request.method,
				}),
			);
			return "close";
		}
		if (!isInitializeParams(request.params)) {
			await write(errorResponse(request.id, -32602, "Invalid params"));
			return "close";
		}
		if (request.params.protocolVersion !== PROTOCOL_VERSION) {
			await write(
				errorResponse(request.id, -32001, "Protocol version mismatch", {
					code: "protocol_version_mismatch",
					details: `Daemon requires protocol version ${PROTOCOL_VERSION}`,
					retryable: false,
					stage: "initialize",
				}),
			);
			return "close";
		}
		if (!Value.Check(DaemonRequestSchema, value)) {
			await write(errorResponse(request.id, -32602, "Invalid params"));
			return "close";
		}
		state.initialized = true;
		await write({
			jsonrpc: JSON_RPC_VERSION,
			id: request.id,
			result: {
				capabilities: { operationProgress: true, streamingAudio: true },
				protocolVersion: PROTOCOL_VERSION,
				serverInfo: { name: "voxspeech-daemon", version: VERSION },
			},
		});
		return;
	}
	if (!Value.Check(DaemonRequestSchema, value)) {
		await write(
			DAEMON_METHOD_SET.has(request.method)
				? invalidParams(request.id)
				: errorResponse(request.id, -32601, "Method not found"),
		);
		return;
	}

	switch (request.method) {
		case "daemon.status":
			if (!isEmptyParams(request.params)) return void (await write(invalidParams(request.id)));
			await write({ jsonrpc: JSON_RPC_VERSION, id: request.id, result: createStatus() });
			return;
		case "speech.synthesize": {
			if (!isSynthesisParams(request.params)) return void (await write(invalidParams(request.id)));
			const tasks = active.get(socket) ?? new Map<string, ActiveSynthesis>();
			active.set(socket, tasks);
			if (tasks.has(request.id)) return void (await write(invalidParams(request.id)));
			const controller = new AbortController();
			tasks.set(request.id, { controller });
			await write({
				jsonrpc: JSON_RPC_VERSION,
				method: "speech.started",
				params: { requestId: request.id, ...synthesis.audio },
			});
			try {
				const result = await synthesis.run(request.params, controller.signal, (chunk) => {
					void write({
						jsonrpc: JSON_RPC_VERSION,
						method: "speech.audio",
						params: {
							data: chunk.data.toString("base64"),
							requestId: request.id,
							sequence: chunk.sequence,
						},
					});
				});
				await write({ jsonrpc: JSON_RPC_VERSION, id: request.id, result });
			} catch (error) {
				const cancelled = controller.signal.aborted;
				await write(
					errorResponse(
						request.id,
						cancelled ? -32005 : -32004,
						cancelled ? "Request cancelled" : "Synthesis failed",
						{
							code: cancelled ? "request_cancelled" : "synthesis_failed",
							details: error instanceof Error ? error.message : undefined,
							retryable: !cancelled,
							stage: "speech.synthesize",
						},
					),
				);
			} finally {
				tasks.delete(request.id);
				if (tasks.size === 0) active.delete(socket);
			}
			return;
		}
		case "speech.cancel": {
			const requestId = parseCancelParams(request.params);
			if (!requestId) return void (await write(invalidParams(request.id)));
			const task = active.get(socket)?.get(requestId);
			if (task) task.controller.abort(new Error("Cancelled by client"));
			await write({
				jsonrpc: JSON_RPC_VERSION,
				id: request.id,
				result: { accepted: Boolean(task) },
			});
			return;
		}
		default:
			await write(errorResponse(request.id, -32601, "Method not found"));
	}
}

function createStatus(): DaemonStatusResult {
	return {
		api: { enabled: true, host: "127.0.0.1", port: 8080 },
		daemon: { state: "ready", version: VERSION },
		engine: { backend: null, modelId: null, state: "stopped" },
		model: { defaultId: null },
		voice: { defaultId: null },
	};
}

function parseRequest(value: unknown): RpcRequest | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ["jsonrpc", "id", "method", "params"])) return;
	if (value.jsonrpc !== JSON_RPC_VERSION || typeof value.id !== "string" || value.id.length === 0)
		return;
	if (typeof value.method !== "string" || value.method.length === 0) return;
	return value as unknown as RpcRequest;
}

function isInitializeParams(
	value: unknown,
): value is { clientInfo: { name: string; version: string }; protocolVersion: number } {
	if (!isRecord(value) || !hasOnlyKeys(value, ["protocolVersion", "clientInfo"])) return false;
	if (!Number.isInteger(value.protocolVersion) || !isRecord(value.clientInfo)) return false;
	return (
		hasOnlyKeys(value.clientInfo, ["name", "version"]) &&
		isNonEmptyString(value.clientInfo.name) &&
		isNonEmptyString(value.clientInfo.version)
	);
}

function isSynthesisParams(value: unknown): value is DaemonSpeechSynthesizeParams {
	if (!isRecord(value) || !hasOnlyKeys(value, ["input", "voice", "language", "instruct"]))
		return false;
	return (
		isNonEmptyString(value.input) &&
		isOptionalNullableNonEmptyString(value.voice) &&
		isOptionalNullableNonEmptyString(value.language) &&
		(value.instruct === undefined || value.instruct === null || typeof value.instruct === "string")
	);
}

function parseCancelParams(value: unknown): string | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ["requestId"])) return;
	return isNonEmptyString(value.requestId) ? value.requestId : undefined;
}

function isEmptyParams(value: unknown): boolean {
	return value === undefined || (isRecord(value) && Object.keys(value).length === 0);
}

function isOptionalNullableNonEmptyString(value: unknown): boolean {
	return value === undefined || value === null || isNonEmptyString(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function invalidParams(id: string) {
	return errorResponse(id, -32602, "Invalid params");
}

function errorResponse(
	id: string | null,
	code: number,
	message: string,
	data?: {
		readonly code: string;
		readonly details?: string;
		readonly retryable: boolean;
		readonly stage: string;
	},
) {
	return {
		error: { code, ...(data ? { data } : {}), message },
		id,
		jsonrpc: JSON_RPC_VERSION,
	};
}

async function prepareSocketPath(socketPath: string): Promise<void> {
	await mkdir(path.dirname(socketPath), { mode: 0o700, recursive: true });
	const existing = await lstat(socketPath).catch((error: unknown) => {
		if (isNodeError(error, "ENOENT")) return undefined;
		throw error;
	});
	if (!existing) return;
	if (!existing.isSocket()) throw new Error(`Refusing to replace non-socket path: ${socketPath}`);
	if (await canConnect(socketPath))
		throw new Error(`Daemon socket is already active: ${socketPath}`);
	await unlink(socketPath);
}

function canConnect(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

function listen(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === code;
}
