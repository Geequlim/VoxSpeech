import { createConnection, type Socket } from "node:net";

import { Value } from "@sinclair/typebox/value";
import {
	DaemonInitializeResultSchema,
	DaemonNotificationSchema,
	DaemonStatusResultSchema,
	type ErrorData,
	ConfigUpdateResultSchema,
	ConfigValidationResultSchema,
	ErrorResponseSchema,
	JSON_RPC_VERSION,
	MAX_AUDIO_CHUNK_BYTES,
	MAX_MESSAGE_BYTES,
	ModelListResultSchema,
	ModelOperationResultSchema,
	PROTOCOL_VERSION,
	type PCM_CHANNELS,
	type PCM_ENCODING,
	type PCM_SAMPLE_RATE,
	SpeechResultSchema,
	VoiceListResultSchema,
	VoiceOperationResultSchema,
	VoiceProfileSchema,
	VoxSpeechConfigSchema,
	type ConfigUpdateResult,
	type ConfigValidationResult,
	type DaemonSpeechSynthesizeParams,
	type DaemonStatusResult,
	type ModelInstallParams,
	type ModelListResult,
	type ModelOperationResult,
	type OperationProgressParams,
	type SpeechResult,
	type SpeechStartedParams,
	type VoiceCloneParams,
	type VoiceListResult,
	type VoiceOperationResult,
	type VoiceProfile,
	type VoxSpeechConfig,
} from "@voxspeech/protocol";

export interface RpcClientOptions {
	readonly connectTimeoutMs?: number;
	readonly connectionFactory?: (socketPath: string) => Socket;
	readonly requestTimeoutMs?: number;
	readonly socketPath: string;
}

export interface SynthesisOutput {
	readonly audio: Buffer;
	readonly format: {
		readonly channels: typeof PCM_CHANNELS;
		readonly encoding: typeof PCM_ENCODING;
		readonly sampleRate: typeof PCM_SAMPLE_RATE;
	};
	readonly result: SpeechResult;
}

export interface OperationOptions {
	readonly onProgress?: (progress: OperationProgressParams) => void;
}

interface PendingRequest {
	reject(error: Error): void;
	resolve(result: unknown): void;
	timer?: NodeJS.Timeout;
}

export class DaemonRpcError extends Error {
	constructor(
		message: string,
		readonly code: number,
		readonly data?: ErrorData,
	) {
		super(data?.details ? `${message}: ${data.details}` : message);
		this.name = "DaemonRpcError";
	}
}

export class DaemonRpcClient {
	readonly #requestTimeoutMs: number;
	readonly #socket: Socket;
	readonly #pending = new Map<string, PendingRequest>();
	readonly #audioChunks = new Map<string, Buffer[]>();
	readonly #started = new Map<string, SpeechStartedParams>();
	readonly #nextSequence = new Map<string, number>();
	readonly #progress = new Map<string, (progress: OperationProgressParams) => void>();
	#buffer = Buffer.alloc(0);
	#nextId = 1;
	#closed = false;

	private constructor(socket: Socket, requestTimeoutMs: number) {
		this.#socket = socket;
		this.#requestTimeoutMs = requestTimeoutMs;
		socket.on("data", (chunk) => this.#handleData(chunk));
		socket.once("close", () => this.#failAll(new Error("Daemon connection closed")));
		socket.once("error", (error) => this.#failAll(error));
	}

	static async connect(options: RpcClientOptions): Promise<DaemonRpcClient> {
		const socket = await connectSocket(
			options.socketPath,
			options.connectTimeoutMs ?? 2_000,
			options.connectionFactory,
		);
		const client = new DaemonRpcClient(socket, options.requestTimeoutMs ?? 30_000);
		try {
			const result = await client.#request("initialize", {
				clientInfo: { name: "voxspeech-cli", version: "0.1.0" },
				protocolVersion: PROTOCOL_VERSION,
			});
			if (!isInitializeResult(result))
				throw new Error("Daemon returned an invalid initialize result");
			return client;
		} catch (error) {
			client.close();
			throw error;
		}
	}

	async status(): Promise<DaemonStatusResult> {
		const result = await this.#request("daemon.status", {});
		if (!isDaemonStatus(result)) throw new Error("Daemon returned an invalid status result");
		return result;
	}

	async getConfig(): Promise<VoxSpeechConfig> {
		return this.#validatedRequest("config.get", {}, VoxSpeechConfigSchema, "config");
	}

	async validateConfig(config: VoxSpeechConfig): Promise<ConfigValidationResult> {
		return this.#validatedRequest(
			"config.validate",
			{ config },
			ConfigValidationResultSchema,
			"config validation",
		);
	}

