export interface ModelFile {
	readonly name: string;
	readonly size: number;
	readonly sha256?: string;
}

export interface ModelManifest {
	readonly repository: string;
	readonly revision: string;
	readonly files: readonly ModelFile[];
}

export interface RepositoryListingOptions {
	readonly hubUrl?: string;
	readonly proxy?: string;
	readonly signal?: AbortSignal;
}

export interface DownloadProgress {
	readonly file: string;
	readonly bytes: number;
	readonly size: number;
	readonly percentage: number;
	readonly bytesPerSecond: number;
}

export interface DownloadOptions {
	readonly outputDir: string;
	readonly hubUrl?: string;
	readonly proxy?: string;
	readonly connections?: number;
	readonly signal?: AbortSignal;
	readonly onProgress?: (progress: DownloadProgress) => void;
}

export type VerificationMode = "sha256" | "size";

export interface DownloadResult {
	readonly path: string;
	readonly url: string;
	readonly size: number;
	readonly sha256?: string;
	readonly verification: VerificationMode;
	readonly downloaded: boolean;
	readonly resumed: boolean;
}
