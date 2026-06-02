import * as fs from "node:fs";
import { redactJsonLine } from "../utils/redaction.ts";
import { logInternalError } from "../utils/internal-error.ts";

export interface DrainableSource {
	pause(): void;
	resume(): void;
}

export interface JsonlWriteStream {
	write(chunk: string): boolean;
	once(event: "drain", listener: () => void): JsonlWriteStream;
	end(callback?: () => void): void;
}

const DEFAULT_MAX_JSONL_BYTES = 50 * 1024 * 1024;
// FIX (Round 21, per-line cap): A single huge line could exhaust memory during
// redactJsonLine if an upstream caller constructs an enormous string. Cap each
// line at 1MB by default — large enough for any legitimate event payload, small
// enough to prevent memory blow-up. Mirrors the upstream oh-my-pi pattern of
// bounding chunk boundaries in Bun.file().writer().
const DEFAULT_MAX_LINE_BYTES = 1 * 1024 * 1024;

export interface JsonlWriterDeps {
	createWriteStream?: (filePath: string) => JsonlWriteStream;
	maxBytes?: number;
	maxLineBytes?: number;
}

export interface JsonlWriter {
	writeLine(line: string): void;
	close(): Promise<void>;
}

export function createJsonlWriter(filePath: string | undefined, source: DrainableSource, deps: JsonlWriterDeps = {}): JsonlWriter {
	if (!filePath) {
		return {
			writeLine() {},
			async close() {},
		};
	}

	const createWriteStream = deps.createWriteStream ?? ((targetPath: string) => fs.createWriteStream(targetPath, { flags: "a" }));
	let stream: JsonlWriteStream | undefined;
	try {
		stream = createWriteStream(filePath);
	} catch {
		return {
			writeLine() {},
			async close() {},
		};
	}

	let backpressured = false;
	let closed = false;
	let bytesWritten = 0;
	let linesDroppedForSize = 0;
	const maxBytes = deps.maxBytes ?? DEFAULT_MAX_JSONL_BYTES;
	const maxLineBytes = deps.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;

	return {
		writeLine(line: string) {
			if (!stream || closed || !line.trim()) return;
			const safeLine = redactJsonLine(line);
			const chunk = `${safeLine}\n`;
			const chunkBytes = Buffer.byteLength(chunk, "utf-8");
			// FIX (Round 21, per-line cap): Drop oversize lines. Without this, a
			// single huge payload (e.g. a 100MB base64-encoded transcript) would
			// be buffered in memory by redactJsonLine AND queued in the write
			// stream. We log the drop so silent loss is visible.
			if (chunkBytes > maxLineBytes) {
				linesDroppedForSize++;
				if (linesDroppedForSize === 1 || linesDroppedForSize % 100 === 0) {
					logInternalError(
						"jsonl-writer.lineTooLarge",
						new Error(`line size ${chunkBytes} exceeds maxLineBytes ${maxLineBytes}`),
						`file=${filePath} dropped=${linesDroppedForSize}`,
					);
				}
				return;
			}
			if (bytesWritten + chunkBytes > maxBytes) return;
			try {
				const ok = stream.write(chunk);
				bytesWritten += chunkBytes;
				if (!ok && !backpressured) {
					backpressured = true;
					source.pause();
					stream.once("drain", () => {
						backpressured = false;
						if (!closed) source.resume();
					});
				}
			} catch (writeError) {
				// Log the error — silently dropping events is dangerous.
				logInternalError("jsonl-writer.write", writeError, `file=${filePath}`);
			}
		},
		async close() {
			if (!stream || closed) return;
			closed = true;
			const current = stream;
			stream = undefined;
			await new Promise<void>((resolve) => current.end(() => resolve()));
		},
	};
}
