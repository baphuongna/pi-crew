import test from "node:test";
import assert from "node:assert/strict";
import { getBackgroundRunnerCommand, buildBackgroundSpawnOptions } from "../../src/runtime/async-runner.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";

test("background runner uses the jiti runtime loader for installed TypeScript", () => {
	const command = getBackgroundRunnerCommand("/tmp/node_modules/pi-crew/src/runtime/background-runner.ts", "/tmp/project", "run_123");
	assert.equal(command.loader, "jiti");
	assert.equal(command.args[0], "--import");
	assert.match(command.args[1] ?? "", /jiti-register\.mjs$/);
	assert.equal(command.args[2], "/tmp/node_modules/pi-crew/src/runtime/background-runner.ts");
	assert.deepEqual(command.args.slice(-4), ["--cwd", "/tmp/project", "--run-id", "run_123"]);
});

test("background runner spawn options hide Windows console windows", () => {
	const manifest: TeamRunManifest = {
		schemaVersion: 1,
		runId: "run_123",
		team: "research",
		workflow: "research",
		goal: "test",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: "/tmp/project",
		stateRoot: "/tmp/project/.pi/teams/state/runs/run_123",
		artifactsRoot: "/tmp/project/.pi/teams/artifacts/run_123",
		tasksPath: "tasks.json",
		eventsPath: "events.jsonl",
		artifacts: [],
	};
	const options = buildBackgroundSpawnOptions(manifest, 1);
	assert.equal(options.windowsHide, true);
	assert.equal(options.detached, true);
});
