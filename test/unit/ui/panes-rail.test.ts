/**
 * E3 — dashboard panes + transcript viewer speak RAIL (design system §2.G).
 *
 * Locks (real render output, ANSI stripped):
 *   1. A pane returns CONTENT LINES ONLY: no frame glyph `┏┃┗┣` and no
 *      rounded-box edge `╭╮╰╯├┤│` (the frame owner draws the rail).
 *   2. `->` may never print (use `▸`); the rail cursor is `›` only.
 *   3. No `undefined` may reach a line, even from disk-sourced records that
 *      are NOT schema-validated at read time (schedules, metric labels).
 *   4. Overflow is the ONE rail dialect (`▲ n above` / `▼ m below`).
 *   5. Glyphs come from `src/ui/rail.ts` (`statusIcon`, `ACTIVE`, `CURSOR`).
 *   6. Hints go through `formatHint()` (keys `label`, ` · ` joined, close last).
 *   7. Where the migration is purely cosmetic the content is byte-identical.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMetricRegistry } from "../../../src/observability/metric-registry.ts";
import type { ScheduledJob } from "../../../src/runtime/scheduling/scheduler.ts";
import type { PlanRecord, TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";
import { renderAgentsPane } from "../../../src/ui/dashboard-panes/agents-pane.ts";
import { renderHealthPane } from "../../../src/ui/dashboard-panes/health-pane.ts";
import { renderMailboxPane } from "../../../src/ui/dashboard-panes/mailbox-pane.ts";
import { renderMetricsPane } from "../../../src/ui/dashboard-panes/metrics-pane.ts";
import { renderPlanPane } from "../../../src/ui/dashboard-panes/plan-pane.ts";
import { renderProgressPane } from "../../../src/ui/dashboard-panes/progress-pane.ts";
import { renderScheduleDetails, renderSchedulesPane } from "../../../src/ui/dashboard-panes/schedules-pane.ts";
import { renderTranscriptPane } from "../../../src/ui/dashboard-panes/transcript-pane.ts";
import { ACTIVE, CURSOR, statusIcon } from "../../../src/ui/rail.ts";
import type { RunUiSnapshot } from "../../../src/ui/snapshot-types.ts";
import { asCrewTheme } from "../../../src/ui/theme-adapter.ts";
import { DurableTextViewer } from "../../../src/ui/transcript-viewer.ts";

const NOW = new Date("2026-09-13T05:00:00.000Z");

/** ANSI stripper — every assertion runs on visible text. */
const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");
const visible = (lines: string[]): string => stripAnsi(lines.join("\n"));

/** Real ANSI theme (the `fg`/`bold` are unambiguous escape wrappers). */
const ANSI_THEME = asCrewTheme({
	fg: (_color: string, text: string) => `\u001b[36m${text}\u001b[39m`,
	bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
});

/** Identity theme — the glyph `statusIcon()` renders for an UNCOLORED pane. */
const PLAIN_THEME = asCrewTheme(undefined);

const MANIFEST = {
	schemaVersion: 1,
	runId: "team_rail",
	cwd: process.cwd(),
	team: "default",
	workflow: "default",
	goal: "rail migration",
	status: "running",
	createdAt: "2026-09-13T00:00:00.000Z",
	updatedAt: "2026-09-13T00:00:00.000Z",
	stateRoot: "",
	artifactsRoot: "",
	tasksPath: "",
	eventsPath: "",
	artifacts: [],
	workspaceMode: "single",
} as unknown as TeamRunManifest;

function task(over: Partial<TeamTaskState> & { id: string }): TeamTaskState {
	return {
		runId: "team_rail",
		role: "executor",
		agent: "executor",
		title: over.id,
		status: "completed",
		dependsOn: [],
		cwd: process.cwd(),
		...over,
	} as TeamTaskState;
}

