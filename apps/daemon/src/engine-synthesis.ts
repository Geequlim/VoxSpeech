import {
	PCM_CHANNELS,
	PCM_ENCODING,
	PCM_SAMPLE_RATE,
	type DaemonSpeechSynthesizeParams,
	type SpeechResult,
	type EngineLoadParams,
	type VoiceExtractParams,
	type VoiceExtractResult,
	type VoiceReference,
} from "@voxspeech/protocol";
import { EngineClient, EngineRpcError, type EngineClientOptions } from "@voxspeech/engine-client";

import {
	SynthesisServiceError,
	type SynthesisAudioChunk,
	type SynthesisService,
	type SynthesisServiceStatus,
} from "./synthesis-service.js";

export class EngineSynthesisService implements SynthesisService {
	public readonly audio = {
		channels: PCM_CHANNELS,
		encoding: PCM_ENCODING,
		sampleRate: PCM_SAMPLE_RATE,
	} as const;

	public constructor(
		private readonly client: EngineClient,
		private readonly options: EngineSynthesisServiceOptions = {},
	) {}

	public async run(
		params: DaemonSpeechSynthesizeParams,
		signal: AbortSignal,
		onChunk: (chunk: SynthesisAudioChunk) => void,
	): Promise<SpeechResult> {
		const modelRelease = this.options.acquireModel?.();
		let voice: ResolvedVoiceLease | undefined;
		let onAbort: (() => void) | undefined;
		try {
			voice = await this.options.resolveVoice?.(params.voice ?? null);
			const handle = this.client.startSynthesis(
				{
					...(params.instruct ? { instruct: params.instruct } : {}),
					language: params.language ?? "auto",
					reference: voice?.reference ?? null,
					sampling: { maxNewTokens: 2048, seed: -1 },
					speaker: null,
					text: params.input,
				},
				{
					onAudio: (data, audio) => onChunk({ data, sequence: audio.sequence }),
				},
			);
			let cancelPromise: Promise<void> | undefined;
			onAbort = () => {
				cancelPromise ??= handle.cancel().then(
					() => undefined,
					() => undefined,
				);
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
			return await handle.result;
		} catch (error) {
			throw toSynthesisServiceError(error);
		} finally {
			if (onAbort) signal.removeEventListener("abort", onAbort);
			voice?.release();
			modelRelease?.();
		}
	}

	public extractVoice(params: VoiceExtractParams): Promise<VoiceExtractResult> {
		return this.client.extractVoice(params);
	}

	public async status(): Promise<SynthesisServiceStatus> {
		return this.client.status();
	}

	public close(): Promise<void> {
		return this.client.shutdown();
	}
}

export interface ResolvedVoiceLease {
	readonly reference: VoiceReference;
	release(): void;
}

export interface EngineSynthesisServiceOptions {
	readonly acquireModel?: () => (() => void) | undefined;
	readonly resolveVoice?: (id: string | null) => Promise<ResolvedVoiceLease | undefined>;
}

export interface StartEngineSynthesisOptions {
	readonly engine: EngineClientOptions;
	readonly load: EngineLoadParams;
	readonly service?: EngineSynthesisServiceOptions;
}

export async function startEngineSynthesisService(
	options: StartEngineSynthesisOptions,
): Promise<EngineSynthesisService> {
	const client = await EngineClient.spawn(options.engine);
	try {
		await client.load(options.load);
		return new EngineSynthesisService(client, options.service);
	} catch (error) {
		await client.shutdown().catch(() => undefined);
		throw error;
	}
}

function toSynthesisServiceError(error: unknown): SynthesisServiceError {
	if (error instanceof SynthesisServiceError) return error;
	if (error instanceof EngineRpcError && error.data) {
		return new SynthesisServiceError(error.data.code, error.message, error.data.retryable, {
			cause: error,
		});
	}
	if (
		error instanceof Error &&
		(error.message.startsWith("Voice profile") || error.message.includes("was created for"))
	)
		return new SynthesisServiceError("invalid_state", error.message, false, { cause: error });
	if (error instanceof Error && error.message.includes("being removed"))
		return new SynthesisServiceError("resource_busy", error.message, true, { cause: error });
	return new SynthesisServiceError(
		"synthesis_failed",
		error instanceof Error ? error.message : "Engine synthesis failed",
		true,
		error instanceof Error ? { cause: error } : undefined,
	);
}
