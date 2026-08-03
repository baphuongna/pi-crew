import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/stores/state-store.ts";
import { createTrackedTempDir } from "../fixtures/test-tempdir.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

test("team run creates durable artifacts and status", async () => {
	const cwd = createTrackedTempDir("pi-crew-run-test-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "default",
				goal: "Test durable run",
			},
			{ cwd },
		);
		assert.equal(run.isError, false);
		const runId = run.details.runId;
		assert.ok(runId);
		const stateRoot = path.join(cwd, ".crew", "state", "runs", runId!);
		const artifactsRoot = path.join(cwd, ".crew", "artifacts", runId!);
		assert.ok(fs.existsSync(path.join(stateRoot, "manifest.json")));
		assert.ok(fs.existsSync(path.join(stateRoot, "tasks.json")));
		assert.ok(fs.existsSync(path.join(stateRoot, "events.jsonl")));
		assert.ok(fs.existsSync(path.join(artifactsRoot, "goal.md")));
		assert.ok(fs.existsSync(path.join(artifactsRoot, "prompts", "01_explore.md")));

		const loaded = loadRunManifestById(cwd, runId!);
		assert.equal(loaded?.manifest.runtimeResolution?.kind, "scaffold");
		assert.equal(loaded?.manifest.runtimeResolution?.safety, "explicit_dry_run");
		const status = await handleTeamTool({ action: "status", runId }, { cwd });
		assert.equal(status.isError, false);
		assert.match(firstText(status), /Status: completed/);
		assert.match(firstText(status), /Runtime safety: explicit_dry_run/);
		assert.match(firstText(status), /Recent events:/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("team run blocks implicit scaffold when worker execution is disabled", async () => {
	const cwd = createTrackedTempDir("pi-crew-run-disabled-workers-");
	const previous = process.env.PI_CREW_EXECUTE_WORKERS;
	process.env.PI_CREW_EXECUTE_WORKERS = "0";
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool({ action: "run", team: "default", goal: "should not no-op" }, { cwd });
		assert.equal(run.isError, true);
		assert.match(firstText(run), /real subagent workers are disabled/i);
		assert.match(firstText(run), /runtime\.mode=scaffold only for explicit dry-run/i);
		const runId = run.details.runId;
		assert.ok(runId);
		const loaded = loadRunManifestById(cwd, runId);
		assert.equal(loaded?.manifest.runtimeResolution?.safety, "blocked");
	} finally {
		restoreEnv("PI_CREW_EXECUTE_WORKERS", previous);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("team resume blocks implicit scaffold when worker execution is disabled", async () => {
	const cwd = createTrackedTempDir("pi-crew-resume-disabled-workers-");
	const previous = process.env.PI_CREW_EXECUTE_WORKERS;
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "default",
				goal: "create resumable run",
			},
			{ cwd },
		);
		assert.equal(run.isError, false);
		const runId = run.details.runId;
		assert.ok(runId);
		process.env.PI_CREW_EXECUTE_WORKERS = "0";
		const resumed = await handleTeamTool({ action: "resume", runId }, { cwd });
		assert.equal(resumed.isError, true);
		assert.match(firstText(resumed), /blocked resume/i);
		assert.match(firstText(resumed), /real subagent workers are disabled/i);
		assert.match(firstText(resumed), /runtime\.mode=scaffold only for explicit dry-run/i);
		const status = await handleTeamTool({ action: "status", runId }, { cwd });
		assert.match(firstText(status), /Status: blocked/);
	} finally {
		restoreEnv("PI_CREW_EXECUTE_WORKERS", previous);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
