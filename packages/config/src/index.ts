import path from "node:path";

export interface VoxSpeechPaths {
	readonly cacheDirectory: string;
	readonly configFile: string;
	readonly dataDirectory: string;
	readonly socketFile: string;
}

export function resolveVoxSpeechPaths(
	environment: NodeJS.ProcessEnv,
	userHome: string,
	userId: number,
): VoxSpeechPaths {
	const configHome = environment.XDG_CONFIG_HOME || path.join(userHome, ".config");
	const dataHome = environment.XDG_DATA_HOME || path.join(userHome, ".local", "share");
	const cacheHome = environment.XDG_CACHE_HOME || path.join(userHome, ".cache");
	const runtimeDirectory = environment.XDG_RUNTIME_DIR || `/run/user/${userId}`;

	return {
		cacheDirectory: path.join(cacheHome, "voxspeech"),
		configFile: path.join(configHome, "voxspeech", "config.yaml"),
		dataDirectory: path.join(dataHome, "voxspeech"),
		socketFile: path.join(runtimeDirectory, "voxspeech", "daemon.sock"),
	};
}
