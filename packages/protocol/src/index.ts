export type AudioFormat = "pcm" | "wav";

export interface SpeechRequest {
	readonly input: string;
	readonly voice?: string;
	readonly format?: AudioFormat;
}
