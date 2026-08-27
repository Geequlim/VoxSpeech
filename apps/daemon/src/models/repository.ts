import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { downloadManifest, fileMatches, type DownloadOptions } from "@tinyaxis/model-downloader";

import { MODEL_CATALOG, type ModelCatalogEntry } from "./catalog.js";

const METADATA_FILE = "installed.json";

interface InstalledMetadata {
	readonly id: string;
	readonly repository: string;
	readonly revision: string;
	readonly files: readonly {
		readonly name: string;
		readonly size: number;
		readonly sha256: string;
	}[];
}

export interface ModelDownloadSettings {
	readonly hubUrl?: string | null;
	readonly proxy?: string | null;
	readonly connections?: number | null;
}

export interface ModelInstallOptions extends ModelDownloadSettings {
	readonly signal?: AbortSignal;
	readonly onProgress?: DownloadOptions["onProgress"];
}

export interface ResolvedModel {
	readonly id: string;
	readonly talkerPath: string;
	readonly tokenizerPath: string;
}

export interface ModelRepositoryOptions {
	readonly cacheDirectory: string;
	readonly dataDirectory: string;
	readonly catalog?: readonly ModelCatalogEntry[];
	readonly download?: typeof downloadManifest;
	readonly sameFileSystem?: (source: string, destination: string) => Promise<boolean>;
}

export class ModelRepository {
	readonly #cacheDirectory: string;
	readonly #modelsDirectory: string;
	readonly catalog: readonly ModelCatalogEntry[];
	readonly #download: typeof downloadManifest;
	readonly #sameFileSystem: (source: string, destination: string) => Promise<boolean>;

	constructor(options: ModelRepositoryOptions) {
		this.#cacheDirectory = options.cacheDirectory;
		this.#modelsDirectory = path.join(options.dataDirectory, "models");
		this.catalog = options.catalog ?? MODEL_CATALOG;
		this.#download = options.download ?? downloadManifest;
		this.#sameFileSystem = options.sameFileSystem ?? sameFileSystem;
	}

