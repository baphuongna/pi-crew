/**
 * pi-crew Functional Test — Live testing of pi-crew features.
 *
 * Uses PI_TEAMS_MOCK_CHILD_PI to avoid real LLM calls. Exercises the major
 * public API surface: handleTeamTool (run), handleSteer, handleCancel,
 * handleStatus, handleTeamSummary.
 *
 * Run with: npx tsx --test test/functional/pi-crew-functional.test.ts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { handleTeamTool, handleSteer } from "../../src/extension/team-tool.ts";
import { handleCancel } from "../../src/extension/team-tool/cancel.ts";
import { handleStatus } from "../../src/extension/team-tool/status.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";

// ── Helpers ────────────────────────────────────────────────────────────

function mkTmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-func-test-"));
	fs.mkdirSync(path.join(dir, ".crew"));
	return dir;
}

function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

async function withMockChild(mockKind: string, fn: () => Promise<void>): Promise<void> {
	const prev = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const prevExec = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const prevAllow = process.env.PI_CREW_ALLOW_MOCK;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = mockKind;
	try {
		await fn();
	} finally {
		if (prev === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = prev;
		if (prevExec === undefined) delete process.env.PI_TEAMS_EXECUTE_WORKERS;
		else process.env.PI_TEAMS_EXECUTE_WORKERS = prevExec;
		if (prevAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = prevAllow;
	}
}

// ── Test 1: Basic run completes ──────────────────────────────────────

test("FEATURE: team run completes with mock child Pi", async () => {
	const cwd = mkTmp();
	try {
		await withMockChild("success", async () => {
			const result = await handleTeamTool(
				{ action: "run", team: "fast-fix", goal: "Verify basic run" },
				{ cwd },
			);
			assert.equal(result.isError, false, "run should not error");
			const runId = result.details.runId;
			assert.ok(runId, "runId must be present");
			const loaded = loadRunManifestById(cwd, runId!);
			assert.ok(loaded, "manifest must be loadable from disk");
			assert.equal(loaded?.manifest.status, "completed");
			assert.ok((loaded?.tasks.length ?? 0) > 0, "must have at least one task");
		});
	} finally {
		cleanup(cwd);
	}
});

// ── Test 2: JSON output tracking (usage, jsonEvents) ──────────────────

test("FEATURE: JSON mock records usage and jsonEvents", async () => {
	const cwd = mkTmp();
	try {
		await withMockChild("json-success", async () => {
			const result = await handleTeamTool(
				{ action: "run", team: "fast-fix", goal: "JSON execute" },
				{ cwd },
			);
			const runId = result.details.runId;
			assert.ok(runId);
			const loaded = loadRunManifestById(cwd, runId!);
			assert.ok(loaded);
			assert.equal(loaded?.manifest.status, "completed");
			// json-success mock emits 2 json events per task
			assert.ok(loaded?.tasks.every((task) => task.jsonEvents === 2), "each task should have 2 json events");
			assert.ok(loaded?.tasks.every((task) => task.usage?.input === 10), "input tokens should be 10");
		});
	} finally {
		cleanup(cwd);
	}
});

// ── Test 3: runId stability across reads ─────────────────────────────

test("FEATURE: runId is stable across multiple reads", async () => {
	const cwd = mkTmp();
	let runId: string | undefined;
	try {
		await withMockChild("success", async () => {
			const result = await handleTeamTool(
				{ action: "run", team: "fast-fix", goal: "Test runId stability" },
				{ cwd },
			);
			assert.equal(result.isError, false);
			runId = result.details.runId;
			assert.ok(runId);
			// First read inside mock context
			const loaded1 = loadRunManifestById(cwd, runId!);
			assert.equal(loaded1?.manifest.runId, runId);
		});
		// Second read outside mock context — manifest should persist
		if (runId) {
			const loaded2 = loadRunManifestById(cwd, runId);
			assert.equal(loaded2?.manifest.runId, runId, "manifest persists after process");
		}
	} finally {
		cleanup(cwd);
	}
});

// ── Test 4: status returns info for completed run ───────────────────

test("FEATURE: status command returns run info", async () => {
	const cwd = mkTmp();
	let runId: string | undefined;
	try {
		await withMockChild("success", async () => {
			const result = await handleTeamTool(
				{ action: "run", team: "fast-fix", goal: "Status test" },
				{ cwd },
			);
			runId = result.details.runId;
		});
		assert.ok(runId);
		const status = await handleStatus({ action: "status", runId: runId! }, { cwd });
		assert.equal(status.isError, false);
		const details = status.details as { runId: string; status: string };
		assert.equal(details.runId, runId);
		// handleStatus returns status: "ok" (query ok) — actual run status is in manifest.status
		assert.equal(details.status, "ok");
		// Verify the actual run status separately:
		assert.equal(loadRunManifestById(cwd, runId!)?.manifest.status, "completed");
	} finally {
		cleanup(cwd);
	}
});

// ── Test 5: summary returns aggregated info ─────────────────────────

test("FEATURE: summary command returns aggregated info", async () => {
	const cwd = mkTmp();
	let runId: string | undefined;
	try {
		await withMockChild("success", async () => {
			const result = await handleTeamTool(
				{ action: "run", team: "fast-fix", goal: "Summary test" },
				{ cwd },
			);
			runId = result.details.runId;
		});
		assert.ok(runId);
		const summary = await handleTeamTool(
			{ action: "summary", runId: runId! },
			{ cwd },
		);
		assert.equal(summary.isError, false);
	} finally {
		cleanup(cwd);
	}
});

// ── Test 6: steer to nonexistent run errors gracefully ──────────────

test("FEATURE: steer with unknown runId returns error", async () => {
	const cwd = mkTmp();
	try {
		const result = await handleSteer(
			{ action: "steer", runId: "nonexistent-run", taskId: "no-task", message: "test" },
			{ cwd },
		);
		assert.equal(result.isError, true, "steer to nonexistent run must error");
	} finally {
		cleanup(cwd);
	}
});

// ── Test 7: cancel on completed run is graceful ────────────────────

test("FEATURE: cancel on completed run does not crash", async () => {
	const cwd = mkTmp();
	let runId: string | undefined;
	try {
		await withMockChild("success", async () => {
			const result = await handleTeamTool(
				{ action: "run", team: "fast-fix", goal: "Cancel test" },
				{ cwd },
			);
			runId = result.details.runId;
		});
		assert.ok(runId);
		// Cancel a completed run — should not crash
		const cancelResult = await handleCancel(
			{ action: "cancel", runId: runId! },
			{ cwd },
		);
		// Either isError or returns an info message — both are acceptable
		assert.ok(cancelResult !== undefined);
	} finally {
		cleanup(cwd);
	}
});

// ── Test 8: concurrent runs are isolated ────────────────────────────

test("FEATURE: concurrent runs have unique runIds", async () => {
	const cwd = mkTmp();
	try {
		await withMockChild("success", async () => {
			const [a, b, c] = await Promise.all([
				handleTeamTool({ action: "run", team: "fast-fix", goal: "Concurrent A" }, { cwd }),
				handleTeamTool({ action: "run", team: "fast-fix", goal: "Concurrent B" }, { cwd }),
				handleTeamTool({ action: "run", team: "fast-fix", goal: "Concurrent C" }, { cwd }),
			]);
			const runIds = new Set([a.details.runId, b.details.runId, c.details.runId]);
			assert.equal(runIds.size, 3, "each concurrent run must have a unique runId");
		});
	} finally {
		cleanup(cwd);
	}
});

// ── Test 9: failure mock produces non-completed status ────────────────

test("FEATURE: failure mock does not produce completed status", async () => {
	const cwd = mkTmp();
	try {
		await withMockChild("failure", async () => {
			const result = await handleTeamTool(
				{ action: "run", team: "fast-fix", goal: "Failure test" },
				{ cwd },
			);
			const runId = result.details.runId;
			assert.ok(runId);
			const loaded = loadRunManifestById(cwd, runId!);
			assert.ok(loaded);
			assert.notEqual(loaded?.manifest.status, "completed", "failure must not be marked completed");
		});
	} finally {
		cleanup(cwd);
	}
});

// ── Test 10: run data written to disk (.crew/state/runs/...) ──────────────

test("FEATURE: run data written to disk (.crew/state/runs/<runId>/...)", async () => {
	const cwd = mkTmp();
	try {
		await withMockChild("success", async () => {
			const result = await handleTeamTool(
				{ action: "run", team: "fast-fix", goal: "Artifact test" },
				{ cwd },
			);
			const runId = result.details.runId!;
			// The state directory and run data must exist
			const runDir = path.join(cwd, ".crew", "state", "runs", runId);
			assert.ok(fs.existsSync(runDir), "run directory must exist");
			// manifest.json, tasks.json, events.jsonl must be written
			assert.ok(fs.existsSync(path.join(runDir, "manifest.json")), "manifest.json must be written");
			assert.ok(fs.existsSync(path.join(runDir, "tasks.json")), "tasks.json must be written");
			assert.ok(fs.existsSync(path.join(runDir, "events.jsonl")), "events.jsonl must be written");
		});
	} finally {
		cleanup(cwd);
	}
});

// ── Test 11: events.jsonl contains run.lifecycle events ────────────────

test("FEATURE: events.jsonl contains lifecycle events", async () => {
	const cwd = mkTmp();
	let runId: string | undefined;
	try {
		await withMockChild("success", async () => {
			const result = await handleTeamTool(
				{ action: "run", team: "fast-fix", goal: "Events test" },
				{ cwd },
			);
			runId = result.details.runId;
		});
		assert.ok(runId);
		const eventsPath = path.join(cwd, ".crew", "state", "runs", runId!, "events.jsonl");
		assert.ok(fs.existsSync(eventsPath), "events.jsonl must exist");
		const events = fs.readFileSync(eventsPath, "utf-8");
		// events.jsonl should have at least one event line
		assert.ok(events.split("\n").filter((l) => l.trim()).length > 0, "events.jsonl must have content");
	} finally {
		cleanup(cwd);
	}
});

// ── Test 12: runId rejected for non-existent run ───────────────────────

test("FEATURE: status on nonexistent runId returns error", async () => {
	const cwd = mkTmp();
	try {
		const result = await handleStatus(
			{ action: "status", runId: "definitely-not-a-real-run" },
			{ cwd },
		);
		assert.equal(result.isError, true, "status on nonexistent run must error");
	} finally {
		cleanup(cwd);
	}
});

// ── Test 13: task metadata includes modelAttempts ────────────────────

test("FEATURE: fast-fix run records modelAttempts on each task", async () => {
	const cwd = mkTmp();
	try {
		await withMockChild("success", async () => {
			const result = await handleTeamTool(
				{ action: "run", team: "fast-fix", goal: "Model attempts test" },
				{ cwd },
			);
			const runId = result.details.runId!;
			const loaded = loadRunManifestById(cwd, runId);
			assert.ok(loaded);
			assert.ok(
				loaded?.tasks.every((task) => Array.isArray(task.modelAttempts) && task.modelAttempts.length >= 1),
				"every task must have at least one model attempt",
			);
		});
	} finally {
		cleanup(cwd);
	}
});

// ── Test 14: error in handleTeamTool ────────────────────────────────

test("FEATURE: handleTeamTool with invalid team returns isError", async () => {
	const cwd = mkTmp();
	try {
		await withMockChild("success", async () => {
			const result = await handleTeamTool(
				{ action: "run", team: "nonexistent-team-1234", goal: "Invalid team" },
				{ cwd },
			);
			// Invalid team should produce an error result
			assert.equal(result.isError, true);
		});
	} finally {
		cleanup(cwd);
	}
});

// ── Test 15: steer with valid runId ──────────────────────────────────

test("FEATURE: steer with valid runId finds the task", async () => {
	const cwd = mkTmp();
	let runId: string | undefined;
	try {
		await withMockChild("success", async () => {
			const result = await handleTeamTool(
				{ action: "run", team: "fast-fix", goal: "Steer valid test" },
				{ cwd },
			);
			runId = result.details.runId;
		});
		assert.ok(runId);
		// Get task IDs from manifest
		const loaded = loadRunManifestById(cwd, runId!);
		const firstTask = loaded?.tasks[0];
		assert.ok(firstTask);
		// Steer toward the completed task — T-S1 guard should reject (terminal status)
		const steerResult = await handleSteer(
			{
				action: "steer",
				runId: runId!,
				taskId: firstTask.id,
				message: "test message",
			},
			{ cwd },
		);
		// T-S1 guard: completed task should reject steer
		assert.equal(steerResult.isError, true, "steer to completed task must error (T-S1 guard)");
	} finally {
		cleanup(cwd);
	}
});
