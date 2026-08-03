/**
 * Integration check: validates pi-crew core discovery and team-run functionality.
 * Run with: node --experimental-strip-types --test test-integration-check.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { discoverAgents, allAgents } from "./src/agents/discover-agents.ts";
import { discoverTeams, allTeams } from "./src/teams/discover-teams.ts";
import { discoverWorkflows, allWorkflows } from "./src/workflows/discover-workflows.ts";
import { handleTeamTool } from "./src/extension/team-tool.ts";
import { loadRunManifestById } from "./src/state/stores/state-store.ts";

const pkgRoot = path.resolve(import.meta.dirname ?? ".");

// ── Discovery tests ──────────────────────────────────────────────────────

test("discovers builtin agents", () => {
	const discovery = discoverAgents(pkgRoot);
	assert.ok(discovery, "discoverAgents should return a result");
	assert.ok(
		discovery.builtin.length >= 10,
		`Expected ≥10 builtin agents, got ${discovery.builtin.length}`,
	);
	const all = allAgents(discovery);
	const names = all.map((a) => a.name);
	assert.ok(names.includes("executor"), `Missing "executor" agent. Got: ${names.join(", ")}`);
});

test("discovers builtin teams", () => {
	const discovery = discoverTeams(pkgRoot);
	assert.ok(discovery, "discoverTeams should return a result");
	assert.ok(
		discovery.builtin.length >= 6,
		`Expected ≥6 builtin teams, got ${discovery.builtin.length}`,
	);
	const all = allTeams(discovery);
	const names = all.map((t) => t.name);
	assert.ok(names.includes("fast-fix"), `Missing "fast-fix" team. Got: ${names.join(", ")}`);
});

test("discovers builtin workflows", () => {
	const discovery = discoverWorkflows(pkgRoot);
	assert.ok(discovery, "discoverWorkflows should return a result");
	assert.ok(
		discovery.builtin.length >= 6,
		`Expected ≥6 builtin workflows, got ${discovery.builtin.length}`,
	);
	const all = allWorkflows(discovery);
	const names = all.map((w) => w.name);
	assert.ok(
		names.includes("fast-fix"),
		`Missing "fast-fix" workflow. Got: ${names.join(", ")}`,
	);
});

// ── Team run test ─────────────────────────────────────────────────────────

test("fast-fix team run completes successfully with mock child Pi", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-int-check-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });

	const prevExec = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const prevMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const prevAllow = process.env.PI_CREW_ALLOW_MOCK;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "success";

	try {
		const run = await handleTeamTool(
			{ action: "run", team: "fast-fix", goal: "create a hello.txt file" },
			{ cwd },
		);

		// run result is not an error
		assert.equal(run.isError, false, `handleTeamTool returned error: ${JSON.stringify(run)}`);

		const runId = run.details.runId;
		assert.ok(runId, "Expected a runId in details");

		// manifest should be persisted and completed
		const loaded = loadRunManifestById(cwd, runId!);
		assert.ok(loaded, "loadRunManifestById should return data");
		assert.equal(
			loaded!.manifest.status,
			"completed",
			`Expected manifest status "completed", got "${loaded!.manifest.status}"`,
		);

		// all tasks should be completed
		const taskStatuses = loaded!.tasks.map((t) => t.status);
		assert.ok(
			taskStatuses.every((s) => s === "completed"),
			`Not all tasks completed: ${JSON.stringify(taskStatuses)}`,
		);

		// artifacts directory should exist
		const artifactsDir = path.join(cwd, ".crew", "artifacts", runId!);
		assert.ok(
			fs.existsSync(artifactsDir),
			`Artifacts directory should exist: ${artifactsDir}`,
		);

		console.log(`✅ fast-fix run ${runId} completed successfully with ${loaded!.tasks.length} tasks`);
	} finally {
		if (prevExec === undefined) delete process.env.PI_TEAMS_EXECUTE_WORKERS;
		else process.env.PI_TEAMS_EXECUTE_WORKERS = prevExec;
		if (prevMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = prevMock;
		if (prevAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = prevAllow;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
