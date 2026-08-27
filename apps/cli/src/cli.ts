import { writeFile } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import type { Readable, Writable } from "node:stream";
import path from "node:path";

import { prepareSpeechRequest } from "@voxspeech/core";
import type { AudioFormat } from "@voxspeech/protocol";

import { encodeWav, playAudio } from "./audio.js";
import { DaemonRpcClient } from "./rpc-client.js";

export interface CliDependencies {
	readonly connect?: typeof DaemonRpcClient.connect;
	readonly input?: Readable;
	readonly output?: Writable;
	readonly play?: (audio: Uint8Array, format: AudioFormat) => Promise<void>;
	readonly write?: typeof writeFile;
}

export async function runCli(
	arguments_: readonly string[],
	socketPath: string,
	dependencies: CliDependencies = {},
): Promise<number> {
	const connect = dependencies.connect ?? DaemonRpcClient.connect;
	const client = await connect({ socketPath });
	try {
		const [command, ...rest] = arguments_;
		if (command === "status") {
			const status = await client.status();
			(dependencies.output ?? stdout).write(`${JSON.stringify(status, null, 2)}\n`);
			return 0;
		}
		if (command !== "speak") throw new Error("Usage: voxspeech <status|speak>");

		const parsed = parseSpeakArguments(rest);
		const text = prepareSpeechRequest({
			input: parsed.text || (await readInput(dependencies.input ?? stdin)),
		}).input;
		const synthesis = await client.synthesize({ input: text });
		const format = parsed.format ?? inferFormat(parsed.outputPath);
		const audio = format === "wav" ? encodeWav(synthesis.audio) : synthesis.audio;
		if (parsed.outputPath) await (dependencies.write ?? writeFile)(parsed.outputPath, audio);
		if (parsed.play || !parsed.outputPath) await (dependencies.play ?? playAudio)(audio, format);
		return 0;
	} finally {
		client.close();
	}
}

interface SpeakArguments {
	readonly format?: AudioFormat;
	readonly outputPath?: string;
	readonly play: boolean;
	readonly text: string;
}

function parseSpeakArguments(arguments_: readonly string[]): SpeakArguments {
	let format: AudioFormat | undefined;
	let outputPath: string | undefined;
	let play = false;
	const text: string[] = [];
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === "--output" || argument === "-o") {
			outputPath = arguments_[index + 1];
			if (!outputPath) throw new Error(`${argument} requires a file path`);
			index += 1;
		} else if (argument === "--format") {
			const value = arguments_[index + 1];
			if (value !== "pcm" && value !== "wav") throw new Error("--format must be pcm or wav");
			format = value;
			index += 1;
		} else if (argument === "--play") {
			play = true;
		} else if (argument?.startsWith("-")) {
			throw new Error(`Unknown option: ${argument}`);
		} else if (argument) {
			text.push(argument);
		}
	}
	return { format, outputPath, play, text: text.join(" ") };
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
