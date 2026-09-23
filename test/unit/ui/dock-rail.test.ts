/**
 * RAIL design-system migration — DOCK / live surfaces (E4, docs/UI-DESIGN-SYSTEM.md §2.B).
 *
 * These locks are written against REAL rendered output (never a helper in
 * isolation): the widget component + `buildWidgetLines`, the plan card
 * (`buildTaskListLines`), the status bar (`statusSummary`), the live-run
 * sidebar and the crew-editor border label. They pin the parts of the grammar
 * that a well-meaning refactor could silently break:
 *
 *   - the dock is EXACTLY one row and always rides the `┃` rail — `┏`/`┗`
 *     would imply a multi-line card and are forbidden there;
 *   - the identity canopy is `CREW ▸ <subject>` / `PLAN ▸ <title>` /
 *     `LIVE ▸ <runId8>`;
 *   - the tail hint is `···· ↓·enter` (never the retired `— ↓·enter`);
 *   - zero runs + zero schedules render NOTHING (`[]`) — the live bug of
 *     2026-09-16 painted the literal string `undefined — ↓·enter`;
 *   - no `undefined` can reach a string, even from a sparse on-disk record;
 *   - the rounded `╭─╮│╰─╯` box and the `role->agent` separator are retired;
 *   - no line ever exceeds the render width (checked with `visibleWidth`).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import type { ScheduledJob } from "../../../src/runtime/scheduling/scheduler.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../src/state/types.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";
import { agentBorderLabel } from "../../../src/ui/inline-panel/crew-editor.ts";
import { LiveRunSidebar } from "../../../src/ui/live-run-sidebar.ts";
import { updateCrewWidget } from "../../../src/ui/widget/index.ts";
import { buildTaskListLines } from "../../../src/ui/widget/task-list.ts";
import { statusSummary } from "../../../src/ui/widget/widget-model.ts";
import {
	buildWidgetLines,
	idleWidgetLine,
	resetWidgetScheduledJobsReader,
	setWidgetScheduledJobsReader,
	widgetRailSlot,
} from "../../../src/ui/widget/widget-renderer.ts";
import type { CrewWidgetState, WidgetRun } from "../../../src/ui/widget/widget-types.ts";
import { visibleWidth } from "../../../src/utils/visual.ts";
import type { WorkflowConfig } from "../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../fixtures/test-tempdir.ts";

const FAKE_CWD = "/tmp/pi-crew-dock-rail-test";
const T0 = new Date("2026-09-13T05:00:00.000Z");

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
/** The spinner frame is wall-clock driven — pin it before comparing verbatim. */
const pinSpinner = (s: string): string => s.replace(/[\u2800-\u28ff]/g, "⠧");
/** ANSI-free, trailing-padding-free view of a rail line (railLine pads). */
const bare = (s: string): string => stripAnsi(s).trimEnd();

afterEach(() => {
	resetWidgetScheduledJobsReader();
});

function makeJob(overrides?: Partial<ScheduledJob>): ScheduledJob {
	return {
		id: "job-1",
		name: "nightly-digest",
		description: "",
		schedule: "0 3 * * *",
		scheduleType: "cron",
		subagentType: "executor",
		prompt: "{}",
		enabled: true,
		createdAt: T0.toISOString(),
		runCount: 0,
		...overrides,
	};
}

/** 5 agents: 3 completed + 2 running → `2 running · 3/5 done`. */
function dockRun(overrides: Partial<Record<string, unknown>> = {}): WidgetRun {
	const run = {
		schemaVersion: 1,
		runId: "team_20260916080601_bff8772bfd8e1d53",
		team: "fast-fix",
		workflow: "fast-fix",
		goal: "dock rail",
		status: "running",
		createdAt: T0.toISOString(),
		updatedAt: T0.toISOString(),
		planApproval: undefined,
		...overrides,
	};
	const agents = ["completed", "completed", "completed", "running", "running"].map((status, index) => ({
		id: `a${index}`,
		runId: run.runId,
		agent: "executor",
		role: "executor",
		taskId: `0${index}`,
		status,
		startedAt: T0.toISOString(),
		progress: { currentTool: "bash" },
		model: "anthropic/claude-sonnet-4",
	}));
	return { run, agents, snapshot: undefined } as unknown as WidgetRun;
}

// ── The dock ──────────────────────────────────────────────────────────

/** Team + workflow shared by every fixture below (one per surface). */
const team: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "worker", agent: "worker" }],
};
const workflow: WorkflowConfig = {
	name: "build",
	description: "build",
	source: "builtin",
	filePath: "build.workflow.md",
	steps: [{ id: "one", role: "worker", task: "One" }],
};

