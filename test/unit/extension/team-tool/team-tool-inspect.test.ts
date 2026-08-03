/**
 * Unit tests for team-tool inspect handlers (events, artifacts, summary).
 * @see src/extension/team-tool/inspect.ts
 *
 * NOTE: These handlers depend heavily on filesystem state (run manifests, events).
 * We test argument validation and error handling for missing/invalid parameters.
 * Full integration tests would require creating run manifests on disk.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { handleArtifacts, handleEvents, handleSummary } from "../../../../src/extension/team-tool/inspect.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import type { TeamToolParamsValue } from "../../../../src/schema/team-tool-schema.ts";

function makeCtx(overrides: Partial<TeamContext> = {}): TeamContext {
	return { cwd: "/tmp/inspect-test", ...overrides };
}

function makeParams(overrides: Partial<TeamToolParamsValue> = {}): TeamToolParamsValue {
	return { ...overrides };
}

// ─── handleEvents ─────────────────────────────────────────────────────────────

describe("handleEvents", () => {
	it("returns error when runId is missing", () => {
		const res = handleEvents(makeParams(), makeCtx());

		assert.strictEqual(res.isError, true);
		const text = textFromToolResult(res);
		assert.ok(text.includes("runId"));
	});

	it("returns error when run is not found", () => {
		const res = handleEvents(makeParams({ runId: "nonexistent-run-999" }), makeCtx({ cwd: "/tmp/no-such-dir" }));

		assert.strictEqual(res.isError, true);
		const text = textFromToolResult(res);
		assert.ok(text.includes("not found"));
	});

	it("includes action=events in details", () => {
		const res = handleEvents(makeParams({ runId: "any-run" }), makeCtx());

		assert.strictEqual(res.details.action, "events");
	});
});

// ─── handleArtifacts ──────────────────────────────────────────────────────────

describe("handleArtifacts", () => {
	it("returns error when runId is missing", () => {
		const res = handleArtifacts(makeParams(), makeCtx());

		assert.strictEqual(res.isError, true);
		const text = textFromToolResult(res);
		assert.ok(text.includes("runId"));
	});

	it("returns error when run is not found", () => {
		const res = handleArtifacts(makeParams({ runId: "missing-run" }), makeCtx({ cwd: "/tmp/no-such-dir" }));

		assert.strictEqual(res.isError, true);
		const text = textFromToolResult(res);
		assert.ok(text.includes("not found"));
	});

	it("includes action=artifacts in details", () => {
		const res = handleArtifacts(makeParams({ runId: "any-run" }), makeCtx());

		assert.strictEqual(res.details.action, "artifacts");
	});
});

// ─── handleSummary ────────────────────────────────────────────────────────────

describe("handleSummary", () => {
	it("returns error when runId is missing", () => {
		const res = handleSummary(makeParams(), makeCtx());

		assert.strictEqual(res.isError, true);
		const text = textFromToolResult(res);
		assert.ok(text.includes("runId"));
	});

	it("returns error when run is not found", () => {
		const res = handleSummary(makeParams({ runId: "missing-run" }), makeCtx({ cwd: "/tmp/no-such-dir" }));

		assert.strictEqual(res.isError, true);
		const text = textFromToolResult(res);
		assert.ok(text.includes("not found"));
	});

	it("includes action=summary in details", () => {
		const res = handleSummary(makeParams({ runId: "any-run" }), makeCtx());

		assert.strictEqual(res.details.action, "summary");
	});
});
