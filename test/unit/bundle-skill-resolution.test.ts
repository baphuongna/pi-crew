import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

// @ts-nocheck — runtime-only test loading the untyped shipped bundle (dist/index.mjs).

const BUNDLE = path.resolve(process.cwd(), "dist/index.mjs");

test("shipped bundle resolves default skills correctly", async () => {
	if (!fs.existsSync(BUNDLE)) {
		assert.fail(`${BUNDLE} not built — run \`npm run build:bundle\` first`);
	}

	const mod = (await import(BUNDLE)) as Record<string, unknown>;
	const checkFn = mod.runPostInitSkillCheck as (cwd: string) => Promise<{ total: number; resolved: number; missing: string[]; severity: string; message: string }>;

	if (typeof checkFn !== "function") {
		assert.fail("runPostInitSkillCheck not exported from bundle");
	}

	const result = await checkFn(process.cwd());

	// Assert no missing skills
	assert.equal(result.severity, "ok", `severity should be 'ok', got '${result.severity}': ${result.message}`);
	assert.equal(result.resolved, result.total, `expected all ${result.total} skills resolved, missing: ${result.missing.join(", ")}`);
	assert.ok(result.total >= 3, `expected ≥3 default skills, got ${result.total}`);
});
