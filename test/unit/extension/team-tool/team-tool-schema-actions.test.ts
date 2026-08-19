/**
 * Regression test for review finding P0-3: the 6 new actions (goal, workflow-*)
 * must be accepted by the RUNTIME TypeBox schema (not just the TS interface).
 * Previously only added to TeamToolParamsValue interface → Pi's schema validation
 * rejected them at the tool boundary.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import { allActionLiterals, TeamToolParams } from "../../../../src/schema/team-tool-schema.ts";

const NEW_ACTIONS = ["goal", "workflow-create", "workflow-get", "workflow-list", "workflow-save", "workflow-delete"] as const;
const EXISTING_ACTIONS = ["run", "list", "status", "plan"] as const;

test("TypeBox TeamToolParams accepts all 6 new actions (Fix P0-3)", () => {
	for (const action of NEW_ACTIONS) {
		assert.equal(Value.Check(TeamToolParams, { action }), true, `action '${action}' must be schema-valid`);
	}
});

test("TypeBox TeamToolParams still accepts existing actions (no regression)", () => {
	for (const action of EXISTING_ACTIONS) {
		assert.equal(Value.Check(TeamToolParams, { action }), true, `action '${action}' must remain schema-valid`);
	}
});

test("TypeBox TeamToolParams rejects unknown actions (validation still works)", () => {
	assert.equal(Value.Check(TeamToolParams, { action: "nonexistent-action" }), false, "unknown action must be rejected");
});

test("flat schema enumerates all 55 actions (allActionLiterals derivation guard)", () => {
	// 10 (run, incl. 'plans' T2/R4 ADR-4) + 16 (status) + 7 (control) + 16 (manage) + 6 (automate) = 55.
	// Guards the .flatMap(set.anyOf ?? []) derivation: if a domain set's structure
	// changes and the flatten drops literals, this fails. Update the expected
	// count if a new action is added.
	assert.equal(allActionLiterals.length, 55, `expected 55 action literals, got ${allActionLiterals.length}`);
	const consts = allActionLiterals.map((l) => (l as { const?: string }).const).filter((c): c is string => c !== undefined);
	assert.equal(new Set(consts).size, consts.length, "duplicate action literals in flat schema");
});
