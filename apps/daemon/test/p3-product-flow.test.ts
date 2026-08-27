import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { resolveVoxSpeechPaths } from "@voxspeech/config";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../cli/src/cli.js";
import {
	startRangeServer,
	type RangeServer,
} from "../../../packages/model-downloader/test/servers.js";
import { startProductDaemon, type DaemonServer, type ModelCatalogEntry } from "../src/index.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-engine.mjs", import.meta.url));
const DEFAULT_MODEL_ID = "qwen3-tts-1.7b-base-q4_k_m";
const directories: string[] = [];
const daemons: DaemonServer[] = [];
const downloadServers: RangeServer[] = [];

afterEach(async () => {
	await Promise.allSettled(daemons.splice(0).map((daemon) => daemon.close()));
	await Promise.allSettled(downloadServers.splice(0).map((server) => server.close()));
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("P3 product flow", () => {
	it("runs setup, restart, Voice clone, and default-Voice synthesis through the real socket", async () => {
		const root = await temporaryDirectory();
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
		const modelData = Buffer.alloc(512 * 1024, 0x5a);
		const downloadServer = await startRangeServer(modelData);
		downloadServers.push(downloadServer);
		const catalog = createCatalog(modelData);
		const engineLog = path.join(root, "engine.jsonl");
		const productOptions = {
			engine: {
				args: [fixturePath, "happy"],
				command: process.execPath,
				env: { ...process.env, FAKE_ENGINE_LOG: engineLog },
			},
			modelCatalog: catalog,
			paths,
		};

		daemons.push(await startProductDaemon(productOptions));
		const setupOutput: unknown[] = [];
		await runCli(
			["setup", "--hub-url", downloadServer.url, "--connections", "2"],
			paths.socketFile,
			{ output: captureJson(setupOutput) },
		);
		expect(setupOutput).toContainEqual(
			expect.objectContaining({ restartRequired: true, type: "notice" }),
		);
		expect((await stat(paths.configFile)).mode & 0o777).toBe(0o600);
		expect(
			await readFile(path.join(paths.modelsDirectory, DEFAULT_MODEL_ID, "installed.json"), "utf8"),
		).toContain(DEFAULT_MODEL_ID);
		await stopCurrentDaemon();

		daemons.push(await startProductDaemon(productOptions));
		const referenceWav = path.join(root, "reference.wav");
		await writeFile(referenceWav, "fake wav input");
		await runCli(["voice", "clone", "assistant", referenceWav, "这是参考文本"], paths.socketFile, {
			output: captureJson([]),
		});
		await runCli(["voice", "use", "assistant"], paths.socketFile, {
			output: captureJson([]),
		});
		const firstPcm = path.join(root, "first.pcm");
		await runCli(["speak", "显式音色", "--voice", "assistant", "-o", firstPcm], paths.socketFile);
		expect(await readFile(firstPcm)).toEqual(Buffer.from([1, 2, 3, 4]));
		await stopCurrentDaemon();

		daemons.push(await startProductDaemon(productOptions));
		const defaultPcm = path.join(root, "default.pcm");
		await runCli(["speak", "默认音色", "-o", defaultPcm], paths.socketFile);
		expect(await readFile(defaultPcm)).toEqual(Buffer.from([1, 2, 3, 4]));
		const messages = (await readFile(engineLog, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
		const synthesis = messages.filter(({ method }) => method === "speech.synthesize").at(-1);
		expect(synthesis?.params.reference).toEqual({
			codesPath: path.join(paths.voicesDirectory, "assistant", "reference.rvq"),
			speakerPath: path.join(paths.voicesDirectory, "assistant", "speaker.spk"),
			text: "这是参考文本",
		});
	});
});

function createCatalog(data: Buffer): readonly ModelCatalogEntry[] {
	const sha256 = createHash("sha256").update(data).digest("hex");
	return [
		{
			id: DEFAULT_MODEL_ID,
			manifest: {
				files: [
					{ name: "talker.gguf", sha256, size: data.length },
					{ name: "tokenizer.gguf", sha256, size: data.length },
				],
				repository: "test/model",
				revision: "fixed",
			},
			talker: "talker.gguf",
			tokenizer: "tokenizer.gguf",
		},
	];
}

function captureJson(values: unknown[]): Writable {
	let buffer = "";
	return new Writable({
		write(chunk, _encoding, callback) {
			buffer += chunk.toString();
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				values.push(JSON.parse(buffer.slice(0, newline)));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
			callback();
		},
	});
}

async function stopCurrentDaemon(): Promise<void> {
	await daemons.pop()!.close();
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "voxspeech-product-flow-"));
	directories.push(directory);
	return directory;
}
