import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { VoiceExtractParams, VoiceExtractResult, VoiceReference } from "@voxspeech/protocol";
import { parse, stringify } from "yaml";

const PROFILE_FILES = new Set(["voice.yaml", "speaker.spk", "reference.rvq"]);
const PRIVATE_MODE = 0o600;
const STORAGE_KEY_PREFIX = "voice-";

export interface VoiceMetadata {
	readonly version: 1;
	readonly id: string;
	readonly transcript: string;
	readonly modelId: string;
	readonly speakerDimension: number;
	readonly codebookCount: number;
	readonly frameCount: number;
}

export interface VoiceProfileRecord {
	readonly metadata: VoiceMetadata;
	readonly directory: string;
	readonly reference: VoiceReference;
}

export interface VoiceCloneRequest {
	readonly id: string;
	readonly audioPath: string;
	readonly transcript: string;
	readonly modelId: string;
}

export interface VoiceExtractor {
	extractVoice(params: VoiceExtractParams): Promise<VoiceExtractResult>;
}

export interface VoiceRepositoryOptions {
	readonly dataDirectory: string;
	readonly createId?: () => string;
}

export interface VoiceRepositoryCloneOptions {
	readonly signal?: AbortSignal;
}

export class VoiceRepository {
	readonly #voicesDirectory: string;
	readonly #createId: () => string;
	readonly #clones = new Map<string, Promise<unknown>>();

	public constructor(options: VoiceRepositoryOptions) {
		this.#voicesDirectory = path.join(options.dataDirectory, "voices");
		this.#createId = options.createId ?? randomUUID;
	}

	public clone(
		request: VoiceCloneRequest,
		extractor: VoiceExtractor,
		options: VoiceRepositoryCloneOptions = {},
	): Promise<VoiceProfileRecord> {
		assertVoiceId(request.id);
		return this.#serialClone(request.id, () => this.#clone(request, extractor, options));
	}

