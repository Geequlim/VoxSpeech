import type { DownloadProgress } from "@tinyaxis/model-downloader";
import type { ModelEntry } from "@voxspeech/protocol";

import type { ModelRepository } from "./repository.js";
import type { ModelDownloadSettings, ModelInstallOptions, ResolvedModel } from "./repository.js";

export interface ModelConfiguration {
	getDefaultModel(): Promise<string | null>;
	setDefaultModel(id: string | null): Promise<void>;
	getDownloadSettings?(): Promise<ModelDownloadSettings>;
}

export interface ModelManagerOptions {
	readonly repository: ModelRepository;
	readonly configuration: ModelConfiguration;
	readonly isLoaded?: (id: string) => boolean;
}

export class ModelManager {
	readonly #repository: ModelRepository;
	readonly #configuration: ModelConfiguration;
	readonly #isLoaded: (id: string) => boolean;
	readonly #operations = new Map<string, Promise<unknown>>();
	readonly #leases = new Map<string, number>();
	readonly #removing = new Set<string>();

	constructor(options: ModelManagerOptions) {
		this.#repository = options.repository;
		this.#configuration = options.configuration;
		this.#isLoaded = options.isLoaded ?? (() => false);
	}

	async list(): Promise<ModelEntry[]> {
		const defaultId = await this.#configuration.getDefaultModel();
		return Promise.all(
			this.#repository.catalog.map(async ({ id }) => {
				const verified = await this.#repository.verify(id);
				return { active: defaultId === id, id, installed: verified, verified };
			}),
		);
	}

	install(id: string, options: ModelInstallOptions = {}): Promise<void> {
		return this.serial(id, async () => {
			const settings = await this.#configuration.getDownloadSettings?.();
			await this.#repository.install(id, {
				...settings,
				...options,
				connections: options.connections ?? settings?.connections,
				hubUrl: options.hubUrl ?? settings?.hubUrl,
				proxy: options.proxy ?? settings?.proxy,
			});
		});
	}

	verify(id: string): Promise<boolean> {
		return this.serial(id, () => this.#repository.verify(id));
	}

	use(id: string): Promise<void> {
		return this.serial(id, async () => {
			if (!(await this.#repository.verify(id)))
				throw new Error(`Model is not installed and verified: ${id}`);
			await this.#configuration.setDefaultModel(id);
		});
	}

	remove(id: string): Promise<void> {
		return this.serial(id, async () => {
			if (this.#isLoaded(id) || (this.#leases.get(id) ?? 0) > 0)
				throw new Error(`Model is currently in use: ${id}`);
			this.#removing.add(id);
			let clearedDefault = false;
			try {
				if ((await this.#configuration.getDefaultModel()) === id) {
					await this.#configuration.setDefaultModel(null);
					clearedDefault = true;
				}
				await this.#repository.remove(id);
			} catch (error) {
				if (clearedDefault) {
					try {
						await this.#configuration.setDefaultModel(id);
					} catch (rollbackError) {
						throw new AggregateError(
							[error, rollbackError],
							`Failed to remove model ${id} and restore its default selection`,
						);
					}
				}
				throw error;
			} finally {
				this.#removing.delete(id);
			}
		});
	}

	async resolve(id: string): Promise<ResolvedModel> {
		return this.#repository.resolve(id);
	}

	lease(id: string): () => void {
		if (this.#removing.has(id)) throw new Error(`Model is currently being removed: ${id}`);
		const current = this.#leases.get(id) ?? 0;
		this.#leases.set(id, current + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const count = this.#leases.get(id) ?? 0;
			if (count <= 1) this.#leases.delete(id);
			else this.#leases.set(id, count - 1);
		};
	}

	private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#operations.get(id) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(operation);
		this.#operations.set(id, next);
		void next
			.finally(() => {
				if (this.#operations.get(id) === next) this.#operations.delete(id);
			})
			.catch(() => undefined);
		return next;
	}
}

export type { DownloadProgress };
