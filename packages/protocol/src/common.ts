import { Type, type Static, type TSchema } from "@sinclair/typebox";

export const JSON_RPC_VERSION = "2.0" as const;
export const PROTOCOL_VERSION = 1 as const;
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const MAX_AUDIO_CHUNK_BYTES = 64 * 1024;
export const PCM_CHANNELS = 1 as const;
export const PCM_ENCODING = "pcm_s16le" as const;
export const PCM_SAMPLE_RATE = 24_000 as const;

const strictObject = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const RequestIdSchema = Type.String({ minLength: 1 });
export const PeerInfoSchema = strictObject({
	name: Type.String({ minLength: 1 }),
	version: Type.String({ minLength: 1 }),
});
export const InitializeParamsSchema = strictObject({
	protocolVersion: Type.Literal(PROTOCOL_VERSION),
	clientInfo: PeerInfoSchema,
});

export const VoxSpeechErrorCodeSchema = Type.Union([
	Type.Literal("protocol_version_mismatch"),
	Type.Literal("invalid_state"),
	Type.Literal("model_load_failed"),
	Type.Literal("synthesis_failed"),
	Type.Literal("request_cancelled"),
	Type.Literal("voice_extraction_failed"),
	Type.Literal("resource_busy"),
	Type.Literal("integrity_check_failed"),
]);
export const JsonRpcErrorCodeSchema = Type.Union([
	Type.Literal(-32700),
	Type.Literal(-32600),
	Type.Literal(-32601),
	Type.Literal(-32602),
	Type.Literal(-32603),
	Type.Literal(-32001),
	Type.Literal(-32002),
	Type.Literal(-32003),
	Type.Literal(-32004),
	Type.Literal(-32005),
	Type.Literal(-32006),
	Type.Literal(-32007),
	Type.Literal(-32008),
]);
export const ErrorDataSchema = strictObject({
	code: VoxSpeechErrorCodeSchema,
	stage: Type.String({ minLength: 1 }),
	retryable: Type.Boolean(),
	details: Type.Optional(Type.String()),
});
export const JsonRpcErrorSchema = strictObject({
	code: JsonRpcErrorCodeSchema,
	message: Type.String(),
	data: Type.Optional(ErrorDataSchema),
});

export function requestSchema<TMethod extends string, TParams extends TSchema>(
	method: TMethod,
	params: TParams,
) {
	return strictObject({
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RequestIdSchema,
		method: Type.Literal(method),
		params,
	});
}

export function notificationSchema<TMethod extends string, TParams extends TSchema>(
	method: TMethod,
	params: TParams,
) {
	return strictObject({
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		method: Type.Literal(method),
		params,
	});
}

export function successResponseSchema<TResult extends TSchema>(result: TResult) {
	return strictObject({
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RequestIdSchema,
		result,
	});
}

export const ErrorResponseSchema = strictObject({
	jsonrpc: Type.Literal(JSON_RPC_VERSION),
	id: Type.Union([RequestIdSchema, Type.Null()]),
	error: JsonRpcErrorSchema,
});
export const EmptyParamsSchema = strictObject({});
export const AcceptedResultSchema = strictObject({ accepted: Type.Boolean() });

export const SpeechCancelParamsSchema = strictObject({ requestId: RequestIdSchema });
export const SpeechCancelResultSchema = AcceptedResultSchema;
export const SpeechStartedParamsSchema = strictObject({
	requestId: RequestIdSchema,
	encoding: Type.Literal(PCM_ENCODING),
	sampleRate: Type.Literal(PCM_SAMPLE_RATE),
	channels: Type.Literal(PCM_CHANNELS),
});

const base64Pattern = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";
const maximumAudioBase64Pattern = "^(?:[A-Za-z0-9+/]{4}){21845}[A-Za-z0-9+/]{2}==$";
export const SpeechAudioParamsSchema = strictObject({
	requestId: RequestIdSchema,
	sequence: Type.Integer({ minimum: 0 }),
	data: Type.Union([
		Type.String({ pattern: base64Pattern, maxLength: 87_380 }),
		Type.String({ pattern: maximumAudioBase64Pattern, minLength: 87_384, maxLength: 87_384 }),
	]),
});
export const SpeechResultSchema = strictObject({
	sampleCount: Type.Integer({ minimum: 0 }),
	durationMs: Type.Integer({ minimum: 0 }),
	firstAudioMs: Type.Integer({ minimum: 0 }),
	processingMs: Type.Integer({ minimum: 0 }),
});

export type RequestId = Static<typeof RequestIdSchema>;
export type PeerInfo = Static<typeof PeerInfoSchema>;
export type InitializeParams = Static<typeof InitializeParamsSchema>;
export type VoxSpeechErrorCode = Static<typeof VoxSpeechErrorCodeSchema>;
export type JsonRpcErrorCode = Static<typeof JsonRpcErrorCodeSchema>;
export type ErrorData = Static<typeof ErrorDataSchema>;
export type JsonRpcError = Static<typeof JsonRpcErrorSchema>;
export type ErrorResponse = Static<typeof ErrorResponseSchema>;
export type SpeechCancelParams = Static<typeof SpeechCancelParamsSchema>;
export type SpeechCancelResult = Static<typeof SpeechCancelResultSchema>;
export type SpeechStartedParams = Static<typeof SpeechStartedParamsSchema>;
export type SpeechAudioParams = Static<typeof SpeechAudioParamsSchema>;
export type SpeechResult = Static<typeof SpeechResultSchema>;

export type AudioFormat = "pcm" | "wav";
export interface SpeechRequest {
	readonly input: string;
	readonly voice?: string;
	readonly format?: AudioFormat;
}
