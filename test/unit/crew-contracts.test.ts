import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskPacket, validateTaskPacket } from "../../src/runtime/task-packet.ts";
import { evaluateGreenContract } from "../../src/runtime/green-contract.ts";
import { evaluateCrewPolicy } from "../../src/runtime/policy-engine.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";
import type { WorkflowStep } from "../../src/workflows/workflow-config.ts";

function manifest(): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "team_test",
		team: "default",
		workflow: "default",
		goal: "Improve crew runtime",
		status: "running",
		workspaceMode: "single",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		cwd: process.cwd(),
		stateRoot: process.cwd(),
		artifactsRoot: process.cwd(),
		tasksPath: "tasks.json",
		eventsPath: "events.jsonl",
		artifacts: [],
	};
}

const step: WorkflowStep = {
	id: "verify",
	role: "verifier",
	task: "Verify {goal}",
	reads: ["src/runtime"],
	verify: true,
};

test("TaskPacket captures scope, contracts, and validates required fields", () => {
	const packet = buildTaskPacket({ manifest: manifest(), step, taskId: "01_verify", cwd: process.cwd() });
	assert.equal(packet.scope, "single_file");
	assert.equal(packet.scopePath, "src/runtime");
	assert.equal(packet.verification.requiredGreenLevel, "targeted");
	assert.equal(validateTaskPacket(packet).valid, true);

	const invalid = validateTaskPacket({ ...packet, objective: " ", scope: "module", scopePath: undefined });
	assert.equal(invalid.valid, false);
	assert.match(invalid.errors.join("\n"), /objective must not be empty/);
	assert.match(invalid.errors.join("\n"), /scopePath is required/);
});

test("Green contract compares required and observed levels", () => {
	assert.equal(evaluateGreenContract({ requiredGreenLevel: "package", commands: [], allowManualEvidence: true }, { requiredGreenLevel: "package", observedGreenLevel: "targeted", satisfied: false, commands: [] }).satisfied, false);
	assert.equal(evaluateGreenContract({ requiredGreenLevel: "package", commands: [], allowManualEvidence: true }, { requiredGreenLevel: "package", observedGreenLevel: "workspace", satisfied: true, commands: [] }).satisfied, true);
});

test("Policy engine blocks unsatisfied green contracts and closes out clean runs", () => {
	const packet = buildTaskPacket({ manifest: manifest(), step, taskId: "01_verify", cwd: process.cwd() });
	const blockedTask: TeamTaskState = {
		id: "01_verify",
		runId: "team_test",
		role: "verifier",
		agent: "verifier",
		title: "verify",
		status: "completed",
		dependsOn: [],
		cwd: process.cwd(),
		taskPacket: packet,
		verification: { requiredGreenLevel: "targeted", observedGreenLevel: "none", satisfied: false, commands: [] },
	};
	const blocked = evaluateCrewPolicy({ manifest: manifest(), tasks: [blockedTask] });
	assert.equal(blocked[0]?.action, "block");
	assert.equal(blocked[0]?.reason, "green_unsatisfied");

	const clean = evaluateCrewPolicy({ manifest: manifest(), tasks: [{ ...blockedTask, verification: { requiredGreenLevel: "targeted", observedGreenLevel: "targeted", satisfied: true, commands: [] } }] });
	assert.equal(clean[0]?.action, "closeout");
});

test("Policy engine enforces graph and concurrency limits", () => {
	const tasks: TeamTaskState[] = [
		{ id: "a", runId: "team_test", role: "executor", agent: "executor", title: "a", status: "running", dependsOn: [], cwd: process.cwd(), graph: { taskId: "a", children: ["b", "c"], dependencies: [], queue: "running" } },
		{ id: "b", runId: "team_test", role: "executor", agent: "executor", title: "b", status: "running", dependsOn: [], cwd: process.cwd(), graph: { taskId: "b", parentId: "a", children: [], dependencies: [], queue: "running" } },
		{ id: "c", runId: "team_test", role: "executor", agent: "executor", title: "c", status: "queued", dependsOn: [], cwd: process.cwd(), graph: { taskId: "c", parentId: "b", children: [], dependencies: [], queue: "ready" } },
	];
	const decisions = evaluateCrewPolicy({ manifest: manifest(), tasks, limits: { maxConcurrentWorkers: 1, maxChildrenPerTask: 1, maxTaskDepth: 1 } });
	assert.equal(decisions.filter((item) => item.reason === "limit_exceeded").length, 3);
});
