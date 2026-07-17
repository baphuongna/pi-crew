import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_PATHS, DEFAULT_SUBAGENT } from "../config/defaults.ts";
import type { PiTeamsToolResult } from "../extension/tool-result.ts";
import { loadRunManifestById } from "../state/state-store.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { projectCrewRoot } from "../utils/paths.ts";
import { redactSecrets } from "../utils/redaction.ts";

export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "error" | "blocked" | "stopped";

export interface SubagentSpawnOptions {
	cwd: string;
	type: string;
	description: string;
	prompt: string;
	background: boolean;
	model?: string;
	skill?: string | string[] | false;
	maxTurns?: number;
	ownerSessionGeneration?: number;
	/** Optional batch grouping id (Rule 1). Agents sharing a batchId coalesce
	 * completion notifications into one. undefined => individual (default). */
	batchId?: string;
}

export interface SubagentRecord {
	id: string;
	runId?: string;
	type: string;
	description: string;
	prompt: string;
	status: SubagentStatus;
	startedAt: number;
	completedAt?: number;
	result?: string;
	error?: string;
	resultConsumed?: boolean;
	model?: string;
	skill?: string | string[] | false;
	background: boolean;
	ownerSessionGeneration?: number;
	/** Batch grouping id (Rule 1). undefined => individual notification. */
	batchId?: string;
	stuckNotified?: boolean;
	blockedAt?: number;
	promise?: Promise<void>;
	// Phase 1.6: Telemetry baseline fields
	turnCount?: number;
	terminated?: boolean;
	durationMs?: number;
	/** Lifetime token usage accumulated via message_end events. Survives compaction. */
	lifetimeUsage?: { input: number; output: number; cacheWrite: number };
}

type SpawnRunner = (options: SubagentSpawnOptions, signal?: AbortSignal) => Promise<PiTeamsToolResult>;
type Notify = (record: SubagentRecord) => void;
type NotifyEvent = (type: string, data: Record<string, unknown>) => void;

interface QueuedSpawn {
	record: SubagentRecord;
	options: SubagentSpawnOptions;
	runner: SpawnRunner;
	signal?: AbortSignal;
}

function isValidSubagentId(id: string): boolean {
	return /^[a-z0-9_]+$/i.test(id) && id.length <= 128;
}

function persistedSubagentPath(cwd: string, id: string): string {
	if (!isValidSubagentId(id)) throw new Error(`Invalid subagent id: ${id}`);
	return path.join(projectCrewRoot(cwd), DEFAULT_PATHS.state.subagentsSubdir, `${id}.json`);
}

function serializableRecord(record: SubagentRecord): SubagentRecord {
	const { promise: _promise, ...rest } = record;
	return rest;
}

export function savePersistedSubagentRecord(cwd: string, record: SubagentRecord): void {
	try {
		const filePath = persistedSubagentPath(cwd, record.id);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, `${JSON.stringify(redactSecrets(serializableRecord(record)), null, 2)}\n`, "utf-8");
		// SECURITY: Restrict permissions to owner-only (rw-------).
		// On multi-user systems, other users must not read task prompts,
		// agent descriptions, and run IDs from subagent record files.
		fs.chmodSync(filePath, 0o600);
	} catch (error) {
		logInternalError("subagent-manager.save", error, `id=${record.id}`);
	}
}

/**
 * Delete the persisted subagent record from disk.
 * Used when a subagent is cancelled or terminated — the user wants no trace.
 * Safe-fail: if the file does not exist (already deleted), this is a no-op.
 * Any other I/O error is logged but not propagated.
 */
export function removePersistedSubagentRecord(cwd: string, id: string): boolean {
	try {
		const filePath = persistedSubagentPath(cwd, id);
		fs.unlinkSync(filePath);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT") return false;
		logInternalError("subagent-manager.remove", error, `id=${id}`);
		return false;
	}
}

/**
 * Predicate: should this record's persisted file be deleted on terminal status?
 * Only abnormal terminations (cancelled / stopped / terminated-flag) are wiped.
 * Successful runs (`completed`) and agent errors (`failed`, `error`) keep their audit trail.
 */
