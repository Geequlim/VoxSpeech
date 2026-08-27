import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	DownloadAbortedError,
	DownloadIntegrityError,
	DownloadLockedError,
	ModelDownloadError,
	defaultConnections,
	downloadHuggingFaceFile,
	huggingFaceFileUrl,
	parseModelManifest,
	resolveHubUrl,
	type ModelFile,
} from "../src/index.js";
import { acquireDownloadLock } from "../src/lock.js";
import {
	createTempDirectories,
	sha256,
	startFlakyRangeServer,
	startForwardProxy,
	startRangeServer,
	startRedirectingServer,
	startResettableRangeServer,
} from "./servers.js";

const directories = createTempDirectories();

function modelFile(name: string, data: Buffer): ModelFile {
	return { name, size: data.length, sha256: sha256(data) };
}

afterEach(async () => {
	await directories.cleanup();
});

describe.sequential("Hugging Face model downloader", () => {
	it("builds official or mirrored URLs with encoded path segments", () => {
		process.env.HF_ENDPOINT = "https://mirror.example/base/";
		try {
			expect(resolveHubUrl()).toBe("https://mirror.example/base");
			expect(huggingFaceFileUrl("org name/model+#", "refs/pr 1", "nested/中文 model.gguf")).toBe(
				"https://mirror.example/base/org%20name/model%2B%23/resolve/refs%2Fpr%201/nested/%E4%B8%AD%E6%96%87%20model.gguf",
			);
			expect(huggingFaceFileUrl("org/model", "main", "model.gguf", "https://explicit.test")).toBe(
				"https://explicit.test/org/model/resolve/main/model.gguf",
			);
		} finally {
			delete process.env.HF_ENDPOINT;
		}
	});

	it("validates the probe manifest shape", () => {
		const manifest = parseModelManifest({
			repository: "org/model",
			revision: "commit",
			files: [{ name: "model.gguf", size: 10, sha256: "a".repeat(64) }],
		});
		expect(manifest.files[0]?.name).toBe("model.gguf");
		expect(() => parseModelManifest({ repository: "org/model", files: [] })).toThrow(
			"Invalid model download manifest",
		);
	});

	it("derives a bounded default connection count", () => {
		const connections = defaultConnections();
		expect(connections).toBeGreaterThanOrEqual(4);
		expect(connections).toBeLessThanOrEqual(16);
	});

	it("downloads with parallel Range requests and atomically installs after verification", async () => {
		const data = Buffer.alloc(2 * 1_024 * 1_024, 0x5a);
		const server = await startRangeServer(data);
		const outputDir = await directories.make();
		try {
			const result = await downloadHuggingFaceFile(
				{ repository: "org/model", revision: "fixed revision" },
				modelFile("weights/model.gguf", data),
				{ outputDir, hubUrl: server.url, connections: 4 },
			);

			expect(server.paths[0]).toBe("/org/model/resolve/fixed%20revision/weights/model.gguf");
			expect(server.ranges.length).toBeGreaterThan(1);
			expect(result).toMatchObject({ downloaded: true, resumed: false, verification: "sha256" });
			expect(await readFile(result.path)).toEqual(data);
			expect(existsSync(`${result.path}.download`)).toBe(false);
			expect(existsSync(`${result.path}.lock`)).toBe(false);
		} finally {
			await server.close();
		}
	});

	it("verifies by size alone when no sha256 is pinned", async () => {
		const data = Buffer.alloc(64 * 1_024, 0x21);
		const server = await startRangeServer(data);
		const outputDir = await directories.make();
		const file: ModelFile = { name: "open.gguf", size: data.length };
		try {
			const result = await downloadHuggingFaceFile(
				{ repository: "org/model", revision: "commit" },
				file,
				{ outputDir, hubUrl: server.url, connections: 2 },
			);
			expect(result).toMatchObject({ downloaded: true, verification: "size" });
			expect(result.sha256).toBe(sha256(data));
			await expect(readFile(join(outputDir, "open.gguf"))).resolves.toEqual(data);

			const verified = await downloadHuggingFaceFile(
				{ repository: "org/model", revision: "commit" },
				file,
				{ outputDir, hubUrl: server.url, connections: 2 },
			);
			expect(verified).toMatchObject({
				downloaded: false,
				verification: "size",
				sha256: undefined,
			});
		} finally {
			await server.close();
		}
	});

	it("downloads through redirecting endpoints", async () => {
		const data = Buffer.alloc(64 * 1_024, 0x11);
		const origin = await startRangeServer(data);
		const redirect = await startRedirectingServer(origin.url);
		const outputDir = await directories.make();
		try {
			const result = await downloadHuggingFaceFile(
				{ repository: "org/model", revision: "commit" },
				modelFile("redirected.gguf", data),
				{ outputDir, hubUrl: redirect.url, connections: 2 },
			);
			expect(result).toMatchObject({ downloaded: true, verification: "sha256" });
			await expect(readFile(join(outputDir, "redirected.gguf"))).resolves.toEqual(data);
		} finally {
			await Promise.all([origin.close(), redirect.close()]);
		}
	});

	it("re-resolves and retries after a failed transfer attempt", async () => {
		const data = Buffer.alloc(64 * 1_024, 0x12);
		const server = await startFlakyRangeServer(data);
		const outputDir = await directories.make();
		try {
			const result = await downloadHuggingFaceFile(
				{ repository: "org/model", revision: "commit" },
				modelFile("flaky.gguf", data),
				{ outputDir, hubUrl: server.url, connections: 2 },
			);
			expect(result).toMatchObject({ downloaded: true });
			await expect(readFile(join(outputDir, "flaky.gguf"))).resolves.toEqual(data);
		} finally {
			await server.close();
		}
	});

	it("rejects concurrent writers for the same destination", async () => {
		const outputDir = await directories.make();
		const destination = join(outputDir, "model.gguf");
		const release = await acquireDownloadLock(`${destination}.lock`);
		try {
			await expect(acquireDownloadLock(`${destination}.lock`)).rejects.toBeInstanceOf(
				DownloadLockedError,
			);
		} finally {
			await release();
		}
	});

	it("never installs a file that fails SHA-256 verification", async () => {
		const data = Buffer.alloc(64 * 1_024, 0x6b);
		const server = await startRangeServer(data);
		const outputDir = await directories.make();
		const file = { ...modelFile("bad.gguf", data), sha256: "0".repeat(64) };
		try {
			await expect(
				downloadHuggingFaceFile({ repository: "org/model", revision: "commit" }, file, {
					outputDir,
					hubUrl: server.url,
					connections: 4,
				}),
			).rejects.toBeInstanceOf(DownloadIntegrityError);
			expect(existsSync(join(outputDir, file.name))).toBe(false);
			expect(existsSync(join(outputDir, `${file.name}.download`))).toBe(false);
		} finally {
			await server.close();
		}
	});

	it("contains late EasyDl errors after a connection reset and allows retry", async () => {
		const data = Buffer.alloc(512 * 1_024, 0x35);
		const server = await startResettableRangeServer(data);
		const outputDir = await directories.make();
		const file = modelFile("reset.gguf", data);
		const escapedErrors: unknown[] = [];
		const escapedRejections: unknown[] = [];
		const onUncaughtException = (error: unknown) => escapedErrors.push(error);
		const onUnhandledRejection = (error: unknown) => escapedRejections.push(error);
		process.on("uncaughtException", onUncaughtException);
		process.on("unhandledRejection", onUnhandledRejection);

		try {
			await expect(
				downloadHuggingFaceFile({ repository: "org/model", revision: "commit" }, file, {
					outputDir,
					hubUrl: server.url,
					connections: 4,
				}),
			).rejects.toBeInstanceOf(ModelDownloadError);
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
			expect(server.resets).toBeGreaterThan(1);
			expect(escapedErrors).toEqual([]);
			expect(escapedRejections).toEqual([]);

			server.setResetConnections(false);
			await expect(
				downloadHuggingFaceFile({ repository: "org/model", revision: "commit" }, file, {
					outputDir,
					hubUrl: server.url,
					connections: 4,
				}),
			).resolves.toMatchObject({ downloaded: true });
		} finally {
			process.removeListener("uncaughtException", onUncaughtException);
			process.removeListener("unhandledRejection", onUnhandledRejection);
			await server.close();
		}
	});

	it("reuses complete chunks after interruption", async () => {
		const data = Buffer.alloc(2 * 1_024 * 1_024, 0x7c);
		const server = await startRangeServer(data);
		const outputDir = await directories.make();
		const file = modelFile("resume.gguf", data);
		const controller = new AbortController();
		try {
			await expect(
				downloadHuggingFaceFile({ repository: "org/model", revision: "commit" }, file, {
					outputDir,
					hubUrl: server.url,
					connections: 2,
					signal: controller.signal,
					onProgress: ({ percentage }) => {
						if (percentage > 0) controller.abort();
					},
				}),
			).rejects.toBeInstanceOf(DownloadAbortedError);
			const rangesBeforeResume = server.ranges.length;

			const result = await downloadHuggingFaceFile(
				{ repository: "org/model", revision: "commit" },
				file,
				{ outputDir, hubUrl: server.url, connections: 2 },
			);
			const resumedRanges = server.ranges.length - rangesBeforeResume;
			expect(result.resumed).toBe(true);
			expect(resumedRanges).toBeLessThan(2);
			expect(await readFile(result.path)).toEqual(data);
		} finally {
			await server.close();
		}
	});

	it("uses explicit and environment proxies while honoring NO_PROXY", async () => {
		const data = Buffer.alloc(128 * 1_024, 0x4d);
		const origin = await startRangeServer(data);
		const proxy = await startForwardProxy();
		const outputDir = await directories.make();
		const environmentKeys = [
			"http_proxy",
			"HTTP_PROXY",
			"https_proxy",
			"HTTPS_PROXY",
			"all_proxy",
			"ALL_PROXY",
			"no_proxy",
			"NO_PROXY",
		] as const;
		const savedEnvironment = Object.fromEntries(
			environmentKeys.map((key) => [key, process.env[key]]),
		);

		try {
			process.env.http_proxy = "http://127.0.0.1:1";
			process.env.HTTP_PROXY = "http://127.0.0.1:2";
			process.env.no_proxy = "*";
			delete process.env.ALL_PROXY;
			delete process.env.all_proxy;
			await downloadHuggingFaceFile(
				{ repository: "org/model", revision: "commit" },
				modelFile("explicit.gguf", data),
				{ outputDir, hubUrl: origin.url, proxy: proxy.url, connections: 2 },
			);
			const afterExplicit = proxy.targets.length;
			expect(afterExplicit).toBeGreaterThan(1);

			process.env.http_proxy = proxy.url;
			process.env.HTTP_PROXY = "http://127.0.0.1:1";
			process.env.no_proxy = "";
			process.env.NO_PROXY = "";
			await downloadHuggingFaceFile(
				{ repository: "org/model", revision: "commit" },
				modelFile("environment.gguf", data),
				{ outputDir, hubUrl: origin.url, connections: 2 },
			);
			const afterEnvironment = proxy.targets.length;
			expect(afterEnvironment).toBeGreaterThan(afterExplicit);

			delete process.env.http_proxy;
			process.env.HTTP_PROXY = proxy.url;
			process.env.NO_PROXY = "127.0.0.1";
			await downloadHuggingFaceFile(
				{ repository: "org/model", revision: "commit" },
				modelFile("no-proxy.gguf", data),
				{ outputDir, hubUrl: origin.url, connections: 2 },
			);
			expect(proxy.targets.length).toBe(afterEnvironment);
		} finally {
			for (const key of environmentKeys) {
				const value = savedEnvironment[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await Promise.all([origin.close(), proxy.close()]);
		}
	});
});
