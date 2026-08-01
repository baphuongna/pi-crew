/**
 * Unit tests for EXT-2: runtime handler missing-field errors include example
 * shapes so calling agents (LLMs) can self-correct.
 * @see src/extension/team-tool/param-error.ts (paramRequired)
 * @see docs/AUDIT-2026-07-30.md (### EXT-2)
 *
 * EXT-2 (AUDIT-2026-07-30): the schema-validation path (`formatTeamToolParamError`)
 * provides rich examples, but runtime handler errors used to return a plain
 * `"X requires Y."` with NO example — giving LLMs worse guidance for the MORE
 * COMMON failure (valid action, missing field). These tests assert the
 * missing-field error string CONTAINS an example shape.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TeamContext } from "../../src/extension/team-tool/context.ts";
import { handleCancel } from "../../src/extension/team-tool/cancel.ts";
import { handleArtifacts, handleEvents, handleSummary } from "../../src/extension/team-tool/inspect.ts";
import { handleRespond } from "../../src/extension/team-tool/respond.ts";
import { handleRun } from "../../src/extension/team-tool/run.ts";
import { handleStatus } from "../../src/extension/team-tool/status.ts";
import { textFromToolResult } from "../../src/extension/tool-result.ts";
import type { TeamToolParamsValue } from "../../src/schema/team-tool-schema.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

function makeCtx(cwd: string): TeamContext {
	return { cwd };
}

function makeParams(overrides: Partial<TeamToolParamsValue> = {}): TeamToolParamsValue {
	return { ...overrides };
}

describe("EXT-2: handler missing-field errors include example shapes", () => {
	it("handleRun includes an example shape when goal/task missing", async () => {
		const tmp = createTrackedTempDir("ext2-run-");
		try {
			const res = await handleRun(makeParams(), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /action:\s*['"]run['"]/);
			assert.match(text, /goal:\s*['"]<what to achieve>['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("handleStatus includes an example shape when runId missing", () => {
		const tmp = createTrackedTempDir("ext2-status-");
		try {
			const res = handleStatus(makeParams(), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /action:\s*['"]status['"]/);
			assert.match(text, /runId:\s*['"]team_\.\.\.['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("handleCancel includes an example shape when runId missing", async () => {
		const tmp = createTrackedTempDir("ext2-cancel-");
		try {
			const res = await handleCancel(makeParams(), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /action:\s*['"]cancel['"]/);
			assert.match(text, /runId:\s*['"]team_\.\.\.['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("handleRespond includes an example shape when runId missing", () => {
		const tmp = createTrackedTempDir("ext2-respond-");
		try {
			const res = handleRespond(makeParams(), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /action:\s*['"]respond['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("handleRespond includes an example shape when message/taskId missing", () => {
		const tmp = createTrackedTempDir("ext2-respond-msg-");
		try {
			// runId present, but neither message nor taskId → second guard fires.
			const res = handleRespond(makeParams({ runId: "team_does-not-exist" }), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /action:\s*['"]respond['"]/);
			assert.match(text, /taskId:\s*['"]01_agent['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("handleEvents includes an example shape when runId missing", () => {
		const tmp = createTrackedTempDir("ext2-events-");
		try {
			const res = handleEvents(makeParams(), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /action:\s*['"]events['"]/);
			assert.match(text, /runId:\s*['"]team_\.\.\.['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("handleArtifacts includes an example shape when runId missing", () => {
		const tmp = createTrackedTempDir("ext2-artifacts-");
		try {
			const res = handleArtifacts(makeParams(), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /action:\s*['"]artifacts['"]/);
			assert.match(text, /runId:\s*['"]team_\.\.\.['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("handleSummary includes an example shape when runId missing", () => {
		const tmp = createTrackedTempDir("ext2-summary-");
		try {
			const res = handleSummary(makeParams(), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /action:\s*['"]summary['"]/);
			assert.match(text, /runId:\s*['"]team_\.\.\.['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});
