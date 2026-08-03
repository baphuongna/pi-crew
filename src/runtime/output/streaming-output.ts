import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest } from "../../state/types.ts";
import { isSafePathId } from "../../utils/safe-paths.ts";

export interface StreamingOutputHandle {
	write(text: string): void;
	close(): void;
	getPath(): string;
}

export function createStreamingOutput(manifest: TeamRunManifest, taskId: string): StreamingOutputHandle {
	if (!isSafePathId(taskId)) throw new Error(`Invalid taskId: ${taskId}`);
	const outputDir = path.join(manifest.artifactsRoot, "streaming");
	fs.mkdirSync(outputDir, { recursive: true });
	const outputPath = path.join(outputDir, `${taskId}.md`);
	let buffer = "";
	let closed = false;

	return {
		write(text: string) {
			if (closed) return;
			buffer += text;
			if (buffer.length > 4096) {
				fs.appendFileSync(outputPath, buffer, "utf-8");
				buffer = "";
			}
		},
		close() {
			if (closed) return;
			closed = true;
			if (buffer) {
				fs.appendFileSync(outputPath, buffer, "utf-8");
				buffer = "";
			}
		},
		getPath: () => outputPath,
	};
}

export function readStreamingOutput(manifest: TeamRunManifest, taskId: string): string {
	if (!isSafePathId(taskId)) return "";
	const outputPath = path.join(manifest.artifactsRoot, "streaming", `${taskId}.md`);
	if (!fs.existsSync(outputPath)) return "";
	try {
		return fs.readFileSync(outputPath, "utf-8");
	} catch {
		return "";
	}
}