function snapshot(over: Partial<RunUiSnapshot> = {}): RunUiSnapshot {
	return {
		runId: "team_rail",
		cwd: process.cwd(),
		fetchedAt: 0,
		signature: "sig",
		manifest: MANIFEST,
		tasks: [],
		agents: [],
		progress: { total: 0, completed: 0, running: 0, failed: 0, queued: 0 },
		usage: { tokensIn: 0, tokensOut: 0, toolUses: 0 },
		mailbox: { inboxUnread: 0, outboxPending: 0, needsAttention: 0 },
		recentEvents: [],
		recentOutputLines: [],
		...over,
	} as unknown as RunUiSnapshot;
}

function planRecord(): PlanRecord {
	return {
		id: "plan-1",
		runId: "team_rail",
		version: 1,
		title: "Ship it",
		phases: [{ id: "ph-1", title: "implement", itemIds: ["it-1", "it-2"], status: "active" }],
		items: [
			{ id: "it-1", title: "Done item", taskIds: ["t1"], specIds: [], acceptance: [], status: "done" },
			{ id: "it-2", title: "Active item", taskIds: ["t2"], specIds: [], acceptance: [], status: "active" },
		],
		createdAt: NOW.toISOString(),
	} as unknown as PlanRecord;
}

function scheduledJob(over: Partial<ScheduledJob> = {}): ScheduledJob {
	return {
		id: "job-1",
		name: "nightly-build",
		description: "Nightly build",
		schedule: "0 9 * * *",
		scheduleType: "cron",
		subagentType: "team",
		prompt: JSON.stringify({ action: "run", team: "default", goal: "Do the thing" }),
		enabled: true,
		createdAt: "2026-09-01T00:00:00.000Z",
		lastRun: "2026-09-13T02:00:00.000Z",
		lastStatus: "success",
		nextRun: new Date(NOW.getTime() + 84 * 60_000).toISOString(),
		runCount: 12,
		...over,
	};
}

const AGENTS_FIXTURE = Array.from({ length: 20 }, (_value, index) => ({
	id: `a${index}`,
	taskId: `01_${index}`,
	status: index % 2 === 0 ? "completed" : "running",
	role: index % 2 === 0 ? "explorer" : "executor",
	agent: index % 2 === 0 ? "explorer" : "executor",
	runtime: "child-process",
	usage: { input: 1000, output: 500, cost: 0.0123 },
	progress: { currentTool: "bash", toolCount: 3 },
}));

const TASKS_FIXTURE: TeamTaskState[] = [
	task({ id: "t1", status: "completed", heartbeat: { workerId: "w1", lastSeenAt: NOW.toISOString(), alive: true } }),
	task({ id: "t2", status: "running", depth: 2, modelAttempts: [{ model: "zai/glm-5.3", success: true }] } as never),
];

function allPaneLines(): Array<{ pane: string; lines: string[] }> {
	const snap = snapshot({
		tasks: TASKS_FIXTURE,
		agents: AGENTS_FIXTURE as never,
		progress: { total: 2, completed: 1, running: 1, failed: 0, queued: 0 },
		mailbox: { inboxUnread: 1, outboxPending: 0, needsAttention: 1, steerUnread: 1, followUpUnread: 2 },
		plans: [planRecord()],
		recentOutputLines: ["hello output", "more output"],
		recentEvents: [{ type: "task.updated", time: NOW.toISOString(), taskId: "t1", metadata: { seq: 7 } }] as never,
	});
	const registry = createMetricRegistry();
	registry.counter("crew.rail.count", "counts").inc({ team: "x" });
	return [
		{ pane: "agents", lines: renderAgentsPane(snap, { workspaceId: "no-such-workspace", nowMs: NOW.getTime() }) },
		{ pane: "plan", lines: renderPlanPane(snap) },
		{ pane: "progress", lines: renderProgressPane(snap) },
		{ pane: "health", lines: renderHealthPane(snap, { now: NOW, isForeground: true }) },
		{ pane: "mailbox", lines: renderMailboxPane(snap) },
		{ pane: "metrics", lines: renderMetricsPane(snap, { registry }) },
		{ pane: "transcript", lines: renderTranscriptPane(snap) },
		{ pane: "schedules", lines: renderSchedulesPane([scheduledJob()], NOW, { selectedIndex: 0 }) },
		{ pane: "schedules-details", lines: renderScheduleDetails(scheduledJob(), NOW) },
	];
}

