/**
 * Finding #1 pin tests (full battery 2026-09-29): goal-loop manifests must
 * persist `modelContext` so DETACHED runs restore the parent session's model
 * routing instead of silently falling back to the default chain (live: minimax
 * 402 while the parent ran zai/glm-5.3).
 *
 * `goal start`/`goal resume`/goal-wrap call spawnBackgroundTeamRun directly,
 * so a behavioral unit test would need a real detached spawn (process-leak —
 * see team-tool-parallel.test.ts for the discipline). Following the
 * goal-wrap.test.ts precedent ("FIX: startGoalWrappedRun calls
 * persistAsyncOnGoalLoopManifest after spawn"), the wiring is pinned by
 * source anchors; removing the wiring removes the matched text.
 *
 * The manifest-creation primitive itself is behaviorally pinned in
 * team-tool-parallel.test.ts ("persists modelContext on dispatched run
 * manifests") via createRunManifest.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";

function readSource(relative: string): string {
	return fs.readFileSync(new URL(`../../../../${relative}`, import.meta.url), "utf-8");
}

function countMatches(source: string, pattern: RegExp): number {
	return [...source.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))].length;
}

test("goal.ts: start + resume manifests persist captureRunModelContext output", () => {
	const source = readSource("src/extension/team-tool/goal.ts");
	assert.match(
		source,
		/import \{ captureRunModelContext \} from "\.\.\/\.\.\/runtime\/model\/session-model\.ts";/,
		"goal.ts must capture the parent model routing in-process (session-model state is process-local)",
	);
	// Exactly two manifest literals (handleStart's goalLoopManifest +
	// handleResume's relaunch manifest) must carry the snapshot.
	assert.equal(
		countMatches(source, /\.\.\.\(modelContext \? \{ modelContext \} : \{\}\),/),
		2,
		"both goal-loop manifests (start + resume) must spread modelContext",
	);
});

test("goal-wrap.ts: goal-loop manifest persists captureRunModelContext output", () => {
	const source = readSource("src/extension/team-tool/goal-wrap.ts");
	assert.match(
		source,
		/import \{ captureRunModelContext \} from "\.\.\/\.\.\/runtime\/model\/session-model\.ts";/,
		"goal-wrap.ts must capture the parent model routing in-process",
	);
	assert.ok(
		countMatches(source, /\.\.\.\(modelContext \? \{ modelContext \} : \{\}\),/) >= 1,
		"the goal-wrap goal-loop manifest must spread modelContext",
	);
});

test("goal-loop-runner.ts: per-turn runs restore model routing from the outer manifest", () => {
	const source = readSource("src/runtime/goal-workflow/goal-loop-runner.ts");
	assert.match(
		source,
		/import \{ registryFromModelContext \} from "\.\.\/model\/session-model\.ts";/,
		"goal-loop-runner must rebuild the model registry from the persisted context",
	);
	// The turn manifest carries the snapshot forward (status/resume paths).
	assert.match(
		source,
		/\.\.\.\(manifest\.modelContext \? \{ modelContext: manifest\.modelContext \} : \{\}\),/,
		"per-turn createRunManifest must inherit the outer manifest's modelContext",
	);
	// The turn's executeTeamRun gets the restored routing inputs — this is the
	// line that actually un-defaults the model chain for detached goal loops.
	assert.match(
		source,
		/\.\.\.restoredTurnModelRouting\(manifest\),/,
		"per-turn executeTeamRun must receive modelOverride/parentModel/modelRegistry restored from the outer manifest",
	);
});

test("async-runner.ts: model env forwards without weakening the secret guard", () => {
	// Cross-file consistency pin: the two env channels must stay in sync with
	// the allowlist test in test/unit/runtime/core/async-runner.test.ts.
	const source = readSource("src/runtime/async-runner.ts");
	assert.match(source, /"PI_CREW_MODEL",/, "PI_CREW_MODEL must be allowlisted for detached runs");
	assert.match(source, /"PI_CREW_MODEL_FALLBACK_ORDER",/, "PI_CREW_MODEL_FALLBACK_ORDER must be allowlisted");
	// The credentials flag rides forwardModelControlEnv instead (isSecretKey
	// false-positive on "_CREDENTIALS" would throw sanitizeEnvSecrets when unset).
	assert.match(
		source,
		/MODEL_CONTROL_ENV_EXPLICIT: readonly string\[\] = \["PI_CREW_MODEL_REQUIRE_CREDENTIALS"\]/,
		"PI_CREW_MODEL_REQUIRE_CREDENTIALS must be explicitly forwarded, not allowlisted",
	);
});
