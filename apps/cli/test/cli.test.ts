import { mkdtemp, readFile, rm } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";

import { startDaemonServer, type DaemonServer } from "../../daemon/src/index.js";
import type { AudioFormat } from "@voxspeech/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/index.js";

const servers: DaemonServer[] = [];
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("runCli", () => {
	it("prints daemon status as JSON", async () => {
		const { socketPath } = await createEnvironment();
		servers.push(await startDaemonServer({ socketPath }));
		let text = "";
		const output = new Writable({
			write(chunk, _encoding, callback) {
				text += chunk.toString();
				callback();
			},
		});

		expect(await runCli(["status"], socketPath, { output })).toBe(0);
		expect(JSON.parse(text)).toMatchObject({
			daemon: { state: "ready" },
			engine: { state: "stopped" },
		});
	});

	it("runs the complete text argument to WAV path", async () => {
		const { directory, socketPath } = await createEnvironment();
		servers.push(await startDaemonServer({ socketPath }));
		const outputPath = path.join(directory, "speech.wav");

		expect(await runCli(["speak", "任务", "完成", "--output", outputPath], socketPath)).toBe(0);
		const wav = await readFile(outputPath);
		expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
		expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
		expect(wav.byteLength).toBeGreaterThan(44);
	});

	it("reads stdin and writes raw PCM", async () => {
		const { directory, socketPath } = await createEnvironment();
		servers.push(await startDaemonServer({ socketPath }));
		const outputPath = path.join(directory, "speech.pcm");

		await runCli(["speak", "--format", "pcm", "--output", outputPath], socketPath, {
			input: Readable.from(["  来自标准输入  "]),
		});
		const pcm = await readFile(outputPath);
		expect(pcm.byteLength).toBe("来自标准输入".length * 480 * 2);
	});

	it("uses the injectable playback path", async () => {
		const { socketPath } = await createEnvironment();
		servers.push(await startDaemonServer({ socketPath }));
		const play = vi.fn(async (_audio: Uint8Array, _format: AudioFormat) => undefined);

		await runCli(["speak", "播放测试"], socketPath, { play });
		expect(play).toHaveBeenCalledOnce();
		expect(play.mock.calls[0]?.[1]).toBe("wav");
		const audio = play.mock.calls[0]?.[0];
		expect(
			Buffer.from(audio ?? [])
				.subarray(0, 4)
				.toString("ascii"),
		).toBe("RIFF");
	});
});

async function createEnvironment(): Promise<{ directory: string; socketPath: string }> {
	const directory = await mkdtemp(path.join(tmpdir(), "voxspeech-cli-test-"));
	directories.push(directory);
	return { directory, socketPath: path.join(directory, "daemon.sock") };
}
