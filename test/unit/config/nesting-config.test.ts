/**
 * Governed-nesting config plumbing (ADR-5 §10, WP-5 step 2).
 *
 * Pins:
 * - `nesting.enabled` DEFAULT FALSE — fail-closed until the WP-5 completion
 *   gate (B3 battery + security sign-off) flips it. This is the security
 *   posture of the whole feature: the `delegate` surface must stay dormant.
 * - parse: valid blocks pass; out-of-range / wrong-typed values are dropped
 *   (never thrown as raw), matching the LIMIT_CEILINGS pattern.
 * - merge: per-key user-wins deep merge — a partial user block must NOT erase
 *   the fail-closed default (the broker wholesale-replacement bug class,
 *   WP-2/R2).
 * - `nesting.enabled` is `sensitive: true` → project-level config cannot
 *   enable delegation (privilege-raising flag, user config only).
 * - schema.json carries the same nesting sub-schema as the TypeBox schema.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { mergeConfig } from "../../../src/config/config-merge.ts";
import { parseConfig } from "../../../src/config/config-validation.ts";
import { DEFAULT_NESTING } from "../../../src/config/defaults.ts";
import { PiTeamsConfigSchema } from "../../../src/schema/config-schema.ts";
import { collectSensitiveConfigPaths } from "../../../src/schema/sensitive-config-paths.ts";

test("DEFAULT_NESTING is fail-closed: enabled=false, maxDepth=2 (ADR-5 §10)", () => {
	assert.equal(DEFAULT_NESTING.enabled, false);
	assert.equal(DEFAULT_NESTING.maxDepth, 2);
});

test("parseConfig: valid nesting block passes through", () => {
	const cfg = parseConfig({ nesting: { enabled: true, maxSlots: 4, maxDepth: 3 } });
	assert.deepEqual(cfg.nesting, { enabled: true, maxSlots: 4, maxDepth: 3 });
});

test("parseConfig: out-of-range nesting values are dropped, not clamped", () => {
	const cfg = parseConfig({ nesting: { maxSlots: 0, maxDepth: 11, enabled: "yes" } });
	// every key invalid → undefined values → whole block drops to undefined
	assert.equal(cfg.nesting, undefined);
});

test("parseConfig: maxSlots=65 and maxDepth=11 exceed ceilings and drop", () => {
	const cfg = parseConfig({ nesting: { maxSlots: 65 } });
	assert.equal(cfg.nesting, undefined);
	const cfg2 = parseConfig({ nesting: { maxDepth: 11, enabled: true } });
	// dropped keys stay as explicit-undefined entries (parseLimitsConfig
	// convention) — assert per-field, not deepEqual.
	assert.equal(cfg2.nesting?.enabled, true);
	assert.equal(cfg2.nesting?.maxDepth, undefined);
});

test("parseConfig: boundaries 1 and 64 / 1 and 10 accepted", () => {
	assert.equal(parseConfig({ nesting: { maxSlots: 1 } }).nesting?.maxSlots, 1);
	assert.equal(parseConfig({ nesting: { maxSlots: 64 } }).nesting?.maxSlots, 64);
	assert.equal(parseConfig({ nesting: { maxDepth: 1 } }).nesting?.maxDepth, 1);
	assert.equal(parseConfig({ nesting: { maxDepth: 10 } }).nesting?.maxDepth, 10);
});

test("mergeConfig: partial user nesting block does not erase the fail-closed default", () => {
	const base = { nesting: { ...DEFAULT_NESTING } };
	const merged = mergeConfig(base, { nesting: { maxSlots: 4 } });
	assert.deepEqual(merged.nesting, { enabled: false, maxDepth: 2, maxSlots: 4 });
});

test("mergeConfig: explicit user enabled=true wins over the default", () => {
	const base = { nesting: { ...DEFAULT_NESTING } };
	const merged = mergeConfig(base, { nesting: { enabled: true } });
	assert.deepEqual(merged.nesting, { enabled: true, maxDepth: 2 });
});

test("nesting.enabled is sensitive: project config cannot enable delegation", () => {
	const sensitive = collectSensitiveConfigPaths(PiTeamsConfigSchema);
	assert.ok(
		sensitive.includes("nesting.enabled"),
		`nesting.enabled must be marked sensitive (got: ${sensitive.filter((p) => p.startsWith("nesting")).join(", ") || "nothing"})`,
	);
});

test("schema.json nesting sub-schema matches the TypeBox properties", () => {
	const schemaJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schema.json"), "utf-8"));
	const jsonNesting = schemaJson.properties?.nesting?.properties;
	assert.ok(jsonNesting, "schema.json must carry a nesting.properties block");
	const typeboxNesting = (PiTeamsConfigSchema.properties as Record<string, { properties?: Record<string, unknown> }>).nesting?.properties;
	assert.ok(typeboxNesting, "TypeBox schema must carry nesting.properties");
	assert.deepEqual(
		Object.keys(jsonNesting).sort(),
		Object.keys(typeboxNesting).sort(),
		"nesting property sets must match between schema.json and TypeBox",
	);
});
