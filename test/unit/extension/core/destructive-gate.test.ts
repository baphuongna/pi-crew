import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shouldBlockDestructiveTeamAction } from "../../../../src/extension/team-tool/destructive-gate.ts";

/**
 * B1 regression: `team action=cleanup dryRun=true` (a PREVIEW that writes
 * nothing) used to be blocked by the tool_call gate with "requires confirm=true",
 * forcing users to pass confirm=true just to preview. dryRun should always be
 * allowed. These tests pin the gate logic (extracted into a pure function for
 * testability — the live handler in register.ts delegates here).
 */
describe("shouldBlockDestructiveTeamAction — B1 dryRun cleanup gate", () => {
	it("allows cleanup dryRun=true WITHOUT confirm (preview writes nothing)", () => {
		assert.equal(shouldBlockDestructiveTeamAction("cleanup", { dryRun: true }), undefined);
	});

	it("allows cleanup dryRun=true even when confirm is NOT set", () => {
		// The bug: this returned a block reason before the fix.
		assert.equal(shouldBlockDestructiveTeamAction("cleanup", { dryRun: true }), undefined);
	});

	it("blocks cleanup WITHOUT dryRun and WITHOUT confirm (real cleanup needs confirm)", () => {
		const reason = shouldBlockDestructiveTeamAction("cleanup", {});
		assert.ok(reason);
		assert.match(reason!, /requires confirm=true/);
	});

	it("allows cleanup WITHOUT dryRun when confirm=true", () => {
		assert.equal(shouldBlockDestructiveTeamAction("cleanup", { confirm: true }), undefined);
	});

	it("blocks prune/forget without confirm (still destructive)", () => {
		assert.ok(shouldBlockDestructiveTeamAction("prune", {}));
		assert.ok(shouldBlockDestructiveTeamAction("forget", {}));
	});

	it("allows prune/forget with confirm=true", () => {
		assert.equal(shouldBlockDestructiveTeamAction("prune", { confirm: true }), undefined);
		assert.equal(shouldBlockDestructiveTeamAction("forget", { confirm: true }), undefined);
	});

	it("dryRun does NOT bypass confirm for non-cleanup actions (only cleanup has a dry mode)", () => {
		// prune/forget/delete have no dryRun semantics; dryRun must not leak.
		assert.ok(shouldBlockDestructiveTeamAction("prune", { dryRun: true }), "prune still blocked even with dryRun");
		assert.ok(shouldBlockDestructiveTeamAction("forget", { dryRun: true }), "forget still blocked even with dryRun");
	});

	it("allows delete with force=true (force bypasses reference checks)", () => {
		assert.equal(shouldBlockDestructiveTeamAction("delete", { force: true }), undefined);
	});

	it("blocks delete without confirm or force", () => {
		const reason = shouldBlockDestructiveTeamAction("delete", {});
		assert.ok(reason);
		assert.match(reason!, /force=true to bypass reference checks/);
	});

	it("allows non-destructive actions (run, status, list, etc.) — returns undefined", () => {
		assert.equal(shouldBlockDestructiveTeamAction("run", {}), undefined);
		assert.equal(shouldBlockDestructiveTeamAction("status", {}), undefined);
		assert.equal(shouldBlockDestructiveTeamAction("list", {}), undefined);
		assert.equal(shouldBlockDestructiveTeamAction(undefined, {}), undefined);
	});
});
