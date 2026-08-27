import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CACHE_DIRECTORY = path.join(REPOSITORY_ROOT, ".cache/voxspeech");
export const MODEL_DIRECTORY = path.join(CACHE_DIRECTORY, "models");
export const NATIVE_DIRECTORY = path.join(CACHE_DIRECTORY, "native");
export const BACKENDS = ["cpu", "cuda", "vulkan"] as const;
export const MODELS = {
	"0.6b": "qwen-talker-0.6b-base-Q8_0.gguf",
	"1.7b": "qwen-talker-1.7b-base-Q4_K_M.gguf",
} as const;

export type Backend = (typeof BACKENDS)[number];
export type Model = keyof typeof MODELS;

export interface NativeAssets {
	readonly codec: string;
	readonly engine: string;
	readonly talker: string;
}

export async function resolveNativeAssets(model: Model, backend: Backend): Promise<NativeAssets> {
	const engine = process.env.VOXSPEECH_NATIVE_ENGINE ?? nativeEnginePath(backend);
	const talker = process.env.VOXSPEECH_NATIVE_TALKER ?? path.join(MODEL_DIRECTORY, MODELS[model]);
	const codec =
		process.env.VOXSPEECH_NATIVE_CODEC ??
		path.join(MODEL_DIRECTORY, "qwen-tokenizer-12hz-Q4_K_M.gguf");
	if (!process.env.VOXSPEECH_NATIVE_ENGINE && !(await fileExists(engine)))
		await buildEngine(backend);
	await requireFiles([
		[engine, `native ${backend} engine; automatic build did not produce the executable`],
		[talker, `${model} talker`],
		[codec, "tokenizer"],
	]);
	return { codec, engine, talker };
}

export function nativeEnginePath(backend: Backend): string {
	return path.join(NATIVE_DIRECTORY, backend, "voxspeech-engine", "voxspeech-engine");
}

export async function buildNativeBackends(backends: readonly Backend[]): Promise<void> {
	for (const backend of backends) await buildEngine(backend);
}

export async function requireFiles(files: ReadonlyArray<readonly [string, string]>): Promise<void> {
	for (const [file, label] of files) {
		if (await fileExists(file)) continue;
		const preparation = label.includes("engine")
			? "Check the CMake error above, or set VOXSPEECH_NATIVE_ENGINE to a compatible executable."
			: 'Run "yarn tiny native/models" first.';
		throw new Error(`Missing ${label}: ${file}\n${preparation}`);
	}
}

async function buildEngine(backend: Backend): Promise<void> {
	const source = path.join(REPOSITORY_ROOT, "native/third_party/qwentts.cpp");
	const build = path.join(NATIVE_DIRECTORY, backend);
	const enabled = (candidate: Backend) => (candidate === backend ? "ON" : "OFF");
	const configure = [
		"-S",
		source,
		"-B",
		build,
		"-G",
		"Ninja",
		"-DCMAKE_BUILD_TYPE=Release",
		`-DCMAKE_PROJECT_INCLUDE=${path.join(REPOSITORY_ROOT, "native/engine/qwentts-inject.cmake")}`,
		"-DVOXSPEECH_ENGINE_ENABLE_QWENTTS=ON",
		"-DVOXSPEECH_ENGINE_BUILD_TESTS=OFF",
		`-DVOXSPEECH_ENGINE_BACKEND=${backend}`,
		`-DGGML_CUDA=${enabled("cuda")}`,
		`-DGGML_VULKAN=${enabled("vulkan")}`,
		"-DGGML_STATIC=ON",
		"-DBUILD_SHARED_LIBS=OFF",
	];
	if (backend === "cpu") configure.push("-DGGML_NATIVE=ON");
	if (backend === "cuda") {
		configure.push("-DCMAKE_CUDA_ARCHITECTURES=native");
		if (await fileExists("/opt/cuda/bin/nvcc"))
			configure.push("-DCMAKE_CUDA_COMPILER=/opt/cuda/bin/nvcc");
		if (await fileExists("/usr/bin/g++-15"))
			configure.push("-DCMAKE_CUDA_HOST_COMPILER=/usr/bin/g++-15");
	}
	process.stdout.write(`Building the ${backend} engine in ${build}\n`);
	await run("cmake", configure);
	await run("cmake", [
		"--build",
		build,
		"--target",
		"voxspeech-engine",
		"--parallel",
		String(availableParallelism()),
	]);
}

async function run(command: string, arguments_: readonly string[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, [...arguments_], { cwd: REPOSITORY_ROOT, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} failed (${signal ?? code ?? "unknown"})`));
		});
	});
}

async function fileExists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}
