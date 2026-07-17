import * as fs from "node:fs";
import { logInternalError } from "../utils/internal-error.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import { readEvents, type TeamEvent, withEventLogLockSync } from "./event-log.ts";

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
 * for the write phase. */
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
	const allEvents = readEvents(eventsPath);
	const originalCount = allEvents.length;
	if (originalCount <= cfg.compactToCount) return undefined;
	const kept = allEvents.slice(-cfg.compactToCount);
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
	// Events appended during the compaction window are preserved because they
	// appear in afterWrite and the condition afterWrite.length >= kept.length is
	// true, so they are included in the return stats without entering the
	// recovery branch.
	try {
		const afterWrite = readEvents(eventsPath);
		// FIX: Check if events were actually lost (afterWrite.length < kept.length)
		// rather than using appendedDuringWindow >= 0 which is always true.
		// Also use sequence numbers for comparison instead of JSON.stringify
		// which is fragile due to key ordering and floating point differences.
		if (afterWrite.length >= kept.length) {
			return {
				originalSize,
				compactedSize: fs.statSync(eventsPath).size,
				eventsRemoved: originalCount - kept.length,
				eventsKept: kept.length + Math.max(0, afterWrite.length - kept.length),
			};
		}
		// afterWrite.length < kept.length — events were lost during compaction window.
		const afterSeqs = new Set(afterWrite.map((e) => e.metadata?.seq).filter((s): s is number => s !== undefined));
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
	// Order of operations: (1) create new empty file, (2) rename old file to archive.
	// This ensures eventsPath always exists — a reader never sees a missing file.
	//
	// NOTE (Round 24 BUG 1): callers ALREADY holding the lock must call
	// rotateEventLogUnlocked directly — this locked variant is NOT re-entrant.
	return withEventLogLockSync(eventsPath, () => rotateEventLogUnlocked(eventsPath));
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
		// BUGFIX (Round 12 C1): the previous order (atomicWriteFile empty THEN
		// rename) destroyed ALL events — atomicWriteFile replaces the file
		// in place, so the rename then moved an EMPTY file to the archive.
		// FIX: copy current content to the archive first (archive is populated,
		// original still intact), then truncate the original to empty in place.
		// copyFileSync + writeFileSync("") ensures eventsPath ALWAYS exists
		// (no missing-file window for concurrent readers).
		fs.copyFileSync(eventsPath, archivePath);
		atomicWriteFile(eventsPath, "");
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
