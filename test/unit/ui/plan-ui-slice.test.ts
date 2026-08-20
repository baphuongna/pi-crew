/**
 * WP-7 (R7) Plan-UI slice tests: the plans snapshot slice + Plan pane.
 *
 * ACs (plan §WP-7): signature changes on plan write (revision append /
 * approval flip / item linkage); flag-off → field absent, zero extra I/O;
 * pane-7 tree from PlanRecord + tasks with approval hint + depth badge; X
 * multi-revision diff; widget crowding degrade preserved (>3 agents →
 * summary line, no data loss) with plans present.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { CrewAgentRecord } from "../../../src/runtime/crew-agent-runtime.ts";
import { appendPlanRevision } from "../../../src/state/stores/plan-store.ts";
import { createRunManifest, saveRunManifest } from "../../../src/state/stores/state-store.ts";
import type { PlanRecord, TeamRunManifest } from "../../../src/state/types.ts";
import { planRevisionDiff, renderPlanPane } from "../../../src/ui/dashboard-panes/plan-pane.ts";
import { buildStepsPayload } from "../../../src/ui/powerbar-publisher.ts";
import { isPlanUiEnabled } from "../../../src/ui/run-snapshot-cache.ts";
import type { RunUiSnapshot } from "../../../src/ui/snapshot-types.ts";
import { buildWidgetLines } from "../../../src/ui/widget/widget-renderer.ts";

const REAL_PLAN_UI = process.env.PI_CREW_PLAN_UI;

function makeCwd(): TeamRunManifest {
	let cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-planui-"));
	try {
		cwd = fs.realpathSync(cwd);
	} catch {
		/* keep */
	}
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const created = createRunManifest({
		cwd,
		team: {
			name: "default",
			description: "",
			roles: [{ name: "executor", agent: "executor" }],
			source: "test",
			filePath: "builtin",
		} as never,
		workflow: {
			name: "default",
			description: "",
			steps: [{ id: "build", role: "executor" }],
			source: "test",
			filePath: "builtin",
		} as never,
		goal: "plan ui",
	});
	saveRunManifest({ ...created.manifest, status: "running" });
	return created.manifest;
}

function planRecord(manifest: TeamRunManifest, version: number, items: PlanRecord["items"]): PlanRecord {
	return {
		id: `plan-${manifest.runId}`,
		runId: manifest.runId,
		version,
		title: "Ship it",
		phases: [{ id: "ph-1", title: "implement", itemIds: items.map((i) => i.id), status: "active" }],
		items,
		createdAt: new Date().toISOString(),
	};
}

function snapshotWith(manifest: TeamRunManifest, plans: PlanRecord[], tasks: never[]): RunUiSnapshot {
	return {
		runId: manifest.runId,
		cwd: manifest.cwd,
		fetchedAt: Date.now(),
		signature: "test",
		manifest,
		tasks,
		agents: [],
		progress: { total: tasks.length, completed: 0, failed: 0, running: 0, queued: tasks.length },
		usage: { inputTokens: 0, outputTokens: 0, totalCost: 0 },
		mailbox: { inbox: [], outbox: [], waiting: [], messageUnread: 0 },
		recentEvents: [],
		recentOutputLines: [],
		plans,
	} as unknown as RunUiSnapshot;
}

test("flag gate: isPlanUiEnabled reads PI_CREW_PLAN_UI=1 exactly", () => {
	process.env.PI_CREW_PLAN_UI = "1";
	assert.equal(isPlanUiEnabled(), true);
	process.env.PI_CREW_PLAN_UI = "0";
	assert.equal(isPlanUiEnabled(), false);
	delete process.env.PI_CREW_PLAN_UI;
	assert.equal(isPlanUiEnabled(), false);
});

test("pane: no plans slice (flag-off / plan-less run) → single honest hint line, no throw", () => {
	const manifest = makeCwd();
	const snap = snapshotWith(manifest, [], []);
	const lines = renderPlanPane(snap);
	assert.equal(lines.length, 1);
	assert.match(lines[0] ?? "", /no plan records/);
});

test("pane: tree renders phases → items → tasks with progress, approval hint, depth badge", () => {
	const manifest = makeCwd();
	const record = planRecord(manifest, 1, [
		{ id: "it-1", title: "Implement login", taskIds: ["t1", "t2"], specIds: [], acceptance: [], status: "active" },
		{ id: "it-2", title: "Write tests", taskIds: ["t3"], specIds: [], acceptance: [], status: "pending" },
	]);
	const tasks = [
		{
			id: "t1",
			runId: manifest.runId,
			role: "executor",
			agent: "executor",
			title: "x",
			status: "completed",
			dependsOn: [],
			cwd: manifest.cwd,
		},
		{
			id: "t2",
			runId: manifest.runId,
			role: "executor",
			agent: "executor",
			title: "x",
			status: "running",
			dependsOn: [],
			cwd: manifest.cwd,
			depth: 2,
		},
		{
			id: "t3",
			runId: manifest.runId,
			role: "executor",
			agent: "executor",
			title: "x",
			status: "queued",
			dependsOn: [],
			cwd: manifest.cwd,
		},
	] as never[];
	const lines = renderPlanPane(snapshotWith(manifest, [record], tasks)).join("\n");
	assert.match(lines, /implement/);
	assert.match(lines, /Implement login 1\/2 ▸1/, "item progress derived from linked tasks");
	assert.match(lines, /t2 d2 executor \[running\]/, "grandchild depth badge (T3/R5)");
	assert.match(lines, /Write tests 0\/1/);
	// Approval pending → hint line with the same A/n actions.
	const pendingManifest = {
		...manifest,
		planApproval: {
			required: true,
			status: "pending" as const,
			requestedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		},
	};
	const pendingLines = renderPlanPane(snapshotWith(pendingManifest, [record], tasks)).join("\n");
	assert.match(pendingLines, /plan approval pending — A approve · n deny/);
});

