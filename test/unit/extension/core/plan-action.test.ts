/**
 * T2/R4 (ADR-4 §7) — `team action='plans'` handler tests: get (default/pinned
 * rev, derived progress), list, diff, approve/reject delegation (dual-write),
 * pre-v2 graceful fallback, auth (missing runId, unknown run).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { handlePlans } from "../../../../src/extension/team-tool/plans.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import { appendPlanRevision, setPlanApproval } from "../../../../src/state/stores/plan-store.ts";
import { saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { PlanRecord, TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

const ctx = { cwd: process.cwd() } as TeamContext;

function buildRun(): { dir: string; manifest: TeamRunManifest; tasks: TeamTaskState[] } {
	const dir = createTrackedTempDir("pi-crew-plansact-");
	const stateRoot = path.join(dir, ".crew", "state", "runs", "run-pa");
	fs.mkdirSync(stateRoot, { recursive: true });
	const manifest: TeamRunManifest = {
		schemaVersion: 1,
		runId: "run-pa",
		team: "default",
		workflow: "default",
		goal: "plans action test",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: dir,
		stateRoot,
		artifactsRoot: path.join(dir, ".crew", "artifacts", "run-pa"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
	};
	saveRunManifest(manifest);
	const tasks: TeamTaskState[] = [
		{
			id: "t1",
			runId: manifest.runId,
			role: "executor",
			agent: "executor",
			title: "t1",
			status: "completed",
			dependsOn: [],
			cwd: dir,
			planItem: "i1",
		},
		{
			id: "t2",
			runId: manifest.runId,
			role: "executor",
			agent: "executor",
			title: "t2",
			status: "running",
			dependsOn: [],
			cwd: dir,
			planItem: "i1",
		},
	] as TeamTaskState[];
	saveRunTasks(manifest, tasks);
	return { dir, manifest, tasks };
}

function makeRecord(runId: string, version: number, items: Array<{ id: string; dropped?: boolean; title?: string }>): PlanRecord {
	const dropped = new Set(items.filter((i) => i.dropped).map((i) => i.id));
	return {
		id: "plan-pa",
		runId,
		version,
		revisionOf: version > 1 ? { id: "plan-pa", version: version - 1 } : undefined,
		title: `pa v${version}`,
		phases: [{ id: "ph1", title: "P1", itemIds: items.map((i) => i.id), status: "active" }],
		items: items.map((i) => ({
			id: i.id,
			title: i.title ?? i.id,
			taskIds: [],
			specIds: [],
			acceptance: [],
			status: dropped.has(i.id) ? ("dropped" as const) : ("pending" as const),
		})),
		createdAt: new Date().toISOString(),
	};
}

const ok = (r: { isError?: boolean }) => r.isError !== true;

describe("plans action: auth + resolution", () => {
	it("missing runId → error; unknown run → error with hint", async () => {
		assert.equal((await handlePlans({ action: "plans" }, ctx)).isError, true);
		assert.match(textFromToolResult(await handlePlans({ action: "plans", runId: "ghost" }, ctx)), /not found/);
	});
});

describe("plans action: get / list / diff", () => {
	it("get default renders current revision with derived progress", async () => {
		const { dir, manifest, tasks } = buildRun();
		appendPlanRevision(manifest, makeRecord(manifest.runId, 1, [{ id: "i1" }, { id: "i2" }]));
		manifest.plan = { id: "plan-pa", version: 1 };
		saveRunManifest(manifest);
		// Simulate scheduler linkage for i1 (t1 done, t2 running).
		const rec = makeRecord(manifest.runId, 1, [{ id: "i1" }, { id: "i2" }]);
		// link via store API instead of hand-editing:
		const { linkTaskToPlanItem } = await import("../../../../src/state/stores/plan-store.ts");
		linkTaskToPlanItem(manifest, "i1", "t1");
		linkTaskToPlanItem(manifest, "i1", "t2");
		const r = await handlePlans({ action: "plans", runId: manifest.runId }, { cwd: dir } as TeamContext);
		assert.ok(ok(r));
		const content = textFromToolResult(r);
		assert.match(content, /v1/);
		assert.match(content, /1\/2 done.*1 running/s);
		assert.match(content, /tasks: t1, t2/);
		void tasks;
	});

	it("get --rev 2 pins the revision; unknown rev → error listing versions", async () => {
		const { dir, manifest } = buildRun();
		appendPlanRevision(manifest, makeRecord(manifest.runId, 1, [{ id: "i1" }]));
		appendPlanRevision(manifest, makeRecord(manifest.runId, 2, [{ id: "i1" }, { id: "i2", dropped: true }]));
		const r = await handlePlans({ action: "plans", runId: manifest.runId, rev: 2 }, { cwd: dir } as TeamContext);
		assert.ok(ok(r));
		assert.match(textFromToolResult(r), /pa v2/);
		const bad = await handlePlans({ action: "plans", runId: manifest.runId, rev: 9 }, { cwd: dir } as TeamContext);
		assert.equal(bad.isError, true);
		assert.match(textFromToolResult(bad), /v1, v2/);
	});

	it("list shows both revisions; diff v1→v2 reports the drop", async () => {
		const { dir, manifest } = buildRun();
		appendPlanRevision(manifest, makeRecord(manifest.runId, 1, [{ id: "i1" }, { id: "i2" }]));
		appendPlanRevision(
			manifest,
			makeRecord(manifest.runId, 2, [{ id: "i1" }, { id: "i2", dropped: true }, { id: "i3", title: "new" }]),
		);
		const list = await handlePlans({ action: "plans", runId: manifest.runId, subAction: "list" }, { cwd: dir } as TeamContext);
		assert.ok(ok(list));
		assert.match(textFromToolResult(list), /v1.*v2/s);
		const diff = await handlePlans({ action: "plans", runId: manifest.runId, subAction: "diff", a: 1, b: 2 }, {
			cwd: dir,
		} as TeamContext);
		assert.ok(ok(diff));
		const content = textFromToolResult(diff);
		assert.match(content, /added:.*i3/);
		assert.match(content, /dropped:.*i2/);
		const missing = await handlePlans({ action: "plans", runId: manifest.runId, subAction: "diff" }, { cwd: dir } as TeamContext);
		assert.equal(missing.isError, true);
	});

	it("pre-v2 run without plans.json degrades gracefully (fallback notice)", async () => {
		const { dir, manifest } = buildRun();
		const r = await handlePlans({ action: "plans", runId: manifest.runId }, { cwd: dir } as TeamContext);
		assert.ok(ok(r));
		assert.match(textFromToolResult(r), /no plan record/);
	});
});

describe("plans action: approve/reject delegation", () => {
	it("reject delegates to api cancel-plan: record side becomes rejected (vocabulary mapping)", async () => {
		const { dir, manifest } = buildRun();
		appendPlanRevision(manifest, makeRecord(manifest.runId, 1, [{ id: "i1" }]));
		setPlanApproval(manifest, { status: "pending", planVersion: 1 });
		manifest.planApproval = {
			required: true,
			status: "pending",
			requestedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		manifest.status = "blocked";
		manifest.plan = { id: "plan-pa", version: 1 };
		saveRunManifest(manifest);
		const r = await handlePlans({ action: "plans", runId: manifest.runId, subAction: "reject" }, { cwd: dir } as TeamContext);
		assert.ok(ok(r), `reject must succeed: ${textFromToolResult(r)}`);
		const { loadPlanRecords } = await import("../../../../src/state/stores/plan-store.ts");
		const reloaded = await import("../../../../src/state/stores/state-store.ts").then((m) =>
			m.loadRunManifestById(dir, manifest.runId),
		);
		assert.ok(reloaded);
		assert.equal(reloaded.manifest.planApproval?.status, "cancelled", "manifest side keeps its vocabulary");
		const records = loadPlanRecords(reloaded.manifest);
		assert.equal(records[0]?.approval?.status, "rejected", "record side uses 'rejected'");
	});
});
