/**
 * stringenum-fallback-composition.test.ts — closes the integrated-fallback gap
 * flagged by the v0.9.58 review (Reviewer 1, item 6).
 *
 * The sibling `stringenum-typebox-guard.test.ts` proves `buildStringEnum({...})`
 * validates in BOTH branches in isolation. But the module-level
 * `HAS_TYPE_REGISTRY` is `true` in the test env, so the real `TeamToolParams` is
 * always built via the REGISTRY (compact-enum) branch. The integrated FALLBACK —
 * a full Object schema whose `action` field is a verbose `Type.Union`/`anyOf`,
 * composed with other fields + `additionalProperties` — was only proven by
 * reasoning + ad-hoc probes, not by an automated regression test.
 *
 * This test builds a TeamToolParams-shaped schema ENTIRELY in fallback mode via
 * the exported `buildStringEnum(..., { hasRegistry: false })` and validates it
 * through `Value.Check`, plus asserts the `anyOf` SHAPE that `allActionLiterals`
 * depends on (`set.anyOf ?? set.enum.map(...)`) is produced by the fallback. This
 * guards against a future refactor silently breaking fallback composition.
 *
 * Deliberately self-contained: no `mock.module` (experimental/churns across Node
 * versions) and no production refactor — uses only existing exports.
 *
 * Run: `env -u PI_CREW_KIND -u PI_CREW_RUN_ID npx tsx --test test/unit/schema/stringenum-fallback-composition.test.ts`
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { buildStringEnum } from "../../../src/schema/team-tool-schema.ts";

const ACTIONS = ["run", "parallel", "status", "list", "get", "cancel"] as const;

// A TeamToolParams-shaped schema built ENTIRELY in fallback mode (anyOf action
// enum), mirroring how the module constructs TeamToolParams when
// HAS_TYPE_REGISTRY === false (stale hoisted typebox < 0.34.50).
const FallbackParams = Type.Object(
	{
		action: Type.Optional(buildStringEnum(ACTIONS, "Team action. Defaults to 'list' when omitted.", { hasRegistry: false })),
		goal: Type.Optional(Type.String({ description: "Objective." })),
		team: Type.Optional(Type.String({ description: "Team name." })),
	},
	{ additionalProperties: true },
);

test("fallback composition: valid actions pass Value.Check through Object+Optional wrapping", () => {
	assert.equal(Value.Check(FallbackParams, { action: "run" }), true);
	assert.equal(Value.Check(FallbackParams, { action: "list" }), true);
	assert.equal(Value.Check(FallbackParams, { action: "", goal: "g", team: "default" }), true, "empty unset marker + extra fields OK");
});

test("fallback composition: invalid actions/values are rejected", () => {
	assert.equal(Value.Check(FallbackParams, { action: "bogus" }), false);
	assert.equal(Value.Check(FallbackParams, { action: 42 }), false);
	assert.equal(Value.Check(FallbackParams, { action: null }), false);
});

test("fallback branch produces the `anyOf` shape that allActionLiterals depends on", () => {
	// allActionLiterals reads `set.anyOf ?? set.enum.map(...)`. The registry
	// branch yields `enum`; the fallback branch MUST yield `anyOf` (of literals)
	// so the same extraction works. This asserts the contract without needing to
	// rebuild the production module in fallback mode.
	const fallbackSet = Type.Optional(buildStringEnum(ACTIONS, "d", { hasRegistry: false })) as unknown as {
		anyOf?: unknown;
		enum?: unknown;
	};
	assert.ok(Array.isArray(fallbackSet.anyOf), "fallback action set must expose `anyOf`");
	assert.equal(Array.isArray(fallbackSet.enum), false, "fallback action set must NOT use compact `enum`");

	// Mirror allActionLiterals' extraction over the fallback shape:
	const extracted = ((fallbackSet.anyOf as { const: string }[] | undefined) ??
		(Array.isArray(fallbackSet.enum) ? fallbackSet.enum.map((v) => ({ const: v })) : []) ??
		[])
		.map((l) => l.const)
		.filter((c) => c !== "");
	assert.deepEqual(extracted, [...ACTIONS], "all actions extracted, '' unset marker excluded");
});

test("fallback and registry branches agree on the action value set", () => {
	for (const v of ["", ...ACTIONS]) {
		const reg = buildStringEnum(ACTIONS, "d", { hasRegistry: true });
		const fall = buildStringEnum(ACTIONS, "d", { hasRegistry: false });
		assert.equal(Value.Check(reg, v), true);
		assert.equal(Value.Check(fall, v), true);
	}
	assert.equal(Value.Check(buildStringEnum(ACTIONS, "d", { hasRegistry: false }), "nope"), false);
});
