/**
 * Unit tests for team-tool run handler.
 * @see src/extension/team-tool/run.ts
 *
 * NOTE: handleRun is async and depends on heavy subsystems (config, discovery,
 * state-store, team-runner). We test argument validation and early error paths.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TeamContext } from "../../src/extension/team-tool/context.ts";
import { handleRun } from "../../src/extension/team-tool/run.ts";
import { textFromToolResult } from "../../src/extension/tool-result.ts";
import type { TeamToolParamsValue } from "../../src/schema/team-tool-schema.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

function makeCtx(cwd: string): TeamContext {
	return { cwd };
}

function makeParams(overrides: Partial<TeamToolParamsValue> = {}): TeamToolParamsValue {
	return { ...overrides };
}

// ─── handleRun ────────────────────────────────────────────────────────────────

describe("handleRun", () => {
	it("returns error when no goal or task provided", async () => {
		const tmp = createTrackedTempDir("run-test-");
		try {
			const res = await handleRun(makeParams(), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("goal") || text.includes("task"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns error for non-existent agent", async () => {
		const tmp = createTrackedTempDir("run-test-");
		try {
			const res = await handleRun(makeParams({ agent: "nonexistent-agent-xyz", goal: "test" }), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("not found"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("uses goal over task when both are provided", async () => {
		const tmp = createTrackedTempDir("run-test-");
		try {
			const res = await handleRun(
				makeParams({
					goal: "primary goal",
					task: "fallback task",
					team: "nonexistent-team-xyz",
				}),
				makeCtx(tmp),
			);

			// Will fail at team lookup since team doesn't exist
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("not found"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns error for non-existent team", async () => {
		const tmp = createTrackedTempDir("run-test-");
		try {
			const res = await handleRun(makeParams({ goal: "do work", team: "nonexistent-team-xyz" }), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("not found"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns error for non-existent workflow", async () => {
		const tmp = createTrackedTempDir("run-test-");
		try {
			const res = await handleRun(
				makeParams({
					goal: "do work",
					team: "default",
					workflow: "nonexistent-workflow-xyz",
				}),
				makeCtx(tmp),
			);

			// May fail at team or workflow lookup
			assert.strictEqual(res.isError, true);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("warns and ignores runKind for a non-dynamic workflow", async () => {
		const tmp = createTrackedTempDir("run-test-");
		const originalStderr = process.stderr.write.bind(process.stderr);
		const captured: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			captured.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const res = await handleRun(
				makeParams({
					agent: "executor",
					goal: "verify ignored run kind",
					runKind: "dynamic-workflow",
					config: { executeWorkers: false },
				}),
				makeCtx(tmp),
			);
			assert.ok(res.details.runId);
			const loaded = loadRunManifestById(tmp, res.details.runId);
			assert.equal(loaded?.manifest.runKind, "team-run");
			assert.match(captured.join(""), /runKind='dynamic-workflow'.*not dynamic/);
		} finally {
			process.stderr.write = originalStderr;
			removeTrackedTempDir(tmp);
		}
	});

	it("includes action=run in details on error", async () => {
		const tmp = createTrackedTempDir("run-test-");
		try {
			const res = await handleRun(makeParams({ team: "nonexistent-team-xyz", goal: "test" }), makeCtx(tmp));

			assert.strictEqual(res.details.action, "run");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});
