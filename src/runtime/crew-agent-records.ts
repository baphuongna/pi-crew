import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { atomicWriteJson, atomicWriteJsonCoalesced, flushPendingAtomicWrites, readJsonFile } from "../state/atomic-write.ts";
import { readJsonFileCoalesced } from "../utils/file-coalescer.ts";
import type { CrewAgentProgress, CrewAgentRecord, CrewRuntimeKind } from "./crew-agent-runtime.ts";
import { taskStatusToAgentStatus } from "./crew-agent-runtime.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { assertSafePathId, resolveRealContainedPath } from "../utils/safe-paths.ts";
import { redactSecretString, redactSecrets } from "../utils/redaction.ts";
import { sleepSync } from "../utils/sleep.ts";

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

export function ensureAgentStateDir(manifest: TeamRunManifest, taskId: string): string {
	const root = agentsRoot(manifest);
	fs.mkdirSync(root, { recursive: true });
	if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`Invalid agents root: ${root}`);
	const dir = agentStateDir(manifest, taskId);
	fs.mkdirSync(dir, { recursive: true });
	if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Invalid agent state directory: ${dir}`);
	resolveRealContainedPath(root, path.basename(dir));
	return dir;
}

function safeExistingAgentFile(manifest: TeamRunManifest, taskId: string, fileName: string): string {
	const filePath = path.join(agentStateDir(manifest, taskId), fileName);
	if (!fs.existsSync(filePath)) return filePath;
	if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`Invalid agent state file: ${filePath}`);
	return resolveRealContainedPath(agentsRoot(manifest), path.join(safeAgentTaskId(taskId), fileName));
}

export function agentStateFile(manifest: TeamRunManifest, taskId: string, fileName: string): string {
	ensureAgentStateDir(manifest, taskId);
	return safeExistingAgentFile(manifest, taskId, fileName);
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

const asyncAgentReaderCache = new Map<string, { expiresAt: number; records: CrewAgentRecord[]; inFlight?: Promise<CrewAgentRecord[]> }>();

function agentsLockPath(manifest: TeamRunManifest): string {
	return `${agentsPath(manifest)}.lock`;
}

function removeStaleAgentsLock(lockPath: string, staleMs: number): boolean {
	try {
		const stat = fs.statSync(lockPath);
		if (stat.size > 1024) return false;
		const raw = fs.readFileSync(lockPath, "utf-8");
		const parsed = JSON.parse(raw) as { createdAt?: unknown; pid?: unknown };
		const createdAt = typeof parsed.createdAt === "string" ? Date.parse(parsed.createdAt) : NaN;
		if (Number.isFinite(createdAt) && Date.now() - createdAt <= staleMs) return false;
		const pid = typeof parsed.pid === "number" ? parsed.pid : undefined;
		if (pid && pid !== process.pid) {
			try { process.kill(pid, 0); return false; } catch { /* owner dead */ }
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
				fs.writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
			} finally {
				fs.closeSync(fd);
			}
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "EISDIR") throw error;
			if (code === "EISDIR") {
				try { fs.rmSync(filePath, { recursive: true, force: true }); } catch { /* ignore */ }
				continue;
			}
			if (!removeStaleAgentsLock(filePath, AGENTS_LOCK_STALE_MS) && Date.now() > deadline) throw new Error(`Crew agents file is locked by another operation: ${agentsPath(manifest)}`);
			sleepSync(Math.min(250, 25 * 2 ** attempt));
			attempt += 1;
		}
	}
	try {
		return fn();
	} finally {
		try { fs.rmSync(filePath, { force: true }); } catch { /* best-effort */ }
	}
}

function setAsyncAgentReaderCache(filePath: string, entry: { expiresAt: number; records: CrewAgentRecord[]; inFlight?: Promise<CrewAgentRecord[]> }): void {
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
	try {
		const records = readJsonFileCoalesced(agentsPath(manifest), AGENT_READER_TTL_MS, () => readJsonFile<CrewAgentRecord[]>(agentsPath(manifest)) ?? []);
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
			const raw = Array.isArray(parsed) ? redactSecrets(parsed) as CrewAgentRecord[] : [];
			// Deduplicate by id to handle concurrent write conflicts
			const seen = new Set<string>();
			const deduped = raw.filter((r) => {
				if (!r || typeof r.id !== "string" || typeof r.taskId !== "string") return false;
				if (seen.has(r.id)) return false;
				seen.add(r.id);
				return true;
			});
			if (deduped.length !== raw.length) {
				try { saveCrewAgents(manifest, deduped); } catch { /* best-effort */ }
			}
			setAsyncAgentReaderCache(filePath, { expiresAt: Date.now() + AGENT_READER_TTL_MS, records: deduped });
			return deduped;
		} catch {
			setAsyncAgentReaderCache(filePath, { expiresAt: Date.now() + AGENT_READER_TTL_MS, records: [] });
			return [];
		}
	})();
	setAsyncAgentReaderCache(filePath, { expiresAt: now + AGENT_READER_TTL_MS, records: cached?.records ?? [], inFlight });
	return inFlight;
}

export function saveCrewAgents(manifest: TeamRunManifest, records: CrewAgentRecord[]): void {
	withAgentsLock(manifest, () => {
		fs.mkdirSync(manifest.stateRoot, { recursive: true });
		const filePath = agentsPath(manifest);
		atomicWriteJson(filePath, redactSecrets(records));
		asyncAgentReaderCache.delete(filePath);
		for (const record of records) writeCrewAgentStatus(manifest, record);
	});
}

const TERMINAL_AGENT_STATUSES = new Set(["completed", "failed", "cancelled", "blocked"]);

export function upsertCrewAgent(manifest: TeamRunManifest, record: CrewAgentRecord): void {
	// Read current state
	const existing = readCrewAgents(manifest);
	// Deduplicate by id: keep newer record when same id appears
	const idIndex = new Map(existing.map((item, i) => [item.id, i]));
	const merged: CrewAgentRecord[] = existing.map((item) => item.id === record.id ? record : item);
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
	atomicWriteJson(agentStatusPath(manifest, record.taskId), redactSecrets(record));
}

// 2.5 — coalesced variants. Buffer per-agent record + aggregate writes for
// 250 ms. High-frequency progress updates collapse to one write per quiescence
// window. Caller migration is opt-in; existing saveCrewAgents/
// writeCrewAgentStatus remain durable for terminal events.
const AGENT_COALESCE_MS = 250;

export function saveCrewAgentsCoalesced(manifest: TeamRunManifest, records: CrewAgentRecord[]): void {
	const filePath = agentsPath(manifest);
	fs.mkdirSync(manifest.stateRoot, { recursive: true });
	atomicWriteJsonCoalesced(filePath, redactSecrets(records), AGENT_COALESCE_MS);
	asyncAgentReaderCache.delete(filePath);
	for (const record of records) writeCrewAgentStatusCoalesced(manifest, record);
}

export function writeCrewAgentStatusCoalesced(manifest: TeamRunManifest, record: CrewAgentRecord): void {
	ensureAgentStateDir(manifest, record.taskId);
	atomicWriteJsonCoalesced(agentStatusPath(manifest, record.taskId), redactSecrets(record), AGENT_COALESCE_MS);
}

/** Flush all coalesced agent writes synchronously. Hook into cleanup paths. */
export function flushPendingAgentWrites(): void {
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

function nextAgentEventSeq(filePath: string): number {
	if (!fs.existsSync(filePath)) return 1;
	const stat = fs.statSync(filePath);
	const cached = agentEventSeqCache.get(filePath);
	if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.seq + 1;
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
	agentEventSeqCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, seq: max });
	return max + 1;
}

export function appendCrewAgentEvent(manifest: TeamRunManifest, taskId: string, event: unknown): void {
	ensureAgentStateDir(manifest, taskId);
	const filePath = agentStateFile(manifest, taskId, "events.jsonl");
	const seq = nextAgentEventSeq(filePath);
	fs.appendFileSync(filePath, `${JSON.stringify(redactSecrets({ seq, time: new Date().toISOString(), event }))}\n`, "utf-8");
	try {
		const stat = fs.statSync(filePath);
		agentEventSeqCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, seq });
	} catch (error) {
		logInternalError("crew-agent-records.stat", error, `filePath=${filePath}`);
	}
}

export interface CrewAgentEventCursorOptions {
	sinceSeq?: number;
	limit?: number;
}

export function readCrewAgentEvents(manifest: TeamRunManifest, taskId: string): unknown[] {
	return readCrewAgentEventsCursor(manifest, taskId).events;
}

export function readCrewAgentEventsCursor(manifest: TeamRunManifest, taskId: string, options: CrewAgentEventCursorOptions = {}): { path: string; events: unknown[]; nextSeq: number; total: number } {
	let filePath: string;
	try {
		filePath = agentEventsPath(manifest, taskId);
	} catch {
		return { path: "", events: [], nextSeq: options.sinceSeq ?? 0, total: 0 };
	}
	if (!fs.existsSync(filePath)) return { path: filePath, events: [], nextSeq: options.sinceSeq ?? 0, total: 0 };
	try {
		filePath = safeExistingAgentFile(manifest, taskId, "events.jsonl");
	} catch {
		return { path: "", events: [], nextSeq: options.sinceSeq ?? 0, total: 0 };
	}
	const sinceSeq = typeof options.sinceSeq === "number" && Number.isInteger(options.sinceSeq) && options.sinceSeq >= 0 ? options.sinceSeq : 0;
	const limit = typeof options.limit === "number" && Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : undefined;
	const parsed = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean).map((line, index) => {
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
	const returnedMaxSeq = events.reduce((max, event) => typeof event.seq === "number" ? Math.max(max, event.seq) : max, sinceSeq);
	return { path: filePath, events, nextSeq: returnedMaxSeq, total: filtered.length };
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
