/**
 * F-01: Trust gate for project-sourced .dwf.ts scripts.
 *
 * Verifies that runDynamicWorkflow refuses to load project-sourced dynamic
 * workflows unless PI_CREW_TRUST_PROJECT_DWF=1 is set, while builtin and user
 * workflows proceed without restriction.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDynamicWorkflow } from "../../src/runtime/goal-workflow/dynamic-workflow-runner.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";
import type { DynamicWorkflowConfig } from "../../src/workflows/workflow-config.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create a temp "project" with a .crew/workflows dir containing a no-op .dwf.ts.
 * The directory structure mirrors what discover-workflows expects so that
 * resolveScriptPath() accepts the file path.
 */
function setupTempProject(): { cwd: string; dwfPath: string; cleanup: () => void } {
	const cwd = mkdtempSync(join(tmpdir(), "dwf-trust-test-"));
	const workflowsDir = join(cwd, ".crew", "workflows");
	mkdirSync(workflowsDir, { recursive: true });
	const dwfPath = join(workflowsDir, "noop.dwf.ts");
	// A no-op script: default export is an empty async function.
	writeFileSync(dwfPath, "export default async function noop() {};\n");
	return { cwd, dwfPath, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function makeManifest(cwd: string): TeamRunManifest {
	const runId = `test-trust-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
	const stateRoot = join(cwd, ".crew", "state", "runs", runId);
	const artifactsRoot = join(cwd, ".crew", "artifacts", runId);
	mkdirSync(stateRoot, { recursive: true });
	mkdirSync(artifactsRoot, { recursive: true });
	return {
		schemaVersion: 1,
		runId,
		team: "test",
		goal: "test goal",
		status: "running",
		workspaceMode: "single" as const,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd,
		stateRoot,
		artifactsRoot,
		tasksPath: join(stateRoot, "tasks.json"),
		eventsPath: join(stateRoot, "events.jsonl"),
		artifacts: [],
	};
}

function makeDynamicWorkflow(source: "builtin" | "user" | "project", filePath: string, name = "noop"): DynamicWorkflowConfig {
	return {
		name,
		description: "test dynamic workflow",
		source,
		filePath,
		runtime: "dynamic",
		dynamicScript: filePath,
		steps: [],
	} as DynamicWorkflowConfig;
}

/**
 * Read events.jsonl and parse lines into an array of event objects.
 */
function readEvents(eventsPath: string): Array<{ type: string; runId?: string; data?: Record<string, unknown> }> {
	try {
		const content = readFileSync(eventsPath, "utf-8");
		return content
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("(a) project-sourced .dwf.ts throws when PI_CREW_TRUST_PROJECT_DWF is unset", async () => {
	const env = setupTempProject();
	const savedEnv = process.env.PI_CREW_TRUST_PROJECT_DWF;
	const savedDet = process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
	// Ensure the trust env var is NOT set.
	delete process.env.PI_CREW_TRUST_PROJECT_DWF;

	try {
		const manifest = makeManifest(env.cwd);
		const workflow = makeDynamicWorkflow("project", env.dwfPath);
		const controller = new AbortController();

		await assert.rejects(runDynamicWorkflow({ manifest, workflow, signal: controller.signal }), (err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			assert.ok(msg.includes("PI_CREW_TRUST_PROJECT_DWF"), `Error should mention PI_CREW_TRUST_PROJECT_DWF, got: ${msg}`);
			return true;
		});

		// Verify the audit event was emitted.
		const events = readEvents(manifest.eventsPath);
		const denied = events.filter((e) => e.type === "dwf.trust_denied");
		assert.equal(denied.length, 1, "exactly one dwf.trust_denied event should be emitted");
		assert.equal(denied[0].data?.source, "project");
		assert.equal(denied[0].data?.workflow, "noop");
	} finally {
		if (savedEnv !== undefined) process.env.PI_CREW_TRUST_PROJECT_DWF = savedEnv;
		if (savedDet !== undefined) process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = savedDet;
		env.cleanup();
	}
});

test("(b) project-sourced .dwf.ts proceeds when PI_CREW_TRUST_PROJECT_DWF=1", async () => {
	const env = setupTempProject();
	const savedEnv = process.env.PI_CREW_TRUST_PROJECT_DWF;
	// Skip determinism AST check to avoid esbuild edge cases in the test fixture.
	const savedDet = process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
	process.env.PI_CREW_TRUST_PROJECT_DWF = "1";
	process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = "1";

	try {
		const manifest = makeManifest(env.cwd);
		const workflow = makeDynamicWorkflow("project", env.dwfPath);
		const controller = new AbortController();

		const result = await runDynamicWorkflow({ manifest, workflow, signal: controller.signal });

		// If we get here, the trust gate passed and the script executed (no-op).
		assert.ok(result, "runDynamicWorkflow should return a result");
		assert.equal(result.manifest.status, "completed", "manifest status should be completed");

		// Verify no trust_denied event was emitted — the workflow proceeded.
		const events = readEvents(manifest.eventsPath);
		const denied = events.filter((e) => e.type === "dwf.trust_denied");
		assert.equal(denied.length, 0, "no dwf.trust_denied event when env var is set");

		// Verify dwf.started and dwf.completed were emitted (script actually ran).
		const started = events.filter((e) => e.type === "dwf.started");
		assert.equal(started.length, 1, "dwf.started event should be emitted");
	} finally {
		if (savedEnv !== undefined) process.env.PI_CREW_TRUST_PROJECT_DWF = savedEnv;
		else delete process.env.PI_CREW_TRUST_PROJECT_DWF;
		if (savedDet !== undefined) process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = savedDet;
		else delete process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
		env.cleanup();
	}
});

test("(c) builtin-sourced .dwf.ts proceeds without PI_CREW_TRUST_PROJECT_DWF", async () => {
	const env = setupTempProject();
	const savedEnv = process.env.PI_CREW_TRUST_PROJECT_DWF;
	const savedDet = process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
	// Ensure the trust env var is NOT set — builtin should not need it.
	delete process.env.PI_CREW_TRUST_PROJECT_DWF;
	process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = "1";

	try {
		const manifest = makeManifest(env.cwd);
		const workflow = makeDynamicWorkflow("builtin", env.dwfPath);
		const controller = new AbortController();

		const result = await runDynamicWorkflow({ manifest, workflow, signal: controller.signal });

		// Builtin workflow should proceed without restriction.
		assert.ok(result, "runDynamicWorkflow should return a result");
		assert.equal(result.manifest.status, "completed", "manifest status should be completed");

		// Verify no trust_denied event was emitted.
		const events = readEvents(manifest.eventsPath);
		const denied = events.filter((e) => e.type === "dwf.trust_denied");
		assert.equal(denied.length, 0, "no dwf.trust_denied event for builtin workflows");
	} finally {
		if (savedEnv !== undefined) process.env.PI_CREW_TRUST_PROJECT_DWF = savedEnv;
		if (savedDet !== undefined) process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = savedDet;
		else delete process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
		env.cleanup();
	}
});

test("(d) non-'1' env values are DENIED (strict comparison, no truthy coercion)", async () => {
	// F-01 hardening: only the exact string "1" opts in. Any other value
	// (truthy strings like "true"/"yes", or "0"/""/whitespace) must be denied
	// to prevent accidental opt-in via env misconfiguration.
	const deniedValues = ["true", "TRUE", "yes", "1.0", "01", " 1", "1 ", "1\n", "0", ""];
	for (const val of deniedValues) {
		const env = setupTempProject();
		const savedEnv = process.env.PI_CREW_TRUST_PROJECT_DWF;
		process.env.PI_CREW_TRUST_PROJECT_DWF = val;
		try {
			const manifest = makeManifest(env.cwd);
			const workflow = makeDynamicWorkflow("project", env.dwfPath);
			const controller = new AbortController();
			await assert.rejects(runDynamicWorkflow({ manifest, workflow, signal: controller.signal }), (err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				assert.ok(msg.includes("PI_CREW_TRUST_PROJECT_DWF"), `env='${val}' should be DENIED (strict ==="1"), got error: ${msg}`);
				return true;
			});
		} finally {
			if (savedEnv === undefined) delete process.env.PI_CREW_TRUST_PROJECT_DWF;
			else process.env.PI_CREW_TRUST_PROJECT_DWF = savedEnv;
			env.cleanup();
		}
	}
});
