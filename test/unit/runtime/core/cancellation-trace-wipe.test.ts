// test/unit/cancellation-trace-wipe.test.ts
//
// Verifies the user policy (v0.9.16): cancelled / stopped subagents leave NO trace.
// Two surfaces tested:
//   (a) .crew/state/subagents/<id>.json — file deleted on cancelled/stopped terminal status
//   (b) agents.json + per-task status.json — record removed from run's agent index

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	agentStatusPath,
	readCrewAgents,
	removeCrewAgent,
	saveCrewAgents,
	shouldDeleteCrewAgentOnTerminalStatus,
	upsertCrewAgent,
} from "../../../../src/runtime/crew-agent-records.ts";
import type { CrewAgentRecord } from "../../../../src/runtime/crew-agent-runtime.ts";
import {
	removePersistedSubagentRecord,
	savePersistedSubagentRecord,
	shouldDeleteOnTerminalStatus,
} from "../../../../src/runtime/subagent-manager.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

// `persistedSubagentPath` is module-private. Reconstruct its layout for tests:
// <cwd>/.crew/state/subagents/<id>.json  (no prefix — id IS the full filename stem)
function persistedSubagentPath(cwd: string, id: string): string {
	return path.join(cwd, ".crew", "state", "subagents", `${id}.json`);
}

interface SubagentRecordLite {
	id: string;
	agentId?: string;
	agentName?: string;
	subagentType?: string;
	type: string;
	description: string;
	prompt: string;
	status: string;
	startedAt: number;
	spawnedAt?: number;
	background?: boolean;
	ownerSessionGeneration?: number;
}

function makeRecord(overrides: Partial<SubagentRecordLite> = {}): SubagentRecordLite {
	return {
		id: "test_sub_1",
		agentId: "test_sub_1",
		agentName: "explorer",
		subagentType: "explorer",
		type: "explorer",
		description: "test",
		prompt: "test prompt",
		status: "queued",
		startedAt: 1000,
		spawnedAt: 1000,
		background: false,
		ownerSessionGeneration: 1,
		...overrides,
	};
}

function makeManifest(cwd: string): TeamRunManifest {
	const stateRoot = path.join(cwd, ".crew/state/runs/test_run");
	fs.mkdirSync(stateRoot, { recursive: true });
	return {
		schemaVersion: 1,
		runId: "test_run",
		team: "default",
		workflow: "default",
		goal: "x",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd,
		stateRoot,
		artifactsRoot: path.join(cwd, ".crew/artifacts/test_run"),
		tasksPath: "tasks.json",
		eventsPath: "events.jsonl",
		artifacts: [],
	} as TeamRunManifest;
}

function makeCrewRecord(overrides: Partial<CrewAgentRecord> = {}): CrewAgentRecord {
	return {
		id: "crew_a",
		role: "explorer",
		taskId: "01_explore",
		agent: "explorer",
		status: "running",
		...overrides,
	} as CrewAgentRecord;
}

test("shouldDeleteOnTerminalStatus: cancelled → true", () => {
	assert.equal(shouldDeleteOnTerminalStatus({ status: "cancelled" } as never), true);
});

test("shouldDeleteOnTerminalStatus: stopped → true", () => {
	assert.equal(shouldDeleteOnTerminalStatus({ status: "stopped" } as never), true);
});

test("shouldDeleteOnTerminalStatus: terminated flag → true", () => {
	assert.equal(
		shouldDeleteOnTerminalStatus({
			status: "completed",
			terminated: true,
		} as never),
		true,
	);
});

test("shouldDeleteOnTerminalStatus: completed → false (audit value)", () => {
	assert.equal(shouldDeleteOnTerminalStatus({ status: "completed" } as never), false);
});

test("shouldDeleteOnTerminalStatus: failed → false (audit value)", () => {
	assert.equal(shouldDeleteOnTerminalStatus({ status: "failed" } as never), false);
});

test("shouldDeleteOnTerminalStatus: error → false (audit value)", () => {
	assert.equal(shouldDeleteOnTerminalStatus({ status: "error" } as never), false);
});

