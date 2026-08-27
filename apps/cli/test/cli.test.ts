import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";

import { startDaemonServer, type DaemonServer } from "../../daemon/src/index.js";
import type { AudioFormat } from "@voxspeech/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/index.js";
import type { DaemonRpcClient } from "../src/rpc-client.js";

const servers: DaemonServer[] = [];
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("runCli", () => {
	it("prints daemon status as JSON", async () => {
		const { socketPath } = await createEnvironment();
		servers.push(await startDaemonServer({ socketPath }));
		let text = "";
		const output = new Writable({
			write(chunk, _encoding, callback) {
				text += chunk.toString();
				callback();
			},
		});

		expect(await runCli(["status"], socketPath, { output })).toBe(0);
		expect(JSON.parse(text)).toMatchObject({
			daemon: { state: "ready" },
			engine: { state: "stopped" },
		});
	});

	it("runs the complete text argument to WAV path", async () => {
		const { directory, socketPath } = await createEnvironment();
		servers.push(await startDaemonServer({ socketPath }));
		const outputPath = path.join(directory, "speech.wav");

		expect(await runCli(["speak", "任务", "完成", "--output", outputPath], socketPath)).toBe(0);
		const wav = await readFile(outputPath);
		expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
		expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
		expect(wav.byteLength).toBeGreaterThan(44);
	});

	it("reads stdin and writes raw PCM", async () => {
		const { directory, socketPath } = await createEnvironment();
		servers.push(await startDaemonServer({ socketPath }));
		const outputPath = path.join(directory, "speech.pcm");

		await runCli(["speak", "--format", "pcm", "--output", outputPath], socketPath, {
			input: Readable.from(["  来自标准输入  "]),
		});
		const pcm = await readFile(outputPath);
		expect(pcm.byteLength).toBe("来自标准输入".length * 480 * 2);
	});

	it("uses the injectable playback path", async () => {
		const { socketPath } = await createEnvironment();
		servers.push(await startDaemonServer({ socketPath }));
		const play = vi.fn(async (_audio: Uint8Array, _format: AudioFormat) => undefined);

		await runCli(["speak", "播放测试"], socketPath, { play });
		expect(play).toHaveBeenCalledOnce();
		expect(play.mock.calls[0]?.[1]).toBe("wav");
		const audio = play.mock.calls[0]?.[0];
		expect(
			Buffer.from(audio ?? [])
				.subarray(0, 4)
				.toString("ascii"),
		).toBe("RIFF");
	});

	it("orchestrates setup through config, install, and model selection", async () => {
		const calls: string[] = [];
		const client = createClient({
			getConfig: vi.fn(async () => {
				calls.push("config.get");
				return defaultConfig();
			}),
			installModel: vi.fn(async (params, options) => {
				calls.push("model.install");
				options?.onProgress?.({ completed: 1, phase: "download", requestId: "cli-1", total: 2 });
				return { id: params.id, success: true };
			}),
			updateConfig: vi.fn(async () => {
				calls.push("config.update");
				return { applied: true };
			}),
			useModel: vi.fn(async (id) => {
				calls.push("model.use");
				return { id, success: true };
			}),
		});
		let text = "";

		await runCli(["setup", "--hub-url", "https://mirror.example", "--connections", "4"], "unused", {
			connect: async () => client,
			output: capture((value) => (text += value)),
		});

		expect(calls).toEqual(["config.get", "config.update", "model.install", "model.use"]);
		expect(client.updateConfig).toHaveBeenCalledWith({
			...defaultConfig(),
			download: { connections: 4, hubUrl: "https://mirror.example", proxy: null },
		});
		expect(
			text
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		).toEqual([
			{ applied: true },
			{ completed: 1, phase: "download", requestId: "cli-1", total: 2, type: "progress" },
			{ id: "qwen3-tts-1.7b-base-q4_k_m", success: true },
			{ id: "qwen3-tts-1.7b-base-q4_k_m", success: true },
			{
				message: "Restart the daemon to load the selected model",
				restartRequired: true,
				type: "notice",
			},
		]);
	});

	it("setup always selects the frozen Base model", async () => {
		const client = createClient({
			getConfig: vi.fn(async () => ({
				...defaultConfig(),
				model: { default: "unsupported-model" },
			})),
			installModel: vi.fn(async (params) => ({ id: params.id, success: true })),
			updateConfig: vi.fn(async () => ({ applied: true })),
			useModel: vi.fn(async (id) => ({ id, success: true })),
		});

		await runCli(["setup"], "unused", {
			connect: async () => client,
			output: capture(() => undefined),
		});
		expect(client.updateConfig).toHaveBeenCalledWith(
			expect.objectContaining({ model: { default: "qwen3-tts-1.7b-base-q4_k_m" } }),
		);
		expect(client.installModel).toHaveBeenCalledWith(
			{ id: "qwen3-tts-1.7b-base-q4_k_m" },
			expect.any(Object),
		);
	});

	it("passes model, voice, and explicit speak inputs to daemon RPC", async () => {
		const client = createClient({
			cloneVoice: vi.fn(async (params) => ({ id: params.id, success: true })),
			installModel: vi.fn(async (params) => ({ id: params.id, success: true })),
			synthesize: vi.fn(async () => ({
				audio: Buffer.from([1, 2]),
				format: { channels: 1, encoding: "s16le", sampleRate: 24_000 },
				result: { durationMs: 1 },
			})),
		});

		await runCli(
			["model", "install", "model-id", "--proxy", "http://proxy", "--connections", "2"],
			"unused",
			{ connect: async () => client, output: capture(() => undefined) },
		);
		await runCli(["voice", "clone", "voice-id", "/tmp/reference.wav", "你好"], "unused", {
			connect: async () => client,
			output: capture(() => undefined),
		});
		await runCli(
			["speak", "你好", "--voice", "voice-id", "--output", "/tmp/output.pcm"],
			"unused",
			{
				connect: async () => client,
				output: capture(() => undefined),
				write: async () => undefined,
			},
		);

		expect(client.installModel).toHaveBeenCalledWith(
			{ connections: 2, hubUrl: undefined, id: "model-id", proxy: "http://proxy" },
			expect.any(Object),
		);
		expect(client.cloneVoice).toHaveBeenCalledWith(
			{ audioPath: "/tmp/reference.wav", id: "voice-id", transcript: "你好" },
			expect.any(Object),
		);
		expect(client.synthesize).toHaveBeenCalledWith({ input: "你好", voice: "voice-id" });
	});

	it("validates a YAML config locally before applying it", async () => {
		const { directory } = await createEnvironment();
		const file = path.join(directory, "config.yaml");
		await writeFile(file, configYaml(), "utf8");
		const client = createClient({ updateConfig: vi.fn(async () => ({ applied: true })) });

		await runCli(["config", "apply", file], "unused", {
			connect: async () => client,
			output: capture(() => undefined),
		});
		expect(client.updateConfig).toHaveBeenCalledWith(defaultConfig());

		await writeFile(file, "version: 2\n", "utf8");
		const connect = vi.fn(async () => client);
		await expect(runCli(["config", "apply", file], "unused", { connect })).rejects.toThrow(
			"Invalid VoxSpeech configuration",
		);
		expect(connect).not.toHaveBeenCalled();
	});

	it("resolves config path locally without connecting to the daemon", async () => {
		let text = "";
		const connect = vi.fn();

		expect(
			await runCli(["config", "path"], "unused", {
				connect,
				output: capture((value) => (text += value)),
			}),
		).toBe(0);
		expect(JSON.parse(text)).toMatchObject({
			path: expect.stringMatching(/voxspeech\/config\.yaml$/),
		});
		expect(connect).not.toHaveBeenCalled();
	});

	it("uses Commander errors without connecting or exiting the process", async () => {
		const connect = vi.fn();
		await expect(
			runCli(["model", "install", "model-id", "--connections", "0"], "unused", {
				connect,
				error: capture(() => undefined),
			}),
		).rejects.toMatchObject({ code: "commander.invalidArgument" });
		expect(connect).not.toHaveBeenCalled();
	});
});