test("dock (running): EXACTLY one row, `┃` rail, canopy, `···· ↓·enter` tail — verbatim §2.B", () => {
	// A job with no finite nextRun renders the plain `⏰ 1 sched` segment, which
	// is exactly the render the design system documents.
	setWidgetScheduledJobsReader(() => [makeJob({ nextRun: undefined })]);
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, [dockRun()], 0, 100, { now: T0 });
	assert.equal(lines.length, 1, `the dock is ONE row, got ${JSON.stringify(lines)}`);
	assert.equal(
		pinSpinner(stripAnsi(lines[0]!)),
		"┃ ⠧ CREW ▸ fast-fix · 2 running · 3/5 done · ⏰ 1 sched ···· ↓·enter",
		"verbatim §2.B running row",
	);
	assert.ok(!lines[0]!.includes("┏") && !lines[0]!.includes("┗"), "the dock never opens/closes a card");
	assert.ok(!lines[0]!.includes("—"), "the retired `— ↓·enter` separator is gone");
});

test("dock (focused): the ❯ prefix rides the SAME single row", () => {
	setWidgetScheduledJobsReader(() => []);
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, [dockRun()], 0, 100, { now: T0, focused: true });
	assert.equal(lines.length, 1);
	assert.ok(lines[0]!.startsWith("❯ ┃ "), `focused marker + rail, got '${lines[0]}'`);
	assert.ok(lines[0]!.endsWith("···· ↓·enter"), `focused row keeps the tail hint, got '${lines[0]}'`);
});

test("dock (zero runs + schedules): `┃ CREW ▸ idle · ⏰ … ···· ↓·enter`", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })]);
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, [], 0, 100, { now: T0 });
	assert.equal(lines.length, 1);
	assert.equal(stripAnsi(lines[0]!), "┃ CREW ▸ idle · ⏰ 1 sched · next 84m ···· ↓·enter");
	assert.equal(
		stripAnsi(buildWidgetLines(FAKE_CWD, 0, 8, [], 0, 100, { now: T0, focused: true })[0]!),
		"❯ ┃ CREW ▸ idle · ⏰ 1 sched · next 84m ···· ↓·enter",
		"focused idle row keeps the ❯ prefix",
	);
});

test("dock (zero runs + NO schedules): renders NOTHING — regression lock for `undefined — ↓·enter`", () => {
	setWidgetScheduledJobsReader(() => []);
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, [], 0, 100, { now: T0 });
	assert.deepEqual(lines, [], "never a bare hint, never a bare `undefined`");
	assert.ok(!JSON.stringify(lines).includes("undefined"), "the live bug's literal string must be impossible");
	assert.equal(idleWidgetLine(undefined), undefined, "no schedules → no idle row");
	assert.ok(idleWidgetLine("⏰ 1 sched")?.startsWith("┃ CREW ▸ idle · ⏰ 1 sched"), "same helper builds the idle row");
});

test("dock: the row never exceeds the render width (40 / 80 / 120 columns)", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })]);
	const states: Array<{ label: string; runs: WidgetRun[]; focused: boolean }> = [
		{ label: "running", runs: [dockRun()], focused: false },
		{ label: "running focused", runs: [dockRun()], focused: true },
		{ label: "idle", runs: [], focused: false },
	];
	for (const width of [40, 80, 120]) {
		for (const state of states) {
			const lines = buildWidgetLines(FAKE_CWD, 0, 8, state.runs, 0, width, { now: T0, focused: state.focused });
			assert.equal(lines.length, 1, `${state.label} @${width}: one row`);
			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= width,
					`${state.label} @${width}: visible width ${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`,
				);
				assert.ok(line.includes("┃"), `${state.label} @${width}: rides the rail`);
				assert.ok(!line.includes("┏") && !line.includes("┗"), `${state.label} @${width}: no card glyphs on the dock`);
			}
		}
	}
});

