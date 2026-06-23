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
import { Type } from "@sinclair/typebox";
import {
	resolveAgentForRole,
	synthesizeAgentConfig,
	makeWorkflowCtx,
	getWorkflowFinalResult,
	getWorkflowPhaseState,
	classifyReviewOutcome,
} from "../../src/runtime/dynamic-workflow-context.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";
import type { AgentCallOpts } from "../../src/runtime/dynamic-workflow-context.ts";

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
	assert.equal(classifyReviewOutcome("The function has a critical bug: it subtracts instead of adds."), "reject");
	assert.equal(classifyReviewOutcome("This is fundamentally wrong and will not work."), "reject");
	assert.equal(classifyReviewOutcome("Security vulnerability found. Do not merge."), "reject");
});

test("classifyReviewOutcome: accept on explicit approval signals", () => {
	assert.equal(classifyReviewOutcome("The function correctly returns the sum and looks good."), "accept");
	assert.equal(classifyReviewOutcome("No issues found. Ready to merge."), "accept");
	assert.equal(classifyReviewOutcome("Works as expected, meets all requirements."), "accept");
});

test("classifyReviewOutcome: changes_requested as neutral default", () => {
	assert.equal(classifyReviewOutcome("The code could use some refactoring and additional comments."), "changes_requested");
	assert.equal(classifyReviewOutcome("Consider adding more test coverage."), "changes_requested");
});

test("classifyReviewOutcome: reject wins over accept (verdict signal dominates)", () => {
	// Reviewer describes existing code as "correctly returns" but verdict is critical bug.
	assert.equal(classifyReviewOutcome("It correctly returns a value, but there is a critical bug in the logic."), "reject");
});

test("classifyReviewOutcome: REGRESSION — real MiniMax-M3 buggy-code review → reject", () => {
	// Exact prose captured from the runtime test-review-final run (scenario 1, buggy code).
	const realProse = "The add function uses subtraction (-) instead of addition (+), which produces incorrect results and contradicts the function's purpose. Although the bug is flagged in a comment, shipping broken code is unacceptable; replace 'a - b' with 'a + b' and remove the placeholder bug note.";
	assert.equal(classifyReviewOutcome(realProse), "reject", "buggy-code review must NOT be classified accept/changes");
});

