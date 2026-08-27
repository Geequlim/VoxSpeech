const DEFAULT_HUB_URL = "https://huggingface.co";

function encodePath(value: string, label: string): string {
	const segments = value.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
		throw new TypeError(`${label} must be a non-empty relative path without dot segments`);
	}
	return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

export function resolveHubUrl(hubUrl?: string): string {
	const value = hubUrl ?? process.env.HF_ENDPOINT ?? DEFAULT_HUB_URL;
	const parsed = new URL(value);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new TypeError("Hugging Face endpoint must use HTTP or HTTPS");
	}
	parsed.search = "";
	parsed.hash = "";
	return parsed.href.replace(/\/$/, "");
}

export function huggingFaceFileUrl(
	repository: string,
	revision: string,
	fileName: string,
	hubUrl?: string,
): string {
	const base = resolveHubUrl(hubUrl);
	const encodedRepository = encodePath(repository, "repository");
	const encodedRevision = encodeURIComponent(revision);
	if (!revision || revision === "." || revision === "..") {
		throw new TypeError("revision must not be empty or a dot segment");
	}
	const encodedFileName = encodePath(fileName, "file name");
	return `${base}/${encodedRepository}/resolve/${encodedRevision}/${encodedFileName}`;
}
