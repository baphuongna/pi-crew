import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TeamContext } from "../../../src/extension/team-tool/context.ts";
import { handleStatus } from "../../../src/extension/team-tool/status.ts";
import { textFromToolResult } from "../../../src/extension/tool-result.ts";
import {
	appendDeadletter,
	type DeadletterEntry,
	deadletterIndexPath,
	deadletterStatusLine,
	readDeadletter,
} from "../../../src/runtime/deadletter.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../src/workflows/workflow-config.ts";
import { resolveCanonicalDir } from "../../fixtures/test-tempdir.ts";

/**
 * US-003 (2026-09-22): dead-letter queue for exhausted-retry failures.
 *
 * What existed before: appendDeadletter wrote ONLY <stateRoot>/deadletter.jsonl —
 * deleted together with the run dir by auto-prune (keep=10, DP-01), exactly when
 * the post-mortem is needed. What this spec adds: a project-level index
 * (<projectRoot>/.crew/state/deadletter/<runId>.jsonl) that survives pruning,
 * a richer entry schema (agent/role/modelAttempts/runStatus), and handleStatus
 * surfacing.
 *
 * Honest deviation recorded in the spec: "atomically (both or neither)" across
 * two files is not physically possible without a journal — the contract is
 * "both on success, never a caller-visible failure" (each failure logged).
 *
 * Mutation: drop the project-index write in appendDeadletter → index test RED.
 */

const team: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

const workflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "do", role: "executor", task: "Do {goal}" }],
};

function fakeManifest(cwd: string, runId = "team_us003_deadletter01", stateRoot?: string): TeamRunManifest {
	return {
		runId,
		stateRoot: stateRoot ?? path.join(cwd, ".crew", "state", "runs", runId),
		cwd,
		status: "failed",
	} as unknown as TeamRunManifest;
}

function entry(taskId: string, overrides: Partial<DeadletterEntry> = {}): DeadletterEntry {
	return {
		taskId,
		runId: "team_us003_deadletter01",
		reason: "max-retries",
		attempts: 3,
		lastError: "rate limit: mock failure\nsecond line is noise",
		attemptId: "att-1",
		timestamp: "2026-09-15T09:00:00.000Z",
		agent: "executor",
		role: "executor",
		modelAttempts: 2,
		runStatus: "failed",
		...overrides,
	};
}

test("US-003: appendDeadletter writes run-local file AND project index with the richer schema", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "us003-"));
	try {
		const manifest = fakeManifest(cwd);
		appendDeadletter(manifest, entry("t1"));
		// Run-local record still exists (backward compat with readDeadletter).
		const local = readDeadletter(manifest);
		assert.equal(local.length, 1);
		assert.equal(local[0].taskId, "t1");
		assert.equal(local[0].agent, "executor");
		assert.equal(local[0].role, "executor");
		assert.equal(local[0].modelAttempts, 2);
		assert.equal(local[0].runStatus, "failed");
		// Project index exists OUTSIDE the run dir and carries the same entry.
		// Compare CANONICAL forms: deadletterIndexPath → projectCrewRoot(), which
		// canonicalizes an EXISTING .crew/ via realpathSync.native — on macOS
		// os.tmpdir() is a symlink (/var → /private/var) and on Windows the path
		// comes back in long-name form (runneradmin vs RUNNER~1). Both spellings
		// denote the same file, so raw-string equality is a platform-dependent
		// assertion (macOS + Windows CI failures).
		const indexPath = deadletterIndexPath(manifest);
		assert.equal(
			path.resolve(indexPath),
			path.resolve(resolveCanonicalDir(cwd), ".crew", "state", "deadletter", "team_us003_deadletter01.jsonl"),
			"project index must live under the project's .crew/state/deadletter",
		);
		assert.equal(fs.existsSync(indexPath), true, "project-level index must be written");
		const indexed = fs
			.readFileSync(indexPath, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as DeadletterEntry);
		assert.equal(indexed.length, 1);
		assert.equal(indexed[0].taskId, "t1");
		assert.equal(indexed[0].agent, "executor");
		assert.equal(indexed[0].modelAttempts, 2);
		// runStatus defaults to the manifest status when the entry omits it.
		appendDeadletter(manifest, entry("t2", { runStatus: undefined }));
		const second = fs
			.readFileSync(indexPath, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as DeadletterEntry);
		assert.equal(second.length, 2, "append-only: re-running the same runId must append, not overwrite");
		assert.equal(second[0].taskId, "t1", "prior entry preserved");
		assert.equal(second[1].runStatus, "failed", "index fills runStatus from the manifest when omitted");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("US-003: index survives run-dir pruning (the point of the spec)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "us003-"));
	try {
		const manifest = fakeManifest(cwd);
		appendDeadletter(manifest, entry("t1"));
		// Simulate auto-prune deleting the run dir.
		fs.rmSync(path.dirname(manifest.stateRoot), { recursive: true, force: true });
		const indexPath = deadletterIndexPath(manifest);
		assert.equal(fs.existsSync(indexPath), true, "project index must survive run-dir deletion");
		assert.equal(fs.existsSync(manifest.stateRoot), false, "sanity: run dir is really gone");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("US-003: appendDeadletter never throws into the retry path (best-effort contract)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "us003-"));
	try {
		// Case A — run-local write fails (parent is a FILE), project index still written.
		const blocker = path.join(cwd, "blocker");
		fs.writeFileSync(blocker, "not a dir");
		const manifestA = fakeManifest(cwd, "team_us003_blocked01", path.join(blocker, "state", "runs", "team_us003_blocked01"));
		assert.doesNotThrow(() => appendDeadletter(manifestA, entry("t1", { runId: "team_us003_blocked01" })));
		assert.equal(fs.existsSync(deadletterIndexPath(manifestA)), true, "index written even when the run-local file cannot be");
		// Case B — index write fails (`.crew` exists as a FILE), run-local still written.
		const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), "us003b-"));
		try {
			fs.writeFileSync(path.join(cwd2, ".crew"), "file, not dir");
			// stateRoot deliberately OUTSIDE .crew so only the index path is blocked.
			const manifestB = fakeManifest(cwd2, "team_us003_blocked02", path.join(cwd2, "run-state", "team_us003_blocked02"));
			assert.doesNotThrow(() => appendDeadletter(manifestB, entry("t1", { runId: "team_us003_blocked02" })));
			assert.equal(readDeadletter(manifestB).length, 1, "run-local record still written when the index cannot be");
			assert.equal(fs.existsSync(deadletterIndexPath(manifestB)), false);
		} finally {
			fs.rmSync(cwd2, { recursive: true, force: true });
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("US-003 AC-3: handleStatus surfaces deadletter count only when entries exist", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "us003-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "US-003 status surfacing" });
		saveRunManifest(created.manifest);
		saveRunTasks(created.manifest, created.tasks);
		const ctx = { cwd } as TeamContext;
		// Before any deadletter entry: no line.
		const clean = handleStatus({ action: "status", runId: created.manifest.runId }, ctx);
		assert.equal(textFromToolResult(clean).includes("Deadletter:"), false, "healthy run shows no deadletter noise");
		// After an exhausted-retry entry: exactly one surfaced line.
		appendDeadletter(created.manifest, entry("t_dead"));
		const dirty = handleStatus({ action: "status", runId: created.manifest.runId }, ctx);
		const text = textFromToolResult(dirty);
		assert.match(text, /Deadletter: 1 \(max-retries\)/);
		assert.equal(deadletterStatusLine(created.manifest) !== undefined, true);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
