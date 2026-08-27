import {
	PCM_CHANNELS,
	PCM_ENCODING,
	PCM_SAMPLE_RATE,
	type DaemonSpeechSynthesizeParams,
	type SpeechResult,
} from "@voxspeech/protocol";

export interface FakeAudioChunk {
	readonly data: Buffer;
	readonly sequence: number;
}

export interface FakeSynthesisOptions {
	readonly chunkDelayMs?: number;
	readonly samplesPerCharacter?: number;
}

export interface FakeSynthesis {
	readonly audio: {
		readonly channels: typeof PCM_CHANNELS;
		readonly encoding: typeof PCM_ENCODING;
		readonly sampleRate: typeof PCM_SAMPLE_RATE;
	};
	run(
		params: DaemonSpeechSynthesizeParams,
		signal: AbortSignal,
		onChunk: (chunk: FakeAudioChunk) => void,
	): Promise<SpeechResult>;
}

export function createFakeSynthesis(options: FakeSynthesisOptions = {}): FakeSynthesis {
	const chunkDelayMs = options.chunkDelayMs ?? 1;
	const samplesPerCharacter = options.samplesPerCharacter ?? 480;

	return {
		audio: {
			channels: PCM_CHANNELS,
			encoding: PCM_ENCODING,
			sampleRate: PCM_SAMPLE_RATE,
		},
		async run(params, signal, onChunk) {
			const startedAt = performance.now();
			const sampleCount = Math.max(480, params.input.length * samplesPerCharacter);
			const samplesPerChunk = 480;
			let firstAudioMs = 0;

			for (let offset = 0, sequence = 0; offset < sampleCount; sequence += 1) {
				await delay(chunkDelayMs, signal);
				const count = Math.min(samplesPerChunk, sampleCount - offset);
				const pcm = Buffer.allocUnsafe(count * 2);
				for (let index = 0; index < count; index += 1) {
					const sample = Math.round(
						Math.sin(((offset + index) * Math.PI * 2 * 220) / 24_000) * 2_000,
					);
					pcm.writeInt16LE(sample, index * 2);
				}
				offset += count;
				if (sequence === 0) firstAudioMs = Math.round(performance.now() - startedAt);
				onChunk({ data: pcm, sequence });
			}

			const processingMs = Math.round(performance.now() - startedAt);
			return {
				durationMs: Math.round((sampleCount / PCM_SAMPLE_RATE) * 1_000),
				firstAudioMs,
				processingMs,
				sampleCount,
			};
		},
	};
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
