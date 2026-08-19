/**
 * T2/R4 (ADR-4 §2) — reader-migration tests: plan-record-first with manifest
 * fallback across the five reader families, including the migration NEGATIVE AC
 * (pre-v2 run with pending planApproval stays protected) and the E2E api
 * approve dual-write through handleTeamTool.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { allAgents, discoverAgents } from "../../../../src/agents/discover-agents.ts";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { isPlanApprovalDenied, isPlanApprovalPendingEffective } from "../../../../src/runtime/plan-approval.ts";
import { isIntentionalWait, reconcileStaleRun } from "../../../../src/runtime/stale-reconciler.ts";
import { executeTeamRun } from "../../../../src/runtime/team-runner.ts";
import { appendPlanRevision, getCurrentPlanRecord, loadPlanRecords, setPlanApproval } from "../../../../src/state/stores/plan-store.ts";
import { createRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { PlanRecord, TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import { allTeams, discoverTeams } from "../../../../src/teams/discover-teams.ts";
import { allWorkflows, discoverWorkflows } from "../../../../src/workflows/discover-workflows.ts";

const NOW = Date.parse("2026-08-19T12:00:00.000Z");

function makeManifest(stateRoot: string, over: Partial<TeamRunManifest> = {}): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "run-mig-1",
		team: "implementation",
		workflow: "implementation",
		goal: "migration test",
		status: "blocked",
		workspaceMode: "single",
		createdAt: new Date(NOW - 60_000).toISOString(),
		updatedAt: new Date(NOW - 60_000).toISOString(),
		cwd: stateRoot,
		stateRoot,
		artifactsRoot: path.join(stateRoot, "artifacts"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
		...over,
	};
}

function pendingManifestApproval() {
	return {
		required: true,
		status: "pending" as const,
		requestedAt: new Date(NOW - 60_000).toISOString(),
		updatedAt: new Date(NOW - 60_000).toISOString(),
	};
}

function makeRecord(runId: string, status: "pending" | "approved" | "rejected"): PlanRecord {
	return {
		id: "plan-mig",
		runId,
		version: 1,
		title: "migration record",
		phases: [{ id: "ph1", title: "P1", itemIds: ["i1"], status: "pending" }],
		items: [{ id: "i1", title: "item", taskIds: [], specIds: [], acceptance: [], status: "pending" }],
		approval: { status, at: new Date(NOW - 30_000).toISOString(), planVersion: 1 },
		createdAt: new Date(NOW - 60_000).toISOString(),
	};
}

const idleTask = (runId: string): TeamTaskState =>
	({
		id: "task-1",
		runId,
		role: "executor",
		agent: "executor",
		title: "t",
		status: "queued",
		dependsOn: [],
		cwd: "/tmp",
	}) as TeamTaskState;

test("NEGATIVE AC: pre-v2 run (manifest-only, no plans.json) keeps every protection after upgrade", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mig-pre-"));
	try {
		const m = makeManifest(dir, { planApproval: pendingManifestApproval() });
		// No plans.json anywhere — exactly the pre-v2 shape.
		assert.equal(fs.existsSync(path.join(dir, "plans", "plans.json")), false);
		assert.equal(isPlanApprovalPendingEffective(m), true);
		assert.equal(isIntentionalWait(m, NOW), true);
		assert.equal(isPlanApprovalDenied(m), false);
		const result = reconcileStaleRun(m, [idleTask(m.runId)], NOW);
		assert.equal(result.verdict, "blocked_awaiting_approval");
		assert.equal(result.repaired, false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("record-first: plans.json approval pending (manifest field absent) is authoritative", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mig-rec-"));
	try {
		const m = makeManifest(dir);
		appendPlanRevision(m, makeRecord(m.runId, "pending"));
		m.plan = { id: "plan-mig", version: 1 };
		assert.equal(isPlanApprovalPendingEffective(m), true);
		assert.equal(isIntentionalWait(m, NOW), true);
		assert.equal(reconcileStaleRun(m, [idleTask(m.runId)], NOW).verdict, "blocked_awaiting_approval");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("vocabulary mapping: record 'rejected' denies even while manifest still says pending (dual-write gap)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mig-vocab-"));
	try {
		const m = makeManifest(dir, { planApproval: pendingManifestApproval() });
		appendPlanRevision(m, makeRecord(m.runId, "rejected"));
		m.plan = { id: "plan-mig", version: 1 };
		assert.equal(isPlanApprovalPendingEffective(m), false, "record decided → not pending");
		assert.equal(isPlanApprovalDenied(m), true, "record rejected → deny");
		// Manifest-only cancelled also denies (pre-v2 path).
		const m2 = makeManifest(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mig-vocab2-")), {
			planApproval: { ...pendingManifestApproval(), status: "cancelled" },
		});
		assert.equal(isPlanApprovalDenied(m2), true);
		fs.rmSync(m2.cwd, { recursive: true, force: true });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("E2E: adaptive approval gate dual-writes the record; api approve flips BOTH sides", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mig-e2e-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const previousRole = process.env.PI_CREW_ROLE;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	try {
		const team = allTeams(discoverTeams(cwd)).find((item) => item.name === "implementation")!;
		const workflow = allWorkflows(discoverWorkflows(cwd)).find((item) => item.name === "implementation")!;
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "dual-write gate" });
		const planPath = path.join(cwd, "assess-plan.txt");
		fs.writeFileSync(
			planPath,
			`ADAPTIVE_PLAN_JSON_START\n${JSON.stringify({ phases: [{ name: "build", tasks: [{ role: "executor", task: "Implement approved change" }] }] })}\nADAPTIVE_PLAN_JSON_END`,
			"utf-8",
		);
		const assessed = tasks.map((task) => ({
			...task,
			status: "completed" as const,
			finishedAt: new Date().toISOString(),
			resultArtifact: {
				kind: "result" as const,
				path: planPath,
				createdAt: new Date().toISOString(),
				producer: task.id,
				retention: "run" as const,
			},
		}));
		saveRunTasks(manifest, assessed);

		const blocked = await executeTeamRun({
			manifest,
			tasks: assessed,
			team,
			workflow,
			agents: allAgents(discoverAgents(cwd)),
			executeWorkers: true,
			workspaceId: cwd,
			runtimeConfig: { requirePlanApproval: true },
			runtime: {
				kind: "child-process",
				requestedMode: "child-process",
				available: true,
				steer: false,
				resume: false,
				liveToolActivity: false,
				transcript: true,
				safety: "trusted",
			},
		});
		assert.equal(blocked.manifest.status, "blocked");
		assert.equal(blocked.manifest.planApproval?.status, "pending");

		// ADR-4 §6 producer 2 + §8: the adaptive injection persisted a PlanRecord
		// and the gate request stamped approval pending on it + manifest pointer.
		const recordBefore = getCurrentPlanRecord(blocked.manifest);
		assert.ok(recordBefore, "adaptive run must have a PlanRecord after injection");
		assert.equal(recordBefore.approval?.status, "pending");
		assert.deepEqual(blocked.manifest.plan, { id: recordBefore.id, version: 1 });
		// Adaptive task carries the item link for scheduler linkage (step 5).
		const adaptiveTask = blocked.tasks.find((t) => t.planItem);
		assert.ok(adaptiveTask, "injected adaptive task must carry planItem");

		const approval = await handleTeamTool({ action: "api", runId: manifest.runId, config: { operation: "approve-plan" } }, { cwd });
		assert.equal(approval.isError, false);
		const records = loadPlanRecords(blocked.manifest);
		assert.equal(records[0]?.approval?.status, "approved", "api approve dual-writes the record side");
		const lateCancel = await handleTeamTool({ action: "api", runId: manifest.runId, config: { operation: "cancel-plan" } }, { cwd });
		assert.equal(lateCancel.isError, true, "no pending request after approval");
	} finally {
		if (previousExecute === undefined) delete process.env.PI_TEAMS_EXECUTE_WORKERS;
		else process.env.PI_TEAMS_EXECUTE_WORKERS = previousExecute;
		if (previousMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock;
		if (previousRole === undefined) delete process.env.PI_CREW_ROLE;
		else process.env.PI_CREW_ROLE = previousRole;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("setPlanApproval stale-version guard protects against approving a superseded revision", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mig-stale-"));
	try {
		const m = makeManifest(dir, { status: "running" });
		appendPlanRevision(m, makeRecord(m.runId, "pending"));
		const v2 = makeRecord(m.runId, "pending");
		v2.version = 2;
		appendPlanRevision(m, v2);
		assert.throws(() => setPlanApproval(m, { status: "approved", planVersion: 1 }), /current is v2/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
