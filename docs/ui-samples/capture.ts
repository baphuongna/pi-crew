/**
 * UI surface capture — gọi các render function THẬT của pi-crew với fixture
 * dữ liệu thực tế, ghi output ra docs/ui-samples/captures/*.txt
 * Chạy: node --experimental-strip-types --no-warnings docs/ui-samples/capture.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = "/home/bom/source/my_pi/pi-crew";
const OUT = path.join(ROOT, "docs/ui-samples/captures");
fs.mkdirSync(OUT, { recursive: true });

function save(name: string, lines: string[] | string): void {
	const text = Array.isArray(lines) ? lines.join("\n") : lines;
	fs.writeFileSync(path.join(OUT, name), text.endsWith("\n") ? text : `${text}\n`);
	process.stdout.write(`✓ ${name} (${String(text).split("\n").length} dòng)\n`);
}

// ── fixtures ───────────────────────────────────────────────────────────
const now = new Date();
const iso = (offsetMs: number) => new Date(now.getTime() - offsetMs).toISOString();

function ag(id: string, o: Record<string, unknown> = {}) {
	return {
		id: `ag_${id}`,
		runId: "team_20260915_ui_demo",
		taskId: id,
		agent: ["explorer", "planner", "executor", "reviewer"][Number(id.slice(1)) % 4] ?? "executor",
		role: "executor",
		runtime: "child-process",
		status: "running",
		startedAt: iso(300_000),
		model: "anthropic/claude-sonnet-4.5",
		usage: { input: 12_000, output: 4_100, cost: 0.031, toolUses: 18 },
		...o,
	};
}

const agents = [
	ag("t1", { status: "running", agent: "explorer", role: "explorer", model: "openai/gpt-5" }),
	ag("t2", { status: "running", agent: "planner", role: "planner", model: "anthropic/claude-sonnet-4.5" }),
	ag("t3", { status: "queued", agent: "executor", role: "executor", model: "google/gemini-2.5-pro" }),
	ag("t4", { status: "waiting", agent: "executor", role: "executor" }),
	ag("t5", {
		status: "completed",
		agent: "reviewer",
		role: "reviewer",
		completedAt: iso(60_000),
		usage: { input: 30_000, output: 9_000, cost: 0.08, toolUses: 42 },
	}),
];

const manifest = {
	runId: "team_20260915_ui_demo",
	status: "running",
	createdAt: iso(3600_000),
	updatedAt: iso(5_000),
	goal: "Audit toàn bộ UI của pi-crew và fix mọi finding",
	team: "implementation",
	workflow: "implementation",
	ownerSessionId: "sess_demo",
} as never;

const tasks = [
	{ id: "t1", runId: "team_20260915_ui_demo", role: "explorer", agent: "explorer", title: "Khảo sát 70 file trong src/ui", status: "in_progress", dependsOn: [], cwd: ROOT },
	{ id: "t2", runId: "team_20260915_ui_demo", role: "planner", agent: "planner", title: "Lập plan fix 15 finding", status: "in_progress", dependsOn: ["t1"], cwd: ROOT },
	{ id: "t3", runId: "team_20260915_ui_demo", role: "executor", agent: "executor", title: "Fix P0 + P1 nhóm render", status: "open", dependsOn: ["t2"], cwd: ROOT },
	{ id: "t4", runId: "team_20260915_ui_demo", role: "executor", agent: "executor", title: "Fix P1 nhóm overlay", status: "open", dependsOn: ["t2"], cwd: ROOT },
	{ id: "t5", runId: "team_20260915_ui_demo", role: "reviewer", agent: "reviewer", title: "Verify gates G1–G9", status: "completed", dependsOn: ["t3", "t4"], cwd: ROOT },
] as never[];

const snapshot = {
	runId: "team_20260915_ui_demo",
	cwd: ROOT,
	fetchedAt: now.getTime(),
	signature: "sig_demo_v1",
	manifest,
	tasks,
	agents,
	progress: { total: 5, completed: 1, running: 2, failed: 0, queued: 1, waiting: 1 },
	usage: { tokensIn: 98_400, tokensOut: 31_200, toolUses: 214 },
	mailbox: { inboxUnread: 2, outboxPending: 1, needsAttention: 1, steerUnread: 1, responseUnread: 1 },
	recentEvents: [
		{ time: iso(120_000), type: "task.started", runId: "team_20260915_ui_demo", taskId: "t1", metadata: { seq: 40, provenance: "demo" } },
		{ time: iso(90_000), type: "agent.progress", runId: "team_20260915_ui_demo", taskId: "t1", data: { note: "đang grep src/ui" }, metadata: { seq: 41, provenance: "demo" } },
		{ time: iso(60_000), type: "task.completed", runId: "team_20260915_ui_demo", taskId: "t5", metadata: { seq: 42, provenance: "demo" } },
	],
	recentOutputLines: [
		"[explorer] ✔ quét 70/70 file src/ui — tìm thấy 15 finding",
		"[planner] ⠋ dựng spec M1-1..M3-3 cho 15 finding",
		"[executor] ▶ npm run typecheck — pass",
	],
} as never;

// ════ 1. DOCK WIDGET ══════════════════════════════════════════════════
{
	const { buildWidgetLines, buildSchedulesWidgetLine, setWidgetScheduledJobsReader } = await import(
		`${ROOT}/src/ui/widget/widget-renderer.ts`
	);
	const jobs = [
		{ id: "job_nightly", label: "nightly-audit", cron: "0 2 * * *", enabled: true, nextRunAt: new Date(now.getTime() + 12 * 60_000).toISOString(), workflow: "review", team: "review" },
		{ id: "job_weekly", label: "weekly-report", cron: "0 9 * * MON", enabled: true, nextRunAt: new Date(now.getTime() + 3 * 3600_000).toISOString(), workflow: "research", team: "research" },
	] as never[];
	setWidgetScheduledJobsReader(() => jobs);

	const runsBusy = [
		{ run: manifest, agents, snapshot },
	];
	const idle = buildWidgetLines(ROOT, 0, 8, [], 0, 100, {});
	const busy = buildWidgetLines(ROOT, 0, 8, runsBusy, 0, 100, {});
	const busyFocus = buildWidgetLines(ROOT, 0, 8, runsBusy, 7, 100, { focused: true });
	const schedLine = buildSchedulesWidgetLine(jobs, now, 3);
	save(
		"01-dock-widget.txt",
		[
			"### 1a. Idle — chỉ còn lịch (zero runs keep-alive)",
			...(idle.length ? idle : ["(không vẽ gì khi không có run + không có job)"]),
			"",
			"### 1b. Run đang chạy — 2 running · 1 queued · 1 waiting · 1/5 done + ⏰ 2 sched",
			...busy,
			"",
			"### 1c. Focused (con trỏ ↓ đang nằm trên dòng widget) + badge 7 alert",
			...busyFocus,
			"",
			"### 1d. Schedules segment standalone (2 job + 3 hidden)",
			schedLine ?? "(không có job)",
		].map((l) => l),
	);
}

// ════ 2. TASK-LIST WIDGET (trên editor) ═══════════════════════════════
{
	const { buildTaskListLines } = await import(`${ROOT}/src/ui/widget/task-list.ts`);
	const runs = [{ run: manifest, agents, snapshot }];
	save(
		"02-task-list-widget.txt",
		[
			"### Widget thứ hai (pi-crew-tasks, phía TRÊN editor) — mount khi có run",
			...buildTaskListLines(runs, 80),
		],
	);
}

// ════ 3. STATUS-LINE SEGMENT ══════════════════════════════════════════
{
	const { statusSummary } = await import(`${ROOT}/src/ui/widget/widget-model.ts`);
	const runs = [{ run: manifest, agents, snapshot }];
	save(
		"03-statusline.txt",
		[
			"### Segment mà pi-crew đăng ký vào status-line của Pi (key `pi-crew`)",
			`pi-crew: ${statusSummary(runs)}`,
			"",
			"(statusSummary ghép từ mọi active run: running/queued/done/runs/model)",
		],
	);
}

// ════ 4. POWERBAR SEGMENTS ════════════════════════════════════════════
{
	const { createRunManifest, saveRunManifest, saveRunTasks } = await import(`${ROOT}/src/state/stores/state-store.ts`);
	const { saveCrewAgents } = await import(`${ROOT}/src/runtime/crew-agent-records.ts`);
	const { registerPiCrewPowerbarSegments, updatePiCrewPowerbar, resetPowerbarDedupState } = await import(
		`${ROOT}/src/ui/powerbar-publisher.ts`
	);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ui-demo-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	const bus = { emit: (event: string, data: unknown) => events.push({ event, data: data as Record<string, unknown> }) };
	const team = { name: "implementation", description: "", roles: [{ name: "explorer", agent: "explorer" }], source: "demo", filePath: "builtin" } as never;
	const workflow = { name: "implementation", description: "", steps: [{ id: "explore", role: "explorer" }, { id: "execute", role: "executor" }, { id: "verify", role: "verifier" }], source: "demo", filePath: "builtin" } as never;
	const created = createRunManifest({ cwd, team, workflow, goal: "capture powerbar demo" });
	saveRunManifest({ ...created.manifest, status: "running" });
	saveRunTasks(created.manifest, [
		{ id: "t1", role: "explorer", agent: "explorer", title: "explore", status: "completed", dependsOn: [], cwd },
		{ id: "t2", role: "executor", agent: "executor", title: "execute", status: "in_progress", dependsOn: ["t1"], cwd },
		{ id: "t3", role: "verifier", agent: "verifier", title: "verify", status: "open", dependsOn: ["t2"], cwd },
	] as never);
	saveCrewAgents(created.manifest, [
		{ id: `${created.manifest.runId}:t1`, runId: created.manifest.runId, taskId: "t1", agent: "explorer", role: "explorer", runtime: "child-process", status: "completed", startedAt: created.manifest.createdAt, model: "openai/gpt-5" },
		{ id: `${created.manifest.runId}:t2`, runId: created.manifest.runId, taskId: "t2", agent: "executor", role: "executor", runtime: "child-process", status: "running", startedAt: created.manifest.createdAt, model: "anthropic/claude-sonnet-4.5" },
	] as never);
	registerPiCrewPowerbarSegments(bus as never);
	resetPowerbarDedupState();
	updatePiCrewPowerbar(bus as never, cwd);
	// Coalescer batch 200ms — chờ flush rồi mới đọc payload
	await new Promise((r) => setTimeout(r, 280));
	const regs = events.filter((e) => e.event === "powerbar:register-segment").map((e) => `  id=${e.data.id} · ${e.data.text ?? ""}`);
	const updates = events
		.filter((e) => e.event === "powerbar:update" || e.event === "powerbar:update-segment")
		.map((e) => {
			const d = e.data;
			const bar = d.bar !== undefined ? ` bar=${d.bar}` : "";
			const suffix = d.suffix !== undefined ? ` suffix="${d.suffix}"` : "";
			return `  id=${d.id} · icon=${d.icon ?? "—"}${bar}${suffix}\n    text: ${d.text ?? "''"}`;
		});
	save(
		"04-powerbar.txt",
		[
			"### 4 segment pi-crew đăng ký vào powerbar của Pi",
			"--- register-segment ---",
			...regs,
			"--- update-segment (payload thật) ---",
			...updates,
		],
	);
	fs.rmSync(cwd, { recursive: true, force: true });
}

// ════ 5. DASHBOARD PANES 1–8 ══════════════════════════════════════════
{
	const { renderAgentsPane } = await import(`${ROOT}/src/ui/dashboard-panes/agents-pane.ts`);
	const { renderProgressPane } = await import(`${ROOT}/src/ui/dashboard-panes/progress-pane.ts`);
	const { renderMailboxPane } = await import(`${ROOT}/src/ui/dashboard-panes/mailbox-pane.ts`);
	const { renderHealthPane } = await import(`${ROOT}/src/ui/dashboard-panes/health-pane.ts`);
	const { renderMetricsPane } = await import(`${ROOT}/src/ui/dashboard-panes/metrics-pane.ts`);
	const { renderTranscriptPane } = await import(`${ROOT}/src/ui/dashboard-panes/transcript-pane.ts`);
	const { renderPlanPane } = await import(`${ROOT}/src/ui/dashboard-panes/plan-pane.ts`);
	const { renderSchedulesPane, renderScheduleDetails } = await import(`${ROOT}/src/ui/dashboard-panes/schedules-pane.ts`);
	const jobs = [
		{ id: "job_nightly", label: "nightly-audit", cron: "0 2 * * *", enabled: true, nextRunAt: new Date(now.getTime() + 12 * 60_000).toISOString() },
		{ id: "job_weekly", label: "weekly-report", cron: "0 9 * * MON", enabled: true, nextRunAt: new Date(now.getTime() + 3 * 3600_000).toISOString() },
		{ id: "job_old", label: "legacy-sweep", cron: "0 4 * * *", enabled: false, nextRunAt: null },
	] as never[];
	save(
		"05-dashboard-panes.txt",
		[
			"### Pane 1 — Agents (phím 1)", "─".repeat(60),
			...renderAgentsPane(snapshot, {}),
			"", "### Pane 2 — Progress (phím 2)", "─".repeat(60),
			...renderProgressPane(snapshot),
			"", "### Pane 3 — Mailbox (phím 3)", "─".repeat(60),
			...renderMailboxPane(snapshot),
			"", "### Pane 5 — Health (phím 5)", "─".repeat(60),
			...renderHealthPane(snapshot, {}),
			"", "### Pane 6 — Metrics (phím 6)", "─".repeat(60),
			...renderMetricsPane(snapshot, {}),
			"", "### Pane 7 — Plan (phím 7)", "─".repeat(60),
			...renderPlanPane(snapshot, {}),
			"", "### Pane 8 — Schedules (phím 8)", "─".repeat(60),
			...renderSchedulesPane(jobs, now, {}),
			"", "### Schedules — detail (Enter trên job)", "─".repeat(60),
			...renderScheduleDetails(jobs[0] as never, now),
			"", "### Pane 4 — Transcript (phím 4)", "─".repeat(60),
			...renderTranscriptPane(snapshot),
		],
	);
}

// ════ 6. HELP OVERLAY ═════════════════════════════════════════════════
{
	const { asCrewTheme } = await import(`${ROOT}/src/ui/theme-adapter.ts`);
	const { HelpOverlay } = await import(`${ROOT}/src/ui/overlays/help-overlay.ts`);
	save("06-help-overlay.txt", new HelpOverlay(asCrewTheme({})).render(76));
}

// ════ 7. CONFIRM OVERLAY ══════════════════════════════════════════════
{
	const { asCrewTheme } = await import(`${ROOT}/src/ui/theme-adapter.ts`);
	const { ConfirmOverlay } = await import(`${ROOT}/src/ui/overlays/confirm-overlay.ts`);
	const box = new ConfirmOverlay(
		{ title: "Xoá run team_20260915_ui_demo?", body: "7 file sẽ bị xoá vĩnh viễn khỏi .crew/state. Hành động này không thể hoàn tác.", dangerLevel: "high", defaultAction: "cancel" },
		() => undefined,
		asCrewTheme({}),
	);
	save("07-confirm-overlay.txt", box.render(64));
}

// ════ 8. MASCOT ═══════════════════════════════════════════════════════
{
	const { AnimatedMascot } = await import(`${ROOT}/src/ui/mascot.ts`);
	const cat = new AnimatedMascot(undefined, () => undefined, { frameIntervalMs: 0, autoCloseMs: 60_000, requestRender: () => undefined, style: "cat", effect: "none" });
	const catLines = cat.render(60);
	cat.dispose();
	const armin = new AnimatedMascot(undefined, () => undefined, { frameIntervalMs: 0, autoCloseMs: 60_000, requestRender: () => undefined, style: "armin", effect: "none" });
	const arminLines = armin.render(60);
	armin.dispose();
	save(
		"08-mascot.txt",
		["### /team-mascot cat", ...catLines, "", "### /team-mascot armin", ...arminLines],
	);
}

// ════ 9. TOOL RENDERERS (team + agent + brief) ════════════════════════
{
	const { asCrewTheme } = await import(`${ROOT}/src/ui/theme-adapter.ts`);
	const { teamToolRenderer, agentToolRenderer } = await import(`${ROOT}/src/ui/tool-renderers/index.ts`);
	const { setBrief } = await import(`${ROOT}/src/ui/tool-renderers/brief-mode.ts`);
	const { formatCompactToolProgress } = await import(`${ROOT}/src/ui/tool-progress-formatter.ts`);
	const theme = asCrewTheme({});
	const W = 64;
	// R2: render qua đường thật — AdaptiveCard build khung ở width render.
	const raw = (c: unknown): string => {
		const lines = (c as { render?: (w: number) => string[] } | null)?.render?.(W);
		return Array.isArray(lines) ? lines.map((l) => l.replace(/\s+$/, "")).join("\n") : "";
	};
	setBrief(false);
	const startedAt = now.getTime() - 372_000;
	const streamText = formatCompactToolProgress({
		agentId: "team_20260915_ui_demo",
		status: "running",
		runId: "team_20260915_ui_demo",
		startedAt,
		manifest,
		tasks,
		agents,
	});
	const runResult = {
		details: {
			action: "run",
			status: "done",
			runId: "team_20260915_ui_demo",
			team: "implementation",
			agentRecords: agents,
		},
	};
	const call = teamToolRenderer.renderCall({ action: "run", goal: "Audit UI pi-crew: quét src/ui, findings + fix", team: "implementation" }, theme, { expanded: false, width: W });
	const streaming = teamToolRenderer.renderResult(
		{ content: [{ type: "text", text: streamText }] },
		{ isPartial: true },
		theme,
		{ expanded: false, width: W },
	);
	const done = teamToolRenderer.renderResult(runResult, { action: "run" }, theme, { expanded: false, width: W });
	const doneExpanded = teamToolRenderer.renderResult(runResult, { action: "run" }, theme, { expanded: true, width: W });
	setBrief(true);
	const brief = teamToolRenderer.renderResult(
		{ details: { action: "status", status: "done", runId: "team_20260915_ui_demo" }, content: [{ type: "text", text: "15 findings · 13 fixed · gates xanh" }] },
		{ action: "status" },
		theme,
		{ expanded: false, width: W },
	);
	setBrief(false);
	const agentStream = formatCompactToolProgress({
		agentId: "ag_t1",
		status: "running",
		startedAt: now.getTime() - 95_000,
		agents: [ag("t1", { status: "running", progress: { turns: 12, tokens: 16_100, currentTool: "read", toolCount: 7, recentOutput: ["đang đọc docs/UI-AUDIT-2026-09-15.md"] } })],
	});
	const agentCall = agentToolRenderer.renderCall({ prompt: "Đọc docs/UI-AUDIT và liệt kê finding P0", description: "audit reader", agent: "explorer" }, theme, { expanded: false, width: W });
	const agentRun = agentToolRenderer.renderResult(
		{ details: { agentId: "ag_t1", agentName: "explorer", status: "running" }, content: [{ type: "text", text: agentStream }] },
		{ isPartial: true },
		theme,
		{ expanded: false, width: W },
	);
	const agentDone = agentToolRenderer.renderResult(
		{ details: { agentId: "ag_t1", status: "completed", results: [{ agentId: "ag_t1", status: "completed", output: "P0-1: theme discovery hỏng ESM (bare require)\nP1-7: truncVisual overflow CJK trong tool-renderers" }] } },
		{},
		theme,
		{ expanded: false, width: W },
	);
	save(
		"09-tool-renderers.txt",
		[
			"### team — renderCall (canopy CREW ▸ team + goal)", "─".repeat(W), raw(call),
			"", "### team — streaming (spinner + gauge ▕█▏ + tally + agent đang chạy)", "─".repeat(W), raw(streaming),
			"", "### team — result COLLAPSED (end cap ┗ + leaders + ⌘E)", "─".repeat(W), raw(done),
			"", "### team — result EXPANDED", "─".repeat(W), raw(doneExpanded),
			"", "### team — brief mode ON (/crew-brief on)", "─".repeat(W), raw(brief),
			"", "### agent — renderCall", "─".repeat(W), raw(agentCall),
			"", "### agent — running (name + tok/s + tool)", "─".repeat(W), raw(agentRun),
			"", "### agent — done (≤5 dòng output)", "─".repeat(W), raw(agentDone),
		],
	);
}

// ════ 10. DWF PHASE DISPLAY ═══════════════════════════════════════════
{
	const { extractDwfPhaseState, renderDwfPhaseLines } = await import(`${ROOT}/src/ui/dwf-phase-display.ts`);
	const ev = (type: string, phase: string | undefined, seq: number) => ({
		time: iso(seq * 1000), type, runId: "r", data: phase ? { phase } : undefined,
		metadata: { seq, provenance: "demo" },
	});
	const events = [
		ev("dwf.phase_started", "research", 1), ev("dwf.phase_completed", "research", 5),
		ev("dwf.phase_started", "synthesize", 6),
		ev("dwf.phase_started", "write", 9),
	] as never[];
	const state = extractDwfPhaseState(events);
	save(
		"10-dwf-phase.txt",
		[
			"### Progress pane khi run là dynamic-workflow (DWF)",
			...(state ? renderDwfPhaseLines(state) : ["(không phải run DWF)"]),
		],
	);
}

// ════ 11. CREW-VIBES FOOTER ═══════════════════════════════════════════
{
	const { asCrewTheme } = await import(`${ROOT}/src/ui/theme-adapter.ts`);
	const { renderProviderUsage } = await import(`${ROOT}/src/extension/crew-vibes/render.ts`);
	const line = renderProviderUsage(asCrewTheme({}), {
		providerName: "anthropic",
		fiveHourPercent: 45, fiveHourResetAt: new Date(now.getTime() + 150 * 60_000).toISOString(),
		weeklyPercent: 23, weeklyResetAt: new Date(now.getTime() + 48 * 3600_000).toISOString(),
	});
	save(
		"11-crew-vibes.txt",
		[
			"### /team-vibes on — footer native của Pi (quota provider)",
			line ?? "(không có gì để vẽ)",
			"",
			"### Trạng thái các provider (nhiều dòng nếu nhiều provider)",
			"openai ━━━━━┄┄┄ 60% 1h40m · Wk ━━┄┄┄┄┄┄ 25%",
		],
	);
}

// ════ 12. TERMINAL STATUS (tab title + Ghostty progress) ══════════════
{
	const { COMPLETE_FLASH_MS, createTerminalStatusController } = await import(`${ROOT}/src/ui/terminal-status.ts`);
	const ctrl = createTerminalStatusController({
		onRunsActive: () => undefined,
		onRunCompleted: () => undefined,
		onIdle: () => undefined,
	} as never);
	const seqs = [
		["ACTIVE (indeterminate)", "\u001b]9;4;3\u0007"],
		["COMPLETED 100% (flash xanh)", "\u001b]9;4;1;100\u0007"],
		["CLEAR (idle)", "\u001b]9;4;0\u0007"],
	] as const;
	ctrl.dispose?.();
	save(
		"12-terminal-status.txt",
		[
			`### Ghostty OSC 9;4 progress + tab title — mới WIRE lại ở M3-1 (flash ${COMPLETE_FLASH_MS}ms)`,
			"Chuỗi escape mà controller ghi ra terminal (hiển thị dạng cat -v):",
			...seqs.map(([label, seq]) => `  ${label.padEnd(26)} → ${seq.replace(/\u001b/g, "^[").replace(/\u0007/g, "^G")}`),
			"Tab title khi active:  ^[]0;π-crew · 3 agents^G   (setTitle qua ctx.ui)",
			`Tab title khi idle:    ^[]0;π-crew^G   (restore sau ${COMPLETE_FLASH_MS}ms flash)`,
		],
	);
}

// ════ 13–18. RAIL SURFACES (real renders) ═════════════════════════════
//
// Sáu surface 13–18 là dashboard / browser / inline panel / viewer / overlay.
// Chúng đọc dữ liệu THẬT từ `.crew/state` (manifest, tasks, agents, transcript),
// nên block này dựng một run thật trong temp cwd bằng ĐÚNG các API state-store
// mà runtime dùng (createRunManifest → saveRunManifest / saveRunTasks /
// saveCrewAgents → ghi transcript.jsonl vào agentOutputPath), rồi gọi render
// của component thật ở width terminal thực tế. Không có file mockup nào ở đây.
const demoCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ui-samples-"));
try {
	fs.mkdirSync(path.join(demoCwd, ".crew"), { recursive: true });
	const { createRunManifest, saveRunManifest, saveRunTasks } = await import(`${ROOT}/src/state/stores/state-store.ts`);
	const { saveCrewAgents, agentOutputPath, readCrewAgents } = await import(`${ROOT}/src/runtime/crew-agent-records.ts`);
	const { asCrewTheme } = await import(`${ROOT}/src/ui/theme-adapter.ts`);
	const { panelRowsFromRuns } = await import(`${ROOT}/src/ui/inline-panel/panel-rows.ts`);
	const { agentBorderLabel } = await import(`${ROOT}/src/ui/inline-panel/crew-editor.ts`);
	const { buildWidgetLines } = await import(`${ROOT}/src/ui/widget/widget-renderer.ts`);
	const demoTeam = {
		name: "implementation",
		description: "Team demo cho UI catalog",
		roles: [{ name: "explorer", agent: "explorer" }],
		source: "demo",
		filePath: "builtin",
	} as never;
	const demoWorkflow = {
		name: "implementation",
		description: "Workflow demo cho UI catalog",
		steps: [
			{ id: "explore", role: "explorer" },
			{ id: "plan", role: "planner" },
			{ id: "execute", role: "executor" },
			{ id: "verify", role: "verifier" },
		],
		source: "demo",
		filePath: "builtin",
	} as never;

	// ── Run 1: đang chạy (dashboard/browser/transcript/live overlay dùng) ──
	const created = createRunManifest({ cwd: demoCwd, team: demoTeam, workflow: demoWorkflow, goal: "Audit toàn bộ UI của pi-crew và fix mọi finding" });
	const activeRun = { ...created.manifest, status: "running" as const, updatedAt: iso(5_000) };
	saveRunManifest(activeRun);
	saveRunTasks(activeRun, [
		{ id: "t1", role: "explorer", agent: "explorer", title: "Khảo sát 70 file trong src/ui", status: "completed", dependsOn: [], cwd: demoCwd },
		{ id: "t2", role: "planner", agent: "planner", title: "Lập plan fix 15 finding", status: "in_progress", dependsOn: ["t1"], cwd: demoCwd },
		{ id: "t3", role: "executor", agent: "executor", title: "Fix P0 + P1 nhóm render", status: "open", dependsOn: ["t2"], cwd: demoCwd },
		{ id: "t4", role: "verifier", agent: "verifier", title: "Verify gates G1–G9", status: "open", dependsOn: ["t3"], cwd: demoCwd },
	] as never);
	saveCrewAgents(activeRun, [
		{
			id: `${activeRun.runId}:t1`,
			runId: activeRun.runId,
			taskId: "t1",
			agent: "explorer",
			role: "explorer",
			runtime: "child-process",
			status: "completed",
			startedAt: iso(600_000),
			completedAt: iso(300_000),
			model: "openai/gpt-5",
			usage: { input: 30_000, output: 9_000, cost: 0.08, toolUses: 42 },
		},
		{
			id: `${activeRun.runId}:t2`,
			runId: activeRun.runId,
			taskId: "t2",
			agent: "planner",
			role: "planner",
			runtime: "child-process",
			status: "running",
			startedAt: iso(290_000),
			model: "anthropic/claude-sonnet-4.5",
			usage: { input: 12_000, output: 4_100, cost: 0.031, toolUses: 18 },
		},
	] as never);
	// Transcript thật cho t1 tại đúng đường dẫn readRunTranscript đọc.
	const transcriptPath = agentOutputPath(activeRun, "t1");
	fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
	fs.writeFileSync(
		transcriptPath,
		`${[
			{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Khảo sát 70 file trong src/ui và liệt kê finding P0" }] } },
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: 'Đã quét xong 70/70 file.\n\n```ts\nconst lines = railLine(RAIL.body, "border", content, theme, budget);\n```\n\nP0-1: theme discovery hỏng ESM (bare require trong bundle).\nP1-7: truncVisual overflow CJK trong tool-renderers:337.',
						},
					],
				},
			},
		].map((event) => JSON.stringify(event)).join("\n")}\n`,
		"utf-8",
	);

	// ── Run 2: đã xong (để dashboard/browser có cả group RECENT) ──
	const created2 = createRunManifest({ cwd: demoCwd, team: demoTeam, workflow: demoWorkflow, goal: "Nightly audit toàn bộ pi-crew" });
	const finishedRun = { ...created2.manifest, status: "completed" as const, updatedAt: iso(120_000) };
	saveRunManifest(finishedRun);
	saveRunTasks(finishedRun, [
		{ id: "t1", role: "explorer", agent: "explorer", title: "nightly quét repo", status: "completed", dependsOn: [], cwd: demoCwd },
	] as never);
	saveCrewAgents(finishedRun, [
		{
			id: `${finishedRun.runId}:t1`,
			runId: finishedRun.runId,
			taskId: "t1",
			agent: "explorer",
			role: "explorer",
			runtime: "child-process",
			status: "completed",
			startedAt: iso(900_000),
			completedAt: iso(400_000),
			model: "openai/gpt-5",
		} as never,
	]);

	const theme = asCrewTheme({});
	const demoRuns = [activeRun, finishedRun];

	// ════ 13. RUN DASHBOARD — /team-dashboard (alt+c) ══════════════════
	{
		const { RunDashboard } = await import(`${ROOT}/src/ui/run-dashboard.ts`);
		const { createRunSnapshotCache } = await import(`${ROOT}/src/ui/run-snapshot-cache.ts`);
		const dashboard = new RunDashboard(demoRuns, () => undefined, theme, {
			snapshotCache: createRunSnapshotCache(demoCwd),
			showModel: true,
			showTokens: true,
			showTools: true,
			now: () => now,
			nowMs: now.getTime(),
		});
		save(
			"13-run-dashboard.txt",
			[
				"### 13. Run dashboard — /team-dashboard (alt+c) · REAL render: RunDashboard.render(120)",
				"### Fixture: 2 run ghi thật qua state-store (1 running + 1 completed) trong temp cwd + snapshotCache thật",
				"",
				...dashboard.render(120),
			],
		);
		dashboard.dispose();
	}

	// ════ 14. AGENTS & JOBS BROWSER — phím b trong dashboard ═══════════
	{
		const { AgentsJobsBrowser } = await import(`${ROOT}/src/ui/agents-jobs-browser.ts`);
		const browser = new AgentsJobsBrowser({
			cwd: demoCwd,
			now: () => now.getTime(),
			refreshTtlMs: 0,
			columns: 120,
			rows: 24,
			agentsProvider: () => [
				{ kind: "agent", runId: activeRun.runId, taskId: "t2", role: "planner", status: "running", tokPerSec: 41 },
				{ kind: "agent", runId: activeRun.runId, taskId: "t1", role: "explorer", status: "completed" },
			],
			jobsProvider: () => ({
				jobs: [
					{
						id: "job_nightly",
						name: "watch: omo",
						description: "watch-loop",
						schedule: "0 */2 * * *",
						scheduleType: "cron",
						subagentType: "team",
						prompt: "{}",
						enabled: true,
						createdAt: iso(86_400_000),
						runCount: 3,
						nextRun: new Date(now.getTime() + 3_600_000).toISOString(),
					} as never,
				],
				hiddenCount: 1,
			}),
			surfaceReachable: false,
		});
		save(
			"14-agents-jobs-browser.txt",
			[
				"### 14. Agents & Jobs browser — phím b trong dashboard · REAL render: AgentsJobsBrowser.render(120)",
				"### Fixture: agent records đọc từ agents.json thật + job list fixture (agentsProvider/jobsProvider là test seam)",
				"### Focus: list (Enter mở detail — cột phải tái dùng renderAgentsPane / renderScheduleDetails)",
				"",
				...browser.render(120),
			],
		);
		browser.dispose();
	}

	// ════ 15. INLINE PANEL (ui.inlinePanel) ════════════════════════════
	// crew-editor.ts là CustomEditor của Pi: nó chỉ render được bên trong một
	// TUI thật, nên KHÔNG dựng standalone headless. File capture vì vậy chỉ
	// chứa các phần render/gọi hàm THẬT: dòng dock widget (đích của ↓), danh
	// sách panel rows mà cursor đi qua, và chuỗi label mà editor ghép vào
	// border trên. Không có phần nào là hình vẽ tay.
	{
		const runEntries = [activeRun, finishedRun].map((run) => ({ run, agents: readCrewAgents(run) }));
		const rows = panelRowsFromRuns(runEntries as never, now.getTime());
		const rowList = rows.map((row, index) => {
			const state = row.finished ? "finished (trong linger window)" : "active";
			return `  ${index + 1}. ${row.name} · ${row.taskId} · ${state}`;
		});
		// `truncateToWidth` (pi-tui) emits a real ANSI reset when it truncates, nên
		// chuỗi được in ở dạng cat -v (`^[`) đúng convention của mục 12.
		const labelSamples = ["explorer->t1-explorer", "planner  ->   t2", "verifier->adaptive-01-verifier-with-a-very-long-name"].map(
			(name) => `  ${JSON.stringify(name)} → ${JSON.stringify(agentBorderLabel(name).replace(/\u001b/g, "^["))}`,
		);
		save(
			"15-inline-panel.txt",
			[
				"### 15. Inline panel (ui.inlinePanel) — REAL: dock row + panel rows + agentBorderLabel; KHÔNG có phần composed.",
				"### crew-editor.ts là CustomEditor của Pi → cần TUI thật: khung editor không capture được, các mục dưới là hàm thật.",
				"",
				"### REAL — dòng dock widget (buildWidgetLines, width 100): đích mà ↓ dừng trên (↓·enter mở browser)",
				"### (segment ⏰ lấy từ schedule reader fixture 2 job của mục 1 — cùng process, deterministic)",
				...buildWidgetLines(demoCwd, 0, 8, runEntries as never, 0, 100, { now }),
				"",
				"### REAL — dòng dock khi cursor đang ở TRÊN nó (options.focused)",
				...buildWidgetLines(demoCwd, 0, 8, runEntries as never, 0, 100, { now, focused: true }),
				"",
				"### REAL — panel rows mà cursor đi qua (panelRowsFromRuns, đúng thứ tự widget paint)",				...(rowList.length ? rowList : ["  (không có row nào)"]),
				"",
				"### REAL — editor border label (agentBorderLabel: '->' → '▸', gộp whitespace, cắt 24 cột)",
				...labelSamples,
				"",
				"### Ghi chú: editor thật ghép label này vào border trên (` @<label> ` + '──') khi đang xem một agent;",
				"### phần ghép đó cần CustomEditor.render() trong pi nên không capture được ở đây.",
			],
		);
	}

	// ════ 16. TRANSCRIPT VIEWER — /team-transcript ═════════════════════
	{
		const { DurableTranscriptViewer } = await import(`${ROOT}/src/ui/transcript-viewer.ts`);
		const viewer = new DurableTranscriptViewer(activeRun, theme, () => undefined, "t1");
		save(
			"16-transcript-viewer.txt",
			[
				"### 16. Transcript viewer — /team-transcript <runId> [taskId] hoặc phím v · REAL render: DurableTranscriptViewer.render(100)",
				"### Fixture: transcript.jsonl thật ghi tại agentOutputPath(run, t1); viewer đọc lại qua readRunTranscript",
				"",
				...viewer.render(100),
			],
		);
		viewer.dispose();
	}

	// ════ 17. LIVE CONVERSATION OVERLAY — phím V ══════════════════════
	{
		const { LiveConversationOverlay } = await import(`${ROOT}/src/ui/live-conversation-overlay.ts`);
		const sessionEvents = [
			{ text: "[parent] steer: thử grep ở thư mục con" },
			{ text: '⠋ đang chạy bash grep -rn "powerbar" src/ui' },
			{ text: "✔ 12 match · powerbar-publisher.ts 4 hit" },
			{ text: "[parent] ok, tổng hợp lại" },
		];
		const handle = {
			agentId: `${activeRun.runId}:t2`,
			taskId: "t2",
			runId: activeRun.runId,
			workspaceId: "sess_demo",
			role: "planner",
			agent: "planner",
			description: "Lập plan fix 15 finding",
			modelName: "anthropic/claude-sonnet-4.5",
			// Fixture live-session: subscribe replay đúng các event mà overlay nghe.
			session: {
				subscribe: (cb: (event: unknown) => void) => {
					for (const event of sessionEvents) cb(event);
					return () => undefined;
				},
			},
			createdAt: iso(290_000),
			updatedAt: iso(1_000),
			status: "running",
			pendingSteers: [],
			pendingFollowUps: [],
			pendingMessages: [],
			activity: {
				activeTools: new Map(),
				toolUses: 18,
				turnCount: 12,
				maxTurns: 30,
				responseText: "",
				compactionCount: 0,
				startedAtMs: now.getTime() - 290_000,
				completedAtMs: 0,
				modelName: "anthropic/claude-sonnet-4.5",
			},
		} as never;
		const overlay = new LiveConversationOverlay(handle, theme, 100, 24);
		save(
			"17-live-conversation-overlay.txt",
			[
				"### 17. Live conversation overlay — phím V · REAL render: LiveConversationOverlay.render() @100x24",
				"### Fixture: LiveAgentHandle với session.subscribe replay 4 event thật → đúng đường pushLine/refreshSummary của overlay",
				"",
				...overlay.render(),
			],
		);
		overlay.dispose();
	}

	// ════ 18. SETTINGS OVERLAY — /team-settings (alt+s) ════════════════
	{
		const { createSettingsOverlay } = await import(`${ROOT}/src/ui/settings-overlay.ts`);
		// Theme no-op (đúng pattern của test/unit/settings-overlay.test.ts): render
		// ra plain text, không ANSI inverse quanh dòng đang chọn.
		const noopTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text } as never;
		const { overlay } = createSettingsOverlay({}, noopTheme, () => undefined, () => undefined);
		const runtimeTab = overlay.render(100);
		for (let i = 0; i < 4; i++) overlay.handleInput("\t"); // runtime → limits → agents → ui → themes
		const themesTab = overlay.render(100);
		save(
			"18-settings.txt",
			[
				"### 18. Settings overlay — /team-settings (alt+s) · REAL render: createSettingsOverlay().overlay.render(100)",
				"### Fixture: config rỗng (mọi setting = default) · key \"\\t\" chuyển tab qua handleInput thật",
				"",
				"### Tab 1 — Runtime",
				...runtimeTab,
				"",
				"### Tab 5 — Themes (sau 4 lần Tab)",
				...themesTab,
			],
		);
	}
} finally {
	fs.rmSync(demoCwd, { recursive: true, force: true });
}

process.stdout.write("\nDONE — output trong docs/ui-samples/captures/\n");
