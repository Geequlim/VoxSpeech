import type { EngineLoadParams } from "@voxspeech/protocol";
import type { EngineClientOptions } from "@voxspeech/engine-client";

import {
	startEngineSynthesisService,
	type StartEngineSynthesisOptions,
} from "./engine-synthesis.js";
import { startDaemonServer, type DaemonServer } from "./server.js";

export interface StartEngineDaemonOptions {
	readonly engine: EngineClientOptions;
	readonly load: EngineLoadParams;
	readonly socketPath: string;
}

export async function startEngineDaemon(options: StartEngineDaemonOptions): Promise<DaemonServer> {
	const synthesisOptions: StartEngineSynthesisOptions = {
		engine: options.engine,
		load: options.load,
	};
	const synthesis = await startEngineSynthesisService(synthesisOptions);
	try {
		return await startDaemonServer({ socketPath: options.socketPath, synthesis });
	} catch (error) {
		await synthesis.close().catch(() => undefined);
		throw error;
	}
}
