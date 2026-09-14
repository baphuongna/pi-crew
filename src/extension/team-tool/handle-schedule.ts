import * as crypto from "node:crypto";
import { humanizeSchedule, nextRunTime, parseSchedule } from "../../runtime/scheduling/scheduler.ts";
import {
	type CrewSettings,
	getScheduledJobsHiddenCount as computeScheduledJobsHiddenCount,
	loadCrewSettingsTiers,
	updateCrewSettings,
} from "../../runtime/settings-store.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { result, type TeamContext } from "./context.ts";
import { paramRequired } from "./param-error.ts";

// Module-scoped scheduler reference — one per extension load (EXT-9).
// Previously this lived on `globalThis[Symbol.for("pi-crew:scheduler")]`, which
// was fragile (cross-realm, no lifecycle, peer extensions could overwrite it).
type SchedulerRef = {
	add(job: import("../../runtime/scheduling/scheduler.ts").ScheduledJob): void;
	list(): import("../../runtime/scheduling/scheduler.ts").ScheduledJob[];
	remove(id: string): boolean;
	update(
		id: string,
		patch: Partial<import("../../runtime/scheduling/scheduler.ts").ScheduledJob>,
	): import("../../runtime/scheduling/scheduler.ts").ScheduledJob | undefined;
	/** Trigger a job immediately (force — bypasses the enabled gate). */
	runNow(jobId: string): { ok: true } | { ok: false; error: string };
};

// Module-scoped scheduler instance — one per extension load (EXT-9).
let crewSchedulerInstance: SchedulerRef | undefined;

/** @internal — exported for lifecycle tests. */
export function getCrewScheduler(): SchedulerRef | undefined {
	return crewSchedulerInstance;
}

export function registerCrewScheduler(scheduler: SchedulerRef): void {
	crewSchedulerInstance = scheduler;
}

// Module-scoped hidden-count stash (P2-1, EXT-9 pattern): computed ONCE at
// session_start registration from the SAME tiers read that drove registration
// (no extra disk I/O), then served to paint-path consumers — the crew widget
// line and the dashboard pane render ticks must never hit the settings store
// (P0-6). undefined = never stashed (pre-registration / cleaned up / unit
// tests with a fake scheduler) → consumers treat it as 0.
let stashedScheduledJobsHiddenCount: number | undefined;

/** @internal — lifecycle wiring: stash the registration-time hidden count. */
export function stashScheduledJobsHiddenCount(count: number | undefined): void {
	stashedScheduledJobsHiddenCount = count;
}

/** @internal — test seam: read the raw stash (undefined = never stashed). */
export function getStashedScheduledJobsHiddenCount(): number | undefined {
	return stashedScheduledJobsHiddenCount;
}

/** Remove the scheduler singleton. Call during session cleanup. */
export function unregisterCrewScheduler(): void {
	crewSchedulerInstance = undefined;
	// P2-1: the hidden-count stash is registration-time state — clear it with
	// the singleton so a later session can never paint a stale gate hint.
	stashedScheduledJobsHiddenCount = undefined;
}

/**
 * SINGLE SOURCE OF TRUTH for scheduled-job READS (G17). Every consumer —
 * dashboard pane, /schedules command, crew widget — must read jobs through
 * this provider; no module may keep its own defaults/settings copy.
 *
 * Reads the module-scoped scheduler singleton when registered (the live view
 * the mutation handlers target); otherwise falls back to the SAME gated tiers
 * view the session-start registration loop consumes (`effectiveScheduledJobs`:
 * user-tier jobs always, project-tier only on explicit opt-in) so the fallback
 * can never disagree with what would register on next session start.
 */
export function getScheduledJobs(
	cwd: string = process.cwd(),
	globalFile?: string,
): import("../../runtime/scheduling/scheduler.ts").ScheduledJob[] {
	const scheduler = getCrewScheduler();
	if (scheduler) return scheduler.list();
	try {
		const tiers = loadCrewSettingsTiers(cwd, globalFile);
		return tiers.effectiveScheduledJobs.filter(isScheduledJobLike);
	} catch {
		return [];
	}
}

/** Shape guard for the settings fallback — mirrors settings-store's private
 * `validateScheduledJob` (id + scheduleType + enabled) so invalid persisted
 * entries are skipped instead of reaching renderers. */
function isScheduledJobLike(job: unknown): job is import("../../runtime/scheduling/scheduler.ts").ScheduledJob {
	if (!job || typeof job !== "object") return false;
	const obj = job as Record<string, unknown>;
	return typeof obj.id === "string" && obj.id.length > 0 && typeof obj.scheduleType === "string" && typeof obj.enabled === "boolean";
}

