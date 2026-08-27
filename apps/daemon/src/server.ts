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
	type DiagnosticsResult,
	type ModelEntry,
	type ModelInstallParams,
	type OperationProgressParams,
	type VoiceCloneParams,
	type VoiceProfile,
	type VoxSpeechConfig,
} from "@voxspeech/protocol";

import { createFakeSynthesis } from "./fake-synthesis.js";
import { SynthesisServiceError, type SynthesisService } from "./synthesis-service.js";

const VERSION = "0.1.0";
const DAEMON_METHOD_SET = new Set<string>(DAEMON_METHODS);

interface RpcRequest {
	readonly id: string;
	readonly jsonrpc: typeof JSON_RPC_VERSION;
	readonly method: string;
	readonly params?: unknown;
}

export interface DaemonServerOptions {
	readonly diagnostics?: Omit<DiagnosticsResult, "configValid" | "recentErrors">;
	readonly engineModelId?: () => string | null;
	readonly recentErrors?: () => DiagnosticsResult["recentErrors"];
	readonly services?: DaemonServices;
	readonly socketPath: string;
	readonly synthesis?: SynthesisService;
}

export interface DaemonConfigService {
	get(): Promise<VoxSpeechConfig> | VoxSpeechConfig;
	update(config: VoxSpeechConfig): Promise<void>;
	validate(config: unknown): { readonly errors: readonly string[]; readonly valid: boolean };
}

export interface DaemonModelService {
	install(
		id: string,
		options: Omit<ModelInstallParams, "id"> & {
			readonly onProgress?: (progress: {
				readonly bytes: number;
				readonly file: string;
				readonly size: number;
			}) => void;
			readonly signal?: AbortSignal;
		},
	): Promise<void>;
	list(): Promise<readonly ModelEntry[]>;
	remove(id: string): Promise<void>;
	use(id: string): Promise<void>;
	verify(id: string): Promise<boolean>;
}

export interface DaemonVoiceService {
	clone(params: VoiceCloneParams, options: { readonly signal?: AbortSignal }): Promise<void>;
	list(): Promise<readonly VoiceProfile[]>;
	remove(id: string): Promise<void>;
	show(id: string): Promise<VoiceProfile>;
	use(id: string): Promise<void>;
}

export interface DaemonServices {
	readonly config: DaemonConfigService;
	readonly models: DaemonModelService;
	readonly voices: DaemonVoiceService;
}

export interface DaemonServer {
	readonly socketPath: string;
	close(): Promise<void>;
}

interface ActiveTask {
	readonly controller: AbortController;
	readonly kind: "operation" | "speech";
	completion?: Promise<void>;
}

type ActiveTasks = Map<Socket, Map<string, ActiveTask>>;

export async function startDaemonServer(options: DaemonServerOptions): Promise<DaemonServer> {
	await prepareSocketPath(options.socketPath);
	const synthesis = options.synthesis ?? createFakeSynthesis();
	const active: ActiveTasks = new Map();
	const activeTasks = new Set<ActiveTask>();
	const sockets = new Set<Socket>();
	let closed = false;
	const server = createServer((socket) => {
		if (closed) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		handleConnection(socket, synthesis, options, active, activeTasks);
		socket.once("close", () => {
			sockets.delete(socket);
			for (const task of active.get(socket)?.values() ?? [])
				task.controller.abort(new Error("Client disconnected"));
			active.delete(socket);
		});
	});

	await listen(server, options.socketPath);
	await chmod(options.socketPath, 0o600);

	return {
		socketPath: options.socketPath,
		async close() {
			if (closed) return;
			closed = true;
			const serverClosed = closeServer(server);
			for (const tasks of active.values())
				for (const task of tasks.values()) task.controller.abort(new Error("Daemon stopped"));
			await Promise.allSettled([...activeTasks].map((task) => task.completion));
			for (const socket of sockets) socket.destroy();
			await serverClosed;
			await synthesis.close();
			await unlink(options.socketPath).catch((error: unknown) => {
				if (!isNodeError(error, "ENOENT")) throw error;
			});
		},
	};
}

