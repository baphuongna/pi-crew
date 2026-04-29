import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTeamTask } from "../../src/runtime/task-runner.ts";
import { createRunManifest, loadRunManifestById } from "../../src/state/state-store.ts";

const team = { name: "t", description: "", source: "test", filePath: "t", roles: [{ name: "r", agent: "a" }] } as const;
const workflow = { name: "w", description: "", source: "test", filePath: "w", steps: [{ id: "s", role: "r", task: "x" }] } as const;
const agent = { name: "a", description: "", source: "test", filePath: "a", systemPrompt: "test" } as const;

test("runTeamTask refreshes worker heartbeat while child JSON events stream", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-task-heartbeat-"));
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	try {
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const created = createRunManifest({ cwd, team: team as never, workflow: workflow as never, goal: "heartbeat" });
		const task = created.tasks[0]!;
		const staleHeartbeat = { workerId: task.id, lastSeenAt: "2026-01-01T00:00:00.000Z", alive: true };
		await runTeamTask({ manifest: created.manifest, tasks: [{ ...task, heartbeat: staleHeartbeat }], task: { ...task, heartbeat: staleHeartbeat }, step: workflow.steps[0] as never, agent: agent as never, executeWorkers: true, runtimeKind: "child-process" });
		const loaded = loadRunManifestById(cwd, created.manifest.runId);
		const updated = loaded?.tasks[0]?.heartbeat;
		assert.ok(updated);
		assert.notEqual(updated.lastSeenAt, staleHeartbeat.lastSeenAt);
	} finally {
		if (previousMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
