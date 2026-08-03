/**
 * RT-13 / RT-15 tests for src/runtime/team-runner.ts.
 *
 * RT-13: The former inline status-rewrite hack
 *   `manifest = { ...manifest, status: "running" }`
 * was replaced with the exported `setRunStatusRunning` helper that validates
 * the transition via `canTransitionRunStatus`. These tests assert:
 *   1. The helper correctly normalizes terminal statuses → "running".
 *   2. The raw spread hack is GONE from the source (grep-based structural pin).
 *   3. The helper is actually called in the cancellation path.
 *
 * RT-15: The 6 per-function forward-sync points were removed; the top-of-loop
 * sync is now the single forward-sync point. A grep-based structural pin
 * asserts that `ctx.tasks = tasks` appears only in the top-of-loop sync +
 * back-syncs inside scheduler functions (not as redundant forward-syncs).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { setRunStatusRunning } from "../../../src/runtime/team-runner.ts";
import { canTransitionRunStatus } from "../../../src/state/contracts.ts";
import type { TeamRunManifest } from "../../../src/state/types.ts";

// ─── RT-13: setRunStatusRunning unit tests ─────────────────────────

/** Build a minimal manifest with the given status (bypasses createRunManifest
 *  to avoid touching the filesystem). */
function manifestWithStatus(status: TeamRunManifest["status"]): TeamRunManifest {
	return {
		runId: "test-rt13",
		team: "test-team",
		workflow: "default",
		cwd: "/tmp/test-rt13",
		stateRoot: "/tmp/test-rt13/.crew/state",
		artifactsRoot: "/tmp/test-rt13/.crew/artifacts",
		eventsPath: "/tmp/test-rt13/.crew/state/events.jsonl",
		status,
		goal: "test goal",
		summary: "",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		artifacts: [],
		tasks: [],
	} as unknown as TeamRunManifest;
}

test("[RT-13] setRunStatusRunning transitions failed → running", () => {
	const m = manifestWithStatus("failed");
	const result = setRunStatusRunning(m);
	assert.equal(result.status, "running", "failed → running");
	// All other fields preserved.
	assert.equal(result.runId, m.runId);
	assert.equal(result.team, m.team);
	assert.equal(result.goal, m.goal);
});

test("[RT-13] setRunStatusRunning transitions cancelled → running", () => {
	const m = manifestWithStatus("cancelled");
	const result = setRunStatusRunning(m);
	assert.equal(result.status, "running", "cancelled → running");
});

test("[RT-13] setRunStatusRunning transitions completed → running", () => {
	const m = manifestWithStatus("completed");
	const result = setRunStatusRunning(m);
	assert.equal(result.status, "running", "completed → running");
});

test("[RT-13] setRunStatusRunning is a no-op-safe for running → running", () => {
	const m = manifestWithStatus("running");
	const result = setRunStatusRunning(m);
	assert.equal(result.status, "running", "running → running");
});

test("[RT-13] setRunStatusRunning returns a new object (does not mutate input)", () => {
	const m = manifestWithStatus("failed");
	const result = setRunStatusRunning(m);
	assert.notEqual(result, m, "returned object must be a new reference");
	assert.equal(m.status, "failed", "input manifest must be unchanged");
});

test("[RT-13] setRunStatusRunning does not emit events or persist (no side effects)", () => {
	// The helper must NOT call updateRunStatus (which writes to disk + appends
	// events). We verify this structurally: the helper should work even when
	// the eventsPath points to a non-existent directory.
	const m = manifestWithStatus("failed");
	// If updateRunStatus were called, it would throw on the bad eventsPath.
	const result = setRunStatusRunning(m);
	assert.equal(result.status, "running");
});

test("[RT-13] all manifest statuses can legally transition to running (validation never rejects)", () => {
	// This documents WHY setRunStatusRunning always succeeds: every status in
	// TEAM_RUN_STATUS_TRANSITIONS can reach "running".
	const statuses: TeamRunManifest["status"][] = ["queued", "planning", "running", "blocked", "completed", "failed", "cancelled"];
	for (const s of statuses) {
		assert.ok(canTransitionRunStatus(s, "running"), `status "${s}" must be able to transition to "running"`);
		const result = setRunStatusRunning(manifestWithStatus(s));
		assert.equal(result.status, "running", `"${s}" → running via helper`);
	}
});

// ─── RT-13: structural pin — the raw spread hack must be GONE ──────

