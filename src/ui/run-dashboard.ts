import * as fs from "node:fs";
import type { MetricRegistry } from "../observability/metric-registry.ts";
import { readCrewAgents } from "../runtime/crew-agent-records.ts";
import type { CrewAgentRecord } from "../runtime/crew-agent-runtime.ts";
import { getLiveAgentContextPercent } from "../runtime/live-session/live-agent-manager.ts";
import { isPlanApprovalPending } from "../runtime/plan-approval.ts";
import { isDisplayActiveRun, isLikelyOrphanedActiveRun } from "../runtime/process-status.ts";
import type { TeamRunManifest, TeamTaskState, UsageState } from "../state/types.ts";
import { aggregateUsage } from "../state/usage.ts";
import { readJsonFileCoalesced } from "../utils/file-coalescer.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";
import { pad, sanitizeLine, truncate, visibleWidth } from "../utils/visual.ts";
import type { InteractiveComponent } from "./component.ts";
import { renderAgentsPane } from "./dashboard-panes/agents-pane.ts";
import { summarizeTerminalReason } from "./dashboard-panes/cancellation-pane.ts";
import { renderHealthPane } from "./dashboard-panes/health-pane.ts";
import { renderMailboxPane } from "./dashboard-panes/mailbox-pane.ts";
import { renderMetricsPane } from "./dashboard-panes/metrics-pane.ts";
import { renderPlanPane } from "./dashboard-panes/plan-pane.ts";
import { renderProgressPane } from "./dashboard-panes/progress-pane.ts";
import { renderTranscriptPane } from "./dashboard-panes/transcript-pane.ts";
import { DynamicCrewBorder } from "./dynamic-border.ts";
import { dashboardActionForKey } from "./keybinding-map.ts";
import { HelpOverlay } from "./overlays/help-overlay.ts";
import type { OverlaySchedulerHandle } from "./shared-overlay-scheduler.ts";
import { registerOverlayScheduler } from "./shared-overlay-scheduler.ts";
import type { RunSnapshotCache, RunUiSnapshot } from "./snapshot-types.ts";
import { spinnerBucket, spinnerFrame } from "./spinner.ts";
import { applyStatusColor, colorizeStatusGlyphs, iconForStatus, type RunStatus } from "./status-colors.ts";
import type { CrewTheme } from "./theme-adapter.ts";
import { asCrewTheme, subscribeThemeChange } from "./theme-adapter.ts";
import { renderLines } from "./widget/widget-renderer.ts";

/** S05 — wrap a pane render in try/catch so a single pane crash does not bring down the whole dashboard. */
function safeRenderPane(name: string, fn: () => string[]): string[] {
	try {
		return fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logInternalError("run-dashboard", new Error(`Dashboard pane '${name}' render failed: ${message}`));
		return [`<error: ${name}>`];
	}
}

// PR-G3 (UI-3): extend the shared InteractiveComponent contract (render +
// invalidate + handleInput). Structurally identical — no behavior change.
interface DashboardComponent extends InteractiveComponent {}

export interface RunDashboardOptions {
	placement?: "center" | "right";
	showModel?: boolean;
	showTokens?: boolean;
	showTools?: boolean;
	snapshotCache?: RunSnapshotCache;
	runProvider?: () => TeamRunManifest[];
	registry?: MetricRegistry;
	/**
	 * Workspace/session ID for filtering runs and live agents. When provided,
	 * only runs with matching ownerSessionId and live agents with matching
	 * workspaceId are shown. This ensures session isolation in the UI.
	 */
	workspaceId?: string;
	/**
	 * Poke the host TUI to repaint after a state change. Must be wired from
	 * `commands.ts` (`() => requestRenderTarget(tui)`) so keypresses and event-bus
	 * updates immediately refresh the overlay instead of waiting on the next
	 * host tick. Without this the overlay can desync and base content (chat,
	 * status line) can paint through stale cells.
	 */
	requestRender?: () => void;
}

/**
 * Persisted per-process so that pressing `r` (reload) or closing+reopening the
 * dashboard within the same Pi session keeps the user on the pane they were
 * looking at. Resetting to "agents" on every `new RunDashboard(...)` was a
 * UX regression.
 */
let lastActivePane: "agents" | "progress" | "mailbox" | "output" | "health" | "metrics" | "plan" = "agents";

export type RunDashboardAction =
	| "status"
	| "summary"
	| "artifacts"
	| "api"
	| "events"
	| "agents"
	| "agent-events"
	| "agent-output"
	| "agent-transcript"
	| "agent-live"
	| "mailbox"
	| "reload"
	| "mailbox-detail"
	| "health-recovery"
	| "health-kill-stale"
	| "health-diagnostic-export"
	| "plan-approve"
	| "plan-deny"
	| "notifications-dismiss";
export interface RunDashboardSelection {
	runId: string;
	action: RunDashboardAction;
}

const TASK_READ_TTL_MS = 1000;

/** Max run rows rendered in the dashboard run-list block (L-1 window budget). */
const RUN_LIST_MAX = 8;

/**
 * 1.10 (UI-P1-2) — short TTL for the buildSignature cache. `buildSignature`
 * iterates every run and calls `snapshotFor → refreshIfStale`, which can
 * stat multiple files per run when the TTL expires. Rendering fires several
 * times per second (spinner + event-bus), so we cache the computed signature
 * for 100ms: enough to coalesce one render burst without holding the cache
 * across genuinely new data (>100ms idle means a fresh signature will be
 * computed on the next render anyway).
 */
const SIGNATURE_CACHE_TTL_MS = 100;