// ── 1. Content-only contract ───────────────────────────────────────────

test("panes return CONTENT ONLY — no rail frame glyph, no rounded-box edge, no `->`", () => {
	for (const { pane, lines } of allPaneLines()) {
		const text = visible(lines);
		assert.ok(lines.length > 0, `${pane}: renders at least one line`);
		assert.ok(!/[┏┃┗┣]/.test(text), `${pane}: pane must not draw rail frame glyphs; got ${JSON.stringify(text)}`);
		assert.ok(!/[╭╮╰╯├┤│]/.test(text), `${pane}: rounded-box frame is retired; got ${JSON.stringify(text)}`);
		assert.ok(!text.includes("->"), `${pane}: \`->\` must never print (use ▸); got ${JSON.stringify(text)}`);
		assert.ok(!text.includes("undefined"), `${pane}: no \`undefined\` may reach a line; got ${JSON.stringify(text)}`);
	}
});

// ── 2. Glyphs come from rail.ts ────────────────────────────────────────

test("plan pane task glyphs come from rail.ts (statusIcon + ACTIVE), not a forked map", () => {
	const text = visible(renderPlanPane(snapshot({ tasks: TASKS_FIXTURE, plans: [planRecord()] })));
	// completed task → statusIcon("completed"); running grandchild → ACTIVE (▸).
	assert.ok(text.includes(`${statusIcon("completed", PLAIN_THEME)} t1`), `completed glyph must be rail's; got ${text}`);
	assert.ok(text.includes(`${ACTIVE} t2 d2`), `running/active glyph must be rail's ACTIVE; got ${text}`);
	// done item → statusIcon("completed") as well (item-level vocabulary unified).
	assert.ok(text.includes(`${statusIcon("completed", PLAIN_THEME)} Done item`), `item glyph must be rail's; got ${text}`);
});

// ── 3. Overflow dialect ────────────────────────────────────────────────

test("agents pane overflow uses `▼ n below` (rail dialect), not `… +N more`", () => {
	const lines = renderAgentsPane(snapshot({ agents: AGENTS_FIXTURE as never }), { workspaceId: "no-such-workspace" });
	const text = visible(lines);
	// 20 agents → 12 rendered (unchanged cap), 8 hidden below.
	assert.ok(/▼ 8 below/.test(text), `expected the rail overflow dialect; got ${JSON.stringify(text)}`);
	assert.ok(!text.includes("more above") && !text.includes("… +"), "legacy overflow dialects are retired");
	assert.ok(!/↑|↓/.test(text), "legacy arrow overflow is retired");
});

test("agents pane keeps its 12-row cap and its per-agent stats (behaviour preserved)", () => {
	const lines = renderAgentsPane(snapshot({ agents: AGENTS_FIXTURE as never }), { workspaceId: "no-such-workspace" });
	const rows = lines.filter((line) => /^\s{2}\S .*(explorer|executor)/.test(stripAnsi(line)));
	assert.equal(rows.length, 12, `cap must stay 12 rows; got ${rows.length}`);
	assert.ok(visible(lines).includes("$0.0123"), "per-agent cost column preserved");
});

// ── 4. Cursor ──────────────────────────────────────────────────────────

test("schedules pane cursor is the rail `›` and the actions hint stays byte-identical", () => {
	const lines = renderSchedulesPane([scheduledJob(), scheduledJob({ id: "job-2", name: "weekly" })], NOW, {
		selectedIndex: 1,
	});
	const text = visible(lines);
	assert.ok(text.includes(`${CURSOR} ● weekly`), `cursor must be rail's CURSOR; got ${JSON.stringify(text)}`);
	assert.ok(!text.includes("→") && !text.includes("->"), "no arrow cursor");
	assert.ok(
		lines.some((line) => stripAnsi(line) === "Actions: T toggle · N run now · V details · X delete · R refresh"),
		`the actions hint must keep the rail hint format; got ${JSON.stringify(text)}`,
	);
});

