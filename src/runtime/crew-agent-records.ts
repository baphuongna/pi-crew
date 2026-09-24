import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	atomicWriteJson,
	atomicWriteJsonCoalesced,
	cancelPendingCoalescedWriteForPath,
	flushPendingAtomicWrites,
	peekPendingCoalescedWrite,
	readJsonFile,
} from "../state/atomic-write.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { readJsonFileCoalesced } from "../utils/file-coalescer.ts";
import { readLinesSince } from "../utils/incremental-reader.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { redactSecretString, redactSecrets } from "../utils/redaction.ts";
import { assertSafePathId, resolveRealContainedPath } from "../utils/safe-paths.ts";
import { sleepSync } from "../utils/sleep.ts";
import type { CrewAgentProgress, CrewAgentRecord, CrewRuntimeKind } from "./crew-agent-runtime.ts";
import { taskStatusToAgentStatus } from "./crew-agent-runtime.ts";

export function agentsPath(manifest: TeamRunManifest): string {
	return path.join(manifest.stateRoot, "agents.json");
}

export function agentsRoot(manifest: TeamRunManifest): string {
	return path.join(manifest.stateRoot, "agents");
}

function safeAgentTaskId(taskId: string): string {
	return assertSafePathId("taskId", taskId.includes(":") ? taskId.split(":").pop()! : taskId);
}

export function agentStateDir(manifest: TeamRunManifest, taskId: string): string {
	return path.join(agentsRoot(manifest), safeAgentTaskId(taskId));
}

// P1-5: per-task path memoization. The agent state dir + file paths cannot
// change within a task, so the mkdir/lstat/resolveRealContainedPath validation
// (≈30 syscalls each, incl. a full ancestor walk) only needs to run ONCE per
// task — not on every event/output line (was ~60 syscalls/event for the double
// ensureAgentStateDir call alone). FIFO-bounded so the cache can't grow with
// run count.
const ensuredAgentDirs = new Map<string, string>();
const resolvedAgentFiles = new Map<string, string>();
const AGENT_PATH_CACHE_MAX = 512;

function bumpAgentPathCache(): void {
	if (ensuredAgentDirs.size > AGENT_PATH_CACHE_MAX) {
		const oldest = ensuredAgentDirs.keys().next().value;
		if (oldest !== undefined) ensuredAgentDirs.delete(oldest);
	}
	if (resolvedAgentFiles.size > AGENT_PATH_CACHE_MAX) {
		const oldest = resolvedAgentFiles.keys().next().value;
		if (oldest !== undefined) resolvedAgentFiles.delete(oldest);
	}
}

