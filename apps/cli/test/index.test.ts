import { describe, expect, it } from "vitest";

import { createCliPreview } from "../src/index.js";

describe("createCliPreview", () => {
	it("prepares text through the shared core", () => {
		expect(createCliPreview("  任务完成  ")).toBe("任务完成");
	});
});