// ── 5. undefined guards on unvalidated disk records ────────────────────

test("schedules pane: a persisted job missing every optional field renders `?`, never `undefined`", () => {
	const degenerate = { id: "job-min", enabled: false } as unknown as ScheduledJob;
	const text = visible(renderSchedulesPane([degenerate], NOW, { includeIds: true }));
	assert.ok(!text.includes("undefined"), `got ${JSON.stringify(text)}`);
	assert.ok(text.includes("0 runs"), `missing runCount must fall back to 0; got ${JSON.stringify(text)}`);
	assert.ok(text.includes("last: never"), "missing lastRun keeps the honest 'never'");
	assert.ok(!text.includes("NaN"), "no NaN may leak");
	const details = visible(renderScheduleDetails(degenerate, NOW));
	assert.ok(!details.includes("undefined"), `details view leaked undefined: ${JSON.stringify(details)}`);
	assert.ok(details.includes("runs: 0"), "missing runCount falls back to 0 in the details view");
});

test("metrics pane: unguarded label values render `?`, never `undefined`", () => {
	const registry = createMetricRegistry();
	registry.counter("crew.rail.labels", "labels").inc({ status: undefined, team: "x" } as unknown as Record<string, string>);
	const text = visible(renderMetricsPane(undefined, { registry }));
	assert.ok(!text.includes("undefined"), `got ${JSON.stringify(text)}`);
	assert.ok(text.includes("status=?"), `missing label value must fall back to ?; got ${JSON.stringify(text)}`);
	assert.ok(text.includes("team=x"), "present label values are preserved");
});

// ── 6. Hints through formatHint ────────────────────────────────────────

test("hints are built with formatHint (keys label · joined, close last)", () => {
	const snap = snapshot({
		tasks: [
			task({
				id: "t9",
				status: "running",
				heartbeat: { workerId: "w9", lastSeenAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(), alive: true },
			}),
		],
		mailbox: { inboxUnread: 1, outboxPending: 0, needsAttention: 1 },
		recentOutputLines: ["hello output", "more output"],
	});
	const health = visible(renderHealthPane(snap, { now: NOW, isForeground: true }));
	assert.ok(health.includes("Actions: R recovery · K kill stale · D diagnostic export"), `got ${health}`);

	const mailbox = visible(renderMailboxPane(snap));
	assert.ok(mailbox.includes("Needs attention: press Enter for detail · A ack · N nudge · C compose · X ack all."), `got ${mailbox}`);

	const transcript = visible(renderTranscriptPane(snap));
	assert.ok(transcript.includes("press V for transcript viewer · O for raw output"), `got ${transcript}`);
	assert.ok(transcript.includes("Output pane: 2 recent lines"), "the pane's own summary line stays a body line");
});

