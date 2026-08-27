import type { VoiceCloneParams, VoiceProfile, VoiceReference } from "@voxspeech/protocol";

import type {
	VoiceRepository,
	VoiceCloneRequest,
	VoiceExtractor,
	VoiceProfileRecord,
} from "./repository.js";

export interface VoiceConfiguration {
	getDefaultVoice(): Promise<string | null>;
	setDefaultVoice(id: string | null): Promise<void>;
}

export interface BaseVoiceLease {
	readonly modelId: string;
	readonly extractor: VoiceExtractor;
	release(): void | Promise<void>;
}

export interface BaseVoiceProvider {
	acquire(): Promise<BaseVoiceLease>;
}

export interface VoiceManagerOptions {
	readonly repository: VoiceRepository;
	readonly configuration: VoiceConfiguration;
	readonly baseProvider: BaseVoiceProvider;
}

export interface VoiceCloneOptions {
	readonly signal?: AbortSignal;
}

export interface VoiceReferenceLease {
	readonly id: string;
	readonly modelId: string;
	readonly reference: VoiceReference;
	release(): void;
}

export class VoiceManager {
	readonly #repository: VoiceRepository;
	readonly #configuration: VoiceConfiguration;
	readonly #baseProvider: BaseVoiceProvider;
	readonly #operations = new Map<string, Promise<unknown>>();
	readonly #leases = new Map<string, number>();
	readonly #removing = new Set<string>();

	public constructor(options: VoiceManagerOptions) {
		this.#repository = options.repository;
		this.#configuration = options.configuration;
		this.#baseProvider = options.baseProvider;
	}

	public async list(): Promise<VoiceProfile[]> {
		const defaultId = await this.#configuration.getDefaultVoice();
		const profiles = await this.#repository.list();
		return profiles.map((profile) => toVoiceProfile(profile, defaultId));
	}

	public async show(id: string): Promise<VoiceProfile | undefined> {
		const [profile, defaultId] = await Promise.all([
			this.#repository.read(id),
			this.#configuration.getDefaultVoice(),
		]);
		return profile ? toVoiceProfile(profile, defaultId) : undefined;
	}

	public clone(params: VoiceCloneParams, options: VoiceCloneOptions = {}): Promise<VoiceProfile> {
		return this.#serial(params.id, async () => {
			options.signal?.throwIfAborted();
			const lease = await this.#baseProvider.acquire();
			try {
				const profile = await this.#repository.clone(
					toCloneRequest(params, lease.modelId),
					lease.extractor,
					options,
				);
				return toVoiceProfile(profile, await this.#configuration.getDefaultVoice());
			} finally {
				await lease.release();
			}
		});
	}

	public use(id: string): Promise<void> {
		return this.#serial(id, async () => {
			await this.#repository.resolve(id);
			await this.#configuration.setDefaultVoice(id);
		});
	}

	public remove(id: string): Promise<void> {
		return this.#serial(id, async () => {
			if ((await this.#configuration.getDefaultVoice()) === id || (this.#leases.get(id) ?? 0) > 0)
				throw new Error(`Voice profile is currently in use: ${id}`);
			this.#removing.add(id);
			try {
				await this.#repository.remove(id);
			} finally {
				this.#removing.delete(id);
			}
		});
	}

	public async acquireReference(id?: string | null): Promise<VoiceReferenceLease | null> {
		const resolvedId = id ?? (await this.#configuration.getDefaultVoice());
		if (resolvedId === null) return null;
		if (this.#removing.has(resolvedId))
			throw new Error(`Voice profile is currently being removed: ${resolvedId}`);
		this.#leases.set(resolvedId, (this.#leases.get(resolvedId) ?? 0) + 1);
		let profile: Awaited<ReturnType<VoiceRepository["resolve"]>>;
		try {
			profile = await this.#repository.resolve(resolvedId);
		} catch (error) {
			this.#releaseReference(resolvedId);
			throw error;
		}
		let released = false;
		return {
			id: resolvedId,
			modelId: profile.metadata.modelId,
			reference: profile.reference,
			release: () => {
				if (released) return;
				released = true;
				this.#releaseReference(resolvedId);
			},
		};
	}

	#releaseReference(id: string): void {
		const count = this.#leases.get(id) ?? 0;
		if (count <= 1) this.#leases.delete(id);
		else this.#leases.set(id, count - 1);
	}

	#serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
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

function toCloneRequest(params: VoiceCloneParams, modelId: string): VoiceCloneRequest {
	return { ...params, modelId };
}

function toVoiceProfile(profile: VoiceProfileRecord, defaultId: string | null): VoiceProfile {
	return {
		id: profile.metadata.id,
		transcript: profile.metadata.transcript,
		active: profile.metadata.id === defaultId,
	};
}
