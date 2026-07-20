import * as fs from "node:fs";

export interface IncrementalReadState {
	byteOffset: number;
	lineCount: number;
}

export interface IncrementalReadResult {
	lines: string[];
	state: IncrementalReadState;
	eof: boolean;
}

const CHUNK_SIZE = 64 * 1024;

/**
 * Read the last `tailBytes` bytes of a file and parse it as JSONL,
 * returning each successfully-parsed item in file order. If the file is
 * shorter than `tailBytes`, the entire file is read from offset 0.
 *
 * Returns:
 *   - items: parsed JSONL items (T may be any deserializable type)
 *   - fileSize: total file size in bytes
 *   - bytesRead: number of bytes actually read (≤ min(fileSize, tailBytes))
 *   - truncated: true when `bytesRead < fileSize` (a prefix was dropped)
 *
 * The function bounds the read to `tailBytes`, so CPU is O(tail bytes)
 * regardless of how large the file grows. Used by the event-log tail
 * read path (FIND-05) to avoid the O(total events) cost of the legacy
 * `readFileSync`+`split("\n")`+`JSON.parse` approach.
 */
export function readJsonlTail<T>(
	filePath: string,
	tailBytes: number,
): {
	items: T[];
	fileSize: number;
	bytesRead: number;
	truncated: boolean;
} {
	const limit = Math.max(0, Math.floor(tailBytes));
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return { items: [], fileSize: 0, bytesRead: 0, truncated: false };
	}
	const fileSize = stat.size;
	if (fileSize === 0 || limit === 0) {
		return { items: [], fileSize, bytesRead: 0, truncated: false };
	}

	const startOffset = Math.max(0, fileSize - limit);
	const bytesToRead = fileSize - startOffset;
	const truncated = startOffset > 0;

	let fd: number | undefined;
	try {
		// FIND-05 follow-up: O_NOFOLLOW refuses symlinks (defense-in-depth,
		// consistent with atomicWriteFile / resolveRealContainedPath). The
		// eventsPath is validated inside stateRoot, but this guards against a
		// symlinked file appearing after validation. O_NOFOLLOW on a symlink
		// yields ELOOP, which the catch below treats like ENOENT (return empty).
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch {
		return { items: [], fileSize, bytesRead: 0, truncated: false };
	}
	try {
		const buf = Buffer.alloc(bytesToRead);
		let totalRead = 0;
		while (totalRead < bytesToRead) {
			const chunkSize = Math.min(CHUNK_SIZE, bytesToRead - totalRead);
			const bytesRead = fs.readSync(fd, buf, totalRead, chunkSize, startOffset + totalRead);
			if (bytesRead === 0) break;
			totalRead += bytesRead;
		}

		// Decode the slice we actually read; the buffer may be partially
		// filled on short reads. We use totalRead (not bytesToRead) so the
		// JSONL split lands on actual data, not a zero-padded tail.
		const content = buf.toString("utf-8", 0, totalRead);

		// If we truncated the file, the first decoded line may be a
		// half-line from the cut. Drop it — we can't trust the JSON.
		// Use a single indexOf("\n") to find the first newline; if there
		// is none, the whole tail is one partial line and we drop it.
		let body = content;
		if (truncated) {
			const firstNewline = body.indexOf("\n");
			if (firstNewline < 0) {
				// No newline at all in the tail → the entire tail is one
				// partial line. Return no items; the caller should fall
				// back to a wider tail or full read.
				return { items: [], fileSize, bytesRead: totalRead, truncated: true };
			}
			body = body.slice(firstNewline + 1);
		}

		const items: T[] = [];
		for (const line of body.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				items.push(JSON.parse(trimmed) as T);
			} catch {
				// Skip malformed lines (mirrors readJsonlSince's behavior).
			}
		}
		return { items, fileSize, bytesRead: totalRead, truncated };
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* ignore */
			}
		}
	}
}

/**
 * Read new lines from a text file since last known byte offset.
 * Uses fs.openSync + fs.readSync for efficient incremental reading.
 */
export function readLinesSince(filePath: string, state: IncrementalReadState): IncrementalReadResult {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
	} catch {
		return {
			lines: [],
			state: { byteOffset: state.byteOffset, lineCount: state.lineCount },
			eof: true,
		};
	}

	try {
		const stat = fs.fstatSync(fd);
		const fileSize = stat.size;

		if (fileSize <= state.byteOffset) {
			return {
				lines: [],
				state: { byteOffset: fileSize, lineCount: state.lineCount },
				eof: true,
			};
		}

		const bytesToRead = fileSize - state.byteOffset;
		const buf = Buffer.alloc(bytesToRead);
		let totalRead = 0;

		while (totalRead < bytesToRead) {
			const chunkSize = Math.min(CHUNK_SIZE, bytesToRead - totalRead);
			const bytesRead = fs.readSync(fd, buf, totalRead, chunkSize, state.byteOffset + totalRead);
			if (bytesRead === 0) break;
			totalRead += bytesRead;
		}

		const content = buf.toString("utf-8", 0, totalRead);
		const lines: string[] = [];
		let lineCount = state.lineCount;
		let committedOffset = state.byteOffset;

		let searchFrom = 0;
		let newlineIdx: number;

		while ((newlineIdx = content.indexOf("\n", searchFrom)) !== -1) {
			const lineText = content.slice(searchFrom, newlineIdx);
			committedOffset = state.byteOffset + newlineIdx + 1;
			searchFrom = newlineIdx + 1;
			if (lineText.length > 0) {
				lines.push(lineText);
				lineCount++;
			}
		}

		const eof = committedOffset >= fileSize;

		return {
			lines,
			state: { byteOffset: committedOffset, lineCount },
			eof,
		};
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* ignore */
			}
		}
	}
}

/**
 * Read parsed JSON objects from a JSONL file since last known byte offset.
 * Skips malformed lines.
 */
export function readJsonlSince<T>(
	filePath: string,
	state: IncrementalReadState,
): { items: T[]; state: IncrementalReadState; eof: boolean } {
	const result = readLinesSince(filePath, state);
	const items: T[] = [];

	for (const line of result.lines) {
		try {
			items.push(JSON.parse(line) as T);
		} catch {
			// Skip malformed lines
		}
	}

	return {
		items,
		state: result.state,
		eof: result.eof,
	};
}
