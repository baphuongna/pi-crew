import test from "node:test";
import assert from "node:assert/strict";
import { buildRecoveryLedger, recipeFor, scenarioForPolicyReason } from "../../src/runtime/recovery-recipes.ts";
import type { PolicyDecision } from "../../src/state/types.ts";

test("recovery recipes map policy reasons to deterministic steps", () => {
	assert.equal(scenarioForPolicyReason("branch_stale"), "stale_branch");
	assert.deepEqual(recipeFor("stale_branch").steps, ["rebase_branch", "clean_build"]);
	assert.deepEqual(recipeFor("green_unsatisfied").steps, ["collect_verification_evidence"]);
});

test("recovery ledger records retry/block/escalate decisions", () => {
	const decisions: PolicyDecision[] = [
		{ action: "retry", reason: "task_failed", message: "failed", taskId: "task_1", createdAt: new Date(0).toISOString() },
		{ action: "block", reason: "branch_stale", message: "stale", createdAt: new Date(0).toISOString() },
	];
	const ledger = buildRecoveryLedger(decisions);
	assert.equal(ledger.entries.length, 2);
	assert.equal(ledger.entries[0]?.scenario, "task_failed");
	assert.equal(ledger.entries[0]?.state, "planned");
	assert.equal(ledger.entries[1]?.scenario, "stale_branch");
	assert.equal(ledger.entries[1]?.state, "escalation_required");
});
