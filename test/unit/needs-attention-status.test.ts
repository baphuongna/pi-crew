/**
 * Validation test for needs_attention task status feature.
 * Covers: contracts, state transitions, attention events, agent-control idle detection.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { applyAttentionState, resolveCrewControlConfig } from "../../src/runtime/agent-control.ts";
import { readCrewAgents, upsertCrewAgent } from "../../src/runtime/crew-agent-records.ts";
import {
	canTransitionTaskStatus,
	TEAM_TASK_STATUS_TRANSITIONS,
	TEAM_TASK_STATUSES,
	TEAM_TERMINAL_TASK_STATUSES,
} from "../../src/state/contracts.ts";
import { readEvents } from "../../src/state/event-log.ts";
import { createRunManifest } from "../../src/state/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "needs-attention-test",
	description: "test team",
	source: "builtin",
	filePath: "test.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};
const workflow: WorkflowConfig = {
	name: "needs-attention-test",
	description: "test workflow",
	source: "builtin",
	filePath: "test.workflow.md",
	steps: [{ id: "execute", role: "executor", task: "Execute" }],
};

// --- Contract tests ---

test("needs_attention is a recognized task status", () => {
	assert.ok(TEAM_TASK_STATUSES.includes("needs_attention"));
});

test("needs_attention is a terminal task status", () => {
	assert.ok(TEAM_TERMINAL_TASK_STATUSES.has("needs_attention"));
});

test("needs_attention can transition to queued and running", () => {
	const allowed = TEAM_TASK_STATUS_TRANSITIONS.needs_attention;
	assert.deepEqual(allowed, ["queued", "running"]);
});

test("canTransitionTaskStatus allows needs_attention -> queued", () => {
	assert.ok(canTransitionTaskStatus("needs_attention", "queued"));
});

test("canTransitionTaskStatus allows needs_attention -> running", () => {
	assert.ok(canTransitionTaskStatus("needs_attention", "running"));
});

test("canTransitionTaskStatus rejects needs_attention -> completed", () => {
	assert.equal(canTransitionTaskStatus("needs_attention", "completed"), false);
});

test("running can transition to needs_attention (via noYield)", () => {
	// running -> queued, completed, failed, cancelled, waiting — NOT directly to needs_attention
	// needs_attention is set at finalize, not via normal transition
	const allowed = TEAM_TASK_STATUS_TRANSITIONS.running;
	assert.ok(!allowed.includes("needs_attention"), "running should not directly transition to needs_attention; it is set at finalize");
});

// --- Agent control idle detection ---

test("agent control marks stale running agents as needs_attention", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-needs-attention-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "test needs_attention",
		});

		const old = new Date(Date.now() - 120_000).toISOString();
		const record = {
			id: `${manifest.runId}:01_execute`,
			runId: manifest.runId,
			taskId: "01_execute",
			agent: "executor",
			role: "executor",
			runtime: "child-process" as const,
			status: "running" as const,
			startedAt: old,
			progress: {
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				lastActivityAt: old,
				activityState: "active" as const,
			},
		};
		upsertCrewAgent(manifest, record);

		const updated = applyAttentionState(
			manifest,
			record,
			resolveCrewControlConfig({
				control: { needsAttentionAfterMs: 1000 },
			}),
		);

		assert.equal(updated.progress?.activityState, "needs_attention");
		assert.equal(readCrewAgents(manifest)[0]!.progress?.activityState, "needs_attention");
		assert.ok(readEvents(manifest.eventsPath).some((e) => e.type === "task.attention" && e.data?.reason === "idle"));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("agent control does NOT mark recently active agents", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-needs-attention-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "test active",
		});

		const recent = new Date().toISOString();
		const record = {
			id: `${manifest.runId}:01_execute`,
			runId: manifest.runId,
			taskId: "01_execute",
			agent: "executor",
			role: "executor",
			runtime: "child-process" as const,
			status: "running" as const,
			startedAt: recent,
			progress: {
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				lastActivityAt: recent,
				activityState: "active" as const,
			},
		};
		upsertCrewAgent(manifest, record);

		const updated = applyAttentionState(
			manifest,
			record,
			resolveCrewControlConfig({
				control: { needsAttentionAfterMs: 60_000 },
			}),
		);

		assert.equal(updated.progress?.activityState, "active");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
