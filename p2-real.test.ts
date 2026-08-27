import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCli } from "./apps/cli/src/cli.js";
import { startEngineDaemon } from "./apps/daemon/src/runtime.js";
import { EngineClient, EngineRpcError } from "./packages/engine-client/src/index.js";
import { afterAll, describe, expect, it } from "vitest";

const engineCommand = process.env.VOXSPEECH_P2_ENGINE;
const talkerPath = process.env.VOXSPEECH_P2_TALKER;
const codecPath = process.env.VOXSPEECH_P2_CODEC;
const backend = process.env.VOXSPEECH_P2_BACKEND;
const referenceWav = process.env.VOXSPEECH_P2_REFERENCE_WAV;
const enabled = Boolean(engineCommand && talkerPath && codecPath && backend);
const directories: string[] = [];

afterAll(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe.skipIf(!enabled)("P2 real engine acceptance", () => {
	it("propagates real cancellation and completes CLI to qwentts synthesis", async () => {
		if (!engineCommand || !talkerPath || !codecPath || !isBackend(backend))
			throw new Error("P2 real engine environment is incomplete");
		const load = { backend, codecPath, maxBatch: 1 as const, talkerPath };
		const directory = await mkdtemp(path.join(tmpdir(), "voxspeech-p2-real-"));
		directories.push(directory);

		const cancellationClient = await EngineClient.spawn({
			command: engineCommand,
			requestTimeoutMs: 120_000,
			shutdownTimeoutMs: 10_000,
		});
		await cancellationClient.load(load);
		if (referenceWav) {
			const speakerPath = path.join(directory, "reference.spk");
			const codesPath = path.join(directory, "reference.rvq");
			await expect(
				cancellationClient.extractVoice({
					audioPath: referenceWav,
					codesOutputPath: codesPath,
					speakerOutputPath: speakerPath,
				}),
			).resolves.toMatchObject({ codebookCount: 16 });
			expect((await readFile(speakerPath)).byteLength).toBeGreaterThan(0);
			expect((await readFile(codesPath)).byteLength).toBeGreaterThan(0);
			let referenceBytes = 0;
			const referenceSynthesis = cancellationClient.startSynthesis(
				{
					instruct: null,
					language: "Chinese",
					reference: {
						codesPath,
						speakerPath,
						text: "This is the voice of the great Freeman.",
					},
					sampling: { maxNewTokens: 8, seed: 42 },
					speaker: null,
					text: "这段语音复用了提取后的音色。",
				},
				{ onAudio: (audio) => (referenceBytes += audio.byteLength) },
			);
			await expect(referenceSynthesis.result).resolves.toMatchObject({ sampleCount: 15_360 });
			expect(referenceBytes).toBeGreaterThan(0);
		}
		let cancel: Promise<unknown> | undefined;
		const handle = cancellationClient.startSynthesis(
			{
				instruct: null,
				language: "Chinese",
				reference: null,
				sampling: { maxNewTokens: 2048, seed: 42 },
				speaker: null,
				text: "这是一段用于验证取消传播的较长语音，它不应该完整生成。",
			},
			{ onStarted: () => (cancel ??= handle.cancel()) },
		);
		await expect(handle.result).rejects.toMatchObject({
			data: {
				code: "request_cancelled",
				retryable: false,
				stage: "speech.synthesize",
			},
		} satisfies Partial<EngineRpcError>);
		await cancel;
		await cancellationClient.shutdown();

		const socketPath = path.join(directory, "daemon.sock");
		const outputPath = process.env.VOXSPEECH_P2_OUTPUT ?? path.join(directory, "speech.wav");
		const daemon = await startEngineDaemon({
			engine: {
				command: engineCommand,
				requestTimeoutMs: 120_000,
				shutdownTimeoutMs: 10_000,
			},
			load,
			socketPath,
		});
		try {
			await expect(
				runCli(["speak", "--output", outputPath, "VoxSpeech 真实链路已经接通。"], socketPath),
			).resolves.toBe(0);
			const wav = await readFile(outputPath);
			expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
			expect(wav.byteLength).toBeGreaterThan(44);
		} finally {
			await daemon.close();
		}
	}, 180_000);
});

function isBackend(value: string | undefined): value is "auto" | "cpu" | "cuda" | "vulkan" {
	return value === "auto" || value === "cpu" || value === "cuda" || value === "vulkan";
}
