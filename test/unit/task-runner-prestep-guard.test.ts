/**
 * F-02 SECURITY: preStepScript guard for project-sourced workflows.
 *
 * A project-sourced workflow (.crew/workflows/*.workflow.md) can declare a
 * preStepScript, which task-runner.ts executes via execFileSync. A hostile
 * repo clone can embed arbitrary code execution through this vector.
 *
 * The fix gates preStepScript execution on step.source via an ALLOWLIST: only
 * 'builtin'/'user' steps execute; project-sourced AND programmatic (undefined)
 * steps are skipped with an audit event (deny by default — F-02 hardening).
 *
 * The full runTeamTask function spawns a child Pi process, making it impractical
 * to unit-test end-to-end. Additionally, execFileSync is loaded via dynamic
 * `await import("node:child_process")` inside the function body, which
 * node:test's mock.module cannot reliably intercept for ESM (documented in
 * test/unit/run-coalesced-heartbeat-race.test.ts). Therefore we test:
 *
 *   (a) The guard predicate logic directly (project → skip, builtin → execute).
 *   (b) Source propagation through the real discoverWorkflows path.
 *   (c) Structural verification: the guard precedes execFileSync in the source.
 *   (d) The skip event type is registered in TEAM_EVENT_TYPES for audit.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

import { TEAM_EVENT_TYPES } from "../../src/state/contracts.ts";
import { allWorkflows, discoverWorkflows, invalidateWorkflowDiscoveryCache } from "../../src/workflows/discover-workflows.ts";
import type { WorkflowStep } from "../../src/workflows/workflow-config.ts";

// ─── (a) Guard predicate logic ────────────────────────────────────────────

/**
 * Mirrors the production allowlist guard in task-runner.ts:
 *   if (preStepScript && source !== "builtin" && source !== "user") { skip }
 *   else if (preStepScript) { execute }
 */
function preStepDecision(step: Pick<WorkflowStep, "source" | "preStepScript">): "skip" | "execute" | "none" {
	if (step.preStepScript && step.source !== "builtin" && step.source !== "user") return "skip";
	if (step.preStepScript) return "execute";
	return "none";
}

describe("F-02 guard predicate", () => {
	test("project-sourced step with preStepScript → skip (RCE prevented)", () => {
		const step = { source: "project" as const, preStepScript: "evil.sh" };
		assert.equal(preStepDecision(step), "skip");
	});

	test("builtin-sourced step with preStepScript → execute (allowed)", () => {
		const step = { source: "builtin" as const, preStepScript: "setup.sh" };
		assert.equal(preStepDecision(step), "execute");
	});

	test("user-sourced step with preStepScript → execute (allowed)", () => {
		const step = { source: "user" as const, preStepScript: "lint.sh" };
		assert.equal(preStepDecision(step), "execute");
	});

	test("project-sourced step WITHOUT preStepScript → none (no-op)", () => {
		const step = { source: "project" as const };
		assert.equal(preStepDecision(step), "none");
	});

	test("undefined source (manual construction) with preStepScript → skip (allowlist denies by default)", () => {
		// Steps constructed manually (not via discovery) have source=undefined.
		// F-02 allowlist hardening: deny by default — only explicit builtin/user
		// provenance permits pre-step script execution.
		const step = { source: undefined, preStepScript: "check.sh" };
		assert.equal(preStepDecision(step), "skip");
	});

	test("no preStepScript at all → none regardless of source", () => {
		for (const source of ["project", "builtin", "user", undefined] as const) {
			assert.equal(preStepDecision({ source: source as WorkflowStep["source"] }), "none");
		}
	});
});

// ─── (b) Source propagation through discovery ─────────────────────────────

function writeProjectWorkflow(cwd: string, body: string): void {
	const dir = path.join(cwd, ".crew", "workflows");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "f02-guard.workflow.md"), body);
}

