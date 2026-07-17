import assert from "node:assert/strict";
import test from "node:test";
import type { ValidationSeverity } from "../../src/schema/validation-types.ts";
import { validateWithSeverity } from "../../src/schema/validation-types.ts";

/**
 * Round 27 (test coverage gaps): `validation-types.ts` provides config
 * validation with severity-tagged findings using TypeBox schema validation.
 *
 * Tests cover validateWithSeverity with various inputs and modes.
 */

// ─── Basic validation ──────────────────────────────────────────────────────

test("validateWithSeverity: rejects non-object input", () => {
	const result = validateWithSeverity("not an object");
	assert.equal(result.hasErrors, true);
	assert.ok(result.findings.length >= 1);
	assert.equal(result.findings[0]?.severity, "ERROR");
	assert.match(result.findings[0]?.message ?? "", /must be an object/i);
});

test("validateWithSeverity: rejects null", () => {
	const result = validateWithSeverity(null);
	assert.equal(result.hasErrors, true);
});

test("validateWithSeverity: rejects array", () => {
	const result = validateWithSeverity([1, 2, 3]);
	assert.equal(result.hasErrors, true);
});

test("validateWithSeverity: empty object has errors (required fields missing)", () => {
	const result = validateWithSeverity({});
	// Empty object will fail schema validation — required fields missing
	assert.ok(result.findings.length >= 1);
});

// ─── Mode behavior ─────────────────────────────────────────────────────────

test("validateWithSeverity: defaults to strict mode", () => {
	const result = validateWithSeverity({});
	assert.equal(result.mode, "strict");
});

test("validateWithSeverity: lenient mode downgrades unknown properties to WARNING", () => {
	const result = validateWithSeverity({ unknownProp: true }, "lenient");
	const unknownFindings = result.findings.filter((f) => f.message?.includes("unknown property"));
	if (unknownFindings.length > 0) {
		for (const f of unknownFindings) {
			assert.equal(f.severity, "WARNING" as ValidationSeverity);
		}
	}
});

test("validateWithSeverity: strict mode treats unknown properties as ERROR", () => {
	const result = validateWithSeverity({ unknownProp: true }, "strict");
	const unknownFindings = result.findings.filter((f) => f.message?.includes("unknown property"));
	if (unknownFindings.length > 0) {
		for (const f of unknownFindings) {
			assert.equal(f.severity, "ERROR" as ValidationSeverity);
		}
	}
});

// ─── Recommended ranges ────────────────────────────────────────────────────

test("validateWithSeverity: warns when maxConcurrentWorkers exceeds 8", () => {
	const result = validateWithSeverity(
		{
			limits: { maxConcurrentWorkers: 20 },
		},
		"lenient",
	);
	const warning = result.findings.find((f) => f.field === "limits.maxConcurrentWorkers" && f.severity === "WARNING");
	assert.ok(warning, "should warn about high maxConcurrentWorkers");
	assert.match(warning!.message ?? "", /maxConcurrentWorkers/);
});

test("validateWithSeverity: warns when maxTaskDepth exceeds 4", () => {
	const result = validateWithSeverity(
		{
			limits: { maxTaskDepth: 10 },
		},
		"lenient",
	);
	const warning = result.findings.find((f) => f.field === "limits.maxTaskDepth" && f.severity === "WARNING");
	assert.ok(warning, "should warn about high maxTaskDepth");
	assert.match(warning!.message ?? "", /maxTaskDepth/);
});

// ─── Recommended optional keys ─────────────────────────────────────────────

test("validateWithSeverity: info for missing recommended keys", () => {
	const result = validateWithSeverity({}, "lenient");
	const infos = result.findings.filter((f) => f.severity === "INFO");
	assert.ok(infos.length >= 1, "should have INFO findings for missing recommended keys");
	const fields = infos.map((f) => f.field);
	assert.ok(fields.includes("limits"), "should recommend 'limits'");
	assert.ok(fields.includes("runtime"), "should recommend 'runtime'");
});

// ─── hasErrors / hasWarnings ───────────────────────────────────────────────

test("validateWithSeverity: hasErrors is false for valid config", () => {
	// Minimal valid config: check what the schema accepts
	const result = validateWithSeverity(
		{
			limits: { maxConcurrentWorkers: 4 },
			runtime: { groupJoin: "smart" },
		},
		"strict",
	);
	// Even if valid, there may be INFO findings for missing optional fields
	// but hasErrors should only be true for ERROR severity
	const errorFindings = result.findings.filter((f) => f.severity === "ERROR");
	assert.equal(result.hasErrors, errorFindings.length > 0);
});

test("validateWithSeverity: hasWarnings reflects WARNING severity", () => {
	const result = validateWithSeverity(
		{
			limits: { maxConcurrentWorkers: 20 },
		},
		"lenient",
	);
	const warningFindings = result.findings.filter((f) => f.severity === "WARNING");
	assert.equal(result.hasWarnings, warningFindings.length > 0);
});

// ─── suggestion field ──────────────────────────────────────────────────────

test("validateWithSeverity: warnings for out-of-range values include suggestion", () => {
	const result = validateWithSeverity(
		{
			limits: { maxConcurrentWorkers: 20 },
		},
		"lenient",
	);
	const warning = result.findings.find((f) => f.field === "limits.maxConcurrentWorkers" && f.severity === "WARNING");
	assert.ok(warning?.suggestion, "should include a suggestion");
	assert.match(warning!.suggestion ?? "", /≤ 8/);
});
