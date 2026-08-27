import type {
	PCM_CHANNELS,
	PCM_ENCODING,
	PCM_SAMPLE_RATE,
	DaemonSpeechSynthesizeParams,
	EngineBackend,
	EngineState,
	SpeechResult,
	VoxSpeechErrorCode,
} from "@voxspeech/protocol";

export interface SynthesisAudioChunk {
	readonly data: Buffer;
	readonly sequence: number;
}

export interface SynthesisService {
	readonly audio: {
		readonly channels: typeof PCM_CHANNELS;
		readonly encoding: typeof PCM_ENCODING;
		readonly sampleRate: typeof PCM_SAMPLE_RATE;
	};
	run(
		params: DaemonSpeechSynthesizeParams,
		signal: AbortSignal,
		onChunk: (chunk: SynthesisAudioChunk) => void,
	): Promise<SpeechResult>;
	status(): Promise<SynthesisServiceStatus>;
	close(): Promise<void>;
}

export interface SynthesisServiceStatus {
	readonly backend: EngineBackend | null;
	readonly state: EngineState | "stopped";
}

export class SynthesisServiceError extends Error {
	public constructor(
		public readonly code: VoxSpeechErrorCode,
		message: string,
		public readonly retryable: boolean,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = new.target.name;
	}
}
