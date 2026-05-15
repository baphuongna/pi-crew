import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { createRunManifest, saveRunTasks } from "../../src/state/state-store.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dispatch-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function cleanupCwd(cwd: string): void {
	fs.rmSync(cwd, { recursive: true, force: true });
}

/**
 * Create a minimal run manifest + a single running task under `cwd`.
 * Returns the runId and manifest for use in tests.
 */
function seedRun(cwd: string, sessionId?: string): { runId: string } {
	const team = { name: "dispatch-test", description: "", roles: [{ name: "worker", agent: "worker" }], source: "test", filePath: "builtin" } as never;
	const workflow = { name: "wf", description: "", steps: [{ id: "one", role: "worker" }], source: "test", filePath: "builtin" } as never;
	const created = createRunManifest({ cwd, team, workflow, goal: "dispatch test", ownerSessionId: sessionId });
	saveRunTasks(created.manifest, [
		{ id: "task-1", runId: created.manifest.runId, role: "worker", agent: "worker", title: "task", status: "running", dependsOn: [], cwd },
	]);
	return { runId: created.manifest.runId };
}

// ---------------------------------------------------------------------------
// 1. Unknown action returns error
// ---------------------------------------------------------------------------

test("handleTeamTool returns error for unknown action", async () => {
	const cwd = makeTmpCwd();
	try {
		// Cast to bypass the TS literal union — this is intentional for the test
		const out = await handleTeamTool({ action: "nonexistent" as never }, { cwd });
		assert.equal(out.isError, true, "should be an error result");
		assert.match(firstText(out), /Unknown action: nonexistent/);
		assert.equal(out.details.status, "error");
	} finally {
		cleanupCwd(cwd);
	}
});

// ---------------------------------------------------------------------------
// 2. "list" action returns ok with resource lists
// ---------------------------------------------------------------------------

test("handleTeamTool 'list' returns ok with team/workflow/agent headings", async () => {
	const cwd = makeTmpCwd();
	try {
		const out = await handleTeamTool({ action: "list" }, { cwd });
		assert.equal(out.isError, false, "list should not error");
		const text = firstText(out);
		assert.match(text, /Teams:/);
		assert.match(text, /Workflows:/);
		assert.match(text, /Agents:/);
		assert.match(text, /Recent runs:/);
	} finally {
		cleanupCwd(cwd);
	}
});

// ---------------------------------------------------------------------------
// 3. "status" action delegates to handleStatus (requires runId)
// ---------------------------------------------------------------------------

test("handleTeamTool 'status' returns error without runId", async () => {
	const cwd = makeTmpCwd();
	try {
		const out = await handleTeamTool({ action: "status" }, { cwd });
		assert.equal(out.isError, true);
		assert.match(firstText(out), /Status requires runId/);
	} finally {
		cleanupCwd(cwd);
	}
});

test("handleTeamTool 'status' returns run details for valid runId", async () => {
	const cwd = makeTmpCwd();
	try {
		const { runId } = seedRun(cwd);
		const out = await handleTeamTool({ action: "status", runId }, { cwd });
		assert.equal(out.isError, false);
		const text = firstText(out);
		assert.match(text, new RegExp(`Run: ${runId}`));
		assert.match(text, /Task counts:/);
		assert.equal(out.details.action, "status");
	} finally {
		cleanupCwd(cwd);
	}
});

// ---------------------------------------------------------------------------
// 4. "cancel" action delegates to handleCancel
// ---------------------------------------------------------------------------

test("handleTeamTool 'cancel' returns error without runId", async () => {
	const cwd = makeTmpCwd();
	try {
		const out = await handleTeamTool({ action: "cancel" }, { cwd });
		assert.equal(out.isError, true);
		assert.match(firstText(out), /Cancel requires runId/);
	} finally {
		cleanupCwd(cwd);
	}
});

test("handleTeamTool 'cancel' cancels a running run", async () => {
	const cwd = makeTmpCwd();
	try {
		const { runId } = seedRun(cwd, "session-dispatch");
		const out = await handleTeamTool(
			{ action: "cancel", runId },
			{ cwd, sessionId: "session-dispatch" },
		);
		assert.equal(out.isError, false);
		assert.match(firstText(out), /Cancelled/);
		assert.equal(out.details.action, "cancel");
	} finally {
		cleanupCwd(cwd);
	}
});

// ---------------------------------------------------------------------------
// 5. "forget" action delegates to handleForget
// ---------------------------------------------------------------------------