export function shouldDeleteOnTerminalStatus(record: SubagentRecord): boolean {
	if (record.terminated === true) return true;
	const s = record.status;
	return s === "cancelled" || s === "stopped";
}

const ALLOWED_RECORD_FIELDS = new Set([
	"id",
	"agentId",
	"agentName",
	"subagentType",
	"type",
	"description",
	"prompt",
	"status",
	"startedAt",
	"completedAt",
	"spawnedAt",
	"model",
	"runId",
	"cwd",
	"taskId",
	"result",
	"error",
	"resultConsumed",
	"background",
	"ownerSessionGeneration",
	"stuckNotified",
	"blockedAt",
	"turnCount",
	"terminated",
	"durationMs",
]);

function sanitizePersistedRecord(raw: unknown): SubagentRecord | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const obj = raw as Record<string, unknown>;
	// Accept either `id` (public SubagentRecord field) or `agentId` (legacy).
	// The saved JSON uses `id` (from serializableRecord → JSON.stringify of record).
	const idValue = obj.id ?? obj.agentId;
	if (typeof idValue !== "string" || !idValue) return undefined;
	const clean: Record<string, unknown> = { id: idValue };
	if (obj.agentId && typeof obj.agentId === "string") {
		clean.agentId = obj.agentId;
	}
	for (const key of Object.keys(obj)) {
		if (
			ALLOWED_RECORD_FIELDS.has(key) &&
			(typeof obj[key] === "string" || typeof obj[key] === "number" || typeof obj[key] === "boolean")
		) {
			clean[key] = obj[key];
		}
	}
	// Re-validate `id` to prevent prototype/constructor smuggling
	if (typeof clean.id !== "string" || clean.id.length === 0) return undefined;
	return clean as unknown as SubagentRecord;
}

export function readPersistedSubagentRecord(cwd: string, id: string): SubagentRecord | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(persistedSubagentPath(cwd, id), "utf-8"));
		return sanitizePersistedRecord(raw);
	} catch {
		return undefined;
	}
}

function resultText(result: PiTeamsToolResult): string {
	return (
		result.content
			?.map((item) => (item.type === "text" ? item.text : ""))
			.filter(Boolean)
			.join("\n") ?? ""
	);
}

function detailsRunId(result: PiTeamsToolResult): string | undefined {
	const details = result.details as { runId?: unknown } | undefined;
	return typeof details?.runId === "string" ? details.runId : undefined;
}

function totalRunTurns(cwd: string, runId: string | undefined): number | undefined {
	if (!runId) return undefined;
	const loaded = loadRunManifestById(cwd, runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) return undefined;
	let total = 0;
	let hasTurns = false;
	for (const task of loaded.tasks) {
		const turns = task.usage?.turns ?? task.agentProgress?.turns;
		if (typeof turns === "number" && Number.isFinite(turns)) {
			total += turns;
			hasTurns = true;
		}
	}
	return hasTurns ? total : undefined;
}

export class SubagentManager {
	private readonly records = new Map<string, SubagentRecord>();
	private readonly cwdByRecord = new Map<string, string>();
	private readonly controllers = new Map<string, AbortController>();
	private readonly controllerCleanup = new Map<string, () => void>();
	private queue: QueuedSpawn[] = [];
	private runningBackground = 0;
	private counter = 0;
	private maxConcurrent: number;
	private readonly onComplete?: Notify;
	private readonly onEvent?: NotifyEvent;
	private readonly pollIntervalMs: number;

	constructor(maxConcurrent = 4, onComplete?: Notify, pollIntervalMs = 1000, onEvent?: NotifyEvent) {
		this.maxConcurrent = maxConcurrent;
		this.onComplete = onComplete;
		this.onEvent = onEvent;
		this.pollIntervalMs = pollIntervalMs;
	}

