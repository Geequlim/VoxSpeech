import { randomUUID } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";

import { DownloadLockedError } from "./errors.ts";

interface LockOwner {
	readonly pid: number;
	readonly token: string;
}

const MALFORMED_LOCK_STALE_MS = 5 * 60 * 1_000;

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === code;
}

async function readOwner(path: string): Promise<LockOwner | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (
			typeof value === "object" &&
			value !== null &&
			"pid" in value &&
			Number.isSafeInteger(value.pid) &&
			(value.pid as number) > 0 &&
			"token" in value &&
			typeof value.token === "string"
		) {
			return { pid: value.pid as number, token: value.token };
		}
	} catch (error) {
		if (!isErrno(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
	}
	return undefined;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isErrno(error, "EPERM");
	}
}

async function removeStaleLock(path: string): Promise<boolean> {
	const owner = await readOwner(path);
	if (owner) {
		if (isProcessAlive(owner.pid)) return false;
	} else {
		try {
			const info = await stat(path);
			if (Date.now() - info.mtimeMs < MALFORMED_LOCK_STALE_MS) return false;
		} catch (error) {
			if (isErrno(error, "ENOENT")) return true;
			throw error;
		}
	}

	try {
		await unlink(path);
		return true;
	} catch (error) {
		if (isErrno(error, "ENOENT")) return true;
		throw error;
	}
}

export async function acquireDownloadLock(path: string): Promise<() => Promise<void>> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const token = randomUUID();
		try {
			const handle = await open(path, "wx", 0o600);
			try {
				await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
				await handle.sync();
			} catch (error) {
				try {
					await unlink(path);
				} catch (unlinkError) {
					if (!isErrno(unlinkError, "ENOENT")) throw unlinkError;
				}
				throw error;
			} finally {
				await handle.close();
			}

			return async () => {
				const owner = await readOwner(path);
				if (owner?.token !== token) return;
				try {
					await unlink(path);
				} catch (error) {
					if (!isErrno(error, "ENOENT")) throw error;
				}
			};
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
			if (attempt === 0 && (await removeStaleLock(path))) continue;
			throw new DownloadLockedError(`Another process is downloading ${path}`, {
				cause: error,
			});
		}
	}

	throw new DownloadLockedError(`Another process is downloading ${path}`);
}
