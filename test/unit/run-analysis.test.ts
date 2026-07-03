/**
 * Integration-style unit tests for the analysis channel on `team action='run'`.
 * Runs in scaffold mode so no child Pi workers spawn.
 * @see src/extension/team-tool/run.ts (resolveAnalysisText + analysis artifact write)
 * @see workflows/plan-execute.workflow.md
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

function makeRunCwd(): string {
	// realpathSync: os.tmpdir() is a symlink on macOS (/var → /private/var) and
	// can be an 8.3 short name on Windows. writeArtifact stores canonicalized
	// paths, so exact-string path assertions below need a canonical cwd too —
	// without this the manifest.artifacts[] lookup fails on macOS/Windows CI.
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-analysis-test-")));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

test("run with inline analysis writes shared/analysis.md and registers artifact", async () => {
	const cwd = makeRunCwd();
	try {
		const analysis = "# Our findings\n\n- A is broken\n- B needs refactor";
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "default",
				workflow: "plan-execute",
				goal: "fix A and refactor B",
				analysis,
			},
			{ cwd },
		);
		assert.equal(run.isError, false, firstText(run));
		const runId = run.details.runId!;
		const artifactsRoot = path.join(cwd, ".crew", "artifacts", runId);
		const analysisPath = path.join(artifactsRoot, "shared", "analysis.md");
		assert.ok(fs.existsSync(analysisPath), "analysis.md should exist at shared/analysis.md");
		const written = fs.readFileSync(analysisPath, "utf-8");
		assert.ok(written.includes("A is broken"));
		assert.ok(written.includes("B needs refactor"));

		const manifest = loadRunManifestById(cwd, runId)?.manifest;
		assert.ok(manifest);
		const analysisDescriptor = manifest!.artifacts.find((a) =>
			a.path === path.join(artifactsRoot, "shared", "analysis.md"),
		);
		assert.ok(analysisDescriptor, "analysis artifact must be in manifest.artifacts[]");
		assert.equal(analysisDescriptor!.kind, "prompt");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("run with analysisPath loads file content into shared/analysis.md", async () => {
	const cwd = makeRunCwd();
	try {
		const analysisPath = path.join(cwd, "notes.md");
		fs.writeFileSync(
			analysisPath,
			"# Pre-analysis\n\nUser says: fix the race condition in payment retry.",
			"utf-8",
		);
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "default",
				workflow: "plan-execute",
				goal: "fix race in payment retry",
				analysisPath: "notes.md",
			},
			{ cwd },
		);
		assert.equal(run.isError, false, firstText(run));
		const runId = run.details.runId!;
		const written = fs.readFileSync(path.join(cwd, ".crew", "artifacts", runId, "shared", "analysis.md"), "utf-8");
		assert.ok(written.includes("race condition in payment retry"));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("run injects analysis into plan step prompt via dependency context", async () => {
	const cwd = makeRunCwd();
	try {
		const uniqueMarker = "ANALYSIS_MARKER_x7k2";
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "default",
				workflow: "plan-execute",
				goal: "do something",
				analysis: `Goal context: ${uniqueMarker}`,
			},
			{ cwd },
		);
		assert.equal(run.isError, false, firstText(run));
		const runId = run.details.runId!;
		const planPrompt = fs.readFileSync(path.join(cwd, ".crew", "artifacts", runId, "prompts", "01_plan.md"), "utf-8");
		assert.ok(
			planPrompt.includes(uniqueMarker),
			"plan step prompt must contain analysis content (sharedReads injection)",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("run rejects analysisPath that escapes cwd (path traversal)", async () => {
	const cwd = makeRunCwd();
	try {
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "default",
				goal: "x",
				analysisPath: "../../../etc/passwd",
			},
			{ cwd },
		);
		assert.equal(run.isError, true);
		assert.match(firstText(run), /within project directory/i);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("run returns friendly error when analysisPath file is missing", async () => {
	const cwd = makeRunCwd();
	try {
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "default",
				goal: "x",
				analysisPath: "does-not-exist.md",
			},
			{ cwd },
		);
		assert.equal(run.isError, true);
		assert.match(firstText(run), /Analysis file not found/i);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("run rejects analysisPath file larger than 100KB cap", async () => {
	const cwd = makeRunCwd();
	try {
		fs.writeFileSync(path.join(cwd, "big.md"), "x".repeat(100_001), "utf-8");
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "default",
				goal: "x",
				analysisPath: "big.md",
			},
			{ cwd },
		);
		assert.equal(run.isError, true);
		assert.match(firstText(run), /Analysis file too large/i);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("run rejects analysis and analysisPath set together", async () => {
	const cwd = makeRunCwd();
	try {
		fs.writeFileSync(path.join(cwd, "notes.md"), "x", "utf-8");
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "default",
				goal: "x",
				analysis: "inline notes",
				analysisPath: "notes.md",
			},
			{ cwd },
		);
		assert.equal(run.isError, true);
		assert.match(firstText(run), /mutually exclusive/i);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("plan-execute runs without analysis (reads filter empty content)", async () => {
	const cwd = makeRunCwd();
	try {
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "default",
				workflow: "plan-execute",
				goal: "do something without analysis",
			},
			{ cwd },
		);
		assert.equal(run.isError, false, firstText(run));
		const runId = run.details.runId!;
		// plan prompt should still be written; sharedReads filter gracefully.
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "artifacts", runId, "prompts", "01_plan.md")));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("direct-agent run with analysis injects into agent prompt", async () => {
	const cwd = makeRunCwd();
	try {
		const uniqueMarker = "DIRECT_AGENT_ANALYSIS_MARKER_q9z";
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				agent: "planner",
				goal: "plan the work",
				analysis: `Pre-analysis context: ${uniqueMarker}`,
			},
			{ cwd },
		);
		assert.equal(run.isError, false, firstText(run));
		const runId = run.details.runId!;
		const artifactsRoot = path.join(cwd, ".crew", "artifacts", runId);
		// shared/analysis.md must exist
		assert.ok(fs.existsSync(path.join(artifactsRoot, "shared", "analysis.md")));
		// agent prompt must contain the analysis content via sharedReads injection
		const promptsDir = path.join(artifactsRoot, "prompts");
		const promptFiles = fs.readdirSync(promptsDir).filter((f) => f.endsWith(".md"));
		assert.ok(promptFiles.length > 0, "expected at least one prompt file");
		const agentPrompt = fs.readFileSync(path.join(promptsDir, promptFiles[0]!), "utf-8");
		assert.ok(
			agentPrompt.includes(uniqueMarker),
			"direct-agent prompt must contain analysis content (sharedReads injection)",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
