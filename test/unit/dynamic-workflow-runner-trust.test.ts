/**
 * F-01: Trust gate for project-sourced .dwf.ts scripts.
 *
 * Verifies that runDynamicWorkflow refuses to load project-sourced dynamic
 * workflows unless PI_CREW_TRUST_PROJECT_DWF=1 is set, while builtin
 * workflows proceed without restriction.
 *
 * w3-dwf-trust (2026-10-29): the USER tier now requires the SAME explicit
 * opt-in via PI_CREW_TRUST_USER_DWF=1 — ~/.pi/agent/workflows is writable by
 * WRITE-role child workers (same OS uid), so a planted user-tier .dwf.ts must
 * NOT execute as trusted host-process code. Also covers the dispatch-time
 * script pin (manifest.dynamicScriptPin): a path/sha256 mismatch refuses to
 * load a swapped script.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDynamicWorkflow } from "../../src/runtime/goal-workflow/dynamic-workflow-runner.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";
import { packageRoot, projectCrewRoot, userPiRoot } from "../../src/utils/paths.ts";
import { resolveRealContainedPath } from "../../src/utils/safe-paths.ts";
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

// ── w3-dwf-trust (2026-10-29): user tier gets the same default-deny ───────

/** Resolve the script path exactly as runDynamicWorkflow's resolveScriptPath does. */
function resolvePinPath(cwd: string, dwfPath: string): string {
	const bases = [join(projectCrewRoot(cwd), "workflows"), join(userPiRoot(), "workflows"), join(packageRoot(), "workflows")];
	for (const base of bases) {
		try {
			const real = resolveRealContainedPath(base, dwfPath);
			if (real) return real;
		} catch {
			// not contained in this base — try next
		}
	}
	return dwfPath;
}

test("(e) user-sourced .dwf.ts is DENIED without PI_CREW_TRUST_USER_DWF (planted-file PoC regression)", async () => {
	const env = setupTempProject();
	const savedUser = process.env.PI_CREW_TRUST_USER_DWF;
	const savedProj = process.env.PI_CREW_TRUST_PROJECT_DWF;
	const savedDet = process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
	// Simulate the plant: a user-tier .dwf.ts (discovered from ~/.pi/agent/workflows)
	// with NO trust opt-in set. The runner must refuse to execute it in-process.
	delete process.env.PI_CREW_TRUST_USER_DWF;
	delete process.env.PI_CREW_TRUST_PROJECT_DWF;

	try {
		const manifest = makeManifest(env.cwd);
		const workflow = makeDynamicWorkflow("user", env.dwfPath);
		const controller = new AbortController();

		await assert.rejects(runDynamicWorkflow({ manifest, workflow, signal: controller.signal }), (err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			assert.ok(msg.includes("PI_CREW_TRUST_USER_DWF"), `Error should mention PI_CREW_TRUST_USER_DWF, got: ${msg}`);
			return true;
		});

		// Audit event carries the user tier.
		const events = readEvents(manifest.eventsPath);
		const denied = events.filter((e) => e.type === "dwf.trust_denied");
		assert.equal(denied.length, 1, "exactly one dwf.trust_denied event should be emitted");
		assert.equal(denied[0].data?.source, "user");
		assert.equal(denied[0].data?.workflow, "noop");
		// NOT executed: no dwf.started — the planted script never ran (PoC's absent-marker equivalent).
		assert.equal(events.filter((e) => e.type === "dwf.started").length, 0, "planted user script must NOT execute (no dwf.started)");
	} finally {
		if (savedUser !== undefined) process.env.PI_CREW_TRUST_USER_DWF = savedUser;
		else delete process.env.PI_CREW_TRUST_USER_DWF;
		if (savedProj !== undefined) process.env.PI_CREW_TRUST_PROJECT_DWF = savedProj;
		else delete process.env.PI_CREW_TRUST_PROJECT_DWF;
		if (savedDet !== undefined) process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = savedDet;
		env.cleanup();
	}
});

