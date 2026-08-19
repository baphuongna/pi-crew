/**
 * T2/R4 (ADR-4 §4/§3) — re-plan sweep (dropped-item soft-cancel) and
 * scheduler linkage at dispatch (E2E through executeTeamRun with mock workers).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { allAgents, discoverAgents } from "../../../../src/agents/discover-agents.ts";
import { sweepDroppedPlanItems } from "../../../../src/runtime/plan-replan.ts";
import { executeTeamRun } from "../../../../src/runtime/team-runner.ts";
import { appendPlanRevision, getCurrentPlanRecord, loadPlanRecords } from "../../../../src/state/stores/plan-store.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { PlanRecord, TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import { allTeams, discoverTeams } from "../../../../src/teams/discover-teams.ts";
import { allWorkflows, discoverWorkflows } from "../../../../src/workflows/discover-workflows.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

function makeRecord(runId: string, version: number, items: Array<{ id: string; dropped?: boolean }>): PlanRecord {
	const dropped = new Set(items.filter((i) => i.dropped).map((i) => i.id));
	return {
		id: "plan-rp",
		runId,
		version,
		revisionOf: version > 1 ? { id: "plan-rp", version: version - 1 } : undefined,
		title: `replan test v${version}`,
		phases: [{ id: "ph1", title: "P1", itemIds: items.map((i) => i.id), status: "active" }],
		items: items.map((i) => ({
			id: i.id,
			title: i.id,
			taskIds: [],
			specIds: [],
			acceptance: [],
			status: dropped.has(i.id) ? ("dropped" as const) : ("active" as const),
		})),
		createdAt: new Date().toISOString(),
	};
}

function buildRun(dir: string): { manifest: TeamRunManifest; tasks: TeamTaskState[] } {
	const stateRoot = path.join(dir, ".crew", "state", "runs", "run-rp");
	fs.mkdirSync(stateRoot, { recursive: true });
	const manifest: TeamRunManifest = {
		schemaVersion: 1,
		runId: "run-rp",
		team: "default",
		workflow: "default",
		goal: "replan sweep",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: dir,
		stateRoot,
		// Canonical layout enforced by validateRunManifestPaths: artifacts live
		// under <root>/.crew/artifacts/<runId>, NOT inside stateRoot.
		artifactsRoot: path.join(dir, ".crew", "artifacts", "run-rp"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
	};
	saveRunManifest(manifest);
	return { manifest, tasks: [] };
}

const mkTask = (manifest: TeamRunManifest, id: string, planItem: string, status: TeamTaskState["status"]): TeamTaskState =>
	({
		id,
		runId: manifest.runId,
		role: "executor",
		agent: "executor",
		title: id,
		status,
		dependsOn: [],
		cwd: manifest.cwd,
		planItem,
	}) as TeamTaskState;

test("sweepDroppedPlanItems: queued cancelled, in-flight advised once, untouched items survive", () => {
	const dir = createTrackedTempDir("pi-crew-replan-");
	{
		const { manifest } = buildRun(dir);
		appendPlanRevision(manifest, makeRecord(manifest.runId, 1, [{ id: "keep" }, { id: "drop" }]));
		// Simulate the scheduler's earlier linkage + an in-flight task on "drop".
		const tasks = [
			mkTask(manifest, "t-queued-drop", "drop", "queued"),
			mkTask(manifest, "t-running-drop", "drop", "running"),
			mkTask(manifest, "t-running-keep", "keep", "running"),
		];
		saveRunTasks(manifest, tasks);
		manifest.plan = { id: "plan-rp", version: 1 };
		// Re-plan: v2 drops "drop".
		appendPlanRevision(manifest, makeRecord(manifest.runId, 2, [{ id: "keep" }, { id: "drop", dropped: true }]));

		const snap = loadRunManifestById(dir, manifest.runId);
		assert.ok(snap);
		const sweep1 = sweepDroppedPlanItems(snap.manifest, snap.tasks);
		assert.ok(sweep1);
		assert.deepEqual(sweep1.cancelledTaskIds, ["t-queued-drop"]);
		assert.deepEqual(sweep1.advisedTaskIds, ["t-running-drop"]);

		const byId = new Map(sweep1.tasks.map((t) => [t.id, t]));
		assert.equal(byId.get("t-queued-drop")?.status, "cancelled");
		assert.match(byId.get("t-queued-drop")?.error ?? "", /dropped by re-plan/);
		assert.equal(byId.get("t-running-drop")?.status, "running"); // soft — advisory, not a status flip
		assert.ok(byId.get("t-running-drop")?.replanDroppedAt);
		assert.equal(byId.get("t-running-keep")?.replanDroppedAt, undefined);

		// Advisory landed in the steering JSONL (same contract as team steer).
		const steering = fs
			.readFileSync(path.join(manifest.artifactsRoot, "steering", "t-running-drop.jsonl"), "utf-8")
			.trim()
			.split("\n");
		const entry = JSON.parse(steering[steering.length - 1] as string) as { type: string; message: string };
		assert.equal(entry.type, "steer");
		assert.match(entry.message, /re-plan/);

		// Events: one plan.item.dropped per affected task.
		const events = fs
			.readFileSync(manifest.eventsPath, "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { type: string });
		assert.equal(events.filter((e) => e.type === "plan.item.dropped").length, 2);

		// Second tick: exactly-once — no duplicate advisory/event.
		const snap2 = loadRunManifestById(dir, manifest.runId);
		const sweep2 = snap2 ? sweepDroppedPlanItems(snap2.manifest, snap2.tasks) : undefined;
		const events2 = fs
			.readFileSync(manifest.eventsPath, "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { type: string });
		assert.equal(events2.filter((e) => e.type === "plan.item.dropped").length, 2);
		if (sweep2) {
			assert.deepEqual(sweep2.advisedTaskIds, []);
			assert.deepEqual(sweep2.cancelledTaskIds, []);
		}
	}
});

test("sweepDroppedPlanItems: no plan-linked tasks / no record / no drops → undefined (cheap exits)", () => {
	const dir = createTrackedTempDir("pi-crew-replan-noop-");
	{
		const { manifest } = buildRun(dir);
		saveRunTasks(manifest, [mkTask(manifest, "t-1", "i1", "queued")]);
		// No plans.json → undefined.
		const snap = loadRunManifestById(dir, manifest.runId);
		assert.ok(snap);
		assert.equal(sweepDroppedPlanItems(snap.manifest, snap.tasks), undefined);
		// Record with no drops → undefined.
		appendPlanRevision(manifest, makeRecord(manifest.runId, 1, [{ id: "i1" }]));
		manifest.plan = { id: "plan-rp", version: 1 };
		const snap2 = loadRunManifestById(dir, manifest.runId);
		assert.ok(snap2);
		assert.equal(sweepDroppedPlanItems(snap2.manifest, snap2.tasks), undefined);
	}
});

test("E2E linkage: adaptive dispatch writes taskIds into the CURRENT revision (scheduler single writer)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-replan-e2e-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	try {
		const team = allTeams(discoverTeams(cwd)).find((item) => item.name === "implementation")!;
		const workflow = allWorkflows(discoverWorkflows(cwd)).find((item) => item.name === "implementation")!;
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "linkage e2e" });
		const planPath = path.join(cwd, "assess-plan.txt");
		fs.writeFileSync(
			planPath,
			`ADAPTIVE_PLAN_JSON_START\n${JSON.stringify({ phases: [{ name: "build", tasks: [{ role: "executor", task: "Implement linked change" }] }] })}\nADAPTIVE_PLAN_JSON_END`,
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

		const result = await executeTeamRun({
			manifest,
			tasks: assessed,
			team,
			workflow,
			agents: allAgents(discoverAgents(cwd)),
			executeWorkers: true,
			workspaceId: cwd,
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
		// Assert from DISK (the durable truth): the final manifest + tasks + record.
		const final = loadRunManifestById(cwd, result.manifest.runId);
		assert.ok(final, "final on-disk run state");
		const record = getCurrentPlanRecord(final.manifest);
		assert.ok(record, "adaptive run persisted a PlanRecord");
		const adaptiveTasks = final.tasks.filter((t) => t.planItem);
		assert.ok(adaptiveTasks.length > 0, "adaptive tasks carry planItem");
		assert.ok(["completed", "needs_attention"].includes(adaptiveTasks[0]?.status ?? ""), "adaptive task ran");
		const linked = new Set(record.items.flatMap((i) => i.taskIds));
		for (const t of adaptiveTasks) {
			assert.ok(linked.has(t.id), `task ${t.id} must be linked into items[].taskIds at dispatch`);
		}
		// Single revision; store lineage intact.
		assert.equal(loadPlanRecords(final.manifest).length, 1);
	} finally {
		if (previousExecute === undefined) delete process.env.PI_TEAMS_EXECUTE_WORKERS;
		else process.env.PI_TEAMS_EXECUTE_WORKERS = previousExecute;
		if (previousMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
