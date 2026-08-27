import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli, type CliIo } from "../src/cli.js";
import { createTempDirectories, startHubServer, type HubFile } from "./servers.js";

interface CapturedIo extends CliIo {
	readonly out: string;
	readonly err: string;
}

function createIo(tty: boolean): CapturedIo {
	let outText = "";
	let errText = "";
	return {
		writeOut: (text) => {
			outText += text;
		},
		writeErr: (text) => {
			errText += text;
		},
		tty,
		get out() {
			return outText;
		},
		get err() {
			return errText;
		},
	};
}

const directories = createTempDirectories();

beforeEach(() => {
	delete process.env.HF_ENDPOINT;
});

afterEach(async () => {
	await directories.cleanup();
});

describe("model-downloader CLI", () => {
	it("downloads a repository with progress and a summary", async () => {
		const weights = Buffer.alloc(256 * 1_024, 0x33);
		const config = Buffer.from('{"kind":"tts"}', "utf8");
		const files: HubFile[] = [
			{ path: "model.gguf", data: weights },
			{ path: "config.json", data: config, lfs: false },
		];
		const server = await startHubServer("org/model", files);
		const outputDir = await directories.make();
		const io = createIo(true);
		try {
			const code = await runCli(
				["org/model", "--output-dir", outputDir, "--hub-url", server.url, "--connections", "2"],
				io,
			);
			expect(code).toBe(0);
			expect(io.err).toContain("org/model@main");
			expect(io.err).toContain("█");
			expect(io.err).toContain("2 files");
			expect(io.out).toContain("installed");
			expect(io.out).toContain("model.gguf");
			expect(io.out).toContain("sha256");
			expect(io.out).toContain("size");
			expect(io.out).toContain("2 files,");
			await expect(readFile(join(outputDir, "model.gguf"))).resolves.toEqual(weights);
			await expect(readFile(join(outputDir, "config.json"))).resolves.toEqual(config);
		} finally {
			await server.close();
		}
	});

	it("defaults the output directory to ./<owner>/<name>", async () => {
		const files: HubFile[] = [{ path: "model.gguf", data: Buffer.alloc(64 * 1_024, 0x44) }];
		const server = await startHubServer("org/model", files);
		const base = await directories.make();
		const previousCwd = process.cwd();
		process.chdir(base);
		try {
			const io = createIo(false);
			const code = await runCli(["org/model", "--hub-url", server.url, "-q"], io);
			expect(code).toBe(0);
			expect(existsSync(join(base, "org", "model", "model.gguf"))).toBe(true);
		} finally {
			process.chdir(previousCwd);
			await server.close();
		}
	});

	it("filters files with include and exclude patterns", async () => {
		const files: HubFile[] = [
			{ path: "model.gguf", data: Buffer.alloc(64 * 1_024, 1) },
			{ path: "weights/extra.gguf", data: Buffer.alloc(32 * 1_024, 2) },
			{ path: "config.json", data: Buffer.from("{}", "utf8"), lfs: false },
			{ path: "README.md", data: Buffer.from("# model", "utf8"), lfs: false },
		];
		const server = await startHubServer("org/model", files);
		const included = await directories.make();
		const excluded = await directories.make();
		try {
			const includeIo = createIo(false);
			await runCli(
				["org/model", "--output-dir", included, "--hub-url", server.url, "--include", "*.gguf"],
				includeIo,
			);
			expect(existsSync(join(included, "model.gguf"))).toBe(true);
			expect(existsSync(join(included, "weights", "extra.gguf"))).toBe(true);
			expect(existsSync(join(included, "config.json"))).toBe(false);
			expect(existsSync(join(included, "README.md"))).toBe(false);

			const excludeIo = createIo(false);
			await runCli(
				[
					"org/model",
					"--output-dir",
					excluded,
					"--hub-url",
					server.url,
					"--exclude",
					"weights/*,*.md",
				],
				excludeIo,
			);
			expect(existsSync(join(excluded, "model.gguf"))).toBe(true);
			expect(existsSync(join(excluded, "config.json"))).toBe(true);
			expect(existsSync(join(excluded, "weights"))).toBe(false);
		} finally {
			await server.close();
		}
	});

	it("prints one line per file without a tty", async () => {
		const files: HubFile[] = [
			{ path: "model.gguf", data: Buffer.alloc(64 * 1_024, 3) },
			{ path: "config.json", data: Buffer.from("{}", "utf8"), lfs: false },
		];
		const server = await startHubServer("org/model", files);
		const outputDir = await directories.make();
		const io = createIo(false);
		try {
			const code = await runCli(
				["org/model", "--output-dir", outputDir, "--hub-url", server.url],
				io,
			);
			expect(code).toBe(0);
			expect(io.err).not.toContain("█");
			expect(io.err).toContain("[1/2] installed model.gguf");
			expect(io.err).toContain("[2/2] installed config.json");
		} finally {
			await server.close();
		}
	});

	it("stays silent with --quiet but still prints the summary", async () => {
		const files: HubFile[] = [{ path: "model.gguf", data: Buffer.alloc(32 * 1_024, 4) }];
		const server = await startHubServer("org/model", files);
		const outputDir = await directories.make();
		const io = createIo(true);
		try {
			const code = await runCli(
				["org/model", "--output-dir", outputDir, "--hub-url", server.url, "--quiet"],
				io,
			);
			expect(code).toBe(0);
			expect(io.err).toBe("");
			expect(io.out).toContain("1 files");
		} finally {
			await server.close();
		}
	});

	it("rejects invalid usage with exit code 2", async () => {
		const io = createIo(false);
		expect(await runCli(["--nope"], io)).toBe(2);
		expect(io.err).toContain("unknown option");
		expect(await runCli([], createIo(false))).toBe(2);
		expect(await runCli(["-c", "0", "org/model"], createIo(false))).toBe(2);
		expect(await runCli(["-c", "abc", "org/model"], createIo(false))).toBe(2);
	});

	it("shows help and version with exit code 0", async () => {
		const helpIo = createIo(false);
		expect(await runCli(["--help"], helpIo)).toBe(0);
		expect(helpIo.out).toContain("Usage:");
		expect(helpIo.out).toContain("--include");

		const versionIo = createIo(false);
		expect(await runCli(["--version"], versionIo)).toBe(0);
		expect(versionIo.out).toContain("0.1.0");
	});

	it("fails with exit code 1 for repository and filter errors", async () => {
		const files: HubFile[] = [{ path: "model.gguf", data: Buffer.alloc(32 * 1_024, 5) }];
		const server = await startHubServer("org/model", files);
		try {
			const invalidIo = createIo(false);
			expect(await runCli(["a/b/c", "--hub-url", server.url], invalidIo)).toBe(1);
			expect(invalidIo.err).toContain("repository must look like");

			const missingIo = createIo(false);
			expect(
				await runCli(["org/model", "--hub-url", server.url, "--include", "*.none"], missingIo),
			).toBe(1);
			expect(missingIo.err).toContain("no files matched");
		} finally {
			await server.close();
		}
	});
});
