export type ScheduleType = "cron" | "once" | "interval";

export interface ScheduledJob {
	id: string;
	name: string;
	description: string;
	schedule: string;
	scheduleType: ScheduleType;
	intervalMs?: number;
	subagentType: string;
	prompt: string;
	enabled: boolean;
	createdAt: string;
	lastRun?: string;
	lastStatus?: "success" | "error" | "running";
	nextRun?: string;
	runCount: number;
	/** Run IDs spawned by this job. Used to cancel runs when job is removed. */
	spawnedRunIds?: string[];
}

export type ScheduleChangeEvent =
	| { type: "added"; job: ScheduledJob }
	| { type: "removed"; jobId: string; spawnedRunIds?: string[] }
	| { type: "updated"; job: ScheduledJob }
	| { type: "fired"; jobId: string; agentId: string; name: string }
	| { type: "error"; jobId: string; error: string };

export class CrewScheduler {
	private jobs = new Map<string, ScheduledJob>();
	private timers = new Map<string, ReturnType<typeof setInterval | typeof setTimeout>>();
	private emit?: (event: ScheduleChangeEvent) => void;
	private executor?: (job: ScheduledJob) => string;
	private finalizer?: (jobId: string, agentId: string) => void;
	private runCancelFn?: (runId: string) => void;

	start(options: {
		emit: (event: ScheduleChangeEvent) => void;
		executor: (job: ScheduledJob) => string;
		finalizer: (jobId: string, agentId: string) => void;
		/** Optional callback to cancel a spawned run by runId. */
		runCancelFn?: (runId: string) => void;
	}): void {
		this.emit = options.emit;
		this.executor = options.executor;
		this.finalizer = options.finalizer;
		this.runCancelFn = options.runCancelFn;
	}

	stop(): void {
		for (const t of this.timers.values()) {
			clearInterval(t as ReturnType<typeof setInterval>);
			clearTimeout(t as ReturnType<typeof setTimeout>);
		}
		this.timers.clear();
		this.emit = undefined;
		this.executor = undefined;
		this.finalizer = undefined;
		this.runCancelFn = undefined;
	}

	add(job: ScheduledJob): void {
		this.jobs.set(job.id, job);
		if (job.enabled) this.arm(job);
		this.emit?.({ type: "added", job });
	}

	remove(id: string): boolean {
		const job = this.jobs.get(id);
		const spawnedRunIds = job?.spawnedRunIds;
		this.disarm(id);
		// Cancel all spawned runs that are still active
		if (spawnedRunIds && this.runCancelFn) {
			for (const runId of spawnedRunIds) {
				try {
					this.runCancelFn(runId);
				} catch {
					/* best-effort */
				}
			}
		}
		const ok = this.jobs.delete(id);
		if (ok) this.emit?.({ type: "removed", jobId: id, spawnedRunIds });
		return ok;
	}

	update(id: string, patch: Partial<ScheduledJob>): ScheduledJob | undefined {
		const existing = this.jobs.get(id);
		if (!existing) return undefined;
		this.disarm(id);
		const updated = { ...existing, ...patch };
		this.jobs.set(id, updated);
		if (updated.enabled) this.arm(updated);
		this.emit?.({ type: "updated", job: updated });
		return updated;
	}

	list(): ScheduledJob[] {
		return [...this.jobs.values()];
	}

	/** Record a runId spawned by a job. Call this after executor fires. */
	recordSpawnedRun(jobId: string, runId: string): void {
		const job = this.jobs.get(jobId);
		if (!job) return;
		const spawnedRunIds = [...(job.spawnedRunIds ?? []), runId];
		this.jobs.set(jobId, { ...job, spawnedRunIds });
	}

