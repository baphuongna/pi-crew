import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { runTeamTask } from "../../../../src/runtime/task-runner.ts";
import { createRunManifest, loadRunManifestById } from "../../../../src/state/stores/state-store.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

const team = {
	name: "t",
	description: "",
	source: "test",
	filePath: "t",
	roles: [{ name: "r", agent: "a" }],
} as const;
const workflow = {
	name: "w",
	description: "",
	source: "test",
	filePath: "w",
	steps: [{ id: "s", role: "r", task: "x" }],
} as const;
const agent = {
	name: "a",
	description: "",
	source: "test",
	filePath: "a",
	systemPrompt: "test",
} as const;

test("runTeamTask refreshes worker heartbeat while child JSON events stream", async () => {
	let cwd = createTrackedTempDir("pi-crew-task-heartbeat-");
	// Canonicalize to long-name form matching production code
	try {
		const r = fs.realpathSync.native(cwd);
		cwd = r.startsWith("\\\\?\\") ? r.slice(4) : r;
	} catch {
		/* keep as-is */
	}
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const previousAllowMock = process.env.PI_CREW_ALLOW_MOCK;
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	try {
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const created = createRunManifest({
			cwd,
			team: team as never,
			workflow: workflow as never,
			goal: "heartbeat",
		});
		const task = created.tasks[0]!;
		const staleHeartbeat = {
			workerId: task.id,
			lastSeenAt: "2026-01-01T00:00:00.000Z",
			alive: true,
		};
		await runTeamTask({
			manifest: created.manifest,
			tasks: [{ ...task, heartbeat: staleHeartbeat }],
			task: { ...task, heartbeat: staleHeartbeat },
			step: workflow.steps[0] as never,
			agent: agent as never,
			executeWorkers: true,
			runtimeKind: "child-process",
			workspaceId: cwd,
		});
		const loaded = loadRunManifestById(cwd, created.manifest.runId);
		const updated = loaded?.tasks[0]?.heartbeat;
		assert.ok(updated);
		assert.notEqual(updated.lastSeenAt, staleHeartbeat.lastSeenAt);
	} finally {
		// Round 19 fix: restore BOTH vars correctly. Previously this restored
		// the wrong var (PI_CREW_ALLOW_MOCK), set 'undefined' as a string, and
		// never restored PI_CREW_ALLOW_MOCK → leaked into sibling tests.
		if (previousMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock;
		if (previousAllowMock === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = previousAllowMock;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
