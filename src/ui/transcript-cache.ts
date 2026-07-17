import * as fs from "node:fs";

export interface TranscriptCacheEntry {
	path: string;
	mtimeMs: number;
	size: number;
	lines: string[];
	parsedAt: number;
	readCount: number;
	mode: "tail" | "full";
	bytesRead: number;
	truncated: boolean;
}

export interface TranscriptReadOptions {
	maxTailBytes?: number;
	full?: boolean;
}

const TRANSCRIPT_CACHE_TTL_MS = 500;
const DEFAULT_TAIL_BYTES = 256 * 1024;
const MAX_CACHE_SIZE = 100;
const transcriptCache = new Map<string, TranscriptCacheEntry>();

function cacheKey(
	path: string,
	options: Required<Pick<TranscriptReadOptions, "full">> & {
		maxTailBytes: number;
	},
): string {
	return `${path}:${options.full ? "full" : `tail:${options.maxTailBytes}`}`;
}

export function clearTranscriptCache(path?: string): void {
	if (!path) {
		transcriptCache.clear();
		return;
	}
	for (const key of [...transcriptCache.keys()]) if (key === path || key.startsWith(`${path}:`)) transcriptCache.delete(key);
}

export function getTranscriptCacheEntry(path: string, options: TranscriptReadOptions = {}): TranscriptCacheEntry | undefined {
	const normalized = {
		full: options.full === true,
		maxTailBytes: options.maxTailBytes ?? DEFAULT_TAIL_BYTES,
	};
	return transcriptCache.get(cacheKey(path, normalized)) ?? transcriptCache.get(path);
}

function readTranscriptText(
	path: string,
	stat: fs.Stats,
	options: Required<Pick<TranscriptReadOptions, "full">> & {
		maxTailBytes: number;
	},
): { text: string; bytesRead: number; truncated: boolean } {
	if (options.full || stat.size <= options.maxTailBytes) {
		return {
			text: fs.readFileSync(path, "utf-8"),
			bytesRead: stat.size,
			truncated: false,
		};
	}
	const bytesToRead = Math.min(stat.size, options.maxTailBytes);
	const fd = fs.openSync(path, "r");
	try {
		const buffer = Buffer.alloc(bytesToRead);
		fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
		let text = buffer.toString("utf-8");
		const firstNewline = text.search(/\r?\n/);
		if (firstNewline >= 0) text = text.slice(firstNewline + (text[firstNewline] === "\r" && text[firstNewline + 1] === "\n" ? 2 : 1));
		return { text, bytesRead: bytesToRead, truncated: true };
	} finally {
		fs.closeSync(fd);
	}
}

export function readTranscriptLinesCached(
	path: string,
	parse: (text: string) => string[],
	now = Date.now(),
	options: TranscriptReadOptions = {},
): string[] {
	const normalized = {
		full: options.full === true,
		maxTailBytes: Math.max(1024, options.maxTailBytes ?? DEFAULT_TAIL_BYTES),
	};
	const key = cacheKey(path, normalized);
	const previous = transcriptCache.get(key);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(path);
	} catch {
		return previous?.lines ?? [];
	}
	if (previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) {
		if (now - previous.parsedAt >= TRANSCRIPT_CACHE_TTL_MS) previous.parsedAt = now;
		return previous.lines;
	}
	try {
		const read = readTranscriptText(path, stat, normalized);
		const lines = parse(read.text);
		const entry: TranscriptCacheEntry = {
			path,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			lines,
			parsedAt: now,
			readCount: (previous?.readCount ?? 0) + 1,
			mode: normalized.full ? "full" : "tail",
			bytesRead: read.bytesRead,
			truncated: read.truncated,
		};
		transcriptCache.set(key, entry);
		// FIND-12: evict the oldest entry by Map insertion order. Map natively
		// preserves insertion order, so the first key is the oldest — replaces
		// the previous O(N) `parsedAt` min-scan that ran on every miss.
		if (transcriptCache.size > MAX_CACHE_SIZE) {
			const oldestKey = transcriptCache.keys().next().value;
			if (oldestKey !== undefined) transcriptCache.delete(oldestKey);
		}
		return lines;
	} catch {
		return previous?.lines ?? [];
	}
}

export const DEFAULT_TRANSCRIPT_TAIL_BYTES = DEFAULT_TAIL_BYTES;
