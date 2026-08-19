/**
 * T2/R4 (ADR-4) — plan-store unit tests: revision append (lineage rules),
 * atomicity of the file format, scheduler linkage single-writer semantics,
 * approval dual-write vocabulary, and the dual-read migration predicate
 * (incl. the pre-v2 protection negative AC).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	appendPlanRevision,
	deriveItemProgress,
	effectivePlanApprovalPending,
	getCurrentPlanRecord,
	linkTaskToPlanItem,
	loadPlanRecords,
	planFilePath,
	setPlanApproval,
} from "../../../../src/state/stores/plan-store.ts";
import type { PlanRecord, TeamRunManifest } from "../../../../src/state/types.ts";

const tracked: string[] = [];
function tmpDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tracked.push(dir);
	return dir;
}
afterEach(() => {
	while (tracked.length) fs.rmSync(tracked.pop() as string, { recursive: true, force: true });
});

function makeManifest(stateRoot: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "run-plan-1",
		team: "default",
		workflow: "default",
		goal: "test plan store",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: stateRoot,
		stateRoot,
		artifactsRoot: path.join(stateRoot, "artifacts"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
	};
}

function makeRecord(
	runId: string,
	version: number,
	itemIds: string[],
	opts: { dropped?: string[]; authorTaskId?: string } = {},
): PlanRecord {
	const dropped = new Set(opts.dropped ?? []);
	return {
		id: "plan-abc",
		runId,
		version,
		revisionOf: version > 1 ? { id: "plan-abc", version: version - 1 } : undefined,
		title: `test plan v${version}`,
		phases: [{ id: "ph1", title: "Phase 1", itemIds, status: "active" }],
		items: itemIds.map((id) => ({
			id,
			title: `item ${id}`,
			taskIds: [],
			specIds: [],
			acceptance: [],
			status: dropped.has(id) ? ("dropped" as const) : ("pending" as const),
		})),
		createdAt: new Date().toISOString(),
		authorTaskId: opts.authorTaskId,
	};
}

describe("plan-store: revision append + lineage", () => {
	it("first revision must be v1 without revisionOf; persisted and readable", () => {
		const dir = tmpDir("pi-crew-planstore-");
		const m = makeManifest(dir);
		const rec = makeRecord(m.runId, 1, ["i1", "i2"]);
		appendPlanRevision(m, rec);
		const loaded = loadPlanRecords(m);
		assert.equal(loaded.length, 1);
		assert.equal(loaded[0]?.id, "plan-abc");
		assert.equal(loaded[0]?.version, 1);
		assert.equal(loaded[0]?.revisionOf, undefined);
		// File lives at the ADR-4 path.
		assert.ok(fs.existsSync(path.join(dir, "plans", "plans.json")));
		assert.equal(planFilePath(m), path.join(dir, "plans", "plans.json"));
	});

	it("second revision appends with auto revisionOf and same lineage id", () => {
		const dir = tmpDir("pi-crew-planstore-");
		const m = makeManifest(dir);
		appendPlanRevision(m, makeRecord(m.runId, 1, ["i1", "i2"]));
		const rec2 = makeRecord(m.runId, 2, ["i1", "i2"], { dropped: ["i2"] });
		delete rec2.revisionOf; // auto-filled
		appendPlanRevision(m, rec2);
		const loaded = loadPlanRecords(m);
		assert.equal(loaded.length, 2);
		assert.deepEqual(loaded[1]?.revisionOf, { id: "plan-abc", version: 1 });
		assert.equal(loaded[1]?.items.find((i) => i.id === "i2")?.status, "dropped");
	});

	it("lineage violations throw: wrong version, foreign id, bad revisionOf, duplicate item ids, phantom phase refs", () => {
		const dir = tmpDir("pi-crew-planstore-");
		const m = makeManifest(dir);
		appendPlanRevision(m, makeRecord(m.runId, 1, ["i1"]));
		assert.throws(() => appendPlanRevision(m, makeRecord(m.runId, 3, ["i1"])), /version must be 2/);
		const foreign = makeRecord(m.runId, 2, ["i1"]);
		foreign.id = "plan-other";
		assert.throws(() => appendPlanRevision(m, foreign), /lineage break/);
		const badRev = makeRecord(m.runId, 2, ["i1"]);
		badRev.revisionOf = { id: "plan-abc", version: 99 };
		assert.throws(() => appendPlanRevision(m, badRev), /revisionOf must point/);
		const dup = makeRecord(m.runId, 2, ["i1", "i1"]);
		assert.throws(() => appendPlanRevision(m, dup), /duplicate item id/);
		const phantomPhase = makeRecord(m.runId, 2, ["i1"]);
		phantomPhase.phases = [{ id: "ph9", title: "x", itemIds: ["nope"], status: "pending" }];
		assert.throws(() => appendPlanRevision(m, phantomPhase), /unknown item/);
	});

	it("events: v1 → plan.created, v2 → plan.revised (with dropped count)", () => {
		const dir = tmpDir("pi-crew-planstore-");
		const m = makeManifest(dir);
		appendPlanRevision(m, makeRecord(m.runId, 1, ["i1"]));
		appendPlanRevision(m, makeRecord(m.runId, 2, ["i1", "i2"], { dropped: ["i2"] }));
		const lines = fs
			.readFileSync(m.eventsPath, "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { type: string; message?: string });
		assert.equal(lines[0]?.type, "plan.created");
		assert.equal(lines[1]?.type, "plan.revised");
		assert.match(lines[1]?.message ?? "", /1 dropped/);
	});
});

describe("plan-store: atomicity + crash-window pointer fallback", () => {
	it("file is always a complete JSON document (atomic rename — no torn writes observable)", () => {
		const dir = tmpDir("pi-crew-planstore-");
		const m = makeManifest(dir);
		for (let v = 1; v <= 5; v++) appendPlanRevision(m, makeRecord(m.runId, v, [`i${v}`]));
		const raw = fs.readFileSync(planFilePath(m), "utf-8");
		const parsed = JSON.parse(raw) as { revisions: PlanRecord[] };
		assert.equal(parsed.revisions.length, 5);
	});

	it("getCurrentPlanRecord: pointer wins; stale pointer degrades to highest version", () => {
		const dir = tmpDir("pi-crew-planstore-");
		const m = makeManifest(dir);
		appendPlanRevision(m, makeRecord(m.runId, 1, ["i1"]));
		appendPlanRevision(m, makeRecord(m.runId, 2, ["i1"]));
		m.plan = { id: "plan-abc", version: 1 };
		assert.equal(getCurrentPlanRecord(m)?.version, 1);
		// Crash window: plans.json has v2 but manifest.plan never saved.
		delete m.plan;
		assert.equal(getCurrentPlanRecord(m)?.version, 2);
		// No records at all → undefined.
		const m2 = makeManifest(tmpDir("pi-crew-planstore-"));
		assert.equal(getCurrentPlanRecord(m2), undefined);
		assert.deepEqual(loadPlanRecords(m2), []);
	});

	it("corrupt file degrades to [] (never throws)", () => {
		const dir = tmpDir("pi-crew-planstore-");
		const m = makeManifest(dir);
		fs.mkdirSync(path.join(dir, "plans"), { recursive: true });
		fs.writeFileSync(planFilePath(m), "{not json", "utf-8");
		assert.deepEqual(loadPlanRecords(m), []);
		assert.equal(getCurrentPlanRecord(m), undefined);
	});
});

describe("plan-store: scheduler linkage (single writer)", () => {
	it("linkTaskToPlanItem appends to CURRENT revision only, dedupes, refuses dropped items", () => {
		const dir = tmpDir("pi-crew-planstore-");
		const m = makeManifest(dir);
		appendPlanRevision(m, makeRecord(m.runId, 1, ["i1"]));
		assert.equal(linkTaskToPlanItem(m, "i1", "task-1"), true);
		assert.equal(linkTaskToPlanItem(m, "i1", "task-1"), false); // dedupe
		appendPlanRevision(m, makeRecord(m.runId, 2, ["i1", "i2"], { dropped: ["i2"] }));
		assert.equal(linkTaskToPlanItem(m, "i1", "task-2"), true); // links into v2 now
		assert.equal(linkTaskToPlanItem(m, "i2", "task-3"), false); // dropped → refuse
		const loaded = loadPlanRecords(m);
		assert.deepEqual(loaded[0]?.items[0]?.taskIds, ["task-1"]); // v1 untouched
		assert.deepEqual(loaded[1]?.items[0]?.taskIds, ["task-1", "task-2"]);
	});

	it("linkage writes NO events", () => {
		const dir = tmpDir("pi-crew-planstore-");
		const m = makeManifest(dir);
		appendPlanRevision(m, makeRecord(m.runId, 1, ["i1"]));
		fs.rmSync(m.eventsPath);
		linkTaskToPlanItem(m, "i1", "task-9");
		assert.ok(!fs.existsSync(m.eventsPath), "scheduler linkage must not append events (ADR-4 §9)");
	});

	it("unknown item / empty store → false, no throw", () => {
		const dir = tmpDir("pi-crew-planstore-");
		const m = makeManifest(dir);
		assert.equal(linkTaskToPlanItem(m, "ghost", "task-1"), false);
		appendPlanRevision(m, makeRecord(m.runId, 1, ["i1"]));
		assert.equal(linkTaskToPlanItem(m, "ghost", "task-1"), false);
	});
});

describe("plan-store: approval dual-write", () => {
	it("setPlanApproval stamps the current revision; stale planVersion throws", () => {
		const dir = tmpDir("pi-crew-planstore-");
		const m = makeManifest(dir);
		appendPlanRevision(m, makeRecord(m.runId, 1, ["i1"]));
		appendPlanRevision(m, makeRecord(m.runId, 2, ["i1"]));
		assert.throws(() => setPlanApproval(m, { status: "approved", planVersion: 1 }), /current is v2/);
		const rec = setPlanApproval(m, { status: "rejected", by: "sess-1", planVersion: 2 });
		assert.equal(rec?.version, 2);
		assert.deepEqual(loadPlanRecords(m)[1]?.approval, { status: "rejected", by: "sess-1", at: rec?.approval?.at, planVersion: 2 });
		const lines = fs
			.readFileSync(m.eventsPath, "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { type: string });
		assert.deepEqual(
			lines.map((l) => l.type),
			["plan.created", "plan.revised", "plan.rejected"],
		);
	});
});

describe("plan-store: dual-read migration predicate (ADR-4 §2)", () => {
	it("record-first: pending record approval wins over manifest; decided record overrides pending manifest", () => {
		const dir = tmpDir("pi-crew-planstore-");
		const m = makeManifest(dir);
		appendPlanRevision(m, makeRecord(m.runId, 1, ["i1"]));
		setPlanApproval(m, { status: "pending", planVersion: 1 });
		assert.equal(effectivePlanApprovalPending(m), true); // record pending, manifest absent
		m.planApproval = { required: true, status: "pending", requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
		assert.equal(effectivePlanApprovalPending(m), true); // both pending
		setPlanApproval(m, { status: "approved", planVersion: 1 });
		assert.equal(effectivePlanApprovalPending(m), false); // record decided → false even though manifest pending
	});

	it("NEGATIVE AC (pre-v2 protection): manifest-only pending stays pending after upgrade — no plans.json at all", () => {
		const dir = tmpDir("pi-crew-planstore-");
		const m = makeManifest(dir);
		m.status = "blocked";
		m.planApproval = { required: true, status: "pending", requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
		assert.equal(effectivePlanApprovalPending(m), true, "pre-v2 run must keep stale-reconciler protection");
	});

	it("record without approval state falls back to manifest gate", () => {
		const dir = tmpDir("pi-crew-planstore-");
		const m = makeManifest(dir);
		appendPlanRevision(m, makeRecord(m.runId, 1, ["i1"]));
		assert.equal(effectivePlanApprovalPending(m), false); // no approval anywhere
		m.planApproval = { required: true, status: "pending", requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
		assert.equal(effectivePlanApprovalPending(m), true); // fallback engages
	});
});

describe("plan-store: deriveItemProgress (derived, never stored)", () => {
	it("counts linked task statuses per item", () => {
		const dir = tmpDir("pi-crew-planstore-");
		const m = makeManifest(dir);
		appendPlanRevision(m, makeRecord(m.runId, 1, ["i1", "i2"]));
		linkTaskToPlanItem(m, "i1", "t1");
		linkTaskToPlanItem(m, "i1", "t2");
		linkTaskToPlanItem(m, "i1", "t3");
		linkTaskToPlanItem(m, "i2", "t4");
		const tasks = [
			{ id: "t1", status: "completed" },
			{ id: "t2", status: "failed" },
			{ id: "t3", status: "queued" },
			{ id: "t4", status: "waiting" },
		] as never;
		const progress = deriveItemProgress(getCurrentPlanRecord(m) as PlanRecord, tasks);
		assert.deepEqual(progress.get("i1"), { itemId: "i1", total: 3, done: 1, failed: 1, running: 0, pending: 1 });
		assert.deepEqual(progress.get("i2"), { itemId: "i2", total: 1, done: 0, failed: 0, running: 1, pending: 0 });
	});
});
