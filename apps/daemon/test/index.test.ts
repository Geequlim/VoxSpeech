import { describe, expect, it } from "vitest";

import { createInitialDaemonStatus } from "../src/index.js";

describe("createInitialDaemonStatus", () => {
	it("does not accept synthesis before the engine is ready", () => {
		expect(createInitialDaemonStatus()).toEqual({
			acceptingRequests: false,
			state: "starting",
		});
	});
});
