import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "@sinclair/typebox/value";
import { normalizeTeamParams } from "../../../../src/extension/registration/team-tool.ts";
import { TeamToolParams } from "../../../../src/schema/team-tool-schema.ts";

describe("normalizeTeamParams — empty-string model defaults", () => {
	it("drops empty-string values for union/pattern fields (runId, workspaceMode, context, scope)", () => {
		const raw = {
			action: "status",
			runId: "",
			workspaceMode: "",
			context: "",
			scope: "",
			resource: "",
			details: true,
		};
		const normalized = normalizeTeamParams(raw) as Record<string, unknown>;
		assert.equal("runId" in normalized, false);
		assert.equal("workspaceMode" in normalized, false);
		assert.equal("context" in normalized, false);
		assert.equal("scope" in normalized, false);
		assert.equal("resource" in normalized, false);
		assert.equal(normalized.action, "status");
		assert.equal(normalized.details, true);
	});

	it("passes validation after normalization (schema now accepts empty strings too)", () => {
		const raw = {
			action: "status",
			runId: "",
			workspaceMode: "",
			context: "",
			scope: "",
			details: true,
		};
		// Schema-level accept (pi-ai validates BEFORE handler — schema must be lenient)
		assert.equal(Value.Check(TeamToolParams, raw), true, "schema now accepts empty strings directly");
		// Handler-level normalize still drops them so downstream logic sees clean params
		const normalized = normalizeTeamParams(raw) as Record<string, unknown>;
		assert.equal("runId" in normalized, false);
		assert.equal("workspaceMode" in normalized, false);
		assert.equal(Value.Check(TeamToolParams, normalized), true);
	});

	it("preserves non-empty strings, booleans, numbers, arrays, objects verbatim", () => {
		const raw = {
			action: "run",
			goal: "  real goal  ",
			team: "default",
			runId: "team_abc123",
			workspaceMode: "worktree",
			details: false,
			interval: 0,
			async: false,
			config: { foo: 1 },
			skill: ["a", "b"],
		};
		const normalized = normalizeTeamParams(raw) as Record<string, unknown>;
		assert.equal(normalized.goal, "  real goal  "); // non-empty kept even with spaces
		assert.equal(normalized.team, "default");
		assert.equal(normalized.runId, "team_abc123");
		assert.equal(normalized.workspaceMode, "worktree");
		assert.equal(normalized.details, false);
		assert.equal(normalized.interval, 0);
		assert.deepEqual(normalized.config, { foo: 1 });
		assert.deepEqual(normalized.skill, ["a", "b"]);
	});

	it("returns non-object inputs untouched", () => {
		assert.equal(normalizeTeamParams(null), null);
		assert.equal(normalizeTeamParams(undefined), undefined);
		assert.equal(normalizeTeamParams("str"), "str");
		assert.deepEqual(normalizeTeamParams([1, 2]), [1, 2]);
	});

	it("still rejects genuinely invalid non-empty values (no silent pass-through)", () => {
		const normalized = normalizeTeamParams({ action: "run", workspaceMode: "nonsense" });
		assert.equal(Value.Check(TeamToolParams, normalized), false, "invalid non-empty literal should still fail");
	});

	it("empty-string action is dropped, making params valid only if action omitted elsewhere", () => {
		// action:"" dropped → defaults to "list" in handler; schema-level check should pass
		const normalized = normalizeTeamParams({ action: "", goal: "x" });
		assert.equal(Value.Check(TeamToolParams, normalized), true);
		assert.equal("action" in (normalized as Record<string, unknown>), false);
	});
});
