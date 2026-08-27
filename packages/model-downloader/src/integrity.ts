import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export interface FileIntegrity {
	readonly size: number;
	readonly sha256: string;
}

export async function inspectFile(path: string): Promise<FileIntegrity | undefined> {
	let size: number;
	try {
		size = (await stat(path)).size;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}

	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return { size, sha256: hash.digest("hex") };
}

export async function fileMatches(
	path: string,
	expectedSize: number,
	expectedSha256?: string,
): Promise<boolean> {
	const actual = await inspectFile(path);
	if (actual?.size !== expectedSize) return false;
	if (expectedSha256 === undefined) return true;
	return actual.sha256 === expectedSha256;
}
