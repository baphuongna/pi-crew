import * as fs from "node:fs";
import * as path from "node:path";
import { loadRunManifestById } from "../state/state-store.ts";
import type { PiTeamsToolResult } from "../extension/tool-result.ts";
import { DEFAULT_SUBAGENT } from "../config/defaults.ts";
import { projectCrewRoot } from "../utils/paths.ts";
import { DEFAULT_PATHS } from "../config/defaults.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { redactSecrets } from "../utils/redaction.ts";

export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "error" | "blocked" | "stopped";

export interface SubagentSpawnOptions {
	cwd: string;
	type: string;
	description: string;
	prompt: string;
	background: boolean;
	model?: string;
	maxTurns?: number;
	ownerSessionGeneration?: number;
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
	background: boolean;
	ownerSessionGeneration?: number;
	stuckNotified?: boolean;
	blockedAt?: number;
	promise?: Promise<void>;
	// Phase 1.6: Telemetry baseline fields
	turnCount?: number;
	terminated?: boolean;
	durationMs?: number;
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

function persistedSubagentPath(cwd: string, id: string): string {
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
	} catch (error) {
		logInternalError("subagent-manager.save", error, `id=${record.id}`);
	}
}

export function readPersistedSubagentRecord(cwd: string, id: string): SubagentRecord | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(persistedSubagentPath(cwd, id), "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as SubagentRecord : undefined;
	} catch {
		return undefined;
	}
}

function resultText(result: PiTeamsToolResult): string {
	return result.content?.map((item) => item.type === "text" ? item.text : "").filter(Boolean).join("\n") ?? "";
}

function detailsRunId(result: PiTeamsToolResult): string | undefined {
	const details = result.details as { runId?: unknown } | undefined;
	return typeof details?.runId === "string" ? details.runId : undefined;
}

function totalRunTurns(cwd: string, runId: string | undefined): number | undefined {
	if (!runId) return undefined;
	const loaded = loadRunManifestById(cwd, runId);
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
			background: options.background,
			ownerSessionGeneration: options.ownerSessionGeneration,
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

	abort(id: string): boolean {
		const record = this.records.get(id);
		if (!record) return false;
		if (record.status === "queued") {
			this.queue = this.queue.filter((entry) => entry.record.id !== id);
			this.markStopped(record);
			return true;
		}
		if (record.status !== "running" && record.status !== "blocked") return false;
		this.controllers.get(id)?.abort();
		this.markStopped(record);
		return true;
	}

	abortAll(): number {
		let count = 0;
		for (const entry of this.queue) {
			this.markStopped(entry.record);
			count++;
		}
		this.queue = [];
		for (const record of this.records.values()) {
			if (record.status === "running" || record.status === "blocked") {
				this.controllers.get(record.id)?.abort();
				this.markStopped(record);
				count++;
			}
		}
		return count;
	}

	async waitForAll(): Promise<void> {
		while (true) {
			this.drainQueue();
			const pending = this.listAgents().filter((record) => record.status === "running" || record.status === "queued").map((record) => record.promise).filter((promise): promise is Promise<void> => Boolean(promise));
			if (!pending.length) break;
			await Promise.allSettled(pending);
		}
	}

	async waitForRecord(id: string): Promise<SubagentRecord | undefined> {
		while (true) {
			const record = this.records.get(id);
			if (!record) return undefined;
			if (record.status !== "running" && record.status !== "queued") return record;
			if (record.promise) await record.promise;
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
					return;
				}
				if (record.runId) await this.pollRunToTerminal(options.cwd, record);
				else record.status = "completed";
			} catch (error) {
				if (record.status === "stopped" || runSignal.aborted) {
					record.status = "stopped";
					return;
				}
				record.status = "error";
				record.error = error instanceof Error ? error.message : String(error);
			} finally {
				this.cleanupRunSignal(record.id);
				if (options.background) this.runningBackground = Math.max(0, this.runningBackground - 1);
				if (record.status !== "blocked") record.completedAt = record.completedAt ?? Date.now();
				savePersistedSubagentRecord(options.cwd, record);
				if (record.status === "completed" || record.status === "failed" || record.status === "cancelled" || record.status === "error" || record.status === "stopped") {
					// Phase 1.6: Populate telemetry fields
					record.turnCount = record.turnCount ?? totalRunTurns(options.cwd, record.runId);
					record.durationMs = record.completedAt ? Math.max(0, record.completedAt - record.startedAt) : undefined;
					savePersistedSubagentRecord(options.cwd, record);
					this.onComplete?.(record);
				}
				this.drainQueue();
			}
		})();
	}

	private markStopped(record: SubagentRecord): void {
		record.status = "stopped";
		record.completedAt = Date.now();
		const cwd = this.cwdByRecord.get(record.id);
		if (cwd) savePersistedSubagentRecord(cwd, record);
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
			if (!next || next.record.status !== "queued") continue;
			this.start(next.record, next.options, next.runner, next.signal);
		}
	}

	private async pollRunToTerminal(cwd: string, record: SubagentRecord): Promise<void> {
		while (record.runId && (record.status === "running" || record.status === "blocked")) {
			const loaded = loadRunManifestById(cwd, record.runId);
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
			if (!current || current.status !== "blocked" || !current.runId) return;
			const loaded = loadRunManifestById(cwd, current.runId);
			if (!loaded || loaded.manifest.status === "blocked" || loaded.manifest.status === "running" || loaded.manifest.status === "planning" || loaded.manifest.status === "queued") {
				const timer = setTimeout(poll, this.pollIntervalMs);
				timer.unref?.();
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
		timer.unref?.();
	}

	private scheduleStuckBlockedNotify(cwd: string, record: SubagentRecord): void {
		const threshold = DEFAULT_SUBAGENT.stuckBlockedNotifyMs;
		const fire = (): void => {
			const current = this.records.get(record.id);
			if (!current || current.status !== "blocked" || !current.blockedAt || current.stuckNotified) return;
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
		timer.unref?.();
	}
}
