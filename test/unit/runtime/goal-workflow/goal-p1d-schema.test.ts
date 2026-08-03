/**
 * Unit tests for P1d budget schema changes (RFC v0.5 §P1d).
 *
 * Verifies:
 *   - schema rejects budgetTotal:500 (below the 1000 minimum)
 *   - schema accepts budgetTotal:1000
 *   - schema accepts budgetUnlimited:true
 *
 * Validation is done with ajv (the project's actual JSON-Schema validator —
 * see src/runtime/yield-handler.ts), because `Value.Check` over the whole
 * TeamToolParams throws on its `Type.Unsafe` constructs (SkillOverride etc.).
 *
 * NOTE: the goal-start validation (requires budgetTotal>=1000 OR
 * budgetUnlimited:true) is a LATER integration task — this test only covers
 * the schema definition changes (minimum raised to 1000 + budgetUnlimited
 * accepted as an optional boolean).
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { TeamToolParams } from "../../../../src/schema/team-tool-schema.ts";

// Hoist ajv (a pi-ai hoisted dependency; used by src/runtime/yield-handler.ts).
// Pattern copied verbatim from yield-handler.ts: cast the dynamic import to a
// constructor type. The untyped cast is needed because the static `default`
// export is typed as a namespace, not a class.
type AjvCtor = new (
	opts: Record<string, unknown>,
) => {
	compile: (schema: unknown) => (data: unknown) => boolean;
};
type AjvValidator = (data: unknown) => boolean;
let validate: AjvValidator | undefined;

before(async () => {
	const mod = await import("ajv");
	const AjvCtor = "default" in mod ? (mod as unknown as { default: AjvCtor }).default : (mod as unknown as AjvCtor);
	const ajv = new AjvCtor({ allErrors: true, strict: false, logger: false });
	const compiled = ajv.compile(TeamToolParams as unknown as Record<string, unknown>);
	validate = compiled as AjvValidator;
});

function valid(input: Record<string, unknown>): boolean {
	if (!validate) throw new Error("ajv not initialized");
	return validate(input);
}

/** Minimal valid base config with budget fields at top level (schema is flat). */
function baseWith(extra: Record<string, unknown>): Record<string, unknown> {
	return { action: "run", config: { objective: "x" }, ...extra };
}

describe("P1d budgetTotal minimum floor (1000)", () => {
	it("rejects budgetTotal:500 (below the 1000 minimum)", () => {
		assert.equal(valid(baseWith({ budgetTotal: 500 })), false, "budgetTotal:500 must fail schema validation (minimum is 1000)");
	});

	it("rejects budgetTotal:1 (the old minimum, now too low)", () => {
		assert.equal(
			valid(baseWith({ budgetTotal: 1 })),
			false,
			"budgetTotal:1 must fail schema validation after the floor was raised to 1000",
		);
	});

	it("accepts budgetTotal:1000 (exactly the new minimum)", () => {
		assert.equal(valid(baseWith({ budgetTotal: 1000 })), true, "budgetTotal:1000 must pass schema validation");
	});

	it("accepts budgetTotal well above the minimum", () => {
		assert.equal(valid(baseWith({ budgetTotal: 500_000 })), true);
	});

	it("accepts a run without any budget field (budget is optional in the schema)", () => {
		// The goal-start "required" rule is a LATER integration task; the schema
		// itself still marks both budgetTotal and budgetUnlimited as Optional.
		assert.equal(valid(baseWith({})), true);
	});
});

describe("P1d budgetUnlimited opt-out", () => {
	it("accepts budgetUnlimited:true", () => {
		assert.equal(valid(baseWith({ budgetUnlimited: true })), true, "budgetUnlimited:true must pass schema validation");
	});

	it("accepts budgetUnlimited:false", () => {
		assert.equal(valid(baseWith({ budgetUnlimited: false })), true);
	});

	it("rejects budgetUnlimited as a non-boolean", () => {
		assert.equal(valid(baseWith({ budgetUnlimited: "yes" })), false, "budgetUnlimited must be a boolean");
	});

	it("accepts budgetUnlimited:true together with budgetTotal:1000", () => {
		assert.equal(valid(baseWith({ budgetUnlimited: true, budgetTotal: 1000 })), true);
	});
});
