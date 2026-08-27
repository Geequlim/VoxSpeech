import type { ModelManifest } from "@tinyaxis/model-downloader";

export interface ModelCatalogEntry {
	readonly id: string;
	readonly manifest: ModelManifest;
	readonly talker: string;
	readonly tokenizer: string;
}

const QWEN3_TTS_17B_BASE_Q4_K_M: ModelCatalogEntry = {
	id: "qwen3-tts-1.7b-base-q4_k_m",
	manifest: {
		repository: "Serveurperso/Qwen3-TTS-GGUF",
		revision: "e0f336a048a3de02b29b8ad92969217d9ecffe3e",
		files: [
			{
				name: "qwen-talker-1.7b-base-Q4_K_M.gguf",
				size: 1_219_245_248,
				sha256: "ea393ebaf2167ea23ce9fc18b093822851358a950d7075cd47ab4f6ce23e887d",
			},
			{
				name: "qwen-tokenizer-12hz-Q4_K_M.gguf",
				size: 254_974_752,
				sha256: "cf3788b4d50aaa665fb6e57c170396aae03a3555fea52d2b5d0cda902d658039",
			},
		],
	},
	talker: "qwen-talker-1.7b-base-Q4_K_M.gguf",
	tokenizer: "qwen-tokenizer-12hz-Q4_K_M.gguf",
};

const QWEN3_TTS_06B_BASE_Q8_0: ModelCatalogEntry = {
	id: "qwen3-tts-0.6b-base-q8_0",
	manifest: {
		repository: "Serveurperso/Qwen3-TTS-GGUF",
		revision: "e0f336a048a3de02b29b8ad92969217d9ecffe3e",
		files: [
			{
				name: "qwen-talker-0.6b-base-Q8_0.gguf",
				size: 992_615_488,
				sha256: "d54dbaf10591421fa764ed630d764efa717ae40cd959bd48c66d4eb1af226426",
			},
			{
				name: "qwen-tokenizer-12hz-Q4_K_M.gguf",
				size: 254_974_752,
				sha256: "cf3788b4d50aaa665fb6e57c170396aae03a3555fea52d2b5d0cda902d658039",
			},
		],
	},
	talker: "qwen-talker-0.6b-base-Q8_0.gguf",
	tokenizer: "qwen-tokenizer-12hz-Q4_K_M.gguf",
};

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
	QWEN3_TTS_17B_BASE_Q4_K_M,
	QWEN3_TTS_06B_BASE_Q8_0,
];

export function findCatalogModel(id: string): ModelCatalogEntry | undefined {
	return MODEL_CATALOG.find((entry) => entry.id === id);
}
