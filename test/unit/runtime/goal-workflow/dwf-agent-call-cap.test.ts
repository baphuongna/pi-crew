/**
 * SDD-3 W-C WI-3 (G13): DWF maxAgentCalls cap — red-first tests.
 *
 * Verified gap (upgrade plan 2026-09-29 §1 W-C + §2 G13): for a run WITHOUT
 * tokenBudget, the ONLY bounds on a .dwf.ts script were the 30-min script
 * timeout (dynamic-workflow-runner.ts PI_CREW_DWF_SCRIPT_TIMEOUT_MS) and the
 * semaphore (concurrency 4). A runaway script could dispatch unbounded agent
 * calls — each a real spawned worker — and the eventual kill was a blind
 * timeout, not a structured termination reason.
 *
 * WI-3 adds a maxAgentCalls cap:
 *  - the DEFAULT_MAX_AGENT_CALLS default applies to EVERY run (omitting all
 *    config still leaves the run bounded);
 *  - override via MakeWorkflowCtxOptions.maxAgentCalls /
 *    RunDynamicWorkflowInput.maxAgentCalls / workflow.maxAgentCalls
 *    (team-tool schema exposes it as an optional goal param);
 *  - when tripped: ctx.agent() throws DwfAgentCallCapError (structured reason),
 *    the ctx signal is aborted (kills in-flight children; pipeline() rethrows
 *    instead of swallowing), a dwf.log event records the trip, and the runner
 *    fails the run with the structured message (dwf.failed) rather than
 *    waiting out the blind 30-min timeout.
 *
 * Red-first: this file was written BEFORE the fix and failed on HEAD dc71198c
 * (the maxAgentCalls option was ignored, DwfAgentCallCapError /
 * DEFAULT_MAX_AGENT_CALLS / getWorkflowLimits did not exist, and a runaway
 * script ran to completion instead of terminating).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as dwfCtx from "../../../../src/runtime/goal-workflow/dynamic-workflow-context.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

// Red-first-safe accessors: on the unfixed HEAD these bindings are undefined,
// so tests assert their existence FIRST (clean failure) instead of crashing on
// `instanceof undefined`.
const { makeWorkflowCtx } = dwfCtx;
const DwfAgentCallCapError = (dwfCtx as { DwfAgentCallCapError?: new (limit: number, used: number) => Error }).DwfAgentCallCapError;
const DEFAULT_MAX_AGENT_CALLS = (dwfCtx as { DEFAULT_MAX_AGENT_CALLS?: number }).DEFAULT_MAX_AGENT_CALLS;
const getWorkflowLimits = (dwfCtx as { getWorkflowLimits?: (ctx: unknown) => { maxAgentCalls: number } | undefined }).getWorkflowLimits;

function tmpCwd(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeManifest(cwd: string): TeamRunManifest {
	const now = new Date().toISOString();
	return {
		schemaVersion: 1,
		runId: "team_dwf_cap_test",
		team: "dwf-cap-test",
		goal: "test cap",
		status: "running",
		workspaceMode: "single",
		createdAt: now,
		updatedAt: now,
		cwd,
		stateRoot: `${cwd}/.crew/state/runs/team_dwf_cap_test`,
		artifactsRoot: `${cwd}/.crew/artifacts/team_dwf_cap_test`,
		tasksPath: `${cwd}/.crew/state/runs/team_dwf_cap_test/tasks.json`,
		eventsPath: `${cwd}/.crew/state/runs/team_dwf_cap_test/events.jsonl`,
		artifacts: [],
	};
}

/** Mock child-pi env (in-process fixtures — no real pi spawn). */
function withMockEnv<T>(fn: () => Promise<T> | T): Promise<T> | T {
	const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	return Promise.resolve(fn()).finally(() => {
		if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
		if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
	});
}

