import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import type { DownloadOptions, DownloadResult, ModelManifest } from "@tinyaxis/model-downloader";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelCatalogEntry } from "../../src/models/catalog.js";
import { ModelManager } from "../../src/models/manager.js";
import { ModelRepository } from "../../src/models/repository.js";

const files = [
	{ name: "talker.gguf", contents: "talker" },
	{ name: "tokenizer.gguf", contents: "tokenizer" },
] as const;
const catalog: readonly ModelCatalogEntry[] = [
	{
		id: "test-model",
		manifest: {
			repository: "test/model",
			revision: "revision",
			files: files.map(({ name, contents }) => ({
				name,
				size: Buffer.byteLength(contents),
				sha256: sha256(contents),
			})),
		},
		talker: "talker.gguf",
		tokenizer: "tokenizer.gguf",
	},
];

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("ModelRepository", () => {
	it("promotes a fully verified staging directory atomically", async () => {
		const root = await temporaryDirectory();
		const repository = createRepository(root);

		await repository.install("test-model");

		expect(await repository.verify("test-model")).toBe(true);
		expect(await repository.resolve("test-model")).toEqual({
			id: "test-model",
			talkerPath: path.join(root, "data", "models", "test-model", "talker.gguf"),
			tokenizerPath: path.join(root, "data", "models", "test-model", "tokenizer.gguf"),
		});
		expect(
			await readFile(path.join(root, "data", "models", "test-model", "installed.json"), "utf8"),
		).toContain('"id":"test-model"');
	});

	it("fails offline verification after an installed file is modified", async () => {
		const root = await temporaryDirectory();
		const repository = createRepository(root);
		await repository.install("test-model");
		await writeFile(path.join(root, "data", "models", "test-model", "talker.gguf"), "changed");

		expect(await repository.verify("test-model")).toBe(false);
		await expect(repository.resolve("test-model")).rejects.toThrow("not installed and verified");
	});

	it("replaces a corrupt final directory on reinstall", async () => {
		const root = await temporaryDirectory();
		const repository = createRepository(root);
		await repository.install("test-model");
		await writeFile(path.join(root, "data", "models", "test-model", "talker.gguf"), "changed");

		await repository.install("test-model");
		expect(await repository.verify("test-model")).toBe(true);
	});

	it("copies into a data-local staging directory before cross-device promotion", async () => {
		const root = await temporaryDirectory();
		const repository = new ModelRepository({
			cacheDirectory: path.join(root, "cache"),
			catalog,
			dataDirectory: path.join(root, "data"),
			download: defaultDownload,
			sameFileSystem: async () => false,
		});

		await repository.install("test-model");
		expect(await repository.verify("test-model")).toBe(true);
		await expect(
			readFile(path.join(root, "cache", "downloads", "test-model.staging", "talker.gguf")),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects linked model files and non-private metadata", async () => {
		const root = await temporaryDirectory();
		const repository = createRepository(root);
		await repository.install("test-model");
		const directory = path.join(root, "data", "models", "test-model");
		await chmod(path.join(directory, "installed.json"), 0o644);
		expect(await repository.verify("test-model")).toBe(false);

		await repository.install("test-model");
		const external = path.join(root, "external-talker.gguf");
		await writeFile(external, "talker");
		await rm(path.join(directory, "talker.gguf"));
		await symlink(external, path.join(directory, "talker.gguf"));
		expect(await repository.verify("test-model")).toBe(false);
	});

	it("keeps interrupted staging private and does not install a failed checksum", async () => {
		const root = await temporaryDirectory();
		let attempts = 0;
		const repository = createRepository(root, async (manifest, options) => {
			attempts += 1;
			await writeFile(path.join(options.outputDir, "talker.gguf"), "partial");
			if (attempts === 1) throw new Error("interrupted");
			await writeManifestFiles(manifest, options.outputDir);
			return resultsFor(manifest, options.outputDir);
		});

		await expect(repository.install("test-model")).rejects.toThrow("interrupted");
		expect(
			await readFile(
				path.join(root, "cache", "downloads", "test-model.staging", "talker.gguf"),
				"utf8",
			),
		).toBe("partial");
		expect(await repository.verify("test-model")).toBe(false);

		await repository.install("test-model");
		expect(attempts).toBe(2);
		expect(await repository.verify("test-model")).toBe(true);
	});

	it("passes explicit install settings ahead of YAML settings", async () => {
		const root = await temporaryDirectory();
		let received: { hubUrl?: string; proxy?: string; connections?: number } | undefined;
		const repository = createRepository(root, async (manifest, options) => {
			received = options;
			await writeManifestFiles(manifest, options.outputDir);
			return resultsFor(manifest, options.outputDir);
		});
		const manager = new ModelManager({
			repository,
			configuration: {
				getDefaultModel: async () => null,
				getDownloadSettings: async () => ({
					connections: 2,
					hubUrl: "https://yaml.example",
					proxy: "http://yaml-proxy.example",
				}),
				setDefaultModel: async () => undefined,
			},
		});

		await manager.install("test-model", {
			connections: 4,
			hubUrl: "https://mirror.example",
			proxy: "http://explicit-proxy.example",
		});
		expect(received).toMatchObject({
			connections: 4,
			hubUrl: "https://mirror.example",
			proxy: "http://explicit-proxy.example",
		});
	});

	it("refuses to remove a leased model and clears the default before removal", async () => {
		const root = await temporaryDirectory();
		const repository = createRepository(root);
		await repository.install("test-model");
		let defaultModel: string | null = "test-model";
		const manager = new ModelManager({
			repository,
			configuration: {
				getDefaultModel: async () => defaultModel,
				setDefaultModel: async (id) => {
					defaultModel = id;
				},
			},
		});
		const release = manager.lease("test-model");

		await expect(manager.remove("test-model")).rejects.toThrow("currently in use");
		release();
		await manager.remove("test-model");

		expect(defaultModel).toBeNull();
		expect(await repository.verify("test-model")).toBe(false);
	});

	it("blocks new leases during removal and restores the default if removal fails", async () => {
		const root = await temporaryDirectory();
		const repository = createRepository(root);
		await repository.install("test-model");
		let defaultModel: string | null = "test-model";
		let continueRemoval: (() => void) | undefined;
		const removalGate = new Promise<void>((resolve) => {
			continueRemoval = resolve;
		});
		const remove = vi.spyOn(repository, "remove").mockImplementation(async () => {
			await removalGate;
			throw new Error("disk failure");
		});
		const manager = new ModelManager({
			repository,
			configuration: {
				getDefaultModel: async () => defaultModel,
				setDefaultModel: async (id) => {
					defaultModel = id;
				},
			},
		});

		const removal = manager.remove("test-model");
		await waitFor(() => remove.mock.calls.length === 1);
		expect(() => manager.lease("test-model")).toThrow("being removed");
		continueRemoval?.();
		await expect(removal).rejects.toThrow("disk failure");
		expect(defaultModel).toBe("test-model");
	});

	it("serializes same-ID operations and lists the injected catalog", async () => {
		const root = await temporaryDirectory();
		let downloads = 0;
		let releaseDownload: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseDownload = resolve;
		});
		const repository = createRepository(root, async (manifest, options) => {
			downloads += 1;
			await gate;
			await writeManifestFiles(manifest, options.outputDir);
			return resultsFor(manifest, options.outputDir);
		});
		const manager = new ModelManager({
			repository,
			configuration: { getDefaultModel: async () => null, setDefaultModel: async () => undefined },
		});

		const first = manager.install("test-model");
		const second = manager.install("test-model");
		await waitFor(() => downloads === 1);
		expect(downloads).toBe(1);
		releaseDownload?.();
		await Promise.all([first, second]);
		expect(downloads).toBe(1);
		expect(await manager.list()).toEqual([
			{ active: false, id: "test-model", installed: true, verified: true },
		]);
	});
});