test("handleTeamTool 'forget' returns error without runId", async () => {
	const cwd = makeTmpCwd();
	try {
		const out = await handleTeamTool({ action: "forget" }, { cwd });
		assert.equal(out.isError, true);
		assert.match(firstText(out), /Forget requires runId/);
	} finally {
		cleanupCwd(cwd);
	}
});

test("handleTeamTool 'forget' returns error without confirm", async () => {
	const cwd = makeTmpCwd();
	try {
		const { runId } = seedRun(cwd);
		const out = await handleTeamTool({ action: "forget", runId }, { cwd });
		assert.equal(out.isError, true);
		assert.match(firstText(out), /confirm: true/);
	} finally {
		cleanupCwd(cwd);
	}
});

// ---------------------------------------------------------------------------
// 6. "cleanup" action delegates to handleCleanup
// ---------------------------------------------------------------------------

test("handleTeamTool 'cleanup' returns error without runId", async () => {
	const cwd = makeTmpCwd();
	try {
		const out = await handleTeamTool({ action: "cleanup" }, { cwd });
		assert.equal(out.isError, true);
		assert.match(firstText(out), /Cleanup requires runId/);
	} finally {
		cleanupCwd(cwd);
	}
});

test("handleTeamTool 'cleanup' succeeds for a valid run", async () => {
	const cwd = makeTmpCwd();
	try {
		const { runId } = seedRun(cwd);
		const out = await handleTeamTool({ action: "cleanup", runId }, { cwd });
		assert.equal(out.isError, false);
		assert.match(firstText(out), /Worktree cleanup/);
		assert.equal(out.details.action, "cleanup");
	} finally {
		cleanupCwd(cwd);
	}
});

// ---------------------------------------------------------------------------
// 7. "settings" action delegates to handleSettings
// ---------------------------------------------------------------------------

test("handleTeamTool 'settings' returns settings list", async () => {
	const cwd = makeTmpCwd();
	try {
		const out = await handleTeamTool({ action: "settings" }, { cwd });
		assert.equal(out.isError, false);
		const text = firstText(out);
		assert.match(text, /pi-crew (effective )?settings:/);
		assert.match(text, /Config file:/);
		assert.equal(out.details.action, "settings");
	} finally {
		cleanupCwd(cwd);
	}
});

// ---------------------------------------------------------------------------
// 8. Intent-gated actions reject without intent confirmation
// ---------------------------------------------------------------------------

const INTENT_POLICY_CONFIG = { policy: { requireIntentForDestructiveActions: true } };

test("intent-gated 'cancel' rejects without config.intent", async () => {
	const cwd = makeTmpCwd();
	try {
		const { runId } = seedRun(cwd, "session-intent");
		const out = await handleTeamTool(
			{ action: "cancel", runId },
			{ cwd, sessionId: "session-intent", config: INTENT_POLICY_CONFIG },
		);
		assert.equal(out.isError, true);
		assert.match(firstText(out), /requires config\.intent/);
	} finally {
		cleanupCwd(cwd);
	}
});

test("intent-gated 'prune' rejects without config.intent", async () => {
	const cwd = makeTmpCwd();
	try {
		const out = await handleTeamTool(
			{ action: "prune", confirm: true },
			{ cwd, config: INTENT_POLICY_CONFIG },
		);
		assert.equal(out.isError, true);
		assert.match(firstText(out), /requires config\.intent/);
	} finally {
		cleanupCwd(cwd);
	}
});

test("intent-gated 'forget' rejects without config.intent", async () => {
	const cwd = makeTmpCwd();
	try {
		const { runId } = seedRun(cwd);
		const out = await handleTeamTool(
			{ action: "forget", runId, confirm: true },
			{ cwd, config: INTENT_POLICY_CONFIG },
		);
		assert.equal(out.isError, true);
		assert.match(firstText(out), /requires config\.intent/);
	} finally {
		cleanupCwd(cwd);
	}
});

test("intent-gated 'cleanup' with force rejects without config.intent", async () => {
	const cwd = makeTmpCwd();
	try {
		const { runId } = seedRun(cwd);
		const out = await handleTeamTool(
			{ action: "cleanup", runId, force: true },
			{ cwd, config: INTENT_POLICY_CONFIG },
		);
		assert.equal(out.isError, true);
		assert.match(firstText(out), /requires config\.intent/);
	} finally {
		cleanupCwd(cwd);
	}
});
