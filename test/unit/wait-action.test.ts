import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

test("wait returns immediately for already-completed run", async () => {
	const previousMock = process.env.PI_CREW_MOCK_LIVE_SESSION;
	const previousDepth = process.env.PI_CREW_DEPTH;
	process.env.PI_CREW_MOCK_LIVE_SESSION = "success";
	process.env.PI_CREW_DEPTH = "0";
	const cwd = createTrackedTempDir("pi-crew-wait-done-");
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		// Run a fast task that completes synchronously (mock mode)
		const run = await handleTeamTool(
			{
				action: "run",
				team: "fast-fix",
				goal: "wait test",
				config: { runtime: { mode: "live-session" } },
			},
			{ cwd },
		);
		assert.equal(run.isError, false);
		const runId = run.details.runId!;

		// wait should return immediately since run is already completed
		const waitResult = await handleTeamTool({ action: "wait", runId, config: { timeoutMs: 5000 } }, { cwd });
		assert.equal(waitResult.isError, false);
		assert.match(firstText(waitResult), /finished: completed/);
	} finally {
		restoreEnv("PI_CREW_MOCK_LIVE_SESSION", previousMock);
		restoreEnv("PI_CREW_DEPTH", previousDepth);
		removeTrackedTempDir(cwd);
	}
});

test("wait returns error for missing runId", async () => {
	const cwd = createTrackedTempDir("pi-crew-wait-noid-");
	try {
		const waitResult = await handleTeamTool({ action: "wait", config: { timeoutMs: 1000 } }, { cwd });
		assert.equal(waitResult.isError, true);
		assert.match(firstText(waitResult), /wait requires runId/);
	} finally {
		removeTrackedTempDir(cwd);
	}
});

test("wait returns error for non-existent run", async () => {
	const cwd = createTrackedTempDir("pi-crew-wait-noexist-");
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const waitResult = await handleTeamTool(
			{
				action: "wait",
				runId: "nonexistent-run-12345",
				config: { timeoutMs: 500 },
			},
			{ cwd },
		);
		assert.equal(waitResult.isError, true);
		assert.match(firstText(waitResult), /not found/);
	} finally {
		removeTrackedTempDir(cwd);
	}
});

// ---------------------------------------------------------------------------
// Cross-CWD locateRunCwd test
// ---------------------------------------------------------------------------

test("wait finds run in child directory when ctx.cwd is parent", async () => {
	const parentDir = createTrackedTempDir("pi-crew-wait-cross-cwd-");
	const childDir = path.join(parentDir, "pi-crew");
	try {
		fs.mkdirSync(childDir, { recursive: true });
		const stateRoot = path.join(childDir, ".crew", "state", "runs", "cross-cwd-run-001");
		fs.mkdirSync(stateRoot, { recursive: true });
		// Give the child dir its own .git marker so findRepoRoot resolves to childDir
		fs.writeFileSync(path.join(childDir, ".git"), "");
		// Create a completed manifest directly in the child's .crew/
		const manifest = {
			schemaVersion: 1,
			runId: "cross-cwd-run-001",
			team: "cross-cwd-test",
			status: "completed" as const,
			summary: "cross-CWD test run",
			goal: "cross-CWD",
			workspaceMode: "single" as const,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			cwd: childDir,
			stateRoot,
			artifactsRoot: path.join(childDir, ".crew", "artifacts", "cross-cwd-run-001"),
			tasksPath: path.join(stateRoot, "tasks.json"),
			eventsPath: path.join(stateRoot, "events.jsonl"),
			artifacts: [],
		};
		const tasks = [
			{
				id: "01_explore",
				runId: "cross-cwd-run-001",
				role: "explorer",
				agent: "explorer",
				title: "Explore",
				status: "completed" as const,
				dependsOn: [],
				cwd: childDir,
				createdAt: Date.now(),
				startedAt: Date.now(),
				completedAt: Date.now(),
				attempts: 1,
			},
			{
				id: "02_execute",
				runId: "cross-cwd-run-001",
				role: "executor",
				agent: "executor",
				title: "Execute",
				status: "completed" as const,
				dependsOn: [],
				cwd: childDir,
				createdAt: Date.now(),
				startedAt: Date.now(),
				completedAt: Date.now(),
				attempts: 1,
			},
		];
		fs.writeFileSync(path.join(stateRoot, "manifest.json"), JSON.stringify(manifest));
		fs.writeFileSync(path.join(stateRoot, "tasks.json"), JSON.stringify(tasks));
		// Call wait from the parent directory — locateRunCwd should scan children and find it
		const waitResult = await handleTeamTool(
			{
				action: "wait",
				runId: "cross-cwd-run-001",
				config: { timeoutMs: 2000 },
			},
			{ cwd: parentDir },
		);
		assert.equal(waitResult.isError, false);
		const text = firstText(waitResult);
		assert.match(text, /finished: completed/);
		assert.match(text, /01_explore.*completed/);
		assert.match(text, /02_execute.*completed/);
	} finally {
		removeTrackedTempDir(parentDir);
	}
});

