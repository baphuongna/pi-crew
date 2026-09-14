/**
 * agents-jobs-browser.ts — unified "Agents & Jobs" browser overlay.
 *
 * Opened from the run dashboard via ONE keypress (`b` → action `browser` →
 * `RunDashboardAction "browser-open"` → `openAgentsJobsBrowser` in
 * extension/registration/viewers.ts). Follows the live-conversation overlay
 * precedent: a dedicated bottom-anchored overlay, NOT a new dashboard pane —
 * the pane route would churn the ActivePane union + keybinding parity goldens.
 *
 * Layout (width-aware for terminals 80..250):
 *
 *   Agents & Jobs — 2 agents · 1 job
 *   Live agents (2)            │ ▸ adaptive-01-executor
 *   › ⠋ Explorer · 41 tok/s    │   0/1 tasks · 1 agents
 *     ✓ Writer                 │   ⠋ adaptive-01-executor executor
 *   Scheduled jobs (1)         │     reading…
 *   › ⏰ watch: omo · cron · next 23h …   │
 *   [↑↓] navigate · [Enter] …  │
 *
 * LEFT column — unified list: live agents first (status glyph via
 * iconForStatus/spinnerFrame, role name, tok/s while running — the SAME
 * widget-formatters formula), then scheduled jobs (⏰ name · schedule · next
 * run relative · enabled ●/○).
 *
 * RIGHT column — detail pane. For agents it REUSES the existing agents-pane
 * detail rendering VERBATIM: `renderAgentsPane` is called with a synthetic
 * one-agent snapshot so its formatting is never forked. For jobs it reuses
 * `renderScheduleDetails` (schedules pane key V) plus enabled + hidden-tier
 * count lines.
 *
 * DATA SOURCES (G17 — hard rule): agents via listLiveAgents()/readCrewAgents;
 * jobs via getScheduledJobs + getScheduledJobsHiddenCountView from
 * extension/team-tool/handle-schedule.ts. This module NEVER imports the
 * scheduler for data (ScheduledJob is a TYPE-only import) and NEVER touches
 * settings keys directly.
 *
 * [p] SURFACE: detection reuses resolve-surface.ts's exported env-signal
 * machinery (`surfaceGateEnvSnapshot`); the pane itself is opened with the
 * EXISTING provider primitives via `surfaceProviderForCleanup` (the same
 * singleton accessor doctor uses — no gate matrix, no new subsystem): a new
 * mux pane running `tail -F` on the selected agent's events log. Known gap
 * (reported, not invented around): providers expose no agent→paneId registry,
 * so [p] cannot FOCUS an existing agent pane — it opens a fresh viewer pane.
 *
 * Headless safety: importing this module is inert — nothing happens until a
 * UI host constructs the class, and the keybinding that opens it lives in the
 * dashboard overlay, so headless sessions never reach it.
 */

import { getScheduledJobs, getScheduledJobsHiddenCountView } from "../extension/team-tool/handle-schedule.ts";
import { agentEventsPath, readCrewAgents } from "../runtime/crew-agent-records.ts";
import type { CrewAgentRecord } from "../runtime/crew-agent-runtime.ts";
import { type LiveAgentHandle, listLiveAgents, listLiveAgentsByWorkspace } from "../runtime/live-session/live-agent-manager.ts";
import type { ScheduledJob } from "../runtime/scheduling/scheduler.ts";
import { surfaceGateEnvSnapshot, surfaceProviderForCleanup } from "../runtime/surface/resolve-surface.ts";
import { getTaskUsage } from "../runtime/usage-tracker.ts";
import { loadRunManifestById } from "../state/stores/state-store.ts";
import type { TeamRunManifest } from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { formatRelativeTime } from "../utils/relative-time.ts";
import { pad, sanitizeLine, truncate, visibleWidth } from "../utils/visual.ts";
import { renderAgentsPane } from "./dashboard-panes/agents-pane.ts";
import { renderScheduleDetails, schedulesHiddenJobsHintLine } from "./dashboard-panes/schedules-pane.ts";
import { computeLiveDurationMs } from "./live-duration.ts";
import type { RunUiSnapshot } from "./snapshot-types.ts";
import { spinnerFrame } from "./spinner.ts";
import { iconForStatus } from "./status-colors.ts";
import type { CrewTheme } from "./theme-adapter.ts";

// ─── Public data types ─────────────────────────────────────────────────────

