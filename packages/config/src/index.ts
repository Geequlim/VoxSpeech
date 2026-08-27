import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { Value } from "@sinclair/typebox/value";
import { VoxSpeechConfigSchema, type VoxSpeechConfig } from "@voxspeech/protocol";
import { parse, stringify } from "yaml";

const IDLE_TIMEOUT_PATTERN = /^[1-9]\d*(ms|s|m|h)$/;

export interface VoxSpeechPaths {
	readonly cacheDirectory: string;
	readonly configFile: string;
	readonly dataDirectory: string;
	readonly downloadsDirectory: string;
	readonly modelsDirectory: string;
	readonly socketFile: string;
	readonly voicesDirectory: string;
}

export interface ConfigValidationResult {
	readonly errors: readonly string[];
	readonly valid: boolean;
}

export class ConfigError extends Error {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
	}
}

export class ConfigValidationError extends ConfigError {
	public constructor(public readonly errors: readonly string[]) {
		super(`Invalid VoxSpeech configuration: ${errors.join("; ")}`);
	}
}

export function resolveVoxSpeechPaths(
	environment: NodeJS.ProcessEnv,
	userHome: string,
	userId: number,
): VoxSpeechPaths {
	const configHome = environment.XDG_CONFIG_HOME || path.join(userHome, ".config");
	const dataHome = environment.XDG_DATA_HOME || path.join(userHome, ".local", "share");
	const cacheHome = environment.XDG_CACHE_HOME || path.join(userHome, ".cache");
	const runtimeDirectory = environment.XDG_RUNTIME_DIR || `/run/user/${userId}`;
	const dataDirectory = path.join(dataHome, "voxspeech");
	const cacheDirectory = path.join(cacheHome, "voxspeech");

	return {
		cacheDirectory,
		configFile: path.join(configHome, "voxspeech", "config.yaml"),
		dataDirectory,
		downloadsDirectory: path.join(cacheDirectory, "downloads"),
		modelsDirectory: path.join(dataDirectory, "models"),
		socketFile: path.join(runtimeDirectory, "voxspeech", "daemon.sock"),
		voicesDirectory: path.join(dataDirectory, "voices"),
	};
}

export function createDefaultConfig(): VoxSpeechConfig {
	return {
		api: { enabled: true, host: "127.0.0.1", port: 8080 },
		audio: { format: "wav" },
		download: { connections: null, hubUrl: null, proxy: null },
		engine: { backend: "auto", idleTimeout: "10m", maxBatch: 1 },
		model: { default: "qwen3-tts-1.7b-base-q4_k_m" },
		version: 1,
		voice: { default: null },
	};
}

export function validateConfig(value: unknown): ConfigValidationResult {
	const errors = [...Value.Errors(VoxSpeechConfigSchema, value)].map((error) =>
		formatSchemaError(error.path, error.message),
	);
	if (isRecord(value) && isRecord(value.engine) && typeof value.engine.idleTimeout === "string") {
		if (!IDLE_TIMEOUT_PATTERN.test(value.engine.idleTimeout))
			errors.push("/engine/idleTimeout must be a positive integer followed by ms, s, m, or h");
	}
	return { errors, valid: errors.length === 0 };
}

export class ConfigStore {
	readonly #configFile: string;
	#config: VoxSpeechConfig | undefined;
	#updates: Promise<void> = Promise.resolve();

	public constructor(configFile: string) {
		this.#configFile = configFile;
	}

	public get(): VoxSpeechConfig {
		if (!this.#config) throw new ConfigError("Configuration has not been loaded");
		return this.#config;
	}

	public async load(): Promise<VoxSpeechConfig> {
		let source: string;
		try {
			source = await readFile(this.#configFile, "utf8");
		} catch (error) {
			if (isNodeError(error, "ENOENT")) {
				this.#config = createDefaultConfig();
				return this.#config;
			}
			throw new ConfigError(`Unable to read configuration: ${this.#configFile}`, { cause: error });
		}

		const config = parseConfig(source, this.#configFile);
		this.#config = config;
		return config;
	}

	public update(value: unknown): Promise<VoxSpeechConfig> {
		return this.#enqueueUpdate(() => value);
	}

	public mutate(
		mutator: (config: VoxSpeechConfig) => VoxSpeechConfig | Promise<VoxSpeechConfig>,
	): Promise<VoxSpeechConfig> {
		return this.#enqueueUpdate(mutator);
	}

	#enqueueUpdate(
		createValue: (config: VoxSpeechConfig) => unknown | Promise<unknown>,
	): Promise<VoxSpeechConfig> {
		const update = this.#updates.then(async () => {
			if (!this.#config) throw new ConfigError("Configuration has not been loaded");
			const value = await createValue(this.#config);
			const validation = validateConfig(value);
			if (!validation.valid) throw new ConfigValidationError(validation.errors);
			const config = value as VoxSpeechConfig;
			try {
				await writeConfigAtomically(this.#configFile, config);
			} catch (error) {
				// A parent-directory fsync can fail after rename has committed. Re-read the
				// target so the in-memory snapshot never diverges from the visible file.
				try {
					this.#config = parseConfig(await readFile(this.#configFile, "utf8"), this.#configFile);
				} catch {
					// The target was not replaced; retain the last known-good snapshot.
				}
				throw error;
			}
			this.#config = config;
			return config;
		});
		this.#updates = update.then(
			() => undefined,
			() => undefined,
		);
		return update;
	}
}

function parseConfig(source: string, configFile: string): VoxSpeechConfig {
	let value: unknown;
	try {
		value = parse(source, { uniqueKeys: true });
	} catch (error) {
		throw new ConfigError(`Unable to parse YAML configuration: ${configFile}`, { cause: error });
	}
	const validation = validateConfig(value);
	if (!validation.valid) throw new ConfigValidationError(validation.errors);
	return value as VoxSpeechConfig;
}

async function writeConfigAtomically(configFile: string, config: VoxSpeechConfig): Promise<void> {
	const directory = path.dirname(configFile);
	await mkdir(directory, { mode: 0o700, recursive: true });
	const temporaryFile = path.join(directory, `.${path.basename(configFile)}.${randomUUID()}.tmp`);
	let renamed = false;
	try {
		const handle = await open(temporaryFile, "wx", 0o600);
		try {
			await handle.writeFile(stringify(config), "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporaryFile, configFile);
		renamed = true;
		const directoryHandle = await open(directory, "r");
		try {
			await directoryHandle.sync();
		} finally {
			await directoryHandle.close();
		}
	} finally {
		if (!renamed) await rm(temporaryFile, { force: true });
	}
}

function formatSchemaError(pathname: string, message: string): string {
	return `${pathname || "/"} ${message}`;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