test('[RT-13] raw spread hack `manifest = { ...manifest, status: "running" }` is absent from source', () => {
	const srcPath = path.resolve(import.meta.dirname, "../../../src/runtime/team-runner.ts");
	const src = fs.readFileSync(srcPath, "utf-8");

	// The EXACT hack pattern that was removed: an assignment of a spread literal
	// with status: "running" to a variable. We strip comment lines (// and *)
	// so docstring references to the former hack don't false-positive.
	// The `setRunStatusRunning` helper uses `return { ...manifest, status:
	// "running" }` which does NOT match because it's a return, not an
	// assignment to a bare identifier.
	const codeLines = src.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"));
	const code = codeLines.join("\n");

	const hackPattern = /=\s*\{\s*\.\.\.manifest,\s*status:\s*"running"\s*\}/;
	assert.doesNotMatch(
		code,
		hackPattern,
		'RT-13: the raw spread hack `= { ...manifest, status: "running" }` must not appear in team-runner.ts',
	);
});

test("[RT-13] setRunStatusRunning helper is defined and exported", () => {
	const srcPath = path.resolve(import.meta.dirname, "../../../src/runtime/team-runner.ts");
	const src = fs.readFileSync(srcPath, "utf-8");

	// The helper function must exist.
	assert.match(src, /export function setRunStatusRunning/, "setRunStatusRunning must be exported from team-runner.ts");
	// It must use canTransitionRunStatus for validation.
	assert.match(
		src,
		/canTransitionRunStatus\(manifest\.status,\s*"running"\)/,
		"setRunStatusRunning must validate via canTransitionRunStatus",
	);
});

test("[RT-13] setRunStatusRunning is called in the cancellation path (not dead code)", () => {
	const srcPath = path.resolve(import.meta.dirname, "../../../src/runtime/team-runner.ts");
	const src = fs.readFileSync(srcPath, "utf-8");

	// The cancellation path must call setRunStatusRunning instead of the raw spread.
	assert.match(src, /manifest = setRunStatusRunning\(manifest\)/, "cancellation path must call setRunStatusRunning(manifest)");
});

// ─── RT-15: structural pin — redundant forward-syncs removed ───────

test("[RT-15] ctx.tasks forward-sync count in loop body is reduced to 1 (top-of-loop only)", () => {
	const srcPath = path.resolve(import.meta.dirname, "../../../src/runtime/team-runner.ts");
	const src = fs.readFileSync(srcPath, "utf-8");

	// Extract the executeTeamRunCore loop body. The loop starts after the ctx
	// initialization block and the `try {` statement.
	const loopStart = src.indexOf('while (tasks.some((task) => task.status === "queued")');
	assert.ok(loopStart > 0, "could not find the scheduler while-loop");

	// Find the matching end of the while body (the finalizeRun call after the loop).
	const finalizeIdx = src.indexOf("const finalResult = await finalizeRun(ctx);", loopStart);
	assert.ok(finalizeIdx > 0, "could not find finalizeRun after the loop");

	const loopBody = src.slice(loopStart, finalizeIdx);

	// Count forward-sync assignments of ctx.tasks = tasks within the loop body.
	// The ONLY one should be the top-of-loop full sync.
	const forwardSyncs = loopBody.match(/^\t+ctx\.tasks = tasks;\s*$/gm) ?? [];
	assert.equal(
		forwardSyncs.length,
		1,
		`RT-15: expected exactly 1 forward-sync of ctx.tasks in the loop body (top-of-loop), found ${forwardSyncs.length}`,
	);
});

test("[RT-15] ctx.manifest forward-sync count in loop body is reduced to 1 (top-of-loop only)", () => {
	const srcPath = path.resolve(import.meta.dirname, "../../../src/runtime/team-runner.ts");
	const src = fs.readFileSync(srcPath, "utf-8");

	const loopStart = src.indexOf('while (tasks.some((task) => task.status === "queued")');
	const finalizeIdx = src.indexOf("const finalResult = await finalizeRun(ctx);", loopStart);
	const loopBody = src.slice(loopStart, finalizeIdx);

	const forwardSyncs = loopBody.match(/^\t+ctx\.manifest = manifest;\s*$/gm) ?? [];
	assert.equal(
		forwardSyncs.length,
		1,
		`RT-15: expected exactly 1 forward-sync of ctx.manifest in the loop body (top-of-loop), found ${forwardSyncs.length}`,
	);
});