function handleConnection(
	socket: Socket,
	synthesis: SynthesisService,
	options: DaemonServerOptions,
	active: ActiveTasks,
	activeTasks: Set<ActiveTask>,
): void {
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
			void dispatchLine(line, socket, write, synthesis, options, active, activeTasks, state)
				.then((result) => {
					if (result === "close") socket.end();
				})
				.catch(() => socket.destroy());
			newline = buffer.indexOf(0x0a);
		}
	});
}

async function dispatchLine(
	line: Buffer,
	socket: Socket,
	write: (message: unknown) => Promise<void>,
	synthesis: SynthesisService,
	options: DaemonServerOptions,
	active: ActiveTasks,
	activeTasks: Set<ActiveTask>,
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
			await write({
				jsonrpc: JSON_RPC_VERSION,
				id: request.id,
				result: await createStatus(
					synthesis,
					options.services?.config,
					options.engineModelId?.() ?? null,
				),
			});
			return;
		case "diagnostics.get": {
			if (!isEmptyParams(request.params)) return void (await write(invalidParams(request.id)));
			if (!options.diagnostics)
				return void (await write(unavailableResponse(request.id, request.method)));
			await write({
				jsonrpc: JSON_RPC_VERSION,
				id: request.id,
				result: {
					...options.diagnostics,
					configValid: true,
					recentErrors: options.recentErrors?.() ?? [],
				},
			});
			return;
		}
		case "config.get": {
			if (!options.services)
				return void (await write(unavailableResponse(request.id, request.method)));
			await respondWith(request.id, request.method, write, () => options.services!.config.get());
			return;
		}
		case "config.validate": {
			if (!options.services)
				return void (await write(unavailableResponse(request.id, request.method)));
			const params = request.params as { config: VoxSpeechConfig };
			await respondWith(request.id, request.method, write, async () => {
				const result = options.services!.config.validate(params.config);
				return { errors: [...result.errors], valid: result.valid };
			});
			return;
		}
		case "config.update": {
			if (!options.services)
				return void (await write(unavailableResponse(request.id, request.method)));
			const params = request.params as { config: VoxSpeechConfig };
			await respondWith(request.id, request.method, write, async () => {
				await options.services!.config.update(params.config);
				return { applied: true };
			});
			return;
		}
		case "model.list": {
			if (!options.services)
				return void (await write(unavailableResponse(request.id, request.method)));
			await respondWith(request.id, request.method, write, async () => ({
				models: await options.services!.models.list(),
			}));
			return;
		}
		case "model.install": {
			if (!options.services)
				return void (await write(unavailableResponse(request.id, request.method)));
			const params = request.params as ModelInstallParams;
			await runOperation(
				request.id,
				request.method,
				socket,
				write,
				active,
				activeTasks,
				async (signal, progress) => {
					await options.services!.models.install(params.id, {
						...(params.connections === undefined ? {} : { connections: params.connections }),
						...(params.hubUrl === undefined ? {} : { hubUrl: params.hubUrl }),
						...(params.proxy === undefined ? {} : { proxy: params.proxy }),
						onProgress: ({ bytes, file, size }) =>
							progress({ completed: bytes, phase: `downloading:${file}`, total: size }),
						signal,
					});
					return { id: params.id, success: true };
				},
			);
			return;
		}
		case "model.verify":
		case "model.use":
		case "model.remove": {
			if (!options.services)
				return void (await write(unavailableResponse(request.id, request.method)));
			const params = request.params as { id: string };
			await respondWith(request.id, request.method, write, async () => {
				if (request.method === "model.verify") {
					const success = await options.services!.models.verify(params.id);
					return { id: params.id, success };
				}
				await options.services!.models[request.method === "model.use" ? "use" : "remove"](
					params.id,
				);
				return { id: params.id, success: true };
			});
			return;
		}
		case "voice.list": {
			if (!options.services)
				return void (await write(unavailableResponse(request.id, request.method)));
			await respondWith(request.id, request.method, write, async () => ({
				voices: await options.services!.voices.list(),
			}));
			return;
		}
		case "voice.clone": {
			if (!options.services)
				return void (await write(unavailableResponse(request.id, request.method)));
			const params = request.params as VoiceCloneParams;
			await runOperation(
				request.id,
				request.method,
				socket,
				write,
				active,
				activeTasks,
				async (signal, progress) => {
					progress({ phase: "extracting" });
					await options.services!.voices.clone(params, { signal });
					return { id: params.id, success: true };
				},
			);
			return;
		}
		case "voice.show":
		case "voice.use":
		case "voice.remove": {
			if (!options.services)
				return void (await write(unavailableResponse(request.id, request.method)));
			const params = request.params as { id: string };
			await respondWith(request.id, request.method, write, async () => {
				if (request.method === "voice.show") return options.services!.voices.show(params.id);
				await options.services!.voices[request.method === "voice.use" ? "use" : "remove"](
					params.id,
				);
				return { id: params.id, success: true };
			});
			return;
		}
		case "speech.synthesize": {
			if (!isSynthesisParams(request.params)) return void (await write(invalidParams(request.id)));
			const tasks = active.get(socket) ?? new Map<string, ActiveTask>();
			active.set(socket, tasks);
			if (tasks.has(request.id)) return void (await write(invalidParams(request.id)));
			const controller = new AbortController();
			const task: ActiveTask = { controller, kind: "speech" };
			tasks.set(request.id, task);
			activeTasks.add(task);
			task.completion = runSynthesis(
				request.id,
				request.params,
				controller,
				write,
				synthesis,
			).finally(() => {
				tasks.delete(request.id);
				if (tasks.size === 0) active.delete(socket);
				activeTasks.delete(task);
			});
			await task.completion;
			return;
		}
		case "speech.cancel": {
			const requestId = parseCancelParams(request.params);
			if (!requestId) return void (await write(invalidParams(request.id)));
			const task = active.get(socket)?.get(requestId);
			if (task?.kind === "speech") task.controller.abort(new Error("Cancelled by client"));
			await write({
				jsonrpc: JSON_RPC_VERSION,
				id: request.id,
				result: { accepted: task?.kind === "speech" },
			});
			return;
		}
		default:
			await write(errorResponse(request.id, -32601, "Method not found"));
	}
}

