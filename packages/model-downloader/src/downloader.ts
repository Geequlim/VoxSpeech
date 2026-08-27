import { availableParallelism } from "node:os";
import { open, mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import EasyDl from "easydl";

import { DownloadAbortedError, DownloadIntegrityError, ModelDownloadError } from "./errors.ts";
import { fileMatches, inspectFile } from "./integrity.ts";
import { acquireDownloadLock } from "./lock.ts";
import { createProxyAgent } from "./proxy.ts";
import { followRedirects } from "./redirect.ts";
import type { DownloadOptions, DownloadResult, ModelFile, ModelManifest } from "./types.ts";
import { huggingFaceFileUrl } from "./url.ts";

interface EasyDlProgress {
	readonly total: {
		readonly bytes?: number;
		readonly percentage: number;
		readonly speed?: number;
	};
}

interface EasyDlMetadata {
	readonly isResume: boolean;
}

const CHUNK_SIZE = 16 * 1_024 * 1_024;
const MIN_BYTES_PER_CONNECTION = 256 * 1_024;
const TRANSFER_ATTEMPTS = 3;
const DOWNLOAD_SUFFIX = ".download";

export function defaultConnections(): number {
	return Math.min(16, Math.max(4, availableParallelism()));
}

function validateFile(file: ModelFile): void {
	if (!Number.isSafeInteger(file.size) || file.size <= 0) {
		throw new TypeError(`Invalid expected size for ${file.name}`);
	}
	if (file.sha256 !== undefined && !/^[a-f\d]{64}$/i.test(file.sha256)) {
		throw new TypeError(`Invalid SHA-256 for ${file.name}`);
	}
}

function destinationPath(outputDir: string, fileName: string): string {
	const root = resolve(outputDir);
	const destination = resolve(root, fileName);
	if (destination !== root && !destination.startsWith(`${root}${sep}`)) {
		throw new TypeError(`Model file escapes output directory: ${fileName}`);
	}
	return destination;
}

function validateConnections(connections: number): void {
	if (!Number.isSafeInteger(connections) || connections < 1 || connections > 32) {
		throw new TypeError("connections must be an integer between 1 and 32");
	}
}

async function syncFile(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function removeFailedStage(path: string): Promise<void> {
	await rm(path, { force: true });
}

export async function downloadHuggingFaceFile(
	manifest: Pick<ModelManifest, "repository" | "revision">,
	file: ModelFile,
	options: DownloadOptions,
): Promise<DownloadResult> {
	validateFile(file);
	const connections = options.connections ?? defaultConnections();
	validateConnections(connections);
	const url = huggingFaceFileUrl(manifest.repository, manifest.revision, file.name, options.hubUrl);
	const destination = destinationPath(options.outputDir, file.name);
	const stage = `${destination}${DOWNLOAD_SUFFIX}`;
	const expectedSha256 = file.sha256?.toLowerCase();
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	const releaseLock = await acquireDownloadLock(`${destination}.lock`);

	try {
		if (await fileMatches(destination, file.size, expectedSha256)) {
			return {
				path: destination,
				url,
				size: file.size,
				sha256: expectedSha256,
				verification: expectedSha256 ? "sha256" : "size",
				downloaded: false,
				resumed: false,
			} satisfies DownloadResult;
		}

		if (await fileMatches(stage, file.size, expectedSha256)) {
			await syncFile(stage);
			await rename(stage, destination);
			return {
				path: destination,
				url,
				size: file.size,
				sha256: expectedSha256,
				verification: expectedSha256 ? "sha256" : "size",
				downloaded: true,
				resumed: true,
			} satisfies DownloadResult;
		}
		if (options.signal?.aborted) {
			throw new DownloadAbortedError(`Download aborted: ${file.name}`);
		}

		// The pre-resolved transfer URLs are signed and can go stale mid-flight;
		// re-resolve and retry the whole transfer instead of trusting EasyDl to
		// retry the same expired URL.
		let metadata: EasyDlMetadata | undefined;
		let completed = false;
		let lastError: unknown;
		for (let attempt = 0; attempt < TRANSFER_ATTEMPTS; attempt += 1) {
			const agent = createProxyAgent(options.proxy);
			try {
				const downloadUrl = await followRedirects(url, agent, options.signal);
				const downloader = new EasyDl(downloadUrl, stage, {
					chunkSize: CHUNK_SIZE,
					connections: Math.max(
						1,
						Math.min(connections, Math.ceil(file.size / MIN_BYTES_PER_CONNECTION)),
					),
					existBehavior: "overwrite",
					followRedirect: true,
					httpOptions: { agent },
					maxRetry: 5,
					reportInterval: 250,
					retryBackoff: 1_000,
					retryDelay: 1_000,
				});
				// EasyDl may emit a second request error after wait() has already settled and
				// removed its one-shot listener. Keep one listener for the instance lifetime so
				// a late socket close cannot become an uncaught EventEmitter error.
				downloader.on("error", () => undefined);
				const abort = () => downloader.destroy();
				options.signal?.addEventListener("abort", abort, { once: true });
				downloader.on("progress", (progress: EasyDlProgress) => {
					options.onProgress?.({
						file: file.name,
						bytes: progress.total.bytes ?? 0,
						size: file.size,
						percentage: progress.total.percentage,
						bytesPerSecond: progress.total.speed ?? 0,
					});
				});

				try {
					[metadata, completed] = await Promise.all([downloader.metadata(), downloader.wait()]);
					lastError = undefined;
					break;
				} finally {
					options.signal?.removeEventListener("abort", abort);
				}
			} catch (error) {
				if (error instanceof DownloadAbortedError) throw error;
				lastError = error;
			} finally {
				await agent.destroy();
			}
		}
		if (metadata === undefined || lastError !== undefined) {
			throw new ModelDownloadError(`Failed to download ${file.name}`, { cause: lastError });
		}
		if (!completed) {
			throw new DownloadAbortedError(`Download aborted: ${file.name}`);
		}

		const integrity = await inspectFile(stage);
		if (integrity?.size !== file.size) {
			await removeFailedStage(stage);
			throw new DownloadIntegrityError(
				`Integrity check failed for ${file.name}: expected ${file.size} bytes, got ${integrity?.size ?? 0} bytes`,
			);
		}
		if (expectedSha256 !== undefined && integrity.sha256 !== expectedSha256) {
			await removeFailedStage(stage);
			throw new DownloadIntegrityError(
				`Integrity check failed for ${file.name}: expected ${expectedSha256}, got ${integrity.sha256}`,
			);
		}

		await syncFile(stage);
		await rename(stage, destination);
		return {
			path: destination,
			url,
			size: integrity.size,
			sha256: integrity.sha256,
			verification: expectedSha256 !== undefined ? "sha256" : "size",
			downloaded: true,
			resumed: metadata.isResume,
		} satisfies DownloadResult;
	} finally {
		await releaseLock();
	}
}

export async function downloadManifest(
	manifest: ModelManifest,
	options: DownloadOptions,
): Promise<DownloadResult[]> {
	const results: DownloadResult[] = [];
	for (const file of manifest.files) {
		results.push(await downloadHuggingFaceFile(manifest, file, options));
	}
	return results;
}
