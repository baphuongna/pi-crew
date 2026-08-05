import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildConfiguredModelRouting } from "../../../../src/runtime/model/model-fallback.ts";

/**
 * [L-NEW-2] Tests for the one-shot re-resolve logic in child-executor.ts.
 *
 * The full child-executor flow (runWorker, spawn, heartbeat, transcript
 * parsing) is too complex to unit-test in isolation — it requires deep
 * mocking of child processes, event streams, and state stores. Instead we
 * test the `buildConfiguredModelRouting` behavior that POWERS the re-resolve:
 * when only `parentModel` is provided (no agent/caller override), the
 * function returns candidate models that may differ from the original
 * attempt chain.
 *
 * The one-shot guard (`reResolveUsed` boolean) and spawn-budget increment
 * (`input.spawnBudget.max += 1`) are structurally enforced in child-executor.ts
 * — they are simple boolean/numeric mutations guarded by `if` conditions,
 * not testable here without the full child-executor mock. Previously this
 * file held two local-simulation tests for those guards; they were REMOVED
 * (Round-2 audit F4) because they were vacuous — they asserted against local
 * variables, not the real child-executor code, so they would pass even if the
 * guards were deleted. The guards are instead exercised by the T7 smoke
 * verifier (real-binary) and integration runs.
 */

function mockRegistry(models: string[]): { getAvailable(): unknown[] } {
	return {
		getAvailable: () =>
			models.map((fullId) => ({
				provider: fullId.split("/")[0],
				id: fullId.split("/").slice(1).join("/"),
				fullId,
			})),
	};
}

function tempCwd(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-reresolve-"));
}

/** Create a temp cwd and auto-clean it after the callback finishes. */
function withTempCwd<T>(fn: (cwd: string) => T): T {
	const cwd = tempCwd();
	try {
		return fn(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

// ── Re-resolve finds alternatives outside the original chain ──────────────

test("re-resolve: parentModel-only routing returns candidates not in the original chain", () => {
	// Simulate: model "anthropic/claude-sonnet" failed (retryable).
	// The re-resolve in child-executor calls buildConfiguredModelRouting
	// with ONLY parentModel set (override/step/teamRole/agent all undefined).
	// It should return candidate models from the registry that are DIFFERENT
	// from the failed parent — these become the retry alternatives.
	withTempCwd((cwd) => {
		const registry = mockRegistry(["openai/gpt-5", "anthropic/claude-sonnet", "google/gemini-pro"]);

		const routing = buildConfiguredModelRouting({
			parentModel: "anthropic/claude-sonnet",
			modelRegistry: registry,
			cwd,
		});

		// The parent model itself should be candidates[0] (B3 inheritance),
		// but there MUST be other candidates that the re-resolve can pick.
		assert.ok(routing.candidates.length > 1, "should have fallback candidates beyond the parent");
		assert.ok(routing.candidates.includes("anthropic/claude-sonnet"), "parent model should be in candidates");

		// The re-resolve logic in child-executor.ts does:
		//   const tried = new Set(modelAttempts.map(a => a.model));
		//   const alt = reResolved.candidates.find(c => !tried.has(c));
		// Verify there IS at least one candidate not equal to the parent.
		const tried = new Set(["anthropic/claude-sonnet"]);
		const alt = routing.candidates.find((c) => !tried.has(c));
		assert.ok(alt, "re-resolve must find at least one untried alternative");
		assert.notEqual(alt, "anthropic/claude-sonnet");
	});
});

// ── Re-resolve with scope patterns: soft sources warn (not throw) ─────────

test("re-resolve: parentModel-only out-of-scope does NOT throw (source=resolved)", () => {
	// The re-resolve always passes parentModel only → source is always
	// "resolved" (soft warn). This must NOT throw even when the resolved
	// model is outside the scope allowlist.
	withTempCwd((cwd) => {
		const registry = mockRegistry(["openai/gpt-5", "anthropic/claude-sonnet"]);

		const routing = buildConfiguredModelRouting({
			parentModel: "anthropic/claude-sonnet",
			modelRegistry: registry,
			cwd,
			scopeModelsPatterns: ["openai/*"],
		});

		// parentModel resolves to "resolved" source → soft warn, no throw.
		assert.equal(routing.scopeVerdict?.inScope, false);
		assert.equal(routing.scopeVerdict?.source, "resolved");
		assert.equal(routing.scopeVerdict?.model, "anthropic/claude-sonnet");
	});
});