test("pane: unphased items still visible; dropped items tagged", () => {
	const manifest = makeCwd();
	const record = planRecord(manifest, 1, [
		{ id: "it-1", title: "Orphan item", taskIds: [], specIds: [], acceptance: [], status: "dropped" },
	]);
	record.phases = []; // no phases — everything unphased
	const lines = renderPlanPane(snapshotWith(manifest, [record], [])).join("\n");
	assert.match(lines, /\(unphased\)/);
	assert.match(lines, /Orphan item .*✗ dropped/);
});

test("pane diff (X): multi-revision diff — added/changed/dropped items vs revisionOf", () => {
	const manifest = makeCwd();
	const v1 = planRecord(manifest, 1, [
		{ id: "keep", title: "Kept", taskIds: [], specIds: [], acceptance: [], status: "done" },
		{ id: "gone", title: "Gone", taskIds: [], specIds: [], acceptance: [], status: "pending" },
	]);
	const v2: PlanRecord = {
		...planRecord(manifest, 2, [
			{ id: "keep", title: "Kept", taskIds: ["t9"], specIds: [], acceptance: [], status: "done" },
			{ id: "new", title: "Added", taskIds: [], specIds: [], acceptance: [], status: "active" },
		]),
		revisionOf: { id: v1.id, version: 1 },
	};
	const lines = planRevisionDiff(snapshotWith(manifest, [v1, v2], [])).join("\n");
	assert.match(lines, /v1 → v2/);
	assert.match(lines, /\+ new Added/);
	assert.match(lines, /~ keep Kept \[done→done · 0→1 tasks\]/);
	assert.match(lines, /- gone Gone \(dropped in v2\)/);
	// No prior revision → honest single line.
	const lone = planRecord(manifest, 1, []);
	assert.match(planRevisionDiff(snapshotWith(manifest, [lone], [])).join("\n"), /no prior revision/);
});

test("store-level: appendPlanRevision changes the plans payload a pane/slice would see (signature input)", () => {
	const manifest = makeCwd();
	const v1 = planRecord(manifest, 1, []);
	appendPlanRevision(manifest, v1);
	const file = path.join(manifest.stateRoot, "plans", "plans.json");
	assert.ok(fs.existsSync(file), "plans.json written under the run state root");
	const after = JSON.parse(fs.readFileSync(file, "utf8")) as { revisions: PlanRecord[] };
	assert.equal(after.revisions.length, 1);
	assert.equal(after.revisions[0]?.version, 1);
	// Revision append (the slice's hash input) — version linkage present.
	const v2 = { ...planRecord(manifest, 2, []), revisionOf: { id: v1.id, version: 1 } };
	appendPlanRevision(manifest, v2);
	const after2 = JSON.parse(fs.readFileSync(file, "utf8")) as { revisions: PlanRecord[] };
	assert.equal(after2.revisions.length, 2);
});

test("powerbar steps: plan phases override workflow steps when plans exist; workflow fallback intact", () => {
	const manifest = makeCwd();
	const record = planRecord(manifest, 3, [{ id: "a", title: "Item A", taskIds: [], specIds: [], acceptance: [], status: "done" }]);
	record.phases = [
		{ id: "p1", title: "research", itemIds: ["a"], status: "done" },
		{ id: "p2", title: "implement", itemIds: [], status: "pending" },
	];
	const withPlan = buildStepsPayload([{ run: manifest, agents: [], tasks: [], snapshot: snapshotWith(manifest, [record], []) }], []);
	assert.match(withPlan.text ?? "", /P3 ✓research › ○implement/);
	// No plans → workflow-steps path unchanged (fallback).
	const noPlan = buildStepsPayload([{ run: manifest, agents: [], tasks: [], snapshot: snapshotWith(manifest, [], []) }], []);
	assert.ok(noPlan.id === "pi-crew-steps");
});

test("widget degrade (negative AC): >3 agents → summary line, no data loss — preserved WITH plans present", () => {
	const manifest = makeCwd();
	const record = planRecord(manifest, 1, [{ id: "a", title: "Item", taskIds: [], specIds: [], acceptance: [], status: "active" }]);
	const snap = snapshotWith(manifest, [record], []);
	const mk = (i: number, status: string): CrewAgentRecord =>
		({
			id: `a${i}`,
			runId: manifest.runId,
			taskId: `t${i}`,
			agent: "executor",
			role: "executor",
			status,
			startedAt: new Date().toISOString(),
		}) as unknown as CrewAgentRecord;
	const agents = [mk(1, "running"), mk(2, "running"), mk(3, "running"), mk(4, "running"), mk(5, "queued")];
	const lines = buildWidgetLines(manifest.cwd, 0, 8, [{ run: manifest, agents, snapshot: snap }], 0, 120);
	const agentRows = lines.filter((l) => /a[0-9]|executor/.test(l));
	// Crowding: at most MAX_AGENTS_DISPLAY(3) worker rows render…
	assert.ok(agentRows.length <= 4, `crowded widget keeps ≤3 agent rows + header (got ${agentRows.length})`);
	// …but the data is NOT lost: counts surface on the run line.
	assert.match(lines.join("\n"), /0\/5 agents/, "all five agents counted in the summary");
});
