import { Type, type Static, type TSchema } from "@sinclair/typebox";

import {
	EmptyParamsSchema,
	InitializeParamsSchema,
	JSON_RPC_VERSION,
	PeerInfoSchema,
	PROTOCOL_VERSION,
	RequestIdSchema,
	SpeechAudioParamsSchema,
	SpeechCancelParamsSchema,
	SpeechCancelResultSchema,
	SpeechResultSchema,
	SpeechStartedParamsSchema,
	notificationSchema,
	requestSchema,
	successResponseSchema,
} from "./common.js";

const strictObject = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

const noParamsRequestSchema = <TMethod extends string>(method: TMethod) =>
	strictObject({
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RequestIdSchema,
		method: Type.Literal(method),
		params: Type.Optional(EmptyParamsSchema),
	});

export const ENGINE_METHODS = [
	"initialize",
	"engine.load",
	"engine.status",
	"speech.synthesize",
	"speech.cancel",
	"voice.extract",
	"engine.shutdown",
] as const;
export const ENGINE_NOTIFICATIONS = ["speech.started", "speech.audio"] as const;

export const EngineBackendSchema = Type.Union([
	Type.Literal("auto"),
	Type.Literal("cuda"),
	Type.Literal("vulkan"),
	Type.Literal("cpu"),
]);
export const EngineModelTypeSchema = Type.Union([
	Type.Literal("base"),
	Type.Literal("custom_voice"),
	Type.Literal("voice_design"),
]);
export const EngineStateSchema = Type.Union([
	Type.Literal("starting"),
	Type.Literal("idle"),
	Type.Literal("loading"),
	Type.Literal("ready"),
	Type.Literal("busy"),
	Type.Literal("stopping"),
]);
export const EngineInitializeResultSchema = strictObject({
	protocolVersion: Type.Literal(PROTOCOL_VERSION),
	serverInfo: PeerInfoSchema,
	capabilities: strictObject({
		streamingAudio: Type.Literal(true),
		voiceExtraction: Type.Literal(true),
	}),
});

export const EngineLoadParamsSchema = strictObject({
	talkerPath: Type.String({ minLength: 1 }),
	codecPath: Type.String({ minLength: 1 }),
	backend: EngineBackendSchema,
	maxBatch: Type.Integer({ minimum: 1 }),
});
export const EngineLoadResultSchema = strictObject({
	backend: EngineBackendSchema,
	modelType: EngineModelTypeSchema,
	runtimeVersion: Type.String({ minLength: 1 }),
});
export const EngineStatusResultSchema = strictObject({
	state: EngineStateSchema,
	backend: Type.Union([EngineBackendSchema, Type.Null()]),
	modelType: Type.Union([EngineModelTypeSchema, Type.Null()]),
	runtimeVersion: Type.String({ minLength: 1 }),
});

export const VoiceReferenceSchema = strictObject({
	speakerPath: Type.String({ minLength: 1 }),
	codesPath: Type.String({ minLength: 1 }),
	text: Type.String({ minLength: 1 }),
});
export type VoiceReference = Static<typeof VoiceReferenceSchema>;
export const SamplingSchema = strictObject({
	seed: Type.Integer(),
	maxNewTokens: Type.Integer({ minimum: 1 }),
});
const speechSynthesizeBase = {
	text: Type.String({ minLength: 1 }),
	language: Type.String({ minLength: 1 }),
	instruct: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
	sampling: SamplingSchema,
};
export const EngineSpeechSynthesizeParamsSchema = Type.Union([
	strictObject({
		...speechSynthesizeBase,
		speaker: Type.String({ minLength: 1 }),
		reference: Type.Optional(Type.Null()),
	}),
	strictObject({
		...speechSynthesizeBase,
		speaker: Type.Optional(Type.Null()),
		reference: VoiceReferenceSchema,
	}),
	strictObject({
		...speechSynthesizeBase,
		speaker: Type.Optional(Type.Null()),
		reference: Type.Optional(Type.Null()),
	}),
]);

export const VoiceExtractParamsSchema = strictObject({
	audioPath: Type.String({ minLength: 1 }),
	speakerOutputPath: Type.String({ minLength: 1 }),
	codesOutputPath: Type.String({ minLength: 1 }),
});
export const VoiceExtractResultSchema = strictObject({
	speakerDimension: Type.Integer({ minimum: 1 }),
	codebookCount: Type.Integer({ minimum: 1 }),
	frameCount: Type.Integer({ minimum: 1 }),
});
export const EngineShutdownResultSchema = strictObject({ accepted: Type.Literal(true) });

export const EngineRequestSchema = Type.Union([
	requestSchema("initialize", InitializeParamsSchema),
	requestSchema("engine.load", EngineLoadParamsSchema),
	noParamsRequestSchema("engine.status"),
	requestSchema("speech.synthesize", EngineSpeechSynthesizeParamsSchema),
	requestSchema("speech.cancel", SpeechCancelParamsSchema),
	requestSchema("voice.extract", VoiceExtractParamsSchema),
	noParamsRequestSchema("engine.shutdown"),
]);
export const EngineNotificationSchema = Type.Union([
	notificationSchema("speech.started", SpeechStartedParamsSchema),
	notificationSchema("speech.audio", SpeechAudioParamsSchema),
]);
export const EngineSuccessResponseSchema = Type.Union([
	successResponseSchema(EngineInitializeResultSchema),
	successResponseSchema(EngineLoadResultSchema),
	successResponseSchema(EngineStatusResultSchema),
	successResponseSchema(SpeechResultSchema),
	successResponseSchema(SpeechCancelResultSchema),
	successResponseSchema(VoiceExtractResultSchema),
	successResponseSchema(EngineShutdownResultSchema),
]);

export type EngineMethod = (typeof ENGINE_METHODS)[number];
export type EngineNotification = (typeof ENGINE_NOTIFICATIONS)[number];
export type EngineBackend = Static<typeof EngineBackendSchema>;
export type EngineModelType = Static<typeof EngineModelTypeSchema>;
export type EngineState = Static<typeof EngineStateSchema>;
export type EngineInitializeResult = Static<typeof EngineInitializeResultSchema>;
export type EngineLoadParams = Static<typeof EngineLoadParamsSchema>;
export type EngineLoadResult = Static<typeof EngineLoadResultSchema>;
export type EngineStatusResult = Static<typeof EngineStatusResultSchema>;
export type EngineSpeechSynthesizeParams = Static<typeof EngineSpeechSynthesizeParamsSchema>;
export type VoiceExtractParams = Static<typeof VoiceExtractParamsSchema>;
export type VoiceExtractResult = Static<typeof VoiceExtractResultSchema>;
export type EngineRequest = Static<typeof EngineRequestSchema>;
export type EngineNotificationMessage = Static<typeof EngineNotificationSchema>;
