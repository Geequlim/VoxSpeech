import { prepareSpeechRequest } from "@voxspeech/core";

export * from "./audio.js";
export * from "./cli.js";
export * from "./rpc-client.js";

export function createCliPreview(text: string): string {
	return prepareSpeechRequest({ input: text }).input;
}
