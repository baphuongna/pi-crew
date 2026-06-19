/**
 * Regression test for review finding P0-3: the 6 new actions (goal, workflow-*)
 * must be accepted by the RUNTIME TypeBox schema (not just the TS interface).
 * Previously only added to TeamToolParamsValue interface → Pi's schema validation
 * rejected them at the tool boundary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";
import { TeamToolParams } from "../../src/schema/team-tool-schema.ts";

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