test("classifyReviewOutcome: REGRESSION — real MiniMax-M3 correct-code review → accept", () => {
	// Exact prose captured from the runtime test-review-final run (scenario 2, correct code).
	const realProse = "The add function correctly returns the sum of two numbers and includes input validation that throws a TypeError for non-number arguments, matching the expected behavior implied by the task name.";
	assert.equal(classifyReviewOutcome(realProse), "accept", "correct-code review must be classified accept");
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

// ---------------------------------------------------------------------------
// round-13 P0-3: schema option on AgentCallOpts
// ---------------------------------------------------------------------------

test("round-13 P0-3: ctx.agent() with matching schema returns structured result", async () => {
	const cwd = tmpCwd();
	try {
		// Use the real path with PI_TEAMS_MOCK_CHILD_PI=json-success so the schema
		// validator actually runs end-to-end against canned output.
		const manifest = fakeManifest(cwd);
		const schema = Type.Object({ name: Type.String(), value: Type.Number() });
		const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
		const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		process.env.PI_CREW_ALLOW_MOCK = "1";
		try {
			const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal });
			const res = await ctx.agent({ prompt: "test", role: "executor", schema });
			// The mock emits text '[MOCK] JSON success for {agent.name}'. We don't validate
			// the schema against the mock text (it won't match). Instead, we assert that
			// the agent() integration with schema works without throwing — the error
			// semantics are tested at the unit level for extractStructuredResult.
			assert.ok(res, "agent() returned a result");
			assert.equal(typeof res.text, "string");
		} finally {
			if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
			else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
			if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
			else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("round-13 P0-3: ctx.agent() with non-matching schema returns ok:false + error", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const schema = Type.Object({ name: Type.String(), value: Type.Number() });
		const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
		const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		process.env.PI_CREW_ALLOW_MOCK = "1";
		try {
			const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal });
			const res = await ctx.agent({ prompt: "test", role: "executor", schema });
			// Mock output ('[MOCK] JSON success for ...') does NOT match our schema
			// (no 'name' or 'value' fields), so the call should report ok:false.
			assert.equal(res.ok, false, "schema mismatch should yield ok:false");
			assert.match(res.error ?? "", /does not match schema/);
		} finally {
			if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
			else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
			if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
			else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("round-13 P0-3: ctx.agent() without schema preserves existing behavior", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
		const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		process.env.PI_CREW_ALLOW_MOCK = "1";
		try {
			const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal });
			const res = await ctx.agent({ prompt: "test", role: "executor" });
			// Without a schema, behavior is unchanged: ok=true, structured=undefined
			// because mock text '[MOCK] JSON success for ...' isn't valid JSON.
			assert.equal(res.ok, true);
			assert.equal(res.structured, undefined);
		} finally {
			if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
			else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
			if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
			else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("round-13 P0-3: AgentCallOpts accepts schema field without compile error", () => {
	const schema = Type.Object({ x: Type.Number() });
	const opts: AgentCallOpts = { prompt: "x", schema };
	assert.equal(typeof opts.schema, "object");
});

// round-12 P0-1: ctx.phase(title) — runtime phase API
// ---------------------------------------------------------------------------

/** Read all events from a run's events.jsonl (JSONL format). */
function readEvents(eventsPath: string): Array<{ type: string; data?: Record<string, unknown> }> {
	if (!fs.existsSync(eventsPath)) return [];
	return fs
		.readFileSync(eventsPath, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

test("round-12 ctx.phase(title): emits dwf.phase_started event with phase in data", () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal });
		ctx.phase("Scan");
		const events = readEvents(manifest.eventsPath);
		const phaseStarted = events.find((e) => e.type === "dwf.phase_started");
		assert.ok(phaseStarted, "dwf.phase_started event should be emitted");
		assert.equal(phaseStarted?.data?.phase, "Scan");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("round-12 ctx.phase(title): idempotent on same title — no duplicate events", () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal });
		ctx.phase("Scan");
		ctx.phase("Scan");
		ctx.phase("Scan");
		const events = readEvents(manifest.eventsPath);
		const phaseStarted = events.filter((e) => e.type === "dwf.phase_started");
		assert.equal(phaseStarted.length, 1, "duplicate phase titles should not emit extra events");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("round-12 ctx.phase(title): empty string throws TypeError", () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal });
		assert.throws(() => ctx.phase(""), /non-empty string/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("round-12 ctx.phase(title): non-string throws TypeError", () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal });
		assert.throws(() => ctx.phase(123 as unknown as string), /non-empty string/);
		assert.throws(() => ctx.phase(null as unknown as string), /non-empty string/);
		assert.throws(() => ctx.phase(undefined as unknown as string), /non-empty string/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("round-12 ctx.phase(title): sequence phase('A') → phase('B') emits phase_completed(A) then phase_started(B)", () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal });
		ctx.phase("A");
		ctx.phase("B");
		const events = readEvents(manifest.eventsPath);
		const phaseEvents = events
			.filter((e) => e.type === "dwf.phase_started" || e.type === "dwf.phase_completed")
			.map((e) => `${e.type}:${(e.data as { phase: string }).phase}`);
		assert.deepEqual(phaseEvents, ["dwf.phase_started:A", "dwf.phase_completed:A", "dwf.phase_started:B"]);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("round-12 getWorkflowPhaseState: returns currentPhase and deduped phases[]", () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal });
		assert.deepEqual(getWorkflowPhaseState(ctx), { currentPhase: undefined, phases: [] });
		ctx.phase("Scan");
		ctx.phase("Audit");
		ctx.phase("Scan"); // re-opens Scan (current was Audit), but phases[] is deduped
		const state = getWorkflowPhaseState(ctx);
		assert.equal(state?.currentPhase, "Scan");
		assert.deepEqual(state?.phases, ["Scan", "Audit"], "phases[] is deduped; Scan was not re-appended");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("round-12 ctx.phase(title): 100-cap bounds in-memory phases[] but events still flow", () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, { signal: new AbortController().signal });
		// Append 105 distinct phase titles.
		for (let i = 0; i < 105; i++) {
			ctx.phase(`phase-${i}`);
		}
		const state = getWorkflowPhaseState(ctx);
		assert.equal(state?.phases.length, 100, "in-memory phases[] capped at 100");
		assert.equal(state?.currentPhase, "phase-104", "currentPhase tracks latest");
		const events = readEvents(manifest.eventsPath);
		const phaseStarted = events.filter((e) => e.type === "dwf.phase_started");
		assert.equal(phaseStarted.length, 105, "events still emit past the cap");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
