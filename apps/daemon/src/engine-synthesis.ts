import {
	PCM_CHANNELS,
	PCM_ENCODING,
	PCM_SAMPLE_RATE,
	type DaemonSpeechSynthesizeParams,
	type SpeechResult,
	type EngineLoadParams,
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

	public constructor(private readonly client: EngineClient) {}

	public async run(
		params: DaemonSpeechSynthesizeParams,
		signal: AbortSignal,
		onChunk: (chunk: SynthesisAudioChunk) => void,
	): Promise<SpeechResult> {
		if (params.voice) {
			throw new SynthesisServiceError(
				"invalid_state",
				"Voice profiles are not available during P2",
				false,
			);
		}

		const handle = this.client.startSynthesis(
			{
				instruct: params.instruct,
				language: params.language ?? "auto",
				reference: null,
				sampling: { maxNewTokens: 2048, seed: -1 },
				speaker: null,
				text: params.input,
			},
			{
				onAudio: (data, audio) => onChunk({ data, sequence: audio.sequence }),
			},
		);
		let cancelPromise: Promise<void> | undefined;
		const cancel = () => {
			cancelPromise ??= handle.cancel().then(
				() => undefined,
				() => undefined,
			);
			return cancelPromise;
		};
		const onAbort = () => void cancel();
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });

		try {
			return await handle.result;
		} catch (error) {
			throw toSynthesisServiceError(error);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	public async status(): Promise<SynthesisServiceStatus> {
		return this.client.status();
	}

	public close(): Promise<void> {
		return this.client.shutdown();
	}
}

export interface StartEngineSynthesisOptions {
	readonly engine: EngineClientOptions;
	readonly load: EngineLoadParams;
}

export async function startEngineSynthesisService(
	options: StartEngineSynthesisOptions,
): Promise<EngineSynthesisService> {
	const client = await EngineClient.spawn(options.engine);
	try {
		await client.load(options.load);
		return new EngineSynthesisService(client);
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
	return new SynthesisServiceError(
		"synthesis_failed",
		error instanceof Error ? error.message : "Engine synthesis failed",
		true,
		error instanceof Error ? { cause: error } : undefined,
	);
}