export function ensureAgentStateDir(manifest: TeamRunManifest, taskId: string): string {
	const root = agentsRoot(manifest);
	const dir = agentStateDir(manifest, taskId);
	const cachedDir = ensuredAgentDirs.get(dir);
	if (cachedDir !== undefined) return cachedDir;
	fs.mkdirSync(root, { recursive: true });
	if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`Invalid agents root: ${root}`);
	fs.mkdirSync(dir, { recursive: true });
	if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Invalid agent state directory: ${dir}`);
	resolveRealContainedPath(root, path.basename(dir));
	ensuredAgentDirs.set(dir, dir);
	bumpAgentPathCache();
	return dir;
}

function safeExistingAgentFile(manifest: TeamRunManifest, taskId: string, fileName: string): string {
	const filePath = path.join(agentStateDir(manifest, taskId), fileName);
	if (!fs.existsSync(filePath)) return filePath;
	if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`Invalid agent state file: ${filePath}`);
	return resolveRealContainedPath(agentsRoot(manifest), path.join(safeAgentTaskId(taskId), fileName));
}

export function agentStateFile(manifest: TeamRunManifest, taskId: string, fileName: string): string {
	const dir = agentStateDir(manifest, taskId);
	const cacheKey = `${dir}\0${fileName}`;
	const cached = resolvedAgentFiles.get(cacheKey);
	if (cached !== undefined) return cached;
	ensureAgentStateDir(manifest, taskId);
	const resolved = safeExistingAgentFile(manifest, taskId, fileName);
	resolvedAgentFiles.set(cacheKey, resolved);
	bumpAgentPathCache();
	return resolved;
}

/** @internal Test-only: clear the path memoization cache. */
export function __test_clearAgentPathCache(): void {
	ensuredAgentDirs.clear();
	resolvedAgentFiles.clear();
}

/** @internal Test-only: inspect cache occupancy (regression guard for P1-5). */
export function __test_agentPathCacheStats(): { dirs: number; files: number } {
	return { dirs: ensuredAgentDirs.size, files: resolvedAgentFiles.size };
}

export function agentStatusPath(manifest: TeamRunManifest, taskId: string): string {
	return path.join(agentStateDir(manifest, taskId), "status.json");
}

export function agentEventsPath(manifest: TeamRunManifest, taskId: string): string {
	return agentEventsPathForStateRoot(manifest.stateRoot, taskId);
}

/**
 * Per-agent events log dưới stateRoot bất kỳ (không cần manifest đầy đủ).
 * MỘT công thức cho mọi bên: host writers/readers (qua agentEventsPath) và
 * surface spawn (S2-T7 set PI_CREW_AGENT_EVENTS_PATH, S2-T9 tail) — tất cả
 * qua safeAgentTaskId, nên taskId chứa ":" (delegate-spawn ids) rơi về CÙNG
 * file cho cả worker recorder lẫn agent-view. Throw khi phần id sau sanitize
 * không hợp lệ (assertSafePathId) — caller fail-closed tự xử lý.
 */
export function agentEventsPathForStateRoot(stateRoot: string, taskId: string): string {
	return path.join(stateRoot, "agents", safeAgentTaskId(taskId), "events.jsonl");
}

export function agentOutputPath(manifest: TeamRunManifest, taskId: string): string {
	return path.join(agentStateDir(manifest, taskId), "output.log");
}

const AGENT_READER_TTL_MS = 200;
const ASYNC_AGENT_READER_CACHE_MAX_ENTRIES = 128;
const AGENTS_LOCK_STALE_MS = 30_000;

const asyncAgentReaderCache = new Map<
	string,
	{
		expiresAt: number;
		records: CrewAgentRecord[];
		inFlight?: Promise<CrewAgentRecord[]>;
	}
>();

function agentsLockPath(manifest: TeamRunManifest): string {
	return `${agentsPath(manifest)}.lock`;
}

function removeStaleAgentsLock(lockPath: string, staleMs: number): boolean {
	try {
		const stat = fs.statSync(lockPath);
		if (stat.size > 1024) return false;
		const raw = fs.readFileSync(lockPath, "utf-8");
		const parsed = JSON.parse(raw) as {
			createdAt?: unknown;
			pid?: unknown;
		};
		const createdAt = typeof parsed.createdAt === "string" ? Date.parse(parsed.createdAt) : NaN;
		if (Number.isFinite(createdAt) && Date.now() - createdAt <= staleMs) return false;
		const pid = typeof parsed.pid === "number" ? parsed.pid : undefined;
		if (pid && pid !== process.pid) {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				/* owner dead */
			}
		}
		fs.rmSync(lockPath, { force: true });
		return true;
	} catch (error) {
		// R17-B1 (HIGH): a bare catch here swallowed parse/stat/rm failures, so the
		// root cause became invisible after withAgentsLock's 60s "locked" error.
		logInternalError("crew-agents.remove-stale-lock", error, `lockPath=${lockPath}`, "warn");
		return false;
	}
}

/**
 * Phase 3.1 (decision α): token-guarded release for the agents-record lock,
 * mirroring `locks.ts` `releaseLock` semantics — only `rmSync` if the stored
 * token still matches the token we wrote at acquisition. If the lock was
 * stolen while our critical section ran (stale-steal replaced the file with a
 * NEW owner's token), releasing must be a no-op — otherwise we would delete
 * the new holder's lock and break mutual exclusion (the exact race the
 * token guard in locks.ts fixes). Missing/corrupt files are handled safely:
 * ENOENT is a no-op (lock already gone); a symlink is never removed (defense
 * against attacker-planted symlinks, matching locks.ts); an unreadable/
 * unparseable payload is treated like locks.ts `releaseLock` (stored token
 * unknown → remove) so a torn write cannot strand the lock forever — the
 * 30s stale-steal path remains the backstop for genuinely foreign locks.
 */
function releaseAgentsLock(filePath: string, token: string): void {
	try {
		const stat = fs.lstatSync(filePath);
		if (stat.isSymbolicLink()) return;
	} catch {
		/* ENOENT — lock already gone, nothing to release */
	}
	let stored: string | undefined;
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as { token?: unknown };
		stored = typeof parsed.token === "string" ? parsed.token : undefined;
	} catch {
		/* unreadable/corrupt — see doc comment: remove, mirroring locks.ts */
	}
	if (stored === undefined || stored === token) {
		try {
			fs.rmSync(filePath, { force: true });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				logInternalError("crew-agents.release-lock", error, `lockPath=${filePath}`, "warn");
			}
		}
	}
	// stored !== token → lock stolen by another process; do NOT touch.
}

function withAgentsLock<T>(manifest: TeamRunManifest, fn: () => T): T {
	const filePath = agentsLockPath(manifest);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	// Phase 3.1 (decision α): the agents lock file now carries a randomUUID
	// `token` (format change explicitly accepted by the plan) so the release
	// below is token-guarded — a stale-steal by another process can no longer
	// be released by the wrong owner (previously PID-only release). Mirrors
	// the `writeLockFile` payload shape in locks.ts ({kind,pid,createdAt,token}
	// minus `kind`). Generated ONCE per call; only the successful O_EXCL write
	// persists it, so a single token per acquisition is correct.
	const token = randomUUID();
	let attempt = 0;
	const deadline = Date.now() + AGENTS_LOCK_STALE_MS * 2;
	while (true) {
		try {
			const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
			try {
				fs.writeSync(
					fd,
					JSON.stringify({
						pid: process.pid,
						createdAt: new Date().toISOString(),
						token,
					}),
				);
			} finally {
				fs.closeSync(fd);
			}
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// EPERM/EACCES/EBUSY: Windows cross-process contention (another handle
			// holds the lock open) — retry like EEXIST, bounded by the deadline.
			if (code !== "EEXIST" && code !== "EISDIR" && code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")
				throw error;
			if (code === "EISDIR") {
				try {
					fs.rmSync(filePath, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
				continue;
			}
			if (!removeStaleAgentsLock(filePath, AGENTS_LOCK_STALE_MS) && Date.now() > deadline)
				throw new Error(`Crew agents file is locked by another operation: ${agentsPath(manifest)}`);
			sleepSync(Math.min(250, 25 * 2 ** attempt));
			attempt += 1;
		}
	}
	try {
		return fn();
	} finally {
		// Phase 3.1 (decision α): unconditional rmSync → token-guarded release.
		releaseAgentsLock(filePath, token);
	}
}

function setAsyncAgentReaderCache(
	filePath: string,
	entry: {
		expiresAt: number;
		records: CrewAgentRecord[];
		inFlight?: Promise<CrewAgentRecord[]>;
	},
): void {
	const now = Date.now();
	for (const [key, cached] of asyncAgentReaderCache) {
		if (cached.expiresAt <= now && !cached.inFlight) asyncAgentReaderCache.delete(key);
	}
	if (asyncAgentReaderCache.has(filePath)) asyncAgentReaderCache.delete(filePath);
	asyncAgentReaderCache.set(filePath, entry);
	while (asyncAgentReaderCache.size > ASYNC_AGENT_READER_CACHE_MAX_ENTRIES) {
		const oldest = asyncAgentReaderCache.keys().next().value;
		if (!oldest) break;
		asyncAgentReaderCache.delete(oldest);
	}
}

export function readCrewAgents(manifest: TeamRunManifest): CrewAgentRecord[] {
	// F06 / RR-017: read-after-write WITHOUT forcing the pending coalesced write
	// to disk. `upsertCrewAgent` always reads first, so the previous scoped
	// `flushPendingAtomicWrites(agentsPath)` (a scoped flush IS a write when an
	// entry exists — atomic-write.ts:1147) turned every non-terminal upsert into
	// a durable agents.json rewrite, destroying the very coalescing window the
	// caller had just created (measured: 20 progress upserts → 19 agents.json
	// renames). The buffered value is byte-for-byte what a flush would have
	// written, so overlaying it preserves the "intra-process readers see the
	// latest data" contract (and cross-process readers still see the file within
	// one coalesce window) with zero I/O.
	const agentsFilePath = agentsPath(manifest);
	const pending = peekPendingCoalescedWrite<CrewAgentRecord[]>(agentsFilePath);
	try {
		const records =
			pending ??
			readJsonFileCoalesced(agentsFilePath, AGENT_READER_TTL_MS, () => readJsonFile<CrewAgentRecord[]>(agentsFilePath) ?? []);
		// Validate schema and deduplicate by id to handle concurrent write conflicts
		const seen = new Set<string>();
		const deduped = records.filter((r) => {
			if (!r || typeof r.id !== "string" || typeof r.taskId !== "string") return false;
			if (seen.has(r.id)) return false;
			seen.add(r.id);
			return true;
		});
		// R10-7: write back only when the corrected list actually differs from
		// the current content. A filter() only removes entries, so element
		// identity + length is an exact (and cheap) change check — deep-equal is
		// unnecessary, and this eliminates the redundant durable write + lock
		// churn on unchanged reads.
		const changed = deduped.length !== records.length || records.some((record, index) => record !== deduped[index]);
		if (changed) {
			// Schema mismatch or duplicates detected — save corrected state
			saveCrewAgents(manifest, deduped);
		}
		return deduped;
	} catch {
		return [];
	}
}

export async function readCrewAgentsAsync(manifest: TeamRunManifest): Promise<CrewAgentRecord[]> {
	const filePath = agentsPath(manifest);
	const now = Date.now();
	const cached = asyncAgentReaderCache.get(filePath);
	if (cached && cached.expiresAt > now) return cached.records;
	if (cached?.inFlight) return cached.inFlight;
	const inFlight = (async (): Promise<CrewAgentRecord[]> => {
		try {
			const parsed = JSON.parse(await fs.promises.readFile(filePath, "utf-8")) as unknown;
			const raw = Array.isArray(parsed) ? (redactSecrets(parsed) as CrewAgentRecord[]) : [];
			// Deduplicate by id to handle concurrent write conflicts
			const seen = new Set<string>();
			const deduped = raw.filter((r) => {
				if (!r || typeof r.id !== "string" || typeof r.taskId !== "string") return false;
				if (seen.has(r.id)) return false;
				seen.add(r.id);
				return true;
			});
			// R10-7: write back only on actual change (element identity + length —
			// see the sync readCrewAgents path for the reasoning).
			const changed = deduped.length !== raw.length || raw.some((record, index) => record !== deduped[index]);
			if (changed) {
				try {
					saveCrewAgents(manifest, deduped);
				} catch {
					/* best-effort */
				}
			}
			setAsyncAgentReaderCache(filePath, {
				expiresAt: Date.now() + AGENT_READER_TTL_MS,
				records: deduped,
			});
			return deduped;
		} catch {
			setAsyncAgentReaderCache(filePath, {
				expiresAt: Date.now() + AGENT_READER_TTL_MS,
				records: [],
			});
			return [];
		}
	})();
	setAsyncAgentReaderCache(filePath, {
		expiresAt: now + AGENT_READER_TTL_MS,
		records: cached?.records ?? [],
		inFlight,
	});
	return inFlight;
}

// ---------------------------------------------------------------------------
// F06 / RR-017: dirty tracking for per-task status.json writes.
//
// `saveCrewAgents`/`saveCrewAgentsCoalesced` used to loop over EVERY record and
// write its status.json, with no notion of which records actually changed. The
// measured cost of updating ONE of four `completed` records was 6 renames / 12
// fsyncs, and the three unchanged records each paid a full durable rename they
// had no reason to pay.
//
// SCOPE OF THE SKIP — durable (terminal) writes only, deliberately:
//   - a coalesced write is buffered in RAM and collapses per path, so skipping
//     it saves no I/O; and a skip there could not be trusted anyway, since the
//     buffered value may never reach disk (the memo would then claim a write
//     that a crash erased). Coalesced writes therefore stay unconditional.
//   - a DURABLE write is only skipped when the exact same bytes are already
//     durably on disk: the memo is written ONLY by durable writes, and the skip
//     is re-validated against the file actually existing. So a skip can never
//     lose durability — it can only avoid re-writing identical bytes.
// Durability is otherwise untouched: agents.json keeps full durability on every
// save, terminal status keeps its deliberate DOUBLE write (H2/F4 — the second
// write is unconditional and is NOT removed here), and non-terminal status keeps
// the coalesced best-effort path.
// ---------------------------------------------------------------------------

/**
 * Last record content (redacted, JSON-serialized) written DURABLY per status
 * path.
 *
 * INVARIANT (single-writer, RM-03 / review MINOR 4): this memo is a
 * PROCESS-GLOBAL Map with no locking, and it is only correct because exactly
 * ONE writer owns a given `statusPath` at a time. Two concurrent writers for
 * the same path would each see a stale memo and could skip a durable write
 * that the other expects to have happened. The single-writer property is
 * provided by the run-lock / task-claim protocol (see
 * src/state/coordination/locks.ts): a task is claimed by one agent, and only
 * that agent calls saveCrewAgents for its statusPath.
 *
 * Do NOT add a second writer for the same statusPath without first replacing
 * this memo with a lock-protected (or content-addressed) structure — and do
 * NOT rely on the memo across processes (it is per-process; cross-process
 * readers see the file, which is why needsDurableStatusWrite re-checks
 * fs.existsSync rather than trusting the memo).
 *
 * Bounded by LAST_WRITTEN_STATUS_MAX_ENTRIES with FIFO eviction, so an evicted
 * entry merely causes one redundant durable write (safe), never a skipped one.
 */
const lastWrittenStatus = new Map<string, string>();
const LAST_WRITTEN_STATUS_MAX_ENTRIES = 2048;

/** @internal Test-only: how many records a save actually persisted status for. */
let lastSaveStatusWriteCount = 0;
/** @internal Test-only: read the counter from the most recent save call. */
export function __test__lastAgentStatusWriteCount(): number {
	return lastSaveStatusWriteCount;
}

/** @internal Test-only: drop the durable-write memo. */
export function __test__clearWrittenStatusMemo(): void {
	lastWrittenStatus.clear();
}

function statusSnapshotKey(record: CrewAgentRecord): string {
	return JSON.stringify(redactSecrets(record));
}

/**
 * True when `record`'s status.json must be written durably: either its content
 * differs from the last durable snapshot for that path, or the file is gone
 * (someone else deleted it — never trust the memo over the filesystem).
 */
function needsDurableStatusWrite(manifest: TeamRunManifest, record: CrewAgentRecord): boolean {
	const statusPath = agentStatusPath(manifest, record.taskId);
	const snapshot = statusSnapshotKey(record);
	if (lastWrittenStatus.get(statusPath) !== snapshot) return true;
	return !fs.existsSync(statusPath);
}

function rememberWrittenStatus(manifest: TeamRunManifest, record: CrewAgentRecord): void {
	const statusPath = agentStatusPath(manifest, record.taskId);
	if (lastWrittenStatus.has(statusPath)) lastWrittenStatus.delete(statusPath);
	lastWrittenStatus.set(statusPath, statusSnapshotKey(record));
	while (lastWrittenStatus.size > LAST_WRITTEN_STATUS_MAX_ENTRIES) {
		const oldest = lastWrittenStatus.keys().next().value;
		if (oldest === undefined) break;
		lastWrittenStatus.delete(oldest);
	}
}

/** Drop the memo for a status path whose file was deleted (cancel/removal). */
function forgetWrittenStatus(statusPath: string): void {
	lastWrittenStatus.delete(statusPath);
}

function writeStatusForRecords(manifest: TeamRunManifest, records: CrewAgentRecord[]): void {
	lastSaveStatusWriteCount = 0;
	for (const record of records) {
		// H2 (2026-08-10): per-task status.json is a DENORMALIZED read
		// optimization for the dashboard/notifier, not an authoritative
		// record — agents.json + events.jsonl cover crash recovery.
		// Previously EVERY record (including running/queued progress
		// snapshots) got a full fsync: N+1 fsyncs per saveCrewAgents call
		// (50-task team ≈ 750ms blocking). Only TERMINAL records keep
		// full durability (F4: notifier/dashboard must see the final
		// state immediately); non-terminal per-task status is best-effort
		// coalesced like the upsertCrewAgent non-terminal path.
		if (TERMINAL_AGENT_STATUSES.has(record.status ?? "")) {
			if (!needsDurableStatusWrite(manifest, record)) continue;
			lastSaveStatusWriteCount++;
			writeCrewAgentStatus(manifest, record);
		} else {
			lastSaveStatusWriteCount++;
			writeCrewAgentStatusCoalesced(manifest, record);
		}
	}
}

export function saveCrewAgents(manifest: TeamRunManifest, records: CrewAgentRecord[]): void {
	// P0-3: flush any pending coalesced (best-effort) write first so a stale
	// debounced progress snapshot can't clobber this durable write.
	flushPendingAgentWrites(manifest, records);
	withAgentsLock(manifest, () => {
		fs.mkdirSync(manifest.stateRoot, { recursive: true });
		const filePath = agentsPath(manifest);
		// Index file (agents.json) is the authoritative record — always full
		// durability.
		atomicWriteJson(filePath, redactSecrets(records));
		asyncAgentReaderCache.delete(filePath);
		writeStatusForRecords(manifest, records);
	});
}

const TERMINAL_AGENT_STATUSES = new Set(["completed", "failed", "cancelled", "blocked"]);

/**
 * User policy (v0.9.16): cancelled / stopped crew-agent records leave NO trace.
 * `failed` records keep their audit trail (different from cancel — agent errored).
 */
export function shouldDeleteCrewAgentOnTerminalStatus(record: Pick<CrewAgentRecord, "status">): boolean {
	const s = record.status;
	return s === "cancelled" || s === "stopped";
}

/**
 * Remove a single crew-agent record from both `agents.json` (the index file)
 * and the per-task `status.json`. Called on cancellation to wipe the trace.
 * Safe-fail: missing files are treated as success (already removed).
 */
export function removeCrewAgent(manifest: TeamRunManifest, taskId: string): { removedIndex: boolean; removedStatus: boolean } {
	let removedIndex = false;
	let removedStatus = false;
	// 1. Remove from agents.json index
	try {
		const existing = readCrewAgents(manifest);
		const filtered = existing.filter((r) => r.taskId !== taskId);
		if (filtered.length !== existing.length) {
			saveCrewAgents(manifest, filtered);
			removedIndex = true;
		}
	} catch {
		// best-effort
	}
	// 2. Remove per-task status.json
	try {
		const statusPath = agentStatusPath(manifest, taskId);
		// F10 / RR-016: cancel the pending coalesced status write for THIS exact
		// path BEFORE unlinking. The record was just dropped from the index, so
		// `flushPendingAgentWrites` (which only iterates records still in the
		// index) will never drain — or cancel — its buffered write. Without this
		// the 250ms timer fired AFTER the unlink and RE-CREATED the file with the
		// stale pre-cancel snapshot (measured: status.json reappearing as
		// `status:"running"` after the exit drain while agents.json stayed empty).
		cancelPendingCoalescedWriteForPath(statusPath);
		forgetWrittenStatus(statusPath);
		if (fs.existsSync(statusPath)) {
			fs.unlinkSync(statusPath);
			removedStatus = true;
		}
	} catch {
		// best-effort
	}
	return { removedIndex, removedStatus };
}

export function upsertCrewAgent(manifest: TeamRunManifest, record: CrewAgentRecord): void {
	// Guard: skip if run state has been deleted (prune/forget/cleanup)
	try {
		fs.statSync(manifest.stateRoot);
	} catch {
		return;
	}
	// User policy (v0.9.16): cancelled / stopped crew agents leave NO trace.
	// We delete BOTH the index entry (agents.json) and the per-task status.json
	// immediately so the UI dashboard/widget never see the cancelled agent again.
	if (shouldDeleteCrewAgentOnTerminalStatus(record)) {
		removeCrewAgent(manifest, record.taskId);
		// Invalidate the per-task reader cache so a subsequent read sees fresh state.
		asyncAgentReaderCache.delete(agentsPath(manifest));
		return;
	}
	// Read current state
	const existing = readCrewAgents(manifest);
	// Deduplicate by id: keep newer record when same id appears
	const idIndex = new Map(existing.map((item, i) => [item.id, i]));
	const merged: CrewAgentRecord[] = existing.map((item) => (item.id === record.id ? record : item));
	if (!idIndex.has(record.id)) merged.push(record);
	// 2.5 caller migration: coalesce non-terminal progress writes; flush
	// terminal statuses (completed/failed/cancelled/blocked) durably so
	// downstream (notifier, dashboard health) sees them immediately.
	if (TERMINAL_AGENT_STATUSES.has(record.status ?? "")) {
		saveCrewAgents(manifest, merged);
		writeCrewAgentStatus(manifest, record);
	} else {
		saveCrewAgentsCoalesced(manifest, merged);
		writeCrewAgentStatusCoalesced(manifest, record);
	}
}

export function writeCrewAgentStatus(manifest: TeamRunManifest, record: CrewAgentRecord): void {
	ensureAgentStateDir(manifest, record.taskId);
	// F4: terminal agent status (completed/failed/cancelled/blocked) — keep full
	// durability so the notifier/dashboard health sees the final state immediately.
	atomicWriteJson(agentStatusPath(manifest, record.taskId), redactSecrets(record), { durability: "full" });
	// F06/RR-017: record the DURABLE snapshot so a later save can skip re-writing
	// byte-identical content for this record (see writeStatusForRecords). Only
	// durable writes memoize — a coalesced write may never reach disk.
	rememberWrittenStatus(manifest, record);
}

// 2.5 — coalesced variants. Buffer per-agent record + aggregate writes for
// 250 ms. High-frequency progress updates collapse to one write per quiescence
// window. Caller migration is opt-in; existing saveCrewAgents/
// writeCrewAgentStatus remain durable for terminal events.
const AGENT_COALESCE_MS = 250;

export function saveCrewAgentsCoalesced(manifest: TeamRunManifest, records: CrewAgentRecord[]): void {
	const filePath = agentsPath(manifest);
	fs.mkdirSync(manifest.stateRoot, { recursive: true });
	// F4: progress write — best-effort is safe because the terminal
	// writeCrewAgentStatus above remains durable and the notifier watches the
	// events.jsonl independently of these JSON files.
	atomicWriteJsonCoalesced(filePath, redactSecrets(records), AGENT_COALESCE_MS, { durability: "best-effort" });
	asyncAgentReaderCache.delete(filePath);
	writeStatusForRecords(manifest, records);
}

export function writeCrewAgentStatusCoalesced(manifest: TeamRunManifest, record: CrewAgentRecord): void {
	ensureAgentStateDir(manifest, record.taskId);
	atomicWriteJsonCoalesced(agentStatusPath(manifest, record.taskId), redactSecrets(record), AGENT_COALESCE_MS, {
		durability: "best-effort",
	});
}

/** @internal Flush coalesced agent-record writes synchronously. Hook into cleanup paths. */
function flushPendingAgentWrites(manifest: TeamRunManifest, records: CrewAgentRecord[]): void {
	// R10-2: scope the pre-durable-save flush to the agent-record files this
	// save can be clobbered by (agents.json + the per-task status.json files).
	// Unrelated coalesced writes (tasks.json, other runs) stay pending on their
	// own timers — draining them here only added latency to this path.
	flushPendingAtomicWrites(agentsPath(manifest));
	for (const record of records) flushPendingAtomicWrites(agentStatusPath(manifest, record.taskId));
}

export function readCrewAgentStatus(manifest: TeamRunManifest, taskOrAgentId: string): CrewAgentRecord | undefined {
	try {
		return readJsonFile<CrewAgentRecord>(safeExistingAgentFile(manifest, taskOrAgentId, "status.json"));
	} catch {
		return undefined;
	}
}

const agentEventSeqCache = new Map<string, { size: number; mtimeMs: number; seq: number }>();
// FIX (Round 22, defensive cap): Bound the per-file-path cache. Without a cap,
// a long-running pi-crew process that spawns 1000s of agents accumulates 1000s
// of entries. Mirrors the `asyncAgentReaderCache` pattern (above) and the
// `NotificationRouter.SEEN_MAP_MAX_SIZE` pattern.
const AGENT_EVENT_SEQ_CACHE_MAX_ENTRIES = 1000;
const AGENT_EVENT_SEQ_SIDECAR = ".seq";

/**
 * Set an entry in the seq cache, evicting the oldest entries when the cache
 * exceeds the cap. Map's natural insertion order means the first key is the
 * oldest — same as the pattern used in `asyncAgentReaderCache`.
 */
function setAgentEventSeqCache(filePath: string, entry: { size: number; mtimeMs: number; seq: number }): void {
	if (agentEventSeqCache.has(filePath)) agentEventSeqCache.delete(filePath);
	agentEventSeqCache.set(filePath, entry);
	while (agentEventSeqCache.size > AGENT_EVENT_SEQ_CACHE_MAX_ENTRIES) {
		const oldest = agentEventSeqCache.keys().next().value;
		if (oldest === undefined) break;
		agentEventSeqCache.delete(oldest);
	}
}

function readSeqFromSidecar(filePath: string): number | undefined {
	try {
		const raw = fs.readFileSync(`${filePath}.${AGENT_EVENT_SEQ_SIDECAR}`, "utf-8");
		const n = Number.parseInt(raw, 10);
		return Number.isFinite(n) && n > 0 ? n : undefined;
	} catch {
		return undefined;
	}
}

function writeSeqToSidecar(filePath: string, seq: number): void {
	try {
		fs.writeFileSync(`${filePath}.${AGENT_EVENT_SEQ_SIDECAR}`, String(seq));
	} catch (error) {
		logInternalError("crew-agent-records.seq-sidecar", error, `filePath=${filePath}`);
	}
}

function nextAgentEventSeq(filePath: string): number {
	if (!fs.existsSync(filePath)) {
		// Clean up stale sidecar when main file is gone.
		try {
			fs.unlinkSync(`${filePath}.${AGENT_EVENT_SEQ_SIDECAR}`);
		} catch (error) {
			logInternalError("crew-agent-records.unlink-sidecar", error, `filePath=${filePath}`, "debug");
		}
		return 1;
	}
	const stat = fs.statSync(filePath);
	const cached = agentEventSeqCache.get(filePath);
	if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.seq + 1;
	// FIX: Try sidecar file for O(1) lookup before falling back to O(n) scan.
	const sidecarSeq = readSeqFromSidecar(filePath);
	if (sidecarSeq !== undefined) {
		setAgentEventSeqCache(filePath, {
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			seq: sidecarSeq,
		});
		return sidecarSeq + 1;
	}
	let max = 0;
	for (const line of fs.readFileSync(filePath, "utf-8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as { seq?: unknown };
			if (typeof parsed.seq === "number" && Number.isFinite(parsed.seq)) max = Math.max(max, parsed.seq);
			else max += 1;
		} catch {
			max += 1;
		}
	}
	setAgentEventSeqCache(filePath, {
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		seq: max,
	});
	writeSeqToSidecar(filePath, max);
	return max + 1;
}

export function appendCrewAgentEvent(manifest: TeamRunManifest, taskId: string, event: unknown): void {
	// Mixed-usage guard: if a buffered batch is pending for this task, land it
	// first so seq allocation stays monotonic and file order matches seq order
	// (reader cursors advance by seq in file order).
	flushCrewAgentRecordBuffer(manifest, taskId);
	ensureAgentStateDir(manifest, taskId);
	const filePath = agentStateFile(manifest, taskId, "events.jsonl");
	const seq = nextAgentEventSeq(filePath);
	fs.appendFileSync(filePath, `${JSON.stringify(redactSecrets({ seq, time: new Date().toISOString(), event }))}\n`, "utf-8");
	try {
		const stat = fs.statSync(filePath);
		setAgentEventSeqCache(filePath, {
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			seq,
		});
		writeSeqToSidecar(filePath, seq);
	} catch (error) {
		logInternalError("crew-agent-records.stat", error, `filePath=${filePath}`);
	}
}

export interface CrewAgentEventCursorOptions {
	sinceSeq?: number;
	limit?: number;
}

/** @internal Convenience wrapper around readCrewAgentEventsCursor. */
function readCrewAgentEvents(manifest: TeamRunManifest, taskId: string): unknown[] {
	return readCrewAgentEventsCursor(manifest, taskId).events;
}

// ---------------------------------------------------------------------------
// F07 / RR-017: incremental agent-event cursor.
//
// The legacy reader did `readFileSync → split → JSON.parse each line → filter →
// slice`, applying `sinceSeq`/`limit` only AFTER reading and parsing the WHOLE
// file. Measured on a 10000-event file: 697788 bytes read per IDLE poll, linear
// in file size, and the inline panel polls it every 700 ms
// (src/ui/inline-panel/index.ts:46, consumer agent-transcript.ts:291).
//
// The fix REUSES the existing incremental primitive
// (`readLinesSince` in src/utils/incremental-reader.ts — the same module
// src/state/event-log/cursor.ts uses) instead of adding a new reader. A per-path
// watermark holds `{byteOffset, lineCount, prefixMaxSeq, size, mtimeMs, ino,
// dev}` — O(1) memory per path, bounded to 512 paths:
//   - idle poll (unchanged size/mtimeMs/inode): ZERO event bytes read;
//   - append: reads only the delta [byteOffset, size);
//   - shrink (truncation) or inode replacement (rotation/rewrite): the watermark
//     is discarded and the file is re-read from 0 — the same "rewrite-then-
//     regrow" hole cursor.ts closes with inode stamping.
//
// WHY A PREFIX IS NEVER RE-READ (soundness): the cached prefix is the set of
// events already consumed before `byteOffset`. `prefixMaxSeq` is the maximum seq
// seen in that prefix, so EVERY prefix event satisfies `seq <= prefixMaxSeq`.
// When `sinceSeq >= prefixMaxSeq`, no prefix event can pass the
// `seq > sinceSeq` filter, so the answer is exactly "the delta's matches" —
// provable without assuming file order equals seq order. When
// `sinceSeq < prefixMaxSeq` the reader falls back to a full read from 0, so
// correctness never depends on the bound being tight.
//
// LEGACY SEQ SEMANTICS ARE PRESERVED EXACTLY: a line without a numeric `seq`
// gets `seq = lineIndex + 1`, where lineIndex is the index of that line among
// the file's NON-EMPTY lines. `readLinesSince` only increments `lineCount` for
// non-empty lines, so a delta's absolute base index is the cached `lineCount`
// and the parity holds without re-reading from offset 0.
//
// A trailing fragment without "\n" (a mid-append partial line) is held back by
// `readLinesSince` (it does not advance the committed offset past it), so it is
// neither lost nor parsed as a torn event — the next poll sees the completed
// line. Every writer of this file appends a trailing "\n", so this only ever
// defers a mid-write fragment.
// ---------------------------------------------------------------------------

