import { describe, expect, it } from "vitest";

import { canAcceptSynthesis } from "../src/index.js";

describe("canAcceptSynthesis", () => {
	it("only accepts synthesis in the ready state", () => {
		expect(canAcceptSynthesis("ready")).toBe(true);
		expect(canAcceptSynthesis("busy")).toBe(false);
		expect(canAcceptSynthesis("stopped")).toBe(false);
	});
});
