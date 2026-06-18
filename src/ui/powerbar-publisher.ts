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
import { notificationBadge } from "./widget/widget-formatters.ts";
import { RenderCoalescer } from "./render-coalescer.ts";
import { allWorkflows, discoverWorkflows } from "../workflows/discover-workflows.ts";
import type { WorkflowConfig, WorkflowStep } from "../workflows/workflow-config.ts";

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
	safeEmit(events, "powerbar:register-segment", { id: "pi-crew-steps", label: "pi-crew workflow steps" });
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
		lastStepsKey = undefined;
		safeEmit(events, "powerbar:update", { id: "pi-crew-active" });
		safeEmit(events, "powerbar:update", { id: "pi-crew-progress" });
		safeEmit(events, "powerbar:update", { id: "pi-crew-steps" });
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
	// Always show consistent status: running count + queued count from live tasks only
	// Avoid snapshot cache for counts to prevent UI jumping
	const runningCount = agents.filter((a) => a.status === "running").length;
	// Count queued/waiting tasks directly from tasks array (not snapshot) for consistency
	const queuedCount = active.reduce((sum, item) => sum + item.tasks.reduce((s, t) => s + (t.status === "queued" || t.status === "waiting" ? 1 : 0), 0), 0);
	// Format: "1 running", "2 running · 1 queued", "3 queued", "idle"
	const runningLabel = runningCount === 1 ? "1 running" : `${runningCount} running`;
	const queuedLabel = queuedCount === 1 ? "1 queued" : `${queuedCount} queued`;
	const crewStatus = runningCount > 0 && queuedCount > 0 ? `${runningLabel} · ${queuedLabel}` : runningCount > 0 ? runningLabel : queuedCount > 0 ? queuedLabel : "idle";
	const liveSuffix = liveRunning > 0 ? ` (${liveRunning} live)` : "";
	const notificationText = notificationBadge(notificationCount);
	// Always show model + tokens as suffix when available (for activePayload consistency)
	const suffixParts = [model, tokenText].filter(Boolean);
	const activeSuffix = suffixParts.length > 0 ? suffixParts.join(" · ") : undefined;
	// Progress always includes token count for consistency
	const progressSuffix = `${completed}/${total}${tokenText ? ` · ${tokenText}` : ""}`;
	// Build complete, always-consistent fallback text AND event payload to prevent UI flickering
	// Both fallback and events must use the SAME format - no conditional display
	// Format: "⚙ 1 running · 1 queued · model · 30k · 0/1" (never changes based on availability)
	const progressPart = `${completed}/${total}`;
	const allParts = [`⚙ ${crewStatus}`, model ?? "", tokenText ?? "", progressPart].filter(Boolean);
	const unifiedText = allParts.join(" · ");
	// activePayload.text includes notification badge for event payload
	const activePayload = {
		id: "pi-crew-active",
		icon: "⚙",
		text: `⚙ ${crewStatus}${liveSuffix}${notificationText}${activeSuffix ? ` · ${activeSuffix}` : ""}`,
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
	// Build step progress: "explorer > planner > executor > verifier" with current step highlighted
	const stepsPayload = buildStepsPayload(active, tasks);
	// 1.8: dedup per segment using a key over every visible field. Previously
	// the dedup string only carried text/suffix/running, so changes to `bar`
	// (progress %) or `color` could be swallowed and stale UI emitted again
	// later as a single noisy burst.
	const activeKey = powerbarKey(activePayload);
	const progressKey = powerbarKey(progressPayload);
	const stepsKey = powerbarKey(stepsPayload);
	if (activeKey !== lastActiveKey) {
		lastActiveKey = activeKey;
		safeEmit(events, "powerbar:update", activePayload);
	}
	if (progressKey !== lastProgressKey) {
		lastProgressKey = progressKey;
		safeEmit(events, "powerbar:update", progressPayload);
	}
	if (stepsKey !== lastStepsKey) {
		lastStepsKey = stepsKey;
		safeEmit(events, "powerbar:update", stepsPayload);
	}
	// Never call setStatusFallback - crew-widget manages "pi-crew" status with its own widget format
	// Powerbar only emits events; it does not set status directly
}

// --- Dedup state: skip emit if segment data unchanged ---
let lastActiveKey: string | undefined;
let lastProgressKey: string | undefined;
let lastStepsKey: string | undefined;

interface PowerbarPayloadShape {
	id?: string;
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

interface ActiveItem {
	run: TeamRunManifest;
	agents: ReturnType<typeof readCrewAgents>;
	tasks: TeamTaskState[];
	snapshot?: RunUiSnapshot;
}

/**
 * Build the workflow steps segment showing: ✓explore › →plan › ○execute › ○verify
 * with the current/active step highlighted using → arrow.
 */
function buildStepsPayload(active: ActiveItem[], allTasks: TeamTaskState[]): PowerbarPayloadShape {
	if (!active.length) {
		return { id: "pi-crew-steps" };
	}
	const run = active[0]!.run;
	const workflowName = run.workflow ?? "default";
	// Load workflow steps
	const workflows = allWorkflows(discoverWorkflows(run.cwd));
	const workflow = workflows.find((w) => w.name === workflowName);
	if (!workflow || workflow.steps.length === 0) {
		return { id: "pi-crew-steps", text: workflowName };
	}
	// Build step status map from tasks
	const stepStatus = new Map<string, "completed" | "running" | "pending">();
	for (const task of allTasks) {
		if (!task.stepId) continue;
		if (!stepStatus.has(task.stepId)) {
			if (task.status === "completed") {
				stepStatus.set(task.stepId, "completed");
			} else if (task.status === "running" || task.status === "queued" || task.status === "waiting") {
				stepStatus.set(task.stepId, "running");
			}
		}
	}
	// Format: "✓explore › →plan › ○execute › ○verify"
	// ✓ = completed, → = running (current), ○ = pending
	const stepParts: string[] = [];
	for (const step of workflow.steps) {
		const status = stepStatus.get(step.id) ?? "pending";
		const icon = status === "completed" ? "✓" : status === "running" ? "→" : "○";
		// Shorten long step names
		const stepName = step.id.length > 10 ? step.id.slice(0, 9) + "…" : step.id;
		stepParts.push(`${icon}${stepName}`);
	}
	const stepsText = stepParts.join(" › ");
	// Color: accent if running step exists, success if all complete, dim otherwise
	const hasRunningStep = [...stepStatus.values()].includes("running");
	const allComplete = stepStatus.size === workflow.steps.length && ![...stepStatus.values()].includes("running");
	const color = allComplete ? "success" : hasRunningStep ? "accent" : "dim";
	return {
		id: "pi-crew-steps",
		text: stepsText,
		color,
	};
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
	powerbarCoalescer.flush();
	powerbarCoalescer.dispose();
}

export function clearPiCrewPowerbar(events: EventBus): void {
	lastActiveKey = undefined;
	lastProgressKey = undefined;
	lastStepsKey = undefined;
	safeEmit(events, "powerbar:update", { id: "pi-crew-active" });
	safeEmit(events, "powerbar:update", { id: "pi-crew-progress" });
	safeEmit(events, "powerbar:update", { id: "pi-crew-steps" });
}

/** Reset dedup state on session lifecycle events. */
export function resetPowerbarDedupState(): void {
	lastActiveKey = undefined;
	lastProgressKey = undefined;
	lastStepsKey = undefined;
}