interface AgentEventsCursorState {
	byteOffset: number;
	lineCount: number;
	/** Max seq among events already consumed before `byteOffset`. */
	prefixMaxSeq: number;
	size: number;
	mtimeMs: number;
	ino: number;
	dev: number;
}

const agentEventsCursorCache = new Map<string, AgentEventsCursorState>();
const AGENT_EVENTS_CURSOR_CACHE_MAX_ENTRIES = 512;

// F07 test hook (AC-5/AC-6/AC-11): bytes of event payload the cursor actually
// read. The tests assert STRUCTURALLY (bytes read, not wall-clock), so the
// reader exposes this counter instead of the suite monkey-patching `node:fs`
// (whose ESM named exports are frozen). Mirrors the `__test__agentRecordBufferCount`
// precedent in this file. Only the incremental read path increments it.
let agentEventBytesRead = 0;

/** @internal Test-only: reset the F07 byte counter. */
export function __test__resetAgentEventBytesRead(): void {
	agentEventBytesRead = 0;
}

/** @internal Test-only: event-file bytes read since the last reset. */
export function __test__agentEventBytesRead(): number {
	return agentEventBytesRead;
}

/** @internal Test-only: drop the per-path incremental cursor watermarks. */
export function __test__clearAgentEventsCursorCache(): void {
	agentEventsCursorCache.clear();
}