/**
 * P2-1 companion read to getScheduledJobs(): how many project-tier
 * scheduledJobs the B2 gate is hiding right now (for the "N project-tier jobs
 * hidden" hint).
 *
 * With the scheduler singleton registered, serves the REGISTRATION-TIME stash
 * (in-memory — paint-path safe, P0-6) computed from the exact tiers view the
 * registration loop gated. Without a scheduler (pre-registration, headless
 * command usage), computes from the same gated tiers view the provider
 * fallback uses — user-initiated surfaces only (pane/command); the widget's
 * default reader never reaches the compute branch because it gates on the
 * scheduler singleton exactly like defaultScheduledJobsReader.
 */
export function getScheduledJobsHiddenCountView(cwd: string = process.cwd(), globalFile?: string): number {
	if (getCrewScheduler()) return stashedScheduledJobsHiddenCount ?? 0;
	try {
		return computeScheduledJobsHiddenCount(cwd, globalFile);
	} catch {
		return 0;
	}
}

interface ScheduleParams {
	team?: string;
	goal?: string;
	task?: string;
	cron?: string;
	interval?: number;
	once?: number | string;
}

function buildScheduleSpec(params: ScheduleParams): {
	spec: import("../../runtime/scheduling/scheduler.ts").ScheduleSpec;
	schedule: string;
	scheduleType: import("../../runtime/scheduling/scheduler.ts").ScheduleType;
	intervalMs?: number;
} {
	// Priority: cron > interval > once
	if (params.cron) {
		const parsed = parseSchedule(params.cron);
		if ("error" in parsed) throw new Error(parsed.error);
		return {
			spec: parsed,
			schedule: params.cron,
			scheduleType: "cron" as const,
		};
	}
	if (params.interval !== undefined && (!Number.isFinite(params.interval) || params.interval <= 0)) {
		throw new Error("interval must be a positive finite number");
	}
	if (params.once !== undefined) {
		const ts = typeof params.once === "number" ? params.once : Date.parse(String(params.once));
		if (!Number.isFinite(ts)) throw new Error("once must be a valid timestamp");
	}
	if (params.interval !== undefined) {
		const specStr = `${params.interval}ms`;
		const spec = parseSchedule(specStr);
		if ("error" in spec) throw new Error(spec.error);
		return {
			spec,
			schedule: specStr,
			scheduleType: "interval" as const,
			intervalMs: params.interval,
		};
	}
	if (params.once !== undefined) {
		const ts = typeof params.once === "number" ? new Date(params.once).toISOString() : params.once;
		const parsed = parseSchedule(ts);
		if ("error" in parsed) throw new Error(parsed.error);
		return { spec: parsed, schedule: ts, scheduleType: "once" as const };
	}
	throw new Error("schedule requires one of: cron, interval, or once.");
}

function getSubAction(params: TeamToolParamsValue): string | undefined {
	const raw = params.subAction ?? (params.config as { subAction?: unknown } | undefined)?.subAction;
	return typeof raw === "string" ? raw.toLowerCase() : undefined;
}

function getJobIdParam(params: TeamToolParamsValue): string {
	const fromTop = typeof params.jobId === "string" ? params.jobId : "";
	const fromConfig = ((params.config as { jobId?: unknown } | undefined)?.jobId as string | undefined) ?? "";
	return (fromTop || fromConfig).trim();
}

