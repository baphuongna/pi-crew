import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { getBackgroundRunnerCommand, buildBackgroundSpawnOptions, resolveJitiRegisterPath, resolveTypeScriptLoader, nodeSupportsStripTypes } from "../../src/runtime/async-runner.ts";
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
	const hoisted = path.resolve(path.join("tmp", "workspace", "node_modules", "jiti", "lib", "jiti-register.mjs"));
	assert.equal(resolveJitiRegisterPath(root, (candidate) => candidate === hoisted), hoisted);
});

test("background runner resolves local-source jiti loader in parent node_modules", () => {
	const root = path.join("tmp", "workspace", "pi-crew");
	const local = path.resolve(path.join("tmp", "workspace", "node_modules", "jiti", "lib", "jiti-register.mjs"));
	assert.equal(resolveJitiRegisterPath(root, (candidate) => candidate === local), local);
});

test("background runner command fails fast when no loader is available", () => {
	assert.throws(() => getBackgroundRunnerCommand("/tmp/runner.ts", "/tmp/project", "run_123", false), /jiti loader not found/);
});

test("nodeSupportsStripTypes accepts Node >= 22.6", () => {
	assert.equal(nodeSupportsStripTypes("v22.6.0"), true);
	assert.equal(nodeSupportsStripTypes("v22.14.0"), true);
	assert.equal(nodeSupportsStripTypes("v23.0.0"), true);
	assert.equal(nodeSupportsStripTypes("v22.5.1"), false);
	assert.equal(nodeSupportsStripTypes("v20.15.0"), false);
	assert.equal(nodeSupportsStripTypes("v18.20.0"), false);
	assert.equal(nodeSupportsStripTypes("not-a-version"), false);
});

test("resolveTypeScriptLoader prefers jiti when available", () => {
	const root = path.join("tmp", "workspace", "pi-crew");
	const jitiPath = path.resolve(path.join("tmp", "workspace", "node_modules", "jiti", "lib", "jiti-register.mjs"));
	const loader = resolveTypeScriptLoader({
		packageRoot: root,
		exists: (candidate) => candidate === jitiPath,
		nodeVersion: "v22.14.0",
	});
	assert.deepEqual(loader, { kind: "jiti", path: jitiPath });
});

test("resolveTypeScriptLoader falls back to strip-types when jiti is missing and Node >= 22.6", () => {
	const loader = resolveTypeScriptLoader({
		packageRoot: "/nonexistent",
		exists: () => false,
		nodeVersion: "v22.14.0",
	});
	assert.deepEqual(loader, { kind: "strip-types" });
});

test("resolveTypeScriptLoader returns undefined when jiti missing and Node < 22.6", () => {
	const loader = resolveTypeScriptLoader({
		packageRoot: "/nonexistent",
		exists: () => false,
		nodeVersion: "v20.15.0",
	});
	assert.equal(loader, undefined);
});

test("getBackgroundRunnerCommand emits --experimental-strip-types args for strip-types loader", () => {
	const command = getBackgroundRunnerCommand("/tmp/runner.ts", "/tmp/project", "run_123", { kind: "strip-types" });
	assert.equal(command.loader, "strip-types");
	assert.equal(command.args[0], "--experimental-strip-types");
	assert.equal(command.args[1], "/tmp/runner.ts");
	assert.deepEqual(command.args.slice(-4), ["--cwd", "/tmp/project", "--run-id", "run_123"]);
});

test("getBackgroundRunnerCommand accepts loader-spec input directly", () => {
	const jitiPath = "/tmp/x/node_modules/jiti/lib/jiti-register.mjs";
	const command = getBackgroundRunnerCommand("/tmp/runner.ts", "/tmp/project", "run_123", { kind: "jiti", path: jitiPath });
	assert.equal(command.loader, "jiti");
	assert.match(command.args[1] ?? "", /jiti-register\.mjs$/);
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
