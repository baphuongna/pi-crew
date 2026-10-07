/**
 * L7/L9 dialect sweep (real-test 2026-10-07 UI-instability wave) — regression
 * pins for the dashboard panes + live-conversation overlay speaking the TUI
 * dialect instead of machine wire format:
 *
 *   1. mailbox pane: compact direction counts (`↓2 unread · ↑1 pending ·
 *      ⚠3 attention` — the compactUsage pattern from live-run-sidebar.ts),
 *      NEVER `unread=2` key=value; follow-up counts pluralised (formatCount).
 *   2. health pane: count-first tally (`1 stale`), never `stale=1`.
 *   3. progress pane: tally header + plain group-join ack state; `reason=`
 *      is the ONE deliberate diagnostic key=value survivor.
 *   4. live-conversation overlay: durations via formatDuration (`5m44s`),
 *      never raw seconds (`344.0s`).
 *   5. plural nouns via formatCount: `1/1 task`, `1 phase`, `0→1 task`,
 *      `Acknowledged 1 message.` (message-level pin lives in
 *      run-action-dispatcher.test.ts).
 *   6. source guard: the dead `formatLiveDuration` export stays deleted.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { LiveAgentHandle } from "../../../src/runtime/live-session/live-agent-manager.ts";
import type { PlanRecord, TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";
import { renderAgentsPane } from "../../../src/ui/dashboard-panes/agents-pane.ts";
import { renderHealthPane } from "../../../src/ui/dashboard-panes/health-pane.ts";
import { renderMailboxPane } from "../../../src/ui/dashboard-panes/mailbox-pane.ts";
import { renderPlanPane } from "../../../src/ui/dashboard-panes/plan-pane.ts";
import { renderProgressPane } from "../../../src/ui/dashboard-panes/progress-pane.ts";
import { LiveConversationOverlay } from "../../../src/ui/live-conversation-overlay.ts";
import type { RunUiSnapshot } from "../../../src/ui/snapshot-types.ts";
import type { CrewTheme } from "../../../src/ui/theme-adapter.ts";
import { briefToolResult } from "../../../src/ui/tool-renderers/brief-mode.ts";

const NOW = new Date("2026-10-07T05:00:00.000Z");

/** No-op theme keeps render output plain and deterministic. */
const PLAIN_THEME: CrewTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
	inverse: (text) => text,
};

const MANIFEST = {
	schemaVersion: 1,
	runId: "team_dialect",
	cwd: process.cwd(),
	team: "default",
	workflow: "default",
	goal: "dialect sweep",
	status: "running",
	createdAt: "2026-10-07T00:00:00.000Z",
	updatedAt: "2026-10-07T00:00:00.000Z",
	stateRoot: "",
	artifactsRoot: "",
	tasksPath: "",
	eventsPath: "",
	artifacts: [],
	workspaceMode: "single",
} as unknown as TeamRunManifest;

