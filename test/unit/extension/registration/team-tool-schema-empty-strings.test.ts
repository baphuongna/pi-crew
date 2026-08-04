import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Compile } from "typebox/compile";
import { TeamToolParams } from "../../../../src/schema/team-tool-schema.ts";

/** pi-ai validateToolArguments uses Compile (same as typebox/compile) + Value.Convert. */
const validator = Compile(TeamToolParams);

/**
 * Calling models (esp. deepseek-via-commandcode) emit EVERY schema key with a
 * default value — including "" for enum/union/pattern fields. pi-ai validates
 * tool args BEFORE the pi-crew handler runs (validateToolArguments in
 * @earendil-works/pi-ai), so the schema itself must accept empty strings as
 * "unset". These tests lock that contract.
 */
describe("team-tool schema accepts empty-string model defaults", () => {
	const emptyParams = {
		action: "run",
		resource: "",
		team: "fast-fix",
		workflow: "fast-fix",
		role: "",
		agent: "",
		goal: "Test goal",
		chain: "",
		task: "",
		singleAgent: false,
		runId: "",
		taskId: "",
		message: "",
		async: false,
		details: false,
		workspaceMode: "",
		context: "",
		cwd: "",
		model: "deepseek/deepseek-v4-flash",
		skill: "",
		scope: "",
		config: {},
		dryRun: false,
		confirm: false,
		force: false,
		keep: false,
		updateReferences: false,
		replyTo: "",
		replyFrom: "",
		replyDeadline: 0,
		planPath: "",
		subAction: "",
		jobId: "",
		cron: "",
		interval: 0,
		once: false,
		excludeContextBash: false,
		budgetTotal: 0,
		budgetUnlimited: false,
		budgetWarning: 0,
		budgetAbort: 0,
		runKind: "",
		tokenBudget: 0,
		args: {},
		analysis: "",
		analysisPath: "",
		focus: "",
	};

	it("accepts the full model-generated empty-string blob (action=run)", () => {
		assert.equal(validator.Check(emptyParams), true);
	});

	it("accepts empty strings for every union/pattern field", () => {
		const probes: Array<[string, unknown]> = [
			["resource", ""],
			["runId", ""],
			["workspaceMode", ""],
			["context", ""],
			["scope", ""],
			["runKind", ""],
			["action", ""],
		];
		for (const [key, val] of probes) {
			const single = { action: "list", [key]: val };
			assert.equal(validator.Check(single), true, `field ${key}=${JSON.stringify(val)} should be accepted`);
		}
	});

	it('action="" defaults to list (accepted, handler treats as omitted)', () => {
		assert.equal(validator.Check({ action: "", goal: "x" }), true);
	});

	it("still rejects genuinely invalid non-empty values", () => {
		assert.equal(validator.Check({ action: "run", workspaceMode: "nonsense" }), false);
		assert.equal(validator.Check({ action: "run", context: "bad" }), false);
		assert.equal(validator.Check({ action: "run", scope: "nope" }), false);
		assert.equal(validator.Check({ action: "run", runId: "!!bad!!" }), false);
		assert.equal(validator.Check({ action: "run", resource: "default" }), false);
	});

	it("still rejects invalid action values", () => {
		assert.equal(validator.Check({ action: "explode" }), false);
		assert.equal(validator.Check({ action: 42 }), false);
	});

	// pi-ai coercion stringifies numeric values when a Union has a string-literal
	// branch (Literal("")) — e.g. interval:0 arrives as "0". The schema accepts
	// these stringified forms (numeric-string pattern branch) so validateToolArguments
	// passes; handleTeamTool coerces them back to numbers before handlers run.
	it("accepts stringified numbers for numeric-union fields (pi-ai coercion)", () => {
		assert.equal(validator.Check({ action: "prune", interval: "0" }), true);
		assert.equal(validator.Check({ action: "prune", interval: "5000" }), true);
		assert.equal(validator.Check({ action: "run", goal: "x", budgetWarning: "0.8" }), true);
		assert.equal(validator.Check({ action: "run", goal: "x", budgetAbort: "0.95" }), true);
		assert.equal(validator.Check({ action: "run", goal: "x", tokenBudget: "5000" }), true);
		assert.equal(validator.Check({ action: "respond", replyDeadline: "1234567890" }), true);
	});

	it("rejects non-numeric strings for numeric-union fields", () => {
		assert.equal(validator.Check({ action: "prune", interval: "abc" }), false);
		assert.equal(validator.Check({ action: "run", goal: "x", budgetWarning: "high" }), false);
		assert.equal(validator.Check({ action: "respond", replyDeadline: "soon" }), false);
	});

	it("accepts a chain-only payload (chain set, goal omitted)", () => {
		// Real calling models emit chain-only payloads (no goal) for chain runs.
		// Regression: chain dispatch lives at run.ts before goal validation.
		assert.equal(validator.Check({ action: "run", chain: '"Echo" -> "Read"' }), true);
	});
});
