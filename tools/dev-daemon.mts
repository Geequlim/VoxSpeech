import { spawn } from "node:child_process";
import { access, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { Command, Option } from "commander";

import { DaemonRpcClient } from "../apps/cli/src/rpc-client.ts";
import { startProductDaemon } from "../apps/daemon/src/runtime.ts";
import { ModelRepository } from "../apps/daemon/src/models/repository.ts";
import { ConfigStore, resolveVoxSpeechPaths } from "../packages/config/src/index.ts";
import type {
	DownloadOptions,
	DownloadResult,
	ModelManifest,
} from "../packages/model-downloader/src/types.ts";
import {
	BACKENDS,
	MODEL_DIRECTORY,
	MODELS,
	requireFiles,
	resolveNativeAssets,
	type Backend,
	type Model,
} from "./native-assets.mts";

const MODEL_IDS: Readonly<Record<Model, string>> = {
	"0.6b": "qwen3-tts-0.6b-base-q8_0",
	"1.7b": "qwen3-tts-1.7b-base-q4_k_m",
};

interface DaemonOptions {
	readonly backend?: Backend;
	readonly model?: Model;
}

const program = new Command()
	.name("voxspeech-dev-daemon")
	.description("Run the real product daemon from repository-cached native assets")
	.addOption(new Option("-m, --model <model>", "default model").choices(Object.keys(MODELS)))
	.addOption(new Option("-b, --backend <backend>", "native backend").choices(BACKENDS))
	.action(async (options: DaemonOptions) => {
		await runDaemon(options);
	});

try {
	await program.parseAsync(process.argv);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}

async function runDaemon(options: DaemonOptions): Promise<void> {
	const paths = resolveVoxSpeechPaths(process.env, homedir(), process.getuid?.() ?? 0);
	await stopExistingDaemon(paths.socketFile);
	const hadConfig = await fileExists(paths.configFile);
	const config = new ConfigStore(paths.configFile);
	const current = await config.load();
	const model =
		options.model ?? (hadConfig ? modelFromId(current.model.default) : undefined) ?? "0.6b";
	const backend =
		options.backend ??
		(hadConfig ? backendFromConfig(current.engine.backend) : undefined) ??
		"vulkan";
	const assets = await resolveNativeAssets(model, backend);
	const modelId = MODEL_IDS[model];
	await config.update({
		...current,
		engine: { ...current.engine, backend },
		model: { default: modelId },
	});
	const repository = new ModelRepository({
		cacheDirectory: paths.cacheDirectory,
		dataDirectory: paths.dataDirectory,
		download: copyCachedManifest,
	});
	for (const id of Object.values(MODEL_IDS)) await repository.install(id);

	const daemon = await startProductDaemon({
		download: copyCachedManifest,
		engine: { command: assets.engine, onStderr: (text) => process.stderr.write(text) },
		paths,
	});
	const client = await DaemonRpcClient.connect({ socketPath: paths.socketFile });
	try {
		const status = await client.status();
		if (status.engine.state !== "ready") {
			await daemon.close();
			throw new Error(
				`Native engine failed to become ready (state: ${status.engine.state}). Check the log above.`,
			);
		}
	} finally {
		client.close();
	}
	process.stdout.write(
		`${JSON.stringify({ backend, model: modelId, socket: paths.socketFile, state: "ready" })}\n`,
	);
	const stopped = Promise.withResolvers<void>();
	let closing = false;
	const close = () => {
		if (closing) return;
		closing = true;
		void daemon.close().then(stopped.resolve, stopped.reject);
	};
	process.once("SIGINT", close);
	process.once("SIGTERM", close);
	await stopped.promise;
}

function modelFromId(id: string | null): Model | undefined {
	return (Object.entries(MODEL_IDS) as Array<[Model, string]>).find(
		(entry) => entry[1] === id,
	)?.[0];
}

function backendFromConfig(value: string): Backend | undefined {
	return BACKENDS.find((backend) => backend === value);
}

async function fileExists(file: string): Promise<boolean> {
	return access(file).then(
		() => true,
		() => false,
	);
}

async function stopExistingDaemon(socketPath: string): Promise<void> {
	if (!(await daemonIsRunning(socketPath))) return;
	process.stdout.write(`Stopping the previous VoxSpeech daemon at ${socketPath}\n`);
	await signalSocketOwner(socketPath, "TERM");
	if (await waitForDaemonToStop(socketPath, 5_000)) return;
	process.stdout.write("Previous daemon did not stop after SIGTERM; sending SIGKILL\n");
	await signalSocketOwner(socketPath, "KILL");
	if (!(await waitForDaemonToStop(socketPath, 2_000)))
		throw new Error(`Unable to stop the previous VoxSpeech daemon at ${socketPath}`);
}

async function daemonIsRunning(socketPath: string): Promise<boolean> {
	const client = await DaemonRpcClient.connect({ socketPath }).catch(() => undefined);
	if (!client) return false;
	client.close();
	return true;
}

async function waitForDaemonToStop(socketPath: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	do {
		if (!(await daemonIsRunning(socketPath))) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	return false;
}

async function signalSocketOwner(socketPath: string, signal: "KILL" | "TERM"): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn("fuser", ["-k", `-${signal}`, socketPath], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => (stderr += chunk));
		child.once("error", reject);
		child.once("exit", (code, exitSignal) => {
			if (code === 0) resolve();
			else
				reject(
					new Error(
						`fuser failed to signal the previous daemon (${exitSignal ?? code ?? "unknown"})${stderr ? `: ${stderr.trim()}` : ""}`,
					),
				);
		});
	});
}

async function copyCachedManifest(
	manifest: ModelManifest,
	options: DownloadOptions,
): Promise<DownloadResult[]> {
	await mkdir(options.outputDir, { mode: 0o700, recursive: true });
	await requireFiles(
		manifest.files.map((file) => [path.join(MODEL_DIRECTORY, file.name), file.name] as const),
	);
	return Promise.all(
		manifest.files.map(async (file) => {
			options.signal?.throwIfAborted();
			const source = path.join(MODEL_DIRECTORY, file.name);
			const destination = path.join(options.outputDir, file.name);
			await copyFile(source, destination);
			options.onProgress?.({
				bytes: file.size,
				bytesPerSecond: 0,
				file: file.name,
				percentage: 100,
				size: file.size,
			});
			return {
				downloaded: false,
				path: destination,
				resumed: false,
				sha256: file.sha256,
				size: file.size,
				url: `file://${source}`,
				verification: "sha256" as const,
			};
		}),
	);
}
