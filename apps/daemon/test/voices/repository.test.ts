import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	VoiceManager,
	VoiceRepository,
	type BaseVoiceLease,
	type BaseVoiceProvider,
	type VoiceConfiguration,
	type VoiceExtractor,
} from "../../src/voices/index.js";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("VoiceRepository", () => {
	it("commits a complete private profile that remains available after restart", async () => {
		const root = await temporaryDirectory();
		const repository = createRepository(root);

		const profile = await repository.clone(cloneRequest(), createExtractor());

		expect(profile.metadata).toMatchObject({
			id: "assistant",
			transcript: "这是参考音频",
			modelId: "base-model",
			version: 1,
		});
		expect(path.basename(profile.directory)).toMatch(/^voice-[a-f0-9]{64}$/);
		expect(profile.reference).toEqual({
			speakerPath: path.join(profile.directory, "speaker.spk"),
			codesPath: path.join(profile.directory, "reference.rvq"),
			text: "这是参考音频",
		});
		expect(await readFile(path.join(profile.directory, "voice.yaml"), "utf8")).toContain(
			"modelId: base-model",
		);
		expect((await stat(profile.reference.speakerPath)).mode & 0o777).toBe(0o600);
		expect((await stat(profile.reference.codesPath)).mode & 0o777).toBe(0o600);

		const restarted = createRepository(root);
		expect(await restarted.list()).toHaveLength(1);
		expect((await restarted.resolve("assistant")).reference).toEqual(profile.reference);
	});

	it("stores arbitrary user-entered names without interpreting them as paths", async () => {
		const root = await temporaryDirectory();
		const repository = createRepository(root);
		const request = { ...cloneRequest(), id: " ../甜妹 助理 / Dr. 小鱼 👩‍💻\n" };

		const profile = await repository.clone(request, createExtractor());

		expect((await createRepository(root).resolve(request.id)).metadata.id).toBe(request.id);
		expect(profile.directory.startsWith(path.join(root, "data", "voices"))).toBe(true);
		expect(path.basename(profile.directory)).toMatch(/^voice-[a-f0-9]{64}$/);
	});

	it("hides corrupt and staging directories from list and show", async () => {
		const root = await temporaryDirectory();
		const voices = path.join(root, "data", "voices");
		await mkdir(path.join(voices, "broken"), { recursive: true });
		await writeFile(path.join(voices, "broken", "voice.yaml"), "version: 1\nid: broken\n");
		await mkdir(path.join(voices, ".assistant.test.staging"));
		const manager = createManager(createRepository(root));

		expect(await manager.list()).toEqual([]);
		expect(await manager.show("broken")).toBeUndefined();
	});

	it("replaces a corrupt final profile on clone", async () => {
		const root = await temporaryDirectory();
		const voices = path.join(root, "data", "voices");
		await mkdir(path.join(voices, "assistant"), { recursive: true });
		await writeFile(path.join(voices, "assistant", "voice.yaml"), "broken");
		const repository = createRepository(root);

		await repository.clone(cloneRequest(), createExtractor());
		expect(await repository.resolve("assistant")).toMatchObject({
			metadata: { id: "assistant", modelId: "base-model" },
		});
	});

	it("does not promote a profile cancelled during extraction", async () => {
		const root = await temporaryDirectory();
		const repository = createRepository(root);
		const controller = new AbortController();
		const extractor: VoiceExtractor = {
			extractVoice: async (params) => {
				controller.abort(new Error("client disconnected"));
				await writeFile(params.speakerOutputPath, "speaker");
				await writeFile(params.codesOutputPath, "codes");
				return { speakerDimension: 2, codebookCount: 3, frameCount: 4 };
			},
		};

		await expect(
			repository.clone(cloneRequest(), extractor, { signal: controller.signal }),
		).rejects.toThrow("client disconnected");
		expect(await repository.list()).toEqual([]);
	});

	it("removes staging when extraction fails or produces invalid output", async () => {
		const root = await temporaryDirectory();
		const repository = createRepository(root);
		const failing: VoiceExtractor = {
			extractVoice: async () => {
				throw new Error("engine extraction failed");
			},
		};

		await expect(repository.clone(cloneRequest(), failing)).rejects.toThrow(
			"engine extraction failed",
		);
		expect(await repository.list()).toEqual([]);
		expect(
			await import("node:fs/promises").then(({ readdir }) =>
				readdir(path.join(root, "data", "voices")),
			),
		).toEqual([]);

		const invalid: VoiceExtractor = {
			extractVoice: async ({ speakerOutputPath }) => {
				await writeFile(speakerOutputPath, "speaker");
				return { speakerDimension: 2, codebookCount: 3, frameCount: 4 };
			},
		};
		await expect(repository.clone({ ...cloneRequest(), id: "invalid" }, invalid)).rejects.toThrow(
			/no such file|non-empty regular file/,
		);
		expect(await repository.list()).toEqual([]);
	});

	it("only rejects an empty ID that cannot identify a profile", async () => {
		const repository = createRepository(await temporaryDirectory());
		expect(() => repository.clone({ ...cloneRequest(), id: "" }, createExtractor())).toThrow(
			"Invalid voice ID",
		);
	});
});

