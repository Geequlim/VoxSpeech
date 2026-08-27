import type { EngineLoadParams } from "@voxspeech/protocol";
import type { EngineClientOptions } from "@voxspeech/engine-client";
import { ConfigStore, validateConfig, type VoxSpeechPaths } from "@voxspeech/config";

import type { EngineSynthesisService } from "./engine-synthesis.js";
import {
	startEngineSynthesisService,
	type StartEngineSynthesisOptions,
} from "./engine-synthesis.js";
import {
	ModelManager,
	ModelRepository,
	type ModelCatalogEntry,
	type ModelRepositoryOptions,
} from "./models/index.js";
import { startDaemonServer, type DaemonServer } from "./server.js";
import {
	SynthesisServiceError,
	type SynthesisService,
	type SynthesisServiceStatus,
} from "./synthesis-service.js";
import { VoiceManager, VoiceRepository } from "./voices/index.js";

export interface StartEngineDaemonOptions {
	readonly engine: EngineClientOptions;
	readonly load: EngineLoadParams;
	readonly socketPath: string;
}

export async function startEngineDaemon(options: StartEngineDaemonOptions): Promise<DaemonServer> {
	const synthesisOptions: StartEngineSynthesisOptions = {
		engine: options.engine,
		load: options.load,
	};
	const synthesis = await startEngineSynthesisService(synthesisOptions);
	try {
		return await startDaemonServer({ socketPath: options.socketPath, synthesis });
	} catch (error) {
		await synthesis.close().catch(() => undefined);
		throw error;
	}
}

export interface StartProductDaemonOptions {
	readonly download?: ModelRepositoryOptions["download"];
	readonly engine: EngineClientOptions;
	readonly modelCatalog?: readonly ModelCatalogEntry[];
	readonly paths: VoxSpeechPaths;
}

export async function startProductDaemon(
	options: StartProductDaemonOptions,
): Promise<DaemonServer> {
	const configStore = new ConfigStore(options.paths.configFile);
	await configStore.load();
	let loadedModelId: string | null = null;
	let engineSynthesis: EngineSynthesisService | undefined;
	const recentErrors: Array<{ stage: string; message: string }> = [];

	const configuration = {
		getDefaultModel: async () => configStore.get().model.default,
		setDefaultModel: async (id: string | null) => {
			await configStore.mutate((config) => ({ ...config, model: { default: id } }));
		},
		getDownloadSettings: async () => configStore.get().download,
	};
	const models = new ModelManager({
		configuration,
		isLoaded: (id) => loadedModelId === id,
		repository: new ModelRepository({
			cacheDirectory: options.paths.cacheDirectory,
			catalog: options.modelCatalog,
			dataDirectory: options.paths.dataDirectory,
			download: options.download,
		}),
	});
	const voices = new VoiceManager({
		baseProvider: {
			acquire: async () => {
				const modelId = loadedModelId;
				const extractor = engineSynthesis;
				if (!modelId || !extractor)
					throw new Error("A verified Base model must be loaded before cloning a Voice profile");
				const release = models.lease(modelId);
				return { extractor, modelId, release };
			},
		},
		configuration: {
			getDefaultVoice: async () => configStore.get().voice.default,
			setDefaultVoice: async (id: string | null) => {
				await configStore.mutate((config) => ({ ...config, voice: { default: id } }));
			},
		},
		repository: new VoiceRepository({ dataDirectory: options.paths.dataDirectory }),
	});

	const selectedModel = configStore.get().model.default;
	let synthesis: SynthesisService = createStoppedSynthesis();
	if (selectedModel && (await models.verify(selectedModel))) {
		const resolved = await models.resolve(selectedModel);
		loadedModelId = selectedModel;
		try {
			engineSynthesis = await startEngineSynthesisService({
				engine: options.engine,
				load: {
					backend: configStore.get().engine.backend,
					codecPath: resolved.tokenizerPath,
					maxBatch: configStore.get().engine.maxBatch,
					talkerPath: resolved.talkerPath,
				},
				service: {
					acquireModel: () => models.lease(selectedModel),
					resolveVoice: async (id) => {
						const voice = await voices.acquireReference(id);
						if (!voice) return undefined;
						if (voice.modelId !== selectedModel) {
							voice.release();
							throw new Error(
								`Voice profile ${voice.id} was created for ${voice.modelId}, not ${selectedModel}`,
							);
						}
						return voice;
					},
				},
			});
			synthesis = engineSynthesis;
		} catch (error) {
			loadedModelId = null;
			recentErrors.push({
				message: error instanceof Error ? error.message : "Engine failed to start",
				stage: "engine.load",
			});
		}
	}

	try {
		return await startDaemonServer({
			diagnostics: {
				configPath: options.paths.configFile,
				engineExecutable: options.engine.command,
				modelsDirectory: options.paths.modelsDirectory,
			},
			engineModelId: () => loadedModelId,
			recentErrors: () => recentErrors,
			services: {
				config: {
					get: () => configStore.get(),
					update: async (config) => void (await configStore.update(config)),
					validate: validateConfig,
				},
				models,
				voices: {
					clone: async (params, cloneOptions) => void (await voices.clone(params, cloneOptions)),
					list: () => voices.list(),
					remove: (id) => voices.remove(id),
					show: async (id) => {
						const profile = await voices.show(id);
						if (!profile) throw new Error(`Voice profile is not installed and verified: ${id}`);
						return profile;
					},
					use: (id) => voices.use(id),
				},
			},
			socketPath: options.paths.socketFile,
			synthesis,
		});
	} catch (error) {
		await synthesis.close().catch(() => undefined);
		throw error;
	}
}

function createStoppedSynthesis(): SynthesisService {
	return {
		audio: { channels: 1, encoding: "pcm_s16le", sampleRate: 24_000 },
		close: async () => undefined,
		run: async () => {
			throw new SynthesisServiceError(
				"invalid_state",
				"No verified default model was loaded when the daemon started",
				false,
			);
		},
		status: async (): Promise<SynthesisServiceStatus> => ({ backend: null, state: "stopped" }),
	};
}
