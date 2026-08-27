#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { downloadManifest, readModelManifest } from "@tinyaxis/model-downloader";

// Pins exact revisions and SHA-256 checksums for the P1 acceptance models. The
// public `model-downloader` CLI discovers files from a repository instead, so
// this helper keeps manifest-driven downloads available for the probe.

interface CliOptions {
	readonly manifestPath: string;
	readonly outputDir: string;
	readonly hubUrl?: string;
	readonly proxy?: string;
	readonly connections?: number;
}

const USAGE = `Usage: yarn model:download <manifest.json> --output-dir <path> [options]

Options:
  --hub-url <url>       Hugging Face endpoint (default: HF_ENDPOINT or https://huggingface.co)
  --proxy <url>         Explicit proxy (overrides HTTP(S)_PROXY for this command)
  --connections <n>     Parallel connections per file (default: auto, max: 32)
  --help                Show this help
`;

function takeValue(args: readonly string[], index: number, option: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new TypeError(`${option} requires a value`);
	return value;
}

function parseCliArgs(args: readonly string[]): CliOptions {
	let manifestPath: string | undefined;
	let outputDir: string | undefined;
	let hubUrl: string | undefined;
	let proxy: string | undefined;
	let connections: number | undefined;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--help") throw new TypeError("--help must be used on its own");
		if (arg === "--output-dir") {
			outputDir = takeValue(args, index, arg);
			index += 1;
		} else if (arg === "--hub-url") {
			hubUrl = takeValue(args, index, arg);
			index += 1;
		} else if (arg === "--proxy") {
			proxy = takeValue(args, index, arg);
			index += 1;
		} else if (arg === "--connections") {
			connections = Number(takeValue(args, index, arg));
			index += 1;
		} else if (arg.startsWith("--")) {
			throw new TypeError(`Unknown option: ${arg}`);
		} else if (!manifestPath) {
			manifestPath = arg;
		} else {
			throw new TypeError(`Unexpected argument: ${arg}`);
		}
	}

	if (!manifestPath) throw new TypeError("Manifest path is required");
	if (!outputDir) throw new TypeError("--output-dir is required");
	return { manifestPath, outputDir, hubUrl, proxy, connections };
}

async function main(args: readonly string[]): Promise<number> {
	if (args.length === 1 && args[0] === "--help") {
		process.stderr.write(USAGE);
		return 0;
	}
	const options = parseCliArgs(args);
	const manifest = await readModelManifest(resolve(options.manifestPath));
	const controller = new AbortController();
	const abort = () => controller.abort();
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);

	try {
		const results = await downloadManifest(manifest, {
			outputDir: resolve(options.outputDir),
			hubUrl: options.hubUrl,
			proxy: options.proxy,
			connections: options.connections,
			signal: controller.signal,
			onProgress: ({ file, percentage }) => process.stderr.write(`\r${file}: ${percentage.toFixed(1)}%`),
		});
		process.stderr.write("\n");
		for (const result of results) {
			process.stdout.write(`${result.downloaded ? "installed" : "verified"}: ${result.path}\n`);
		}
		return 0;
	} finally {
		process.removeListener("SIGINT", abort);
		process.removeListener("SIGTERM", abort);
	}
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error: unknown) => {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		},
	);
}
