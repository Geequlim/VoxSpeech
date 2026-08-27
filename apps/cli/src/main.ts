import { homedir } from "node:os";
import process from "node:process";

import { resolveVoxSpeechPaths } from "@voxspeech/config";

import { runCli } from "./cli.js";

const paths = resolveVoxSpeechPaths(process.env, homedir(), process.getuid?.() ?? 0);

try {
	process.exitCode = await runCli(process.argv.slice(2), paths.socketFile);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