	public async list(): Promise<VoiceProfileRecord[]> {
		try {
			const entries = await readdir(this.#voicesDirectory, {
				encoding: "utf8",
				withFileTypes: true,
			});
			const profiles = await Promise.all(
				entries
					.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
					.map((entry) => readProfile(path.join(this.#voicesDirectory, entry.name))),
			);
			return profiles.filter((profile): profile is VoiceProfileRecord => profile !== undefined);
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return [];
			throw error;
		}
	}

	public async read(id: string): Promise<VoiceProfileRecord | undefined> {
		if (!isVoiceId(id)) return undefined;
		const profile = await readProfile(this.#directory(id), id);
		if (profile) return profile;
		const legacy = this.#legacyDirectory(id);
		return legacy ? readProfile(legacy, id) : undefined;
	}

	public async resolve(id: string): Promise<VoiceProfileRecord> {
		assertVoiceId(id);
		const profile = await this.read(id);
		if (!profile) throw new Error(`Voice profile is not installed and verified: ${id}`);
		return profile;
	}

	public async remove(id: string): Promise<void> {
		assertVoiceId(id);
		await rm(this.#directory(id), { force: true, recursive: true });
		const legacy = this.#legacyDirectory(id);
		if (legacy) await rm(legacy, { force: true, recursive: true });
		await syncDirectory(this.#voicesDirectory);
	}

	async #clone(
		request: VoiceCloneRequest,
		extractor: VoiceExtractor,
		options: VoiceRepositoryCloneOptions,
	): Promise<VoiceProfileRecord> {
		options.signal?.throwIfAborted();
		if (!isNonEmptyString(request.audioPath))
			throw new Error("Voice clone audio path must not be empty");
		if (!isNonEmptyString(request.transcript))
			throw new Error("Voice clone transcript must not be empty");
		if (!isNonEmptyString(request.modelId))
			throw new Error("Voice clone model ID must not be empty");
		await mkdir(this.#voicesDirectory, { recursive: true, mode: 0o700 });
		const staging = path.join(this.#voicesDirectory, `.${this.#createId()}.staging`);
		const destination = this.#directory(request.id);
		const displaced = path.join(this.#voicesDirectory, `.${this.#createId()}.replaced`);
		let committed = false;
		let displacedExisting = false;
		try {
			await mkdir(staging, { mode: 0o700 });
			const speakerOutputPath = path.join(staging, "speaker.spk.tmp");
			const codesOutputPath = path.join(staging, "reference.rvq.tmp");
			const extraction = await extractor.extractVoice({
				audioPath: request.audioPath,
				speakerOutputPath,
				codesOutputPath,
			});
			options.signal?.throwIfAborted();
			await makePrivateRegularFile(speakerOutputPath);
			await makePrivateRegularFile(codesOutputPath);
			await rename(speakerOutputPath, path.join(staging, "speaker.spk"));
			await rename(codesOutputPath, path.join(staging, "reference.rvq"));
			const metadata: VoiceMetadata = {
				version: 1,
				id: request.id,
				transcript: request.transcript,
				modelId: request.modelId,
				speakerDimension: extraction.speakerDimension,
				codebookCount: extraction.codebookCount,
				frameCount: extraction.frameCount,
			};
			if (!isVoiceMetadata(metadata, request.id))
				throw new Error("Voice extraction returned invalid metadata");
			await writeMetadata(path.join(staging, "voice.yaml"), metadata);
			options.signal?.throwIfAborted();
			if (!(await readProfile(staging, request.id)))
				throw new Error("Voice profile staging validation failed");
			await syncDirectory(staging);
			options.signal?.throwIfAborted();
			if (await pathExists(destination)) {
				await rename(destination, displaced);
				displacedExisting = true;
			}
			try {
				await rename(staging, destination);
			} catch (error) {
				if (displacedExisting) await rename(displaced, destination).catch(() => undefined);
				throw error;
			}
			committed = true;
			await syncDirectory(this.#voicesDirectory);
			if (displacedExisting) await rm(displaced, { force: true, recursive: true });
			const legacy = this.#legacyDirectory(request.id);
			if (legacy) await rm(legacy, { force: true, recursive: true });
			return await this.resolve(request.id);
		} finally {
			if (!committed) await rm(staging, { force: true, recursive: true });
		}
	}

	#directory(id: string): string {
		return path.join(this.#voicesDirectory, storageKey(id));
	}

	#legacyDirectory(id: string): string | undefined {
		if (
			id === "." ||
			id === ".." ||
			id.includes("/") ||
			id.includes("\0") ||
			Buffer.byteLength(id, "utf8") > 255
		)
			return undefined;
		return path.join(this.#voicesDirectory, id);
	}

	#serialClone<T>(id: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#clones.get(id) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(operation);
		this.#clones.set(id, next);
		void next
			.finally(() => {
				if (this.#clones.get(id) === next) this.#clones.delete(id);
			})
			.catch(() => undefined);
		return next;
	}
}

export function isVoiceId(value: string): boolean {
	return value.length > 0;
}

export function assertVoiceId(value: string): void {
	if (!isVoiceId(value)) throw new Error(`Invalid voice ID: ${value}`);
}

async function readProfile(
	directory: string,
	expectedId?: string,
): Promise<VoiceProfileRecord | undefined> {
	try {
		const directoryStat = await lstat(directory);
		if (!directoryStat.isDirectory()) return undefined;
		const entries = await readdir(directory);
		if (entries.length !== PROFILE_FILES.size || entries.some((entry) => !PROFILE_FILES.has(entry)))
			return undefined;
		const metadata = await readMetadata(path.join(directory, "voice.yaml"), expectedId);
		if (!metadata) return undefined;
		await Promise.all([
			validatePrivateRegularFile(path.join(directory, "speaker.spk")),
			validatePrivateRegularFile(path.join(directory, "reference.rvq")),
			validatePrivateRegularFile(path.join(directory, "voice.yaml")),
		]);
		return {
			metadata,
			directory,
			reference: {
				speakerPath: path.join(directory, "speaker.spk"),
				codesPath: path.join(directory, "reference.rvq"),
				text: metadata.transcript,
			},
		};
	} catch {
		return undefined;
	}
}

async function readMetadata(file: string, expectedId?: string): Promise<VoiceMetadata | undefined> {
	try {
		return parseVoiceMetadata(
			parse(await readFile(file, "utf8"), { uniqueKeys: true }),
			expectedId,
		);
	} catch {
		return undefined;
	}
}

function parseVoiceMetadata(value: unknown, expectedId?: string): VoiceMetadata | undefined {
	if (!isPlainObject(value) || !isVoiceMetadata(value, expectedId)) return undefined;
	return value;
}

function isVoiceMetadata(value: unknown, expectedId?: string): value is VoiceMetadata {
	if (!isPlainObject(value)) return false;
	const keys = Object.keys(value);
	if (
		keys.length !== 7 ||
		keys.some(
			(key) =>
				![
					"version",
					"id",
					"transcript",
					"modelId",
					"speakerDimension",
					"codebookCount",
					"frameCount",
				].includes(key),
		)
	)
		return false;
	return (
		value.version === 1 &&
		(expectedId === undefined || value.id === expectedId) &&
		typeof value.id === "string" &&
		isVoiceId(value.id) &&
		isNonEmptyString(value.transcript) &&
		isNonEmptyString(value.modelId) &&
		isPositiveInteger(value.speakerDimension) &&
		isPositiveInteger(value.codebookCount) &&
		isPositiveInteger(value.frameCount)
	);
}

function storageKey(id: string): string {
	return `${STORAGE_KEY_PREFIX}${createHash("sha256").update(id, "utf8").digest("hex")}`;
}

async function writeMetadata(file: string, metadata: VoiceMetadata): Promise<void> {
	const handle = await open(file, "wx", PRIVATE_MODE);
	try {
		await handle.writeFile(stringify(metadata), "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function makePrivateRegularFile(file: string): Promise<void> {
	const stat = await lstat(file);
	if (!stat.isFile() || stat.size === 0)
		throw new Error(`Voice extractor did not create a non-empty regular file: ${file}`);
	await chmod(file, PRIVATE_MODE);
	await validatePrivateRegularFile(file);
	const handle = await open(file, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function validatePrivateRegularFile(file: string): Promise<void> {
	const stat = await lstat(file);
	if (!stat.isFile() || stat.size === 0 || (stat.mode & 0o777) !== PRIVATE_MODE)
		throw new Error(`Invalid private Voice profile file: ${file}`);
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

async function pathExists(file: string): Promise<boolean> {
	return lstat(file).then(
		() => true,
		(error: unknown) => {
			if (isNodeError(error, "ENOENT")) return false;
			throw error;
		},
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}