	spawn(options: SubagentSpawnOptions, runner: SpawnRunner, signal?: AbortSignal): SubagentRecord {
		const record: SubagentRecord = {
			id: `agent_${Date.now().toString(36)}_${(++this.counter).toString(36)}`,
			type: options.type,
			description: options.description,
			prompt: options.prompt,
			status: options.background && this.runningBackground >= this.maxConcurrent ? "queued" : "running",
			startedAt: Date.now(),
			model: options.model,
			skill: options.skill,
			background: options.background,
			ownerSessionGeneration: options.ownerSessionGeneration,
			batchId: options.batchId,
		};
		this.records.set(record.id, record);
		this.cwdByRecord.set(record.id, options.cwd);
		savePersistedSubagentRecord(options.cwd, record);
		if (record.status === "queued") {
			this.queue.push({ record, options, runner, signal });
			return record;
		}
		this.start(record, options, runner, signal);
		return record;
	}

	getRecord(id: string): SubagentRecord | undefined {
		return this.records.get(id);
	}

	listAgents(): SubagentRecord[] {
		return [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt);
	}

	abort(id: string, reason?: string): boolean {
		const record = this.records.get(id);
		if (!record) return false;
		if (record.status === "queued") {
			this.queue = this.queue.filter((entry) => entry.record.id !== id);
			this.markStopped(record, reason ?? "Aborted by caller.");
			return true;
		}
		if (record.status !== "running" && record.status !== "blocked") return false;
		this.controllers.get(id)?.abort();
		this.markStopped(record, reason ?? "Aborted by caller.");
		return true;
	}

	abortAll(reason?: string): number {
		let count = 0;
		const stopReason = reason ?? "Aborted (session switch or shutdown).";
		for (const entry of this.queue) {
			this.markStopped(entry.record, stopReason);
			count++;
		}
		this.queue = [];
		for (const record of this.records.values()) {
			if (record.status === "running" || record.status === "blocked") {
				this.controllers.get(record.id)?.abort();
				this.markStopped(record, stopReason);
				count++;
			}
		}
		return count;
	}

	async waitForAll(): Promise<void> {
		while (true) {
			this.drainQueue();
			const pending = this.listAgents()
				.filter((record) => record.status === "running" || record.status === "queued")
				.map((record) => record.promise)
				.filter((promise): promise is Promise<void> => Boolean(promise));
			if (!pending.length) break;
			await Promise.allSettled(pending);
		}
	}

