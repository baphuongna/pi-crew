import { describe, it } from "node:test";
import assert from "node:assert/strict";
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

	it("action=\"\" defaults to list (accepted, handler treats as omitted)", () => {
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
});