/** @internal Test-only: inspect a watermark (undefined when uncached). */
export function __test__agentEventsCursorState(filePath: string): AgentEventsCursorState | undefined {
	return agentEventsCursorCache.get(filePath);
}

function setAgentEventsCursorState(filePath: string, state: AgentEventsCursorState): void {
	if (agentEventsCursorCache.has(filePath)) agentEventsCursorCache.delete(filePath);
	agentEventsCursorCache.set(filePath, state);
	while (agentEventsCursorCache.size > AGENT_EVENTS_CURSOR_CACHE_MAX_ENTRIES) {
		const oldest = agentEventsCursorCache.keys().next().value;
		if (oldest === undefined) break;
		agentEventsCursorCache.delete(oldest);
	}
}

/**
 * Parse raw JSONL lines into cursor events, assigning the legacy `seq = index+1`
 * fallback for lines that carry no numeric seq. `lineIndexBase` is the index of
 * the FIRST line in this batch among the file's non-empty lines (0 when reading
 * from offset 0).
 *
 * A single trailing "\r" is stripped so CRLF files behave like the legacy
 * `split(/\r?\n/)` reader (JSON.parse tolerates it either way; the difference
 * only shows up in the `raw` payload of an already-corrupt line).
 */
function parseAgentEventLines(lines: string[], lineIndexBase: number): { events: Array<Record<string, unknown>>; maxSeq: number } {
	const events: Array<Record<string, unknown>> = [];
	let maxSeq = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const raw = lines[index]!;
		const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		const lineIndex = lineIndexBase + index;
		let event: Record<string, unknown>;
		try {
			const parsed = JSON.parse(text) as unknown;
			event = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { seq: lineIndex + 1, raw: text };
			if (typeof event.seq !== "number") event.seq = lineIndex + 1;
		} catch {
			event = { seq: lineIndex + 1, raw: text };
		}
		events.push(event);
		if (typeof event.seq === "number" && event.seq > maxSeq) maxSeq = event.seq;
	}
	return { events, maxSeq };
}