test("removePersistedSubagentRecord: deletes the file", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wipe-test-"));
	try {
		const record = makeRecord();
		savePersistedSubagentRecord(cwd, record as never);
		assert.ok(fs.existsSync(persistedSubagentPath(cwd, record.id)), "should exist after save");
		const removed = removePersistedSubagentRecord(cwd, record.id);
		assert.equal(removed, true);
		assert.ok(!fs.existsSync(persistedSubagentPath(cwd, record.id)), "should be gone after remove");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("removePersistedSubagentRecord: safe-fail when file does not exist", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wipe-noexist-"));
	try {
		const removed = removePersistedSubagentRecord(cwd, "nonexistent_id");
		assert.equal(removed, false); // ENOENT returns false (no actual deletion happened)
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("shouldDeleteCrewAgentOnTerminalStatus: cancelled/stopped → true", () => {
	assert.equal(shouldDeleteCrewAgentOnTerminalStatus({ status: "cancelled" } as never), true);
	assert.equal(shouldDeleteCrewAgentOnTerminalStatus({ status: "stopped" } as never), true);
});

test("shouldDeleteCrewAgentOnTerminalStatus: failed/completed → false", () => {
	assert.equal(shouldDeleteCrewAgentOnTerminalStatus({ status: "failed" } as never), false);
	assert.equal(shouldDeleteCrewAgentOnTerminalStatus({ status: "completed" } as never), false);
});

test("removeCrewAgent: removes from agents.json index", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wipe-crew-"));
	try {
		const manifest = makeManifest(cwd);
		const a = makeCrewRecord({ id: "a", taskId: "01_a" });
		const b = makeCrewRecord({ id: "b", taskId: "02_b" });
		saveCrewAgents(manifest, [a, b]);
		assert.equal(readCrewAgents(manifest).length, 2);
		const result = removeCrewAgent(manifest, "01_a");
		assert.equal(result.removedIndex, true);
		const after = readCrewAgents(manifest);
		assert.equal(after.length, 1);
		assert.equal(after[0]?.taskId, "02_b");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("removeCrewAgent: removes per-task status.json", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wipe-status-"));
	try {
		const manifest = makeManifest(cwd);
		// H2 (2026-08-10): non-terminal records get best-effort coalesced (debounced)
		// status writes — only TERMINAL records are sync-written, so use a terminal
		// status here to guarantee status.json exists immediately after save.
		const a = makeCrewRecord({ id: "a", taskId: "01_a", status: "completed" });
		saveCrewAgents(manifest, [a]);
		const statusPath = agentStatusPath(manifest, "01_a");
		assert.ok(fs.existsSync(statusPath), "status.json should exist after save");
		const result = removeCrewAgent(manifest, "01_a");
		assert.equal(result.removedStatus, true);
		assert.ok(!fs.existsSync(statusPath), "status.json should be gone");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("upsertCrewAgent: cancelled status triggers removal (no save)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wipe-upsert-"));
	try {
		const manifest = makeManifest(cwd);
		// First: agent is running
		const running = makeCrewRecord({
			id: "a",
			taskId: "01_a",
			status: "running",
		});
		upsertCrewAgent(manifest, running);
		assert.equal(readCrewAgents(manifest).length, 1);
		// Then: transition to cancelled
		const cancelled = makeCrewRecord({
			id: "a",
			taskId: "01_a",
			status: "cancelled",
		});
		upsertCrewAgent(manifest, cancelled);
		// Should be removed from index
		assert.equal(readCrewAgents(manifest).length, 0, "cancelled agent should be wiped");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("upsertCrewAgent: completed status keeps audit trail", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wipe-completed-"));
	try {
		const manifest = makeManifest(cwd);
		const completed = makeCrewRecord({
			id: "a",
			taskId: "01_a",
			status: "completed",
		});
		upsertCrewAgent(manifest, completed);
		assert.equal(readCrewAgents(manifest).length, 1, "completed agent should be preserved");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("upsertCrewAgent: failed status keeps audit trail", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wipe-failed-"));
	try {
		const manifest = makeManifest(cwd);
		const failed = makeCrewRecord({
			id: "a",
			taskId: "01_a",
			status: "failed",
		});
		upsertCrewAgent(manifest, failed);
		assert.equal(readCrewAgents(manifest).length, 1, "failed agent should be preserved");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
