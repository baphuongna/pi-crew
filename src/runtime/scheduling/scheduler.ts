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

export interface CrewSchedulerOptions {
	/** Injectable clock for tests. Defaults to real time (`new Date()`). */
	now?: () => Date;
}

/** Node clamps setTimeout delays > 2^31-1 ms to fire ~immediately; longer
 * waits (e.g. a yearly cron) must be chained in hops below this ceiling. */
const MAX_TIMER_DELAY_MS = 2_147_483_000;

export class CrewScheduler {
	private jobs = new Map<string, ScheduledJob>();
	private timers = new Map<string, ReturnType<typeof setInterval | typeof setTimeout>>();
	private emit?: (event: ScheduleChangeEvent) => void;
	private executor?: (job: ScheduledJob) => string;
	private finalizer?: (jobId: string, agentId: string) => void;
	private runCancelFn?: (runId: string) => void;
	private nowFn: () => Date;

	constructor(options: CrewSchedulerOptions = {}) {
		this.nowFn = options.now ?? (() => new Date());
	}

	/** Scheduler clock. Injected in tests; real time in production. */
	private now(): Date {
		return this.nowFn();
	}

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

	/**
	 * Trigger a job immediately (dashboard "run now" / subAction='run-now').
	 * Bypasses the enabled gate — an explicit user action — but otherwise reuses
	 * fire()'s exact path: marks lastStatus=running, invokes the SAME executor
	 * callback, emits fired/error events, and calls the finalizer. Completion
	 * (runCount/lastRun/lastStatus=persisted success) is handled by the same
	 * async finalization the timer-driven path uses.
	 *
	 * Returns ok:false (no throw) when the job or the executor is missing.
	 */
	runNow(jobId: string): { ok: true } | { ok: false; error: string } {
		const job = this.jobs.get(jobId);
		if (!job) return { ok: false, error: `No scheduled job with id '${jobId}'.` };
		if (!this.executor) return { ok: false, error: "Scheduler is not running." };
		this.fire(jobId, true);
		// A run-now on a scheduled ONCE job CONSUMES it: the timer-driven path
		// self-disables after firing (arm()'s setTimeout callback), and without
		// the same step here the still-armed timer would fire the job a SECOND
		// time at its scheduled time — a one-shot executing twice.
		if (job.scheduleType === "once") this.update(jobId, { enabled: false });
		return { ok: true };
	}

	private arm(job: ScheduledJob): void {
		if (this.timers.has(job.id)) return;
		if (job.scheduleType === "interval" && job.intervalMs) {
			// 2026-09-22 spawn-storm root cause: this branch used
			// setInterval(fire, intervalMs). Node timers are 32-bit — a LEGAL long
			// interval (e.g. 90d = 7,776,000,000ms > 2^31-1) overflows and Node
			// silently sets the delay to 1ms (TimeoutOverflowWarning): the job then
			// fired every millisecond, and fire() has no in-flight guard, so each
			// tick dispatched another run (measured live: ~104 garbage runs + 50+
			// node processes from ONE registered 90-day interval job). armCron()
			// already clamps its hops below the same ceiling — the interval branch
			// was missed. Reuse the identical chained-hop treatment: schedule toward
			// now+intervalMs, clamped; cronTick fires on arrival (its
			// advanceCronNextRun is a cron-only no-op here), and fire()'s internal
			// update() → disarm→arm lifecycle re-arms the next interval.
			const targetMs = this.now().getTime() + job.intervalMs;
			this.setCronTimeout(job.id, targetMs);
		} else if (job.scheduleType === "once") {
			const target = new Date(job.schedule).getTime();
			const delay = target - this.now().getTime();
			if (delay > 0) {
				// Same 32-bit ceiling as the interval branch above: a once job armed
			// > 2^31-1 ms out (e.g. "+30d" — a LEGAL relative spec — or a far ISO
			// timestamp) overflowed setTimeout to a 1ms PREMATURE fire. Chained hops
			// instead; cronTick self-disables once-jobs on arrival (below).
				this.setCronTimeout(job.id, target);
			} else {
				this.update(job.id, { enabled: false, lastStatus: "error" });
				this.emit?.({
					type: "error",
					jobId: job.id,
					error: `Scheduled time ${job.schedule} is in the past`,
				});
			}
		} else if (job.scheduleType === "cron") {
			this.armCron(job);
		}
	}

