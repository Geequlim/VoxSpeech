import { beforeEach, describe, expect, it } from "vitest";

import { ModelDownloadError, listRepositoryFiles, parseRepositoryId } from "../src/index.js";
import {
	sha256,
	startForwardProxy,
	startHubServer,
	startRedirectingServer,
	type HubFile,
} from "./servers.js";

beforeEach(() => {
	delete process.env.HF_ENDPOINT;
});

describe("Hub repository listing", () => {
	it("parses repository identifiers", () => {
		expect(parseRepositoryId("org/model")).toEqual({ owner: "org", name: "model" });
		expect(parseRepositoryId("user/model.git")).toEqual({ owner: "user", name: "model.git" });
		expect(() => parseRepositoryId("model")).toThrow(TypeError);
		expect(() => parseRepositoryId("a/b/c")).toThrow(TypeError);
		expect(() => parseRepositoryId("/model")).toThrow(TypeError);
		expect(() => parseRepositoryId("org/")).toThrow(TypeError);
		expect(() => parseRepositoryId("org/..")).toThrow(TypeError);
	});

	it("lists files across paginated tree responses", async () => {
		const weights = Buffer.alloc(32, 1);
		const config = Buffer.from("{}", "utf8");
		const files: HubFile[] = [
			{ path: "model.gguf", data: weights },
			{ path: "config.json", data: config, lfs: false },
		];
		const server = await startHubServer("org/model", files, { pageSize: 1 });
		try {
			const listed = await listRepositoryFiles("org/model", "main", { hubUrl: server.url });
			expect(listed).toEqual([
				{ name: "model.gguf", size: 32, sha256: sha256(weights) },
				{ name: "config.json", size: 2, sha256: undefined },
			]);
			expect(server.apiRequests.length).toBe(2);
			expect(server.apiRequests[0]).toContain("recursive=true");
		} finally {
			await server.close();
		}
	});

	it("follows tree redirects", async () => {
		const files: HubFile[] = [{ path: "model.gguf", data: Buffer.alloc(8, 2) }];
		const origin = await startHubServer("org/model", files);
		const redirect = await startRedirectingServer(origin.url);
		try {
			const listed = await listRepositoryFiles("org/model", "main", { hubUrl: redirect.url });
			expect(listed.map((file) => file.name)).toEqual(["model.gguf"]);
		} finally {
			await Promise.all([origin.close(), redirect.close()]);
		}
	});

	it("reports missing repositories and revisions", async () => {
		const server = await startHubServer("org/model", []);
		try {
			await expect(
				listRepositoryFiles("org/other", "main", { hubUrl: server.url }),
			).rejects.toThrow(ModelDownloadError);
			await expect(
				listRepositoryFiles("org/other", "main", { hubUrl: server.url }),
			).rejects.toThrow(/not found/);
		} finally {
			await server.close();
		}
	});

	it("routes tree requests through the configured proxy", async () => {
		const files: HubFile[] = [{ path: "model.gguf", data: Buffer.alloc(8, 2) }];
		const origin = await startHubServer("org/model", files);
		const proxy = await startForwardProxy();
		try {
			await listRepositoryFiles("org/model", "main", { hubUrl: origin.url, proxy: proxy.url });
			expect(proxy.targets.some((target) => target.includes("/api/models/org/model/tree/"))).toBe(
				true,
			);
		} finally {
			await Promise.all([origin.close(), proxy.close()]);
		}
	});
});