describe("VoiceManager", () => {
	it("uses the configured default and resolves it to reference paths and transcript", async () => {
		const root = await temporaryDirectory();
		let defaultVoice: string | null = null;
		const repository = createRepository(root);
		const manager = createManager(repository, {
			getDefaultVoice: async () => defaultVoice,
			setDefaultVoice: async (id) => {
				defaultVoice = id;
			},
		});

		expect(await manager.acquireReference()).toBeNull();
		await manager.clone({
			id: "assistant",
			audioPath: "/tmp/reference.wav",
			transcript: "这是参考音频",
		});
		await manager.use("assistant");
		expect(await manager.list()).toEqual([
			{ id: "assistant", transcript: "这是参考音频", active: true },
		]);

		const lease = await manager.acquireReference();
		expect(lease?.reference).toEqual((await repository.resolve("assistant")).reference);
		lease?.release();
	});

	it("rejects deleting active or leased profiles and releases idempotently", async () => {
		const root = await temporaryDirectory();
		let defaultVoice: string | null = null;
		const manager = createManager(createRepository(root), {
			getDefaultVoice: async () => defaultVoice,
			setDefaultVoice: async (id) => {
				defaultVoice = id;
			},
		});
		await manager.clone({
			id: "assistant",
			audioPath: "/tmp/reference.wav",
			transcript: "这是参考音频",
		});
		await manager.use("assistant");
		await expect(manager.remove("assistant")).rejects.toThrow("currently in use");

		defaultVoice = null;
		const lease = await manager.acquireReference("assistant");
		await expect(manager.remove("assistant")).rejects.toThrow("currently in use");
		lease?.release();
		lease?.release();
		await manager.remove("assistant");
		expect(await manager.show("assistant")).toBeUndefined();
	});

	it("rejects new reference leases after removal begins", async () => {
		const root = await temporaryDirectory();
		const repository = createRepository(root);
		await repository.clone(cloneRequest(), createExtractor());
		let continueRemoval: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			continueRemoval = resolve;
		});
		const remove = vi.spyOn(repository, "remove").mockImplementation(async () => {
			await gate;
		});
		const manager = createManager(repository);

		const removal = manager.remove("assistant");
		await waitFor(() => remove.mock.calls.length === 1);
		await expect(manager.acquireReference("assistant")).rejects.toThrow("being removed");
		continueRemoval?.();
		await removal;
	});

	it("serializes same-ID upserts and keeps the latest user data", async () => {
		const root = await temporaryDirectory();
		let active = 0;
		let peak = 0;
		let releases = 0;
		const extractor: VoiceExtractor = {
			extractVoice: async ({ speakerOutputPath, codesOutputPath }) => {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 20));
				await writeFile(speakerOutputPath, "speaker");
				await writeFile(codesOutputPath, "codes");
				active -= 1;
				return { speakerDimension: 2, codebookCount: 3, frameCount: 4 };
			},
		};
		const manager = createManager(createRepository(root), undefined, {
			acquire: async () => ({
				modelId: "base-model",
				extractor,
				release: () => {
					releases += 1;
				},
			}),
		});

		const results = await Promise.allSettled([
			manager.clone({ id: "assistant", audioPath: "/tmp/reference.wav", transcript: "第一条" }),
			manager.clone({ id: "assistant", audioPath: "/tmp/reference.wav", transcript: "第二条" }),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
		expect(peak).toBe(1);
		expect(releases).toBe(2);
		expect((await manager.show("assistant"))?.transcript).toBe("第二条");
	});
});

function createRepository(root: string): VoiceRepository {
	return new VoiceRepository({ dataDirectory: path.join(root, "data") });
}

function createManager(
	repository: VoiceRepository,
	configuration: VoiceConfiguration = {
		getDefaultVoice: async () => null,
		setDefaultVoice: async () => undefined,
	},
	baseProvider: BaseVoiceProvider = {
		acquire: async () => createBaseLease(createExtractor()),
	},
): VoiceManager {
	return new VoiceManager({ repository, configuration, baseProvider });
}

function createBaseLease(extractor: VoiceExtractor): BaseVoiceLease {
	return { modelId: "base-model", extractor, release: () => undefined };
}

function createExtractor(): VoiceExtractor {
	return {
		extractVoice: async ({ speakerOutputPath, codesOutputPath }) => {
			await writeFile(speakerOutputPath, "speaker");
			await writeFile(codesOutputPath, "codes");
			await chmod(speakerOutputPath, 0o644);
			await chmod(codesOutputPath, 0o640);
			return { speakerDimension: 2, codebookCount: 3, frameCount: 4 };
		},
	};
}

function cloneRequest() {
	return {
		id: "assistant",
		audioPath: "/tmp/reference.wav",
		transcript: "这是参考音频",
		modelId: "base-model",
	};
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "voxspeech-voices-"));
	directories.push(directory);
	return directory;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 1));
}
