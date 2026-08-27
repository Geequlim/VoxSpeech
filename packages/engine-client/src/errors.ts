import type { ErrorData, JsonRpcError } from "@voxspeech/protocol";

export class EngineClientError extends Error {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
	}
}

export class EngineProtocolError extends EngineClientError {}

export class EngineTimeoutError extends EngineClientError {
	public constructor(
		public readonly requestId: string,
		public readonly timeoutMs: number,
	) {
		super(`Engine request ${requestId} timed out after ${timeoutMs} ms`);
	}
}

export class EngineExitedError extends EngineClientError {
	public constructor(
		public readonly exitCode: number | null,
		public readonly signal: NodeJS.Signals | null,
		public readonly stderr: string,
	) {
		const status = signal ? `signal ${signal}` : `code ${String(exitCode)}`;
		super(`Engine exited with ${status}`);
	}
}

export class EngineRpcError extends EngineClientError {
	public readonly code: number;
	public readonly data?: ErrorData;

	public constructor(
		public readonly requestId: string,
		error: JsonRpcError,
	) {
		super(error.message);
		this.code = error.code;
		this.data = error.data;
	}
}
