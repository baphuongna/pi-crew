import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteJson, atomicWriteJsonCoalesced, flushPendingAtomicWrites, readJsonFile } from "../state/atomic-write.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { readJsonFileCoalesced } from "../utils/file-coalescer.ts";
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
	return path.join(agentStateDir(manifest, taskId), "events.jsonl");
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
	} catch {
		return false;
	}
}

function withAgentsLock<T>(manifest: TeamRunManifest, fn: () => T): T {
	const filePath = agentsLockPath(manifest);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	let attempt = 0;
	const deadline = Date.now() + AGENTS_LOCK_STALE_MS * 2;
	while (true) {
		try {
			const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
			try {
				fs.writeSync(
					fd,
					JSON.stringify({
						pid: process.pid,
						createdAt: new Date().toISOString(),
					}),
				);
			} finally {
				fs.closeSync(fd);
			}
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "EISDIR") throw error;
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
		try {
			fs.rmSync(filePath, { force: true });
		} catch {
			/* best-effort */
		}
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
	// 2.5: ensure intra-process coalesced writes are visible to subsequent
	// readers in the same process. Cross-process readers still see the file
	// after at most one coalesce window (250 ms).
	flushPendingAtomicWrites();
	try {
		const records = readJsonFileCoalesced(
			agentsPath(manifest),
			AGENT_READER_TTL_MS,
			() => readJsonFile<CrewAgentRecord[]>(agentsPath(manifest)) ?? [],
		);
		// Validate schema and deduplicate by id to handle concurrent write conflicts
		const seen = new Set<string>();
		const deduped = records.filter((r) => {
			if (!r || typeof r.id !== "string" || typeof r.taskId !== "string") return false;
			if (seen.has(r.id)) return false;
			seen.add(r.id);
			return true;
		});
		if (deduped.length !== records.length) {
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
			if (deduped.length !== raw.length) {
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

export function saveCrewAgents(manifest: TeamRunManifest, records: CrewAgentRecord[]): void {
	// P0-3: flush any pending coalesced (best-effort) write first so a stale
	// debounced progress snapshot can't clobber this durable write.
	flushPendingAgentWrites();
	withAgentsLock(manifest, () => {
		fs.mkdirSync(manifest.stateRoot, { recursive: true });
		const filePath = agentsPath(manifest);
		// Index file (agents.json) is the authoritative record — always full
		// durability.
		atomicWriteJson(filePath, redactSecrets(records));
		asyncAgentReaderCache.delete(filePath);
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
				writeCrewAgentStatus(manifest, record);
			} else {
				writeCrewAgentStatusCoalesced(manifest, record);
			}
		}
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
	for (const record of records) writeCrewAgentStatusCoalesced(manifest, record);
}

export function writeCrewAgentStatusCoalesced(manifest: TeamRunManifest, record: CrewAgentRecord): void {
	ensureAgentStateDir(manifest, record.taskId);
	atomicWriteJsonCoalesced(agentStatusPath(manifest, record.taskId), redactSecrets(record), AGENT_COALESCE_MS, {
		durability: "best-effort",
	});
}

/** @internal Flush all coalesced agent writes synchronously. Hook into cleanup paths. */
function flushPendingAgentWrites(): void {
	flushPendingAtomicWrites();
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
	const parsed = fs
		.readFileSync(filePath, "utf-8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line, index) => {
			try {
				const event = JSON.parse(line) as Record<string, unknown>;
				if (typeof event.seq !== "number") event.seq = index + 1;
				return event;
			} catch {
				return { seq: index + 1, raw: line };
			}
		});
	const filtered = parsed.filter((event) => typeof event.seq === "number" && event.seq > sinceSeq);
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
	ensureAgentStateDir(manifest, taskId);
	fs.appendFileSync(agentStateFile(manifest, taskId, "output.log"), `${redactSecretString(text)}\n`, "utf-8");
}

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