function snapshot(over: Partial<RunUiSnapshot> = {}): RunUiSnapshot {
	return {
		runId: "team_dialect",
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

function task(id: string, lastSeenAt?: string): TeamTaskState {
	return {
		id,
		runId: "team_dialect",
		role: "executor",
		agent: "executor",
		title: id,
		status: "running",
		dependsOn: [],
		cwd: process.cwd(),
		heartbeat: lastSeenAt ? { workerId: id, lastSeenAt, alive: true } : undefined,
	} as TeamTaskState;
}

// ── 1. Mailbox pane: compact direction dialect ─────────────────────────

test("mailbox pane speaks the compactUsage dialect, never key=value wire format", () => {
	const lines = renderMailboxPane(
		snapshot({
			mailbox: {
				inboxUnread: 2,
				outboxPending: 1,
				needsAttention: 3,
				steerUnread: 1,
				followUpUnread: 2,
				responseUnread: 4,
				messageUnread: 5,
				approximate: true,
			},
		}),
	);
	assert.equal(
		lines[0],
		"Mailbox pane: ↓2 unread · ↑1 pending · ⚠3 attention · approximate (tail)",
		`header must use ↓/↑ compact counts; got ${JSON.stringify(lines[0])}`,
	);
	assert.ok(
		lines.some((line) => line.includes("Breakdown: ↓1 steer · ↓2 follow-up · ↓4 response · ↓5 message")),
		`breakdown must use the same dialect; got ${JSON.stringify(lines)}`,
	);
	// The retired wire format must not appear anywhere in the pane.
	assert.ok(!lines.some((line) => /=/.test(line)), `no key=value may survive; got ${JSON.stringify(lines)}`);
	assert.ok(!lines.some((line) => line.includes("unread=") || line.includes("steer=")), "wire-format keys are gone");
});

test("mailbox pane pluralises the follow-up review line (no `(s)`)", () => {
	const two = renderMailboxPane(snapshot({ mailbox: { inboxUnread: 2, outboxPending: 0, needsAttention: 0, followUpUnread: 2 } }));
	assert.ok(
		two.some((line) => line.includes("📋 2 follow-ups pending review.")),
		`got ${JSON.stringify(two)}`,
	);
	const one = renderMailboxPane(snapshot({ mailbox: { inboxUnread: 1, outboxPending: 0, needsAttention: 0, followUpUnread: 1 } }));
	assert.ok(
		one.some((line) => line.includes("📋 1 follow-up pending review.")),
		`got ${JSON.stringify(one)}`,
	);
	assert.ok(!one.some((line) => line.includes("follow-up(s)")), "the lazy `(s)` plural is retired");
});

// ── 2. Health pane: count-first tally ──────────────────────────────────

test("health pane tally is count-first (`1 stale`), never `stale=1`", () => {
	const lines = renderHealthPane(
		snapshot({
			tasks: [
				task("healthy", NOW.toISOString()),
				task("stale", new Date(NOW.getTime() - 120_000).toISOString()),
				task("dead", new Date(NOW.getTime() - 600_000).toISOString()),
				task("missing"),
			],
		}),
		{ now: NOW, isForeground: true },
	);
	assert.ok(
		lines.some((line) => line.includes("1/4 healthy · 1 stale · 1 dead · 1 missing")),
		`count-first tally expected; got ${JSON.stringify(lines)}`,
	);
	assert.ok(!lines.some((line) => line.includes("stale=") || line.includes("dead=") || line.includes("missing=")), "wire format retired");
});

// ── 3. Progress pane: tally header + plain ack state ───────────────────

test("progress pane header is count-first and group joins carry the ack state plainly", () => {
	const lines = renderProgressPane(
		snapshot({
			progress: { total: 3, completed: 1, running: 1, failed: 0, queued: 1 },
			groupJoins: [
				{ requestId: "req-9", messageId: "m1", partial: false, ack: "acknowledged" },
				{ requestId: "req-8", messageId: "m2", partial: true, ack: "pending" },
			],
		}),
	);
	assert.ok(
		lines.some((line) => line.includes("Progress pane: 1/3 completed · 1 running · 1 queued · 0 failed")),
		`tally header expected; got ${JSON.stringify(lines)}`,
	);
	assert.ok(
		lines.some((line) => line.includes("group join completed: req-9 · acknowledged")),
		`got ${JSON.stringify(lines)}`,
	);
	assert.ok(
		lines.some((line) => line.includes("group join partial: req-8 · pending")),
		`got ${JSON.stringify(lines)}`,
	);
	assert.ok(!lines.some((line) => line.includes("ack=") || line.includes("running=")), "wire format retired");
});

test("progress pane keeps the diagnostic `reason=` for cancellation (judged, documented)", () => {
	const lines = renderProgressPane(
		snapshot({
			manifest: { ...MANIFEST, status: "cancelled" } as unknown as TeamRunManifest,
			cancellationReason: "leader_interrupted",
		}),
	);
	assert.ok(
		lines.some((line) => line.includes("cancelled: reason=leader_interrupted")),
		`the one diagnostic key=value survivor; got ${JSON.stringify(lines)}`,
	);
});

// ── 4. Live conversation overlay: formatDuration, not raw seconds ──────

function makeHandle(startedAtMs: number): LiveAgentHandle {
	return {
		agentId: "agent-1",
		taskId: "task-1",
		runId: "run-1",
		workspaceId: "ws-1",
		role: "executor",
		agent: "worker",
		description: "building feature",
		modelName: "sonnet",
		session: {},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		status: "running",
		pendingSteers: [],
		pendingFollowUps: [],
		pendingMessages: [],
		activity: {
			activeTools: new Map(),
			toolUses: 3,
			turnCount: 1,
			maxTurns: 10,
			responseText: "",
			compactionCount: 0,
			startedAtMs,
			completedAtMs: 0,
		},
	} as unknown as LiveAgentHandle;
}

test("live conversation overlay renders durations as `5m44s`, never `344.0s`", () => {
	const nowMs = NOW.getTime();
	const overlay = new LiveConversationOverlay(makeHandle(nowMs - 344_000), PLAIN_THEME, 80, 24, () => nowMs);
	try {
		const rendered = overlay.render(80).join("\n");
		assert.ok(rendered.includes("5m44s"), `meta row must use formatDuration; got ${JSON.stringify(rendered)}`);
		assert.ok(!/\d+\.\ds\b/.test(rendered), `raw toFixed(1) seconds are retired; got ${JSON.stringify(rendered)}`);
		const summary = overlay.cachedLines[overlay.cachedLines.length - 1] ?? "";
		assert.ok(summary.includes("5m44s"), `summary line must use formatDuration; got ${JSON.stringify(summary)}`);
		assert.ok(summary.includes("1 turn"), `turn count pluralised; got ${JSON.stringify(summary)}`);
	} finally {
		overlay.close();
	}
});

// ── 5. Plural nouns via formatCount ────────────────────────────────────

function planRecord(phases: number, items: number): PlanRecord {
	return {
		id: "plan-1",
		runId: "team_dialect",
		version: 1,
		title: "Ship it",
		phases: Array.from({ length: phases }, (unused, index) => ({
			id: `ph-${index}`,
			title: `phase-${index}`,
			itemIds: Array.from({ length: items }, (_v, i) => `it-${index}-${i}`),
			status: "active",
		})),
		items: Array.from({ length: items }, (unused, index) => ({
			id: `it-0-${index}`,
			title: `item-${index}`,
			taskIds: [],
			specIds: [],
			acceptance: [],
			status: "active",
		})),
		createdAt: NOW.toISOString(),
	} as unknown as PlanRecord;
}

test("plan pane header pluralises phases/items (`1 phase · 2 items`)", () => {
	const single = renderPlanPane(snapshot({ plans: [planRecord(1, 2)] }));
	assert.ok(single[0]?.includes("(1 phase · 2 items)"), `got ${JSON.stringify(single[0])}`);
	const many = renderPlanPane(snapshot({ plans: [planRecord(3, 5)] }));
	assert.ok(many[0]?.includes("(3 phases · 5 items)"), `got ${JSON.stringify(many[0])}`);
});

test("plan revision diff pluralises the task count (`0→1 task`)", () => {
	const previous = {
		...planRecord(1, 1),
		version: 1,
		items: [{ id: "it-0-0", title: "grow", taskIds: [], specIds: [], acceptance: [], status: "done" }],
	} as unknown as PlanRecord;
	const current = {
		...planRecord(1, 1),
		version: 2,
		revisionOf: { version: 1 },
		items: [{ id: "it-0-0", title: "grow", taskIds: ["t1"], specIds: [], acceptance: [], status: "done" }],
	} as unknown as PlanRecord;
	const lines = renderPlanPane(snapshot({ plans: [previous, current] }), { diff: true });
	assert.ok(
		lines.some((line) => line.includes("0→1 task")),
		`got ${JSON.stringify(lines)}`,
	);
	assert.ok(
		lines.some((line) => line.includes("v1 → v2")),
		`diff header intact; got ${JSON.stringify(lines)}`,
	);
});

test("agents pane task tally pluralises by the total (`1/1 task`, `3/3 tasks`)", () => {
	const agent = (n: number) => ({
		id: `a${n}`,
		taskId: `01_${n}`,
		status: "completed",
		role: "executor",
		agent: "executor",
		runtime: "child-process",
		usage: { input: 100, output: 50 },
		progress: { toolCount: 1 },
	});
	const one = renderAgentsPane(
		snapshot({
			agents: [agent(1)] as never,
			progress: { total: 1, completed: 1, running: 0, failed: 0, queued: 0 },
		}),
		{ workspaceId: "no-such-workspace", nowMs: NOW.getTime() },
	);
	assert.ok(
		one.some((line) => line.includes("1/1 task · 1 agent")),
		`got ${JSON.stringify(one)}`,
	);
	const three = renderAgentsPane(
		snapshot({
			agents: [agent(1), agent(2), agent(3)] as never,
			progress: { total: 3, completed: 3, running: 0, failed: 0, queued: 0 },
		}),
		{ workspaceId: "no-such-workspace", nowMs: NOW.getTime() },
	);
	assert.ok(
		three.some((line) => line.includes("3/3 tasks · 3 agents")),
		`got ${JSON.stringify(three)}`,
	);
});

test("brief-mode team summary pluralises the task tally (`1/1 task`)", () => {
	const record = {
		status: "completed",
		startedAt: new Date(NOW.getTime() - 60_000).toISOString(),
		completedAt: NOW.toISOString(),
		usage: { input: 10, output: 5 },
	} as never;
	// `briefToolResult` reads `details` off the (loosely typed) result at
	// runtime; the declared param only names `content`, hence the cast.
	const withRecords = (records: unknown[]): Parameters<typeof briefToolResult>[1] =>
		({ details: { status: "completed", agentRecords: records } }) as unknown as Parameters<typeof briefToolResult>[1];
	const one = briefToolResult("team", withRecords([record]), PLAIN_THEME);
	assert.ok(one.includes("1/1 task"), `got ${JSON.stringify(one)}`);
	assert.ok(!one.includes("1/1 tasks"), "hard-coded plural retired");
	const two = briefToolResult("team", withRecords([record, record]), PLAIN_THEME);
	assert.ok(two.includes("2/2 tasks"), `got ${JSON.stringify(two)}`);
});

// ── 6. Source guard: dead export stays deleted ─────────────────────────

test("source guard: `formatLiveDuration` stays deleted from live-duration.ts (dead export, L9)", () => {
	const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../src/ui/live-duration.ts"), "utf8");
	assert.ok(!src.includes("export function formatLiveDuration"), "the dead raw-seconds export must not reappear");
	assert.ok(src.includes("export function computeLiveDurationMs"), "the validated duration math stays");
});
