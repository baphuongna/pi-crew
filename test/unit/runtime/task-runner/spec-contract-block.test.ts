/**
 * SPEC contract prompt block tests (ADR-6 §2/§6, WP-6 steps 5-6).
 * The executor prompt must teach the EXACT footer format + frozen ids; the
 * verifier variant is advisory-only (judgment is never the security boundary).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { renderSpecContractBlock } from "../../../../src/runtime/task-runner/prompt-builder.ts";
import type { TaskPacket } from "../../../../src/state/types.ts";

function packet(overrides?: Partial<TaskPacket>): TaskPacket {
	return {
		objective: "obj",
		scope: "workspace",
		scopePath: "/repo",
		repo: "/repo",
		branchPolicy: "read-only",
		acceptanceTests: [],
		commitPolicy: "forbidden",
		reportingContract: "markdown",
		escalationPolicy: "ask",
		constraints: [],
		expectedArtifacts: [],
		verification: { requiredGreenLevel: "none", commands: [], allowManualEvidence: true },
		specRefs: ["spec-login"],
		specSnapshots: [
			{
				specId: "spec-login",
				version: 2,
				frozenAt: "2026-08-20T00:00:00.000Z",
				trustedAtFreeze: false,
				items: [
					{
						requirement: { id: "req-1", text: "login", priority: "must" },
						acceptance: { id: "acc-1", requirementId: "req-1", check: "login probe", command: "printf ok", idempotent: true },
					},
					{
						requirement: { id: "req-2", text: "error msg", priority: "should" },
						acceptance: { id: "acc-2", requirementId: "req-2", check: "error shown" },
					},
				],
			},
		],
		...overrides,
	};
}

test("executor block: frozen ids + EXACT footer format + fabrication warning", () => {
	const block = renderSpecContractBlock(packet());
	assert.ok(block.includes("<spec-contract>"));
	assert.ok(block.includes("spec-login@v2 acc-1 [MUST] login probe"), "frozen ids with spec@version + priority");
	assert.ok(block.includes("acc-2 [SHOULD] error shown"));
	assert.ok(!block.includes("(strict: machine-checked)"), "non-strict: no machine-check claim");
	assert.ok(block.includes("SPEC-EVIDENCE:"));
	assert.ok(block.includes("<acceptanceId>: <one-line evidence>"), "exact mechanical format taught");
	assert.ok(block.includes("citing anything else is fabrication"));
	assert.ok(!block.includes("VERIFIER"), "executor variant has no verifier guidance");
});

test("strict executor block: machine-check warning present", () => {
	const block = renderSpecContractBlock(packet({ specStrict: true }));
	assert.ok(block.includes("STRICT MODE"));
	assert.ok(block.includes("(strict: machine-checked)"), "idempotent items flagged machine-checked");
});

test("verifier block: advisory-only framing (§6 — judgment is never the boundary)", () => {
	const block = renderSpecContractBlock(packet(), { verifier: true });
	assert.ok(block.includes("You are the VERIFIER"));
	assert.ok(block.includes("ADVISORY ONLY"));
	assert.ok(block.includes("dependency output"), "footer arrives via dependency context — no new delivery mechanism");
});