test("dock component (real CrewWidgetComponent): one row, rail present, no card glyphs", () => {
	setWidgetScheduledJobsReader(() => []);
	const cwd = createTrackedTempDir("pi-crew-dock-rail-component-");
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest } = createRunManifest({ cwd, team, workflow, goal: "dock rail component" });
		fs.writeFileSync(
			path.join(manifest.stateRoot, "agents.json"),
			JSON.stringify([
				{
					id: "a1",
					taskId: "01",
					agent: "executor",
					role: "executor",
					status: "running",
					startedAt: new Date().toISOString(),
					progress: { recentOutput: [] },
				},
			]),
		);
		const calls: Array<{ key: string; content: unknown }> = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				setStatus: () => undefined,
				setWidget: (key: string, content: unknown) => calls.push({ key, content }),
				requestRender: () => undefined,
			},
			sessionManager: { getSessionId: () => undefined },
		} as never;
		updateCrewWidget(ctx, { frame: 0 } as CrewWidgetState, { widgetPlacement: "aboveEditor" }, undefined, undefined, [manifest]);
		const install = calls.find((call) => call.key === "pi-crew-active" && typeof call.content === "function");
		assert.ok(install, "dock component installed");
		const factory = install.content as (tui: unknown, theme: unknown) => { render(width: number): string[] };
		const lines = factory(undefined, { fg: (_c: string, v: string) => v, bold: (v: string) => v }).render(100);
		assert.equal(lines.length, 1, `component paints ONE row, got ${JSON.stringify(lines)}`);
		assert.ok(stripAnsi(lines[0]!).includes("CREW ▸"), `canopy on the rail, got '${stripAnsi(lines[0]!)}'`);
		assert.ok(!stripAnsi(lines[0]!).includes("┏") && !stripAnsi(lines[0]!).includes("┗"), "no card glyphs");
	} finally {
		removeTrackedTempDir(cwd);
	}
});

test("dock component at zero runs: nothing to paint → [] (never a bare hint, never `undefined`)", () => {
	const cwd = createTrackedTempDir("pi-crew-dock-rail-zero-");
	try {
		setWidgetScheduledJobsReader(() => [makeJob({ nextRun: undefined })]);
		const calls: Array<{ key: string; content: unknown }> = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				setStatus: () => undefined,
				setWidget: (key: string, content: unknown) => calls.push({ key, content }),
				requestRender: () => undefined,
			},
			sessionManager: { getSessionId: () => undefined },
		} as never;
		updateCrewWidget(ctx, { frame: 0 } as CrewWidgetState, { widgetPlacement: "aboveEditor" }, undefined, undefined, []);
		const install = calls.find((call) => call.key === "pi-crew-active" && typeof call.content === "function");
		assert.ok(install, "keep-alive mounts the dock while a job is scheduled");
		const factory = install.content as (tui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void };
		const component = factory(undefined, { fg: (_c: string, v: string) => v, bold: (v: string) => v });
		const withJob = component.render(100);
		assert.equal(withJob.length, 1, `one idle row while a job is scheduled, got ${JSON.stringify(withJob)}`);
		assert.ok(stripAnsi(withJob[0]!).includes("CREW ▸ idle"), `idle canopy, got '${stripAnsi(withJob[0]!)}'`);
		// The job disappears (right after a scheduled run finished): the component
		// path used to paint the literal `undefined — ↓·enter` here.
		setWidgetScheduledJobsReader(() => []);
		component.invalidate();
		const empty = component.render(100);
		assert.deepEqual(empty, [], "zero runs + no schedules renders NOTHING");
		assert.ok(!JSON.stringify(empty).includes("undefined"), "the 2026-09-16 live bug stays dead");
	} finally {
		removeTrackedTempDir(cwd);
	}
});

test("status bar: `┃ CREW ▸ <n>r · <n>q · <n>/<n> done · <model>`", () => {
	assert.equal(statusSummary([dockRun()]), "┃ CREW ▸ 2r · 3/5 done · claude-sonnet-4");
	const queued = [dockRun()];
	(queued[0]!.agents[3] as { status: string }).status = "queued";
	assert.equal(statusSummary(queued), "┃ CREW ▸ 1r · 1q · 3/5 done · claude-sonnet-4");

	// Live 2026-09-16: after a run finished the bar printed `┃ CREW ▸ 0r · 3/3
	// done · MiniMax-M3` — a zero segment is noise, exactly like the `0 running`
	// the dock header used to print.
	const base = dockRun({ status: "completed" });
	const finished = {
		run: { ...(base.run as object), status: "completed" },
		agents: (base.agents as unknown as Array<Record<string, unknown>>).map((a) => ({ ...a, status: "completed" })),
		snapshot: undefined,
	} as unknown as WidgetRun;
	assert.equal(statusSummary([finished]), "┃ CREW ▸ 5/5 done · claude-sonnet-4", "no `0r` segment on a finished run");
	assert.ok(!statusSummary([finished]).includes("0r"), "zero-running must never print");
	assert.ok(!/\b0[qrw]\b/.test(statusSummary([finished])), "no zero count segments at all");
	assert.equal(
		statusSummary([dockRun(), dockRun({ runId: "team_20260916080601_second" })]),
		"┃ CREW ▸ 4r · 6/10 done · 2 runs · claude-sonnet-4",
		"the r/q counts stay AGENT counts; the run tally is its own segment",
	);
	assert.match(statusSummary(queued), /^┃ CREW ▸ \d+r · \d+q · \d+\/\d+ done · \S+$/, "canonical §2.B shape");
});