	async updateConfig(config: VoxSpeechConfig): Promise<ConfigUpdateResult> {
		return this.#validatedRequest(
			"config.update",
			{ config },
			ConfigUpdateResultSchema,
			"config update",
		);
	}

	async listModels(): Promise<ModelListResult> {
		return this.#validatedRequest("model.list", {}, ModelListResultSchema, "model list");
	}

	async installModel(
		params: ModelInstallParams,
		options: OperationOptions = {},
	): Promise<ModelOperationResult> {
		return this.#operation(
			"model.install",
			params,
			ModelOperationResultSchema,
			"model install",
			options,
		);
	}

	async verifyModel(id: string): Promise<ModelOperationResult> {
		return this.#validatedRequest(
			"model.verify",
			{ id },
			ModelOperationResultSchema,
			"model verification",
		);
	}

	async useModel(id: string): Promise<ModelOperationResult> {
		return this.#validatedRequest(
			"model.use",
			{ id },
			ModelOperationResultSchema,
			"model selection",
		);
	}

	async removeModel(id: string): Promise<ModelOperationResult> {
		return this.#validatedRequest(
			"model.remove",
			{ id },
			ModelOperationResultSchema,
			"model removal",
		);
	}

	async listVoices(): Promise<VoiceListResult> {
		return this.#validatedRequest("voice.list", {}, VoiceListResultSchema, "voice list");
	}

	async cloneVoice(
		params: VoiceCloneParams,
		options: OperationOptions = {},
	): Promise<VoiceOperationResult> {
		return this.#operation(
			"voice.clone",
			params,
			VoiceOperationResultSchema,
			"voice clone",
			options,
		);
	}

	async showVoice(id: string): Promise<VoiceProfile> {
		return this.#validatedRequest("voice.show", { id }, VoiceProfileSchema, "voice profile");
	}

	async useVoice(id: string): Promise<VoiceOperationResult> {
		return this.#validatedRequest(
			"voice.use",
			{ id },
			VoiceOperationResultSchema,
			"voice selection",
		);
	}

	async removeVoice(id: string): Promise<VoiceOperationResult> {
		return this.#validatedRequest(
			"voice.remove",
			{ id },
			VoiceOperationResultSchema,
			"voice removal",
		);
	}

	async synthesize(
		params: DaemonSpeechSynthesizeParams,
		options: { readonly signal?: AbortSignal } = {},
	): Promise<SynthesisOutput> {
		const id = this.#allocateId();
		this.#audioChunks.set(id, []);
		this.#nextSequence.set(id, 0);
		const cancel = () => {
			void this.#request("speech.cancel", { requestId: id }).catch(() => undefined);
		};
		if (options.signal?.aborted) queueMicrotask(cancel);
		else options.signal?.addEventListener("abort", cancel, { once: true });
		try {
			const result = await this.#requestWithId(id, "speech.synthesize", params);
			if (!isSpeechResult(result)) throw new Error("Daemon returned an invalid synthesis result");
			const started = this.#started.get(id);
			if (!started) throw new Error("Daemon completed synthesis before speech.started");
			return {
				audio: Buffer.concat(this.#audioChunks.get(id) ?? []),
				format: {
					channels: started.channels,
					encoding: started.encoding,
					sampleRate: started.sampleRate,
				},
				result,
			};
		} finally {
			options.signal?.removeEventListener("abort", cancel);
			this.#audioChunks.delete(id);
			this.#nextSequence.delete(id);
			this.#started.delete(id);
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#socket.destroy();
		this.#failAll(new Error("Daemon connection closed"));
	}

	#request(method: string, params: unknown): Promise<unknown> {
		return this.#requestWithId(this.#allocateId(), method, params);
	}

	async #validatedRequest<T>(
		method: string,
		params: unknown,
		schema: Parameters<typeof Value.Check>[0],
		label: string,
	): Promise<T> {
		const result = await this.#request(method, params);
		if (!Value.Check(schema, result)) throw new Error(`Daemon returned an invalid ${label} result`);
		return result as T;
	}

	async #operation<T>(
		method: string,
		params: unknown,
		schema: Parameters<typeof Value.Check>[0],
		label: string,
		options: OperationOptions,
	): Promise<T> {
		const id = this.#allocateId();
		if (options.onProgress) this.#progress.set(id, options.onProgress);
		try {
			const result = await this.#requestWithId(id, method, params, 0);
			if (!Value.Check(schema, result))
				throw new Error(`Daemon returned an invalid ${label} result`);
			return result as T;
		} finally {
			this.#progress.delete(id);
		}
	}

	#requestWithId(
		id: string,
		method: string,
		params: unknown,
		timeoutMs: number = this.#requestTimeoutMs,
	): Promise<unknown> {
		if (this.#closed) return Promise.reject(new Error("Daemon connection is closed"));
		return new Promise((resolve, reject) => {
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							this.#pending.delete(id);
							reject(new Error(`Daemon request timed out: ${method}`));
						}, timeoutMs)
					: undefined;
			this.#pending.set(id, { reject, resolve, timer });
			this.#socket.write(
				`${JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, method, params })}\n`,
				(error) => {
					if (!error) return;
					if (timer) clearTimeout(timer);
					this.#pending.delete(id);
					reject(error);
				},
			);
		});
	}

	#allocateId(): string {
		const id = `cli-${this.#nextId}`;
		this.#nextId += 1;
		return id;
	}

	#handleData(chunk: Buffer): void {
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		if (this.#buffer.byteLength > MAX_MESSAGE_BYTES && !this.#buffer.includes(0x0a)) {
			this.close();
			return;
		}
		let newline = this.#buffer.indexOf(0x0a);
		while (newline >= 0) {
			const line = this.#buffer.subarray(0, newline);
			this.#buffer = this.#buffer.subarray(newline + 1);
			if (line.byteLength > MAX_MESSAGE_BYTES) {
				this.close();
				return;
			}
			this.#handleMessage(line);
			newline = this.#buffer.indexOf(0x0a);
		}
	}

	#handleMessage(line: Buffer): void {
		let value: unknown;
		try {
			value = JSON.parse(line.toString("utf8"));
		} catch {
			this.#failAll(new Error("Daemon returned invalid JSON"));
			this.#socket.destroy();
			return;
		}
		if (!isRecord(value) || value.jsonrpc !== JSON_RPC_VERSION)
			return void this.#protocolFailure("Daemon returned an invalid JSON-RPC message");
		if ("method" in value) {
			if (!Value.Check(DaemonNotificationSchema, value))
				return void this.#protocolFailure("Daemon returned an invalid notification");
			if (value.method === "operation.progress") {
				this.#progress.get(value.params.requestId)?.(value.params);
				return;
			}
			if (value.method === "speech.started") {
				const params = value.params;
				if (this.#started.has(params.requestId))
					return void this.#protocolFailure("Daemon returned duplicate speech.started");
				this.#started.set(params.requestId, params);
				return;
			}
			const params = value.params;
			const expected = this.#nextSequence.get(params.requestId);
			if (
				expected === undefined ||
				params.sequence !== expected ||
				!this.#started.has(params.requestId)
			)
				return void this.#protocolFailure("Daemon returned out-of-order speech audio");
			const chunk = Buffer.from(params.data, "base64");
			if (chunk.byteLength > MAX_AUDIO_CHUNK_BYTES)
				return void this.#protocolFailure("Daemon returned an oversized audio chunk");
			this.#nextSequence.set(params.requestId, expected + 1);
			this.#audioChunks.get(params.requestId)?.push(chunk);
			return;
		}
		if (typeof value.id !== "string") return;
		const pending = this.#pending.get(value.id);
		if (!pending) return;
		this.#pending.delete(value.id);
		if (pending.timer) clearTimeout(pending.timer);
		if (Value.Check(ErrorResponseSchema, value)) {
			const error = value.error;
			pending.reject(new DaemonRpcError(error.message, error.code, error.data));
		} else if (
			"result" in value &&
			Object.keys(value).every((key) => ["jsonrpc", "id", "result"].includes(key))
		) {
			pending.resolve(value.result);
		} else {
			pending.reject(new Error("Daemon returned an invalid JSON-RPC response"));
		}
	}

	#protocolFailure(message: string): void {
		this.#failAll(new Error(message));
		this.#socket.destroy();
	}

	#failAll(error: Error): void {
		for (const pending of this.#pending.values()) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

function connectSocket(
	socketPath: string,
	timeoutMs: number,
	connectionFactory: (socketPath: string) => Socket = createConnection,
): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connectionFactory(socketPath);
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`Timed out connecting to daemon at ${socketPath}`));
		}, timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			resolve(socket);
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			reject(new Error(`Unable to connect to daemon at ${socketPath}: ${error.message}`));
		});
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInitializeResult(value: unknown): boolean {
	return Value.Check(DaemonInitializeResultSchema, value);
}

function isDaemonStatus(value: unknown): value is DaemonStatusResult {
	return Value.Check(DaemonStatusResultSchema, value);
}

function isSpeechResult(value: unknown): value is SpeechResult {
	return Value.Check(SpeechResultSchema, value);
}
