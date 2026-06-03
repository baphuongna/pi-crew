import * as crypto from "node:crypto";
import type { PiTeamsToolResult } from "../tool-result.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { result, type TeamContext } from "./context.ts";
import { humanizeSchedule, nextRunTime, parseSchedule } from "../../runtime/scheduler.ts";
import { loadCrewSettings, saveCrewSettings } from "../../runtime/settings-store.ts";

// Global key for cross-module scheduler access.
const CREW_SCHEDULER_KEY = Symbol.for("pi-crew:scheduler");
type SchedulerRef = { add(job: import("../../runtime/scheduler.ts").ScheduledJob): void; list(): import("../../runtime/scheduler.ts").ScheduledJob[] };

function getCrewScheduler(): SchedulerRef | undefined {
	return (globalThis as Record<symbol | string, unknown>)[CREW_SCHEDULER_KEY] as SchedulerRef | undefined;
}

export function registerCrewScheduler(scheduler: SchedulerRef): void {
	(globalThis as Record<symbol | string, unknown>)[CREW_SCHEDULER_KEY] = scheduler;
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
	spec: import("../../runtime/scheduler.ts").ScheduleSpec;
	schedule: string;
	scheduleType: import("../../runtime/scheduler.ts").ScheduleType;
	intervalMs?: number;
} {
	// Priority: cron > interval > once
	if (params.cron) {
		const parsed = parseSchedule(params.cron);
		if ("error" in parsed) throw new Error(parsed.error);
		return { spec: parsed, schedule: params.cron, scheduleType: "cron" as const };
	}
	if (params.interval !== undefined && params.interval > 0) {
		const specStr = `${params.interval}ms`;
		const spec = parseSchedule(specStr);
		if ("error" in spec) throw new Error(spec.error);
		return { spec, schedule: specStr, scheduleType: "interval" as const, intervalMs: params.interval };
	}
	if (params.once !== undefined) {
		const ts = typeof params.once === "number" ? new Date(params.once).toISOString() : params.once;
		const parsed = parseSchedule(ts);
		if ("error" in parsed) throw new Error(parsed.error);
		return { spec: parsed, schedule: ts, scheduleType: "once" as const };
	}
	throw new Error("schedule requires one of: cron, interval, or once.");
}

export function handleSchedule(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const team = params.team ?? "default";
	const goal = params.goal ?? params.task ?? "";
	if (!goal) return result("Schedule requires goal or task.", { action: "schedule", status: "error" }, true);

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
	const job: import("../../runtime/scheduler.ts").ScheduledJob = {
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

function persistScheduledJob(cwd: string, job: import("../../runtime/scheduler.ts").ScheduledJob): void {
	try {
		const settings = loadCrewSettings(cwd);
		const existingJobs: import("../../runtime/scheduler.ts").ScheduledJob[] = Array.isArray(
			(settings as Record<string, unknown>).scheduledJobs,
		)
			? ((settings as Record<string, unknown>).scheduledJobs as import("../../runtime/scheduler.ts").ScheduledJob[])
			: [];
		saveCrewSettings(
			{ ...settings, scheduledJobs: [...existingJobs, job] } as Parameters<typeof saveCrewSettings>[0],
			cwd,
		);
	} catch {
		/* best-effort persistence */
	}
}

export function handleListScheduled(_params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const scheduler = getCrewScheduler();
	if (!scheduler) return result("Scheduler not running.", { action: "scheduled", status: "error" }, true);
	const jobs = scheduler.list();
	if (jobs.length === 0) return result("No scheduled jobs.", { action: "scheduled", status: "ok" });
	const lines: string[] = [`Scheduled jobs (${jobs.length}):`];
	for (const job of jobs) {
		lines.push(
			`  [${job.id}] ${job.name}`,
			`    Schedule: ${job.schedule} (${job.scheduleType})`,
			`    Enabled: ${job.enabled}`,
			`    Next run: ${job.nextRun ?? "(unscheduled)"}`,
			`    Runs: ${job.runCount}, Last: ${job.lastRun ?? "(never)"} [${job.lastStatus ?? "?"}]`,
		);
	}
	return result(lines.join("\n"), { action: "scheduled", status: "ok" });
}