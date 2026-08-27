import { readFile } from "node:fs/promises";

import type { ModelFile, ModelManifest } from "./types.ts";

function isModelFile(value: unknown): value is ModelFile {
	if (typeof value !== "object" || value === null) return false;
	if (!("name" in value) || typeof value.name !== "string") return false;
	if (!("size" in value) || !Number.isSafeInteger(value.size)) return false;
	if ("sha256" in value && typeof value.sha256 !== "string") return false;
	return true;
}

export function parseModelManifest(value: unknown): ModelManifest {
	if (
		typeof value !== "object" ||
		value === null ||
		!("repository" in value) ||
		typeof value.repository !== "string" ||
		!("revision" in value) ||
		typeof value.revision !== "string" ||
		!("files" in value) ||
		!Array.isArray(value.files) ||
		value.files.length === 0 ||
		!value.files.every(isModelFile)
	) {
		throw new TypeError("Invalid model download manifest");
	}

	return {
		repository: value.repository,
		revision: value.revision,
		files: value.files,
	};
}

export async function readModelManifest(path: string): Promise<ModelManifest> {
	return parseModelManifest(JSON.parse(await readFile(path, "utf8")) as unknown);
}
