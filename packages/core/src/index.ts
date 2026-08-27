import type { SpeechRequest } from "@voxspeech/protocol";

export function prepareSpeechRequest(request: SpeechRequest): SpeechRequest {
	const input = request.input.trim();
	if (!input) throw new Error("Speech input must not be empty");

	return {
		...request,
		input,
	};
}
