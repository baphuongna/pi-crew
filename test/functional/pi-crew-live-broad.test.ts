/**
 * pi-crew Live Test (broad) — Run pi-crew with REAL LLM, multiple scenarios.
 *
 * Verifies that the H-7 step 6 regression fix works across multiple models,
 * teams, and goal complexity. Uses real pi binary + real provider.
 *
 * Run with: npx tsx --test test/functional/pi-crew-live-broad.test.ts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";

function mkTmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-live-broad-"));
	fs.mkdirSync(path.join(dir, ".crew"));
	return dir;
}

function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

async function runLive(
	team: string,
	goal: string,
	model: string,
	sampleText: string,
): Promise<{
	success: boolean;
	tasksCompleted: number;
	totalTokens: number;
	error?: string;
}> {
	const cwd = mkTmp();
	try {
		fs.writeFileSync(path.join(cwd, "sample.txt"), sampleText);
		const result = await handleTeamTool({ action: "run", team, goal, model }, { cwd });
		if (result.isError) {
			return {
				success: false,
				tasksCompleted: 0,
				totalTokens: 0,
				error: (result.content?.[0] as any)?.text?.slice(0, 300) ?? "isError=true",
			};
		}
		const runId = result.details.runId;
		const loaded = loadRunManifestById(cwd, runId!);
		const completedTasks = loaded?.tasks.filter((t) => t.status === "completed") ?? [];
		const totalTokens = completedTasks.reduce((s, t) => s + (t.usage?.input ?? 0) + (t.usage?.output ?? 0), 0);
		return {
			success: completedTasks.length > 0,
			tasksCompleted: completedTasks.length,
			totalTokens,
		};
	} finally {
		cleanup(cwd);
	}
}

// ── Test 1: simple task with minimax (fast model) ─────────────────────

test("LIVE BROAD: simple task with minimax/minimax-m3", async () => {
	const r = await runLive(
		"fast-fix",
		"Read sample.txt and tell me the first word",
		"minimax/minimax-m3",
		"The quick brown fox jumps over the lazy dog.",
	);
	console.log("  →", JSON.stringify(r));
	assert.equal(r.success, true, `run failed: ${r.error}`);
	assert.ok(r.tasksCompleted >= 1);
	assert.ok(r.totalTokens > 0, "real LLM call should report token usage");
});

// ── Test 2: same task with zai (different provider) ──────────────────

test("LIVE BROAD: same task with zai provider", async () => {
	const r = await runLive("fast-fix", "Read sample.txt and tell me the first word", "zai/glm-5.2", "hello world this is a test");
	console.log("  →", JSON.stringify(r));
	// zai/glm-5.2 may not exist; skip if model unavailable
	if (r.error?.includes("Unknown Model") || r.error?.includes("not found")) {
		console.log("  (skipped: zai/glm-5.2 unavailable)");
		return;
	}
	assert.equal(r.success, true, `run failed: ${r.error}`);
});

// ── Test 3: research team (multi-task workflow) ──────────────────────

test("LIVE BROAD: research team with multiple tasks", async () => {
	const r = await runLive(
		"research",
		"Read sample.txt and summarize what it says in one sentence",
		"minimax/minimax-m3",
		"Pi-crew is a multi-agent orchestration extension for pi. It coordinates teams of agents to execute complex tasks.",
	);
	console.log("  →", JSON.stringify(r));
	assert.equal(r.success, true, `run failed: ${r.error}`);
	assert.ok(r.tasksCompleted >= 2, "research team should run multiple tasks");
});

// ── Test 4: parallel-research team ──────────────────────────────────

test("LIVE BROAD: parallel-research team", async () => {
	const r = await runLive(
		"parallel-research",
		"Read sample.txt and list 3 key points",
		"minimax/minimax-m3",
		"Distributed systems coordinate multiple nodes via consensus protocols. They trade consistency for availability during network partitions.",
	);
	console.log("  →", JSON.stringify(r));
	assert.equal(r.success, true, `run failed: ${r.error}`);
});

// ── Test 5: long-running task with retries (forced via no-tools agent) ─

test("LIVE BROAD: fast-fix with realistic goal", async () => {
	const r = await runLive(
		"fast-fix",
		"Look at sample.txt — list every word on a separate line with its index",
		"minimax/minimax-m3",
		"alpha beta gamma delta epsilon zeta eta theta",
	);
	console.log("  →", JSON.stringify(r));
	assert.equal(r.success, true, `run failed: ${r.error}`);
});
