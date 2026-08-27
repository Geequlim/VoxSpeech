#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { Command, CommanderError, InvalidArgumentError, type OptionValues } from "commander";

import { defaultConnections, downloadHuggingFaceFile } from "./downloader.ts";
import { DownloadAbortedError } from "./errors.ts";
import { listRepositoryFiles } from "./hub.ts";
import type { DownloadProgress, DownloadResult, ModelFile } from "./types.ts";
import { resolveHubUrl } from "./url.ts";

export interface CliIo {
	readonly writeOut: (text: string) => void;
	readonly writeErr: (text: string) => void;
	readonly tty: boolean;
}

const processIo: CliIo = {
	writeOut: (text) => process.stdout.write(text),
	writeErr: (text) => process.stderr.write(text),
	tty: process.stderr.isTTY === true,
};

const BAR_WIDTH = 16;
const NAME_WIDTH = 24;

function readVersion(): string {
	const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string };
	return manifest.version ?? "0.0.0";
}

function parseConnections(value: string): number {
	const connections = Number(value);
	if (!Number.isSafeInteger(connections) || connections < 1 || connections > 32) {
		throw new InvalidArgumentError("connections must be an integer between 1 and 32");
	}
	return connections;
}

function compileGlob(pattern: string): RegExp {
	let source = "";
	for (const character of pattern) {
		if (character === "*") source += ".*";
		else if (character === "?") source += ".";
		else source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

function splitGlobs(values: readonly string[] | undefined): string[] {
	return (values ?? [])
		.flatMap((value) => value.split(","))
		.filter((pattern) => pattern.length > 0);
}

function filterFiles(
	files: readonly ModelFile[],
	include: readonly string[],
	exclude: readonly string[],
): ModelFile[] {
	const includes = include.map(compileGlob);
	const excludes = exclude.map(compileGlob);
	return files.filter(
		(file) =>
			(includes.length === 0 || includes.some((pattern) => pattern.test(file.name))) &&
			!excludes.some((pattern) => pattern.test(file.name)),
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1_000) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = -1;
	do {
		value /= 1_000;
		unit += 1;
	} while (value >= 1_000 && unit < units.length - 1);
	return `${value.toFixed(1)} ${units[unit]}`;
}

function formatSpeed(bytesPerSecond: number): string {
	return bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : "--";
}

function formatDuration(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	const hours = Math.floor(total / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);
	const rest = total % 60;
	if (hours > 0)
		return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
	return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function shortenName(name: string): string {
	const last = basename(name);
	return last.length > NAME_WIDTH ? `${last.slice(0, NAME_WIDTH - 1)}…` : last;
}

interface ProgressReporterOptions {
	readonly repository: string;
	readonly files: readonly ModelFile[];
	readonly io: CliIo;
	readonly quiet: boolean;
}

interface ProgressReporter {
	onProgress(progress: DownloadProgress): void;
	onFileComplete(file: ModelFile, result: DownloadResult): void;
	finish(): void;
}

function createProgressReporter(options: ProgressReporterOptions): ProgressReporter {
	const { io, quiet } = options;
	const totalBytes = options.files.reduce((sum, file) => sum + file.size, 0);
	const fileSizes = new Map(options.files.map((file) => [file.name, file.size] as const));
	const animated = io.tty && !quiet;
	let completedCount = 0;
	let completedBytes = 0;
	let currentBytes = 0;
	let currentName = "";
	let speed = 0;

	function render(): void {
		if (!animated) return;
		const transferred = completedBytes + currentBytes;
		const percentage = totalBytes > 0 ? (transferred / totalBytes) * 100 : 100;
		const filled = Math.round((percentage / 100) * BAR_WIDTH);
		const bar = `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
		const remaining = speed > 0 ? (totalBytes - transferred) / speed : Number.POSITIVE_INFINITY;
		const eta = Number.isFinite(remaining) ? formatDuration(remaining) : "--:--";
		const line =
			`${options.repository}  ${bar}  ${completedCount}/${options.files.length}  ` +
			`${percentage.toFixed(0)}%  ${formatBytes(transferred)}/${formatBytes(totalBytes)}  ` +
			`${formatSpeed(speed)}  ETA ${eta}  ${shortenName(currentName)}`;
		io.writeErr(`\r${line}\x1b[K`);
	}

	return {
		onProgress(progress) {
			if (quiet) return;
			currentBytes = progress.bytes;
			currentName = progress.file;
			speed = progress.bytesPerSecond;
			render();
		},
		onFileComplete(file, result) {
			if (quiet) return;
			completedCount += 1;
			currentBytes = 0;
			currentName = file.name;
			completedBytes += fileSizes.get(file.name) ?? file.size;
			speed = 0;
			if (animated) {
				render();
			} else {
				const status = result.downloaded ? "installed" : "verified";
				io.writeErr(
					`[${completedCount}/${options.files.length}] ${status} ${file.name} (${formatBytes(file.size)})\n`,
				);
			}
		},
		finish() {
			if (animated) io.writeErr("\n");
		},
	};
}

function errorMessage(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	while (current instanceof Error && parts.length < 4) {
		parts.push(current.message);
		current = current.cause;
	}
	if (parts.length === 0) parts.push(String(error));
	return parts.join(": ");
}

function endpointLabel(hubUrl: string | undefined): string {
	const endpoint = resolveHubUrl(hubUrl);
	const fromEnvironment = !hubUrl && process.env.HF_ENDPOINT ? " (HF_ENDPOINT)" : "";
	return `${endpoint}${fromEnvironment}`;
}

interface DownloadCommandOptions extends OptionValues {
	readonly outputDir?: string;
	readonly revision?: string;
	readonly include?: string[];
	readonly exclude?: string[];
	readonly connections?: number;
	readonly hubUrl?: string;
	readonly proxy?: string;
	readonly quiet?: boolean;
}

async function runDownload(
	repository: string,
	options: DownloadCommandOptions,
	io: CliIo,
): Promise<number> {
	const revision = options.revision ?? "main";
	const outputDir = options.outputDir ?? `./${repository}`;
	const quiet = options.quiet === true;

	let files: ModelFile[];
	try {
		files = filterFiles(
			await listRepositoryFiles(repository, revision, {
				hubUrl: options.hubUrl,
				proxy: options.proxy,
			}),
			splitGlobs(options.include),
			splitGlobs(options.exclude),
		);
	} catch (error) {
		if (error instanceof DownloadAbortedError) return 130;
		io.writeErr(`error: ${errorMessage(error)}\n`);
		return 1;
	}
	if (files.length === 0) {
		io.writeErr(`error: no files matched in ${repository}@${revision}\n`);
		return 1;
	}

	const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
	if (!quiet) {
		const connections = options.connections ?? defaultConnections();
		io.writeErr(`${repository}@${revision} → ${outputDir}\n`);
		io.writeErr(
			`${files.length} files, ${formatBytes(totalBytes)} · ${endpointLabel(options.hubUrl)} · ${connections} connections\n`,
		);
	}

	const controller = new AbortController();
	const abort = () => controller.abort();
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	const startedAt = performance.now();
	const reporter = createProgressReporter({ repository, files, io, quiet });
	const results: DownloadResult[] = [];

	try {
		for (const file of files) {
			const result = await downloadHuggingFaceFile({ repository, revision }, file, {
				outputDir,
				hubUrl: options.hubUrl,
				proxy: options.proxy,
				connections: options.connections,
				signal: controller.signal,
				onProgress: reporter.onProgress,
			});
			reporter.onFileComplete(file, result);
			results.push(result);
		}
	} catch (error) {
		if (error instanceof DownloadAbortedError) {
			io.writeErr("\ninterrupted: completed chunks are kept, rerun the same command to resume\n");
			return 130;
		}
		io.writeErr(`error: ${errorMessage(error)}\n`);
		return 1;
	} finally {
		process.removeListener("SIGINT", abort);
		process.removeListener("SIGTERM", abort);
	}
	reporter.finish();

	const elapsed = Math.round((performance.now() - startedAt) / 1_000);
	const nameWidth = Math.min(48, Math.max(...files.map((file) => file.name.length)));
	for (const [index, result] of results.entries()) {
		const status = result.downloaded ? "installed" : "verified";
		const resumed = result.resumed ? " (resumed)" : "";
		io.writeOut(
			`${status.padEnd(10)}${files[index].name.padEnd(nameWidth)}  ${formatBytes(result.size).padEnd(10)}  ${result.verification}${resumed}\n`,
		);
	}
	io.writeOut(
		`${files.length} files, ${formatBytes(totalBytes)} total in ${formatDuration(elapsed)} → ${outputDir}\n`,
	);
	return 0;
}

export async function runCli(
	arguments_: readonly string[],
	io: CliIo = processIo,
): Promise<number> {
	let exitCode = 0;
	const program = new Command();
	program
		.name("model-downloader")
		.description("Download Hugging Face model repositories with resumable, verified transfers")
		.version(readVersion())
		.exitOverride()
		.configureOutput({ writeOut: io.writeOut, writeErr: io.writeErr })
		.showHelpAfterError()
		.argument("<repository>", 'Hugging Face repository, e.g. "Qwen/Qwen3-Talker"')
		.option("-o, --output-dir <dir>", "destination directory (default: ./<owner>/<name>)")
		.option("-r, --revision <revision>", "branch, tag, or commit revision", "main")
		.option("-i, --include <globs...>", "only download files matching these glob patterns")
		.option("-e, --exclude <globs...>", "skip files matching these glob patterns")
		.option("-c, --connections <number>", "parallel connections per file (1-32)", parseConnections)
		.option(
			"--hub-url <url>",
			"Hugging Face endpoint (default: HF_ENDPOINT or https://huggingface.co)",
		)
		.option("--proxy <url>", "explicit proxy for this command")
		.option("-q, --quiet", "suppress progress output")
		.action(async (repository: string, options: DownloadCommandOptions) => {
			exitCode = await runDownload(repository, options, io);
		});

	try {
		await program.parseAsync(arguments_, { from: "user" });
	} catch (error) {
		if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
		throw error;
	}
	return exitCode;
}

// Bin links are symlinks: argv[1] keeps the link path while import.meta.url is
// the real file, so compare through realpath or the entry guard never fires.
const entryPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) {
	runCli(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error: unknown) => {
			process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		},
	);
}
