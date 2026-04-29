import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { getBackgroundRunnerCommand, buildBackgroundSpawnOptions, resolveJitiRegisterPath } from "../../src/runtime/async-runner.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";

test("background runner uses the jiti runtime loader for installed TypeScript", () => {
	const command = getBackgroundRunnerCommand("/tmp/node_modules/pi-crew/src/runtime/background-runner.ts", "/tmp/project", "run_123", "/tmp/node_modules/pi-crew/node_modules/jiti/lib/jiti-register.mjs");
	assert.equal(command.loader, "jiti");
	assert.equal(command.args[0], "--import");
	assert.match(command.args[1] ?? "", /jiti-register\.mjs$/);
	assert.equal(command.args[2], "/tmp/node_modules/pi-crew/src/runtime/background-runner.ts");
	assert.deepEqual(command.args.slice(-4), ["--cwd", "/tmp/project", "--run-id", "run_123"]);
});

test("background runner resolves hoisted jiti loader path", () => {
	const root = path.join("tmp", "workspace", "node_modules", "pi-crew");
	const hoisted = path.join("tmp", "workspace", "node_modules", "jiti", "lib", "jiti-register.mjs");
	assert.equal(resolveJitiRegisterPath(root, (candidate) => candidate === hoisted), hoisted);
});

test("background runner command fails fast when jiti loader is missing", () => {
	assert.throws(() => getBackgroundRunnerCommand("/tmp/runner.ts", "/tmp/project", "run_123", false), /jiti loader not found/);
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
		stateRoot: "/tmp/project/.crew/state/runs/run_123",
		artifactsRoot: "/tmp/project/.crew/artifacts/run_123",
		tasksPath: "tasks.json",
		eventsPath: "events.jsonl",
		artifacts: [],
	};
	const options = buildBackgroundSpawnOptions(manifest, 1);
	assert.equal(options.windowsHide, true);
	assert.equal(options.detached, true);
});