test("dock rail colour = aggregate run state (statusSlot)", () => {
	assert.equal(widgetRailSlot([]), "border", "idle");
	assert.equal(widgetRailSlot([dockRun()]), "borderAccent", "running");
	assert.equal(widgetRailSlot([dockRun({ status: "failed" })]), "error", "failure outranks live work");
	assert.equal(widgetRailSlot([dockRun(), dockRun({ runId: "team_b", status: "failed" })]), "error");
});

// ── Plan card (task-list.ts) ──────────────────────────────────────────

function planTasks(count = 4): TeamTaskState[] {
	const titles = ["Design the flux capacitor", "Acquire plutonium", "Install flux capacitor", "Report the result"];
	const tasks = titles.slice(0, count).map((title, index) => ({
		id: `0${index + 1}_step`,
		status: "completed",
		title,
		displayName: title,
	})) as unknown as TeamTaskState[];
	if (count >= 2) Object.assign(tasks[1]!, { status: "running", startedAt: T0.toISOString(), usage: { input: 4100, output: 1200 } });
	if (count >= 3) Object.assign(tasks[2]!, { status: "queued", dependsOn: [tasks[1]!.id] });
	return tasks;
}

function planRuns(tasks: TeamTaskState[]): WidgetRun[] {
	return [
		{
			run: { runId: "team_plan_test", team: "default", workflow: "build", status: "running" },
			agents: [],
			snapshot: { tasks },
		} as unknown as WidgetRun,
	];
}