describe("F-02 source propagation via discoverWorkflows", () => {
	test("project workflow steps carry source='project'", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-f02-"));
		try {
			writeProjectWorkflow(
				cwd,
				[
					"---",
					"name: f02-guard",
					"description: F-02 source propagation test",
					"---",
					"",
					"## run",
					"role: executor",
					"preStepScript: check.sh",
					"",
					"Do the task: {goal}",
					"",
				].join("\n"),
			);
			invalidateWorkflowDiscoveryCache(cwd);
			const wf = allWorkflows(discoverWorkflows(cwd)).find((w) => w.name === "f02-guard");
			assert.ok(wf, "project workflow should be discovered");
			const step = wf!.steps.find((s) => s.id === "run");
			assert.ok(step, "step 'run' present");
			assert.equal(step!.source, "project", "step source must be 'project' for project-sourced workflows");
			assert.equal(step!.preStepScript, undefined, "project-sourced preStepScript must be stripped at discover layer (F-02)");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("project workflow preStepScript is stripped at discover layer", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-f02-strip-"));
		try {
			writeProjectWorkflow(
				cwd,
				[
					"---",
					"name: f02-strip",
					"description: F-02 strip test",
					"---",
					"",
					"## run",
					"role: executor",
					"preStepScript: check.sh",
					"preStepArgs: --flag",
					"",
					"Do the task: {goal}",
					"",
				].join("\n"),
			);
			invalidateWorkflowDiscoveryCache(cwd);
			const wf = allWorkflows(discoverWorkflows(cwd)).find((w) => w.name === "f02-strip");
			assert.ok(wf, "project workflow should be discovered");
			const step = wf!.steps.find((s) => s.id === "run");
			assert.ok(step, "step 'run' present");
			assert.equal(step!.source, "project");
			assert.equal(step!.preStepScript, undefined);
			assert.equal(step!.preStepArgs, undefined);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("builtin workflow steps carry source='builtin'", () => {
		// discoverWorkflows from any cwd always discovers builtin workflows from
		// the package. Use a temp cwd with no project workflows to isolate.
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-f02builtin-"));
		try {
			const discovery = discoverWorkflows(cwd);
			// Pick any builtin workflow that has steps
			const builtin = discovery.builtin.find((w) => w.steps.length > 0);
			if (builtin) {
				for (const step of builtin.steps) {
					assert.equal(step.source, "builtin", `builtin step '${step.id}' must have source='builtin' (got '${step.source}')`);
				}
			}
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ─── (c) Structural verification: guard precedes execFileSync ──────────────

describe("F-02 structural placement in pre-execution.ts (CORE-5 extraction 2)", () => {
	test("project-source guard exists BEFORE execFileSync call", () => {
		const src = readFileSync("src/runtime/task-runner/pre-execution.ts", "utf8");

		// F-02 allowlist guard condition must exist (deny unless builtin/user)
		const guardIndex = src.indexOf('input.step.source !== "builtin" && input.step.source !== "user"');
		assert.ok(guardIndex >= 0, "F-02 allowlist guard condition must exist in task-runner.ts");

		// The execFileSync import must exist
		const execIndex = src.indexOf('await import("node:child_process")');
		assert.ok(execIndex >= 0, "execFileSync dynamic import must exist");

		// The guard must come BEFORE execFileSync (so project scripts never reach it)
		assert.ok(
			guardIndex < execIndex,
			`F-02 guard (offset ${guardIndex}) must precede execFileSync import (offset ${execIndex}) — ` +
				"a project-sourced preStepScript must never reach the execution path",
		);
	});

	test("skip event 'hook.pre_step_skipped' is emitted inside the guard block", () => {
		const src = readFileSync("src/runtime/task-runner/pre-execution.ts", "utf8");
		const guardIndex = src.indexOf('input.step.source !== "builtin" && input.step.source !== "user"');
		const skipEventIndex = src.indexOf('"hook.pre_step_skipped"');
		assert.ok(skipEventIndex >= 0, "hook.pre_step_skipped event type must be emitted in task-runner.ts");
		assert.ok(skipEventIndex > guardIndex, "skip event must be inside the project-source guard block (after guard condition)");
		// Ensure it's before execFileSync
		const execIndex = src.indexOf('await import("node:child_process")');
		assert.ok(skipEventIndex < execIndex, "skip event must be before execFileSync");
	});
});

// ─── (d) Event type registration ──────────────────────────────────────────

describe("F-02 event registration", () => {
	test("hook.pre_step_skipped is registered in TEAM_EVENT_TYPES", () => {
		assert.ok(
			(TEAM_EVENT_TYPES as readonly string[]).includes("hook.pre_step_skipped"),
			"hook.pre_step_skipped must be in TEAM_EVENT_TYPES for audit trail validation",
		);
	});
});