	async waitForRecord(id: string): Promise<SubagentRecord | undefined> {
		while (true) {
			const record = this.records.get(id);
			if (!record) return undefined;
			if (record.status !== "running" && record.status !== "queued") return record;
			if (record.promise)
				await record.promise.catch((error) => {
					logInternalError("subagent-manager.waitForRecord", error, `id=${id}`);
				});
			else await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	setMaxConcurrent(value: number): void {
		this.maxConcurrent = Math.max(1, Math.floor(value));
		this.drainQueue();
	}

	private start(record: SubagentRecord, options: SubagentSpawnOptions, runner: SpawnRunner, signal?: AbortSignal): void {
		if (options.background) this.runningBackground++;
		record.status = "running";
		record.startedAt = Date.now();
		record.completedAt = undefined;
		const runSignal = this.createRunSignal(record.id, signal);
		savePersistedSubagentRecord(options.cwd, record);
		record.promise = (async () => {
			try {
				const result = await runner(options, runSignal);
				if (record.status === "stopped") return;
				record.runId = detailsRunId(result);
				record.result = resultText(result);
				savePersistedSubagentRecord(options.cwd, record);
				if (result.isError) {
					record.status = "error";
					record.error = record.result;
					throw new Error(record.error);
				}
				if (record.runId) await this.pollRunToTerminal(options.cwd, record);
				else record.status = "completed";
			} catch (error) {
				if (record.status === "stopped" || runSignal.aborted) {
					const abortReason = runSignal.aborted
						? "Signal aborted — agent cancelled by parent (session switch, user cancel, or tool timeout)."
						: undefined;
					record.status = "stopped";
					if (!record.error) record.error = abortReason ?? (error instanceof Error ? error.message : String(error));
					return;
				}
				record.status = "error";
				record.error = error instanceof Error ? error.message : String(error);
				throw error; // H4: Propagate rejection so callers awaiting record.promise see the error
			} finally {
				this.cleanupRunSignal(record.id);
				if (options.background) this.runningBackground = Math.max(0, this.runningBackground - 1);
				if (record.status !== "blocked") record.completedAt = record.completedAt ?? Date.now();
				savePersistedSubagentRecord(options.cwd, record);
				if (
					record.status === "completed" ||
					record.status === "failed" ||
					record.status === "cancelled" ||
					record.status === "error" ||
					record.status === "stopped"
				) {
					// Phase 1.6: Populate telemetry fields
					record.turnCount = record.turnCount ?? totalRunTurns(options.cwd, record.runId);
					record.durationMs = record.completedAt ? Math.max(0, record.completedAt - record.startedAt) : undefined;
					savePersistedSubagentRecord(options.cwd, record);
					// User policy (v0.9.16): cancelled / stopped subagents leave NO trace.
					// Successful runs (`completed`) and agent errors (`failed`, `error`)
					// keep their audit trail. See shouldDeleteOnTerminalStatus().
					if (shouldDeleteOnTerminalStatus(record)) {
						removePersistedSubagentRecord(options.cwd, record.id);
					}
					this.onComplete?.(record);
				}
				this.drainQueue();
			}
		})();
		// Defense in depth (issue #29): a subagent failure should never crash
		// the host pi process. The IIFE above can reject (e.g. when a run
		// lookup fails) and the re-throw at line 281 propagates to
		// `record.promise`. If no caller awaits the promise, that rejection
		// would become `unhandledRejection` → `uncaughtException` → pi exits.
		// Attaching a no-op catch here keeps the contract for callers that
		// DO await (they still see the rejection) while preventing the
		// harness-killing failure mode for callers that don't.
		record.promise.catch((error) => {
			logInternalError("subagent-manager.start.unhandled", error, `id=${record.id}`);
		});
	}

	private markStopped(record: SubagentRecord, reason?: string): void {
		record.status = "stopped";
		record.terminated = true;
		record.completedAt = Date.now();
		if (reason && !record.error) record.error = reason;
		const cwd = this.cwdByRecord.get(record.id);
		// User policy (v0.9.16): stopped subagents leave NO trace on disk.
		// Save first (so any concurrent reader sees the final status), then
		// unlink. The race window is microseconds and the file is gone before
		// the next widget/dashboard tick.
		if (cwd) savePersistedSubagentRecord(cwd, record);
		if (cwd) removePersistedSubagentRecord(cwd, record.id);
	}

	private createRunSignal(id: string, signal?: AbortSignal): AbortSignal {
		const controller = new AbortController();
		this.controllers.set(id, controller);
		if (signal?.aborted) {
			controller.abort();
			return controller.signal;
		}
		if (signal) {
			const abort = (): void => controller.abort();
			signal.addEventListener("abort", abort, { once: true });
			this.controllerCleanup.set(id, () => signal.removeEventListener("abort", abort));
		}
		return controller.signal;
	}

	private cleanupRunSignal(id: string): void {
		this.controllerCleanup.get(id)?.();
		this.controllerCleanup.delete(id);
		this.controllers.delete(id);
	}

	private drainQueue(): void {
		while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
			const next = this.queue.shift();
			if (next?.record.status !== "queued") continue;
			this.start(next.record, next.options, next.runner, next.signal);
		}
	}

	private async pollRunToTerminal(cwd: string, record: SubagentRecord): Promise<void> {
		// Safety: max 30 minutes (1800 polls at 1s interval) to prevent infinite
		// polling if manifest file is deleted or run state becomes unrecoverable.
		const MAX_POLL_COUNT = 1800;
		let pollCount = 0;
		while (record.runId && (record.status === "running" || record.status === "blocked")) {
			if (++pollCount > MAX_POLL_COUNT) {
				logInternalError(
					"subagent-manager.poll-timeout",
					new Error(`pollRunToTerminal exceeded ${MAX_POLL_COUNT} polls for runId=${record.runId}`),
					`id=${record.id}`,
				);
				record.status = "error";
				record.error = `Poll timeout: run did not reach terminal state after ${MAX_POLL_COUNT} seconds`;
				record.completedAt = Date.now();
				savePersistedSubagentRecord(cwd, record);
				return;
			}
			const loaded = loadRunManifestById(cwd, record.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
			if (!loaded) {
				await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
				continue;
			}
			if (loaded.manifest.status === "completed") {
				record.status = "completed";
				record.error = undefined;
				record.turnCount = record.turnCount ?? totalRunTurns(cwd, record.runId);
				record.completedAt = Date.now();
				savePersistedSubagentRecord(cwd, record);
				return;
			}
			if (loaded.manifest.status === "failed" || loaded.manifest.status === "cancelled") {
				record.status = loaded.manifest.status;
				record.error = loaded.manifest.summary;
				record.turnCount = record.turnCount ?? totalRunTurns(cwd, record.runId);
				record.completedAt = Date.now();
				savePersistedSubagentRecord(cwd, record);
				return;
			}
			if (loaded.manifest.status === "blocked") {
				record.status = "blocked";
				record.error = undefined;
				if (!record.blockedAt) {
					record.blockedAt = Date.now();
					record.stuckNotified = false;
					record.completedAt = undefined;
					this.onComplete?.(record);
					this.scheduleStuckBlockedNotify(cwd, record);
					this.scheduleBlockedTerminalPoll(cwd, record);
				}
				savePersistedSubagentRecord(cwd, record);
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
		}
	}

	private scheduleBlockedTerminalPoll(cwd: string, record: SubagentRecord): void {
		const poll = (): void => {
			const current = this.records.get(record.id);
			if (current?.status !== "blocked" || !current.runId) return;
			const loaded = loadRunManifestById(cwd, current.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
			if (
				!loaded ||
				loaded.manifest.status === "blocked" ||
				loaded.manifest.status === "running" ||
				loaded.manifest.status === "planning" ||
				loaded.manifest.status === "queued"
			) {
				const timer = setTimeout(poll, this.pollIntervalMs);
				timer.unref();
				return;
			}
			const persisted = readPersistedSubagentRecord(cwd, current.id);
			current.resultConsumed = current.resultConsumed || persisted?.resultConsumed;
			if (loaded.manifest.status === "completed") {
				current.status = "completed";
				current.error = undefined;
			} else if (loaded.manifest.status === "failed" || loaded.manifest.status === "cancelled") {
				current.status = loaded.manifest.status;
				current.error = loaded.manifest.summary;
			} else return;
			current.completedAt = Date.now();
			current.turnCount = current.turnCount ?? totalRunTurns(cwd, current.runId);
			current.durationMs = Math.max(0, current.completedAt - current.startedAt);
			savePersistedSubagentRecord(cwd, current);
			this.onComplete?.(current);
		};
		const timer = setTimeout(poll, this.pollIntervalMs);
		timer.unref();
	}

	private scheduleStuckBlockedNotify(cwd: string, record: SubagentRecord): void {
		const threshold = DEFAULT_SUBAGENT.stuckBlockedNotifyMs;
		const fire = (): void => {
			const current = this.records.get(record.id);
			if (current?.status !== "blocked" || !current.blockedAt || current.stuckNotified) return;
			current.stuckNotified = true;
			this.onEvent?.("subagent.stuck-blocked", {
				event: "subagent.stuck-blocked",
				id: current.id,
				runId: current.runId,
				durationMs: Math.max(0, Date.now() - current.blockedAt),
				ownerSessionGeneration: current.ownerSessionGeneration,
			});
			savePersistedSubagentRecord(cwd, current);
		};
		if (threshold <= 0) {
			fire();
			return;
		}
		const timer = setTimeout(fire, threshold);
		timer.unref();
	}
}
