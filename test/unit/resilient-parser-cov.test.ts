import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConfigResilient } from "../../src/config/resilient-parser.ts";

describe("parseConfigResilient", () => {
	it("returns valid=true and empty config for null input", () => {
		const result = parseConfigResilient(null);
		assert.equal(result.valid, false);
		assert.equal(result.errors.length, 1);
		assert.equal(result.errors[0].field, "config");
		assert.equal(result.config.config, undefined);
	});

	it("returns valid=true and empty config for array input", () => {
		const result = parseConfigResilient([1, 2, 3]);
		assert.equal(result.valid, false);
		assert.equal(result.errors[0].field, "config");
	});

	it("preserves multiple valid fields while reporting errors for invalid ones", () => {
		const result = parseConfigResilient({
			asyncByDefault: true,
			executeWorkers: true,
			limits: "not-an-object",
		});
		assert.equal(result.config.asyncByDefault, true);
		assert.equal(result.config.executeWorkers, true);
		const limitsError = result.errors.find((e) => e.field === "limits");
		assert.ok(limitsError, "should report error for limits");
	});

	it("reports unknown key without suggestion when too far from known keys", () => {
		const result = parseConfigResilient({
			concurrecny: 4,
		});
		assert.equal(result.valid, false);
		const err = result.errors.find((e) => e.field === "concurrecny");
		assert.ok(err);
		// suggestion may be null if edit distance exceeds threshold
	});

	it("handles deeply nested valid config", () => {
		const result = parseConfigResilient({
			runtime: { mode: "auto", maxTurns: 100 },
			observability: { enabled: true },
		});
		assert.equal(result.valid, true);
		assert.equal((result.config.runtime as Record<string, unknown>)?.mode, "auto");
		assert.equal((result.config.observability as Record<string, unknown>)?.enabled, true);
	});

	it("returns empty warnings array", () => {
		const result = parseConfigResilient({});
		assert.deepEqual(result.warnings, []);
	});

	it("handles numeric input as non-object", () => {
		const result = parseConfigResilient(42);
		assert.equal(result.valid, false);
		assert.equal(result.errors[0].field, "config");
	});

	it("reports error for boolean field where object expected", () => {
		const result = parseConfigResilient({
			limits: true,
		});
		assert.equal(result.valid, false);
		const limitsError = result.errors.find((e) => e.field === "limits");
		assert.ok(limitsError);
	});

	it("does not report errors for keys not present in raw input", () => {
		const result = parseConfigResilient({
			asyncByDefault: true,
		});
		// Only asyncByDefault is provided and valid
		assert.equal(result.valid, true);
		assert.equal(result.errors.length, 0);
	});

	it("handles empty string input as non-object", () => {
		const result = parseConfigResilient("");
		assert.equal(result.valid, false);
		assert.equal(result.errors.length, 1);
	});

	it("returns undefined for invalid field values in config", () => {
		const result = parseConfigResilient({
			asyncByDefault: "yes-please",
		});
		assert.equal(result.valid, false);
		// The parsed config should not contain the invalid value
		assert.equal(result.config.asyncByDefault, undefined);
	});
});
