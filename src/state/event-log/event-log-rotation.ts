import * as fs from "node:fs";
import * as path from "node:path";
import { logInternalError } from "../../utils/internal-error.ts";
import { atomicWriteFile } from "../atomic-write.ts";
import { type TeamEvent, withEventLogLockSync } from "./event-log.ts";

/**
 * ST-11: Stream a JSONL file line-by-line using a bounded read buffer (8 KB
 * chunks), invoking `onLine` for each non-empty line. Replaces the previous
 * `readFileSync` approach that loaded the ENTIRE event log (up to 4 MB /
 * 50 000 events) into a single string before splitting + JSON.parsing every
 * line into an array. Memory is now bounded by the chunk size plus the
 * longest single line, and parsing is interleaved with I/O so the append
 * lock is held for less wall-clock time.
 */
function forEachLineSync(filePath: string, onLine: (line: string) => void): void {
	const fd = fs.openSync(filePath, "r");
	try {
		const chunkSize = 8192;
		const buf = Buffer.alloc(chunkSize);
		let leftover = "";
		let offset = 0;
		let bytesRead: number;
		while ((bytesRead = fs.readSync(fd, buf, 0, chunkSize, offset)) > 0) {
			offset += bytesRead;
			leftover += buf.subarray(0, bytesRead).toString("utf-8");
			let nl: number;
			while ((nl = leftover.indexOf("\n")) >= 0) {
				const line = leftover.slice(0, nl);
				leftover = leftover.slice(nl + 1);
				if (line.length > 0) onLine(line);
			}
		}
		if (leftover.length > 0) {
			// Trailing line without a final newline.
			onLine(leftover);
		}
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * ST-11: Stream the event log and keep only the last `maxKeep` valid (parseable)
 * events using a fixed-size ring buffer. Bounds memory to O(maxKeep) event
 * objects regardless of file size — previously the entire file was parsed
 * into a single array just to `slice(-compactToCount)` it. Corrupt lines
 * are skipped (matching `readEvents` behaviour). Returns the ordered
 * last-N events and the total count of valid events seen.
 */
function readLastEvents(filePath: string, maxKeep: number): { events: TeamEvent[]; totalCount: number } {
	if (maxKeep <= 0) {
		let totalCount = 0;
		forEachLineSync(filePath, (line) => {
			try {
				JSON.parse(line);
				totalCount++;
			} catch {
				/* skip corrupt */
			}
		});
		return { events: [], totalCount };
	}
	const ring: TeamEvent[] = new Array(maxKeep);
	let ringFilled = 0;
	let writeIdx = 0;
	let totalCount = 0;
	forEachLineSync(filePath, (line) => {
		let event: TeamEvent;
		try {
			event = JSON.parse(line) as TeamEvent;
		} catch {
			return; // skip corrupt — not counted (matches readEvents)
		}
		ring[writeIdx] = event;
		writeIdx = (writeIdx + 1) % maxKeep;
		if (ringFilled < maxKeep) ringFilled++;
		totalCount++;
	});
	const events: TeamEvent[] = [];
	if (ringFilled < maxKeep) {
		for (let i = 0; i < ringFilled; i++) events.push(ring[i]);
	} else {
		for (let i = 0; i < maxKeep; i++) events.push(ring[(writeIdx + i) % maxKeep]);
	}
	return { events, totalCount };
}

/**
 * ST-11: Stream the event log to count valid events and collect their seq
 * numbers, without materialising the full event array. Used by
 * `applyCompactionUnlocked` for the post-write recovery check. Memory is
 * bounded to the count + seq-set of the (small, post-compaction) file.
 */
function countEventsAndSeqs(filePath: string): { count: number; seqs: Set<number> } {
	const seqs = new Set<number>();
	let count = 0;
	forEachLineSync(filePath, (line) => {
		try {
			const event = JSON.parse(line) as TeamEvent;
			count++;
			const seq = event.metadata?.seq;
			if (typeof seq === "number") seqs.add(seq);
		} catch {
			/* skip corrupt */
		}
	});
	return { count, seqs };
}

export interface RotationConfig {
	maxFileSizeBytes: number;
	maxEventCount: number;
	compactToCount: number;
}

const DEFAULT_ROTATION_CONFIG: RotationConfig = {
	// 2.3: lowered from 5 MB to 4 MB so the file stays small enough that
	// `tail -c MAX_TAIL_BYTES` reads in run-snapshot-cache (default 32 KB)
	// always cover a useful slice and rotations happen earlier.
	maxFileSizeBytes: 4 * 1024 * 1024,
	maxEventCount: 50_000,
	compactToCount: 1_000,
};

const AVG_BYTES_PER_EVENT = 80;

function resolveConfig(config?: Partial<RotationConfig>): RotationConfig {
	return { ...DEFAULT_ROTATION_CONFIG, ...config };
}

/**
 * Check if an event file needs rotation/compaction.
 * M1: Uses file size estimation to avoid full-file read.
 */
export function needsRotation(eventsPath: string, config?: Partial<RotationConfig>): boolean {
	if (!fs.existsSync(eventsPath)) return false;
	const cfg = resolveConfig(config);
	try {
		const stat = fs.statSync(eventsPath);
		if (stat.size > cfg.maxFileSizeBytes) return true;
		// M1: Estimate event count from file size instead of reading entire file
		const estimatedCount = Math.floor(stat.size / AVG_BYTES_PER_EVENT);
		return estimatedCount > cfg.maxEventCount;
	} catch {
		return false;
	}
}

export interface CompactionResult {
	originalSize: number;
	compactedSize: number;
	eventsRemoved: number;
	eventsKept: number;
	recoveryFailed?: boolean;
}

/**
 * Compact an event log file:
 * C2: Fixed TOCTOU race — atomicWriteFile replaces in one step;
 * any events appended between readEvents and the write will be preserved
 * on the next compaction cycle because atomicWriteFile writes the full content.
 *
 * 1. Read all events
 * 2. Keep last `compactToCount` events
 * 3. Atomically write (atomicWriteFile handles temp-file + rename)
 * 4. Re-read to detect events appended during the window
 * 5. If events were lost, append them
 * 6. Return compaction stats
 */
export function compactEventLog(eventsPath: string, config?: Partial<RotationConfig>): CompactionResult | undefined {
	const prepared = prepareCompaction(eventsPath, config);
	if (!prepared) return undefined;
	// FIX: Wrap entire read-compact-write-recover sequence in lock to prevent
	// event loss during compaction. Without lock, events can be appended between
	// read and write, lost silently.
	//
	// NOTE (Round 24 BUG 1): callers ALREADY holding the event-log lock (e.g.
	// appendEventInsideLock in event-log.ts) must call applyCompactionUnlocked
	// directly — calling compactEventLog from inside the lock deadlocks (the
	// mkdir lock is not re-entrant → 5s timeout → compaction never ran → the
	// log grew unbounded until events were silently dropped past 50MB).
	return withEventLogLockSync(eventsPath, () => applyCompactionUnlocked(eventsPath, prepared));
}

/** Round 24 (BUG 1): the lock-free pre-read for compaction. Safe to run
 * outside the lock (read-only). Returns the compacted lines + stats needed
 * for the write phase.
 *
 * ST-11: streams the event log line-by-line through a ring buffer instead of
 * `readEvents` (full readFileSync + JSON.parse of every line into a single
 * array). Memory is bounded to O(compactToCount) events regardless of file
 * size, and the append lock is held for less time because parsing is
 * interleaved with I/O rather than deferred until the entire file is loaded. */
export function prepareCompaction(
	eventsPath: string,
	config?: Partial<RotationConfig>,
):
	| {
			lines: string;
			originalSize: number;
			originalCount: number;
			kept: TeamEvent[];
	  }
	| undefined {
	if (!fs.existsSync(eventsPath)) return undefined;
	const cfg = resolveConfig(config);
	let originalSize: number;
	try {
		originalSize = fs.statSync(eventsPath).size;
	} catch {
		return undefined;
	}
	const { events: kept, totalCount: originalCount } = readLastEvents(eventsPath, cfg.compactToCount);
	if (originalCount <= cfg.compactToCount) return undefined;
	const lines = kept.map((e) => JSON.stringify(e)).join("\n") + "\n";
	return { lines, originalSize, originalCount, kept };
}

/** Round 24 (BUG 1): the write+recover phase of compaction. Assumes the
 * caller ALREADY holds the event-log lock (or accepts the unlocked race). */
export function applyCompactionUnlocked(
	eventsPath: string,
	prepared: {
		lines: string;
		originalSize: number;
		originalCount: number;
		kept: TeamEvent[];
	},
): CompactionResult | undefined {
	const { lines, originalSize, originalCount, kept } = prepared;
	try {
		atomicWriteFile(eventsPath, lines);
	} catch (err) {
		// Concurrent write conflict — skip compaction this cycle
		logInternalError("event-log-rotation.compact", err, `eventsPath=${eventsPath}`);
		return undefined;
	}
	// C2: Re-read to recover any events appended during the compaction window.
	// ST-11: stream the post-write file instead of `readEvents` (full
	// readFileSync + JSON.parse per line into an array). We only need the event
	// count and the set of seq numbers for the recovery check, so memory is
	// bounded without materialising every event object.
	try {
		const { count: afterWriteCount, seqs: afterSeqs } = countEventsAndSeqs(eventsPath);
		if (afterWriteCount >= kept.length) {
			return {
				originalSize,
				compactedSize: fs.statSync(eventsPath).size,
				eventsRemoved: originalCount - kept.length,
				eventsKept: kept.length + Math.max(0, afterWriteCount - kept.length),
			};
		}
		// afterWriteCount < kept.length — events were lost during compaction window.
		const missingEvents = kept.filter((e) => e.metadata?.seq === undefined || !afterSeqs.has(e.metadata.seq));
		let recoveredCount = 0;
		let recoveryFailed = false;
		if (missingEvents.length > 0) {
			const recoveryLines = missingEvents.map((e) => JSON.stringify(e) + "\n").join("");
			try {
				fs.appendFileSync(eventsPath, recoveryLines);
				recoveredCount = missingEvents.length;
			} catch (err) {
				recoveryFailed = true;
				logInternalError("event-log-rotation.recovery", err, `eventsPath=${eventsPath} lostEvents=${missingEvents.length}`);
			}
		}
		return {
			originalSize,
			compactedSize: fs.statSync(eventsPath).size,
			eventsRemoved: originalCount - kept.length,
			eventsKept: kept.length + recoveredCount,
			recoveryFailed,
		};
	} catch {
		// Post-write verification failed — compaction likely succeeded.
		return {
			originalSize,
			compactedSize: fs.statSync(eventsPath).size,
			eventsRemoved: originalCount - kept.length,
			eventsKept: kept.length,
		};
	}
}

// --- R-03: generation sidecar for rotation cursor invalidation ---

/**
 * R-03: Path of the generation sidecar for an events file. Mirrors the
 * `.seq` sidecar pattern. The generation is bumped every time the events
 * file is rotated (truncated + archived), so readers holding a byte-offset
 * cursor can detect their offset is stale and re-read from the start of the
 * new file instead of missing the post-rotation events.
 */
export function generationPath(eventsPath: string): string {
	return `${eventsPath}.gen`;
}

/**
 * R-03: Read the current generation of an events file.
 *
 * Primary (and sole authoritative) mechanism = the `.gen` sidecar, which is
 * cross-platform. Inode (`fs.statSync().ino`) was evaluated as a secondary
 * fast-path signal but is platform-dependent: on Windows `ino` is always 0,
 * so it cannot be relied upon to detect rotation. The `.gen` sidecar is
 * therefore used exclusively (verified Windows path: ino=0 falls back to
 * the sidecar here).
 *
 * Returns 0 when the sidecar is absent (backward-compat: logs created before
 * this fix have no sidecar and are treated as generation 0, so a streaming
 * cursor that never tracked generation behaves as before on its first read).
 */
export function currentGeneration(eventsPath: string): number {
	try {
		const raw = fs.readFileSync(generationPath(eventsPath), "utf-8");
		const value = Number.parseInt(raw.trim(), 10);
		return Number.isInteger(value) && value >= 0 ? value : 0;
	} catch {
		return 0;
	}
}

/**
 * R-03: Atomically bump and persist the generation sidecar. Called by
 * `rotateEventLogUnlocked` after truncating the events file. Assumes the
 * caller already holds the event-log lock (or accepts the unlocked race).
 * Returns the new generation value.
 */
function bumpGenerationUnlocked(eventsPath: string): number {
	const next = currentGeneration(eventsPath) + 1;
	try {
		atomicWriteFile(generationPath(eventsPath), String(next));
	} catch (error) {
		logInternalError("event-log.bump-generation", error, `eventsPath=${eventsPath}`);
	}
	return next;
}

/**
 * Rotate an event log file by archiving it with a timestamp.
 * The current file is renamed to `<eventsPath>.<timestamp>.archive.jsonl`
 * and a fresh empty file is created in its place.
 * Readers using `readEvents` will see the new file; archived files can be
 * picked up by snapshot replay if needed.
 */
export function rotateEventLog(eventsPath: string): boolean {
	if (!fs.existsSync(eventsPath)) return false;
	// FIX: Wrap rotation in lock to prevent race conditions with concurrent readers.
	// Order of operations: (1) rename old live file to archive, (2) create new
	// empty live file. The rename is atomic (POSIX) so eventsPath is briefly
	// absent between (1) and (2); readers using readEvents tolerate a missing
	// file (return []). See rotateEventLogUnlocked for the ST-8 rationale.
	//
	// NOTE (Round 24 BUG 1): callers ALREADY holding the lock must call
	// rotateEventLogUnlocked directly — this locked variant is NOT re-entrant.
	return withEventLogLockSync(eventsPath, () => rotateEventLogUnlocked(eventsPath));
}

/** H2 retention: delete `<eventsPath>.*.archive.jsonl` files older than the window so
 * they don't accumulate forever (mirrors notification/metric-sink rotateOldFiles). */
const ARCHIVE_RETENTION_DAYS = 7;
function sweepOldArchives(eventsPath: string, now = Date.now()): void {
	const dir = path.dirname(eventsPath);
	const base = path.basename(eventsPath);
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return;
	}
	const cutoff = now - ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
	for (const name of entries) {
		if (!name.startsWith(`${base}.`) || !name.endsWith(".archive.jsonl")) continue;
		const archivePath = path.join(dir, name);
		try {
			if (fs.statSync(archivePath).mtimeMs < cutoff) fs.unlinkSync(archivePath);
		} catch (error) {
			logInternalError("event-log.archive-sweep", error, `archivePath=${archivePath}`, "debug");
		}
	}
}

/** Round 24 (BUG 1): the lock-free core of rotation. Assumes the caller
 * already holds the event-log lock (or accepts the unlocked race). */
export function rotateEventLogUnlocked(eventsPath: string): boolean {
	if (!fs.existsSync(eventsPath)) return false;
	try {
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		let archivePath = `${eventsPath}.${ts}.archive.jsonl`;
		// Round 12: avoid timestamp collisions when two rotations happen within
		// the same millisecond (copyFileSync would silently overwrite the
		// first archive). Append a counter until the path is free.
		let collision = 1;
		while (fs.existsSync(archivePath)) {
			archivePath = `${eventsPath}.${ts}.${collision}.archive.jsonl`;
			collision++;
		}
		// ST-8: rename+create instead of copy+truncate. The old approach
		// (copyFileSync + atomicWriteFile("")) had two data-loss windows:
		//
		//   1. Copy window: events appended between copyFileSync and the
		//      atomicWriteFile truncate landed on the OLD inode. After
		//      atomicWriteFile replaced eventsPath with a new (empty) inode,
		//      those appends were on an orphaned inode with no path → lost
		//      forever once the writer's fd closed.
		//   2. atomicWriteFile replaces the inode → any in-flight writer fd
		//      (opened before rotation) continues writing to the old inode,
		//      which is now orphaned.
		//
		// rename+create fixes both:
		//   - rename(2) is atomic: the live log's inode moves to the archive
		//     path in one step, carrying ALL pre-rotation content. No copy
		//     window exists — there is nothing to lose between "read" and
		//     "truncate" because both happen in the single rename syscall.
		//   - In-flight writer fds that opened the old inode before the rename
		//     continue writing to it — but it is now the ARCHIVE (it has a
		//     path), so their appends are preserved, not orphaned. The next
		//     append (all write paths open per-call) naturally opens the new
		//     inode at eventsPath.
		//   - The new live file is created with O_CREAT|O_EXCL ("wx"): if a
		//     concurrent writer (different lock class — sync `.mkdirlock` vs
		//     async `.alock` are separate) already recreated the file between
		//     our rename and here, we leave their data intact (EEXIST → skip).
		fs.renameSync(eventsPath, archivePath);
		try {
			const fd = fs.openSync(eventsPath, "wx", 0o644);
			fs.closeSync(fd);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			// A concurrent writer recreated the file — their data is preserved.
		}
		// R-03: bump the generation sidecar so byte-offset cursor readers
		// detect the truncation and reset (re-read from offset 0 of the new
		// file), instead of reading past EOF and missing post-rotation events.
		bumpGenerationUnlocked(eventsPath);
		// H2: retention — sweep archive files older than the window so they don't
		// accumulate forever (mirrors notification/metric-sink rotateOldFiles).
		sweepOldArchives(eventsPath);
		return true;
	} catch (error) {
		logInternalError("event-log.rotate", error, `eventsPath=${eventsPath}`);
		return false;
	}
}

export interface EventLogStats {
	fileSizeBytes: number;
	eventCount: number;
	oldestTimestamp?: string;
	newestTimestamp?: string;
}

/**
 * L3: Get event log stats using optimized reads.
 * Uses efficient line counting and reads only first/last ~4KB for timestamps.
 */
export function getEventLogStats(eventsPath: string): EventLogStats | undefined {
	if (!fs.existsSync(eventsPath)) return undefined;
	try {
		const stat = fs.statSync(eventsPath);
		const fileSizeBytes = stat.size;
		if (fileSizeBytes === 0) {
			return { fileSizeBytes: 0, eventCount: 0 };
		}

		// NEW-9 fix: stream-scan for line count (no full-file load).
		// Read last up-to-1KB for newest timestamp.
		let newestTimestamp: string | undefined;
		let lastLine = "";
		const tailSize = Math.min(fileSizeBytes, 1024);
		{
			const tailBuf = Buffer.alloc(tailSize);
			const fd = fs.openSync(eventsPath, "r");
			try {
				fs.readSync(fd, tailBuf, 0, tailSize, fileSizeBytes - tailSize);
			} finally {
				fs.closeSync(fd);
			}
			const tailStr = tailBuf.toString("utf-8");
			// JSONL files end with "\n", so the last newline bounds an empty string.
			// Walk backwards to find the last non-empty line.
			let searchFrom = tailStr.length;
			for (;;) {
				const nl = tailStr.lastIndexOf("\n", searchFrom - 1);
				if (nl < 0) {
					lastLine = tailStr.trim();
					break;
				}
				const candidate = tailStr.slice(nl + 1, searchFrom).trim();
				if (candidate) {
					lastLine = candidate;
					break;
				}
				searchFrom = nl;
			}
			try {
				if (lastLine) {
					newestTimestamp = (JSON.parse(lastLine) as { time: string }).time;
				}
			} catch {
				/* corrupt tail */
			}
		}

		// Stream-scan to count newlines and find first line boundary.
		let eventCount = 0;
		let firstLineBytes = 0;
		const buf = Buffer.alloc(8192);
		let offset = 0;
		let newlineCount = 0;
		const scanFd = fs.openSync(eventsPath, "r");
		try {
			let bytesRead: number;
			while ((bytesRead = fs.readSync(scanFd, buf, 0, buf.length, offset)) > 0) {
				for (let i = 0; i < bytesRead; i++) {
					if (buf[i] === 10) {
						if (newlineCount === 0) firstLineBytes = offset + i + 1;
						newlineCount++;
					}
				}
				offset += bytesRead;
			}
		} finally {
			fs.closeSync(scanFd);
		}
		eventCount = newlineCount;

		// Read first line for oldest timestamp.
		let oldestTimestamp: string | undefined;
		if (firstLineBytes > 0) {
			try {
				const firstBuf = Buffer.alloc(firstLineBytes);
				const fd = fs.openSync(eventsPath, "r");
				try {
					fs.readSync(fd, firstBuf, 0, firstLineBytes, 0);
				} finally {
					fs.closeSync(fd);
				}
				const firstLine = firstBuf.toString("utf-8").trim();
				if (firstLine) {
					oldestTimestamp = (JSON.parse(firstLine) as { time: string }).time;
				}
			} catch {
				/* corrupt head */
			}
		}

		return {
			fileSizeBytes,
			eventCount,
			oldestTimestamp,
			newestTimestamp,
		};
	} catch {
		return undefined;
	}
}