export function handleSchedule(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	// Route subactions FIRST so remove/disable/enable don't require a goal.
	const subAction = getSubAction(params);
	if (subAction === "remove" || subAction === "delete") {
		return handleRemoveScheduled(params, ctx);
	}
	if (subAction === "disable" || subAction === "enable" || subAction === "update") {
		return handleUpdateScheduled(params, ctx);
	}
	if (subAction === "run-now") {
		return handleRunNowScheduled(params);
	}

	const team = params.team ?? "default";
	const goal = params.goal ?? params.task ?? "";
	if (!goal)
		return result(
			paramRequired("schedule", "goal or task", "{ action: 'schedule', goal: '...', cron: '0 9 * * *' }"),
			{ action: "schedule", status: "error" },
			true,
		);

	let specResult: ReturnType<typeof buildScheduleSpec>;
	try {
		specResult = buildScheduleSpec({
			team,
			goal,
			cron: params.cron,
			interval: params.interval,
			once: params.once as ScheduleParams["once"],
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return result(msg, { action: "schedule", status: "error" }, true);
	}

	const { spec, schedule, scheduleType, intervalMs } = specResult;
	const next = nextRunTime(spec);
	if ("error" in next) return result(next.error, { action: "schedule", status: "error" }, true);

	// Build the ScheduledJob
	const job: import("../../runtime/scheduling/scheduler.ts").ScheduledJob = {
		id: crypto.randomUUID(),
		name: `${team}: ${goal.slice(0, 60)}`,
		description: `Scheduled run for team '${team}'`,
		schedule,
		scheduleType,
		intervalMs,
		subagentType: "team",
		prompt: JSON.stringify({ action: "run", team, goal }),
		enabled: true,
		createdAt: new Date().toISOString(),
		nextRun: next.toISOString(),
		runCount: 0,
	};

	const scheduler = getCrewScheduler();
	if (!scheduler) {
		// Persist even if scheduler isn't running yet — register.ts loads them on startup.
		persistScheduledJob(ctx.cwd, job);
		return result(
			[
				`Scheduled job created (scheduler not yet running — will activate on next session start):`,
				`  Job ID: ${job.id}`,
				`  Team: ${team}`,
				`  Goal: ${goal}`,
				`  Schedule: ${humanizeSchedule(spec)}`,
				`  Next run: ${next.toISOString()}`,
			].join("\n"),
			{
				action: "schedule",
				status: "ok",
				data: {
					jobId: job.id,
					team,
					goal,
					schedule: humanizeSchedule(spec),
					nextRun: next.toISOString(),
					pending: true,
				},
			},
		);
	}

	scheduler.add(job);
	persistScheduledJob(ctx.cwd, job);

	return result(
		[
			`Scheduled job registered.`,
			`  Job ID: ${job.id}`,
			`  Team: ${team}`,
			`  Goal: ${goal}`,
			`  Schedule: ${humanizeSchedule(spec)}`,
			`  Next run: ${next.toISOString()}`,
		].join("\n"),
		{
			action: "schedule",
			status: "ok",
			data: {
				jobId: job.id,
				team,
				goal,
				schedule: humanizeSchedule(spec),
				nextRun: next.toISOString(),
			},
		},
	);
}

function scheduledJobsOf(settings: CrewSettings): import("../../runtime/scheduling/scheduler.ts").ScheduledJob[] {
	return Array.isArray(settings.scheduledJobs)
		? (settings.scheduledJobs as import("../../runtime/scheduling/scheduler.ts").ScheduledJob[])
		: [];
}

function persistScheduledJob(cwd: string, job: import("../../runtime/scheduling/scheduler.ts").ScheduledJob): void {
	try {
		updateCrewSettings(cwd, (settings) => ({
			...settings,
			scheduledJobs: [...scheduledJobsOf(settings), job],
		}));
	} catch {
		/* best-effort persistence */
	}
}

/** Update an existing scheduled job in persistent settings. */
export function persistScheduledJobUpdate(cwd: string, job: import("../../runtime/scheduling/scheduler.ts").ScheduledJob): void {
	try {
		updateCrewSettings(cwd, (settings) => ({
			...settings,
			scheduledJobs: scheduledJobsOf(settings).map((j) => (j.id === job.id ? job : j)),
		}));
	} catch {
		/* best-effort persistence */
	}
}

/** Remove a scheduled job from persistent settings. */
function persistScheduledJobRemove(cwd: string, jobId: string): void {
	try {
		updateCrewSettings(cwd, (settings) => ({
			...settings,
			scheduledJobs: scheduledJobsOf(settings).filter((j) => j.id !== jobId),
		}));
	} catch {
		/* best-effort persistence */
	}
}

export function handleListScheduled(_params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const scheduler = getCrewScheduler();
	if (!scheduler) return result("Scheduler not running.", { action: "scheduled", status: "error" }, true);
	const jobs = scheduler.list();
	if (jobs.length === 0)
		return result("No scheduled jobs.", {
			action: "scheduled",
			status: "ok",
		});
	const lines: string[] = [`Scheduled jobs (${jobs.length}):`];
	for (const job of jobs) {
		lines.push(
			`  [${job.id}] ${job.name}`,
			`    Schedule: ${job.schedule} (${job.scheduleType})`,
			`    Enabled: ${job.enabled}`,
			`    Next run: ${job.nextRun ?? "(unscheduled)"}`,
			`    Runs: ${job.runCount}, Last: ${job.lastRun ?? "(never)"} [${job.lastStatus ?? "?"}]`,
		);
		if (job.spawnedRunIds && job.spawnedRunIds.length > 0) {
			lines.push(`    Spawned runs: ${job.spawnedRunIds.join(", ")}`);
		}
	}
	return result(lines.join("\n"), { action: "scheduled", status: "ok" });
}

/**
 * Remove a scheduled job. Mirrors the `cancel` action for runs.
 *
 * Usage:
 *   team action='schedule' subAction='remove' jobId='<uuid>'
 *   team action='schedule' subAction='delete' jobId='<uuid>'
 */
export function handleRemoveScheduled(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const jobId = getJobIdParam(params);
	if (!jobId) {
		return result(
			"subAction=remove requires jobId. Usage: team action='schedule' subAction='remove' jobId='<uuid>'",
			{ action: "schedule", status: "error" },
			true,
		);
	}
	const scheduler = getCrewScheduler();
	if (!scheduler) {
		return result("Scheduler not running.", { action: "schedule", status: "error" }, true);
	}
	const removed = scheduler.remove(jobId);
	persistScheduledJobRemove(ctx.cwd, jobId);
	if (!removed) {
		return result(`No scheduled job with id '${jobId}'.`, { action: "schedule", status: "error" }, true);
	}
	return result([`Scheduled job removed.`, `  Job ID: ${jobId}`].join("\n"), {
		action: "schedule",
		status: "ok",
		data: { jobId, removed: true },
	});
}

/**
 * Update a scheduled job — toggle enabled flag or apply patches.
 *
 * Usage:
 *   team action='schedule' subAction='disable' jobId='<uuid>'
 *   team action='schedule' subAction='enable'  jobId='<uuid>'
 *   team action='schedule' subAction='update'  jobId='<uuid>' cron='0 9 * * *'
 */
export function handleUpdateScheduled(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const jobId = getJobIdParam(params);
	if (!jobId) {
		return result(
			"subAction=update requires jobId. Usage: team action='schedule' subAction='update|enable|disable' jobId='<uuid>'",
			{ action: "schedule", status: "error" },
			true,
		);
	}
	const subAction = typeof params.subAction === "string" ? params.subAction.toLowerCase() : "update";
	const scheduler = getCrewScheduler();
	if (!scheduler) {
		return result("Scheduler not running.", { action: "schedule", status: "error" }, true);
	}

	const patch: Partial<import("../../runtime/scheduling/scheduler.ts").ScheduledJob> = {};
	if (subAction === "disable") patch.enabled = false;
	if (subAction === "enable") patch.enabled = true;
	// For generic "update", allow patch of cron / interval / goal.
	if (subAction === "update") {
		if (typeof params.cron === "string") patch.schedule = params.cron;
		if (typeof params.goal === "string" || typeof params.task === "string") {
			patch.description = typeof params.task === "string" ? params.task : params.goal;
		}
	}

	const updated = scheduler.update(jobId, patch);
	if (!updated) {
		return result(`No scheduled job with id '${jobId}'.`, { action: "schedule", status: "error" }, true);
	}
	persistScheduledJobUpdate(ctx.cwd, updated);
	return result(
		[`Scheduled job updated.`, `  Job ID: ${jobId}`, `  Enabled: ${updated.enabled}`, `  Schedule: ${updated.schedule}`].join("\n"),
		{ action: "schedule", status: "ok", data: { jobId, enabled: updated.enabled, schedule: updated.schedule } },
	);
}

/**
 * Trigger a scheduled job immediately — the UI "run now" channel. Runs even
 * when the job is disabled (explicit user action); completion tracking stays
 * on the scheduler's async finalization path.
 *
 * Usage:
 *   team action='schedule' subAction='run-now' jobId='<uuid>'
 */
export function handleRunNowScheduled(params: TeamToolParamsValue): PiTeamsToolResult {
	const jobId = getJobIdParam(params);
	if (!jobId) {
		return result(
			"subAction=run-now requires jobId. Usage: team action='schedule' subAction='run-now' jobId='<uuid>'",
			{ action: "schedule", status: "error" },
			true,
		);
	}
	const scheduler = getCrewScheduler();
	if (!scheduler) {
		return result("Scheduler not running.", { action: "schedule", status: "error" }, true);
	}
	const outcome = scheduler.runNow(jobId);
	if (!outcome.ok) {
		return result(outcome.error, { action: "schedule", status: "error" }, true);
	}
	return result([`Scheduled job triggered.`, `  Job ID: ${jobId}`].join("\n"), {
		action: "schedule",
		status: "ok",
		data: { jobId, triggered: true },
	});
}