/**
 * F-4 — a live run's snapshot is considered "possibly stale" once its
 * `fetchedAt` is this old. A progressing run rebuilds on every stamp change,
 * so an old `fetchedAt` means the manifest read has been repeatedly flaky
 * (the cache silently returned the previous entry).
 */
const STALE_SNAPSHOT_MS = 15_000;

/** Left-pad `value` to a fixed VISIBLE width (ANSI-aware). Used by V-1. */
function padVis(value: string, width: number): string {
	const current = visibleWidth(value);
	return current >= width ? value : `${" ".repeat(width - current)}${value}`;
}

/**
 * L-1 — compute the run-list window (visible slots + which scroll indicators
 * render) for a given offset. Shared by `ensureRunListWindow()` and the
 * render loop so they ALWAYS agree and the selection can never land off-screen.
 */
interface RunListWindow {
	slots: number;
	hasTop: boolean;
	hasBottom: boolean;
}
function runListWindow(scrollOffset: number, count: number): RunListWindow {
	const hasTop = scrollOffset > 0;
	const availNoBottom = Math.max(1, RUN_LIST_MAX - (hasTop ? 1 : 0));
	const hasBottom = scrollOffset + availNoBottom < count;
	const slots = Math.max(1, RUN_LIST_MAX - (hasTop ? 1 : 0) - (hasBottom ? 1 : 0));
	return { slots, hasTop, hasBottom };
}

function formatAge(iso: string | undefined): string | undefined {
	if (!iso) return undefined;
	const ms = Math.max(0, Date.now() - new Date(iso).getTime());
	if (!Number.isFinite(ms)) return undefined;
	if (ms < 1000) return "now";
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
	return `${Math.floor(ms / 3_600_000)}h`;
}

function readProgressPreview(run: TeamRunManifest, maxLines = 5, snapshotCache?: RunSnapshotCache, resolve?: SnapshotResolver): string[] {
	// P0-6: prefer the snapshot's `recentOutputLines` (no disk I/O) over reading the
	// progress artifact on every render. The progress artifact content is captured
	// into the snapshot's recent events / output pipeline upstream.
	const snapshot = resolve ? resolve(run) : snapshotFor(run, snapshotCache);
	if (snapshot?.recentOutputLines?.length) {
		return ["Progress:", ...snapshot.recentOutputLines.slice(0, maxLines)];
	}
	if (snapshotCache) return ["Progress: (loading…)"];
	// Legacy fallback: tests/dev paths without a snapshot cache still read the
	// progress artifact directly so existing assertions keep working.
	const progress = [...run.artifacts].reverse().find((artifact) => artifact.kind === "progress");
	if (!progress) return ["Progress: (none)"];
	try {
		const progressPath = resolveRealContainedPath(run.artifactsRoot, progress.path);
		if (!fs.existsSync(progressPath)) return ["Progress: (none)"];
		return ["Progress:", ...fs.readFileSync(progressPath, "utf-8").split(/\r?\n/).filter(Boolean).slice(0, maxLines)];
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return [`Progress: failed to read (${message})`];
	}
}

