import * as fs from "node:fs";

export interface TranscriptCacheEntry {
	path: string;
	mtimeMs: number;
	/**
	 * Byte offset of the END of the cached text. Equals `offset + raw.length`
	 * (normally the file size at read time; only smaller if a concurrent
	 * writer shrank the file mid-read, which forces a fresh read next time).
	 */
	size: number;
	/**
	 * Byte offset of the START of the cached text. Zero for whole-file reads;
	 * positive once the tail cap front-trims, because the cached text then
	 * starts partway into the file — not at offset 0.
	 */
	offset: number;
	/** Undecoded bytes backing the cached text, spanning [offset, size). */
	raw: Buffer;
	lines: string[];
	parsedAt: number;
	readCount: number;
	mode: "tail" | "full";
	/** Bytes actually read from disk on the most recent read (delta for appends). */
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

interface TranscriptReadResult {
	raw: Buffer;
	offset: number;
	bytesRead: number;
	truncated: boolean;
}

/**
 * Fresh read: whole file, or the last `maxTailBytes` bytes with the leading
 * partial line skipped. Operates on raw bytes so a later append can extend
 * the buffer and decode exactly like a fresh read of the same byte range.
 */
function readTranscriptText(
	path: string,
	stat: fs.Stats,
	options: Required<Pick<TranscriptReadOptions, "full">> & {
		maxTailBytes: number;
	},
): TranscriptReadResult {
	if (options.full || stat.size <= options.maxTailBytes) {
		const raw = fs.readFileSync(path);
		return { raw, offset: 0, bytesRead: raw.length, truncated: false };
	}
	const bytesToRead = Math.min(stat.size, options.maxTailBytes);
	const fd = fs.openSync(path, "r");
	try {
		const buffer = Buffer.alloc(bytesToRead);
		fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
		// Skip through the first newline so the tail starts on a line boundary
		// (0x0a is ASCII, so a byte scan matches the old decoded-text scan).
		const firstNewline = buffer.indexOf(0x0a);
		const start = firstNewline >= 0 ? firstNewline + 1 : 0;
		return {
			raw: buffer.subarray(start),
			offset: stat.size - bytesToRead + start,
			bytesRead: bytesToRead,
			truncated: true,
		};
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Incremental read for append-only growth: read only [previous.size, size) and
 * extend the cached bytes, then re-apply the tail cap by trimming the FRONT.
 * Returns null when the delta could not be read completely (concurrent
 * shrink/rotation) so the caller falls back to a fresh read.
 */
function appendTranscriptText(
	path: string,
	previous: TranscriptCacheEntry,
	stat: fs.Stats,
	options: Required<Pick<TranscriptReadOptions, "full">> & {
		maxTailBytes: number;
	},
): TranscriptReadResult | null {
	const deltaLength = stat.size - previous.size;
	const fd = fs.openSync(path, "r");
	let delta: Buffer;
	try {
		delta = Buffer.alloc(deltaLength);
		let read = 0;
		while (read < deltaLength) {
			const n = fs.readSync(fd, delta, read, deltaLength - read, previous.size + read);
			if (n <= 0) break;
			read += n;
		}
		if (read < deltaLength) return null;
	} finally {
		fs.closeSync(fd);
	}
	let raw = Buffer.concat([previous.raw, delta], previous.raw.length + deltaLength);
	let offset = previous.offset;
	const endOffset = previous.size + deltaLength;
	if (!options.full && endOffset - offset > options.maxTailBytes) {
		// Keep the tail bounded: drop to the start of the new window, then
		// through the first newline so the front stays a complete line.
		const windowStart = endOffset - options.maxTailBytes;
		const firstNewline = raw.indexOf(0x0a, windowStart - offset);
		const drop = firstNewline >= 0 ? firstNewline + 1 : windowStart - offset;
		// Copy (not subarray) so a huge append does not keep its pre-trim
		// buffer alive through the retained view.
		raw = Buffer.from(raw.subarray(drop));
		offset += drop;
	}
	return {
		raw,
		offset,
		bytesRead: deltaLength,
		truncated: !options.full && offset > 0,
	};
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
		// Append-only growth (size grew, mtime not older): read only the new
		// bytes and extend the cached range. Any shrink or backdated mtime
		// falls through to a fresh read below.
		const read =
			previous && stat.size > previous.size && stat.mtimeMs >= previous.mtimeMs
				? (appendTranscriptText(path, previous, stat, normalized) ?? readTranscriptText(path, stat, normalized))
				: readTranscriptText(path, stat, normalized);
		const lines = parse(read.raw.toString("utf-8"));
		const entry: TranscriptCacheEntry = {
			path,
			mtimeMs: stat.mtimeMs,
			size: read.offset + read.raw.length,
			offset: read.offset,
			raw: read.raw,
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
