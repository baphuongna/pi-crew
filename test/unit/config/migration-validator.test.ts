/**
 * WI-5.6 (M5 spec §5) — config migration validator test.
 *
 * Spec acceptance: "Migration validator: test case cũ config + key
 * deprecated → warning không fail."
 *
 * Validates:
 *   1. Deprecated env keys produce warnings, not throws.
 *   2. Removed / dead env keys produce warnings, not throws.
 *   3. Config-level deprecated keys produce warnings.
 *   4. Unknown env keys (not in registry) pass through without warnings.
 *   5. Mutation demo: a synthetic config with a deprecated key, the
 *      validator returns the warning + never throws.
 *
 * The "additive-only" contract is captured in src/config/migration-validator.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateConfigAgainstEnvRegistry, validateEnv } from "../../../src/config/migration-validator.ts";

describe("WI-5.6 migration validator", () => {
	it("deprecated env keys warn but don't fail", () => {
		const fakeEnv = {
			PI_CREW_SESSION_DEPTH: "1", // per env-vars.ts:571 'legacy name; code uses PI_CREW_DEPTH'
		};
		const result = validateEnv(fakeEnv);
		assert.equal(result.hasWarnings, true, "expected at least one warning");
		const legacyWarn = result.warnings.find((w) => w.name === "PI_CREW_SESSION_DEPTH");
		assert.ok(legacyWarn, `expected a warning for PI_CREW_SESSION_DEPTH`);
		assert.equal(legacyWarn.severity, "deprecated", `expected severity=deprecated for legacy guard; got ${legacyWarn.severity}`);
	});

	it("removed/dead env keys produce a 'removed' severity warning", () => {
		// REVIEW FIX (2026-09-10): use REAL registry entries — the previous
		// fake key (PI_CREW_SUPERSEDED_NAME) is not in CREW_ENV_VARS, so the
		// removed-branch was never exercised (vacuous test).
		const fakeEnv = {
			PI_CREW_BROKER_DIAG_UI: "1", // env-vars.ts: deprecated: "removed"
			PI_CREW_SAFE_BASH: "1", // env-vars.ts: deprecated: "dead"
		};
		const result = validateEnv(fakeEnv);
		assert.equal(result.hasWarnings, true);
		const removedWarn = result.warnings.find((w) => w.name === "PI_CREW_BROKER_DIAG_UI");
		assert.ok(removedWarn, "expected a warning for PI_CREW_BROKER_DIAG_UI");
		assert.equal(removedWarn.severity, "removed", `got ${removedWarn.severity}`);
		const deadWarn = result.warnings.find((w) => w.name === "PI_CREW_SAFE_BASH");
		assert.ok(deadWarn, "expected a warning for PI_CREW_SAFE_BASH");
		assert.equal(deadWarn.severity, "removed", `dead must also map to severity=removed; got ${deadWarn.severity}`);
	});

	it("config-level deprecated key warns", () => {
		const config = {
			PI_CREW_SESSION_DEPTH: "1",
			otherKey: "untouched",
		};
		const result = validateConfigAgainstEnvRegistry(config);
		assert.equal(result.hasWarnings, true);
		assert.ok(result.warnings.some((w) => w.name === "PI_CREW_SESSION_DEPTH"));
	});

	it("clean env has no warnings (regression: false positives)", () => {
		const fakeEnv = {
			PI_CREW_DEPTH: "4",
			PI_TEAMS_HOME: "/tmp/test",
			PATH: "/usr/bin",
			HOME: "/root",
			USER: "test",
		};
		const result = validateEnv(fakeEnv);
		assert.deepEqual(result.warnings, [], `clean env should yield zero warnings; got: ${JSON.stringify(result.warnings, null, 2)}`);
	});

	it("validator never throws on weird input", () => {
		// Mutation: try several adversarial shapes.
		const shapes = [
			null,
			undefined,
			{},
			{ PI_CREW_DEPTH: null as unknown as string },
			{ PI_CREW_DEPTH: 0 as unknown as string },
			{ PI_CREW_DEPTH: "" as unknown as string },
			{ PI_CREW_DEPTH: "0" },
			{ __proto__: { poisoned: true } },
		];
		for (const env of shapes) {
			assert.doesNotThrow(() => validateEnv(env as never), `should not throw for ${JSON.stringify(env)}`);
			assert.doesNotThrow(
				() => validateConfigAgainstEnvRegistry(env as never),
				`config validator should not throw for ${JSON.stringify(env)}`,
			);
		}
	});

	it("additive-only contract: validator does NOT mutate input", () => {
		const original = {
			PI_CREW_SESSION_DEPTH: "legacy-value",
			SHARED_KEY: "untouched",
		};
		const snapshot = JSON.parse(JSON.stringify(original));
		validateEnv(original);
		validateConfigAgainstEnvRegistry(original);
		assert.deepEqual(original, snapshot, "validator must not mutate input env");
	});
});
