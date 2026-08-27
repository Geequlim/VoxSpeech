import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";

import { createProxyAgent } from "./proxy.ts";
import { DownloadAbortedError, ModelDownloadError } from "./errors.ts";
import { REDIRECT_STATUSES } from "./redirect.ts";
import { resolveHubUrl } from "./url.ts";
import type { ModelFile, RepositoryListingOptions } from "./types.ts";
import type { ProxyAgent } from "proxy-agent";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const SHA256_PATTERN = /^[a-f\d]{64}$/i;

export interface RepositoryId {
	readonly owner: string;
	readonly name: string;
}

interface TreeEntry {
	readonly type?: unknown;
	readonly path?: unknown;
	readonly size?: unknown;
	readonly lfs?: { readonly oid?: unknown } | null;
}

interface JsonResponse {
	readonly status: number;
	readonly body: string;
	readonly headers: Record<string, string | string[] | undefined>;
}

export function parseRepositoryId(repository: string): RepositoryId {
	const segments = repository.split("/");
	if (segments.length !== 2) {
		throw new TypeError(`repository must look like "owner/name", got: ${repository}`);
	}
	for (const segment of segments) {
		if (!segment || segment === "." || segment === "..") {
			throw new TypeError(`repository must look like "owner/name", got: ${repository}`);
		}
	}
	return { owner: segments[0], name: segments[1] };
}

function nextLink(headers: JsonResponse["headers"]): string | undefined {
	const values = headers.link;
	const link = Array.isArray(values) ? values.join(", ") : values;
	const match = /<([^>]+)>;\s*rel="next"/.exec(link ?? "");
	return match?.[1];
}

function requestJson(url: string, agent: ProxyAgent, signal?: AbortSignal): Promise<JsonResponse> {
	return new Promise<JsonResponse>((resolvePromise, rejectPromise) => {
		if (signal?.aborted) {
			rejectPromise(new DownloadAbortedError("Repository listing aborted"));
			return;
		}
		const parsed = new URL(url);
		const get = parsed.protocol === "http:" ? httpGet : httpsGet;
		const request = get(
			parsed,
			{ agent, headers: { accept: "application/json" }, signal, timeout: REQUEST_TIMEOUT_MS },
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => {
					signal?.removeEventListener("abort", abort);
					resolvePromise({
						status: response.statusCode ?? 0,
						body: Buffer.concat(chunks).toString("utf8"),
						headers: response.headers,
					});
				});
			},
		);
		const abort = () => request.destroy();
		signal?.addEventListener("abort", abort, { once: true });
		request.on("error", (error) => {
			signal?.removeEventListener("abort", abort);
			if (signal?.aborted) rejectPromise(new DownloadAbortedError("Repository listing aborted"));
			else
				rejectPromise(new ModelDownloadError(`Hub API request failed: ${url}`, { cause: error }));
		});
		request.on("timeout", () => request.destroy(new Error(`Hub API request timed out: ${url}`)));
	});
}

// Mirrors redirect tree requests (e.g. hf-mirror.com answers with 308).
async function getJson(
	url: string,
	agent: ProxyAgent,
	signal?: AbortSignal,
	redirects = 0,
): Promise<JsonResponse> {
	if (redirects > MAX_REDIRECTS) {
		throw new ModelDownloadError(`Hub API redirected too many times: ${url}`);
	}
	const response = await requestJson(url, agent, signal);
	if (!REDIRECT_STATUSES.has(response.status)) return response;
	const location = Array.isArray(response.headers.location)
		? response.headers.location[0]
		: response.headers.location;
	if (!location) throw new ModelDownloadError(`Hub API redirect without location: ${url}`);
	return getJson(new URL(location, url).href, agent, signal, redirects + 1);
}

function toModelFiles(body: string, source: string): ModelFile[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch (error) {
		throw new ModelDownloadError(`Hub API returned invalid JSON: ${source}`, { cause: error });
	}
	if (!Array.isArray(parsed)) {
		throw new ModelDownloadError(`Hub API returned an unexpected tree payload: ${source}`);
	}

	const files: ModelFile[] = [];
	for (const entry of parsed as TreeEntry[]) {
		if (entry?.type !== "file" || typeof entry.path !== "string") continue;
		if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) {
			throw new ModelDownloadError(`Hub API returned an invalid size for ${entry.path}`);
		}
		const lfsOid = typeof entry.lfs?.oid === "string" ? entry.lfs.oid : undefined;
		files.push({
			name: entry.path,
			size: entry.size,
			sha256: lfsOid && SHA256_PATTERN.test(lfsOid) ? lfsOid : undefined,
		});
	}
	return files;
}

function assertStatus(status: number, repository: string, revision: string): void {
	if (status === 200) return;
	if (status === 401 || status === 403) {
		throw new ModelDownloadError(`Repository is gated or private: ${repository}`);
	}
	if (status === 404) {
		throw new ModelDownloadError(`Repository or revision not found: ${repository}@${revision}`);
	}
	throw new ModelDownloadError(`Hub API request failed with status ${status}`);
}

export async function listRepositoryFiles(
	repository: string,
	revision = "main",
	options: RepositoryListingOptions = {},
): Promise<ModelFile[]> {
	const { owner, name } = parseRepositoryId(repository);
	const base = resolveHubUrl(options.hubUrl);
	const agent = createProxyAgent(options.proxy);
	const files: ModelFile[] = [];
	let url: string | undefined =
		`${base}/api/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` +
		`/tree/${encodeURIComponent(revision)}?recursive=true`;

	try {
		while (url) {
			const response = await getJson(url, agent, options.signal);
			assertStatus(response.status, repository, revision);
			files.push(...toModelFiles(response.body, url));
			url = nextLink(response.headers);
		}
		return files;
	} finally {
		agent.destroy();
	}
}