function formatTokens(usage: UsageState | undefined): string | undefined {
	if (!usage) return undefined;
	const total = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	if (!total) return undefined;
	const compact = total >= 1000 ? `${(total / 1000).toFixed(total >= 10_000 ? 0 : 1)}k` : `${total}`;
	const parts = [`tok=${compact}`];
	if (usage.input) parts.push(`in=${usage.input}`);
	if (usage.output) parts.push(`out=${usage.output}`);
	if (usage.cacheRead) parts.push(`cache=${usage.cacheRead}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join("/");
}

function snapshotFor(run: TeamRunManifest, snapshotCache?: RunSnapshotCache): RunUiSnapshot | undefined {
	try {
		return snapshotCache?.refreshIfStale(run.runId);
	} catch {
		return snapshotCache?.get(run.runId);
	}
}

/**
 * PERF (2026-08-24, task 20) — per-frame snapshot resolver. The render path
 * used to resolve each run's snapshot 6-8 times per frame (refreshRuns,
 * buildSignature, groupedRuns, per-row, selected-run), and every
 * `snapshotFor → refreshIfStale` call can stat several files per run when its
 * own TTL expires. `renderUnsafe` now builds a frame-local Map keyed by runId
 * and threads this resolver through every render-path helper. Helpers keep
 * their plain direct-resolution behavior when no resolver is passed
 * (keypress handlers and other callers outside a render frame).
 */
type SnapshotResolver = (run: TeamRunManifest) => RunUiSnapshot | undefined;

function readRunTasks(run: TeamRunManifest, snapshotCache?: RunSnapshotCache, resolve?: SnapshotResolver): TeamTaskState[] {
	const snapshot = resolve ? resolve(run) : snapshotFor(run, snapshotCache);
	if (snapshot) return snapshot.tasks;
	// P0-6: when a snapshot cache is provided but hasn't populated yet, return
	// empty (the render loop falls back to the empty pane placeholder) instead
	// of reading the tasks.json file synchronously every render tick.
	if (snapshotCache) return [];
	const parse = () => {
		if (!fs.existsSync(run.tasksPath)) return [];
		const parsed = JSON.parse(fs.readFileSync(run.tasksPath, "utf-8"));
		return Array.isArray(parsed) ? (parsed as TeamTaskState[]) : [];
	};
	try {
		return readJsonFileCoalesced(run.tasksPath, TASK_READ_TTL_MS, parse);
	} catch {
		return [];
	}
}

function taskForAgent(tasks: TeamTaskState[], agent: CrewAgentRecord): TeamTaskState | undefined {
	return tasks.find((task) => task.id === agent.taskId);
}

function modelForTask(task: TeamTaskState | undefined): string | undefined {
	const attempts = task?.modelAttempts;
	if (!attempts?.length) return undefined;
	return attempts.find((attempt) => attempt.success)?.model ?? attempts.at(-1)?.model;
}

function modelForAgent(agent: CrewAgentRecord, task: TeamTaskState | undefined): string | undefined {
	return modelForTask(task) ?? agent.model;
}

function usageForAgent(agent: CrewAgentRecord, task: TeamTaskState | undefined): UsageState | undefined {
	return task?.usage ?? agent.usage;
}

function agentPreviewLine(agent: CrewAgentRecord, task: TeamTaskState | undefined, options: RunDashboardOptions): string {
	const stats = [
		agent.progress?.activityState,
		options.showModel !== false && modelForAgent(agent, task) ? `model=${modelForAgent(agent, task)}` : undefined,
		options.showTokens !== false
			? (formatTokens(usageForAgent(agent, task)) ??
				(agent.progress?.tokens !== undefined ? `tok=${agent.progress.tokens}` : undefined))
			: undefined,
		options.showTools !== false && agent.progress?.currentTool ? `tool=${agent.progress.currentTool}` : undefined,
		options.showTools !== false && agent.toolUses !== undefined ? `${agent.toolUses} tools` : undefined,
		agent.progress?.turns !== undefined ? `${agent.progress.turns} turns` : undefined,
		agent.progress?.failedTool ? `failedTool=${agent.progress.failedTool}` : undefined,
		agent.startedAt ? `age=${formatAge(agent.completedAt ?? agent.startedAt)}` : undefined,
	].filter((part): part is string => Boolean(part));
	const recent = agent.progress?.recentOutput?.at(-1);
	const icon = iconForStatus(agent.status, {
		runningGlyph: spinnerFrame(agent.taskId),
	});
	return sanitizeLine(
		`Agent: ${icon} ${agent.taskId} ${agent.role}->${agent.agent}${stats.length ? ` · ${stats.join(" · ")}` : ""}${recent ? ` ⎿ ${recent}` : ""}`,
	);
}

function readAgentPreview(run: TeamRunManifest, maxLines = 5, options: RunDashboardOptions = {}, resolve?: SnapshotResolver): string[] {
	try {
		const snapshot = resolve ? resolve(run) : snapshotFor(run, options.snapshotCache);
		// P0-6: when a snapshot cache is provided but hasn't populated yet, return
		// the empty-pane placeholder instead of calling `readCrewAgents` (disk I/O)
		// on every render tick. Legacy callers (no cache) keep the disk-read path
		// so existing unit tests continue to assert against concrete agent data.
		const agents = snapshot?.agents ?? (options.snapshotCache ? [] : readCrewAgents(run));
		const tasks = snapshot?.tasks ?? readRunTasks(run, options.snapshotCache, resolve);
		if (!agents.length) return ["Agents: (none)"];
		const totals = tasks.reduce(
			(acc, task) => {
				acc.input += task.usage?.input ?? 0;
				acc.output += task.usage?.output ?? 0;
				acc.cacheRead += task.usage?.cacheRead ?? 0;
				acc.cacheWrite += task.usage?.cacheWrite ?? 0;
				acc.cost += task.usage?.cost ?? 0;
				return acc;
			},
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } as {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				cost: number;
			},
		);
		const header = formatTokens(totals) ? `Agents: ${formatTokens(totals)}` : "Agents:";
		return [
			header,
			...agents.slice(0, maxLines).map((agent) => agentPreviewLine(agent, taskForAgent(tasks, agent), options)),
			...(agents.length > maxLines ? [`Agents: +${agents.length - maxLines} more`] : []),
		];
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return [`Agents: failed to read (${message})`];
	}
}

function agentsFor(run: TeamRunManifest, snapshotCache?: RunSnapshotCache, resolve?: SnapshotResolver): CrewAgentRecord[] {
	const snapshot = resolve ? resolve(run) : snapshotFor(run, snapshotCache);
	if (snapshot) return snapshot.agents;
	// P0-6: when a snapshot cache is provided but hasn't populated yet, return
	// empty (callers handle the empty-state placeholder) instead of calling
	// `readCrewAgents` synchronously on every render tick.
	if (snapshotCache) return [];
	try {
		return readCrewAgents(run);
	} catch {
		return [];
	}
}

function runLabel(
	run: TeamRunManifest,
	selected: boolean,
	snapshotCache?: RunSnapshotCache,
	maxW?: number,
	resolve?: SnapshotResolver,
): string {
	const agents = agentsFor(run, snapshotCache, resolve);
	const stale = isLikelyOrphanedActiveRun(run, agents);
	const running = agents.find((agent) => agent.status === "running");
	const queued = agents.find((agent) => agent.status === "queued");
	const step = stale
		? "orphaned queued run"
		: running
			? `step ${running.taskId}`
			: queued
				? `queued ${queued.taskId}`
				: `agents ${agents.length}`;
	const status: RunStatus = stale ? "stale" : (run.status as RunStatus);
	const marker = selected ? "›" : " ";
	const icon = iconForStatus(status, {
		runningGlyph: spinnerFrame(run.runId),
	});
	// L-5: unified " · " separator (was "|").
	// L-3: keep the GOAL (the human identifier) visible on narrow terminals —
	// when the full line overflows, sacrifice the meta prefix (runId/status
	// survive; team/workflow/step clip) rather than the goal. Optional `maxW`
	// enables the goal-aware truncation; legacy 3-arg callers (dev patch
	// scripts) get the untruncated full label.
	const head = `${marker} ${icon} ${run.runId.slice(-8)} ${status}`;
	const meta = `${run.team}/${run.workflow ?? "none"} · ${step}`;
	const goal = sanitizeLine(run.goal ?? "");
	if (maxW === undefined) return sanitizeLine(`${head} · ${meta} · ${goal}`);
	const sepW = 3; // " · "
	if (visibleWidth(head) + sepW + visibleWidth(meta) + sepW + visibleWidth(goal) <= maxW) {
		return sanitizeLine(`${head} · ${meta} · ${goal}`);
	}
	// Not enough room: keep head + goal; clip the goal only if head+goal alone
	// cannot fit, then shrink the prefix (meta clips first) to match.
	const goalFits = visibleWidth(head) + sepW + visibleWidth(goal) <= maxW;
	const goalRender = goalFits ? goal : truncate(goal, Math.max(8, maxW - visibleWidth(head) - sepW));
	const prefixBudget = Math.max(0, maxW - visibleWidth(goalRender) - sepW);
	const prefixRender = truncate(`${head} · ${meta}`, prefixBudget);
	return sanitizeLine(`${prefixRender} · ${goalRender}`);
}

interface ResolvedRun {
	manifest: TeamRunManifest;
	snapshot: RunUiSnapshot | undefined;
	agents: CrewAgentRecord[];
	status: RunStatus;
}

function resolveRuns(runs: TeamRunManifest[], snapshotCache?: RunSnapshotCache, resolve?: SnapshotResolver): Map<string, ResolvedRun> {
	const map = new Map<string, ResolvedRun>();
	for (const run of runs) {
		const snapshot = resolve ? resolve(run) : snapshotFor(run, snapshotCache);
		const agents = snapshot?.agents ?? agentsFor(run, snapshotCache, resolve);
		const displayRun = snapshot?.manifest ?? run;
		const status: RunStatus = isLikelyOrphanedActiveRun(displayRun, agents) ? "stale" : (displayRun.status as RunStatus);
		map.set(run.runId, { manifest: run, snapshot, agents, status });
	}
	return map;
}

function groupedRuns(
	runs: TeamRunManifest[],
	snapshotCache?: RunSnapshotCache,
	resolve?: SnapshotResolver,
): Array<{ label: string; run?: TeamRunManifest }> {
	const resolved = resolveRuns(runs, snapshotCache, resolve);
	const rows: Array<{ label: string; run?: TeamRunManifest }> = [];
	const active = runs.filter((run) =>
		isDisplayActiveRun(resolved.get(run.runId)?.snapshot?.manifest ?? run, resolved.get(run.runId)?.agents ?? []),
	);
	const rest = runs.filter(
		(run) => !isDisplayActiveRun(resolved.get(run.runId)?.snapshot?.manifest ?? run, resolved.get(run.runId)?.agents ?? []),
	);
	if (active.length) rows.push({ label: "Active" }, ...active.map((run) => ({ label: run.runId, run })));
	if (rest.length) rows.push({ label: "Recent" }, ...rest.map((run) => ({ label: run.runId, run })));
	return rows;
}

function selectedRunFromGrouped(
	runs: TeamRunManifest[],
	selected: number,
	snapshotCache?: RunSnapshotCache,
	resolve?: SnapshotResolver,
): TeamRunManifest | undefined {
	return groupedRuns(runs, snapshotCache, resolve).filter((row) => row.run)[selected]?.run;
}

function countByStatus(runs: TeamRunManifest[], snapshotCache?: RunSnapshotCache): string {
	const resolved = resolveRuns(runs, snapshotCache);
	const counts = new Map<RunStatus, number>();
	for (const r of resolved.values()) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
	return [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ") || "none";
}

export class RunDashboard implements DashboardComponent {
	private selected = 0;
	private runScrollOffset = 0;
	private showFullProgress = false;
	private showHelp = false;
	private activePane: "agents" | "progress" | "mailbox" | "output" | "health" | "metrics" | "plan" = lastActivePane;
	/** WP-7 (R7): pane-scoped revision-diff toggle (X). */
	private planDiff = false;
	private runs: TeamRunManifest[];
	private readonly done: (selection: RunDashboardSelection | undefined) => void;
	private readonly theme: CrewTheme;
	private readonly options: RunDashboardOptions;
	private cachedWidth = 0;
	private cachedVersion = "";
	private cachedLines: string[] = [];
	/** 1.10 (UI-P1-2) — short-TTL cache for `buildSignature()` so per-run
	 *  `snapshotFor → refreshIfStale` calls don't fire on every render tick. */
	private cachedSignatureAt = 0;
	private cachedSignature = "";
	private readonly unsubscribeTheme: () => void;
	private readonly schedulerHandle: OverlaySchedulerHandle | undefined;

	constructor(
		runs: TeamRunManifest[],
		done: (selection: RunDashboardSelection | undefined) => void,
		theme: unknown = {},
		options: RunDashboardOptions = {},
	) {
		// Filter runs by workspaceId for session isolation
		// If workspaceId is provided, only show runs owned by that session or runs with no owner (legacy)
		const filteredRuns = options.workspaceId
			? runs.filter((run) => !run.ownerSessionId || run.ownerSessionId === options.workspaceId)
			: runs;
		this.runs = filteredRuns;
		this.done = done;
		this.theme = asCrewTheme(theme);
		this.options = options;
		// 1.10 (UI-P1-1): route run:state / worker:lifecycle / ui:invalidate
		// through a RenderScheduler (debounce + fallback) instead of registering
		// 3 raw runEventBus subscriptions that each schedule an immediate
		// invalidate+requestRender. With 3 overlays subscribing independently,
		// a single event triggered up to 9 callbacks and ~150 invalidates/sec.
		// The scheduler keeps the per-channel subscriptions but collapses them
		// into one debounced render + one coalesced invalidate per runId.
		//
		// FIND-07: scheduler must be constructed BEFORE the theme subscription
		// and the input-handler paths so they can route their invalidate+render
		// calls through `this.scheduleRender()` (debounced + coalesced) instead
		// of bypassing it with direct `invalidateAndRender()` calls. Each direct
		// call would otherwise skip the scheduler's debounce window and force
		// a synchronous repaint, recreating the burst-storm that this scheduler
		// was introduced to eliminate.
		const renderTick = (): void => {
			this.invalidateAndRender();
		};
		this.schedulerHandle = registerOverlayScheduler(renderTick, () => {
			// Drop any cached signature — data underneath may have
			// changed so the next buildSignature() needs to recompute.
			this.cachedSignature = "";
			this.cachedSignatureAt = 0;
		});
		// FIND-07: route theme changes through the scheduler so they coalesce
		// with run:state / worker:lifecycle / ui:invalidate bursts instead of
		// each firing their own immediate invalidate+requestRender.
		this.unsubscribeTheme = subscribeThemeChange(theme, () => this.scheduleRender());
	}

	/**
	 * FIND-07: route an external invalidation through the RenderScheduler.
	 *
	 * Use this for any caller-driven invalidation (theme change, input
	 * handler action) instead of calling `invalidateAndRender()` directly.
	 * The scheduler debounces + coalesces these so a theme change arriving
	 * in the middle of a run:state burst doesn't force a separate synchronous
	 * repaint. Falls back to a direct render if the scheduler was not created
	 * (defensive — currently always created in the constructor).
	 */
	private scheduleRender(): void {
		if (this.schedulerHandle) {
			this.schedulerHandle.schedule();
			return;
		}
		this.invalidateAndRender();
	}

	/**
	 * Invalidate the layout cache AND poke the host TUI to repaint. Without
	 * the explicit `requestRender` call the host only repaints on its own
	 * tick / on keypress, so async events (subagent completed, mailbox
	 * updates, theme change) would leave the overlay showing stale data
	 * until the user pressed a key — which is exactly when the "cascading
	 * dashboard" symptom surfaces because the diff renderer was comparing
	 * against a stale `previousLines` snapshot.
	 */
	private invalidateAndRender(): void {
		this.invalidate();
		try {
			this.options.requestRender?.();
		} catch {
			/* host may not expose requestRender */
		}
	}

	/**
	 * Stable overlay height. The host pi-tui positions overlays based on the
	 * number of lines `render()` returns; if that number fluctuates between
	 * frames (empty state → full pane → fewer agents) the anchor row shifts
	 * up/down and the differential renderer cannot reliably erase the
	 * previous footprint, producing the "ghost dashboard below" bug.
	 *
	 * Locking the output to a single height per render eliminates that.
	 */
	private targetHeight(): number {
		const rows = Number.isFinite(process.stdout?.rows) ? Number(process.stdout?.rows) : 30;
		return Math.max(12, Math.min(36, rows - 2));
	}

	private refreshRuns(resolve?: SnapshotResolver): void {
		if (!this.options.runProvider) return;
		const selectedRunId = this.selectedRunId(resolve);
		const next = this.options.runProvider();
		// P3 (#8): re-apply the workspaceId filter on EVERY refresh, not just
		// the constructor. Without this, runs from other sessions leak back in
		// on frame 2+ once the runProvider returns the unfiltered manifest list.
		const unfiltered = Array.isArray(next) ? next : this.runs;
		this.runs = this.options.workspaceId
			? unfiltered.filter((run) => !run.ownerSessionId || run.ownerSessionId === this.options.workspaceId)
			: unfiltered;
		if (selectedRunId) {
			const nextIndex = groupedRuns(this.runs, this.options.snapshotCache, resolve)
				.filter((row) => row.run)
				.findIndex((row) => row.run?.runId === selectedRunId);
			if (nextIndex >= 0) this.selected = nextIndex;
			else this.selected = 0;
		}
	}

	/**
	 * L-1 — keep the run-list selection inside the rendered window so the `›`
	 * marker can never scroll off-screen (and Enter can never act on an
	 * invisible run). Uses the SAME `runListWindow()` the render loop uses and
	 * iterates to a fixed point, because the slot count depends on whether the
	 * ↑/↓ indicators render (which depends on the offset). This makes the
	 * window correct on the SAME render that processed the keypress — there is
	 * no one-frame lag where the marker is off-screen.
	 */
	private ensureRunListWindow(selectableCount: number): void {
		if (selectableCount <= RUN_LIST_MAX) {
			this.runScrollOffset = 0;
			return;
		}
		for (let i = 0; i < 4; i++) {
			const { slots } = runListWindow(this.runScrollOffset, selectableCount);
			const prev = this.runScrollOffset;
			if (this.selected < this.runScrollOffset) this.runScrollOffset = this.selected;
			else if (this.selected >= this.runScrollOffset + slots) this.runScrollOffset = this.selected - slots + 1;
			this.runScrollOffset = Math.max(0, Math.min(this.runScrollOffset, Math.max(0, selectableCount - 1)));
			if (this.runScrollOffset === prev) break;
		}
	}

	private buildSignature(resolve?: SnapshotResolver): string {
		// 1.10 (UI-P1-2) — short-TTL cache so we don't re-read every run's
		// snapshot on every render tick. `snapshotFor → refreshIfStale` can
		// stat multiple files per run when its own TTL expires, and the
		// dashboard's render is called several times per second (spinner +
		// event-bus). Cache the full computed signature for ~100ms: long
		// enough to coalesce one render burst, short enough that idle pauses
		// still pick up new data promptly.
		const now = Date.now();
		if (this.cachedSignature && now - this.cachedSignatureAt < SIGNATURE_CACHE_TTL_MS) {
			return this.cachedSignature;
		}
		let hasRunning = false;
		const statuses = this.runs
			.map((run) => {
				const snapshot = resolve ? resolve(run) : snapshotFor(run, this.options.snapshotCache);
				const displayRun = snapshot?.manifest ?? run;
				const agents = snapshot?.agents ?? agentsFor(run, this.options.snapshotCache, resolve);
				const stale = isLikelyOrphanedActiveRun(displayRun, agents);
				const status: RunStatus = stale ? "stale" : (displayRun.status as RunStatus);
				if (status === "running" || agents.some((agent) => agent.status === "running")) hasRunning = true;
				return snapshot?.signature ?? `${displayRun.runId}:${displayRun.status}:${displayRun.updatedAt}:${status}`;
			})
			.join("|");
		const metricsSig =
			this.activePane === "metrics" ? `:metrics=${this.options.registry?.snapshot().length ?? 0}:${spinnerBucket()}` : "";
		const sig = `${this.selected}:${this.showHelp ? 1 : 0}:${this.showFullProgress ? 1 : 0}:${this.activePane}:${statuses}${hasRunning ? `:spin=${spinnerBucket()}` : ""}${metricsSig}`;
		this.cachedSignature = sig;
		this.cachedSignatureAt = now;
		return sig;
	}

	invalidate(): void {
		this.cachedVersion = "";
		this.cachedLines = [];
		// 1.10 (UI-P1-2): also drop the short-TTL signature cache so the next
		// render can't return a stale snapshot-derived signature that was
		// computed before the invalidating event arrived.
		this.cachedSignature = "";
		this.cachedSignatureAt = 0;
	}

	dispose(): void {
		this.unsubscribeTheme();
		this.schedulerHandle?.dispose();
	}

	private selectedRunId(resolve?: SnapshotResolver): string | undefined {
		return selectedRunFromGrouped(this.runs, this.selected, this.options.snapshotCache, resolve)?.runId;
	}

	render(width: number): string[] {
		try {
			return this.renderUnsafe(width);
		} catch (error) {
			logInternalError("run-dashboard.render", error);
			return renderLines(["Dashboard error — see logs for details.", "Press r to reload · Esc to close."], width);
		}
	}

	private renderUnsafe(width: number): string[] {
		// PERF (2026-08-24): snapshot resolution stat'd 7-8 files per run 6-8
		// times per frame. Resolve once per frame into a local map and thread
		// it through every render-path consumer below.
		const frameSnapshots = new Map<string, RunUiSnapshot | undefined>();
		const snapshotOnce: SnapshotResolver = (run) => {
			if (!frameSnapshots.has(run.runId)) frameSnapshots.set(run.runId, snapshotFor(run, this.options.snapshotCache));
			return frameSnapshots.get(run.runId);
		};
		this.refreshRuns(snapshotOnce);
		const signature = this.buildSignature(snapshotOnce);
		if (signature !== this.cachedVersion || this.cachedWidth !== width) {
			const innerWidth = Math.max(20, width - 4);
			const borderWidth = Math.min(innerWidth, Math.max(0, width - 2));
			const fg = (color: Parameters<CrewTheme["fg"]>[0], text: string) => this.theme.fg(color, text);
			// PERF (2026-08-24): DynamicCrewBorder caches the rendered fill per
			// instance — a new instance per line defeated it. One per render
			// pass; every border()/sep() call below reuses the cached line.
			const crewBorder = new DynamicCrewBorder(this.theme);
			const borderFill = (count: number) => crewBorder.render(count)[0];
			const border = (left: string, right: string) => `${fg("border", left)}${borderFill(borderWidth)}${fg("border", right)}`;
			const row = (text: string) => `│ ${pad(truncate(text, innerWidth - 1), innerWidth - 1)}│`;
			const sep = () => border("├", "┤");

			const lines: string[] = [];
			if (this.showHelp) {
				// K-1: help overlay replaces the dashboard body until dismissed.
				lines.push(...new HelpOverlay(this.theme).render(width));
			} else {
				lines.push(
					border("╭", "╮"),
					row(
						`${fg("accent", "▐")} ${this.theme.bold("pi-crew")} · ${this.runs.length} runs  ${fg("dim", "1-7 pane · ↑↓ · Enter · ? help · Esc")}`,
					),
					sep(),
				);

				if (this.runs.length === 0) {
					// F-7: actionable empty state instead of a bare "No runs.".
					lines.push(row(fg("dim", "No runs yet.")));
					lines.push(row(fg("dim", "Start one: team action='run' · r reload · Esc close")));
				} else {
					// L-1: windowed run list so the selection can never scroll off-screen.
					const allGrouped = groupedRuns(this.runs, this.options.snapshotCache, snapshotOnce);
					const selectable = allGrouped.filter((rowItem) => rowItem.run);
					const selectableCount = selectable.length;
					if (this.selected > selectableCount - 1) this.selected = Math.max(0, selectableCount - 1);
					this.ensureRunListWindow(selectableCount);
					if (selectableCount <= RUN_LIST_MAX) {
						// Common case (≤8 runs): keep the Active/Recent group headers.
						for (const rowItem of allGrouped) {
							if (!rowItem.run) {
								lines.push(row(fg("dim", `── ${rowItem.label} ──`)));
								continue;
							}
							const idx = selectable.findIndex((c) => c.run?.runId === rowItem.run?.runId);
							const snap = snapshotOnce(rowItem.run);
							const run = snap?.manifest ?? rowItem.run;
							const agents = snap?.agents ?? agentsFor(rowItem.run, this.options.snapshotCache, snapshotOnce);
							const status: RunStatus = isLikelyOrphanedActiveRun(run, agents) ? "stale" : (run.status as RunStatus);
							const label = runLabel(run, idx === this.selected, this.options.snapshotCache, innerWidth - 2, snapshotOnce);
							lines.push(row(applyStatusColor(this.theme, status, label)));
						}
					} else {
						// >8 runs: windowed list (group headers omitted to maximise run rows).
						const win = runListWindow(this.runScrollOffset, selectableCount);
						if (win.hasTop) lines.push(row(fg("dim", `↑ ${this.runScrollOffset} more above`)));
						for (let gi = this.runScrollOffset; gi < Math.min(this.runScrollOffset + win.slots, selectableCount); gi++) {
							const rowItem = selectable[gi];
							if (!rowItem?.run) continue;
							const snap = snapshotOnce(rowItem.run);
							const run = snap?.manifest ?? rowItem.run;
							const agents = snap?.agents ?? agentsFor(rowItem.run, this.options.snapshotCache, snapshotOnce);
							const status: RunStatus = isLikelyOrphanedActiveRun(run, agents) ? "stale" : (run.status as RunStatus);
							const label = runLabel(run, gi === this.selected, this.options.snapshotCache, innerWidth - 2, snapshotOnce);
							lines.push(row(applyStatusColor(this.theme, status, label)));
						}
						if (win.hasBottom)
							lines.push(row(fg("dim", `↓ ${selectableCount - (this.runScrollOffset + win.slots)} more below`)));
					}

					// Selected run detail — compact. PERF (2026-08-24): reuse the
					// `selectable` rows already derived from the single groupedRuns()
					// computation above instead of recomputing grouping a third time
					// (`selectedRunFromGrouped` is exactly `selectable[selected].run`).
					const selectedRun = selectable[Math.min(this.selected, selectable.length - 1)]?.run;
					if (selectedRun) {
						const snap = snapshotOnce(selectedRun);
						const r = snap?.manifest ?? selectedRun;
						const agents = snap?.agents ?? agentsFor(selectedRun, this.options.snapshotCache, snapshotOnce);
						const statusStr: RunStatus = isLikelyOrphanedActiveRun(r, agents) ? "stale" : (r.status as RunStatus);
						const selectedTasks = snap?.tasks ?? readRunTasks(r, this.options.snapshotCache, snapshotOnce);
						lines.push(sep());
						lines.push(row(`${fg("accent", "▸")} ${truncate(sanitizeLine(r.goal), innerWidth - 6)}`));
						// L-2: surface the failure/cancellation reason inline for terminal runs.
						const isTerminal = statusStr === "failed" || statusStr === "cancelled" || statusStr === "stopped";
						const reason = isTerminal ? summarizeTerminalReason(r, selectedTasks, snap?.cancellationReason) : undefined;
						const reasonSuffix = reason ? ` · ${truncate(sanitizeLine(reason), 40)}` : "";
						lines.push(
							row(
								fg(
									"dim",
									sanitizeLine(
										`  ${r.team}/${r.workflow ?? "default"} · ${statusStr} · ${r.runId.slice(-10)}${reasonSuffix}`,
									),
								),
							),
						);

						// Pane content (max 8 lines) — F-2: colorize embedded status glyphs.
						const paneLines = snap
							? this.activePane === "agents"
								? safeRenderPane("agents", () => renderAgentsPane(snap, this.options))
								: this.activePane === "progress"
									? safeRenderPane("progress", () => renderProgressPane(snap))
									: this.activePane === "mailbox"
										? safeRenderPane("mailbox", () => renderMailboxPane(snap))
										: this.activePane === "health"
											? safeRenderPane("health", () =>
													renderHealthPane(snap, {
														isForeground: !r.async,
													}),
												)
											: this.activePane === "metrics"
												? safeRenderPane("metrics", () =>
														renderMetricsPane(snap, {
															registry: this.options.registry,
														}),
													)
												: this.activePane === "plan"
													? safeRenderPane("plan", () => renderPlanPane(snap, { diff: this.planDiff }))
													: safeRenderPane("transcript", () => renderTranscriptPane(snap))
							: [
									...readAgentPreview(r, 4, this.options, snapshotOnce),
									...readProgressPreview(r, 2, this.options.snapshotCache, snapshotOnce),
								];
						const filteredPane = paneLines.filter((l) => l && !l.includes("(none)") && l.trim() !== "");
						if (filteredPane.length > 0) {
							lines.push(row(fg("dim", `── ${this.activePane} ──`)));
							for (const line of filteredPane.slice(0, 8)) {
								lines.push(colorizeStatusGlyphs(row(truncate(sanitizeLine(line), innerWidth - 2)), this.theme));
							}
						}

						// F-4: warn when a live run's snapshot is likely stale (flaky read).
						const isActiveRun = statusStr === "running" || statusStr === "queued" || statusStr === "waiting";
						const staleData = isActiveRun && (snap ? Date.now() - snap.fetchedAt > STALE_SNAPSHOT_MS : true);
						if (staleData) lines.push(row(fg("warning", "⚠ data may be stale (manifest read flaky)")));

						// One-line footer — V-1: width-padded so the right edge doesn't jitter.
						const usage = aggregateUsage(selectedTasks);
						const u = usage ?? {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0,
						};
						const tok = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
						const tokStr = tok > 0 ? (tok >= 1000 ? `${(tok / 1000).toFixed(1)}k tok` : `${tok} tok`) : "";
						let ctxPct: number | undefined;
						for (const agent of agents) {
							if (agent.status === "running" && agent.runtime === "live-session") {
								const pct = getLiveAgentContextPercent(agent.taskId);
								if (pct != null) {
									ctxPct = pct;
									break;
								}
							}
						}
						const ctxStr = ctxPct != null ? `${Math.round(ctxPct)}% ctx` : "";
						const footerFields: string[] = [];
						if (tokStr) footerFields.push(padVis(tokStr, 10));
						if (ctxStr) footerFields.push(padVis(ctxStr, 9));
						if (footerFields.length) lines.push(row(fg("dim", footerFields.join(" · "))));
					}
				}
				lines.push(border("╰", "╯"));
			}

			const target = this.targetHeight();
			if (lines.length < target) {
				const innerWidth = Math.max(20, width - 4);
				const fg = (color: Parameters<CrewTheme["fg"]>[0], text: string) => this.theme.fg(color, text);
				const blankRow = `│ ${pad("", innerWidth - 1)}│`;
				const bottom = lines.pop();
				while (lines.length < target - 1) lines.push(fg("border", blankRow));
				if (bottom) lines.push(bottom);
			} else if (lines.length > target) {
				const bottom = lines[lines.length - 1];
				lines.length = target - 1;
				lines.push(bottom);
			}

			this.cachedLines = renderLines(
				lines.map((line) => truncate(line, width)),
				width,
			);
			this.cachedVersion = signature;
			this.cachedWidth = width;
		}
		return this.cachedLines;
	}

	// Pi 0.81+ requires the Focusable contract: a string-indexable `focused`
	// marker that TUI toggles to track which component currently receives
	// input. Without it, isFocusable() returns false and downstream
	// dispatch may skip the component. Declared as an own property so
	// `"focused" in component` is true.
	public focused = false;

	handleInput(data: string): void {
		const action = dashboardActionForKey(data, this.activePane);
		// K-1: "?" toggles the help overlay; while it is shown, any other key
		// (including Esc) just dismisses it first instead of acting.
		if (action === "help") {
			this.showHelp = !this.showHelp;
			this.scheduleRender();
			return;
		}
		if (this.showHelp) {
			this.showHelp = false;
			this.scheduleRender();
			return;
		}
		const selectedRunId = this.selectedRunId();
		if (action === "close") {
			this.done(undefined);
			return;
		}
		if (action === "select") {
			this.done(selectedRunId ? { runId: selectedRunId, action: "status" } : undefined);
			return;
		}
		// WP-3 (H4-subset): plan approval keys. Deliberately a DEDICATED branch
		// (not the generic union block below) because plan actions must gate on
		// the selected run actually being parked on a pending approval — a
		// stray keystroke on a non-pending run is a silent no-op (dashboard
		// stays open) instead of closing it via done(undefined).
		if (action === "plan-approve" || action === "plan-deny") {
			const run = selectedRunFromGrouped(this.runs, this.selected, this.options.snapshotCache);
			const manifest = run ? (snapshotFor(run, this.options.snapshotCache)?.manifest ?? run) : undefined;
			if (run && manifest && isPlanApprovalPending(manifest)) {
				this.done({ runId: run.runId, action });
			}
			return;
		}
		if (
			action === "summary" ||
			action === "artifacts" ||
			action === "api" ||
			action === "agents" ||
			action === "mailbox" ||
			action === "reload" ||
			action === "mailbox-detail" ||
			action === "health-recovery" ||
			action === "health-kill-stale" ||
			action === "health-diagnostic-export" ||
			action === "notifications-dismiss"
		) {
			this.done(selectedRunId ? { runId: selectedRunId, action } : action === "reload" ? { runId: "", action } : undefined);
			return;
		}
		if (action === "events") {
			this.done(selectedRunId ? { runId: selectedRunId, action: "agent-events" } : undefined);
			return;
		}
		if (action === "output") {
			this.done(selectedRunId ? { runId: selectedRunId, action: "agent-output" } : undefined);
			return;
		}
		if (action === "transcript") {
			this.done(selectedRunId ? { runId: selectedRunId, action: "agent-transcript" } : undefined);
			return;
		}
		if (action === "live-conversation") {
			this.done(selectedRunId ? { runId: selectedRunId, action: "agent-live" } : undefined);
			return;
		}
		if (action === "progressToggle") {
			this.showFullProgress = !this.showFullProgress;
			this.invalidate();
			return;
		}
		if (action === "pane-agents") this.activePane = "agents";
		else if (action === "pane-progress") this.activePane = "progress";
		else if (action === "pane-mailbox") this.activePane = "mailbox";
		else if (action === "pane-output") this.activePane = "output";
		else if (action === "pane-health") this.activePane = "health";
		else if (action === "pane-metrics") this.activePane = "metrics";
		else if (action === "pane-plan") this.activePane = "plan";
		else if (action === "plan-diff") {
			this.planDiff = !this.planDiff;
			this.invalidate();
			return;
		} else if (action === "up") this.selected = Math.max(0, this.selected - 1);
		else if (action === "down") {
			const selectableCount = groupedRuns(this.runs, this.options.snapshotCache).filter((row) => row.run).length;
			this.selected = Math.min(Math.max(0, selectableCount - 1), this.selected + 1);
		}
		if (action) {
			lastActivePane = this.activePane;
			this.scheduleRender();
		}
	}
}
