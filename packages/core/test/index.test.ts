import { describe, expect, it } from "vitest";

import { prepareSpeechRequest } from "../src/index.js";

describe("prepareSpeechRequest", () => {
	it("trims the input text", () => {
		expect(prepareSpeechRequest({ input: "  hello  " })).toEqual({ input: "hello" });
	});

	it("rejects empty input", () => {
		expect(() => prepareSpeechRequest({ input: "   " })).toThrow("Speech input must not be empty");
	});
});
