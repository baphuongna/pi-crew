import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { abortOwned, retryShortCircuitsCompleted } from "../../../../src/extension/team-tool/cancel.ts";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";

/**
 * abortOwned is the primary pure-logic export from cancel.ts.
 * handleCancel and handleRetry require filesystem state so we test abortOwned thoroughly.
 *
 * We use isolated empty temp directories (not /tmp) for ctx.cwd so that
 * locateRunCwd's readdirSync scan is bounded and doesn't hang in CI
 * environments where /tmp has hundreds of entries.
 */
function makeEmptyCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cancel-test-"));
	return dir;
}

describe("retryShortCircuitsCompleted", () => {
	it("returns true for a completed run with all completed tasks", () => {
		assert.equal(
			retryShortCircuitsCompleted("completed", [
				{ id: "01_explore", status: "completed" },
				{ id: "02_execute", status: "completed" },
			]),
			true,
		);
	});

	it("returns false for a completed run that still has a failed task", () => {
		assert.equal(
			retryShortCircuitsCompleted("completed", [
				{ id: "01_explore", status: "completed" },
				{ id: "02_execute", status: "failed" },
			]),
			false,
		);
	});

	it("returns false for a completed run that still has a cancelled task", () => {
		assert.equal(retryShortCircuitsCompleted("completed", [{ id: "01_explore", status: "cancelled" }]), false);
	});

	it("returns false for a non-completed run regardless of task statuses", () => {
		assert.equal(retryShortCircuitsCompleted("failed", [{ id: "01", status: "failed" }]), false);
		assert.equal(retryShortCircuitsCompleted("running", [{ id: "01", status: "completed" }]), false);
		assert.equal(retryShortCircuitsCompleted("cancelled", [{ id: "01", status: "cancelled" }]), false);
	});

	it("honors targetTaskId: completed run with the targeted task completed short-circuits", () => {
		assert.equal(
			retryShortCircuitsCompleted(
				"completed",
				[
					{ id: "01_explore", status: "completed" },
					{ id: "02_execute", status: "failed" },
				],
				"01_explore",
			),
			true,
		);
	});

	it("honors targetTaskId: completed run with the targeted task failed does NOT short-circuit", () => {
		assert.equal(retryShortCircuitsCompleted("completed", [{ id: "01_explore", status: "failed" }], "01_explore"), false);
	});

	it("returns true for a completed run with no tasks", () => {
		assert.equal(retryShortCircuitsCompleted("completed", []), true);
	});
});

describe("abortOwned", () => {
	it("returns all IDs as missing when runId does not resolve to a cwd", () => {
		const ctx: TeamContext = { cwd: makeEmptyCwd() };
		const result = abortOwned("nonexistent-run", ["t1", "t2"], ctx);
		assert.deepEqual(result.missingIds, ["t1", "t2"]);
		assert.deepEqual(result.abortedIds, []);
		assert.deepEqual(result.foreignIds, []);
		fs.rmSync(ctx.cwd, { recursive: true, force: true });
	});

	it("returns empty abortedIds for non-existent run", () => {
		const ctx: TeamContext = { cwd: makeEmptyCwd() };
		const result = abortOwned("fake-run-id-12345", undefined, ctx);
		assert.deepEqual(result.abortedIds, []);
		assert.deepEqual(result.missingIds, []);
		assert.deepEqual(result.foreignIds, []);
		fs.rmSync(ctx.cwd, { recursive: true, force: true });
	});

	it("returns all IDs as missing when taskIds are provided but run not found", () => {
		const ctx: TeamContext = { cwd: makeEmptyCwd() };
		const result = abortOwned("nonexistent", ["x", "y", "z"], ctx);
		assert.deepEqual(result.missingIds, ["x", "y", "z"]);
		assert.deepEqual(result.abortedIds, []);
		fs.rmSync(ctx.cwd, { recursive: true, force: true });
	});

	it("returns empty missingIds when taskIds is undefined and run not found", () => {
		const ctx: TeamContext = { cwd: makeEmptyCwd() };
		const result = abortOwned("nonexistent", undefined, ctx);
		assert.deepEqual(result.missingIds, []);
		fs.rmSync(ctx.cwd, { recursive: true, force: true });
	});

	it("returns empty lists when cwd is an empty string", () => {
		const ctx: TeamContext = { cwd: "" };
		const result = abortOwned("any", ["t1"], ctx);
		assert.deepEqual(result.abortedIds, []);
		assert.deepEqual(result.missingIds, ["t1"]);
	});

	it("returns all IDs as missing when taskIds is empty array", () => {
		const ctx: TeamContext = { cwd: makeEmptyCwd() };
		const result = abortOwned("nonexistent", [], ctx);
		assert.deepEqual(result.missingIds, []);
		assert.deepEqual(result.abortedIds, []);
		fs.rmSync(ctx.cwd, { recursive: true, force: true });
	});
});