/** A live agent row in the unified list. */
export interface AgentsBrowserAgentEntry {
	kind: "agent";
	runId: string;
	taskId: string;
	/** Display role (Explorer/Writer/…) — handle.role, else durable record role. */
	role: string;
	agentName?: string;
	status: CrewAgentRecord["status"];
	/** tok/s while running (widget-formatters formula); undefined otherwise. */
	tokPerSec?: number;
	/** Durable record for detail rendering; undefined when manifest is gone. */
	record?: CrewAgentRecord;
	/** Live handle when the agent is still tracked in-process. */
	handle?: LiveAgentHandle;
}

/** A scheduled-job row in the unified list. */
export interface AgentsBrowserJobEntry {
	kind: "job";
	job: ScheduledJob;
}

export type AgentsJobsBrowserEntry = AgentsBrowserAgentEntry | AgentsBrowserJobEntry;

/** Column focus of the keyboard state machine. */
export type AgentsJobsBrowserFocus = "list" | "detail";

// ─── Options ───────────────────────────────────────────────────────────────

export interface AgentsJobsBrowserOptions {
	/** cwd for job reads (G17 provider) and run manifests. */
	cwd: string;
	/** Session/workspace filter for live agents (mirrors the dashboard). */
	workspaceId?: string;
	theme?: CrewTheme;
	/** Injected clock (D6-T4) — render paths never read the wall clock directly. */
	now?: () => number;
	/** Terminal size hint; `render(width)` still governs per-line truncation. */
	columns?: number;
	rows?: number;
	/** Test seam: replace the live-agent data source. */
	agentsProvider?: () => AgentsBrowserAgentEntry[];
	/** Test seam: replace the job data source (G17 provider by default). */
	jobsProvider?: () => { jobs: ScheduledJob[]; hiddenCount: number };
	/** Test seam: override surface reachability (default: env probe). */
	surfaceReachable?: boolean;
	/** Test seam: replace the [p] surface action. */
	surfaceAgent?: (entry: AgentsBrowserAgentEntry, tailPath: string | undefined) => Promise<boolean>;
	/** Host repaint hook — called by the refresh timer so spinners animate. */
	requestRender?: () => void;
	/** Data cache TTL ms (default 600). 0 = always read fresh. */
	refreshTtlMs?: number;
}

// ─── Layout constants ──────────────────────────────────────────────────────

const REFRESH_TTL_MS_DEFAULT = 600;
const POLL_INTERVAL_MS = 400;
/** Body height clamp — mirrors the dashboard's stable-height lesson: a
 *  fluctuating line count shifts the overlay anchor every frame. */
const MIN_BODY = 8;
const MAX_BODY = 24;
const MIN_LIST_WIDTH = 26;
const MAX_LIST_WIDTH = 64;

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * tok/s for a RUNNING live agent — the exact widget-formatters "viewed"
 * formula (dockUsageText): (input+output+cacheWrite) / elapsed seconds,
 * only when the agent has >1s of history. Reuses getTaskUsage +
 * computeLiveDurationMs rather than forking the math.
 */
export function agentTokPerSec(handle: LiveAgentHandle, nowMs: number): number | undefined {
	if (handle.status !== "running") return undefined;
	const usage = getTaskUsage(handle.taskId);
	const totalTokens = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheWrite ?? 0);
	if (totalTokens <= 0) return undefined;
	const ms = computeLiveDurationMs(handle.activity, nowMs);
	if (ms <= 1000) return undefined;
	const tps = Math.round(totalTokens / (ms / 1000));
	return tps > 0 ? tps : undefined;
}

/** Status rank for "live agents first, running before the rest" ordering. */
function statusRank(status: CrewAgentRecord["status"]): number {
	if (status === "running") return 0;
	if (status === "waiting" || status === "queued" || status === "needs_attention") return 1;
	return 2;
}

/**
 * Which mux can host a viewer pane RIGHT NOW. Reuses resolve-surface.ts's
 * exported env-signal snapshot: $TMUX implies the tmux binary (we are inside
 * tmux), HERDR_ENV=1 implies the herdr host env. NOTE (gap, reported): the
 * socket liveness ping used by resolveSurfaceDetailed is module-private, so
 * herdr detection here is env-signal-only — a dead socket surfaces as a
 * createSurface failure which is caught and logged, never thrown.
 */
export function detectViewSurfaceKind(env: NodeJS.ProcessEnv): "tmux" | "herdr" | null {
	const snapshot = surfaceGateEnvSnapshot(env);
	if (snapshot.tmux) return "tmux";
	if (snapshot.herdrEnv) return "herdr";
	return null;
}

