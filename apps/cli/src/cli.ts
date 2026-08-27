import { access, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { stdin, stderr, stdout } from "node:process";
import type { Readable, Writable } from "node:stream";
import path from "node:path";

import { ConfigStore, resolveVoxSpeechPaths } from "@voxspeech/config";
import { prepareSpeechRequest } from "@voxspeech/core";
import type { AudioFormat, OperationProgressParams, VoxSpeechConfig } from "@voxspeech/protocol";
import { Command, CommanderError, InvalidArgumentError } from "commander";

import { encodeWav, playAudio } from "./audio.js";
import { DaemonRpcClient } from "./rpc-client.js";

const DEFAULT_MODEL_ID = "qwen3-tts-1.7b-base-q4_k_m";

export interface CliDependencies {
	readonly connect?: typeof DaemonRpcClient.connect;
	readonly error?: Writable;
	readonly input?: Readable;
	readonly output?: Writable;
	readonly play?: (audio: Uint8Array, format: AudioFormat) => Promise<void>;
	readonly write?: typeof writeFile;
}

interface CommandContext {
	readonly dependencies: CliDependencies;
	readonly socketPath: string;
}

interface InstallOptions {
	readonly connections?: number;
	readonly hubUrl?: string;
	readonly proxy?: string;
}

interface SpeakOptions {
	readonly format?: AudioFormat;
	readonly output?: string;
	readonly play?: boolean;
	readonly voice?: string;
}

export async function runCli(
	arguments_: readonly string[],
	socketPath: string,
	dependencies: CliDependencies = {},
): Promise<number> {
	const context = { dependencies, socketPath };
	const program = createProgram(context);
	if (arguments_.length === 0) {
		program.outputHelp();
		return 0;
	}
	try {
		await program.parseAsync(arguments_, { from: "user" });
	} catch (error) {
		if (
			error instanceof CommanderError &&
			(error.code === "commander.help" || error.code === "commander.helpDisplayed")
		)
			return 0;
		throw error;
	}
	return 0;
}

function createProgram(context: CommandContext): Command {
	const output = context.dependencies.output ?? stdout;
	const error = context.dependencies.error ?? stderr;
	const program = new Command();
	program
		.name("voxspeech")
		.description("Local text-to-speech runtime")
		.showHelpAfterError()
		.configureOutput({
			writeErr: (message) => error.write(message),
			writeOut: (message) => output.write(message),
		})
		.exitOverride();

	program
		.command("status")
		.description("Show daemon status")
		.action(async () => {
			await withClient(context, async (client) => writeJson(context, await client.status()));
		});

	program
		.command("setup")
		.description("Configure downloads and install the default model")
		.option("--hub-url <url>", "Hugging Face hub URL")
		.option("--proxy <url>", "download proxy URL")
		.option("--connections <number>", "parallel connections (1-32)", parseConnections)
		.action(async (options: InstallOptions) => {
			await withClient(context, async (client) => {
				let config = await client.getConfig();
				if (hasDownloadOptions(options)) {
					config = {
						...config,
						download: {
							connections: options.connections ?? config.download.connections,
							hubUrl: options.hubUrl ?? config.download.hubUrl,
							proxy: options.proxy ?? config.download.proxy,
						},
					};
				}
				config = { ...config, model: { default: DEFAULT_MODEL_ID } };
				writeJson(context, await client.updateConfig(config));
				const id = DEFAULT_MODEL_ID;
				writeJson(
					context,
					await client.installModel({ id }, { onProgress: progressWriter(context) }),
				);
				writeJson(context, await client.useModel(id));
				writeJson(context, {
					message: "Restart the daemon to load the selected model",
					restartRequired: true,
					type: "notice",
				});
			});
		});

	program
		.command("speak [text...]")
		.description("Synthesize text, or read it from standard input")
		.option("-o, --output <path>", "write audio to a file")
		.option("--format <format>", "audio format: pcm or wav", parseFormat)
		.option("--play", "play audio after synthesis")
		.option("--voice <id>", "voice profile ID")
		.action(async (text: string[], options: SpeakOptions) => {
			const input = text.join(" ") || (await readInput(context.dependencies.input ?? stdin));
			const prepared = prepareSpeechRequest({ input }).input;
			await withClient(context, async (client) => {
				const synthesis = await client.synthesize({ input: prepared, voice: options.voice });
				const format = options.format ?? inferFormat(options.output);
				const audio = format === "wav" ? encodeWav(synthesis.audio) : synthesis.audio;
				if (options.output) await (context.dependencies.write ?? writeFile)(options.output, audio);
				if (options.play || !options.output)
					await (context.dependencies.play ?? playAudio)(audio, format);
			});
		});

	addModelCommands(program, context);
	addVoiceCommands(program, context);
	addConfigCommands(program, context);
	return program;
}

function addModelCommands(program: Command, context: CommandContext): void {
	const model = program.command("model").description("Manage installed models");
	model.command("list").action(async () => {
		await withClient(context, async (client) => writeJson(context, await client.listModels()));
	});
	model
		.command("install <id>")
		.option("--hub-url <url>", "Hugging Face hub URL")
		.option("--proxy <url>", "download proxy URL")
		.option("--connections <number>", "parallel connections (1-32)", parseConnections)
		.action(async (id: string, options: InstallOptions) => {
			await withClient(context, async (client) => {
				writeJson(
					context,
					await client.installModel(
						{ connections: options.connections, hubUrl: options.hubUrl, id, proxy: options.proxy },
						{ onProgress: progressWriter(context) },
					),
				);
			});
		});
	for (const [name, operation] of [
		["verify", "verifyModel"],
		["use", "useModel"],
		["remove", "removeModel"],
	] as const) {
		model.command(`${name} <id>`).action(async (id: string) => {
			await withClient(context, async (client) => {
				writeJson(context, await client[operation](id));
			});
		});
	}
}

function addVoiceCommands(program: Command, context: CommandContext): void {
	const voice = program.command("voice").description("Manage voice profiles");
	voice.command("list").action(async () => {
		await withClient(context, async (client) => writeJson(context, await client.listVoices()));
	});
	voice
		.command("clone <id> <audio-path> <transcript>")
		.action(async (id: string, audioPath: string, transcript: string) => {
			await withClient(context, async (client) => {
				writeJson(
					context,
					await client.cloneVoice(
						{ audioPath, id, transcript },
						{ onProgress: progressWriter(context) },
					),
				);
			});
		});
	voice.command("show <id>").action(async (id: string) => {
		await withClient(context, async (client) => writeJson(context, await client.showVoice(id)));
	});
	for (const [name, operation] of [
		["use", "useVoice"],
		["remove", "removeVoice"],
	] as const) {
		voice.command(`${name} <id>`).action(async (id: string) => {
			await withClient(context, async (client) => {
				writeJson(context, await client[operation](id));
			});
		});
	}
}

function addConfigCommands(program: Command, context: CommandContext): void {
	const config = program.command("config").description("Inspect and apply configuration");
	config.command("path").action(() => {
		writeJson(context, { path: getConfigPath() });
	});
	config.command("show").action(async () => {
		await withClient(context, async (client) => writeJson(context, await client.getConfig()));
	});
	config.command("validate <file>").action(async (file: string) => {
		const value = await loadConfigFile(file);
		await withClient(context, async (client) => {
			writeJson(context, await client.validateConfig(value));
		});
	});
	config.command("apply <file>").action(async (file: string) => {
		const value = await loadConfigFile(file);
		await withClient(context, async (client) => {
			writeJson(context, await client.updateConfig(value));
		});
	});
}

async function withClient<T>(
	context: CommandContext,
	action: (client: DaemonRpcClient) => Promise<T>,
): Promise<T> {
	const client = await (context.dependencies.connect ?? DaemonRpcClient.connect)({
		socketPath: context.socketPath,
	});
	try {
		return await action(client);
	} finally {
		client.close();
	}
}

function getConfigPath(): string {
	return resolveVoxSpeechPaths(process.env, homedir(), process.getuid?.() ?? 0).configFile;
}

async function loadConfigFile(file: string): Promise<VoxSpeechConfig> {
	await access(file);
	return new ConfigStore(file).load();
}

function hasDownloadOptions(options: InstallOptions): boolean {
	return (
		options.connections !== undefined || options.hubUrl !== undefined || options.proxy !== undefined
	);
}

function parseConnections(value: string): number {
	const connections = Number(value);
	if (!Number.isInteger(connections) || connections < 1 || connections > 32)
		throw new InvalidArgumentError("connections must be an integer from 1 to 32");
	return connections;
}

function parseFormat(value: string): AudioFormat {
	if (value !== "pcm" && value !== "wav")
		throw new InvalidArgumentError("format must be pcm or wav");
	return value;
}

function progressWriter(context: CommandContext): (progress: OperationProgressParams) => void {
	return (progress) => writeJson(context, { ...progress, type: "progress" });
}

function writeJson(context: CommandContext, value: unknown): void {
	(context.dependencies.output ?? stdout).write(`${JSON.stringify(value)}\n`);
}

function inferFormat(outputPath?: string): AudioFormat {
	return outputPath && path.extname(outputPath).toLowerCase() === ".pcm" ? "pcm" : "wav";
}

async function readInput(input: Readable): Promise<string> {
	input.setEncoding("utf8");
	let text = "";
	for await (const chunk of input) text += chunk;
	return text;
}
