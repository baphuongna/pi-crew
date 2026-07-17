import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../../src/config/config.ts";

/**
 * Regression for CFG-1 (config type↔parser↔schema drift).
 *
 * These 11 fields were declared in `types.ts` (and most read by runtime) but
 * silently dropped by `parseConfig` / absent from the TypeBox schema — so user
 * settings were ignored without warning. They are now wired into the parsers
 * AND the schema (`additionalProperties: false` requires both). This test
 * feeds a distinctive value for each and asserts it survives parsing.
 *
 * NOTE: `autonomous.excludeContextBash` is a known dead type (no runtime
 * reader) and is intentionally NOT wired — not covered here.
 */
test("parseConfig preserves previously-phantom config fields (CFG-1)", () => {
	const parsed = parseConfig({
		ignoreMethod: "exclude",
		reliability: {
			autoRepairIntervalMs: 120000,
			forcePreflight: true,
			ambientStatusInjection: false,
			perWriteValidation: false,
			scopeModels: true,
		},
		limits: { serializeOnPathOverlap: true },
		runtime: {
			yield: { enabled: true, maxReminders: 5, reminderPrompt: "ping" },
			excludeContextBash: true,
		},
		ui: { autoCloseDashboardMs: 9999 },
	});

	assert.equal(parsed.ignoreMethod, "exclude");
	assert.equal(parsed.reliability?.autoRepairIntervalMs, 120000);
	assert.equal(parsed.reliability?.forcePreflight, true);
	assert.equal(parsed.reliability?.ambientStatusInjection, false);
	assert.equal(parsed.reliability?.perWriteValidation, false);
	assert.equal(parsed.reliability?.scopeModels, true);
	assert.equal(parsed.limits?.serializeOnPathOverlap, true);
	assert.equal(parsed.runtime?.yield?.enabled, true);
	assert.equal(parsed.runtime?.yield?.maxReminders, 5);
	assert.equal(parsed.runtime?.yield?.reminderPrompt, "ping");
	assert.equal(parsed.runtime?.excludeContextBash, true);
	assert.equal(parsed.ui?.autoCloseDashboardMs, 9999);
});

test("parseConfig still drops unknown/invalid values for the formerly-phantom fields", () => {
	// Type-mismatched values must be rejected (undefined), not passed through.
	const parsed = parseConfig({
		reliability: { autoRepairIntervalMs: "soon", scopeModels: "yes" },
		ignoreMethod: "something-else",
	});
	assert.equal(parsed.reliability?.autoRepairIntervalMs, undefined);
	assert.equal(parsed.reliability?.scopeModels, undefined);
	assert.equal(parsed.ignoreMethod, undefined);
});

test("defaults are unchanged when formerly-phantom fields are absent", () => {
	// Empty config → no phantom fields present (readers apply their own defaults).
	const parsed = parseConfig({});
	assert.equal(parsed.reliability?.autoRepairIntervalMs, undefined);
	assert.equal(parsed.reliability?.scopeModels, undefined);
	assert.equal(parsed.limits?.serializeOnPathOverlap, undefined);
	assert.equal(parsed.ignoreMethod, undefined);
});
