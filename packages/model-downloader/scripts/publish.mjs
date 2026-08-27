#!/usr/bin/env node

// Yarn's `npm publish` applies publishConfig but cannot read the npm auth
// token from ~/.npmrc; npm has the opposite trade-off. This script stages the
// package with publishConfig already applied (the single source of truth) and
// publishes it through npm.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extraArgs = process.argv.slice(2);

const tscCandidates = [
	join(packageRoot, "node_modules", "typescript", "bin", "tsc"),
	join(packageRoot, "..", "..", "node_modules", "typescript", "bin", "tsc"),
];
const tsc = tscCandidates.find((candidate) => existsSync(candidate)) ?? "tsc";
execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
	cwd: packageRoot,
	stdio: "inherit",
});

const raw = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const { publishConfig, scripts: _scripts, devDependencies: _devDependencies, ...rest } = raw;
const { access: _access, ...overrides } = publishConfig;
const manifest = { ...rest, ...overrides };
const stage = await mkdtemp(join(tmpdir(), "model-downloader-publish-"));

try {
	await writeFile(join(stage, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	await cp(join(packageRoot, "dist"), join(stage, "dist"), { recursive: true });
	await cp(join(packageRoot, "README.md"), join(stage, "README.md"));
	await cp(join(packageRoot, "LICENSE"), join(stage, "LICENSE"));
	execFileSync("npm", ["publish", "--access", "public", ...extraArgs], {
		cwd: stage,
		stdio: "inherit",
	});
} finally {
	await rm(stage, { recursive: true, force: true });
}
