import test from "node:test";
import assert from "node:assert/strict";
import {
	isDirectRun,
	directTeamAndWorkflowFromRun,
} from "../../src/runtime/direct-run.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";
import type { AgentConfig } from "../../src/agents/agent-config.ts";

/**
 * Round 28 (test coverage gaps): `direct-run.ts` provides direct-run detection
 * and synthetic team/workflow construction for the direct-agent workflow.
 *
 * Both exports are pure functions — no file I/O.
 */

// ─── isDirectRun ───────────────────────────────────────────────────────────

test("isDirectRun: returns true for direct-agent workflow", () => {
	assert.equal(isDirectRun({ team: "direct-executor", workflow: "direct-agent" }), true);
});

test("isDirectRun: returns false for implementation workflow", () => {
	assert.equal(isDirectRun({ team: "default", workflow: "implementation" }), false);
});

test("isDirectRun: returns false for review workflow", () => {
	assert.equal(isDirectRun({ team: "review", workflow: "review" }), false);
});

// ─── directTeamAndWorkflowFromRun ──────────────────────────────────────────

test("directTeamAndWorkflowFromRun: returns undefined for non-direct runs", () => {
	const manifest = { team: "default", workflow: "implementation" } as TeamRunManifest;
	const result = directTeamAndWorkflowFromRun(manifest, [], []);
	assert.equal(result, undefined);
});

test("directTeamAndWorkflowFromRun: builds team/workflow from first task", () => {
	const manifest = {
		team: "direct-executor",
		workflow: "direct-agent",
		workspaceMode: "single",
	} as TeamRunManifest;
	const tasks = [{
		id: "task-1",
		agent: "executor",
		role: "agent",
		stepId: "01_agent",
	}] as TeamTaskState[];
	const agents = [{
		name: "executor",
		description: "Implements code changes",
	}] as AgentConfig[];

	const result = directTeamAndWorkflowFromRun(manifest, tasks, agents);
	assert.ok(result);
	assert.equal(result!.team.name, "direct-executor");
	assert.equal(result!.team.roles[0]!.agent, "executor");
	assert.equal(result!.workflow.steps[0]!.role, "agent");
	assert.equal(result!.workflow.steps[0]!.id, "01_agent");
});

test("directTeamAndWorkflowFromRun: defaults agent name from team prefix", () => {
	const manifest = {
		team: "direct-explorer",
		workflow: "direct-agent",
	} as TeamRunManifest;
	const result = directTeamAndWorkflowFromRun(manifest, [], []);
	assert.ok(result);
	assert.equal(result!.team.roles[0]!.agent, "explorer");
});

test("directTeamAndWorkflowFromRun: defaults role to 'agent' when no task role", () => {
	const manifest = {
		team: "direct-executor",
		workflow: "direct-agent",
	} as TeamRunManifest;
	const tasks = [{}] as TeamTaskState[];
	const result = directTeamAndWorkflowFromRun(manifest, tasks, []);
	assert.ok(result);
	assert.equal(result!.workflow.steps[0]!.role, "agent");
});

test("directTeamAndWorkflowFromRun: defaults stepId to '01_agent' when no task stepId", () => {
	const manifest = {
		team: "direct-executor",
		workflow: "direct-agent",
	} as TeamRunManifest;
	const tasks = [{}] as TeamTaskState[];
	const result = directTeamAndWorkflowFromRun(manifest, tasks, []);
	assert.ok(result);
	assert.equal(result!.workflow.steps[0]!.id, "01_agent");
});

test("directTeamAndWorkflowFromRun: falls back to 'executor' for empty team prefix", () => {
	const manifest = {
		team: "direct-",
		workflow: "direct-agent",
	} as TeamRunManifest;
	const result = directTeamAndWorkflowFromRun(manifest, [], []);
	assert.ok(result);
	assert.equal(result!.team.roles[0]!.agent, "executor");
});
