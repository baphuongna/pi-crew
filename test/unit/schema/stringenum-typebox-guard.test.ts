/**
 * stringenum-typebox-guard.test.ts — guard for the v0.9.57→0.9.58 load crash.
 *
 * Background: pi-crew@0.9.57 called `TypeRegistry.Set("StringEnum", ...)` at
 * module top-level. TypeRegistry only exists in @sinclair/typebox >= 0.34.50.
 * Pi installs ALL extensions into ONE shared npm store with hoisted deps, and
 * on update it only re-checks the extension's own package.json version — if
 * pi-crew is already latest, it does NOT re-resolve transitive deps. So an
 * install could land pi-crew@0.9.57 (needs TypeRegistry) over a stale hoisted
 * @sinclair/typebox@0.34.49 (no TypeRegistry). Under ESM↔CJS interop,
 * `import { TypeRegistry }` then resolves to `undefined`, and the unguarded
 * top-level `TypeRegistry.Set(...)` crashed extension load:
 *   "Cannot read properties of undefined (reading 'Set')"
 *
 * team-tool-schema.ts now feature-detects TypeRegistry (HAS_TYPE_REGISTRY) and
 * buildStringEnum() falls back to a verbose-but-validating anyOf-of-literals
 * when it is absent, so the extension ALWAYS loads. This test exercises BOTH
 * branches against the real typebox Type/Value, proving the fallback validates
 * even with the registry path disabled — i.e. the exact condition that crashed.
 *
 * Run: `env -u PI_CREW_KIND -u PI_CREW_RUN_ID npx tsx --test test/unit/schema/stringenum-typebox-guard.test.ts`
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import { buildStringEnum, HAS_TYPE_REGISTRY } from "../../../src/schema/team-tool-schema.ts";

const VALUES = ["run", "status", "list"] as const;

test("HAS_TYPE_REGISTRY is detected true in an env that exports TypeRegistry", () => {
	// Sanity: the dev/test typebox DOES export TypeRegistry.Set — proves the
	// detector resolves correctly when the API is present.
	assert.equal(HAS_TYPE_REGISTRY, true, "typebox in this env should expose TypeRegistry.Set");
});

test("registry branch produces the compact { type:'string', enum:[...] } form and validates", () => {
	const schema = buildStringEnum(VALUES, "an action", { hasRegistry: true });
	assert.equal((schema as { type?: string }).type, "string");
	const enumVals = (schema as { enum?: unknown[] }).enum;
	assert.ok(Array.isArray(enumVals), "registry branch emits `enum`");
	assert.ok(enumVals?.includes("") && enumVals?.includes("run"), "enum includes '' marker + members");

	// Value.Check needs the "StringEnum" kind, registered at module load.
	assert.equal(Value.Check(schema, "run"), true);
	assert.equal(Value.Check(schema, "list"), true);
	assert.equal(Value.Check(schema, ""), true, "'' is the unset marker — accepted");
	assert.equal(Value.Check(schema, "nonsense"), false);
	assert.equal(Value.Check(schema, 42), false);
});

test("fallback branch (no TypeRegistry — stale hoisted typebox) validates via anyOf", () => {
	// Simulates the v0.9.57 crash env: typebox present but TypeRegistry missing.
	const schema = buildStringEnum(VALUES, "an action", { hasRegistry: false });
	assert.ok(Array.isArray((schema as { anyOf?: unknown[] }).anyOf), "fallback uses anyOf of literals");

	assert.equal(Value.Check(schema, "run"), true);
	assert.equal(Value.Check(schema, "list"), true);
	assert.equal(Value.Check(schema, ""), true, "'' is the unset marker — accepted");
	assert.equal(Value.Check(schema, "nonsense"), false);
	assert.equal(Value.Check(schema, 42), false);
});

test("both branches agree on every value (behavioral parity for Value.Check)", () => {
	const reg = buildStringEnum(VALUES, "d", { hasRegistry: true });
	const fall = buildStringEnum(VALUES, "d", { hasRegistry: false });
	for (const v of ["", "run", "status", "list"]) {
		assert.equal(Value.Check(reg, v), true, `registry should accept ${JSON.stringify(v)}`);
		assert.equal(Value.Check(fall, v), true, `fallback should accept ${JSON.stringify(v)}`);
	}
	for (const bad of ["RUN", "run ", "x", null, 1, undefined, {}, []]) {
		assert.equal(Value.Check(reg, bad), false, `registry should reject ${JSON.stringify(bad)}`);
		assert.equal(Value.Check(fall, bad), false, `fallback should reject ${JSON.stringify(bad)}`);
	}
});

test("TeamToolParams still validates a representative call regardless of branch", async () => {
	// Imports the full schema (which uses buildStringEnum internally). Under the
	// current env HAS_TYPE_REGISTRY is true, so this exercises the registry path
	// end-to-end. The fallback is covered by the isolated buildStringEnum tests above.
	const { TeamToolParams } = await import("../../../src/schema/team-tool-schema.ts");
	assert.equal(Value.Check(TeamToolParams, { action: "list" }), true);
	assert.equal(Value.Check(TeamToolParams, { action: "" }), true, "empty action allowed (defaults to list)");
	assert.equal(Value.Check(TeamToolParams, { action: "run", goal: "g" }), true);
	assert.equal(Value.Check(TeamToolParams, { action: "nope" }), false);
});
