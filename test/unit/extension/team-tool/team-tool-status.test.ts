/**
 * Unit tests for team-tool status handler.
 * @see src/extension/team-tool/status.ts
 *
 * NOTE: handleStatus depends on run manifests on disk. We test
 * argument validation and error handling for missing/invalid params.
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { handleStatus, transitionStaleAsyncUnderLock } from "../../../../src/extension/team-tool/status.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import type { TeamToolParamsValue } from "../../../../src/schema/team-tool-schema.ts";
import { readEvents } from "../../../../src/state/event-log/event-log.ts";
import {
	createRunManifest,
	loadRunManifestById,
	saveRunManifest,
	saveRunTasks,
} from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

function makeCtx(cwd: string): TeamContext {
	return { cwd };
}

function makeParams(overrides: Partial<TeamToolParamsValue> = {}): TeamToolParamsValue {
	return { ...overrides };
}

// ─── R14-1 (Phase 3.4) fixtures ───────────────────────────────────────────────

const team: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "planner", agent: "planner" }],
};

const workflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "plan", role: "planner", task: "Plan {goal}" }],
};

// > pid_max on every CI OS (Linux 4M, macOS 100k) — process.kill(pid, 0) is
// deterministically ESRCH → checkProcessLiveness reports dead. Same constant
// as test/unit/extension/core/async-stale.test.ts.
const STALE_ASYNC_PID = 2147483000;

/** Persist a fresh async run: status running + dead async pid + first task running. */
function createDeadAsyncRun(cwd: string, ownerSessionId?: string): { runId: string; cwd: string } {
	const created = createRunManifest({
		cwd,
		team,
		workflow,
		goal: "stale async regression",
		...(ownerSessionId ? { ownerSessionId } : {}),
	});
	saveRunManifest({
		...created.manifest,
		status: "running",
		async: {
			pid: STALE_ASYNC_PID,
			logPath: path.join(created.manifest.stateRoot, "background.log"),
			spawnedAt: new Date().toISOString(),
		},
	});
	saveRunTasks(
		created.manifest,
		created.tasks.map((task, index) => (index === 0 ? { ...task, status: "running" as const } : task)),
	);
	return { runId: created.manifest.runId, cwd };
}

// ─── handleStatus ─────────────────────────────────────────────────────────────

