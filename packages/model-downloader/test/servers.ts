import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RangeServer {
	readonly url: string;
	readonly paths: string[];
	readonly ranges: string[];
	close(): Promise<void>;
}

export interface ForwardProxy {
	readonly url: string;
	readonly targets: string[];
	close(): Promise<void>;
}

export interface HubFile {
	readonly path: string;
	readonly data: Buffer;
	readonly lfs?: boolean;
}

export interface HubServer {
	readonly url: string;
	readonly apiRequests: string[];
	readonly fileRequests: string[];
	close(): Promise<void>;
}

export function sha256(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

export function respondWithRanges(
	data: Buffer,
	request: IncomingMessage,
	response: ServerResponse,
): void {
	response.setHeader("accept-ranges", "bytes");
	if (request.method === "HEAD") {
		response.setHeader("content-length", data.length);
		response.end();
		return;
	}

	const range = request.headers.range;
	const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
	if (!match) {
		response.statusCode = 200;
		response.setHeader("content-length", data.length);
		response.end(data);
		return;
	}

	const start = Number(match[1]);
	const end = Number(match[2]);
	const chunk = data.subarray(start, end + 1);
	response.statusCode = 206;
	response.setHeader("content-length", chunk.length);
	response.setHeader("content-range", `bytes ${start}-${end}/${data.length}`);
	response.end(chunk);
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
	await new Promise<void>((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test server address");
	return `http://127.0.0.1:${address.port}`;
}

export async function startRangeServer(data: Buffer): Promise<RangeServer> {
	const paths: string[] = [];
	const ranges: string[] = [];
	const server = createServer((request, response) => {
		paths.push(request.url ?? "");
		if (request.headers.range) ranges.push(request.headers.range);
		respondWithRanges(data, request, response);
	});
	const url = await listen(server);
	return {
		url,
		get paths() {
			return paths;
		},
		get ranges() {
			return ranges;
		},
		close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
	};
}

export interface FlakyRangeServer {
	readonly url: string;
	setHealthy(value: boolean): void;
	close(): Promise<void>;
}

// Fails the first resolution (HEAD) with 503, then serves normal range data.
export async function startFlakyRangeServer(data: Buffer): Promise<FlakyRangeServer> {
	let healthy = false;
	const server = createServer((request, response) => {
		if (!healthy && request.method === "HEAD") {
			healthy = true;
			response.statusCode = 503;
			response.end();
			return;
		}
		respondWithRanges(data, request, response);
	});
	const url = await listen(server);
	return {
		url,
		setHealthy(value) {
			healthy = value;
		},
		close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
	};
}

export interface ResettableRangeServer extends RangeServer {
	readonly resets: number;
	setResetConnections(value: boolean): void;
}

export async function startResettableRangeServer(data: Buffer): Promise<ResettableRangeServer> {
	const paths: string[] = [];
	const ranges: string[] = [];
	let resetConnections = true;
	let resets = 0;
	const server = createServer((request, response) => {
		paths.push(request.url ?? "");
		if (request.headers.range) ranges.push(request.headers.range);
		if (request.method === "HEAD" || !resetConnections) {
			respondWithRanges(data, request, response);
			return;
		}

		const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
		if (!match) {
			response.destroy();
			return;
		}
		const start = Number(match[1]);
		const end = Number(match[2]);
		const chunk = data.subarray(start, end + 1);
		response.writeHead(206, {
			"accept-ranges": "bytes",
			"content-length": chunk.length,
			"content-range": `bytes ${start}-${end}/${data.length}`,
		});
		response.write(chunk.subarray(0, Math.min(chunk.length, 1_024)));
		resets += 1;
		setImmediate(() => response.destroy());
	});
	const url = await listen(server);
	return {
		url,
		get paths() {
			return paths;
		},
		get ranges() {
			return ranges;
		},
		get resets() {
			return resets;
		},
		setResetConnections(value) {
			resetConnections = value;
		},
		close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
	};
}

export async function startForwardProxy(): Promise<ForwardProxy> {
	const targets: string[] = [];
	const server = createServer((request, response) => {
		const target = new URL(request.url ?? "");
		targets.push(target.href);
		const upstream = httpRequest(
			target,
			{
				headers: { ...request.headers, host: target.host },
				method: request.method,
			},
			(upstreamResponse) => {
				response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
				upstreamResponse.pipe(response);
			},
		);
		upstream.once("error", (error) => response.destroy(error));
		request.pipe(upstream);
	});
	const url = await listen(server);
	return {
		url,
		get targets() {
			return targets;
		},
		close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
	};
}

export async function startHubServer(
	repository: string,
	files: readonly HubFile[],
	options: { readonly revision?: string; readonly pageSize?: number } = {},
): Promise<HubServer> {
	const revision = options.revision ?? "main";
	const pageSize = options.pageSize ?? files.length;
	const apiRequests: string[] = [];
	const fileRequests: string[] = [];
	const byPath = new Map(files.map((file) => [file.path, file.data] as const));
	const treePath = `/api/models/${repository}/tree/${revision}`;
	let baseUrl = "";
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname === treePath) {
			apiRequests.push(`${url.pathname}${url.search}`);
			const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
			const pageFiles = files.slice((page - 1) * pageSize, page * pageSize);
			const entries = pageFiles.map((file) => ({
				type: "file",
				path: file.path,
				size: file.data.length,
				...(file.lfs === false ? {} : { lfs: { oid: sha256(file.data), size: file.data.length } }),
			}));
			if (page === 1) entries.unshift({ type: "directory", path: "assets", size: 0 });
			response.setHeader("content-type", "application/json");
			if (page * pageSize < files.length) {
				response.setHeader(
					"link",
					`<${baseUrl}${treePath}?recursive=true&page=${page + 1}>; rel="next"`,
				);
			}
			response.end(JSON.stringify(entries));
			return;
		}

		const resolvePrefix = `/${repository}/resolve/${revision}/`;
		if (url.pathname.startsWith(resolvePrefix)) {
			const path = decodeURIComponent(url.pathname.slice(resolvePrefix.length));
			const data = byPath.get(path);
			if (!data) {
				response.statusCode = 404;
				response.end();
				return;
			}
			fileRequests.push(path);
			respondWithRanges(data, request, response);
			return;
		}

		response.statusCode = 404;
		response.end();
	});
	const url = await listen(server);
	baseUrl = url;
	return {
		url,
		get apiRequests() {
			return apiRequests;
		},
		get fileRequests() {
			return fileRequests;
		},
		close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
	};
}

export interface RedirectingServer {
	readonly url: string;
	close(): Promise<void>;
}

export async function startRedirectingServer(target: string): Promise<RedirectingServer> {
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		response.statusCode = 308;
		response.setHeader("location", new URL(`${url.pathname}${url.search}`, target).href);
		response.end();
	});
	const url = await listen(server);
	return {
		url,
		close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
	};
}

export function createTempDirectories(): {
	make(): Promise<string>;
	cleanup(): Promise<void>;
} {
	const directories: string[] = [];
	return {
		async make() {
			const directory = await mkdtemp(join(tmpdir(), "model-downloader-"));
			directories.push(directory);
			return directory;
		},
		async cleanup() {
			await Promise.all(
				directories.splice(0).map((directory) => rm(directory, { recursive: true })),
			);
		},
	};
}
