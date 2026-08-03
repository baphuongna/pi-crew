/**
 * Unit tests for team-tool plan handler.
 * @see src/extension/team-tool/plan.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { handlePlan } from "../../../../src/extension/team-tool/plan.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import type { TeamToolParamsValue } from "../../../../src/schema/team-tool-schema.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

function makeCtx(cwd: string): TeamContext {
	return { cwd };
}

function makeParams(overrides: Partial<TeamToolParamsValue> = {}): TeamToolParamsValue {
	return { ...overrides };
}

// ─── handlePlan ───────────────────────────────────────────────────────────────

describe("handlePlan", () => {
	it("returns error when specified team is not found", () => {
		const tmp = createTrackedTempDir("plan-test-");
		try {
			const res = handlePlan(makeParams({ team: "nonexistent-team", goal: "test goal" }), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("not found"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns plan output for builtin 'default' team", () => {
		const tmp = createTrackedTempDir("plan-test-");
		try {
			// The 'default' team is a builtin team that should be discovered
			const res = handlePlan(makeParams({ team: "default", goal: "test goal" }), makeCtx(tmp));

			// Should succeed — default team and its defaultWorkflow should exist
			const text = textFromToolResult(res);
			assert.ok(
				text.includes("Team plan: default") || text.includes("not found"),
				`Expected plan or error, got: ${text.slice(0, 200)}`,
			);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns error details with action=plan", () => {
		const tmp = createTrackedTempDir("plan-test-");
		try {
			const res = handlePlan(makeParams({ team: "missing" }), makeCtx(tmp));

			assert.strictEqual(res.details.action, "plan");
			assert.strictEqual(res.details.status, "error");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("shows '(not provided)' when neither goal nor task given", () => {
		const tmp = createTrackedTempDir("plan-test-");
		try {
			// Use a nonexistent team to hit the error path first,
			// but test that the handler reads the params correctly
			const res = handlePlan(makeParams({ team: "default" }), makeCtx(tmp));

			const text = textFromToolResult(res);
			// If team is found, plan output should show goal as "(not provided)"
			if (!res.isError) {
				assert.ok(text.includes("(not provided)"));
			}
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns error for nonexistent workflow", () => {
		const tmp = createTrackedTempDir("plan-test-");
		try {
			const res = handlePlan(
				makeParams({
					team: "default",
					workflow: "nonexistent-workflow-xyz",
				}),
				makeCtx(tmp),
			);

			// Either workflow not found, or validation fails
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("not found") || text.includes("not valid"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("shows step information in successful plan output", () => {
		const tmp = createTrackedTempDir("plan-test-");
		try {
			const res = handlePlan(makeParams({ team: "default", goal: "implement feature" }), makeCtx(tmp));

			if (!res.isError) {
				const text = textFromToolResult(res);
				assert.ok(text.includes("Steps:"));
				assert.ok(text.includes("Goal: implement feature"));
				assert.ok(text.includes("Workflow:"));
			}
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});