test("plan card: `┏ PLAN ▸ <title>` canopy + gauge, `┃` rows (detail kept), `┗ <counts>` cap", () => {
	const lines = buildTaskListLines(planRuns(planTasks(4)), 120).map(bare);
	assert.match(lines[0] ?? "", /^┏ PLAN ▸ default\/build/, `canopy identity, got '${lines[0]}'`);
	assert.ok(lines[0]!.includes("▕"), `gauge on the canopy where a bar fits, got '${lines[0]}'`);
	assert.match(lines[1] ?? "", /^┃ ✔ #1 Design the flux capacitor/, "completed row keeps its icon on the rail");
	assert.match(lines[2] ?? "", /^┃ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] #2 Acquire plutonium \(.*↑ 4\.1k ↓ 1\.2k\)/, "running row keeps elapsed + tokens");
	assert.match(lines[3] ?? "", /^┃ ◻ #3 Install flux capacitor › blocked by #2/, "queued row keeps `› blocked by #N`");
	assert.match(lines.at(-1) ?? "", /^┗ 2 done · 1 in progress · 1 open$/, "counts cap via formatCount");
	assert.ok(!lines.join("\n").includes("● "), "the legacy `● N tasks (…)` header is retired");
});

test("plan card: overflow uses the canonical `▼ N below` dialect (never `… and N more`)", () => {
	const tasks = Array.from({ length: 15 }, (_, index) => ({
		id: `t${index + 1}`,
		status: "queued",
		title: `Step ${index + 1}`,
		displayName: `Step ${index + 1}`,
	})) as unknown as TeamTaskState[];
	const lines = buildTaskListLines(planRuns(tasks), 120).map(bare);
	const joined = lines.join("\n");
	assert.ok(joined.includes("▼ 5 below"), `canonical overflow hint, got '${joined}'`);
	assert.ok(!joined.includes("… and 5 more"), "retired dialect");
	assert.ok(!joined.includes("undefined"), "no undefined from an unvalidated slice");
});

// ── Live-run sidebar ──────────────────────────────────────────────────

const sidebarTeam: TeamConfig = {
	name: "research",
	description: "research",
	source: "builtin",
	filePath: "research.team.md",
	roles: [
		{ name: "explorer", agent: "explorer" },
		{ name: "analyst", agent: "analyst" },
	],
};
const sidebarWorkflow: WorkflowConfig = {
	name: "research",
	description: "research",
	source: "builtin",
	filePath: "research.workflow.md",
	steps: [
		{ id: "explore", role: "explorer", task: "Explore" },
		{ id: "analyze", role: "analyst", dependsOn: ["explore"], task: "Analyze" },
	],
};

function sidebarRun(records: (manifest: ReturnType<typeof createRunManifest>["manifest"]) => unknown[]): {
	sidebar: LiveRunSidebar;
	runId: string;
	lines: string[];
} {
	const cwd = createTrackedTempDir("pi-crew-dock-rail-sidebar-");
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const { manifest, tasks } = createRunManifest({ cwd, team: sidebarTeam, workflow: sidebarWorkflow, goal: "sidebar rail" });
	saveRunManifest({ ...manifest, status: "running"  }, { allowTerminalExit: true });
	const updated = tasks.map((task) =>
		task.id === "01_explore"
			? { ...task, status: "running" as const, startedAt: T0.toISOString(), usage: { input: 10, output: 5 } }
			: task,
	);
	saveRunTasks(manifest, updated as never);
	fs.writeFileSync(path.join(manifest.stateRoot, "agents.json"), JSON.stringify(records(manifest)));
	const sidebar = new LiveRunSidebar({ cwd, runId: manifest.runId, done: () => undefined });
	const lines = sidebar.render(80).map(stripAnsi);
	fs.rmSync(cwd, { recursive: true, force: true });
	return { sidebar, runId: manifest.runId, lines };
}

test("sidebar: `┏ LIVE ▸ <runId8>` canopy, `┣ SECTION` headers, `┗ <hint>` cap — rounded box retired", () => {
	const runId = "team_plan_test_run_id_abcdef";
	const { lines } = sidebarRun(() => [
		{
			id: "a1",
			runId,
			taskId: "01_explore",
			agent: "explorer",
			role: "explorer",
			status: "running",
			startedAt: T0.toISOString(),
			progress: { currentTool: "read", toolCount: 2 },
			usage: { input: 10, output: 5 },
		},
	]);
	const joined = lines.join("\n");
	assert.match(lines[0] ?? "", /^┏ LIVE ▸ \w{8}\s*$/, `canopy identity, got '${lines[0]}'`);
	assert.ok(!joined.includes("pi-crew live sidebar"), "the old title line is gone");
	assert.ok(!/[╭╮╰╯]/.test(joined), `rounded box glyphs retired, got '${joined}'`);
	assert.ok(!joined.includes("│"), "no box edge column");
	assert.match(joined, /┣ ACTIVE ▸ 1 agent/, "active section header");
	assert.match(joined, /┣ WAITING ▸ \d+ tasks?/, "waiting section header");
	assert.match(joined, /┣ DONE ▸ \d+ agents?/, "done section header");
	assert.match(joined, /┣ TASKS ▸ \d+ tasks?/, "tasks section header");
	assert.ok(
		(lines.at(-1) ?? "").startsWith("┗ ") && joined.includes("/team-dashboard details") && joined.includes("close"),
		`cap carries the formatHint footer, got '${lines.at(-1)}'`,
	);
	assert.ok(!joined.includes("->"), "the legacy `role->agent` separator is retired");
	assert.ok(!joined.includes("undefined"), "no undefined from unvalidated agents.json");
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 80, `sidebar line exceeds 80: ${JSON.stringify(line)}`);
	}
});

test("sidebar: an agents.json record missing every optional field still cannot print `undefined`", () => {
	const { lines } = sidebarRun(() => [
		// Only the fields readCrewAgents validates (id + taskId) are present.
		{ id: "sparse-1", taskId: "sparse-task", status: "running" },
	]);
	const joined = lines.join("\n");
	assert.match(joined, /┃ .* sparse-task \? ▸ \?/, `guarded fields, got '${joined}'`);
	assert.ok(!joined.includes("undefined"), "guarded record cannot leak `undefined`");
	assert.ok(joined.includes("model pending"), "an unresolved model reads as pending");
});

// ── crew-editor border label ──────────────────────────────────────────

test("crew-editor: the @name border label collapses legacy separators and stays single-line", () => {
	assert.equal(agentBorderLabel("explorer->child"), "explorer▸child");
	assert.equal(agentBorderLabel("verifier\n  ->  executor"), "verifier ▸ executor", "newlines can never tear the border");
	assert.ok(!agentBorderLabel("a->b").includes("->"), "no `->` may reach the editor border");
	assert.ok(visibleWidth(agentBorderLabel("x".repeat(80))) <= 24, "label stays within AGENT_LABEL_MAX");
	assert.equal(agentBorderLabel(""), "");
});