/**
 * Read the agent events file, consuming only the bytes that are new since the
 * last read of this path, and return every event with `seq > sinceSeq` (the
 * legacy `total` is this array's length before `limit` is applied).
 */
function readAgentEventMatches(filePath: string, sinceSeq: number): Array<Record<string, unknown>> {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return [];
	}
	const cached = agentEventsCursorCache.get(filePath);
	const sameFile = cached !== undefined && cached.ino === stat.ino && cached.dev === stat.dev;
	// A shrink (truncate) or an inode change (rotation / rewrite) invalidates the
	// byte offset: the new content must be read from 0 or events are lost.
	const usable = sameFile && stat.size > cached.byteOffset;
	const canServeDelta = usable && sinceSeq >= cached.prefixMaxSeq;
	const canServeIdle = sameFile && stat.size === cached.byteOffset && stat.mtimeMs === cached.mtimeMs && sinceSeq >= cached.prefixMaxSeq;

	if (canServeIdle) {
		// Nothing changed AND no prefix event can pass the filter — no bytes read.
		return [];
	}

	const baseOffset = canServeDelta ? cached.byteOffset : 0;
	const baseLineCount = canServeDelta ? cached.lineCount : 0;
	const baseMaxSeq = canServeDelta ? cached.prefixMaxSeq : 0;
	const result = readLinesSince(filePath, { byteOffset: baseOffset, lineCount: baseLineCount });
	// `readLinesSince` reads [state.byteOffset, fileSize); account for the bytes
	// it requested (a held-back trailing fragment is still READ, just not parsed).
	agentEventBytesRead += Math.max(0, stat.size - baseOffset);
	const { events, maxSeq } = parseAgentEventLines(result.lines, baseLineCount);
	const nextSeqInFile = Math.max(baseMaxSeq, maxSeq);
	setAgentEventsCursorState(filePath, {
		byteOffset: result.state.byteOffset,
		lineCount: result.state.lineCount,
		prefixMaxSeq: nextSeqInFile,
		// `Math.max` covers a concurrent append that landed between the stat above
		// and the read: storing the SMALLER (stale) size would make the next poll
		// see `size === byteOffset` and needlessly re-read the whole file.
		size: Math.max(stat.size, result.state.byteOffset),
		mtimeMs: stat.mtimeMs,
		ino: stat.ino,
		dev: stat.dev,
	});

	// `events` is the whole-file parse when we could not serve a delta, and the
	// delta-only parse otherwise — either way it holds EVERY event with
	// seq > sinceSeq, because in the delta case the prefix is provably all <= sinceSeq.
	return events.filter((event) => typeof event.seq === "number" && event.seq > sinceSeq);
}

