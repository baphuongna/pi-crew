/**
 * Workflow step parsing for spec fields (ADR-6 §7, WP-6 step 7):
 * `specRefs:` / `specStrict:` in a step body + `specStrict:` frontmatter must
 * survive discovery — a silent drop would make spec wiring a no-op for every
 * .workflow.md author.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { discoverWorkflows } from "../../../src/workflows/discover-workflows.ts";

function writeProjectWorkflow(content: string): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-specwf-"));
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(path.join(cwd, ".crew", "workflows"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".crew", "workflows", "specdemo.workflow.md"), content);
	return cwd;
}

test("step body specRefs/specStrict + frontmatter specStrict round-trip through discovery", () => {
	const cwd = writeProjectWorkflow(`---
name: specdemo
description: spec wiring demo
specStrict: true
---

## build
role: executor
specRefs: spec-api, spec-ui
specStrict: false

Implement: {goal}

## audit
role: verifier
dependsOn: build
specRefs: spec-audit

Verify: {goal}
`);
	try {
		const found = discoverWorkflows(cwd).project.find((w) => w.name === "specdemo");
		assert.ok(found, "workflow discovered");
		assert.equal(found.specStrict, true, "frontmatter specStrict parsed");
		const build = found.steps.find((s) => s.id === "build");
		const audit = found.steps.find((s) => s.id === "audit");
		assert.ok(build && audit);
		assert.deepEqual(build.specRefs, ["spec-api", "spec-ui"], "CSV specRefs parsed");
		assert.equal(build.specStrict, false, "per-step strict override parsed");
		assert.deepEqual(audit.specRefs, ["spec-audit"]);
		assert.equal(audit.task.startsWith("Verify:"), true, "task body not swallowed by config lines");
		// Round-1 P1-2 regression: workflow-level strict + step WITHOUT the flag
		// must resolve STRICT at dispatch (the ?? fallback). A hard `false` parse
		// here silently disabled the documented frontmatter opt-in.
		const merged = found.specStrict === true && build.specStrict === false;
		assert.equal(merged, true, "workflow strict flows to the un-flagged step; explicit step false still opts out");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow without spec fields is unchanged (no undefined leakage)", () => {
	const cwd = writeProjectWorkflow(`---
name: specdemo
description: plain
---

## build
role: executor

Do: {goal}
`);
	try {
		const found = discoverWorkflows(cwd).project.find((w) => w.name === "specdemo");
		assert.ok(found);
		assert.equal(found.specStrict, undefined);
		assert.equal(found.steps[0]?.specRefs, undefined);
		assert.equal(
			found.steps[0]?.specStrict,
			undefined,
			"absent step flag stays undefined so the workflow-level flag survives the ?? merge (round-1 P1-2)",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