function createRepository(
	root: string,
	download: (
		manifest: ModelManifest,
		options: DownloadOptions,
	) => Promise<DownloadResult[]> = defaultDownload,
): ModelRepository {
	return new ModelRepository({
		cacheDirectory: path.join(root, "cache"),
		dataDirectory: path.join(root, "data"),
		catalog,
		download,
	});
}

async function defaultDownload(
	manifest: ModelManifest,
	options: DownloadOptions,
): Promise<DownloadResult[]> {
	await writeManifestFiles(manifest, options.outputDir);
	return resultsFor(manifest, options.outputDir);
}

async function writeManifestFiles(manifest: ModelManifest, outputDirectory: string): Promise<void> {
	await Promise.all(
		files.map(({ name, contents }) => writeFile(path.join(outputDirectory, name), contents)),
	);
}

function resultsFor(manifest: ModelManifest, outputDirectory: string) {
	return manifest.files.map((file) => ({
		path: path.join(outputDirectory, file.name),
		url: "https://example.invalid",
		size: file.size,
		sha256: file.sha256,
		verification: "sha256" as const,
		downloaded: true,
		resumed: false,
	}));
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "voxspeech-models-"));
	directories.push(directory);
	return directory;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function waitFor(predicate: () => boolean): Promise<void> {
	while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 1));
}
