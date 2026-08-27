import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { PCM_CHANNELS, PCM_SAMPLE_RATE, type AudioFormat } from "@voxspeech/protocol";

export function encodeWav(pcm: Uint8Array): Buffer {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.byteLength, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(PCM_CHANNELS, 22);
	header.writeUInt32LE(PCM_SAMPLE_RATE, 24);
	header.writeUInt32LE(PCM_SAMPLE_RATE * PCM_CHANNELS * 2, 28);
	header.writeUInt16LE(PCM_CHANNELS * 2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.byteLength, 40);
	return Buffer.concat([header, pcm]);
}

export async function playAudio(audio: Uint8Array, format: AudioFormat): Promise<void> {
	const directory = await mkdtemp(path.join(tmpdir(), "voxspeech-play-"));
	const audioPath = path.join(directory, `speech.${format}`);
	try {
		await writeFile(audioPath, audio);
		await new Promise<void>((resolve, reject) => {
			const arguments_ =
				format === "pcm"
					? ["--format=s16", `--rate=${PCM_SAMPLE_RATE}`, `--channels=${PCM_CHANNELS}`, audioPath]
					: [audioPath];
			const child = spawn("pw-play", arguments_, { stdio: ["ignore", "ignore", "inherit"] });
			child.once("error", reject);
			child.once("exit", (code, signal) => {
				if (code === 0) resolve();
				else reject(new Error(`pw-play failed (${signal ?? code ?? "unknown"})`));
			});
		});
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}
