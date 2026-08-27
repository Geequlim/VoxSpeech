import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveVoxSpeechPaths } from "@voxspeech/config";
import { afterEach, describe, expect, it } from "vitest";

import { DaemonRpcClient } from "../../cli/src/rpc-client.js";
import { startProductDaemon, type DaemonServer } from "../src/index.js";

const directories: string[] = [];
const servers: DaemonServer[] = [];

afterEach(async () => {
	await Promise.allSettled(servers.splice(0).map((server) => server.close()));
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("P3 product runtime", () => {
	it("starts from empty XDG directories and persists config across daemon restarts", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "voxspeech-runtime-p3-"));
		directories.push(root);
		const paths = resolveVoxSpeechPaths(
			{
				XDG_CACHE_HOME: path.join(root, "cache"),
				XDG_CONFIG_HOME: path.join(root, "config"),
				XDG_DATA_HOME: path.join(root, "data"),
				XDG_RUNTIME_DIR: path.join(root, "runtime"),
			},
			root,
			1000,
		);
		const options = { engine: { command: "/engine-must-not-start-without-a-model" }, paths };
		servers.push(await startProductDaemon(options));
		let client = await DaemonRpcClient.connect({ socketPath: paths.socketFile });
		const initial = await client.getConfig();
		expect(initial.model.default).toBe("qwen3-tts-1.7b-base-q4_k_m");
		expect((await client.listModels()).models[0]).toMatchObject({
			active: true,
			installed: false,
			verified: false,
		});
		await client.updateConfig({
			...initial,
			api: { ...initial.api, port: 18_080 },
			model: { default: null },
		});
		client.close();
		await servers.pop()!.close();

		servers.push(await startProductDaemon(options));
		client = await DaemonRpcClient.connect({ socketPath: paths.socketFile });
		await expect(client.getConfig()).resolves.toMatchObject({
			api: { port: 18_080 },
			model: { default: null },
		});
		await expect(client.status()).resolves.toMatchObject({
			engine: { modelId: null, state: "stopped" },
			model: { defaultId: null },
		});
		await expect(client.synthesize({ input: "没有模型" })).rejects.toMatchObject({ code: -32002 });
		client.close();
	});
});
