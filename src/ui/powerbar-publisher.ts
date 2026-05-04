import * as fs from "node:fs";
import { listRecentRuns } from "../extension/run-index.ts";
import type { CrewUiConfig } from "../config/config.ts";
import { readCrewAgents } from "../runtime/crew-agent-records.ts";
import { readJsonFileCoalesced } from "../utils/file-coalescer.ts";
import type { TeamTaskState, TeamRunManifest } from "../state/types.ts";
import { aggregateUsage } from "../state/usage.ts";
import { isDisplayActiveRun } from "../runtime/process-status.ts";
import { logInternalError } from "../utils/internal-error.ts";
import type { ManifestCache } from "../runtime/manifest-cache.ts";
import type { RunSnapshotCache, RunUiSnapshot } from "./snapshot-types.ts";
import { notificationBadge } from "./crew-widget.ts";

type EventBus = { emit?: (event: string, data: unknown) => void; listenerCount?: (event: string) => number } | undefined;
type StatusContext = { hasUI?: boolean; ui?: { setStatus?: (key: string, text: string | undefined) => void } } | undefined;

const TASK_READ_TTL_MS = 200;

function hasPowerbarConsumer(events: EventBus): boolean {
	try {
		return (events?.listenerCount?.("powerbar:register-segment") ?? 0) > 0 || (events?.listenerCount?.("powerbar:update") ?? 0) > 0;
	} catch {
		return false;
	}
}

function setStatusFallback(ctx: StatusContext, text: string | undefined): void {
	try {
		if (ctx?.hasUI) ctx.ui?.setStatus?.("pi-crew", text);
	} catch (error) {
		logInternalError("powerbar.statusFallback", error);
	}
}

function safeEmit(events: EventBus, event: string, data: unknown): void {
	try {
		events?.emit?.(event, data);
	} catch (error) {
		logInternalError("powerbar.safeEmit", error, `event=${event}`);
	}
}

function readTasks(tasksPath: string): TeamTaskState[] {
	try {
		const parse = () => {
			const parsed = JSON.parse(fs.readFileSync(tasksPath, "utf-8"));
			return Array.isArray(parsed) ? (parsed as TeamTaskState[]) : [];
		};
		return readJsonFileCoalesced(tasksPath, TASK_READ_TTL_MS, parse);
	} catch (error) {
		logInternalError("powerbar.readTasks", error, tasksPath);
		return [];
	}
}

export function compactTokens(total: number): string {
	return total >= 1000 ? `${Math.round(total / 1000)}k` : `${total}`;
}

export function registerPiCrewPowerbarSegments(events: EventBus, config?: CrewUiConfig): void {
	if (config?.powerbar === false) return;
	safeEmit(events, "powerbar:register-segment", { id: "pi-crew-active", label: "pi-crew active agents" });
	safeEmit(events, "powerbar:register-segment", { id: "pi-crew-progress", label: "pi-crew run progress" });
}

export function updatePiCrewPowerbar(events: EventBus, cwd: string, config?: CrewUiConfig, manifestCache?: ManifestCache, snapshotCache?: RunSnapshotCache, ctx?: StatusContext, notificationCount = 0, preloadedManifests?: TeamRunManifest[]): void {
	if (config?.powerbar === false) return;
	const useStatusFallback = !hasPowerbarConsumer(events);
	const runs = preloadedManifests ?? (manifestCache ? manifestCache.list(20) : listRecentRuns(cwd, 20));
	const active = runs.map((run) => {
		let snapshot: RunUiSnapshot | undefined;
		try {
			snapshot = snapshotCache?.get(run.runId) ?? snapshotCache?.refreshIfStale(run.runId);
		} catch (error) {
			logInternalError("powerbar.snapshot", error, run.runId);
		}
		if (snapshot) return { run: snapshot.manifest, agents: snapshot.agents, tasks: snapshot.tasks, snapshot };
		let agents: ReturnType<typeof readCrewAgents> = [];
		try {
			agents = readCrewAgents(run);
		} catch (error) {
			logInternalError("powerbar.readCrewAgents", error, run.runId);
		}
		return { run, agents, tasks: readTasks(run.tasksPath), snapshot };
	}).filter((item) => isDisplayActiveRun(item.run, item.agents));
	if (!active.length) {
		safeEmit(events, "powerbar:update", { id: "pi-crew-active" });
		safeEmit(events, "powerbar:update", { id: "pi-crew-progress" });
		if (useStatusFallback) setStatusFallback(ctx, undefined);
		return;
	}
	const agents = active.flatMap((item) => item.agents);
	const tasks = active.flatMap((item) => item.tasks);
	const running = agents.filter((agent) => agent.status === "running").length;
	const waiting = active.reduce((sum, item) => sum + (item.snapshot?.progress.queued ?? item.tasks.reduce((s, t) => s + (t.status === "queued" ? 1 : 0), 0)), 0);
	const completed = active.reduce((sum, item) => sum + (item.snapshot?.progress.completed ?? item.tasks.reduce((s, t) => s + (t.status === "completed" ? 1 : 0), 0)), 0);
	const total = Math.max(1, active.reduce((sum, item) => sum + (item.snapshot?.progress.total ?? item.tasks.length), 0) || agents.length);
	const usage = aggregateUsage(tasks);
	const snapshotTokens = active.reduce((sum, item) => sum + (item.snapshot ? item.snapshot.usage.tokensIn + item.snapshot.usage.tokensOut : 0), 0);
	const hasUsage = usage && ((usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)) > 0;
	const tokenTotal = hasUsage ? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) : snapshotTokens;
	const model = config?.showModel === false ? undefined : agents.find((agent) => agent.model)?.model?.split("/").at(-1);
	const tokenText = config?.showTokens === false || !tokenTotal ? undefined : compactTokens(tokenTotal);
	const activeText = `crew ${running}a/${waiting}w${notificationBadge(notificationCount)}`;
	const activeSuffix = [model, tokenText].filter(Boolean).join(" · ") || undefined;
	const progressSuffix = `${completed}/${total}${tokenText ? ` · ${tokenText}` : ""}`;
	safeEmit(events, "powerbar:update", {
		id: "pi-crew-active",
		icon: "⚙",
		text: activeText,
		suffix: activeSuffix,
		color: running ? "accent" : "warning",
	});
	safeEmit(events, "powerbar:update", {
		id: "pi-crew-progress",
		text: (active[0]?.run as TeamRunManifest)?.team ?? "crew",
		bar: Math.round((completed / total) * 100),
		suffix: progressSuffix,
		color: completed === total ? "success" : "accent",
		barSegments: 8,
	});
	if (useStatusFallback) setStatusFallback(ctx, `${activeText}${activeSuffix ? ` · ${activeSuffix}` : ""} · ${progressSuffix}`);
}

export function clearPiCrewPowerbar(events: EventBus, ctx?: StatusContext): void {
	safeEmit(events, "powerbar:update", { id: "pi-crew-active" });
	safeEmit(events, "powerbar:update", { id: "pi-crew-progress" });
	setStatusFallback(ctx, undefined);
}