export function readCrewAgentEventsCursor(
	manifest: TeamRunManifest,
	taskId: string,
	options: CrewAgentEventCursorOptions = {},
): { path: string; events: unknown[]; nextSeq: number; total: number } {
	let filePath: string;
	try {
		filePath = agentEventsPath(manifest, taskId);
	} catch {
		return {
			path: "",
			events: [],
			nextSeq: options.sinceSeq ?? 0,
			total: 0,
		};
	}
	if (!fs.existsSync(filePath))
		return {
			path: filePath,
			events: [],
			nextSeq: options.sinceSeq ?? 0,
			total: 0,
		};
	try {
		filePath = safeExistingAgentFile(manifest, taskId, "events.jsonl");
	} catch {
		return {
			path: "",
			events: [],
			nextSeq: options.sinceSeq ?? 0,
			total: 0,
		};
	}
	const sinceSeq =
		typeof options.sinceSeq === "number" && Number.isInteger(options.sinceSeq) && options.sinceSeq >= 0 ? options.sinceSeq : 0;
	const limit = typeof options.limit === "number" && Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : undefined;

	const filtered = readAgentEventMatches(filePath, sinceSeq);
	const events = limit !== undefined ? filtered.slice(0, limit) : filtered;
	const returnedMaxSeq = events.reduce((max, event) => (typeof event.seq === "number" ? Math.max(max, event.seq) : max), sinceSeq);
	return {
		path: filePath,
		events,
		nextSeq: returnedMaxSeq,
		total: filtered.length,
	};
}

