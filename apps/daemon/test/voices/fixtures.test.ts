import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const fixtureDirectory = fileURLToPath(new URL("../fixtures/voice-brief/", import.meta.url));
const fixtureIds = ["neighbor", "default", "sweet", "energetic", "thoughtful"] as const;

describe("Voice Brief clone fixtures", () => {
	it.each(fixtureIds)("keeps %s suitable for Chinese voice cloning", async (fixtureId) => {
		const [transcript, wav] = await Promise.all([
			readFile(path.join(fixtureDirectory, `${fixtureId}.txt`), "utf8"),
			readFile(path.join(fixtureDirectory, `${fixtureId}.wav`)),
		]);

		const normalizedTranscript = transcript.trim();
		expect(normalizedTranscript.length).toBeGreaterThanOrEqual(60);
		expect(normalizedTranscript).not.toMatch(/[A-Za-z]/);
		expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
		expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
		expect(wav.readUInt16LE(22)).toBe(1);
		expect(wav.readUInt32LE(24)).toBe(24_000);
		expect(wav.readUInt16LE(34)).toBe(16);
		expect(wav.byteLength).toBeGreaterThan(44);
	});
});