async function runSynthesis(
	requestId: string,
	params: DaemonSpeechSynthesizeParams,
	controller: AbortController,
	write: (message: unknown) => Promise<void>,
	synthesis: SynthesisService,
): Promise<void> {
	await write({
		jsonrpc: JSON_RPC_VERSION,
		method: "speech.started",
		params: { requestId, ...synthesis.audio },
	});
	try {
		const result = await synthesis.run(params, controller.signal, (chunk) => {
			void write({
				jsonrpc: JSON_RPC_VERSION,
				method: "speech.audio",
				params: { data: chunk.data.toString("base64"), requestId, sequence: chunk.sequence },
			});
		});
		await write({ jsonrpc: JSON_RPC_VERSION, id: requestId, result });
	} catch (error) {
		await write(synthesisErrorResponse(requestId, error, controller.signal.aborted));
	}
}

async function runOperation<T>(
	requestId: string,
	method: string,
	socket: Socket,
	write: (message: unknown) => Promise<void>,
	active: ActiveTasks,
	activeTasks: Set<ActiveTask>,
	operation: (
		signal: AbortSignal,
		progress: (progress: Omit<OperationProgressParams, "requestId">) => void,
	) => Promise<T>,
): Promise<void> {
	const tasks = active.get(socket) ?? new Map<string, ActiveTask>();
	active.set(socket, tasks);
	if (tasks.has(requestId)) return void (await write(invalidParams(requestId)));
	const controller = new AbortController();
	const task: ActiveTask = { controller, kind: "operation" };
	tasks.set(requestId, task);
	activeTasks.add(task);
	task.completion = (async () => {
		try {
			const result = await operation(controller.signal, (progress) => {
				void write({
					jsonrpc: JSON_RPC_VERSION,
					method: "operation.progress",
					params: { ...progress, requestId },
				});
			});
			await write({ id: requestId, jsonrpc: JSON_RPC_VERSION, result });
		} catch (error) {
			await write(operationErrorResponse(requestId, method, error, controller.signal.aborted));
		}
	})().finally(() => {
		tasks.delete(requestId);
		if (tasks.size === 0) active.delete(socket);
		activeTasks.delete(task);
	});
	await task.completion;
}