	async install(id: string, options: ModelInstallOptions = {}): Promise<void> {
		const entry = this.requireEntry(id);
		if (await this.verify(id)) return;
		const staging = path.join(this.#cacheDirectory, "downloads", `${id}.staging`);
		await mkdir(staging, { recursive: true, mode: 0o700 });
		await this.#download(entry.manifest, {
			outputDir: staging,
			signal: options.signal,
			onProgress: options.onProgress,
			...optionalDownloadSettings(options),
		});
		options.signal?.throwIfAborted();
		if (!(await verifyFiles(staging, entry))) {
			throw new Error(`Downloaded model failed offline verification: ${id}`);
		}
		options.signal?.throwIfAborted();
		await writeMetadata(path.join(staging, METADATA_FILE), metadataFor(entry));
		await syncDirectory(staging);
		await mkdir(this.#modelsDirectory, { recursive: true, mode: 0o700 });
		options.signal?.throwIfAborted();
		const destination = this.directory(id);
		const promotion = await preparePromotion(
			staging,
			this.#modelsDirectory,
			entry,
			options.signal,
			this.#sameFileSystem,
		);
		const displaced = path.join(this.#modelsDirectory, `.${id}.${randomUUID()}.replaced`);
		let displacedExisting = false;
		try {
			if (await pathExists(destination)) {
				await rename(destination, displaced);
				displacedExisting = true;
			}
			await rename(promotion, destination);
		} catch (error) {
			if (displacedExisting && !(await pathExists(destination)))
				await rename(displaced, destination).catch(() => undefined);
			if (await this.verify(id)) return;
			throw error;
		}
		await syncDirectory(this.#modelsDirectory);
		if (displacedExisting) await rm(displaced, { force: true, recursive: true });
		if (promotion !== staging) await rm(staging, { force: true, recursive: true });
	}

	async verify(id: string): Promise<boolean> {
		const entry = this.findEntry(id);
		return entry !== undefined && verifyDirectory(this.directory(id), entry);
	}

	async resolve(id: string): Promise<ResolvedModel> {
		const entry = this.requireEntry(id);
		if (!(await this.verify(id))) throw new Error(`Model is not installed and verified: ${id}`);
		const directory = this.directory(id);
		return {
			id,
			talkerPath: path.join(directory, entry.talker),
			tokenizerPath: path.join(directory, entry.tokenizer),
		};
	}

	async remove(id: string): Promise<void> {
		const directory = this.directory(this.requireEntry(id).id);
		await rm(directory, { force: true, recursive: true });
		await syncDirectory(this.#modelsDirectory).catch((error: unknown) => {
			if (!isNodeError(error, "ENOENT")) throw error;
		});
	}

	private directory(id: string): string {
		return path.join(this.#modelsDirectory, id);
	}

	private requireEntry(id: string): ModelCatalogEntry {
		const entry = this.findEntry(id);
		if (!entry) throw new Error(`Unknown model: ${id}`);
		return entry;
	}

	private findEntry(id: string): ModelCatalogEntry | undefined {
		return this.catalog.find((entry) => entry.id === id);
	}
}

function optionalDownloadSettings(
	options: ModelDownloadSettings,
): Pick<DownloadOptions, "hubUrl" | "proxy" | "connections"> {
	return {
		...(options.hubUrl ? { hubUrl: options.hubUrl } : {}),
		...(options.proxy ? { proxy: options.proxy } : {}),
		...(options.connections ? { connections: options.connections } : {}),
	};
}

async function verifyDirectory(directory: string, entry: ModelCatalogEntry): Promise<boolean> {
	const directoryStat = await lstat(directory).catch(() => undefined);
	if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) return false;
	const metadataStat = await lstat(path.join(directory, METADATA_FILE)).catch(() => undefined);
	if (
		!metadataStat?.isFile() ||
		metadataStat.isSymbolicLink() ||
		(metadataStat.mode & 0o777) !== 0o600
	)
		return false;
	const metadata = await readMetadata(path.join(directory, METADATA_FILE));
	if (!metadataMatches(metadata, entry)) return false;
	return verifyFiles(directory, entry);
}

async function verifyFiles(directory: string, entry: ModelCatalogEntry): Promise<boolean> {
	return Promise.all(
		entry.manifest.files.map(async (file) => {
			const filePath = path.join(directory, file.name);
			const stat = await lstat(filePath).catch(() => undefined);
			return Boolean(
				stat?.isFile() &&
				!stat.isSymbolicLink() &&
				(await fileMatches(filePath, file.size, file.sha256)),
			);
		}),
	)
		.then((results) => results.every(Boolean))
		.catch(() => false);
}

function metadataFor(entry: ModelCatalogEntry): InstalledMetadata {
	return {
		id: entry.id,
		repository: entry.manifest.repository,
		revision: entry.manifest.revision,
		files: entry.manifest.files.map((file) => ({
			name: file.name,
			size: file.size,
			sha256: file.sha256!,
		})),
	};
}

function metadataMatches(
	metadata: InstalledMetadata | undefined,
	entry: ModelCatalogEntry,
): boolean {
	return JSON.stringify(metadata) === JSON.stringify(metadataFor(entry));
}

async function readMetadata(file: string): Promise<InstalledMetadata | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(file, "utf8"));
		return isMetadata(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function isMetadata(value: unknown): value is InstalledMetadata {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"repository" in value &&
		typeof value.repository === "string" &&
		"revision" in value &&
		typeof value.revision === "string" &&
		"files" in value &&
		Array.isArray(value.files) &&
		value.files.every(
			(file) =>
				typeof file === "object" &&
				file !== null &&
				"name" in file &&
				typeof file.name === "string" &&
				"size" in file &&
				typeof file.size === "number" &&
				"sha256" in file &&
				typeof file.sha256 === "string",
		)
	);
}

async function writeMetadata(file: string, metadata: InstalledMetadata): Promise<void> {
	await rm(file, { force: true });
	const handle = await open(file, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(metadata)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function preparePromotion(
	staging: string,
	modelsDirectory: string,
	entry: ModelCatalogEntry,
	signal?: AbortSignal,
	isSameFileSystem: (source: string, destination: string) => Promise<boolean> = sameFileSystem,
): Promise<string> {
	if (await isSameFileSystem(staging, modelsDirectory)) return staging;
	const promotion = path.join(modelsDirectory, `.${entry.id}.${randomUUID()}.staging`);
	try {
		await mkdir(promotion, { mode: 0o700 });
		for (const file of entry.manifest.files) {
			signal?.throwIfAborted();
			const destination = path.join(promotion, file.name);
			await copyFile(path.join(staging, file.name), destination);
			await chmod(destination, 0o600);
			await syncFile(destination);
		}
		if (!(await verifyFiles(promotion, entry)))
			throw new Error(`Promoted model failed offline verification: ${entry.id}`);
		await writeMetadata(path.join(promotion, METADATA_FILE), metadataFor(entry));
		signal?.throwIfAborted();
		await syncDirectory(promotion);
		return promotion;
	} catch (error) {
		await rm(promotion, { force: true, recursive: true });
		throw error;
	}
}

async function sameFileSystem(source: string, destination: string): Promise<boolean> {
	const [sourceStat, destinationStat] = await Promise.all([lstat(source), lstat(destination)]);
	return sourceStat.dev === destinationStat.dev;
}

async function syncFile(file: string): Promise<void> {
	const handle = await open(file, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function pathExists(file: string): Promise<boolean> {
	return lstat(file).then(
		() => true,
		(error: unknown) => {
			if (isNodeError(error, "ENOENT")) return false;
			throw error;
		},
	);
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === code;
}
