import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";

import { DownloadAbortedError, ModelDownloadError } from "./errors.ts";
import type { ProxyAgent } from "proxy-agent";

const REQUEST_TIMEOUT_MS = 30_000;

export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// EasyDl fails to follow the signed resolve-cache URLs the Hub emits (their
// query strings contain encoded slashes), so resolve redirects up front with
// plain HEAD hops and hand EasyDl a redirect-free URL.
export async function followRedirects(
	url: string,
	agent: ProxyAgent,
	signal?: AbortSignal,
	hops = 0,
): Promise<string> {
	if (hops > 5) throw new ModelDownloadError(`Redirected too many times: ${url}`);
	if (signal?.aborted) throw new DownloadAbortedError("Redirect resolution aborted");

	const parsed = new URL(url);
	const get = parsed.protocol === "http:" ? httpGet : httpsGet;
	const response = await new Promise<{ status: number; location?: string }>(
		(resolvePromise, rejectPromise) => {
			const request = get(
				parsed,
				{ agent, method: "HEAD", signal, timeout: REQUEST_TIMEOUT_MS },
				(response_) => {
					response_.resume();
					response_.on("end", () =>
						resolvePromise({
							status: response_.statusCode ?? 0,
							location: Array.isArray(response_.headers.location)
								? response_.headers.location[0]
								: response_.headers.location,
						}),
					);
				},
			);
			const abort = () => request.destroy();
			signal?.addEventListener("abort", abort, { once: true });
			request.on("error", (error) => {
				signal?.removeEventListener("abort", abort);
				if (signal?.aborted) rejectPromise(new DownloadAbortedError("Redirect resolution aborted"));
				else rejectPromise(new ModelDownloadError(`Request failed: ${url}`, { cause: error }));
			});
			request.on("timeout", () => request.destroy(new Error(`Request timed out: ${url}`)));
		},
	);

	if (response.status >= 400) {
		throw new ModelDownloadError(`Endpoint answered ${response.status} resolving ${url}`);
	}
	if (!REDIRECT_STATUSES.has(response.status) || !response.location) return url;
	return followRedirects(new URL(response.location, url).href, agent, signal, hops + 1);
}