	private arm(job: ScheduledJob): void {
		if (this.timers.has(job.id)) return;
		if (job.scheduleType === "interval" && job.intervalMs) {
			const t = setInterval(() => this.fire(job.id), job.intervalMs);
			t.unref();
			this.timers.set(job.id, t);
		} else if (job.scheduleType === "once") {
			const target = new Date(job.schedule).getTime();
			const delay = target - Date.now();
			if (delay > 0) {
				const t = setTimeout(() => {
					this.fire(job.id);
					this.update(job.id, { enabled: false });
				}, delay);
				t.unref();
				this.timers.set(job.id, t);
			} else {
				this.update(job.id, { enabled: false, lastStatus: "error" });
				this.emit?.({
					type: "error",
					jobId: job.id,
					error: `Scheduled time ${job.schedule} is in the past`,
				});
			}
		}
	}

	private disarm(id: string): void {
		const t = this.timers.get(id);
		if (t) {
			// Branch on timer type to use correct clear function
			const job = this.jobs.get(id);
			if (job?.scheduleType === "once") {
				clearTimeout(t as ReturnType<typeof setTimeout>);
			} else {
				clearInterval(t as ReturnType<typeof setInterval>);
			}
			this.timers.delete(id);
		}
	}

	private fire(id: string): void {
		const job = this.jobs.get(id);
		if (!job?.enabled || !this.executor) return;
		this.update(id, { lastStatus: "running" });
		let agentId: string;
		try {
			agentId = this.executor(job);
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			this.update(id, {
				lastRun: new Date().toISOString(),
				lastStatus: "error",
			});
			this.emit?.({ type: "error", jobId: id, error });
			return;
		}
		this.emit?.({ type: "fired", jobId: id, agentId, name: job.name });
		this.finalizer?.(id, agentId);
	}

	static detectSchedule(s: string): {
		type: ScheduleType;
		intervalMs?: number;
		normalized: string;
	} {
		const trimmed = s.trim();
		// Relative: +10m
		const rel = trimmed.match(/^\+(\d+)(s|m|h|d)$/);
		if (rel) {
			const ms = parseInt(rel[1], 10) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "s" | "m" | "h" | "d"];
			return {
				type: "once",
				normalized: new Date(Date.now() + ms).toISOString(),
			};
		}
		// Interval: 5m
		const ivl = trimmed.match(/^(\d+)(s|m|h|d)$/);
		if (ivl) {
			const ms = parseInt(ivl[1], 10) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[ivl[2] as "s" | "m" | "h" | "d"];
			return { type: "interval", intervalMs: ms, normalized: trimmed };
		}
		// ISO timestamp
		if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
			const d = new Date(trimmed);
			if (!Number.isNaN(d.getTime())) {
				if (d.getTime() <= Date.now()) throw new Error(`Scheduled time ${d.toISOString()} is in the past.`);
				return { type: "once", normalized: d.toISOString() };
			}
		}
		// Simple cron-like (5 fields)
		const cronFields = trimmed.split(/\s+/);
		if (cronFields.length >= 5) {
			return { type: "cron", normalized: trimmed };
		}
		throw new Error(`Invalid schedule "${s}". Use "5m", "+10m", ISO timestamp, or cron expression.`);
	}
}

export interface ScheduleSpec {
	kind: "once" | "interval" | "cron";
	spec: string;
}

function parseIntervalMs(s: string): number | undefined {
	let ms = 0;
	let remaining = s;
	const unitMs: Record<string, number> = {
		s: 1000,
		m: 60_000,
		h: 3_600_000,
		d: 86_400_000,
	};
	while (remaining.length > 0) {
		const m = remaining.match(/^(\d+)(s|m|h|d)/);
		if (!m) return undefined;
		ms += parseInt(m[1], 10) * unitMs[m[2]];
		remaining = remaining.slice(m[0].length);
	}
	return ms;
}

