import { Argument, Command } from "commander";

import { BACKENDS, buildNativeBackends, nativeEnginePath, type Backend } from "./native-assets.mts";

const program = new Command()
	.name("voxspeech-native-build")
	.description("Build cached native engine artifacts")
	.addArgument(new Argument("[backends...]", "backends to build").choices(BACKENDS))
	.action(async (backends: Backend[]) => {
		const selected = backends.length > 0 ? backends : [...BACKENDS];
		await buildNativeBackends(selected);
		for (const backend of selected)
			process.stdout.write(`${backend}: ${nativeEnginePath(backend)}\n`);
	});

await program.parseAsync(process.argv);