async function createEnvironment(): Promise<{ directory: string; socketPath: string }> {
	const directory = await mkdtemp(path.join(tmpdir(), "voxspeech-cli-test-"));
	directories.push(directory);
	return { directory, socketPath: path.join(directory, "daemon.sock") };
}

function capture(write: (value: string) => void): Writable {
	return new Writable({
		write(chunk, _encoding, callback) {
			write(chunk.toString());
			callback();
		},
	});
}

function createClient(
	overrides: Record<string, unknown>,
): DaemonRpcClient & Record<string, ReturnType<typeof vi.fn>> {
	return {
		close: vi.fn(),
		cloneVoice: vi.fn(),
		getConfig: vi.fn(async () => defaultConfig()),
		installModel: vi.fn(),
		listModels: vi.fn(),
		listVoices: vi.fn(),
		removeModel: vi.fn(),
		removeVoice: vi.fn(),
		showVoice: vi.fn(),
		status: vi.fn(),
		synthesize: vi.fn(),
		updateConfig: vi.fn(),
		useModel: vi.fn(),
		useVoice: vi.fn(),
		validateConfig: vi.fn(async () => ({ errors: [], valid: true })),
		verifyModel: vi.fn(),
		...overrides,
	} as unknown as DaemonRpcClient & Record<string, ReturnType<typeof vi.fn>>;
}

function defaultConfig() {
	return {
		api: { enabled: true, host: "127.0.0.1", port: 8080 },
		audio: { format: "wav" as const },
		download: { connections: null, hubUrl: null, proxy: null },
		engine: { backend: "auto" as const, idleTimeout: "10m", maxBatch: 1 },
		model: { default: "qwen3-tts-1.7b-base-q4_k_m" },
		version: 1 as const,
		voice: { default: null },
	};
}

function configYaml(): string {
	return `version: 1
engine:
  backend: auto
  idleTimeout: 10m
  maxBatch: 1
model:
  default: qwen3-tts-1.7b-base-q4_k_m
voice:
  default: null
download:
  hubUrl: null
  proxy: null
  connections: null
api:
  enabled: true
  host: 127.0.0.1
  port: 8080
audio:
  format: wav
`;
}
