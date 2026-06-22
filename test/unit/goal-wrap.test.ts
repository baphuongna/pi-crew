/**
 * goal-wrap unit tests (RFC v0.5 vision: apply goal completion-guarantee to builtins).
 *
 * Tests the config resolution + validation logic WITHOUT spawning the background
 * goal-loop (that's runtime-tested separately). Exercises:
 *   - isGoalWrapEnabled: only eligible builtins, respects config, default OFF
 *   - validateGoalWrapConfig: budget required / mutex / evaluatorModel required
 *   - GOAL_WRAP_ELIGIBLE_BUILTINS: implementation, fast-fix, default
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	GOAL_WRAP_ELIGIBLE_BUILTINS,
	GOAL_WRAP_MAX_STEPS,
	isGoalWrapEnabled,
	persistAsyncOnGoalLoopManifest,
	validateGoalWrapConfig,
} from "../../src/extension/team-tool/goal-wrap.ts";

function tmpCwd(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-goalwrap-"));
}

function writeConfig(cwd: string, config: unknown): void {
	const crewRoot = path.join(cwd, ".crew");
	fs.mkdirSync(crewRoot, { recursive: true });
	fs.writeFileSync(path.join(crewRoot, "config.json"), JSON.stringify(config));
}

test("GOAL_WRAP_ELIGIBLE_BUILTINS includes implementation, fast-fix, default", () => {
	assert.ok(GOAL_WRAP_ELIGIBLE_BUILTINS.has("implementation"));
	assert.ok(GOAL_WRAP_ELIGIBLE_BUILTINS.has("fast-fix"));
	assert.ok(GOAL_WRAP_ELIGIBLE_BUILTINS.has("default"));
	// Read-only workflows are NOT eligible.
	assert.ok(!GOAL_WRAP_ELIGIBLE_BUILTINS.has("review"));
	assert.ok(!GOAL_WRAP_ELIGIBLE_BUILTINS.has("research"));
	assert.ok(!GOAL_WRAP_ELIGIBLE_BUILTINS.has("parallel-research"));
});

test("isGoalWrapEnabled: returns false when no config (default OFF)", () => {
	const cwd = tmpCwd();
	try {
		// No .crew/config.json in a fresh tmp dir → goal-wrap must be OFF by default.
		assert.equal(isGoalWrapEnabled(cwd, "implementation"), false);
		assert.equal(isGoalWrapEnabled(cwd, "fast-fix"), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// Note: testing isGoalWrapEnabled=true requires loadConfig to find a temp .crew/config.json,
// which depends on projectCrewRoot's repo-root resolution (fragile in tmp dirs). The full
// integration is covered by runtime tests; here we verify the default-OFF path + the
// eligibility gate (which is pure logic) + the validation logic (pure).

// --- validateGoalWrapConfig ---

test("validateGoalWrapConfig: returns undefined for valid unlimited config", () => {
	assert.equal(validateGoalWrapConfig({ enabled: true, evaluatorModel: "minimax/MiniMax-M3", budgetUnlimited: true }), undefined);
});

test("validateGoalWrapConfig: returns undefined for valid budgetTotal config", () => {
	assert.equal(validateGoalWrapConfig({ enabled: true, evaluatorModel: "minimax/MiniMax-M3", budgetTotal: 5000 }), undefined);
});

test("validateGoalWrapConfig: requires evaluatorModel", () => {
	const err = validateGoalWrapConfig({ enabled: true, budgetUnlimited: true });
	assert.match(err ?? "", /evaluatorModel/i);
});

test("validateGoalWrapConfig: requires budget (no silent unbounded default)", () => {
	const err = validateGoalWrapConfig({ enabled: true, evaluatorModel: "x" });
	assert.match(err ?? "", /budgetTotal.*budgetUnlimited/i);
});

test("validateGoalWrapConfig: rejects both budgetTotal AND budgetUnlimited (mutex)", () => {
	const err = validateGoalWrapConfig({ enabled: true, evaluatorModel: "x", budgetTotal: 5000, budgetUnlimited: true });
	assert.match(err ?? "", /mutually exclusive/i);
});

test("validateGoalWrapConfig: rejects budgetTotal below 1000 floor", () => {
	const err = validateGoalWrapConfig({ enabled: true, evaluatorModel: "x", budgetTotal: 500 });
	assert.match(err ?? "", /budgetTotal.*1000|>=1000/i);
});

// Regression test: after goal-wrap spawns the background runner, the OUTER
// goal-loop manifest MUST have its `async.pid` field set on disk.
//
// Why: async-notifier.markDeadAsyncRunIfNeeded() reads `run.async?.pid` from
// the manifest to detect a dead background runner. Without this field, the
// notifier returns early and the user sees the goal hang at "1/3" forever —
// they have to kill pi to recover (even though the actual fix is just to
// surface the failure via `async.died`).
//
// We test the helper directly: persistAsyncOnGoalLoopManifest is the small
// helper that performs the missing atomic-write. startGoalWrappedRun calls
// it after spawnBackgroundTeamRun returns.
test("FIX: persistAsyncOnGoalLoopManifest writes async.pid on the goal-loop manifest", () => {
	const cwd = tmpCwd();
	try {
		const manifestPath = path.join(cwd, "manifest.json");
		const fakeManifest: import("../../src/state/types.ts").TeamRunManifest = {
			schemaVersion: 1 as const,
			runId: "goal_test",
			team: "goal-wrap-test",
			workflow: "goal-loop",
			goal: "test",
			status: "queued" as const,
			workspaceMode: "single" as const,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			cwd,
			stateRoot: cwd,
			artifactsRoot: cwd,
			tasksPath: "",
			eventsPath: "",
			artifacts: [],
			ownerSessionId: "sess",
			runKind: "goal-loop" as const,
		};
		persistAsyncOnGoalLoopManifest(manifestPath, fakeManifest, {
			pid: 99_999_999,
			logPath: "/tmp/fake.log",
		});
		const persisted = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
		const asyncField = persisted["async"] as Record<string, unknown> | undefined;
		assert.ok(asyncField, "manifest.async must be set so async-notifier can detect dead runner");
		assert.equal(asyncField["pid"], 99_999_999);
		assert.equal(asyncField["logPath"], "/tmp/fake.log");
		assert.ok(typeof asyncField["spawnedAt"] === "string", "spawnedAt must be ISO timestamp");
		// Other fields preserved.
		assert.equal(persisted["runId"], "goal_test");
		assert.equal(persisted["runKind"], "goal-loop");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("FIX: startGoalWrappedRun calls persistAsyncOnGoalLoopManifest after spawn", () => {
	// Black-box check: we don't actually run startGoalWrappedRun (it would spawn
	// a real runner). Instead we assert the helper exists and was called from
	// startGoalWrappedRun's source via grep. This catches accidental removal
	// during future refactors.
	const source = fs.readFileSync(
		new URL("../../src/extension/team-tool/goal-wrap.ts", import.meta.url),
		"utf-8",
	);
	assert.match(source, /persistAsyncOnGoalLoopManifest\(/, "startGoalWrappedRun must call persistAsyncOnGoalLoopManifest");
	assert.match(source, /async:\s*\{\s*pid:\s*spawned\.pid/, "manifest.async.pid must come from spawn result");
});

test("GOAL_WRAP_MAX_STEPS is 1 (single-step only — multi-step crashes non-deterministically)", () => {
	assert.equal(GOAL_WRAP_MAX_STEPS, 1, "GOAL_WRAP_MAX_STEPS must be 1; multi-step workflows crash in background goal-loop");
});

test("SAFETY: shouldGoalWrap returns {enabled:false, reason:'multi-step'} for multi-step workflows", async () => {
	const cwd = tmpCwd();
	try {
		writeConfig(cwd, {
			goalWrap: {
				"fast-fix": {
					enabled: true,
					maxTurns: 1,
					evaluatorModel: "minimax/MiniMax-M3",
					verification: { commands: ["npm test"] },
					budgetUnlimited: true,
				},
			},
		});

		// Load the real fast-fix workflow (3 steps: explore, execute, verify).
		const dwMod: any = await import("../../src/workflows/discover-workflows.ts");
		const dw = dwMod.default ?? dwMod;
		const wf = dw.allWorkflows(dw.discoverWorkflows(cwd)).find((w: { name: string }) => w.name === "fast-fix");
		if (!wf) {
			// fast-fix not bundled → skip
			return;
		}
		assert.ok(wf.steps.length > 1, `fast-fix must be multi-step for this test; got ${wf.steps.length} steps`);

		const gwMod: any = await import("../../src/extension/team-tool/goal-wrap.ts");
		const gw = gwMod.default ?? gwMod;
		const decision = gw.shouldGoalWrap(cwd, wf);
		assert.equal(decision.enabled, false, "multi-step goal-wrap must be bypassed (enabled=false)");
		assert.equal(decision.reason, "multi-step", "refusal reason must be 'multi-step'");
		assert.match((decision as { message?: string }).message ?? "", /multi-step/i, "message must explain multi-step crash");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("SAFETY: shouldGoalWrap returns {enabled:true} for single-step workflows (implementation)", async () => {
	const cwd = tmpCwd();
	try {
		writeConfig(cwd, {
			goalWrap: {
				"implementation": {
					enabled: true,
					maxTurns: 1,
					evaluatorModel: "minimax/MiniMax-M3",
					verification: { commands: ["npm test"] },
					budgetUnlimited: true,
				},
			},
		});

		const dwMod: any = await import("../../src/workflows/discover-workflows.ts");
		const dw = dwMod.default ?? dwMod;
		const wf = dw.allWorkflows(dw.discoverWorkflows(cwd)).find((w: { name: string }) => w.name === "implementation");
		if (!wf) {
			return; // skip if not bundled
		}
		assert.equal(wf.steps.length, 1, `implementation must be 1-step (adaptive assess); got ${wf.steps.length}`);

		const gwMod: any = await import("../../src/extension/team-tool/goal-wrap.ts");
		const gw = gwMod.default ?? gwMod;
		const decision = gw.shouldGoalWrap(cwd, wf);
		assert.equal(decision.enabled, true, "single-step goal-wrap must be accepted");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("shouldGoalWrap returns {enabled:false, reason:'config-off'} when goal-wrap not configured", async () => {
	const cwd = tmpCwd();
	try {
		// No config.json — goal-wrap is OFF by default.
		const dwMod: any = await import("../../src/workflows/discover-workflows.ts");
		const dw = dwMod.default ?? dwMod;
		const wf = dw.allWorkflows(dw.discoverWorkflows(cwd)).find((w: { name: string }) => w.name === "fast-fix");
		if (!wf) return;
		const gwMod: any = await import("../../src/extension/team-tool/goal-wrap.ts");
		const gw = gwMod.default ?? gwMod;
		const decision = gw.shouldGoalWrap(cwd, wf);
		assert.equal(decision.enabled, false);
		assert.equal(decision.reason, "config-off");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("shouldGoalWrap returns {enabled:false, reason:'invalid-config'} for malformed config", async () => {
	const cwd = tmpCwd();
	try {
		// Missing evaluatorModel + missing budget → invalid config.
		writeConfig(cwd, {
			goalWrap: { "fast-fix": { enabled: true } },
		});
		const dwMod: any = await import("../../src/workflows/discover-workflows.ts");
		const dw = dwMod.default ?? dwMod;
		const wf = dw.allWorkflows(dw.discoverWorkflows(cwd)).find((w: { name: string }) => w.name === "fast-fix");
		if (!wf) return;
		const gwMod: any = await import("../../src/extension/team-tool/goal-wrap.ts");
		const gw = gwMod.default ?? gwMod;
		const decision = gw.shouldGoalWrap(cwd, wf);
		assert.equal(decision.enabled, false);
		assert.equal(decision.reason, "invalid-config");
		assert.ok((decision as { message?: string }).message, "invalid-config must carry a message");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