/** POSIX single-quote — the tail path contains no shell metachars after this. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

// ─── The browser ───────────────────────────────────────────────────────────

export class AgentsJobsBrowser {
	private readonly options: AgentsJobsBrowserOptions;
	private cachedEntries: AgentsJobsBrowserEntry[] = [];
	private cachedAt = -Infinity;
	private hiddenCount = 0;
	private selected = 0;
	private listScroll = 0;
	private focus: AgentsJobsBrowserFocus = "list";
	private detailScroll = 0;
	private closed = false;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private readonly manifests = new Map<string, TeamRunManifest | null>();

	constructor(options: AgentsJobsBrowserOptions) {
		this.options = options;
		this.refreshData(true);
		this.pollTimer = setInterval(() => {
			if (this.closed) return;
			this.refreshData(false);
			try {
				this.options.requestRender?.();
			} catch {
				/* host may be gone */
			}
		}, POLL_INTERVAL_MS);
		this.pollTimer.unref();
	}

	// ── Test-facing read access ──────────────────────────────────────────

	get entriesView(): readonly AgentsJobsBrowserEntry[] {
		return this.cachedEntries;
	}

	get selectedIndex(): number {
		return this.selected;
	}

	get focusMode(): AgentsJobsBrowserFocus {
		return this.focus;
	}

	get hiddenJobsCount(): number {
		return this.hiddenCount;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	// ── Lifecycle ────────────────────────────────────────────────────────

	close(): void {
		this.closed = true;
	}

	dispose(): void {
		this.closed = true;
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	private nowMs(): number {
		return this.options.now ? this.options.now() : Date.now();
	}

	// ── Data loading (G17 sources only) ──────────────────────────────────

	/** Reload the merged list when the TTL expired (or `force`). */
	refreshData(force = false): void {
		const ttl = this.options.refreshTtlMs ?? REFRESH_TTL_MS_DEFAULT;
		const at = this.nowMs();
		if (!force && ttl > 0 && at - this.cachedAt < ttl) return;
		this.cachedAt = at;
		const agents = this.loadAgents();
		const { jobs, hiddenCount } = this.loadJobs();
		this.hiddenCount = hiddenCount;
		this.cachedEntries = [...agents, ...jobs.map((job) => ({ kind: "job" as const, job }))];
		if (this.selected >= this.cachedEntries.length) this.selected = Math.max(0, this.cachedEntries.length - 1);
	}

	private loadAgents(): AgentsBrowserAgentEntry[] {
		if (this.options.agentsProvider) {
			return [...this.options.agentsProvider()].sort((a, b) => statusRank(a.status) - statusRank(b.status));
		}
		const handles = this.options.workspaceId ? listLiveAgentsByWorkspace(this.options.workspaceId) : listLiveAgents();
		const nowMs = this.nowMs();
		return handles
			.map((handle): AgentsBrowserAgentEntry => {
				const record = this.recordFor(handle.runId, handle.taskId);
				return {
					kind: "agent",
					runId: handle.runId,
					taskId: handle.taskId,
					role: handle.role ?? record?.role ?? handle.agent ?? "agent",
					agentName: handle.agent,
					status: handle.status,
					tokPerSec: agentTokPerSec(handle, nowMs),
					record,
					handle,
				};
			})
			.sort((a, b) => statusRank(a.status) - statusRank(b.status));
	}

	private loadJobs(): { jobs: ScheduledJob[]; hiddenCount: number } {
		if (this.options.jobsProvider) return this.options.jobsProvider();
		try {
			return { jobs: getScheduledJobs(this.options.cwd), hiddenCount: getScheduledJobsHiddenCountView(this.options.cwd) };
		} catch {
			return { jobs: [], hiddenCount: 0 };
		}
	}

	private manifestFor(runId: string): TeamRunManifest | null {
		if (this.manifests.has(runId)) return this.manifests.get(runId) ?? null;
		let manifest: TeamRunManifest | null = null;
		try {
			const loaded = loadRunManifestById(this.options.cwd, runId); // NOTE: no run lock — best-effort read, mirrors viewers.ts
			manifest = loaded ? loaded.manifest : null;
		} catch {
			manifest = null;
		}
		this.manifests.set(runId, manifest);
		return manifest;
	}

	private recordFor(runId: string, taskId: string): CrewAgentRecord | undefined {
		const manifest = this.manifestFor(runId);
		if (!manifest) return undefined;
		try {
			return readCrewAgents(manifest).find((record) => record.taskId === taskId);
		} catch {
			return undefined;
		}
	}

	// ── Detail rendering (VERBATIM pane reuse) ───────────────────────────

	/**
	 * RIGHT-column detail for the selected entry.
	 *
	 * Agents: `renderAgentsPane` with a synthetic ONE-agent snapshot — the
	 * existing pane formatting is reused verbatim, never forked. Jobs:
	 * `renderScheduleDetails` (schedules-pane V view) + enabled + hidden-tier
	 * count lines.
	 */
	detailLinesFor(entry: AgentsJobsBrowserEntry): string[] {
		if (entry.kind === "job") {
			const lines = renderScheduleDetails(entry.job, new Date(this.nowMs()));
			lines.push(`  enabled: ${entry.job.enabled ? "● on" : "○ off"}`);
			if (this.hiddenCount > 0) lines.push(`  hidden project-tier jobs: ${this.hiddenCount}`);
			return lines;
		}
		const record = entry.record ?? this.recordFor(entry.runId, entry.taskId);
		const manifest = this.manifestFor(entry.runId);
		if (!record || !manifest) {
			return [
				`▸ ${entry.taskId} (${entry.role})`,
				`  status: ${entry.status}`,
				"  (agent record unavailable — run manifest not found)",
			];
		}
		const snapshot: RunUiSnapshot = {
			runId: record.runId,
			cwd: this.options.cwd,
			fetchedAt: this.nowMs(),
			signature: `browser:${record.taskId}`,
			manifest,
			tasks: [],
			agents: [record],
			progress: {
				total: 1,
				completed: record.status === "completed" ? 1 : 0,
				running: record.status === "running" ? 1 : 0,
				failed: record.status === "failed" ? 1 : 0,
				queued: record.status === "queued" ? 1 : 0,
				waiting: record.status === "waiting" ? 1 : 0,
			},
			usage: {
				tokensIn: record.usage?.input ?? 0,
				tokensOut: record.usage?.output ?? 0,
				toolUses: record.toolUses ?? 0,
			},
			mailbox: { inboxUnread: 0, outboxPending: 0, needsAttention: 0 },
			recentEvents: [],
			recentOutputLines: [],
		};
		return renderAgentsPane(snapshot, { workspaceId: this.options.workspaceId, nowMs: this.nowMs() });
	}

	// ── [p] surface action ───────────────────────────────────────────────

	/** Best-effort tail target for the selected agent: events log first. */
	tailPathFor(entry: AgentsBrowserAgentEntry): string | undefined {
		const record = entry.record ?? this.recordFor(entry.runId, entry.taskId);
		if (record?.eventsPath) return record.eventsPath;
		const manifest = this.manifestFor(entry.runId);
		if (manifest) return agentEventsPath(manifest, entry.taskId);
		return record?.outputPath ?? record?.transcriptPath ?? undefined;
	}

	private surfaceReachable(): boolean {
		if (this.options.surfaceReachable !== undefined) return this.options.surfaceReachable;
		return detectViewSurfaceKind(process.env) !== null;
	}

	/**
	 * [p] — open a mux viewer pane tailing the selected agent's events log.
	 * Reuses the EXISTING provider primitives (surfaceProviderForCleanup →
	 * createSurface); fire-and-forget from the sync handleInput.
	 */
	private surfaceSelectedAgent(entry: AgentsBrowserAgentEntry): void {
		const action = this.options.surfaceAgent ?? this.defaultSurfaceAgent.bind(this);
		void action(entry, this.tailPathFor(entry)).catch(() => {
			/* provider failure — logged inside defaultSurfaceAgent */
		});
	}

	private async defaultSurfaceAgent(entry: AgentsBrowserAgentEntry, tailPath: string | undefined): Promise<boolean> {
		try {
			const kind = detectViewSurfaceKind(process.env);
			if (!kind || !tailPath) return false;
			const provider = surfaceProviderForCleanup(kind);
			if (!provider) return false;
			// Legacy (no tabKey) path: the viewer pane splits from the HOST's
			// pane, lives independently of any run, and stays open until the
			// user closes it — no onExit watcher is registered, so nothing leaks.
			await provider.createSurface(`crew-view-${entry.taskId.slice(0, 12)}`, {
				cwd: this.options.cwd,
				command: `tail -n 40 -F ${shellQuote(tailPath)}`,
				title: `crew: ${entry.role}/${entry.taskId.slice(-8)}`,
			});
			return true;
		} catch (error) {
			logInternalError("agents-jobs-browser", error instanceof Error ? error : new Error(String(error)));
			return false;
		}
	}

	// ── Keyboard state machine ───────────────────────────────────────────

	/**
	 * Overlay input handling (overlays are mutually exclusive — the dashboard's
	 * dispatch never sees these keys while this overlay owns input).
	 *
	 * list focus:  ↑/↓/k/j move · Enter/\r/\n open detail · p surface (agent +
	 *              reachable only) · q/Esc/\x1b close.
	 * detail focus: ↑/↓/k/j scroll · Esc/\x1b/q/Enter back to list.
	 */
	handleInput(data: string): void {
		if (this.closed) return;
		const up = data === "k" || data === "\x1b[A" || data === "up";
		const down = data === "j" || data === "\x1b[B" || data === "down";
		if (this.focus === "list") {
			if (up || down) {
				const count = this.cachedEntries.length;
				if (count > 0) {
					this.selected = up ? Math.max(0, this.selected - 1) : Math.min(count - 1, this.selected + 1);
				}
				return;
			}
			if (data === "\r" || data === "\n" || data === "enter") {
				if (this.cachedEntries.length > 0) {
					this.focus = "detail";
					this.detailScroll = 0;
				}
				return;
			}
			if (data === "p") {
				const entry = this.cachedEntries[this.selected];
				if (this.surfaceReachable() && entry && entry.kind === "agent") {
					this.surfaceSelectedAgent(entry);
				}
				return;
			}
			if (data === "q" || data === "escape" || data === "\x1b") {
				this.close();
				return;
			}
			return;
		}
		// detail focus
		if (up || down) {
			this.detailScroll = up ? Math.max(0, this.detailScroll - 1) : this.detailScroll + 1;
			return;
		}
		if (data === "q" || data === "escape" || data === "\x1b" || data === "\r" || data === "\n" || data === "enter") {
			this.focus = "list";
			return;
		}
	}

	// ── Render ───────────────────────────────────────────────────────────

	/** Render the overlay. Width-aware for 80..250 columns; lines never
	 *  exceed `width` (truncate/visibleWidth from utils/visual — the same
	 *  width model pi-tui enforces). */
	render(width?: number): string[] {
		const w = Math.max(40, width ?? this.options.columns ?? 80);
		const nowMs = this.nowMs();
		const listWidth = Math.max(MIN_LIST_WIDTH, Math.min(MAX_LIST_WIDTH, Math.round(w * 0.38)));
		const detailWidth = Math.max(20, w - listWidth - 3);
		// Narrow-terminal guard (target range is 80..250, but never overflow):
		// below the natural split, shrink BOTH columns so row width === w.
		const rowWidth = Math.min(w, listWidth + detailWidth + 3);
		const safeList = rowWidth >= listWidth + 3 + 20 ? listWidth : Math.max(10, rowWidth - 23);
		const safeDetail = Math.max(10, rowWidth - safeList - 3);
		const bodyHeight = Math.max(MIN_BODY, Math.min(MAX_BODY, (this.options.rows ?? 24) - 6));
		const separator = this.options.theme ? this.options.theme.fg("border", "│") : "│";

		const header = truncate(`Agents & Jobs — ${this.countAgents()} agents · ${this.countJobs()} jobs`, w);
		const lines = [header];
		const hiddenHint = schedulesHiddenJobsHintLine(this.hiddenCount);
		if (hiddenHint) lines.push(truncate(hiddenHint, w));

		const left = this.renderListColumn(safeList, bodyHeight, nowMs);
		const right = this.renderDetailColumn(safeDetail, bodyHeight);
		for (let i = 0; i < bodyHeight; i++) {
			lines.push(`${pad(left[i] ?? "", safeList)} ${separator} ${pad(right[i] ?? "", safeDetail)}`);
		}
		lines.push(truncate(this.hintRow(), w));
		return lines;
	}

	private countAgents(): number {
		return this.cachedEntries.filter((entry) => entry.kind === "agent").length;
	}

	private countJobs(): number {
		return this.cachedEntries.filter((entry) => entry.kind === "job").length;
	}

	private hintRow(): string {
		const base =
			this.focus === "list"
				? `[↑↓] navigate · [Enter] open detail${this.surfaceReachable() ? " · [p] surface" : ""} · [Esc] close`
				: "[↑↓] scroll detail · [Esc] back";
		return base;
	}

	/** LEFT column: section labels + unified rows, windowed around selection. */
	private renderListColumn(listWidth: number, bodyHeight: number, nowMs: number): string[] {
		const out: string[] = [];
		const push = (text: string) => out.push(truncate(sanitizeLine(text), listWidth));
		if (this.cachedEntries.length === 0) {
			push("No live agents · no scheduled jobs");
			return out;
		}
		const agents = this.cachedEntries.filter((entry): entry is AgentsBrowserAgentEntry => entry.kind === "agent");
		const jobs = this.cachedEntries.filter((entry): entry is AgentsBrowserJobEntry => entry.kind === "job");
		// Rows: section labels + one row per entry, in merged order.
		const rows: { entry?: AgentsJobsBrowserEntry; text: string }[] = [];
		if (agents.length > 0) rows.push({ text: `Live agents (${agents.length})` });
		for (const entry of agents) rows.push({ entry, text: this.agentRow(entry, nowMs) });
		if (jobs.length > 0) rows.push({ text: `Scheduled jobs (${jobs.length})` });
		for (const entry of jobs) rows.push({ entry, text: this.jobRow(entry) });

		// Windowing: keep the selected entry's row inside the visible slot
		// count (fixed-point like the dashboard's run-list window).
		const entryRowIndex = rows.findIndex((row) => row.entry !== undefined && this.indexOf(row.entry) === this.selected);
		const slots = Math.max(1, bodyHeight);
		if (entryRowIndex >= 0) {
			this.listScroll = Math.max(0, Math.min(this.listScroll, entryRowIndex));
			if (entryRowIndex >= this.listScroll + slots) this.listScroll = entryRowIndex - slots + 1;
		}
		for (const row of rows.slice(this.listScroll, this.listScroll + slots)) {
			const isSelected = row.entry !== undefined && this.indexOf(row.entry) === this.selected;
			const marker = row.entry === undefined ? "" : isSelected ? "› " : "  ";
			push(`${marker}${row.text}`);
		}
		return out;
	}

	private indexOf(entry: AgentsJobsBrowserEntry): number {
		return this.cachedEntries.indexOf(entry);
	}

	private agentRow(entry: AgentsBrowserAgentEntry, nowMs: number): string {
		const icon = iconForStatus(entry.status, { runningGlyph: spinnerFrame(entry.taskId, nowMs) });
		const tok = entry.tokPerSec !== undefined && entry.status === "running" ? ` · ${entry.tokPerSec} tok/s` : "";
		return `${icon} ${entry.role}${tok} · ${entry.taskId.slice(-8)}`;
	}

	private jobRow(entry: AgentsBrowserJobEntry): string {
		const job = entry.job;
		const name = sanitizeLine(job.name);
		const schedule = sanitizeLine(job.schedule);
		const next = job.nextRun ? formatRelativeTime(new Date(this.nowMs()), new Date(job.nextRun)) : "—";
		return `⏰ ${name} · ${schedule} · next ${next} · ${job.enabled ? "●" : "○"}`;
	}

	/** RIGHT column: selected entry's detail (or a placeholder), scrolled. */
	private renderDetailColumn(detailWidth: number, bodyHeight: number): string[] {
		const entry = this.cachedEntries[this.selected];
		if (!entry) return [truncate("(nothing selected)", detailWidth)];
		let detail: string[];
		try {
			detail = this.detailLinesFor(entry);
		} catch (error) {
			logInternalError("agents-jobs-browser", error instanceof Error ? error : new Error(String(error)));
			detail = ["(detail render failed)"];
		}
		const maxScroll = Math.max(0, detail.length - (bodyHeight - 1));
		this.detailScroll = Math.max(0, Math.min(this.detailScroll, maxScroll));
		const windowed = detail.slice(this.detailScroll, this.detailScroll + bodyHeight - 1);
		const title = entry.kind === "agent" ? `▸ ${entry.role} · ${entry.taskId.slice(-8)}` : `▸ ${sanitizeLine(entry.job.name)}`;
		const out = [truncate(sanitizeLine(title), detailWidth)];
		for (const line of windowed) out.push(truncate(sanitizeLine(line), detailWidth));
		if (this.detailScroll > 0 || this.detailScroll + windowed.length < detail.length) {
			out.push(
				truncate(
					`… ${this.detailScroll} above · ${Math.max(0, detail.length - this.detailScroll - windowed.length)} below`,
					detailWidth,
				),
			);
		}
		return out;
	}
}

// Re-export for consumers/tests that want the width helpers this module's
// truncation discipline is built on (visibleWidth parity with pi-tui).
export { visibleWidth };
