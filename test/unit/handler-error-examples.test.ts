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
import { handleApi } from "../../src/extension/team-tool/api.ts";
import { handleCancel } from "../../src/extension/team-tool/cancel.ts";
import type { TeamContext } from "../../src/extension/team-tool/context.ts";
import { handleArtifacts, handleEvents, handleSummary } from "../../src/extension/team-tool/inspect.ts";
import { handleRespond } from "../../src/extension/team-tool/respond.ts";
import { handleRun } from "../../src/extension/team-tool/run.ts";
import { handleStatus } from "../../src/extension/team-tool/status.ts";
import { textFromToolResult } from "../../src/extension/tool-result.ts";
import type { TeamToolParamsValue } from "../../src/schema/team-tool-schema.ts";
import { createRunManifest, saveRunTasks } from "../../src/state/state-store.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

function makeCtx(cwd: string): TeamContext {
	return { cwd };
}

function makeParams(overrides: Partial<TeamToolParamsValue> = {}): TeamToolParamsValue {
	return { ...overrides };
}

/** Seed a minimal run so handleApi subAction guards (which run after manifest
 *  load) can be exercised. Returns the runId. */
function seedApiRun(cwd: string): { runId: string } {
	const team = {
		name: "ext2-api-test",
		description: "",
		roles: [{ name: "worker", agent: "worker" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const workflow = {
		name: "wf",
		description: "",
		steps: [{ id: "one", role: "worker" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const created = createRunManifest({ cwd, team, workflow, goal: "ext2 api test" });
	saveRunTasks(created.manifest, [
		{
			id: "task-1",
			runId: created.manifest.runId,
			role: "worker",
			agent: "worker",
			title: "task",
			status: "running",
			dependsOn: [],
			cwd,
		},
	]);
	return { runId: created.manifest.runId };
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

describe("EXT-2: api.ts subAction missing-field errors include example shapes", () => {
	it("read-task error includes an example shape", async () => {
		const tmp = createTrackedTempDir("ext2-api-readtask-");
		try {
			const { runId } = seedApiRun(tmp);
			const res = await handleApi(makeParams({ runId, config: { operation: "read-task", taskId: "no-such-task" } }), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /Example:/);
			assert.match(text, /operation:\s*['"]read-task['"]/);
			assert.match(text, /taskId:\s*['"]01_01-agent['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("get-agent-result error includes an example shape", async () => {
		const tmp = createTrackedTempDir("ext2-api-getagent-");
		try {
			const { runId } = seedApiRun(tmp);
			const res = await handleApi(makeParams({ runId, config: { operation: "get-agent-result" } }), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /Example:/);
			assert.match(text, /operation:\s*['"]get-agent-result['"]/);
			assert.match(text, /agentId:\s*['"]agent-1['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("nudge-agent error includes an example shape", async () => {
		const tmp = createTrackedTempDir("ext2-api-nudge-");
		try {
			const { runId } = seedApiRun(tmp);
			const res = await handleApi(makeParams({ runId, config: { operation: "nudge-agent" } }), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /Example:/);
			assert.match(text, /operation:\s*['"]nudge-agent['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("send-message error includes an example shape", async () => {
		const tmp = createTrackedTempDir("ext2-api-sendmsg-");
		try {
			const { runId } = seedApiRun(tmp);
			const res = await handleApi(makeParams({ runId, config: { operation: "send-message" } }), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /Example:/);
			assert.match(text, /operation:\s*['"]send-message['"]/);
			assert.match(text, /body:\s*['"]<message>['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("ack-message error includes an example shape", async () => {
		const tmp = createTrackedTempDir("ext2-api-ackmsg-");
		try {
			const { runId } = seedApiRun(tmp);
			const res = await handleApi(makeParams({ runId, config: { operation: "ack-message" } }), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /Example:/);
			assert.match(text, /operation:\s*['"]ack-message['"]/);
			assert.match(text, /messageId:\s*['"]msg-1['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("transition-task-status error includes an example shape", async () => {
		const tmp = createTrackedTempDir("ext2-api-transition-");
		try {
			const { runId } = seedApiRun(tmp);
			const res = await handleApi(makeParams({ runId, config: { operation: "transition-task-status" } }), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /Example:/);
			assert.match(text, /operation:\s*['"]transition-task-status['"]/);
			assert.match(text, /status:\s*['"]done['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("write-heartbeat error includes an example shape", async () => {
		const tmp = createTrackedTempDir("ext2-api-heartbeat-");
		try {
			const { runId } = seedApiRun(tmp);
			const res = await handleApi(
				makeParams({ runId, config: { operation: "write-heartbeat", taskId: "no-such-task" } }),
				makeCtx(tmp),
			);
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /Example:/);
			assert.match(text, /operation:\s*['"]write-heartbeat['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});
