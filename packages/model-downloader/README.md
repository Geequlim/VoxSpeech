# @tinyaxis/model-downloader

Resumable, integrity-verified Hugging Face model downloader with a CLI and an API.

- Parallel HTTP Range downloads with automatic connection count (`4-16`, based on CPU).
- Cross-process file locks and cross-restart resume of completed chunks.
- SHA-256 + size verification for LFS files, size verification for plain files.
- Atomic install: files land at their final path only after verification.
- Hugging Face mirrors (`HF_ENDPOINT` / `--hub-url`) and HTTP(S) proxies.

Requires Node.js >= 24.

## CLI

```bash
npm install -g @tinyaxis/model-downloader

# Download a repository to ./<owner>/<name>
model-downloader Qwen/Qwen3-Talker-1.7B

# Pin a revision, filter files, and choose a destination
model-downloader Qwen/Qwen3-Talker-1.7B \
  --revision main \
  --include "*.gguf" \
  --exclude "original/*" \
  --output-dir ./models/talker

# Use a mirror endpoint and an explicit proxy
HF_ENDPOINT=https://hf-mirror.com model-downloader Qwen/Qwen3-Talker-1.7B
model-downloader Qwen/Qwen3-Talker-1.7B --proxy http://127.0.0.1:7890
```

On a TTY the CLI renders an aggregate progress bar with speed and ETA; without a
TTY it prints one line per completed file. `--quiet` disables progress output.
Exit codes: `0` success, `1` download or verification failure, `2` usage error,
`130` interrupted (rerun the same command to resume).

## API

```ts
import {
	downloadHuggingFaceFile,
	downloadManifest,
	listRepositoryFiles,
} from "@tinyaxis/model-downloader";

// Discover files from a repository (LFS files carry their SHA-256)
const files = await listRepositoryFiles("Qwen/Qwen3-Talker-1.7B", "main");

// Download one file
await downloadHuggingFaceFile(
	{ repository: "Qwen/Qwen3-Talker-1.7B", revision: "main" },
	files[0],
	{ outputDir: "./Qwen/Qwen3-Talker-1.7B", onProgress: console.log },
);

// Or download a pinned manifest with exact sizes and checksums
await downloadManifest(
	{
		repository: "Qwen/Qwen3-Talker-1.7B",
		revision: "<commit sha>",
		files: [{ name: "model.gguf", size: 1_234_567, sha256: "<64 hex chars>" }],
	},
	{ outputDir: "./models" },
);
```

Every `DownloadResult` reports how the file was verified:

- `verification: "sha256"` — LFS-backed files with a known SHA-256 (weights, etc.).
- `verification: "size"` — plain Git files where the Hub only exposes the size.

Both the downloader and the CLI abort cleanly on `SIGINT`/`SIGTERM`, keep
completed chunks in a `.download` staging file, and verify before an atomic
rename, so rerunning a command resumes instead of restarting.

## Environment

| Variable                                   | Effect                                         |
| ------------------------------------------ | ---------------------------------------------- |
| `HF_ENDPOINT`                              | Default Hugging Face endpoint (mirror support) |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | Default proxy                                  |
| `NO_PROXY`                                 | Hosts that bypass the proxy                    |

`--hub-url` and `--proxy` (or the equivalent API options) override the
environment for a single run.

## License

Apache-2.0
