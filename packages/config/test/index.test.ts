import { describe, expect, it } from "vitest";

import { resolveVoxSpeechPaths } from "../src/index.js";

describe("resolveVoxSpeechPaths", () => {
	it("uses XDG directories", () => {
		expect(
			resolveVoxSpeechPaths(
				{
					XDG_CACHE_HOME: "/cache",
					XDG_CONFIG_HOME: "/config",
					XDG_DATA_HOME: "/data",
					XDG_RUNTIME_DIR: "/runtime",
				},
				"/home/test",
				1000,
			),
		).toEqual({
			cacheDirectory: "/cache/voxspeech",
			configFile: "/config/voxspeech/config.yaml",
			dataDirectory: "/data/voxspeech",
			socketFile: "/runtime/voxspeech/daemon.sock",
		});
	});
});