test("G13 WI-3 preconditions: DwfAgentCallCapError + DEFAULT_MAX_AGENT_CALLS + getWorkflowLimits exist", () => {
	assert.ok(typeof DwfAgentCallCapError === "function", "DwfAgentCallCapError must be exported (missing on unfixed HEAD)");
	assert.ok(
		typeof DEFAULT_MAX_AGENT_CALLS === "number" && Number.isFinite(DEFAULT_MAX_AGENT_CALLS) && DEFAULT_MAX_AGENT_CALLS >= 1,
		`DEFAULT_MAX_AGENT_CALLS must be a finite number ≥ 1 (got ${String(DEFAULT_MAX_AGENT_CALLS)} on unfixed HEAD)`,
	);
	assert.ok(typeof getWorkflowLimits === "function", "getWorkflowLimits must be exported (missing on unfixed HEAD)");
});

test("G13 cap: default applies when maxAgentCalls unset — a no-budget run is still bounded", () => {
	const cwd = tmpCwd("pi-crew-dwf-cap-default-");
	try {
		const manifest = fakeManifest(cwd);
		assert.ok(DEFAULT_MAX_AGENT_CALLS !== undefined, "guarded by precondition test");
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
		});
		const limits = getWorkflowLimits?.(ctx);
		assert.ok(limits, "getWorkflowLimits must return the effective limits");
		assert.equal(limits?.maxAgentCalls, DEFAULT_MAX_AGENT_CALLS, "unset option falls back to the default cap");
		const ctxOverride = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			maxAgentCalls: 5,
		});
		assert.equal(getWorkflowLimits?.(ctxOverride)?.maxAgentCalls, 5, "explicit override wins over the default");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("G13 cap: ctx.agent() beyond maxAgentCalls throws DwfAgentCallCapError and aborts the ctx signal", async () => {
	const cwd = tmpCwd("pi-crew-dwf-cap-ctx-");
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
			maxAgentCalls: 2,
		});
		await withMockEnv(async () => {
			const r1 = await ctx.agent({ role: "executor", prompt: "call one", maxTurns: 1 });
			assert.equal(r1.ok, true, `first call within cap must succeed (error=${r1.error ?? "none"})`);
			const r2 = await ctx.agent({ role: "executor", prompt: "call two", maxTurns: 1 });
			assert.equal(r2.ok, true, `second call within cap must succeed (error=${r2.error ?? "none"})`);
			// Third call: completed agentCount (2) >= cap (2) → structured termination.
			await assert.rejects(ctx.agent({ role: "executor", prompt: "call three beyond the cap", maxTurns: 1 }), (error: unknown) => {
				assert.ok(DwfAgentCallCapError !== undefined, "guarded by precondition test");
				assert.ok(
					error instanceof DwfAgentCallCapError,
					`expected DwfAgentCallCapError, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
				);
				assert.match((error as Error).message, /agent-call cap reached/);
				return true;
			});
			assert.equal(ctx.signal.aborted, true, "cap trip must abort the ctx signal (kills in-flight children)");
			// The trip must be recorded in the durable events log (dwf.log is the
			// registered type for workflow-level log lines).
			const events = fs.existsSync(manifest.eventsPath) ? fs.readFileSync(manifest.eventsPath, "utf-8") : "";
			assert.match(events, /agent-call cap reached/, "cap trip must be observable in events.jsonl");
		});
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("G13 cap: cached replays count toward the cap (a resume/spin loop cannot bypass it)", async () => {
	const cwd = tmpCwd("pi-crew-dwf-cap-cache-");
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
			maxAgentCalls: 2,
		});
		await withMockEnv(async () => {
			const r1 = await ctx.agent({ role: "executor", prompt: "same prompt", maxTurns: 1 });
			assert.equal(r1.ok, true);
			// Same prompt → PERS-1 cache hit (no spawn) but STILL counts toward the cap.
			const r2 = await ctx.agent({ role: "executor", prompt: "same prompt", maxTurns: 1 });
			assert.equal(r2.ok, true);
			assert.equal(r2.durationMs, 0, "second identical call must be served from the PERS-1 cache");
			await assert.rejects(ctx.agent({ role: "executor", prompt: "distinct prompt after cap", maxTurns: 1 }), (error: unknown) => {
				assert.match((error as Error).message, /agent-call cap reached/);
				return true;
			});
		});
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Runner-level: the runaway script itself must TERMINATE with the structured
// reason (dwf.failed), not run to completion and not hang until the 30-min
// script timeout.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const nodeRequire = createRequire(import.meta.url);
const thisFile = fileURLToPath(import.meta.url);

// These tests execute PROJECT-sourced .dwf.ts scripts (F-01 trust gate) — set
// the opt-in explicitly (same pattern as test/unit/dwf-setresult.test.ts).
const prevTrust = process.env.PI_CREW_TRUST_PROJECT_DWF;
process.env.PI_CREW_TRUST_PROJECT_DWF = "1";
test.after(() => {
	if (prevTrust === undefined) delete process.env.PI_CREW_TRUST_PROJECT_DWF;
	else process.env.PI_CREW_TRUST_PROJECT_DWF = prevTrust;
});

test("G13 runner: runaway no-budget script terminates with the structured cap reason", async () => {
	const jitiMod = nodeRequire(path.join(repoRoot, "node_modules/jiti/lib/jiti.cjs"));
	const createJiti = jitiMod.default ?? jitiMod;
	const jiti = createJiti(thisFile);
	const dwfMod = (await jiti.import(path.join(repoRoot, "src/runtime/goal-workflow/dynamic-workflow-runner.ts"))) as Record<
		string,
		unknown
	>;
	const runDynamicWorkflow = dwfMod.runDynamicWorkflow as (input: Record<string, unknown>) => Promise<unknown>;
	assert.equal(typeof runDynamicWorkflow, "function");

	const cwd = tmpCwd("pi-crew-dwf-cap-runner-");
	fs.mkdirSync(path.join(cwd, ".crew", "workflows"), { recursive: true });
	const stateRoot = path.join(cwd, "state");
	fs.mkdirSync(stateRoot, { recursive: true });
	const eventsPath = path.join(stateRoot, "events.jsonl");
	fs.writeFileSync(eventsPath, "");
	const artifactPath = path.join(cwd, "never-reached.txt");
	const dwfPath = path.join(cwd, ".crew", "workflows", "cap-loop.dwf.ts");
	fs.writeFileSync(
		dwfPath,
		`export default async function run(ctx) {
  let i = 0;
  while (i < 50) {
    const res = await ctx.agent({ role: "executor", prompt: "iteration " + i });
    i = i + 1;
    if (!res.ok) break;
  }
  ctx.setResult(${JSON.stringify(artifactPath)});
}
`,
	);
	const manifest = {
		schemaVersion: 1,
		runId: "team_dwf_cap_runner",
		team: "cap-test-team",
		workflow: "cap-loop",
		goal: "test cap termination",
		status: "running" as const,
		workspaceMode: "single" as const,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd,
		stateRoot,
		artifactsRoot: path.join(cwd, "artifacts"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath,
		artifacts: [],
	};
	const workflow = {
		name: "cap-loop",
		description: "test",
		source: "project" as const,
		filePath: dwfPath,
		steps: [],
		runtime: "dynamic" as const,
		dynamicScript: dwfPath,
	};
	const team = {
		name: "cap-test-team",
		description: "test",
		source: "dynamic" as const,
		filePath: "<test>",
		roles: [{ name: "worker", agent: "executor" }],
		workspaceMode: "single" as const,
	};

	try {
		await withMockEnv(async () => {
			await assert.rejects(
				runDynamicWorkflow({
					manifest,
					workflow,
					team,
					signal: AbortSignal.timeout(30_000),
					// G13: small cap so the loop (50 iterations) trips it at call 4.
					maxAgentCalls: 3,
				}),
				(error: unknown) => {
					assert.match(
						error instanceof Error ? error.message : String(error),
						/agent-call cap reached/,
						"runDynamicWorkflow must reject with the structured cap reason",
					);
					return true;
				},
			);
		});
		const events = fs.readFileSync(eventsPath, "utf-8");
		assert.match(events, /dwf\.failed/, "runner must record the termination as dwf.failed");
		assert.match(events, /agent-call cap reached/, "dwf.failed must carry the structured cap reason");
		assert.equal(fs.existsSync(artifactPath), false, "script must NOT reach ctx.setResult after the cap trip");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