test("plan approval hint uses the rail hint format ( · join, close/deny last)", () => {
	const manifest = {
		...MANIFEST,
		planApproval: { required: true, status: "pending", requestedAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
	} as unknown as TeamRunManifest;
	const text = visible(renderPlanPane(snapshot({ manifest, tasks: TASKS_FIXTURE, plans: [planRecord()] })));
	assert.ok(text.includes("plan approval pending — A approve · n deny"), `got ${text}`);
});

// ── 7. Transcript viewer: standalone overlay, own RAIL frame ───────────

function viewer(lines: number, done: (result: undefined) => void = () => undefined): DurableTextViewer {
	return new DurableTextViewer(
		"pi-crew transcript",
		"team_rail:01 · full 1KB · f full",
		Array.from({ length: lines }, (_value, index) => `line-${index}`),
		ANSI_THEME,
		done,
	);
}

test("transcript viewer draws a RAIL canopy + `┃` body + `┗` close (rounded box retired)", () => {
	const lines = viewer(60).render(100).map(stripAnsi);
	const text = lines.join("\n");
	assert.ok(lines[0]?.startsWith("┏ ") && lines[0].includes("TRANSCRIPT") && lines[0].includes("pi-crew transcript"));
	assert.ok(!/[╭╮╰╯├┤│]/.test(text), `rounded box must be gone; got ${JSON.stringify(text)}`);
	assert.ok(
		lines.slice(1, -1).every((line) => line.startsWith("┃ ")),
		"every body row is a `┃ ` rail row",
	);
	assert.ok(!lines.some((line) => /[┏┣]/.test(line.slice(1))), "panes must not repeat the canopy/section glyph");
	assert.ok(lines[lines.length - 1]?.startsWith("┗ "), "close glyph last");
	assert.ok(/lines · \d+% · auto-scroll (on|off)/.test(lines[lines.length - 1] ?? ""), "status line preserved");
});

test("transcript viewer overflow uses `▲ n above` (single dialect, paren bug gone)", () => {
	const lines = viewer(60).render(100).map(stripAnsi);
	const overflow = lines.find((line) => /▲ \d+ above/.test(line));
	assert.ok(overflow, `expected the rail overflow dialect; got ${JSON.stringify(lines.join("\n"))}`);
	assert.ok(!lines.join("\n").includes("truncated above"), "legacy `… (n lines truncated above` dialect retired");
	assert.ok(!lines.some((line) => line.includes("(") && line.includes("above")), "the unbalanced paren line is gone");
});

test("transcript viewer hint is formatHint-built, close action last, `Esc` spelled", () => {
	const lines = viewer(60).render(100).map(stripAnsi);
	const hint = lines.find((line) => line.includes("scroll"));
	assert.ok(hint, "hint row renders");
	assert.ok(hint.includes("PgUp/PgDn page"), `rail keyToken spelling; got ${hint}`);
	assert.ok(hint.includes("Esc close"), `Esc spelling + close last; got ${hint}`);
	assert.ok(hint.trimEnd().endsWith("Esc close"), `close must be LAST; got ${hint}`);
});

test("transcript viewer keys/scroll are unchanged (j/k · g/G · a · f · q close)", () => {
	const v = viewer(60);
	v.handleInput("G");
	assert.ok(
		v
			.render(100)
			.map(stripAnsi)
			.some((line) => /100%/.test(line)),
		"G pins to the bottom",
	);
	v.handleInput("k");
	assert.ok(/(^|\s)auto-scroll off/.test(v.render(100).map(stripAnsi).join("\n")), "k leaves auto-scroll");
	v.handleInput("a");
	assert.ok(/(^|\s)auto-scroll on/.test(v.render(100).map(stripAnsi).join("\n")), "a re-enables auto-scroll");
	let closed = false;
	viewer(60, () => {
		closed = true;
	}).handleInput("q");
	assert.equal(closed, true, "q still closes");
});

// ── 8. Cosmetic parity ─────────────────────────────────────────────────

test("cosmetic migration: summary lines that only changed frame language are unchanged", () => {
	const snap = snapshot({
		tasks: TASKS_FIXTURE,
		plans: [planRecord()],
		progress: { total: 2, completed: 1, running: 1, failed: 0, queued: 0 },
	});
	assert.equal(stripAnsi(renderSchedulesPane([scheduledJob()], NOW)[0] ?? ""), "Scheduled jobs (1):", "header unchanged");
	assert.ok(
		stripAnsi(renderSchedulesPane([scheduledJob()], NOW)[1] ?? "").includes("● nightly-build  cron 0 9 * * * · in 84m · ✓ · 12 runs"),
		"schedules main row keeps all six columns + rhythm",
	);
	assert.ok(stripAnsi(renderPlanPane(snap)[0] ?? "") === "Plan pane: Ship it @v1 (1 phases · 2 items)", "plan header unchanged");
	assert.ok(
		stripAnsi(renderProgressPane(snap)[0] ?? "").includes("Progress pane: 1/2 completed · running=1 queued=0 failed=0"),
		"progress summary unchanged",
	);
	assert.ok(
		stripAnsi(renderTranscriptPane(snap)[0] ?? "").startsWith("Output pane: "),
		"transcript pane summary unchanged (run-dashboard tests assert this prefix)",
	);
});
