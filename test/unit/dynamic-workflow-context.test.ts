/**
 * Unit tests for dynamic-workflow-context.ts (P2).
 *
 * Tests resolveAgentForRole (G4 4-tier precedence), synthesizeAgentConfig (C7),
 * makeWorkflowCtx surface (capability lock + setResult + semaphore).
 * The agent() path is exercised via PI_TEAMS_MOCK_CHILD_PI (no real pi spawn).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	resolveAgentForRole,
	synthesizeAgentConfig,
	makeWorkflowCtx,
	getWorkflowFinalResult,
} from "../../src/runtime/dynamic-workflow-context.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";

function tmpCwd(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dwf-ctx-"));
}

function fakeManifest(cwd: string): TeamRunManifest {
	const now = new Date().toISOString();
	return {
		schemaVersion: 1,
		runId: "team_dwf_test_abc",
		team: "dwf-test",
		goal: "test goal",
		status: "running",
		workspaceMode: "single",
		createdAt: now,
		updatedAt: now,
		cwd,
		stateRoot: `${cwd}/.crew/state/runs/team_dwf_test_abc`,
		artifactsRoot: `${cwd}/.crew/artifacts/team_dwf_test_abc`,
		tasksPath: `${cwd}/.crew/state/runs/team_dwf_test_abc/tasks.json`,
		eventsPath: `${cwd}/.crew/state/runs/team_dwf_test_abc/events.jsonl`,
		artifacts: [],
	};
}

test("synthesizeAgentConfig uses source:'dynamic' (§0c C7 — not 'synthetic')", () => {
	const cfg = synthesizeAgentConfig("myrole");
	assert.equal(cfg.name, "myrole");
	assert.equal(cfg.source, "dynamic");
	assert.match(cfg.systemPrompt, /You are myrole/);
	assert.equal(cfg.inheritProjectContext, false);
});

test("resolveAgentForRole tier-4 fallback synthesizes when no agent matches", () => {
	const cwd = tmpCwd();
	try {
		const cfg = resolveAgentForRole("nonexistent-role-xyz", { cwd });
		assert.equal(cfg.name, "nonexistent-role-xyz");
		assert.equal(cfg.source, "dynamic", "tier-4 synthesis uses source:'dynamic'");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("resolveAgentForRole tier-1 explicit agent wins over role name", () => {
	const cwd = tmpCwd();
	try {
		// No real agents in tmp cwd → tier-1 miss falls through to tier-4 synthesis,
		// but with the explicit name preserved.
		const cfg = resolveAgentForRole("some-role", { explicitAgent: "my-explicit", cwd });
		assert.equal(cfg.name, "my-explicit", "explicit agent name preserved in fallback");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("makeWorkflowCtx exposes ONLY documented methods (capability lock)", () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal });
		// Public surface.
		assert.equal(typeof ctx.agent, "function");
		assert.equal(typeof ctx.fanOut, "function");
		assert.equal(typeof ctx.setResult, "function");
		assert.ok(ctx.semaphore);
		assert.equal(ctx.cwd, cwd);
		assert.equal(ctx.runId, "team_dwf_test_abc");
		// No raw manifest/process/require leaks on the ctx object.
		assert.equal((ctx as unknown as { manifest?: unknown }).manifest, undefined);
		assert.equal((ctx as unknown as { process?: unknown }).process, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("ctx.setResult records the final result; runner reads it via getWorkflowFinalResult", () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal });
		assert.equal(getWorkflowFinalResult(ctx), undefined, "no final result until setResult is called");
		ctx.setResult("/tmp/fake-artifact.md", { ok: true });
		const final = getWorkflowFinalResult(ctx);
		assert.deepEqual(final, { artifactPath: "/tmp/fake-artifact.md", meta: { ok: true } });
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("ctx.agent() returns ok:false on spawn failure (mock without PI_CREW_ALLOW_MOCK)", async () => {
	const cwd = tmpCwd();
	try {
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		// PI_CREW_ALLOW_MOCK intentionally NOT set → mock returns exit 1.
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal, concurrency: 1 });
		const res = await ctx.agent({ role: "executor", prompt: "say hi", maxTurns: 1 });
		assert.equal(res.ok, false, "without PI_CREW_ALLOW_MOCK, mock child-pi fails");
		assert.ok(res.error);
	} finally {
		delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// --- review() round-11 fix tests (disableTools, systemPrompt, 2-step fallback) ---
// These mock ctx.agent to verify review()'s verdict logic without spawning real pi.

test("classifyReviewOutcome: reject on critical-bug signals", () => {
	const { classifyReviewOutcome } = require("../../src/runtime/dynamic-workflow-context.ts") as typeof import("../../src/runtime/dynamic-workflow-context.ts");
	assert.equal(classifyReviewOutcome("The function has a critical bug: it subtracts instead of adds."), "reject");
	assert.equal(classifyReviewOutcome("This is fundamentally wrong and will not work."), "reject");
	assert.equal(classifyReviewOutcome("Security vulnerability found. Do not merge."), "reject");
});

test("classifyReviewOutcome: accept on explicit approval signals", () => {
	const { classifyReviewOutcome } = require("../../src/runtime/dynamic-workflow-context.ts") as typeof import("../../src/runtime/dynamic-workflow-context.ts");
	assert.equal(classifyReviewOutcome("The function correctly returns the sum and looks good."), "accept");
	assert.equal(classifyReviewOutcome("No issues found. Ready to merge."), "accept");
	assert.equal(classifyReviewOutcome("Works as expected, meets all requirements."), "accept");
});

test("classifyReviewOutcome: changes_requested as neutral default", () => {
	const { classifyReviewOutcome } = require("../../src/runtime/dynamic-workflow-context.ts") as typeof import("../../src/runtime/dynamic-workflow-context.ts");
	assert.equal(classifyReviewOutcome("The code could use some refactoring and additional comments."), "changes_requested");
	assert.equal(classifyReviewOutcome("Consider adding more test coverage."), "changes_requested");
});

test("classifyReviewOutcome: reject wins over accept (verdict signal dominates)", () => {
	const { classifyReviewOutcome } = require("../../src/runtime/dynamic-workflow-context.ts") as typeof import("../../src/runtime/dynamic-workflow-context.ts");
	// Reviewer describes existing code as "correctly returns" but verdict is critical bug.
	assert.equal(classifyReviewOutcome("It correctly returns a value, but there is a critical bug in the logic."), "reject");
});

test("review(): returns verdict directly when reviewer emits JSON (1-step)", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal, concurrency: 1 });
		const calls: { disableTools?: boolean; systemPrompt?: string }[] = [];
		ctx.agent = (async (call: { disableTools?: boolean; systemPrompt?: string; prompt: string }) => {
			calls.push({ disableTools: call.disableTools, systemPrompt: call.systemPrompt });
			return { ok: true, text: '{"outcome":"accept","feedback":"looks good"}', structured: { outcome: "accept", feedback: "looks good" } };
		}) as typeof ctx.agent;
		const r = await ctx.review("task-1", "reviewer", { content: "work here" });
		assert.equal(r.outcome, "accept");
		assert.equal(r.feedback, "looks good");
		assert.equal(calls.length, 1, "1-step: no judge fallback when reviewer emits JSON");
		assert.equal(calls[0].disableTools, true, "review defaults disableTools=true");
		assert.ok(calls[0].systemPrompt, "review passes a JSON-verdict systemPrompt");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("review(): 2-step fallback converts prose review → JSON verdict when model ignores JSON", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal, concurrency: 1 });
		let callNo = 0;
		ctx.agent = (async (call: { prompt: string }) => {
			callNo += 1;
			if (callNo === 1) {
				// Reviewer ignores JSON instruction, returns prose (real MiniMax-M3 behavior).
				return { ok: true, text: "The add function subtracts instead of adds. Critical bug.", structured: undefined };
			}
			// Call 2 = judge fallback: converts prose → JSON verdict.
			assert.match(call.prompt, /Convert the following code review/, "2nd call is the judge fallback");
			return { ok: true, text: '{"outcome":"reject","feedback":"subtracts instead of adds"}', structured: { outcome: "reject", feedback: "subtracts instead of adds" } };
		}) as typeof ctx.agent;
		const r = await ctx.review("task-add", "reviewer", { content: "function add(a,b){return a-b;}" });
		assert.equal(callNo, 2, "2-step fallback ran exactly one extra judge call");
		assert.equal(r.outcome, "reject", "judge verdict propagated");
		assert.equal(r.feedback, "subtracts instead of adds");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("review(): when reviewer produces NO text (killed), skips judge + returns fallback", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal, concurrency: 1 });
		let callNo = 0;
		ctx.agent = (async () => {
			callNo += 1;
			// Reviewer killed (exit 143) → empty text, like the unfixed bug.
			return { ok: false, text: "", error: "exit 143" };
		}) as typeof ctx.agent;
		const r = await ctx.review("task-empty");
		assert.equal(callNo, 1, "judge fallback SKIPPED when reviewer text is empty");
		assert.equal(r.outcome, "changes_requested");
		assert.equal(r.feedback, "(reviewer produced no parseable verdict)");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("review(): content option is injected into the reviewer prompt", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal, concurrency: 1 });
		let capturedPrompt = "";
		ctx.agent = (async (call: { prompt: string }) => {
			capturedPrompt = call.prompt;
			return { ok: true, text: '{"outcome":"accept","feedback":"ok"}', structured: { outcome: "accept", feedback: "ok" } };
		}) as typeof ctx.agent;
		await ctx.review("task-x", "reviewer", { content: "UNIQUE_WORK_MARKER_42" });
		assert.match(capturedPrompt, /UNIQUE_WORK_MARKER_42/, "content is passed to the reviewer");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
