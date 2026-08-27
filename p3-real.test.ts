import { link, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { runCli } from "./apps/cli/src/cli.js";
import { DaemonRpcClient } from "./apps/cli/src/rpc-client.js";
import { startProductDaemon } from "./apps/daemon/src/runtime.js";
import { MODEL_CATALOG } from "./apps/daemon/src/models/catalog.js";
import { resolveVoxSpeechPaths } from "./packages/config/src/index.js";
import type {
	DownloadOptions,
	DownloadResult,
	ModelManifest,
} from "./packages/model-downloader/src/index.js";
import { afterAll, describe, expect, it } from "vitest";

const engineCommand = process.env.VOXSPEECH_P3_ENGINE;
const talkerPath = process.env.VOXSPEECH_P3_TALKER;
const tokenizerPath = process.env.VOXSPEECH_P3_TOKENIZER;
const backend = process.env.VOXSPEECH_P3_BACKEND;
const modelId = process.env.VOXSPEECH_P3_MODEL_ID ?? "qwen3-tts-1.7b-base-q4_k_m";
const voiceFixtureDirectory = fileURLToPath(
	new URL("./apps/daemon/test/fixtures/voice-brief/", import.meta.url),
);
const voiceFixtureIds = ["neighbor", "default", "sweet", "energetic", "thoughtful"] as const;
const selectedVoiceId =
	process.env.VOXSPEECH_P3_VOICE_FIXTURE ??
	(modelId === "qwen3-tts-0.6b-base-q4_k_m" ? "thoughtful" : "sweet");
const maximumAcceptanceWavBytes = 30 * 24_000 * 2 + 4_096;
const enabled = Boolean(engineCommand && talkerPath && tokenizerPath && backend);
const directories: string[] = [];

afterAll(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe.skipIf(!enabled)("P3 real product acceptance", () => {
	it("persists setup and Voice state across real engine restarts", async () => {
		if (!engineCommand || !talkerPath || !tokenizerPath || !isBackend(backend))
			throw new Error("P3 real acceptance environment is incomplete");
		if (!voiceFixtureIds.includes(selectedVoiceId as (typeof voiceFixtureIds)[number]))
			throw new Error(`Unknown P3 Voice fixture: ${selectedVoiceId}`);
		const root = await mkdtemp(path.join(tmpdir(), "voxspeech-p3-real-"));
		directories.push(root);
		const paths = resolveVoxSpeechPaths(
			{
				XDG_CACHE_HOME: path.join(root, "cache"),
				XDG_CONFIG_HOME: path.join(root, "config"),
				XDG_DATA_HOME: path.join(root, "data"),
				XDG_RUNTIME_DIR: path.join(root, "runtime"),
			},
			root,
			1000,
		);
		const options = {
			download: createLocalDownload({
				[requireCatalogModel(modelId).talker]: talkerPath,
				"qwen-tokenizer-12hz-Q4_K_M.gguf": tokenizerPath,
			}),
			engine: {
				command: engineCommand,
				requestTimeoutMs: 180_000,
				shutdownTimeoutMs: 15_000,
			},
			paths,
		};

		let daemon = await startProductDaemon(options);
		const configClient = await DaemonRpcClient.connect({ socketPath: paths.socketFile });
		const config = await configClient.getConfig();
		await configClient.updateConfig({
			...config,
			engine: { ...config.engine, backend },
		});
		configClient.close();
		if (modelId === "qwen3-tts-1.7b-base-q4_k_m")
			await runCli(["setup", "--connections", "4"], paths.socketFile, { output: discard() });
		else {
			await runCli(["model", "install", modelId, "--connections", "4"], paths.socketFile, {
				output: discard(),
			});
			await runCli(["model", "use", modelId], paths.socketFile, { output: discard() });
		}
		await daemon.close();

		daemon = await startProductDaemon(options);
		for (const voiceId of voiceFixtureIds) {
			const transcript = (
				await readFile(path.join(voiceFixtureDirectory, `${voiceId}.txt`), "utf8")
			).trim();
			await runCli(
				["voice", "clone", voiceId, path.join(voiceFixtureDirectory, `${voiceId}.wav`), transcript],
				paths.socketFile,
				{ output: discard() },
			);
		}
		await runCli(["voice", "use", selectedVoiceId], paths.socketFile, { output: discard() });
		const outputPath = process.env.VOXSPEECH_P3_OUTPUT ?? path.join(root, "p3-real.wav");
		await runCli(["speak", "产品流程已经接通。", "--output", outputPath], paths.socketFile);
		assertAcceptanceWav(await readFile(outputPath));
		await expect(
			runCli(["model", "remove", modelId], paths.socketFile, {
				output: discard(),
			}),
		).rejects.toMatchObject({ code: -32007 });
		await daemon.close();

		daemon = await startProductDaemon(options);
		try {
			await runCli(["speak", "重启后默认音色仍然有效。", "--output", outputPath], paths.socketFile);
			assertAcceptanceWav(await readFile(outputPath));
		} finally {
			await daemon.close();
		}
	}, 300_000);
});

function assertAcceptanceWav(wav: Buffer): void {
	expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
	expect(wav.byteLength).toBeGreaterThan(44);
	expect(wav.byteLength).toBeLessThanOrEqual(maximumAcceptanceWavBytes);
}

function createLocalDownload(
	files: Readonly<Record<string, string>>,
): (manifest: ModelManifest, options: DownloadOptions) => Promise<DownloadResult[]> {
	return async (manifest, options) => {
		await mkdir(options.outputDir, { mode: 0o700, recursive: true });
		const results: DownloadResult[] = [];
		for (const file of manifest.files) {
			options.signal?.throwIfAborted();
			const source = files[file.name];
			if (!source) throw new Error(`Missing local P3 model fixture: ${file.name}`);
			const destination = path.join(options.outputDir, file.name);
			await rm(destination, { force: true });
			await link(source, destination);
			options.onProgress?.({
				bytes: file.size,
				bytesPerSecond: file.size,
				file: file.name,
				percentage: 100,
				size: file.size,
			});
			results.push({
				downloaded: true,
				path: destination,
				resumed: false,
				sha256: file.sha256,
				size: file.size,
				url: `file://${source}`,
				verification: "sha256",
			});
		}
		return results;
	};
}

function requireCatalogModel(id: string) {
	const model = MODEL_CATALOG.find((entry) => entry.id === id);
	if (!model) throw new Error(`Unknown P3 real model: ${id}`);
	return model;
}

function discard(): Writable {
	return new Writable({ write: (_chunk, _encoding, callback) => callback() });
}

function isBackend(value: string | undefined): value is "auto" | "cpu" | "cuda" | "vulkan" {
	return value === "auto" || value === "cpu" || value === "cuda" || value === "vulkan";
}