test("(f) user-sourced .dwf.ts proceeds WITH PI_CREW_TRUST_USER_DWF=1 (legit user-config workflow)", async () => {
	const env = setupTempProject();
	const savedUser = process.env.PI_CREW_TRUST_USER_DWF;
	const savedDet = process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
	process.env.PI_CREW_TRUST_USER_DWF = "1";
	process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = "1";

	try {
		const manifest = makeManifest(env.cwd);
		const workflow = makeDynamicWorkflow("user", env.dwfPath);
		const controller = new AbortController();

		const result = await runDynamicWorkflow({ manifest, workflow, signal: controller.signal });

		assert.ok(result, "runDynamicWorkflow should return a result");
		assert.equal(result.manifest.status, "completed", "manifest status should be completed");
		const events = readEvents(manifest.eventsPath);
		assert.equal(events.filter((e) => e.type === "dwf.trust_denied").length, 0, "no trust_denied when the user-tier opt-in is set");
		assert.equal(events.filter((e) => e.type === "dwf.started").length, 1, "dwf.started emitted — the user workflow executed");
	} finally {
		if (savedUser !== undefined) process.env.PI_CREW_TRUST_USER_DWF = savedUser;
		else delete process.env.PI_CREW_TRUST_USER_DWF;
		if (savedDet !== undefined) process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = savedDet;
		else delete process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
		env.cleanup();
	}
});

// ── w3-dwf-trust: dispatch-time script pin (manifest.dynamicScriptPin) ────

test("(g) dynamicScriptPin sha256 mismatch refuses to load the swapped script", async () => {
	const env = setupTempProject();
	const savedDet = process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
	process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = "1";

	try {
		const manifest = makeManifest(env.cwd);
		// Correct path, WRONG hash: simulates a plant that rewrote the script bytes
		// between dispatch and (re)load. The runner must refuse.
		manifest.dynamicScriptPin = { scriptPath: resolvePinPath(env.cwd, env.dwfPath), sha256: "deadbeef".repeat(8) };
		const workflow = makeDynamicWorkflow("builtin", env.dwfPath);
		const controller = new AbortController();

		await assert.rejects(runDynamicWorkflow({ manifest, workflow, signal: controller.signal }), (err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			assert.ok(msg.includes("dispatch-time pin"), `Error should mention the dispatch-time pin, got: ${msg}`);
			return true;
		});

		const events = readEvents(manifest.eventsPath);
		const denied = events.filter((e) => e.type === "dwf.trust_denied");
		assert.equal(denied.length, 1);
		assert.equal(denied[0].data?.reason, "script-pin-mismatch");
		assert.equal(events.filter((e) => e.type === "dwf.started").length, 0, "swapped script must NOT execute");
	} finally {
		if (savedDet !== undefined) process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = savedDet;
		else delete process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
		env.cleanup();
	}
});

test("(h) dynamicScriptPin match (path + sha256 of the exact bytes) proceeds", async () => {
	const env = setupTempProject();
	const savedDet = process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
	process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = "1";

	try {
		const manifest = makeManifest(env.cwd);
		const scriptPath = resolvePinPath(env.cwd, env.dwfPath);
		manifest.dynamicScriptPin = { scriptPath, sha256: createHash("sha256").update(readFileSync(scriptPath)).digest("hex") };
		const workflow = makeDynamicWorkflow("builtin", env.dwfPath);
		const controller = new AbortController();

		const result = await runDynamicWorkflow({ manifest, workflow, signal: controller.signal });
		assert.equal(result.manifest.status, "completed", "pinned script matching its dispatch bytes executes normally");
		assert.equal(readEvents(manifest.eventsPath).filter((e) => e.type === "dwf.trust_denied").length, 0);
	} finally {
		if (savedDet !== undefined) process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = savedDet;
		else delete process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
		env.cleanup();
	}
});
