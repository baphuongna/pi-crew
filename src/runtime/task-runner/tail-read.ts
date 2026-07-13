import * as fs from "node:fs";

/**
 * Read the tail of a file, capped at maxBytes.
 * If the file exceeds maxBytes, reads only the last maxBytes and snaps
 * to the nearest newline boundary to avoid partial JSONL lines.
 *
 * Falls back to `fallbackContent` when the file is missing OR empty. The
 * empty-file case matters because `appendTranscript` is fire-and-forget
 * async in the mock path (commit e316a36) — the file is created on disk
 * (existsSync returns true) before the actual write completes, so a
 * subsequent tail-read can observe size=0. Returning "" in that case would
 * silently drop the mock's stdout, breaking downstream parsers that depend
 * on a non-empty transcript (e.g. adaptive-plan JSON extraction in
 * implementation-fanout.test.ts). Falling back to `fallbackContent` keeps
 * the existing fallback semantics: "if the file isn't usable, use what
 * the caller already has."
 */
export function tailReadWithLineSnap(filePath: string, maxBytes: number, fallbackContent: string): string {
	if (!fs.existsSync(filePath)) return fallbackContent;
	const stat = fs.statSync(filePath);
	if (stat.size === 0) return fallbackContent;
	if (stat.size <= maxBytes) return fs.readFileSync(filePath, "utf-8");
	const fd = fs.openSync(filePath, "r");
	try {
		const buf = Buffer.alloc(maxBytes);
		const bytesRead = fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
		const raw = buf.slice(0, bytesRead).toString("utf-8");
		const firstNewline = raw.indexOf("\n");
		return firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
	} finally {
		fs.closeSync(fd);
	}
}