export function appendCrewAgentOutput(manifest: TeamRunManifest, taskId: string, text: string): void {
	if (!text.trim()) return;
	// Mixed-usage guard (see appendCrewAgentEvent): land any pending buffered
	// lines first so buffered/direct lines never interleave out of order.
	flushCrewAgentRecordBuffer(manifest, taskId);
	ensureAgentStateDir(manifest, taskId);
	fs.appendFileSync(agentStateFile(manifest, taskId, "output.log"), `${redactSecretString(text)}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// R10-5 (Wave 2B item 4): per-task batching for the agent-record append sinks.
// ---------------------------------------------------------------------------
// child-executor's hot path previously did, PER CHILD EVENT:
//   appendCrewAgentEvent  -> nextAgentEventSeq (stat + sidecar read) + appendFileSync
//   appendCrewAgentOutput -> appendFileSync
// (~4 syscalls/event after the P1-5 path memo, ×N events/task). The buffered
// variants below collapse adjacent appends into ONE appendFileSync per flush.
// Flush triggers: task boundary (child-executor finally), process exit / signal,
// 32-event cap, or the 250ms window timer — whichever comes first.
//
// CRASH-WINDOW TRADEOFF (deliberate, documented): buffering widens the SIGKILL
// loss window for AGENT PROGRESS events to <=250ms (AGENT_RECORD_BUFFER_WINDOW_MS
// below) instead of 0. Precedent: the event-log coalescer already accepts a
// documented 50ms loss window for non-terminal task.progress events; agent
// events.jsonl/output.log lines are the same class of re-derivable progress
// telemetry — authoritative terminal state lives in tasks.json/agents.json,
// which stay on their existing durable/coalesced-atomic paths. Durable
// artifacts (result.md, steering, run-level events.jsonl) are NOT routed
// through this buffer.
//
// SEQUENCE-NUMBER CORRECTNESS: seqs are RESERVED from nextAgentEventSeq() at
// the first buffered event and incremented in memory, so buffered events can
// never collide with each other, and the post-flush seq cache + sidecar are
// updated with the last reserved seq exactly like a direct append. The direct
// appendCrewAgentEvent()/appendCrewAgentOutput() flush any pending buffer for
// the task BEFORE appending, so a mixed buffered/direct caller can neither
// double-allocate a seq nor land a higher-seq line before lower-seq buffered
// lines. Within pi-crew a task's sinks have exactly one writer at a time
// (child-executor OR live-executor, never both), so that guard is
// defense-in-depth, not a load-bearing lock.
//
// v0.9.26 lesson (event-log.ts:237,416-425): this buffer is for the AGENT
// record sinks ONLY — core run events.jsonl appends must NOT be routed
// through buffered machinery.
const AGENT_RECORD_BUFFER_MAX_EVENTS = 32;
const AGENT_RECORD_BUFFER_WINDOW_MS = 250;

interface AgentRecordBuffer {
	manifest: TeamRunManifest;
	taskId: string;
	events: string[];
	output: string[];
	lastReservedSeq: number; // 0 = not yet reserved from disk state
	timer?: NodeJS.Timeout;
}
const agentRecordBuffers = new Map<string, AgentRecordBuffer>();

function agentRecordBufferKey(manifest: TeamRunManifest, taskId: string): string {
	return `${manifest.stateRoot}\0${safeAgentTaskId(taskId)}`;
}

function flushAgentRecordBuffer(buffer: AgentRecordBuffer): void {
	const { manifest, taskId } = buffer;
	if (buffer.timer) {
		clearTimeout(buffer.timer);
		buffer.timer = undefined;
	}
	if (buffer.events.length > 0) {
		const filePath = agentStateFile(manifest, taskId, "events.jsonl");
		try {
			fs.appendFileSync(filePath, buffer.events.join(""), "utf-8");
			// Mirror appendCrewAgentEvent's post-append bookkeeping so subsequent
			// nextAgentEventSeq calls (direct or buffered) see the reserved seqs.
			const stat = fs.statSync(filePath);
			setAgentEventSeqCache(filePath, {
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				seq: buffer.lastReservedSeq,
			});
			writeSeqToSidecar(filePath, buffer.lastReservedSeq);
		} catch (error) {
			// Best-effort progress telemetry: a fs failure here (e.g. run dir
			// deleted by prune/forget) must not fail the task; drop the batch.
			logInternalError("crew-agent-records.buffered-events-flush", error, `filePath=${filePath}`);
		}
	}
	if (buffer.output.length > 0) {
		try {
			fs.appendFileSync(agentStateFile(manifest, taskId, "output.log"), buffer.output.join(""), "utf-8");
		} catch (error) {
			logInternalError("crew-agent-records.buffered-output-flush", error, `taskId=${taskId}`);
		}
	}
	buffer.events.length = 0;
	buffer.output.length = 0;
	buffer.lastReservedSeq = 0;
	agentRecordBuffers.delete(agentRecordBufferKey(manifest, taskId));
}

/**
 * Flush any pending buffered agent-record appends for `taskId` synchronously.
 * Task-boundary hook — child-executor calls this at attempt completion/failure
 * and process exit so no buffered line outlives the task.
 */
export function flushCrewAgentRecordBuffer(manifest: TeamRunManifest, taskId: string): void {
	const buffer = agentRecordBuffers.get(agentRecordBufferKey(manifest, taskId));
	if (buffer) flushAgentRecordBuffer(buffer);
}

/** @internal Flush ALL buffered agent-record writes (process-exit / signal hook). */
export function flushAllCrewAgentRecordBuffers(): void {
	for (const buffer of [...agentRecordBuffers.values()]) flushAgentRecordBuffer(buffer);
}

export function appendCrewAgentEventBuffered(manifest: TeamRunManifest, taskId: string, event: unknown): void {
	const filePath = agentStateFile(manifest, taskId, "events.jsonl");
	const key = agentRecordBufferKey(manifest, taskId);
	let buffer = agentRecordBuffers.get(key);
	if (!buffer) {
		buffer = { manifest, taskId, events: [], output: [], lastReservedSeq: 0 };
		agentRecordBuffers.set(key, buffer);
	}
	if (buffer.lastReservedSeq === 0) {
		// Reserve the next seq ONCE from the on-disk state; further buffered
		// events increment in memory (no per-event stat/sidecar read).
		buffer.lastReservedSeq = nextAgentEventSeq(filePath) - 1;
	}
	const seq = ++buffer.lastReservedSeq;
	buffer.events.push(`${JSON.stringify(redactSecrets({ seq, time: new Date().toISOString(), event }))}\n`);
	scheduleAgentRecordBufferFlush(buffer);
}

export function appendCrewAgentOutputBuffered(manifest: TeamRunManifest, taskId: string, text: string): void {
	if (!text.trim()) return;
	// Ensure the state dir at BUFFER time (the event variant gets this for free
	// via agentStateFile): fs.appendFileSync at flush time does NOT create parent
	// dirs, so an output-only task with no events buffered yet would drop its
	// whole batch on ENOENT. Memoized (ensuredAgentDirs) — one mkdir per task,
	// not per line — preserving the R10-5 batching win.
	ensureAgentStateDir(manifest, taskId);
	const key = agentRecordBufferKey(manifest, taskId);
	let buffer = agentRecordBuffers.get(key);
	if (!buffer) {
		buffer = { manifest, taskId, events: [], output: [], lastReservedSeq: 0 };
		agentRecordBuffers.set(key, buffer);
	}
	buffer.output.push(`${redactSecretString(text)}\n`);
	scheduleAgentRecordBufferFlush(buffer);
}

function scheduleAgentRecordBufferFlush(buffer: AgentRecordBuffer): void {
	// Cap: flush now so buffer memory and the crash window stay bounded.
	if (buffer.events.length >= AGENT_RECORD_BUFFER_MAX_EVENTS || buffer.output.length >= AGENT_RECORD_BUFFER_MAX_EVENTS) {
		flushAgentRecordBuffer(buffer);
		return;
	}
	// Window: a REAL (unref'd) timer enforces the <=250ms loss-window bound even
	// when no further events arrive (lazy check-on-next-append would not).
	if (!buffer.timer) {
		buffer.timer = setTimeout(() => {
			buffer.timer = undefined;
			flushAgentRecordBuffer(buffer);
		}, AGENT_RECORD_BUFFER_WINDOW_MS);
		buffer.timer.unref();
	}
}

// Defense-in-depth (mirrors atomic-write.ts): land buffered agent-record lines
// on normal process exit and best-effort on termination signals.
/** @internal Test-only: number of pending buffered agent-record batches. */
export function __test__agentRecordBufferCount(): number {
	return agentRecordBuffers.size;
}

process.on("exit", () => flushAllCrewAgentRecordBuffers());
process.on("SIGTERM", () => setImmediate(() => flushAllCrewAgentRecordBuffers()));
process.on("SIGINT", () => setImmediate(() => flushAllCrewAgentRecordBuffers()));

export function emptyCrewAgentProgress(): CrewAgentProgress {
	return { recentTools: [], recentOutput: [], toolCount: 0 };
}

function modelFromTask(task: TeamTaskState): string | undefined {
	const attempts = task.modelAttempts;
	if (!attempts?.length) return undefined;
	return attempts.find((attempt) => attempt.success)?.model ?? attempts.at(-1)?.model;
}

export function recordFromTask(manifest: TeamRunManifest, task: TeamTaskState, runtime: CrewRuntimeKind): CrewAgentRecord {
	return {
		id: `${manifest.runId}:${task.id}`,
		runId: manifest.runId,
		taskId: task.id,
		agent: task.agent,
		role: task.role,
		runtime,
		status: taskStatusToAgentStatus(task.status),
		startedAt: task.startedAt ?? new Date().toISOString(),
		completedAt: task.finishedAt,
		resultArtifactPath: task.resultArtifact?.path,
		transcriptPath: task.transcriptArtifact?.path ?? task.logArtifact?.path,
		statusPath: agentStatusPath(manifest, task.id),
		eventsPath: agentEventsPath(manifest, task.id),
		outputPath: agentOutputPath(manifest, task.id),
		toolUses: task.agentProgress?.toolCount,
		jsonEvents: task.jsonEvents,
		model: modelFromTask(task),
		routing: task.modelRouting,
		usage: task.usage,
		progress: task.agentProgress,
		error: task.error,
	};
}
