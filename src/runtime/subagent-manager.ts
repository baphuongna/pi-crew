import * as fs from "node:fs";
import * as path from "node:path";
import { loadRunManifestById } from "../state/state-store.ts";
import type { PiTeamsToolResult } from "../extension/tool-result.ts";
import { DEFAULT_SUBAGENT } from "../config/defaults.ts";
import { projectCrewRoot } from "../utils/paths.ts";
import { DEFAULT_PATHS } from "../config/defaults.ts";
import { logInternalError } from "../utils/internal-error.ts";

export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "error" | "blocked" | "stopped";

export interface SubagentSpawnOptions {
	cwd: string;
	type: string;
	description: string;
	prompt: string;
	background: boolean;
	model?: string;
	maxTurns?: number;
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
	stuckNotified?: boolean;
	blockedAt?: number;
	promise?: Promise<void>;
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
		fs.writeFileSync(filePath, `${JSON.stringify(serializableRecord(record), null, 2)}\n`, "utf-8");
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

export class SubagentManager {
	private readonly records = new Map<string, SubagentRecord>();
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
		};
		this.records.set(record.id, record);
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
			record.status = "stopped";
			record.completedAt = Date.now();
			return true;
		}
		if (record.status !== "running" && record.status !== "blocked") return false;
		record.status = "stopped";
		record.completedAt = Date.now();
		return true;
	}

	abortAll(): number {
		let count = 0;
		for (const entry of this.queue) {
			entry.record.status = "stopped";
			entry.record.completedAt = Date.now();
			count++;
		}
		this.queue = [];
		for (const record of this.records.values()) {
			if (record.status === "running" || record.status === "blocked") {
				record.status = "stopped";
				record.completedAt = Date.now();
				count++;
			}
		}
		return count;
	}

	async waitForAll(): Promise<void> {
		while (true) {
			this.drainQueue();
			const pending = this.listAgents().filter((record) => record.status === "running" || record.status === "blocked" || record.status === "queued").map((record) => record.promise).filter((promise): promise is Promise<void> => Boolean(promise));
			if (!pending.length) break;
			await Promise.allSettled(pending);
		}
	}

	async waitForRecord(id: string): Promise<SubagentRecord | undefined> {
		while (true) {
			const record = this.records.get(id);
			if (!record) return undefined;
			if (record.status !== "running" && record.status !== "blocked" && record.status !== "queued") return record;
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
		savePersistedSubagentRecord(options.cwd, record);
		record.promise = (async () => {
			try {
				const result = await runner(options, signal);
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
				record.status = "error";
				record.error = error instanceof Error ? error.message : String(error);
			} finally {
				if (options.background) this.runningBackground = Math.max(0, this.runningBackground - 1);
				record.completedAt = record.completedAt ?? Date.now();
				savePersistedSubagentRecord(options.cwd, record);
				if (record.status === "completed" || record.status === "failed" || record.status === "cancelled" || record.status === "error" || record.status === "stopped") {
					this.onComplete?.(record);
				}
				this.drainQueue();
			}
		})();
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
				record.completedAt = Date.now();
				savePersistedSubagentRecord(cwd, record);
				return;
			}
			if (loaded.manifest.status === "failed" || loaded.manifest.status === "cancelled") {
				record.status = loaded.manifest.status;
				record.error = loaded.manifest.summary;
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
				}
				savePersistedSubagentRecord(cwd, record);
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
		}
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
