import { homedir } from "node:os";
import process from "node:process";

import { resolveVoxSpeechPaths } from "@voxspeech/config";

import { startProductDaemon } from "./runtime.js";

const engineCommand = process.env.VOXSPEECH_ENGINE;
if (!engineCommand) {
	process.stderr.write("VOXSPEECH_ENGINE must point to the native voxspeech-engine executable\n");
	process.exitCode = 1;
} else {
	const paths = resolveVoxSpeechPaths(process.env, homedir(), process.getuid?.() ?? 0);
	try {
		const daemon = await startProductDaemon({ engine: { command: engineCommand }, paths });
		let closing = false;
		const close = () => {
			if (closing) return;
			closing = true;
			void daemon.close().catch((error: unknown) => {
				process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
				process.exitCode = 1;
			});
		};
		process.once("SIGINT", close);
		process.once("SIGTERM", close);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