	/**
	 * Arm a cron job: schedule a chained setTimeout at the next occurrence
	 * (hops are clamped below the 2^31-1 ms setTimeout ceiling so yearly crons
	 * cannot mis-fire), fire once on arrival, then let the existing
	 * update() → disarm+arm lifecycle (triggered by fire()'s
	 * lastStatus='running' update) re-arm the NEXT occurrence. fire() itself
	 * stays persistence-blind; the post-fire nextRun advance happens in
	 * advanceCronNextRun and persists via the usual `updated` event flow.
	 */
	private armCron(job: ScheduledJob): void {
		const now = this.now();
		const next = nextRunTime({ kind: "cron", spec: job.schedule }, now);
		if (!(next instanceof Date) || next.getTime() <= now.getTime()) {
			this.disableCronForUncomputableNext(job.id, next);
			return;
		}
		this.setCronTimeout(job.id, next.getTime());
	}

	/** Chain a clamped timeout hop toward the target cron occurrence. */
	private setCronTimeout(jobId: string, targetMs: number): void {
		const delay = Math.max(targetMs - this.now().getTime(), 0);
		const t = setTimeout(() => this.cronTick(jobId, targetMs), Math.min(delay, MAX_TIMER_DELAY_MS));
		t.unref();
		this.timers.set(jobId, t);
	}

	/** Timer callback for a cron hop/arrival. Fires at most once per occurrence. */
	private cronTick(jobId: string, targetMs: number): void {
		const job = this.jobs.get(jobId);
		if (!job?.enabled) return; // disabled/removed mid-flight: hop must die
		if (this.now().getTime() < targetMs) {
			// Clamped hop landed early — chain again for the remaining time.
			this.setCronTimeout(jobId, targetMs);
			return;
		}
		// Occurrence reached. fire()'s internal update({lastStatus:'running'})
		// runs disarm→arm, which re-arms the NEXT occurrence exactly once; the
		// hop that just fired is dead, so no timer doubles up.
		this.fire(jobId);
		this.advanceCronNextRun(jobId);
		// once-semantics (was inline in arm()'s removed setTimeout): consume the
		// job after its single arrival fire so a re-arm cannot fire it again.
		if (job.scheduleType === "once") this.update(jobId, { enabled: false });
	}

	/** After a cron fire, advance the persisted nextRun to the next occurrence
	 * (or self-disable when no further occurrence is computable). */
	private advanceCronNextRun(jobId: string): void {
		const job = this.jobs.get(jobId);
		if (!job?.enabled || job.scheduleType !== "cron") return;
		const next = nextRunTime({ kind: "cron", spec: job.schedule }, this.now());
		if (!(next instanceof Date)) {
			this.disableCronForUncomputableNext(jobId, next);
			return;
		}
		this.update(jobId, { nextRun: next.toISOString() });
	}

	/** No computable next occurrence (e.g. Feb-29 beyond the 366-day search
	 * window): disable the job and record why. */
	private disableCronForUncomputableNext(jobId: string, next: Date | { error: string }): void {
		const reason = next && typeof next === "object" && "error" in next ? next.error : "next occurrence is not in the future";
		this.update(jobId, { enabled: false, lastStatus: "error" });
		this.emit?.({
			type: "error",
			jobId,
			error: `Cron schedule cannot compute a next occurrence (${reason}); job disabled`,
		});
	}

	private disarm(id: string): void {
		const t = this.timers.get(id);
		if (t) {
			// Branch on timer type to use correct clear function
			const job = this.jobs.get(id);
			if (job?.scheduleType === "interval") {
				clearInterval(t as ReturnType<typeof setInterval>);
			} else {
				// `once` and `cron` both arm setTimeout handles (cron chains hops).
				clearTimeout(t as ReturnType<typeof setTimeout>);
			}
			this.timers.delete(id);
		}
	}

