/**
 * WP-8 (R8) model-routing transparency tests:
 * pre-run budget summary (chain + worst-case spawns), loud passthrough
 * warnings (deduped), per-attempt model lines in the transcript pane.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { summarizeModelBudget } from "../../../../src/runtime/model/model-budget-summary.ts";
import { resetPassthroughWarnings, resolveModelCandidate } from "../../../../src/runtime/model/model-fallback.ts";
import { computeSpawnBudgetMax } from "../../../../src/runtime/task-runner/child-executor.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import { renderTranscriptPane } from "../../../../src/ui/dashboard-panes/transcript-pane.ts";
import type { RunUiSnapshot } from "../../../../src/ui/snapshot-types.ts";

function tempCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mb-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

const CATALOG = [
	{ id: "glm-5.3", provider: "zai", fullId: "zai/glm-5.3" },
	{ id: "qwen3.7-max", provider: "qwencoder", fullId: "qwencoder/qwen3.7-max" },
] as never;

test("budget formula: attemptModels × (maxAttempts + 1)", () => {
	assert.equal(computeSpawnBudgetMax(3, 3), 12);
	assert.equal(computeSpawnBudgetMax(1, 0), 1);
	assert.equal(computeSpawnBudgetMax(7, 3), 28);
});

test("summarizeModelBudget: never throws on a bare workspace; line carries chain + worst-case math", () => {
	const cwd = tempCwd();
	fs.rmSync(cwd, { recursive: true, force: true }); // hostile: no state at all
	const summary = summarizeModelBudget(cwd);
	assert.ok(Number.isFinite(summary.worstCaseSpawnsPerTask));
	assert.ok(summary.maxAttempts >= 1);
	assert.match(summary.line, /model routing:/);
	assert.match(summary.line, /worst-case \d+ spawns\/task/);
	// Worst-case = max(1, chain.length) × (maxAttempts + 1) — self-consistent.
	assert.equal(summary.worstCaseSpawnsPerTask, computeSpawnBudgetMax(Math.max(1, summary.chain.length), summary.maxAttempts));
});

test("summarizeModelBudget: honors configured maxAttempts (config可靠性)", () => {
	const cwd = tempCwd();
	fs.writeFileSync(path.join(cwd, ".crew", "config.json"), JSON.stringify({ reliability: { retryPolicy: { maxAttempts: 7 } } }));
	try {
		const summary = summarizeModelBudget(cwd);
		assert.equal(summary.maxAttempts, 7);
		assert.ok(summary.line.includes("maxAttempts+1=8"));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("passthrough warning: provider-qualified ref warns ONCE (deduped) and still returns the model", () => {
	resetPassthroughWarnings();
	const original = console.warn;
	const warned: string[] = [];
	console.warn = (msg: string) => warned.push(String(msg));
	try {
		assert.equal(resolveModelCandidate("zai/glm-5.3", CATALOG), "zai/glm-5.3");
		assert.equal(resolveModelCandidate("zai/glm-5.3", CATALOG), "zai/glm-5.3", "second resolve returns the same model");
		assert.equal(resolveModelCandidate("zai/glm-5.3", CATALOG), "zai/glm-5.3", "third resolve too");
	} finally {
		console.warn = original;
	}
	const passthrough = warned.filter((w) => w.includes("unvalidated passthrough"));
	assert.equal(passthrough.length, 1, "deduped to exactly one warning");
	assert.match(passthrough[0] ?? "", /provider-qualified ref/);
});

test("passthrough warning: no-catalog and no-match paths warn with their reasons; exact match stays silent", () => {
	resetPassthroughWarnings();
	const original = console.warn;
	const warned: string[] = [];
	console.warn = (msg: string) => warned.push(String(msg));
	try {
		assert.equal(resolveModelCandidate("some-model", undefined), "some-model");
		assert.equal(resolveModelCandidate("ghost-model-xyz", CATALOG), "ghost-model-xyz");
		assert.equal(resolveModelCandidate("glm-5.3", CATALOG), "zai/glm-5.3", "exact match resolves — NO warning");
	} finally {
		console.warn = original;
	}
	const reasons = warned.filter((w) => w.includes("unvalidated passthrough")).map((w) => (w.match(/\((.*?)\)/) ?? [])[1]);
	assert.ok(reasons.includes("no model catalog available"), String(reasons));
	assert.ok(reasons.includes("no exact or fuzzy catalog match"), String(reasons));
	assert.equal(reasons.filter((r) => r === "provider-qualified ref, no catalog check").length, 0, "different models do not collide");
});

function snapshotWith(tasks: TeamTaskState[]): RunUiSnapshot {
	const manifest = { runId: "r1", cwd: "/tmp", goal: "g" } as unknown as TeamRunManifest;
	return {
		runId: "r1",
		cwd: "/tmp",
		fetchedAt: Date.now(),
		signature: "t",
		manifest,
		tasks,
		agents: [],
		progress: { total: tasks.length, completed: 0, failed: 0, running: 0, queued: 0 },
		usage: { inputTokens: 0, outputTokens: 0, totalCost: 0 },
		mailbox: { inbox: [], outbox: [], waiting: [], messageUnread: 0 },
		recentEvents: [],
		recentOutputLines: [],
	} as unknown as RunUiSnapshot;
}

test("transcript pane: per-attempt model lines (newest first, resolved model, ✓/✗ + exit codes)", () => {
	const tasks = [
		{
			id: "t1",
			runId: "r1",
			role: "executor",
			agent: "executor",
			title: "x",
			status: "completed",
			dependsOn: [],
			cwd: "/tmp",
			modelRouting: { resolved: "zai/glm-5.3", fallbackChain: [] },
			modelAttempts: [
				{ model: "qwencoder/qwen3.7-max", success: false, exitCode: 1 },
				{ model: "zai/glm-5.3", success: true },
			],
		},
	] as unknown as TeamTaskState[];
	const lines = renderTranscriptPane(snapshotWith(tasks)).join("\n");
	assert.match(lines, /model attempts \(newest first\)/);
	assert.match(lines, /t1 \(executor\) · resolved zai\/glm-5\.3/);
	assert.match(lines, /qwencoder\/qwen3\.7-max ✗\(1\) → zai\/glm-5\.3 ✓/);
	// No attempts → section absent (regression shape).
	const bare = renderTranscriptPane(snapshotWith([])).join("\n");
	assert.ok(!bare.includes("model attempts"));
});
