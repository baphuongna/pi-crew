import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleCleanup, handleWorktrees } from "../../../../src/extension/team-tool/lifecycle-actions.ts";
import { readEvents } from "../../../../src/state/event-log/event-log.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import { textFromToolResult } from "../../../fixtures/tool-result-helpers.ts";

function createRun(): { cwd: string; runId: string; eventsPath: string } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-lifecycle-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const team = {
		name: "lifecycle",
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
		goal: "lifecycle",
	});
	return {
		cwd,
		runId: created.manifest.runId,
		eventsPath: created.manifest.eventsPath,
	};
}

test("handleWorktrees lists worktrees for a run in cwd", () => {
	const run = createRun();
	try {
		const result = handleWorktrees({ action: "worktrees", runId: run.runId }, { cwd: run.cwd });
		assert.equal(result.isError, false);
		assert.match(textFromToolResult(result), new RegExp(`Worktrees for ${run.runId}`));
		assert.match(textFromToolResult(result), /- \(none\)/);
	} finally {
		fs.rmSync(run.cwd, { recursive: true, force: true });
	}
});

test("handleWorktrees resolves run in nested child .crew via locateRunCwd", () => {
	const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-worktrees-cross-"));
	try {
		const childDir = path.join(parentDir, "pi-crew");
		fs.mkdirSync(path.join(childDir, ".crew"), { recursive: true });
		const team = {
			name: "lifecycle",
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
			cwd: childDir,
			team,
			workflow,
			goal: "worktrees cross-cwd",
		});
		// Call from the PARENT dir — locateRunCwd should scan immediate children and find it.
		const result = handleWorktrees({ action: "worktrees", runId: created.manifest.runId }, { cwd: parentDir });
		assert.equal(result.isError, false);
		assert.match(textFromToolResult(result), new RegExp(`Worktrees for ${created.manifest.runId}`));
	} finally {
		fs.rmSync(parentDir, { recursive: true, force: true });
	}
});

test("handleCleanup records audit intent on worktree cleanup events", async () => {
	const run = createRun();
	try {
		const result = await handleCleanup(
			{
				action: "cleanup",
				runId: run.runId,
				confirm: true,
				config: { _intent: "clean temporary worktrees before release" },
			},
			{ cwd: run.cwd },
		);
		assert.equal(result.isError, false);
		assert.equal(result.details.intent, "clean temporary worktrees before release");
		const events = readEvents(run.eventsPath);
		assert.ok(
			events.some((event) => event.type === "worktree.cleanup" && event.data?.intent === "clean temporary worktrees before release"),
		);
	} finally {
		fs.rmSync(run.cwd, { recursive: true, force: true });
	}
});