async function respondWith<T>(
	requestId: string,
	method: string,
	write: (message: unknown) => Promise<void>,
	operation: () => Promise<T> | T,
): Promise<void> {
	try {
		await write({ id: requestId, jsonrpc: JSON_RPC_VERSION, result: await operation() });
	} catch (error) {
		await write(operationErrorResponse(requestId, method, error, false));
	}
}

async function createStatus(
	synthesis: SynthesisService,
	configService?: DaemonConfigService,
	engineModelId: string | null = null,
): Promise<DaemonStatusResult> {
	const engine = await synthesis.status().catch(() => ({
		backend: null,
		state: "stopped" as const,
	}));
	const config = await Promise.resolve(configService?.get()).catch(() => undefined);
	return {
		api: config?.api ?? { enabled: true, host: "127.0.0.1", port: 8080 },
		daemon: { state: "ready", version: VERSION },
		engine: { backend: engine.backend, modelId: engineModelId, state: engine.state },
		model: { defaultId: config?.model.default ?? null },
		voice: { defaultId: config?.voice.default ?? null },
	};
}

function unavailableResponse(requestId: string, method: string) {
	return errorResponse(requestId, -32002, "Invalid state", {
		code: "invalid_state",
		details: `${method} is unavailable because product services are not configured`,
		retryable: false,
		stage: method,
	});
}

function operationErrorResponse(
	requestId: string,
	method: string,
	error: unknown,
	cancelled: boolean,
) {
	const details = error instanceof Error ? error.message : undefined;
	if (cancelled)
		return errorResponse(requestId, -32005, "Request cancelled", {
			code: "request_cancelled",
			details,
			retryable: false,
			stage: method,
		});
	if (details?.includes("currently in use"))
		return errorResponse(requestId, -32007, "Resource busy", {
			code: "resource_busy",
			details,
			retryable: true,
			stage: method,
		});
	if (method === "voice.clone" && details?.toLowerCase().includes("extract"))
		return errorResponse(requestId, -32006, "Voice extraction failed", {
			code: "voice_extraction_failed",
			details,
			retryable: false,
			stage: method,
		});
	if (
		details?.toLowerCase().includes("verif") ||
		details?.toLowerCase().includes("checksum") ||
		details?.toLowerCase().includes("integrity")
	)
		return errorResponse(requestId, -32008, "Integrity check failed", {
			code: "integrity_check_failed",
			details,
			retryable: false,
			stage: method,
		});
	return errorResponse(requestId, -32002, "Invalid state", {
		code: "invalid_state",
		details,
		retryable: false,
		stage: method,
	});
}

function synthesisErrorResponse(requestId: string, error: unknown, cancelled: boolean) {
	if (cancelled)
		return errorResponse(requestId, -32005, "Request cancelled", {
			code: "request_cancelled",
			details: error instanceof Error ? error.message : undefined,
			retryable: false,
			stage: "speech.synthesize",
		});
	const serviceError = error instanceof SynthesisServiceError ? error : undefined;
	if (serviceError?.code === "invalid_state")
		return errorResponse(requestId, -32002, "Invalid state", {
			code: serviceError.code,
			details: serviceError.message,
			retryable: false,
			stage: "speech.synthesize",
		});
	if (serviceError?.code === "resource_busy")
		return errorResponse(requestId, -32007, "Resource busy", {
			code: serviceError.code,
			details: serviceError.message,
			retryable: true,
			stage: "speech.synthesize",
		});
	return errorResponse(requestId, -32004, "Synthesis failed", {
		code: "synthesis_failed",
		details: error instanceof Error ? error.message : undefined,
		retryable: serviceError?.retryable ?? true,
		stage: "speech.synthesize",
	});
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
