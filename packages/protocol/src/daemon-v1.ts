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
import { EngineBackendSchema, EngineStateSchema } from "./engine-v1.js";

const strictObject = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const nullableString = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);
const noParamsRequestSchema = <TMethod extends string>(method: TMethod) =>
	strictObject({
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RequestIdSchema,
		method: Type.Literal(method),
		params: Type.Optional(EmptyParamsSchema),
	});

export const DAEMON_METHODS = [
	"initialize",
	"daemon.status",
	"diagnostics.get",
	"speech.synthesize",
	"speech.cancel",
	"model.list",
	"model.install",
	"model.verify",
	"model.use",
	"model.remove",
	"voice.list",
	"voice.clone",
	"voice.show",
	"voice.use",
	"voice.remove",
	"config.get",
	"config.validate",
	"config.update",
] as const;
export const DAEMON_NOTIFICATIONS = [
	"speech.started",
	"speech.audio",
	"operation.progress",
] as const;

export const DaemonInitializeResultSchema = strictObject({
	protocolVersion: Type.Literal(PROTOCOL_VERSION),
	serverInfo: PeerInfoSchema,
	capabilities: strictObject({
		streamingAudio: Type.Literal(true),
		operationProgress: Type.Literal(true),
	}),
});
export const DaemonSpeechSynthesizeParamsSchema = strictObject({
	input: Type.String({ minLength: 1 }),
	voice: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
	language: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
	instruct: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export const DaemonStatusResultSchema = strictObject({
	daemon: strictObject({
		state: Type.Union([Type.Literal("starting"), Type.Literal("ready"), Type.Literal("stopping")]),
		version: Type.String({ minLength: 1 }),
	}),
	engine: strictObject({
		state: Type.Union([EngineStateSchema, Type.Literal("stopped")]),
		backend: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
		modelId: nullableString,
	}),
	model: strictObject({ defaultId: nullableString }),
	voice: strictObject({ defaultId: nullableString }),
	api: strictObject({
		enabled: Type.Boolean(),
		host: Type.String({ minLength: 1 }),
		port: Type.Integer({ minimum: 1, maximum: 65_535 }),
	}),
});
export const DiagnosticsResultSchema = strictObject({
	configPath: Type.String({ minLength: 1 }),
	configValid: Type.Boolean(),
	modelsDirectory: Type.String({ minLength: 1 }),
	engineExecutable: Type.String({ minLength: 1 }),
	recentErrors: Type.Array(
		strictObject({ stage: Type.String({ minLength: 1 }), message: Type.String() }),
	),
});

export const ModelIdParamsSchema = strictObject({ id: Type.String({ minLength: 1 }) });
export const ModelInstallParamsSchema = strictObject({
	id: Type.String({ minLength: 1 }),
	hubUrl: Type.Optional(Type.String({ minLength: 1 })),
	proxy: Type.Optional(Type.String({ minLength: 1 })),
	connections: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
});
export const ModelEntrySchema = strictObject({
	id: Type.String({ minLength: 1 }),
	installed: Type.Boolean(),
	verified: Type.Boolean(),
	active: Type.Boolean(),
});
export const ModelListResultSchema = strictObject({ models: Type.Array(ModelEntrySchema) });
export const ModelOperationResultSchema = strictObject({
	id: Type.String({ minLength: 1 }),
	success: Type.Boolean(),
});

export const VoiceIdParamsSchema = strictObject({ id: Type.String({ minLength: 1 }) });
export const VoiceCloneParamsSchema = strictObject({
	id: Type.String({ minLength: 1 }),
	audioPath: Type.String({ minLength: 1 }),
	transcript: Type.String({ minLength: 1 }),
});
export const VoiceProfileSchema = strictObject({
	id: Type.String({ minLength: 1 }),
	transcript: Type.String({ minLength: 1 }),
	active: Type.Boolean(),
});
export const VoiceListResultSchema = strictObject({ voices: Type.Array(VoiceProfileSchema) });
export const VoiceOperationResultSchema = strictObject({
	id: Type.String({ minLength: 1 }),
	success: Type.Boolean(),
});

export const VoxSpeechConfigSchema = strictObject({
	version: Type.Literal(1),
	engine: strictObject({
		backend: EngineBackendSchema,
		idleTimeout: Type.String({ minLength: 1 }),
		maxBatch: Type.Integer({ minimum: 1 }),
	}),
	model: strictObject({ default: nullableString }),
	voice: strictObject({ default: nullableString }),
	download: strictObject({
		hubUrl: nullableString,
		proxy: nullableString,
		connections: Type.Union([Type.Integer({ minimum: 1, maximum: 32 }), Type.Null()]),
	}),
	api: strictObject({
		enabled: Type.Boolean(),
		host: Type.String({ minLength: 1 }),
		port: Type.Integer({ minimum: 1, maximum: 65_535 }),
	}),
	audio: strictObject({ format: Type.Union([Type.Literal("pcm"), Type.Literal("wav")]) }),
});
export const ConfigParamsSchema = strictObject({ config: VoxSpeechConfigSchema });
export const ConfigValidationResultSchema = strictObject({
	valid: Type.Boolean(),
	errors: Type.Array(Type.String()),
});
export const ConfigUpdateResultSchema = strictObject({ applied: Type.Boolean() });

export const OperationProgressParamsSchema = strictObject({
	requestId: RequestIdSchema,
	phase: Type.String({ minLength: 1 }),
	completed: Type.Optional(Type.Integer({ minimum: 0 })),
	total: Type.Optional(Type.Integer({ minimum: 0 })),
});

export const DaemonRequestSchema = Type.Union([
	requestSchema("initialize", InitializeParamsSchema),
	noParamsRequestSchema("daemon.status"),
	noParamsRequestSchema("diagnostics.get"),
	requestSchema("speech.synthesize", DaemonSpeechSynthesizeParamsSchema),
	requestSchema("speech.cancel", SpeechCancelParamsSchema),
	noParamsRequestSchema("model.list"),
	requestSchema("model.install", ModelInstallParamsSchema),
	requestSchema("model.verify", ModelIdParamsSchema),
	requestSchema("model.use", ModelIdParamsSchema),
	requestSchema("model.remove", ModelIdParamsSchema),
	noParamsRequestSchema("voice.list"),
	requestSchema("voice.clone", VoiceCloneParamsSchema),
	requestSchema("voice.show", VoiceIdParamsSchema),
	requestSchema("voice.use", VoiceIdParamsSchema),
	requestSchema("voice.remove", VoiceIdParamsSchema),
	noParamsRequestSchema("config.get"),
	requestSchema("config.validate", ConfigParamsSchema),
	requestSchema("config.update", ConfigParamsSchema),
]);
export const DaemonNotificationSchema = Type.Union([
	notificationSchema("speech.started", SpeechStartedParamsSchema),
	notificationSchema("speech.audio", SpeechAudioParamsSchema),
	notificationSchema("operation.progress", OperationProgressParamsSchema),
]);
export const DaemonSuccessResponseSchema = Type.Union([
	successResponseSchema(DaemonInitializeResultSchema),
	successResponseSchema(DaemonStatusResultSchema),
	successResponseSchema(DiagnosticsResultSchema),
	successResponseSchema(SpeechResultSchema),
	successResponseSchema(SpeechCancelResultSchema),
	successResponseSchema(ModelListResultSchema),
	successResponseSchema(ModelOperationResultSchema),
	successResponseSchema(VoiceListResultSchema),
	successResponseSchema(VoiceProfileSchema),
	successResponseSchema(VoiceOperationResultSchema),
	successResponseSchema(VoxSpeechConfigSchema),
	successResponseSchema(ConfigValidationResultSchema),
	successResponseSchema(ConfigUpdateResultSchema),
]);

export type DaemonMethod = (typeof DAEMON_METHODS)[number];
export type DaemonNotification = (typeof DAEMON_NOTIFICATIONS)[number];
export type DaemonInitializeResult = Static<typeof DaemonInitializeResultSchema>;
export type DaemonSpeechSynthesizeParams = Static<typeof DaemonSpeechSynthesizeParamsSchema>;
export type DaemonStatusResult = Static<typeof DaemonStatusResultSchema>;
export type DiagnosticsResult = Static<typeof DiagnosticsResultSchema>;
export type ModelIdParams = Static<typeof ModelIdParamsSchema>;
export type ModelInstallParams = Static<typeof ModelInstallParamsSchema>;
export type ModelEntry = Static<typeof ModelEntrySchema>;
export type ModelListResult = Static<typeof ModelListResultSchema>;
export type ModelOperationResult = Static<typeof ModelOperationResultSchema>;
export type VoiceIdParams = Static<typeof VoiceIdParamsSchema>;
export type VoiceCloneParams = Static<typeof VoiceCloneParamsSchema>;
export type VoiceProfile = Static<typeof VoiceProfileSchema>;
export type VoiceListResult = Static<typeof VoiceListResultSchema>;
export type VoiceOperationResult = Static<typeof VoiceOperationResultSchema>;
export type VoxSpeechConfig = Static<typeof VoxSpeechConfigSchema>;
export type ConfigParams = Static<typeof ConfigParamsSchema>;
export type ConfigValidationResult = Static<typeof ConfigValidationResultSchema>;
export type ConfigUpdateResult = Static<typeof ConfigUpdateResultSchema>;
export type OperationProgressParams = Static<typeof OperationProgressParamsSchema>;
export type DaemonRequest = Static<typeof DaemonRequestSchema>;
export type DaemonNotificationMessage = Static<typeof DaemonNotificationSchema>;
