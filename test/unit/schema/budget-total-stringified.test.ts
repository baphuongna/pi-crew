import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { normalizeLooseNumericFields } from "../../../src/extension/team-tool.ts";
import { TeamToolParams } from "../../../src/schema/team-tool-schema.ts";

/** The function's param type is not exported; the loose-numeric inputs we
 * exercise (stringified numbers) only exist pre-coercion, so the literals are
 * typed through this alias. */
type LooseParams = Parameters<typeof normalizeLooseNumericFields>[0];

/**
 * Regression (found live 2026-09-21): `team action='goal' budgetTotal=100000`
 * was rejected at schema validation ("must be equal to constant / must be
 * number"). pi-ai stringifies numeric tool arguments when a Union schema has a
 * string-literal branch — budgetTotal has Literal("") — so the call arrived as
 * "100000" and died at the door. Every sibling budget param
 * (budgetWarning/budgetAbort/tokenBudget/replyDeadline/interval) already
 * accepts the stringified form in-schema and coerces it back via
 * normalizeLooseNumericFields; budgetTotal was missing from BOTH lists.
 */

// Hoisted-ajv validation, same pattern as goal-p1d-schema.test.ts.
type AjvCtor = new (opts: Record<string, unknown>) => { compile: (schema: unknown) => (data: unknown) => boolean };
let validate: ((data: unknown) => boolean) | undefined;

before(async () => {
	const mod = await import("ajv");
	const Ajv = "default" in mod ? (mod as unknown as { default: AjvCtor }).default : (mod as unknown as AjvCtor);
	const ajv = new Ajv({ allErrors: true, strict: false, logger: false });
	validate = ajv.compile(TeamToolParams as unknown as Record<string, unknown>) as (data: unknown) => boolean;
});

function valid(input: Record<string, unknown>): boolean {
	if (!validate) throw new Error("ajv not initialized");
	return validate(input);
}

describe("budgetTotal stringified-number acceptance (schema)", () => {
	it('accepts budgetTotal:"100000" (pi-ai stringifies numbers on Literal("") unions)', () => {
		assert.equal(valid({ action: "goal", goal: "x", budgetTotal: "100000" }), true);
	});

	it("still accepts the plain numeric form budgetTotal:100000", () => {
		assert.equal(valid({ action: "goal", goal: "x", budgetTotal: 100_000 }), true);
	});

	it("still rejects the sub-floor NUMERIC form budgetTotal:500 (misconfig guard)", () => {
		assert.equal(valid({ action: "goal", goal: "x", budgetTotal: 500 }), false);
	});

	it('still accepts the unset markers: 0 and ""', () => {
		assert.equal(valid({ action: "goal", goal: "x", budgetTotal: 0 }), true);
		assert.equal(valid({ action: "goal", goal: "x", budgetTotal: "" }), true);
	});

	it("rejects non-numeric strings", () => {
		assert.equal(valid({ action: "goal", goal: "x", budgetTotal: "lots" }), false);
	});
});

describe("budgetTotal coercion (normalizeLooseNumericFields)", () => {
	it('coerces "100000" back to the number 100000', () => {
		const out = normalizeLooseNumericFields({ action: "goal", goal: "x", budgetTotal: "100000" } as unknown as LooseParams);
		assert.equal(out.budgetTotal, 100_000);
	});

	it('treats "" as unset (field removed)', () => {
		const out = normalizeLooseNumericFields({ action: "goal", goal: "x", budgetTotal: "" } as unknown as LooseParams);
		assert.equal("budgetTotal" in out, false);
	});

	it("drops non-numeric strings", () => {
		const out = normalizeLooseNumericFields({ action: "goal", goal: "x", budgetTotal: "abc" } as unknown as LooseParams);
		assert.equal("budgetTotal" in out, false);
	});

	it("leaves real numbers untouched", () => {
		const out = normalizeLooseNumericFields({ action: "goal", goal: "x", budgetTotal: 100_000 });
		assert.equal(out.budgetTotal, 100_000);
	});
});
