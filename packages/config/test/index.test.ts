import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	ConfigError,
	ConfigStore,
	ConfigValidationError,
	createDefaultConfig,
	resolveVoxSpeechPaths,
	validateConfig,
} from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("resolveVoxSpeechPaths", () => {
	it("uses XDG directories for every persisted product resource", () => {
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
			downloadsDirectory: "/cache/voxspeech/downloads",
			modelsDirectory: "/data/voxspeech/models",
			socketFile: "/runtime/voxspeech/daemon.sock",
			voicesDirectory: "/data/voxspeech/voices",
		});
	});
});

describe("ConfigStore", () => {
	it("uses defaults for a missing file without creating it", async () => {
		const configFile = await createConfigFilePath();
		const store = new ConfigStore(configFile);

		await expect(store.load()).resolves.toEqual(createDefaultConfig());
		await expect(stat(configFile)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects malformed YAML, unsupported versions, schema errors, and invalid durations", async () => {
		const malformedFile = await writeConfig("engine: [");
		await expect(new ConfigStore(malformedFile).load()).rejects.toBeInstanceOf(ConfigError);

		const versionFile = await writeConfig("version: 2");
		await expect(new ConfigStore(versionFile).load()).rejects.toBeInstanceOf(ConfigValidationError);

		const schemaFile = await writeConfig("version: 1\nengine: {}\n");
		await expect(new ConfigStore(schemaFile).load()).rejects.toBeInstanceOf(ConfigValidationError);

		const invalidDuration = {
			...createDefaultConfig(),
			engine: { ...createDefaultConfig().engine, idleTimeout: "0m" },
		};
		expect(validateConfig(invalidDuration)).toMatchObject({ valid: false });
	});

	it("atomically persists a private YAML document and loads it after restart", async () => {
		const configFile = await createConfigFilePath();
		const store = new ConfigStore(configFile);
		await store.load();
		const config = { ...createDefaultConfig(), voice: { default: "assistant" } };

		await expect(store.update(config)).resolves.toEqual(config);
		expect((await stat(configFile)).mode & 0o777).toBe(0o600);
		expect(await readFile(configFile, "utf8")).toContain("default: assistant");
		await expect(new ConfigStore(configFile).load()).resolves.toEqual(config);
	});

	it("serializes updates", async () => {
		const configFile = await createConfigFilePath();
		const store = new ConfigStore(configFile);
		await store.load();
		const first = { ...createDefaultConfig(), voice: { default: "first" } };
		const second = { ...createDefaultConfig(), voice: { default: "second" } };

		await Promise.all([store.update(first), store.update(second)]);
		expect(store.get()).toEqual(second);
		expect(await new ConfigStore(configFile).load()).toEqual(second);
	});

	it("merges concurrent field mutations inside the update queue", async () => {
		const configFile = await createConfigFilePath();
		const store = new ConfigStore(configFile);
		await store.load();

		await Promise.all([
			store.mutate((config) => ({ ...config, model: { default: "model-two" } })),
			store.mutate((config) => ({ ...config, voice: { default: "voice-two" } })),
		]);
		expect(store.get()).toMatchObject({
			model: { default: "model-two" },
			voice: { default: "voice-two" },
		});
	});

	it("preserves the previous file and snapshot when staging cannot be created", async () => {
		const configFile = await writeConfigFromDefault();
		const store = new ConfigStore(configFile);
		const original = await store.load();
		const directory = path.dirname(configFile);
		await chmod(directory, 0o500);
		try {
			await expect(
				store.update({ ...original, voice: { default: "new-voice" } }),
			).rejects.toBeInstanceOf(Error);
			await expect(readFile(configFile, "utf8")).resolves.toContain("default: null");
			expect(store.get()).toEqual(original);
		} finally {
			await chmod(directory, 0o700);
		}
	});
});

async function createConfigFilePath(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "voxspeech-config-test-"));
	directories.push(directory);
	return resolveVoxSpeechPaths({ XDG_CONFIG_HOME: directory }, "/unused", 1000).configFile;
}

async function writeConfig(contents: string): Promise<string> {
	const configFile = await createConfigFilePath();
	await mkdir(path.dirname(configFile), { recursive: true });
	await writeFile(configFile, contents);
	return configFile;
}

async function writeConfigFromDefault(): Promise<string> {
	const configFile = await createConfigFilePath();
	await mkdir(path.dirname(configFile), { recursive: true });
	await writeFile(
		configFile,
		"version: 1\nengine:\n  backend: auto\n  idleTimeout: 10m\n  maxBatch: 1\nmodel:\n  default: qwen3-tts-1.7b-base-q4_k_m\nvoice:\n  default: null\ndownload:\n  hubUrl: null\n  proxy: null\n  connections: null\napi:\n  enabled: true\n  host: 127.0.0.1\n  port: 8080\naudio:\n  format: wav\n",
	);
	return configFile;
}
