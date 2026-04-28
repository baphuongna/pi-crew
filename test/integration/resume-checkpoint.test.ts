import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { readEvents } from "../../src/state/event-log.ts";
import { loadRunManifestById, saveRunTasks, updateRunStatus } from "../../src/state/state-store.ts";

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

test("resume recovers running task with artifact-written checkpoint without rerunning worker", async () => {
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-resume-checkpoint-"));
	try {
		const run = await handleTeamTool({ action: "run", team: "fast-fix", goal: "checkpoint recovery" }, { cwd });
		const runId = run.details?.runId;
		assert.ok(runId);
		const loaded = loadRunManifestById(cwd, runId)!;
		const task = loaded.tasks[0]!;
		assert.equal(task.status, "completed");
		assert.equal(task.checkpoint?.phase, "artifact-written");
		assert.ok(task.resultArtifact);
		const rewound = loaded.tasks.map((item, index) => index === 0 ? { ...item, status: "running" as const, finishedAt: undefined, claim: undefined, checkpoint: { phase: "artifact-written" as const, updatedAt: new Date().toISOString(), childPid: 12345 } } : item);
		saveRunTasks(loaded.manifest, rewound);
		updateRunStatus(loaded.manifest, "running", "simulate crash after artifact write");
		process.env.PI_TEAMS_MOCK_CHILD_PI = "fail";

		const resumed = await handleTeamTool({ action: "resume", runId }, { cwd });
		assert.equal(resumed.isError, false);
		const after = loadRunManifestById(cwd, runId)!;
		assert.equal(after.tasks[0]!.status, "completed");
		assert.equal(after.tasks[0]!.resultArtifact?.path, task.resultArtifact.path);
		const events = readEvents(after.manifest.eventsPath).filter((event) => event.type === "task.checkpoint_recovered");
		assert.equal(events.length, 1);
		assert.deepEqual(events[0]!.data, { taskIds: [task.id] });
	} finally {
		restoreEnv("PI_TEAMS_MOCK_CHILD_PI", previousMock);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
