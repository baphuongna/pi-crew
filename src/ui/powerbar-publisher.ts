import * as fs from "node:fs";
import { listRecentRuns } from "../extension/run-index.ts";
import type { CrewUiConfig } from "../config/config.ts";
import { readCrewAgents } from "../runtime/crew-agent-records.ts";
import { readJsonFileCoalesced } from "../utils/file-coalescer.ts";
import type { TeamTaskState, TeamRunManifest } from "../state/types.ts";
import { aggregateUsage } from "../state/usage.ts";
import { isDisplayActiveRun } from "../runtime/process-status.ts";
import { listLiveAgents } from "../runtime/live-agent-manager.ts";
import { logInternalError } from "../utils/internal-error.ts";
import type { ManifestCache } from "../runtime/manifest-cache.ts";
import type { RunSnapshotCache, RunUiSnapshot } from "./snapshot-types.ts";
import { notificationBadge } from "./crew-widget.ts";
import { RenderCoalescer } from "./render-coalescer.ts";

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
			// 1.2: render path is read-only. Use cache.get() only; the background
			// preload loop in register.ts populates entries on its own cadence.
			snapshot = snapshotCache?.get(run.runId);
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
		lastActiveKey = undefined;
		lastProgressKey = undefined;
		safeEmit(events, "powerbar:update", { id: "pi-crew-active" });
		safeEmit(events, "powerbar:update", { id: "pi-crew-progress" });
		if (useStatusFallback) setStatusFallback(ctx, undefined);
		return;
	}
	const agents = active.flatMap((item) => item.agents);
	const tasks = active.flatMap((item) => item.tasks);
	const running = agents.filter((agent) => agent.status === "running").length;
	const waiting = active.reduce((sum, item) => sum + (item.snapshot ? item.snapshot.progress.queued + (item.snapshot.progress.waiting ?? 0) : item.tasks.reduce((s, t) => s + (t.status === "queued" || t.status === "waiting" ? 1 : 0), 0)), 0);
	const completed = active.reduce((sum, item) => sum + (item.snapshot?.progress.completed ?? item.tasks.reduce((s, t) => s + (t.status === "completed" ? 1 : 0), 0)), 0);
	const total = Math.max(1, active.reduce((sum, item) => sum + (item.snapshot?.progress.total ?? item.tasks.length), 0) || agents.length);
	const usage = aggregateUsage(tasks);
	const snapshotTokens = active.reduce((sum, item) => sum + (item.snapshot ? item.snapshot.usage.tokensIn + item.snapshot.usage.tokensOut : 0), 0);
	const hasUsage = usage && ((usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)) > 0;
	const tokenTotal = hasUsage ? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) : snapshotTokens;
	const model = config?.showModel === false ? undefined : agents.find((agent) => agent.model)?.model?.split("/").at(-1);
	const tokenText = config?.showTokens === false || !tokenTotal ? undefined : compactTokens(tokenTotal);
	const liveRunning = listLiveAgents().filter((a) => a.status === "running").length;
	const activeText = `crew ${running}a/${waiting}w${liveRunning > 0 ? `/${liveRunning}live` : ""}${notificationBadge(notificationCount)}`;
	const activeSuffix = [model, tokenText].filter(Boolean).join(" · ") || undefined;
	const progressSuffix = `${completed}/${total}${tokenText ? ` · ${tokenText}` : ""}`;
	const activePayload = {
		id: "pi-crew-active",
		icon: "⚙",
		text: activeText,
		suffix: activeSuffix,
		color: running ? "accent" : "warning",
	} as const;
	const progressPayload = {
		id: "pi-crew-progress",
		text: (active[0]?.run as TeamRunManifest)?.team ?? "crew",
		bar: Math.round((completed / total) * 100),
		suffix: progressSuffix,
		color: completed === total ? "success" : "accent",
		barSegments: 8,
	} as const;
	// 1.8: dedup per segment using a key over every visible field. Previously
	// the dedup string only carried text/suffix/running, so changes to `bar`
	// (progress %) or `color` could be swallowed and stale UI emitted again
	// later as a single noisy burst.
	const activeKey = powerbarKey(activePayload);
	const progressKey = powerbarKey(progressPayload);
	if (activeKey !== lastActiveKey) {
		lastActiveKey = activeKey;
		safeEmit(events, "powerbar:update", activePayload);
	}
	if (progressKey !== lastProgressKey) {
		lastProgressKey = progressKey;
		safeEmit(events, "powerbar:update", progressPayload);
	}
	if (useStatusFallback) setStatusFallback(ctx, `${activeText}${activeSuffix ? ` · ${activeSuffix}` : ""} · ${progressSuffix}`);
}

// --- Dedup state: skip emit if segment data unchanged ---
let lastActiveKey: string | undefined;
let lastProgressKey: string | undefined;

interface PowerbarPayloadShape {
	text?: string;
	suffix?: string;
	bar?: number;
	color?: string;
	icon?: string;
	barSegments?: number;
}

function powerbarKey(payload: PowerbarPayloadShape): string {
	return `${payload.text ?? ""}|${payload.suffix ?? ""}|${payload.bar ?? ""}|${payload.color ?? ""}|${payload.icon ?? ""}|${payload.barSegments ?? ""}`;
}

// --- Coalesced powerbar update ---

interface PowerbarUpdateArgs {
	events: EventBus;
	cwd: string;
	config?: CrewUiConfig;
	manifestCache?: ManifestCache;
	snapshotCache?: RunSnapshotCache;
	ctx?: StatusContext;
	notificationCount: number;
	preloadedManifests?: TeamRunManifest[];
}

let latestArgs: PowerbarUpdateArgs | null = null;

const powerbarCoalescer = new RenderCoalescer(() => {
	if (!latestArgs) return;
	const a = latestArgs;
	latestArgs = null;
	updatePiCrewPowerbar(a.events, a.cwd, a.config, a.manifestCache, a.snapshotCache, a.ctx, a.notificationCount, a.preloadedManifests);
}, 200);

/**
 * Request a coalesced powerbar update. Multiple rapid calls are batched into a single
 * render pass within 200ms, preventing UI flicker from event bursts.
 */
export function requestPowerbarUpdate(
	events: EventBus,
	cwd: string,
	config?: CrewUiConfig,
	manifestCache?: ManifestCache,
	snapshotCache?: RunSnapshotCache,
	ctx?: StatusContext,
	notificationCount = 0,
	preloadedManifests?: TeamRunManifest[],
): void {
	if (config?.powerbar === false) return;
	latestArgs = { events, cwd, config, manifestCache, snapshotCache, ctx, notificationCount, preloadedManifests };
	powerbarCoalescer.request();
}

/** Dispose the powerbar coalescer. Call during extension cleanup. */
export function disposePowerbarCoalescer(): void {
	powerbarCoalescer.dispose();
}

export function clearPiCrewPowerbar(events: EventBus, ctx?: StatusContext): void {
	lastActiveKey = undefined;
	lastProgressKey = undefined;
	safeEmit(events, "powerbar:update", { id: "pi-crew-active" });
	safeEmit(events, "powerbar:update", { id: "pi-crew-progress" });
	setStatusFallback(ctx, undefined);
}

/** Reset dedup state on session lifecycle events. */
export function resetPowerbarDedupState(): void {
	lastActiveKey = undefined;
	lastProgressKey = undefined;
}