function nextCronDate(spec: string, from: Date): Date | { error: string } | null {
	const parts = spec.split(/\s+/);
	if (parts.length < 5) return { error: "Invalid cron expression" };
	const [minStr, hourStr, domStr, monthStr, dowStr] = parts;

	function matchField(value: number, str: string, min: number, max: number): boolean {
		if (str === "*") return true;
		const n = parseInt(str, 10);
		if (!Number.isNaN(n) && n >= min && n <= max && n === value) return true;
		if (/^\d+-\d+$/.test(str)) {
			const [a, b] = str.split("-").map(Number);
			return value >= a && value <= b;
		}
		if (str.includes(",")) {
			return str.split(",").some((part) => matchField(value, part.trim(), min, max));
		}
		return false;
	}

	let cursor = new Date(from.getTime());
	cursor.setSeconds(0, 0);
	cursor = new Date(cursor.getTime() + 60_000);

	const maxIterations = 366 * 24 * 60;
	for (let i = 0; i < maxIterations; i++) {
		const min = cursor.getUTCMinutes();
		const hour = cursor.getUTCHours();
		const dom = cursor.getUTCDate();
		const month = cursor.getUTCMonth() + 1;
		const dow = cursor.getUTCDay();

		if (
			matchField(min, minStr, 0, 59) &&
			matchField(hour, hourStr, 0, 23) &&
			matchField(dom, domStr, 1, 31) &&
			matchField(month, monthStr, 1, 12) &&
			matchField(dow, dowStr, 0, 6)
		) {
			return cursor;
		}

		cursor = new Date(cursor.getTime() + 60_000);
	}

	return { error: "No next cron occurrence found within search window" };
}

export function parseSchedule(spec: string): ScheduleSpec | { error: string } {
	const trimmed = spec.trim();
	if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
		const d = new Date(trimmed);
		if (!Number.isNaN(d.getTime())) {
			return { kind: "once", spec: trimmed };
		}
	}
	if (/^\+\d+(s|m|h|d)$/.test(trimmed)) {
		return { kind: "once", spec: trimmed };
	}
	const ivlMs = parseIntervalMs(trimmed);
	if (ivlMs !== undefined && ivlMs > 0) {
		return { kind: "interval", spec: trimmed };
	}
	const fields = trimmed.split(/\s+/);
	if (fields.length >= 5) {
		return { kind: "cron", spec: trimmed };
	}
	return {
		error: `Invalid schedule "${spec}". Use "5m", "+10m", ISO timestamp, or cron expression.`,
	};
}

export function nextRunTime(spec: ScheduleSpec, from: Date = new Date()): Date | { error: string } {
	if (spec.kind === "once") {
		const rel = spec.spec.match(/^\+(\d+)(s|m|h|d)$/);
		if (rel) {
			const ms = parseInt(rel[1], 10) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "s" | "m" | "h" | "d"];
			return new Date(from.getTime() + ms);
		}
		const d = new Date(spec.spec);
		if (Number.isNaN(d.getTime())) {
			return { error: `Invalid once schedule: ${spec.spec}` };
		}
		return d;
	}
	if (spec.kind === "interval") {
		const ms = parseIntervalMs(spec.spec);
		if (ms === undefined || ms <= 0) {
			return { error: `Invalid interval: ${spec.spec}` };
		}
		return new Date(from.getTime() + ms);
	}
	if (spec.kind === "cron") {
		const next = nextCronDate(spec.spec, from);
		if (!next || !(next instanceof Date)) {
			return (
				(next as { error: string } | null) ?? {
					error: "Invalid cron expression",
				}
			);
		}
		return next;
	}
	return {
		error: `Unknown schedule kind: ${(spec as unknown as Record<string, unknown>).kind}`,
	};
}

export function humanizeSchedule(spec: ScheduleSpec): string {
	if (spec.kind === "once") {
		if (/^\+\d+(s|m|h|d)$/.test(spec.spec)) {
			return `once in ${spec.spec.slice(1)}`;
		}
		return `once at ${spec.spec}`;
	}
	if (spec.kind === "interval") {
		return `every ${spec.spec}`;
	}
	if (spec.kind === "cron") {
		return `cron ${spec.spec}`;
	}
	return "unknown schedule";
}
