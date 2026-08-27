import {
	spawn,
	type ChildProcessWithoutNullStreams,
	type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { Value } from "@sinclair/typebox/value";
import type { Static, TSchema } from "@sinclair/typebox";
import {
	EngineInitializeResultSchema,
	EngineLoadResultSchema,
	EngineNotificationSchema,
	EngineShutdownResultSchema,
	EngineStatusResultSchema,
	ErrorResponseSchema,
	JSON_RPC_VERSION,
	MAX_AUDIO_CHUNK_BYTES,
	MAX_MESSAGE_BYTES,
	PROTOCOL_VERSION,
	SpeechCancelResultSchema,
	SpeechResultSchema,
	VoiceExtractResultSchema,
	type EngineLoadParams,
	type EngineLoadResult,
	type EngineSpeechSynthesizeParams,
	type EngineStatusResult,
	type PeerInfo,
	type SpeechAudioParams,
	type SpeechCancelResult,
	type SpeechResult,
	type SpeechStartedParams,
	type VoiceExtractParams,
	type VoiceExtractResult,
} from "@voxspeech/protocol";

import {
	EngineClientError,
	EngineExitedError,
	EngineProtocolError,
	EngineRpcError,
	EngineTimeoutError,
} from "./errors.js";

export interface EngineClientOptions {
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly clientInfo?: PeerInfo;
	readonly requestTimeoutMs?: number;
	readonly shutdownTimeoutMs?: number;
	readonly onStderr?: (text: string) => void;
}

export interface SynthesisHandlers {
	readonly onStarted?: (params: SpeechStartedParams) => void;
	readonly onAudio?: (audio: Buffer, params: SpeechAudioParams) => void;
}

export interface SynthesisHandle {
	readonly requestId: string;
	readonly result: Promise<SpeechResult>;
	cancel(): Promise<SpeechCancelResult>;
}

interface PendingRequest {
	readonly resultSchema: TSchema;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: NodeJS.Timeout;
}

interface SynthesisStream {
	readonly handlers: SynthesisHandlers;
	started: boolean;
	nextSequence: number;
}

interface JsonRpcResponse {
	readonly jsonrpc: "2.0";
	readonly id: string;
	readonly result?: unknown;
	readonly error?: unknown;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const STDERR_TAIL_BYTES = 256 * 1024;
const DEFAULT_CLIENT_INFO: PeerInfo = { name: "voxspeech-engine-client", version: "0.1.0" };

const BASE64_VALUES = (() => {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	const values = new Int8Array(128).fill(-1);
	for (let index = 0; index < alphabet.length; index++) values[alphabet.charCodeAt(index)] = index;
	return values;
})();

function decodeAudioChunk(data: string): Buffer | null {
	if (data.length === 0 || data.length % 4 !== 0) return null;
	let padding = 0;
	while (padding < data.length && data[data.length - 1 - padding] === "=") padding++;
	if (padding > 2) return null;
	const dataEnd = data.length - padding;
	for (let index = 0; index < dataEnd; index++) {
		const code = data.charCodeAt(index);
		if (code >= 128 || BASE64_VALUES[code] < 0) return null;
	}
	if (
		padding > 0 &&
		(BASE64_VALUES[data.charCodeAt(dataEnd - 1)] & (padding === 1 ? 0b11 : 0b1111)) !== 0
	) {
		return null;
	}
	const decoded = Buffer.from(data, "base64");
	if (decoded.length !== (data.length / 4) * 3 - padding) return null;
	if (decoded.length % 2 !== 0 || decoded.length > MAX_AUDIO_CHUNK_BYTES) return null;
	return decoded;
}

export class EngineClient {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #requestTimeoutMs: number;
	readonly #shutdownTimeoutMs: number;
	readonly #onStderr?: (text: string) => void;
	readonly #pending = new Map<string, PendingRequest>();
	readonly #synthesisStreams = new Map<string, SynthesisStream>();
	readonly #decoder = new StringDecoder("utf8");
	readonly #stderrDecoder = new StringDecoder("utf8");
	#stdoutBuffer = "";
	#stderr = "";
	#nextRequestId = 1;
	#closed = false;
	#shutdownPromise?: Promise<void>;

	private constructor(child: ChildProcessWithoutNullStreams, options: EngineClientOptions) {
		this.#child = child;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
		this.#onStderr = options.onStderr;

		child.stdout.on("data", (chunk: Buffer) => this.#receiveStdout(chunk));
		child.stderr.on("data", (chunk: Buffer) => this.#receiveStderr(chunk));
		child.stdout.on("error", (error) =>
			this.#abortSession(new EngineClientError("Engine stdout stream failed", { cause: error })),
		);
		child.stderr.on("error", (error) =>
			this.#abortSession(new EngineClientError("Engine stderr stream failed", { cause: error })),
		);
		child.stdin.on("error", (error) => {
			this.#abortSession(
				new EngineClientError("Failed to write to engine stdin", { cause: error }),
			);
		});
		child.once("error", (error) => {
			this.#closed = true;
			this.#fail(new EngineClientError("Failed to start engine", { cause: error }));
		});
		child.once("close", (code, signal) => {
			this.#closed = true;
			this.#fail(new EngineExitedError(code, signal, this.#stderr));
		});
	}

	public static async spawn(options: EngineClientOptions): Promise<EngineClient> {
		const spawnOptions: SpawnOptionsWithoutStdio = {
			cwd: options.cwd,
			env: options.env,
			stdio: "pipe",
		};
		const child = spawn(options.command, [...(options.args ?? [])], spawnOptions);
		const client = new EngineClient(child, options);
		await client.#waitForSpawn();
		try {
			await client.#request(
				"initialize",
				{
					protocolVersion: PROTOCOL_VERSION,
					clientInfo: options.clientInfo ?? DEFAULT_CLIENT_INFO,
				},
				EngineInitializeResultSchema,
			);
			return client;
		} catch (error) {
			await client.#terminate();
			throw error;
		}
	}

	public get pid(): number | undefined {
		return this.#child.pid;
	}

	public get stderr(): string {
		return this.#stderr;
	}

	public load(params: EngineLoadParams): Promise<EngineLoadResult> {
		return this.#request("engine.load", params, EngineLoadResultSchema);
	}

	public status(): Promise<EngineStatusResult> {
		return this.#request("engine.status", {}, EngineStatusResultSchema);
	}

	public startSynthesis(
		params: EngineSpeechSynthesizeParams,
		handlers: SynthesisHandlers = {},
	): SynthesisHandle {
		const requestId = this.#allocateRequestId();
		this.#synthesisStreams.set(requestId, { handlers, started: false, nextSequence: 0 });
		const result = this.#requestWithId(
			requestId,
			"speech.synthesize",
			params,
			SpeechResultSchema,
		).finally(() => this.#synthesisStreams.delete(requestId));

		return {
			requestId,
			result,
			cancel: () => this.cancel(requestId),
		};
	}

	public cancel(requestId: string): Promise<SpeechCancelResult> {
		return this.#request("speech.cancel", { requestId }, SpeechCancelResultSchema);
	}

	public extractVoice(params: VoiceExtractParams): Promise<VoiceExtractResult> {
		return this.#request("voice.extract", params, VoiceExtractResultSchema);
	}

	public shutdown(): Promise<void> {
		this.#shutdownPromise ??= this.#performShutdown();
		return this.#shutdownPromise;
	}

	async #performShutdown(): Promise<void> {
		if (this.#closed) return;

		try {
			await this.#request(
				"engine.shutdown",
				{},
				EngineShutdownResultSchema,
				this.#shutdownTimeoutMs,
			);
		} catch (error) {
			await this.#terminate();
			throw error;
		}
		this.#child.stdin.end();
		await this.#observeCloseWithEscalation();
	}

	async #terminate(): Promise<void> {
		if (this.#closed && (this.#child.exitCode !== null || this.#child.signalCode !== null)) {
			return;
		}
		await new Promise<void>((resolve) => {
			const killTimer = setTimeout(() => this.#child.kill("SIGKILL"), this.#shutdownTimeoutMs);
			this.#child.once("close", () => {
				clearTimeout(killTimer);
				resolve();
			});
			this.#child.kill("SIGTERM");
		});
	}

	#observeCloseWithEscalation(): Promise<void> {
		if (this.#closed && (this.#child.exitCode !== null || this.#child.signalCode !== null)) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			let killTimer: NodeJS.Timeout | undefined;
			const sigtermTimer = setTimeout(() => {
				this.#child.kill("SIGTERM");
				killTimer = setTimeout(() => this.#child.kill("SIGKILL"), this.#shutdownTimeoutMs);
			}, this.#shutdownTimeoutMs);
			this.#child.once("close", () => {
				clearTimeout(sigtermTimer);
				if (killTimer) clearTimeout(killTimer);
				resolve();
			});
		});
	}

	#waitForSpawn(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.#child.once("spawn", resolve);
			this.#child.once("error", (error) =>
				reject(new EngineClientError("Failed to start engine", { cause: error })),
			);
		});
	}

	#request<TResultSchema extends TSchema>(
		method: string,
		params: unknown,
		resultSchema: TResultSchema,
		timeoutMs = this.#requestTimeoutMs,
	): Promise<Static<TResultSchema>> {
		return this.#requestWithId(this.#allocateRequestId(), method, params, resultSchema, timeoutMs);
	}

	#requestWithId<TResultSchema extends TSchema>(
		requestId: string,
		method: string,
		params: unknown,
		resultSchema: TResultSchema,
		timeoutMs = this.#requestTimeoutMs,
	): Promise<Static<TResultSchema>> {
		if (this.#closed) return Promise.reject(new EngineClientError("Engine is not running"));

		const promise = new Promise<Static<TResultSchema>>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(requestId);
				this.#synthesisStreams.delete(requestId);
				reject(new EngineTimeoutError(requestId, timeoutMs));
			}, timeoutMs);
			this.#pending.set(requestId, {
				resultSchema,
				resolve: (value) => resolve(value as Static<TResultSchema>),
				reject,
				timer,
			});
		});

		try {
			this.#write({ jsonrpc: JSON_RPC_VERSION, id: requestId, method, params });
		} catch (error) {
			const pending = this.#pending.get(requestId);
			if (pending) {
				clearTimeout(pending.timer);
				this.#pending.delete(requestId);
				this.#synthesisStreams.delete(requestId);
				pending.reject(error instanceof Error ? error : new EngineClientError(String(error)));
			}
		}
		return promise;
	}

	#allocateRequestId(): string {
		return String(this.#nextRequestId++);
	}

	#write(message: unknown): void {
		const line = `${JSON.stringify(message)}\n`;
		if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
			throw new EngineProtocolError("Outgoing engine message exceeds 1 MiB");
		}
		this.#child.stdin.write(line);
	}

	#receiveStdout(chunk: Buffer): void {
		if (this.#closed) return;
		this.#stdoutBuffer += this.#decoder.write(chunk);
		if (
			Buffer.byteLength(this.#stdoutBuffer, "utf8") > MAX_MESSAGE_BYTES &&
			!this.#stdoutBuffer.includes("\n")
		) {
			this.#protocolFailure("Incoming engine message exceeds 1 MiB");
			return;
		}

		let newline = this.#stdoutBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.#stdoutBuffer.slice(0, newline);
			this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
			if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
				this.#protocolFailure("Incoming engine message exceeds 1 MiB");
				return;
			}
			if (line.length > 0) this.#handleLine(line);
			if (this.#closed) return;
			newline = this.#stdoutBuffer.indexOf("\n");
		}
	}

	#receiveStderr(chunk: Buffer): void {
		const text = this.#stderrDecoder.write(chunk);
		if (!text) return;
		this.#stderr += text;
		if (Buffer.byteLength(this.#stderr, "utf8") > STDERR_TAIL_BYTES) {
			const bytes = Buffer.from(this.#stderr, "utf8");
			let start = bytes.length - STDERR_TAIL_BYTES;
			while ((bytes[start] & 0xc0) === 0x80) start++;
			this.#stderr = bytes.subarray(start).toString("utf8");
		}
		this.#onStderr?.(text);
	}

	#handleLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch (error) {
			this.#protocolFailure("Engine stdout contained invalid JSON", error);
			return;
		}

		if (!message || typeof message !== "object") {
			this.#protocolFailure("Engine stdout contained a non-object message");
			return;
		}

		if ("id" in message) this.#handleResponse(message);
		else this.#handleNotification(message);
	}

	#handleResponse(message: object): void {
		const response = message as Partial<JsonRpcResponse>;
		if (
			response.jsonrpc !== JSON_RPC_VERSION ||
			typeof response.id !== "string" ||
			!response.id ||
			!Object.keys(response).every((key) => ["jsonrpc", "id", "result", "error"].includes(key))
		) {
			this.#protocolFailure("Engine returned an invalid response envelope");
			return;
		}

		const pending = this.#pending.get(response.id);
		if (!pending) {
			this.#protocolFailure("Engine returned a response with an unexpected request ID");
			return;
		}

		if ("error" in response) {
			if (!Value.Check(ErrorResponseSchema, message)) {
				this.#protocolFailure("Engine returned an invalid error response");
				return;
			}
			this.#synthesisStreams.delete(response.id);
			clearTimeout(pending.timer);
			this.#pending.delete(response.id);
			pending.reject(new EngineRpcError(response.id, message.error));
			return;
		}

		if (!("result" in response) || !Value.Check(pending.resultSchema, response.result)) {
			this.#protocolFailure("Engine returned a result that violates the protocol");
			return;
		}
		const synthesis = this.#synthesisStreams.get(response.id);
		if (synthesis && !synthesis.started) {
			this.#protocolFailure("Engine completed synthesis before speech.started");
			return;
		}
		this.#synthesisStreams.delete(response.id);
		clearTimeout(pending.timer);
		this.#pending.delete(response.id);
		pending.resolve(response.result);
	}

	#handleNotification(message: object): void {
		if (!Value.Check(EngineNotificationSchema, message)) {
			this.#protocolFailure("Engine returned an unknown or invalid notification");
			return;
		}
		if (message.method === "speech.started") this.#handleStarted(message.params);
		else this.#handleAudio(message.params);
	}

	#handleStarted(params: SpeechStartedParams): void {
		const stream = this.#synthesisStreams.get(params.requestId);
		if (!stream || stream.started) {
			this.#protocolFailure("Engine returned an unexpected speech.started notification");
			return;
		}
		stream.started = true;
		stream.handlers.onStarted?.(params);
	}

	#handleAudio(params: SpeechAudioParams): void {
		const stream = this.#synthesisStreams.get(params.requestId);
		if (!stream?.started || params.sequence !== stream.nextSequence) {
			this.#protocolFailure("Engine returned speech.audio out of order");
			return;
		}
		const audio = decodeAudioChunk(params.data);
		if (!audio) {
			this.#protocolFailure("Engine sent an audio chunk that is not canonical Base64 PCM");
			return;
		}
		stream.nextSequence++;
		stream.handlers.onAudio?.(audio, params);
	}

	#protocolFailure(message: string, cause?: unknown): void {
		this.#abortSession(
			new EngineProtocolError(message, cause instanceof Error ? { cause } : undefined),
		);
	}

	#abortSession(error: Error): void {
		if (!this.#closed) {
			this.#closed = true;
			void this.#terminate();
		}
		this.#fail(error);
	}

	#fail(error: Error): void {
		for (const [requestId, pending] of this.#pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
			this.#pending.delete(requestId);
		}
		this.#synthesisStreams.clear();
	}
}