describe("handleStatus", () => {
	it("returns error when runId is missing", () => {
		const tmp = createTrackedTempDir("status-test-");
		try {
			const res = handleStatus(makeParams(), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("runId"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns error when run is not found", () => {
		const tmp = createTrackedTempDir("status-test-");
		try {
			const res = handleStatus(makeParams({ runId: "nonexistent-run-999" }), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("not found"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("includes action=status in details", () => {
		const tmp = createTrackedTempDir("status-test-");
		try {
			const res = handleStatus(makeParams({ runId: "any-run-id" }), makeCtx(tmp));

			assert.strictEqual(res.details.action, "status");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns error status in details for missing run", () => {
		const tmp = createTrackedTempDir("status-test-");
		try {
			const res = handleStatus(makeParams({ runId: "missing" }), makeCtx(tmp));

			assert.strictEqual(res.details.status, "error");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── R14-1 (Phase 3.4): stale-async transition on a READ path ─────────────────

describe("handleStatus stale-async transition (R14-1)", () => {
	it("foreign session polling a dead async run does NOT transition (disk stays running)", () => {
		const tmp = createTrackedTempDir("status-r14-1-foreign-");
		try {
			const { runId, cwd } = createDeadAsyncRun(tmp, "owner-session");

			const res = handleStatus(makeParams({ runId }), { cwd, sessionId: "foreign-session" });

			assert.strictEqual(res.isError, false, "foreign poll still returns its read view");
			const onDisk = loadRunManifestById(cwd, runId);
			assert.ok(onDisk, "run must still exist");
			assert.strictEqual(onDisk.manifest.status, "running", "disk manifest must stay running");
			assert.strictEqual(onDisk.tasks[0]!.status, "running", "running task must not be cancelled");
			assert.ok(
				!readEvents(onDisk.manifest.eventsPath).some((event) => event.type === "async.stale"),
				"no async.stale event for a foreign poll",
			);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("foreign session with force:true DOES transition (ownership override)", () => {
		const tmp = createTrackedTempDir("status-r14-1-force-");
		try {
			const { runId, cwd } = createDeadAsyncRun(tmp, "owner-session");

			const res = handleStatus(makeParams({ runId, force: true }), { cwd, sessionId: "foreign-session" });

			assert.strictEqual(res.isError, false);
			assert.strictEqual(
				loadRunManifestById(cwd, runId)?.manifest.status,
				"failed",
				"force:true must override the foreign-ownership gate",
			);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("owning session polling a dead async run DOES transition to failed", () => {
		const tmp = createTrackedTempDir("status-r14-1-owner-");
		try {
			const { runId, cwd } = createDeadAsyncRun(tmp, "owner-session");

			const res = handleStatus(makeParams({ runId }), { cwd, sessionId: "owner-session" });

			assert.strictEqual(res.isError, false);
			const onDisk = loadRunManifestById(cwd, runId);
			assert.ok(onDisk, "run must still exist");
			assert.strictEqual(onDisk.manifest.status, "failed", "owning poll must transition to failed on disk");
			assert.strictEqual(onDisk.tasks[0]!.status, "cancelled", "running task must be remapped to cancelled");
			assert.ok(
				readEvents(onDisk.manifest.eventsPath).some((event) => event.type === "async.stale"),
				"async.stale event must be appended",
			);
			// Same-poll read view reflects the transition (pre-fix behavior preserved).
			assert.match(textFromToolResult(res), /Status: failed/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("legacy run without ownerSessionId is not gated (transition still applies)", () => {
		const tmp = createTrackedTempDir("status-r14-1-legacy-");
		try {
			const { runId, cwd } = createDeadAsyncRun(tmp); // no ownerSessionId

			const res = handleStatus(makeParams({ runId }), { cwd, sessionId: "any-session" });

			assert.strictEqual(res.isError, false);
			assert.strictEqual(
				loadRunManifestById(cwd, runId)?.manifest.status,
				"failed",
				"runs without an owner are not gated by the ownership check",
			);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("concurrent terminal write between load and lock is NOT re-flipped to failed", () => {
		const tmp = createTrackedTempDir("status-r14-1-race-");
		try {
			const { runId, cwd } = createDeadAsyncRun(tmp, "owner-session");
			// The stale snapshot a status poll would hold at load time (status running).
			const staleSnapshot = loadRunManifestById(cwd, runId)!;
			// A concurrent writer commits 'completed' BEFORE the poll's transition
			// runs (direct state-store write between load and lock).
			saveRunManifest({ ...staleSnapshot.manifest, status: "completed", updatedAt: new Date().toISOString() });

			// The stale transition (lock + fresh re-read) must short-circuit on the
			// fresh terminal status and NOT flip it back to failed.
			const transitioned = transitionStaleAsyncUnderLock(staleSnapshot, cwd, runId);

			assert.strictEqual(transitioned, undefined, "transition must be skipped for a terminal fresh state");
			const onDisk = loadRunManifestById(cwd, runId)!;
			assert.strictEqual(onDisk.manifest.status, "completed", "disk must stay completed, not re-flipped to failed");
			assert.ok(
				!readEvents(onDisk.manifest.eventsPath).some((event) => event.type === "async.stale"),
				"no async.stale event for the skipped transition",
			);
			// And a plain status poll of the completed run is a no-op too.
			const res = handleStatus(makeParams({ runId }), { cwd, sessionId: "owner-session" });
			assert.strictEqual(res.isError, false);
			assert.strictEqual(loadRunManifestById(cwd, runId)?.manifest.status, "completed");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});
