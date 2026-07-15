import assert from "node:assert/strict";
import test from "node:test";
import { parseConfigResilient } from "../../src/config/resilient-parser.ts";

test("parseConfigResilient: returns valid for empty object", () => {
	const result = parseConfigResilient({});
	assert.equal(result.valid, true);
	assert.deepEqual(result.errors, []);
	// Empty object still surfaces default runtime.inheritContext=true
	assert.deepEqual(result.config, { runtime: { inheritContext: true } });
});

test("parseConfigResilient: returns valid for correct config", () => {
	const result = parseConfigResilient({
		asyncByDefault: true,
		executeWorkers: false,
		limits: { maxConcurrentWorkers: 4 },
	});
	assert.equal(result.valid, true);
	assert.equal(result.errors.length, 0);
	assert.equal(result.config.asyncByDefault, true);
	assert.equal((result.config.limits as Record<string, unknown> | undefined)?.maxConcurrentWorkers, 4);
});

test("parseConfigResilient: reports unknown keys with suggestion", () => {
	const result = parseConfigResilient({
		asynByDefault: true, // typo
		runtime: { mode: "child-process" },
	});
	assert.equal(result.valid, false);
	assert.equal(result.errors.length, 1);
	assert.equal(result.errors[0].field, "asynByDefault");
	assert.equal(result.errors[0].suggestion, "asyncByDefault");
	// Valid fields still parse
	assert.equal((result.config.runtime as Record<string, unknown>)?.mode, "child-process");
});

test("parseConfigResilient: reports invalid field type", () => {
	const result = parseConfigResilient({
		asyncByDefault: "not-a-boolean",
		executeWorkers: true,
	});
	assert.equal(result.valid, false);
	assert.ok(result.errors.length >= 1);
	const asyncError = result.errors.find((e) => e.field === "asyncByDefault");
	assert.ok(asyncError, "should report error for asyncByDefault");
	assert.equal(result.config.executeWorkers, true);
});

test("parseConfigResilient: non-object input returns error", () => {
	const result = parseConfigResilient("not an object");
	assert.equal(result.valid, false);
	assert.equal(result.errors.length, 1);
	assert.equal(result.errors[0].field, "config");
});

test("parseConfigResilient: multiple unknown keys each get suggestions", () => {
	const result = parseConfigResilient({
		limts: { maxConcurrentWorkers: 2 }, // typo
		runtim: { mode: "auto" }, // typo
	});
	assert.equal(result.valid, false);
	assert.equal(result.errors.length, 2);
	const fields = result.errors.map((e) => e.field);
	assert.ok(fields.includes("limts"));
	assert.ok(fields.includes("runtim"));
});

test("parseConfigResilient: valid fields pass through even when others fail", () => {
	const result = parseConfigResilient({
		asyncByDefault: true,
		limits: "not-an-object",
		runtime: { maxTurns: 50 },
	});
	// asyncByDefault and runtime are valid
	assert.equal(result.config.asyncByDefault, true);
	assert.equal((result.config.runtime as Record<string, unknown>)?.maxTurns, 50);
	// limits is invalid → reported as error
	assert.equal(result.config.limits, undefined);
	const limitsError = result.errors.find((e) => e.field === "limits");
	assert.ok(limitsError);
});
