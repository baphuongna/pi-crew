/**
 * Unit tests for team-tool status handler.
 * @see src/extension/team-tool/status.ts
 *
 * NOTE: handleStatus depends on run manifests on disk. We test
 * argument validation and error handling for missing/invalid params.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { handleStatus } from "../../../../src/extension/team-tool/status.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import type { TeamToolParamsValue } from "../../../../src/schema/team-tool-schema.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

function makeCtx(cwd: string): TeamContext {
	return { cwd };
}

function makeParams(overrides: Partial<TeamToolParamsValue> = {}): TeamToolParamsValue {
	return { ...overrides };
}

// ─── handleStatus ─────────────────────────────────────────────────────────────

describe("handleStatus", () => {
	it("returns error when runId is missing", () => {
		const tmp = createTrackedTempDir("status-test-");
		try {
			const res = handleStatus(makeParams(), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("runId"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns error when run is not found", () => {
		const tmp = createTrackedTempDir("status-test-");
		try {
			const res = handleStatus(makeParams({ runId: "nonexistent-run-999" }), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("not found"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("includes action=status in details", () => {
		const tmp = createTrackedTempDir("status-test-");
		try {
			const res = handleStatus(makeParams({ runId: "any-run-id" }), makeCtx(tmp));

			assert.strictEqual(res.details.action, "status");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns error status in details for missing run", () => {
		const tmp = createTrackedTempDir("status-test-");
		try {
			const res = handleStatus(makeParams({ runId: "missing" }), makeCtx(tmp));

			assert.strictEqual(res.details.status, "error");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});