// ---------------------------------------------------------------------------
// E2E wait with task breakdown verification
// ---------------------------------------------------------------------------

test("wait returns task breakdown for live-session run", async () => {
	const previousMock = process.env.PI_CREW_MOCK_LIVE_SESSION;
	const previousDepth = process.env.PI_CREW_DEPTH;
	process.env.PI_CREW_MOCK_LIVE_SESSION = "success";
	process.env.PI_CREW_DEPTH = "0";
	const cwd = createTrackedTempDir("pi-crew-wait-e2e-");
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		// Start a fast-fix run via live-session mock
		const run = await handleTeamTool(
			{
				action: "run",
				team: "fast-fix",
				goal: "e2e wait task breakdown test",
				config: { runtime: { mode: "live-session" } },
			},
			{ cwd },
		);
		assert.equal(run.isError, false);
		const runId = run.details.runId!;
		// Wait for completion
		const waitResult = await handleTeamTool({ action: "wait", runId, config: { timeoutMs: 10000 } }, { cwd });
		assert.equal(waitResult.isError, false);
		const text = firstText(waitResult);
		assert.match(text, /finished: completed/, `Expected 'finished: completed' in: ${text}`);
		// Verify task breakdown: fast-fix has 01_explore, 02_execute, 03_verify
		assert.match(text, /01_explore.*completed/s, `Expected '01_explore: completed' in: ${text}`);
		assert.match(text, /02_execute.*completed/s, `Expected '02_execute: completed' in: ${text}`);
		assert.match(text, /03_verify.*completed/s, `Expected '03_verify: completed' in: ${text}`);
	} finally {
		restoreEnv("PI_CREW_MOCK_LIVE_SESSION", previousMock);
		restoreEnv("PI_CREW_DEPTH", previousDepth);
		removeTrackedTempDir(cwd);
	}
});

// ---------------------------------------------------------------------------
// E2E cross-CWD wait with live-session mock
// ---------------------------------------------------------------------------

test("e2e wait from parent directory for live-session run in child", async () => {
	const previousMock = process.env.PI_CREW_MOCK_LIVE_SESSION;
	const previousDepth = process.env.PI_CREW_DEPTH;
	process.env.PI_CREW_MOCK_LIVE_SESSION = "success";
	process.env.PI_CREW_DEPTH = "0";
	const parentDir = createTrackedTempDir("pi-crew-wait-e2e-cross-");
	const childDir = path.join(parentDir, "pi-crew");
	try {
		fs.mkdirSync(childDir, { recursive: true });
		fs.mkdirSync(path.join(childDir, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(childDir, ".git"), "");
		// Start run from child directory
		const run = await handleTeamTool(
			{
				action: "run",
				team: "fast-fix",
				goal: "cross-CWD wait test",
				config: { runtime: { mode: "live-session" } },
			},
			{ cwd: childDir },
		);
		assert.equal(run.isError, false);
		const runId = run.details.runId!;
		// Wait from the parent directory — locateRunCwd scans children to find the run
		const waitResult = await handleTeamTool({ action: "wait", runId, config: { timeoutMs: 10000 } }, { cwd: parentDir });
		assert.equal(waitResult.isError, false);
		const text = firstText(waitResult);
		assert.match(text, /finished: completed/, `Expected 'finished: completed' in: ${text}`);
		assert.match(text, /01_explore.*completed/s);
		assert.match(text, /02_execute.*completed/s);
		assert.match(text, /03_verify.*completed/s);
	} finally {
		restoreEnv("PI_CREW_MOCK_LIVE_SESSION", previousMock);
		restoreEnv("PI_CREW_DEPTH", previousDepth);
		removeTrackedTempDir(parentDir);
	}
});
