import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { parseConfig } from "../../../../src/config/config.ts";
import { handleCancel } from "../../../../src/extension/team-tool/cancel.ts";
import { handleCleanup } from "../../../../src/extension/team-tool/lifecycle-actions.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../../../src/state/stores/state-store.ts";

const policy = { policy: { requireIntentForDestructiveActions: true } };

function createRun(): {
	cwd: string;
	runId: string;
	manifest: ReturnType<typeof createRunManifest>["manifest"];
} {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-intent-policy-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const team = {
		name: "intent",
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
	const created = createRunManifest({
		cwd,
		team,
		workflow,
		goal: "intent",
		ownerSessionId: "session-a",
	});
	return { cwd, runId: created.manifest.runId, manifest: created.manifest };
}

test("parseConfig accepts policy.requireIntentForDestructiveActions", () => {
	const config = parseConfig(policy);
	assert.equal(config.policy?.requireIntentForDestructiveActions, true);
});

test("cancel is blocked by intent policy before state mutation", async () => {
	const run = createRun();
	try {
		saveRunTasks(run.manifest, [
			{
				id: "task-1",
				runId: run.runId,
				role: "worker",
				agent: "worker",
				title: "task",
				status: "running",
				dependsOn: [],
				cwd: run.cwd,
			},
		]);
		const out = await handleCancel(
			{ action: "cancel", runId: run.runId },
			{
				cwd: run.cwd,
				sessionId: "session-a",
				config: parseConfig(policy),
			},
		);
		assert.equal(out.isError, true);
		assert.match(textFromToolResult(out), /requires config\.intent/);
		assert.equal(loadRunManifestById(run.cwd, run.runId)?.manifest.status, "queued");
		assert.equal(loadRunManifestById(run.cwd, run.runId)?.tasks[0]?.status, "running");
	} finally {
		fs.rmSync(run.cwd, { recursive: true, force: true });
	}
});

test("cancel proceeds when required intent is supplied", async () => {
	const run = createRun();
	try {
		saveRunTasks(run.manifest, [
			{
				id: "task-1",
				runId: run.runId,
				role: "worker",
				agent: "worker",
				title: "task",
				status: "running",
				dependsOn: [],
				cwd: run.cwd,
			},
		]);
		const out = await handleCancel(
			{
				action: "cancel",
				runId: run.runId,
				config: { intent: "stop runaway background worker" },
			},
			{
				cwd: run.cwd,
				sessionId: "session-a",
				config: parseConfig(policy),
			},
		);
		assert.equal(out.isError, false);
		assert.equal(out.details.intent, "stop runaway background worker");
		assert.equal(loadRunManifestById(run.cwd, run.runId)?.manifest.status, "cancelled");
	} finally {
		fs.rmSync(run.cwd, { recursive: true, force: true });
	}
});

test("cleanup requires intent only when force is set", async () => {
	const run = createRun();
	try {
		const normal = await handleCleanup(
			{ action: "cleanup", runId: run.runId, confirm: true },
			{
				cwd: run.cwd,
				sessionId: "session-a",
				config: parseConfig(policy),
			},
		);
		assert.equal(normal.isError, false);
		const forced = await handleCleanup(
			{ action: "cleanup", runId: run.runId, force: true, confirm: true },
			{
				cwd: run.cwd,
				sessionId: "session-a",
				config: parseConfig(policy),
			},
		);
		assert.equal(forced.isError, true);
		assert.match(textFromToolResult(forced), /requires config\.intent/);
	} finally {
		fs.rmSync(run.cwd, { recursive: true, force: true });
	}
});