	private fire(id: string, force = false): void {
		const job = this.jobs.get(id);
		if (!job || !this.executor) return;
		if (!job.enabled && !force) return;
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
		// Interval: 5m — "ms" MUST be accepted: handle-schedule builds
		// `${params.interval}ms` from the schema-level numeric `interval` param
		// (ms number), so without an ms unit here every interval schedule died in
		// the parser ("Invalid schedule …") — found live 2026-09-21 when
		// `team action='schedule' interval=3600000` was impossible to satisfy.
		const ivl = trimmed.match(/^(\d+)(ms|s|m|h|d)$/);
		if (ivl) {
			const ms = parseInt(ivl[1], 10) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[ivl[2] as "ms" | "s" | "m" | "h" | "d"];
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
		// "ms" MUST be first in the regex alternation below and present here:
		// handle-schedule builds `${params.interval}ms` from the numeric interval
		// param, so without an ms unit every interval schedule failed to parse
		// (found live 2026-09-21 — `interval=3600000` was unsatisfiable).
		ms: 1,
		s: 1000,
		m: 60_000,
		h: 3_600_000,
		d: 86_400_000,
	};
	while (remaining.length > 0) {
		const m = remaining.match(/^(\d+)(ms|s|m|h|d)/);
		if (!m) return undefined;
		ms += parseInt(m[1], 10) * unitMs[m[2]];
		remaining = remaining.slice(m[0].length);
	}
	return ms;
}

/** Named-token maps for cron DOW (SUN=0..SAT=6) and month (JAN=1..DEC=12). */
const CRON_DOW_NAMES: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const CRON_MONTH_NAMES: Record<string, number> = {
	JAN: 1,
	FEB: 2,
	MAR: 3,
	APR: 4,
	MAY: 5,
	JUN: 6,
	JUL: 7,
	AUG: 8,
	SEP: 9,
	OCT: 10,
	NOV: 11,
	DEC: 12,
};

/**
 * Match a single cron field value against a cron field expression.
 * Supports the standard cron grammar: wildcard, single N, range a-b, list a,b,c,
 * step syntax (wildcard-step, range-step, from-step), and named tokens
 * (MON, JAN) when a `names` map is passed. Fixes the prior matcher that
 * rejected step values and named DOW (parseInt returned NaN).
 */
function cronFieldMatches(value: number, field: string, min: number, max: number, names?: Record<string, number>): boolean {
	let normalized = field.trim().toUpperCase();
	if (names) {
		for (const name of Object.keys(names).sort((a, b) => b.length - a.length)) {
			normalized = normalized.split(name).join(String(names[name]));
		}
	}
	// Cron permits 7 for Sunday in the DOW field — normalize to 0.
	if (min === 0 && max === 6) normalized = normalized.replace(/\b7\b/g, "0");
	const matched = new Set<number>();
	for (const rawPart of normalized.split(",")) {
		const part = rawPart.trim();
		if (part === "") return false;
		const stepMatch = part.match(/^(.*)\/(\d+)$/);
		const step = stepMatch ? Number.parseInt(stepMatch[2], 10) : 1;
		if (!Number.isFinite(step) || step < 1) return false;
		const rangeStr = stepMatch ? stepMatch[1] : part;
		let lo: number;
		let hi: number;
		if (rangeStr === "*") {
			lo = min;
			hi = max;
		} else if (/^\d+$/.test(rangeStr)) {
			lo = Number.parseInt(rangeStr, 10);
			hi = stepMatch ? max : lo; // bare `N` = single value; `N/S` = N..max step S
		} else {
			const rm = rangeStr.match(/^(\d+)-(\d+)$/);
			if (!rm) return false;
			lo = Number.parseInt(rm[1], 10);
			hi = Number.parseInt(rm[2], 10);
		}
		for (let v = lo; v <= hi; v += step) {
			if (v >= min && v <= max) matched.add(v);
		}
	}
	return matched.has(value);
}

function nextCronDate(spec: string, from: Date): Date | { error: string } | null {
	const parts = spec.split(/\s+/);
	if (parts.length < 5) return { error: "Invalid cron expression" };
	const [minStr, hourStr, domStr, monthStr, dowStr] = parts;

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
			cronFieldMatches(min, minStr, 0, 59) &&
			cronFieldMatches(hour, hourStr, 0, 23) &&
			cronFieldMatches(dom, domStr, 1, 31) &&
			cronFieldMatches(month, monthStr, 1, 12, CRON_MONTH_NAMES) &&
			cronFieldMatches(dow, dowStr, 0, 6, CRON_DOW_NAMES)
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
