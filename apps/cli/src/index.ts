import { prepareSpeechRequest } from "@voxspeech/core";

export function createCliPreview(text: string): string {
	return prepareSpeechRequest({ input: text }).input;
}
