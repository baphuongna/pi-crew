import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import { __test__mergeConfig, parseConfig } from "../../../src/config/config.ts";
import { PiTeamsConfigSchema } from "../../../src/schema/config-schema.ts";

/**
 * Round 19 Part A parity fixes (schema = parser = read), behavior-preserving:
 * - F19-1 runtime.modelFallback: parsed + deep-merged (was declared in types.ts
 *   and the schema, but parseRuntimeConfig never emitted it — user config was
 *   silently inert).
 * - F19-2 reliability.retryPolicy.maxTotalSpawns: parsed + read, but the schema
 *   (additionalProperties:false) rejected it — schema-side phantom.
 * - F19-3 control.consecutiveFailureThreshold / control.longRunningMinutes:
 *   read at agent-control.ts (defaults 3/10) but absent from schema AND parser
 *   — parser-side phantom. Unset MUST stay undefined so the read-site defaults
 *   remain authoritative.
 */

// ---------------------------------------------------------------------------
// F19-1: runtime.modelFallback parse parity
// ---------------------------------------------------------------------------

test("F19-1: parseConfig emits runtime.modelFallback and round-trips all fields", () => {
	const parsed = parseConfig({
		runtime: {
			modelFallback: {
				maxAutoFallbacks: 2,
				order: "parentFirst",
				requireCredentials: true,
				quotaAwareOrdering: false,
				defaultSubagentModel: "zaic/glm-5.2",
			},
		},
	});
	assert.ok(parsed.runtime?.modelFallback, "runtime.modelFallback must be an object, not undefined");
	assert.equal(parsed.runtime.modelFallback.maxAutoFallbacks, 2);
	assert.equal(parsed.runtime.modelFallback.order, "parentFirst");
	assert.equal(parsed.runtime.modelFallback.requireCredentials, true);
	assert.equal(parsed.runtime.modelFallback.quotaAwareOrdering, false);
	assert.equal(parsed.runtime.modelFallback.defaultSubagentModel, "zaic/glm-5.2");
});

test("F19-1: parseConfig drops invalid modelFallback values instead of passing them through", () => {
	const parsed = parseConfig({
		runtime: {
			modelFallback: { maxAutoFallbacks: -1, order: "bogus", defaultSubagentModel: "" },
		},
	});
	// Every field fails its schema bound → helper collapses to undefined.
	assert.equal(parsed.runtime?.modelFallback, undefined);
});

test("F19-1: modelFallback stays undefined when absent (defaults untouched)", () => {
	const parsed = parseConfig({ runtime: { maxTurns: 12 } });
	assert.equal(parsed.runtime?.modelFallback, undefined);
});

// ---------------------------------------------------------------------------
// F19-1: runtime.modelFallback merge parity (user-wins, nested)
// ---------------------------------------------------------------------------

test("F19-1: mergeConfig deep-merges runtime.modelFallback — override wins per key, base preserved", () => {
	const base = { runtime: { modelFallback: { order: "asIs" as const, maxAutoFallbacks: 5 } } };
	const override = { runtime: { modelFallback: { maxAutoFallbacks: 1 } } };
	const merged = __test__mergeConfig(base, override);
	assert.equal(merged.runtime?.modelFallback?.maxAutoFallbacks, 1, "override must win on maxAutoFallbacks");
	assert.equal(merged.runtime?.modelFallback?.order, "asIs", "base order must be preserved");
});

test("F19-1: mergeConfig keeps base modelFallback when override sets none", () => {
	const merged = __test__mergeConfig(
		{ runtime: { modelFallback: { order: "asIs" as const, maxAutoFallbacks: 5 } } },
		{ runtime: { maxTurns: 42 } },
	);
	assert.equal(merged.runtime?.modelFallback?.maxAutoFallbacks, 5);
	assert.equal(merged.runtime?.modelFallback?.order, "asIs");
	assert.equal(merged.runtime?.maxTurns, 42);
});

// ---------------------------------------------------------------------------
// F19-2: reliability.retryPolicy.maxTotalSpawns schema parity
// ---------------------------------------------------------------------------

test("F19-2: retryPolicy.maxTotalSpawns schema-validates and parses (no phantom-field drop)", () => {
	const config = { reliability: { retryPolicy: { maxTotalSpawns: 4 } } };
	// additionalProperties:false previously made this Check fail.
	assert.equal(Value.Check(PiTeamsConfigSchema, config), true, "schema must admit maxTotalSpawns");
	const parsed = parseConfig(config);
	assert.equal(parsed.reliability?.retryPolicy?.maxTotalSpawns, 4, "parser must round-trip maxTotalSpawns");
});

test("F19-2: retryPolicy.maxTotalSpawns still rejects invalid values (schema bounds)", () => {
	assert.equal(Value.Check(PiTeamsConfigSchema, { reliability: { retryPolicy: { maxTotalSpawns: -1 } } }), false);
	const parsed = parseConfig({ reliability: { retryPolicy: { maxTotalSpawns: 1.5 } } });
	assert.equal(parsed.reliability?.retryPolicy?.maxTotalSpawns, undefined, "non-integer must not pass through");
});

// ---------------------------------------------------------------------------
// F19-3: control.consecutiveFailureThreshold / longRunningMinutes parity
// ---------------------------------------------------------------------------

test("F19-3: control thresholds round-trip through schema and parser", () => {
	const config = { control: { consecutiveFailureThreshold: 5, longRunningMinutes: 20 } };
	assert.equal(Value.Check(PiTeamsConfigSchema, config), true, "schema must admit both control thresholds");
	const parsed = parseConfig(config);
	assert.equal(parsed.control?.consecutiveFailureThreshold, 5);
	assert.equal(parsed.control?.longRunningMinutes, 20);
});

test("F19-3: unset control thresholds stay undefined — read-site defaults 3/10 untouched", () => {
	const parsed = parseConfig({});
	assert.equal(parsed.control?.consecutiveFailureThreshold, undefined);
	assert.equal(parsed.control?.longRunningMinutes, undefined);
	const parsedEnabledOnly = parseConfig({ control: { enabled: true } });
	assert.equal(parsedEnabledOnly.control?.consecutiveFailureThreshold, undefined);
	assert.equal(parsedEnabledOnly.control?.longRunningMinutes, undefined);
});

test("F19-3: invalid control thresholds are dropped, siblings survive", () => {
	const parsed = parseConfig({ control: { consecutiveFailureThreshold: 0, longRunningMinutes: -5, needsAttentionAfterMs: 5000 } });
	assert.equal(parsed.control?.consecutiveFailureThreshold, undefined, "0 is below minimum 1");
	assert.equal(parsed.control?.longRunningMinutes, undefined, "negative must be dropped");
	assert.equal(parsed.control?.needsAttentionAfterMs, 5000, "sibling fields unaffected");
});
