import { describe, expect, it } from "vitest";

import { MODEL_CATALOG } from "../../src/models/catalog.js";

describe("model catalog", () => {
	it("uses the validated Q8_0 talker for 0.6B", () => {
		const model = MODEL_CATALOG.find(({ id }) => id === "qwen3-tts-0.6b-base-q8_0");

		expect(model).toMatchObject({
			talker: "qwen-talker-0.6b-base-Q8_0.gguf",
		});
		expect(model?.manifest.files[0]).toEqual({
			name: "qwen-talker-0.6b-base-Q8_0.gguf",
			sha256: "d54dbaf10591421fa764ed630d764efa717ae40cd959bd48c66d4eb1af226426",
			size: 992_615_488,
		});
		expect(MODEL_CATALOG.some(({ id }) => id === "qwen3-tts-0.6b-base-q4_k_m")).toBe(false);
	});
});
