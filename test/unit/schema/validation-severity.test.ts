import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig } from "../../../src/schema/config-schema.ts";
import { validateWithSeverity } from "../../../src/schema/validation-types.ts";

// ---------------------------------------------------------------------------
// validateWithSeverity
// ---------------------------------------------------------------------------

test("validateWithSeverity: non-object input produces ERROR", () => {
	const outcome = validateWithSeverity("not an object");
	assert.equal(outcome.hasErrors, true);
	assert.equal(outcome.findings.length, 1);
	assert.equal(outcome.findings[0].severity, "ERROR");
	assert.equal(outcome.findings[0].field, "config");
});

test("validateWithSeverity: valid config has no ERROR findings", () => {
	const outcome = validateWithSeverity({
		asyncByDefault: true,
		limits: { maxConcurrentWorkers: 4 },
		runtime: { mode: "child-process" },
	});
	assert.equal(outcome.hasErrors, false);
	// May have INFO findings for missing recommended keys
	const errorFindings = outcome.findings.filter((f) => f.severity === "ERROR");
	assert.equal(errorFindings.length, 0);
});

test("validateWithSeverity: unknown property is ERROR in strict mode", () => {
	const outcome = validateWithSeverity({ unknownKey: true }, "strict");
	assert.equal(outcome.hasErrors, true);
	const unknown = outcome.findings.find((f) => f.message.includes("unknown property"));
	assert.ok(unknown);
	assert.equal(unknown.severity, "ERROR");
});

test("validateWithSeverity: unknown property is WARNING in lenient mode", () => {
	const outcome = validateWithSeverity({ unknownKey: true }, "lenient");
	const unknown = outcome.findings.find((f) => f.message.includes("unknown property"));
	assert.ok(unknown);
	assert.equal(unknown.severity, "WARNING");
});

test("validateWithSeverity: missing recommended keys produce INFO findings", () => {
	const outcome = validateWithSeverity({ asyncByDefault: true });
	const infoFindings = outcome.findings.filter((f) => f.severity === "INFO");
	assert.ok(infoFindings.length >= 1);
	const fields = infoFindings.map((f) => f.field);
	assert.ok(fields.includes("limits") || fields.includes("runtime"));
});

test("validateWithSeverity: maxConcurrentWorkers > 8 produces WARNING", () => {
	const outcome = validateWithSeverity({
		limits: { maxConcurrentWorkers: 16 },
		runtime: { mode: "auto" },
	});
	const warning = outcome.findings.find((f) => f.field === "limits.maxConcurrentWorkers");
	assert.ok(warning);
	assert.equal(warning.severity, "WARNING");
	assert.ok(warning.message.includes("8"));
});

test("validateWithSeverity: maxTaskDepth > 4 produces WARNING", () => {
	const outcome = validateWithSeverity({
		limits: { maxTaskDepth: 6 },
		runtime: { mode: "auto" },
	});
	const warning = outcome.findings.find((f) => f.field === "limits.maxTaskDepth");
	assert.ok(warning);
	assert.equal(warning.severity, "WARNING");
	assert.ok(warning.message.includes("4"));
});

test("validateWithSeverity: recommended ranges not triggered when within bounds", () => {
	const outcome = validateWithSeverity({
		limits: { maxConcurrentWorkers: 4, maxTaskDepth: 3 },
		runtime: { mode: "auto" },
	});
	const rangeWarnings = outcome.findings.filter(
		(f) => f.severity === "WARNING" && (f.field?.includes("maxConcurrentWorkers") || f.field?.includes("maxTaskDepth")),
	);
	assert.equal(rangeWarnings.length, 0);
});

test("validateWithSeverity: defaults to strict mode", () => {
	const outcome = validateWithSeverity({});
	assert.equal(outcome.mode, "strict");
});

test("validateWithSeverity: respects lenient mode parameter", () => {
	const outcome = validateWithSeverity({}, "lenient");
	assert.equal(outcome.mode, "lenient");
});

// ---------------------------------------------------------------------------
// validateConfig (convenience re-export)
// ---------------------------------------------------------------------------

test("validateConfig: delegates to validateWithSeverity", () => {
	const outcome = validateConfig({ unknownProp: 123 }, "lenient");
	assert.equal(outcome.mode, "lenient");
	assert.ok(outcome.findings.length > 0);
});
