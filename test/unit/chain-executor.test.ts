/**
 * Unit + integration tests for the live `chain` feature wiring.
 *
 * Covers:
 *  (a) chain string parses to N steps
 *  (b) mapRunToTaskResult maps a (mocked) team-run manifest → TaskResult
 *  (c) formatChainHistory formats __chainHistory + __chainHistoryNotes into the goal (Fix C coupling)
 *  (d) ChainTeamRunExecutor runs steps via an injected mock handleRun + real manifest fixtures
 *  (e) a failed step → outcome 'failure' → chain respects continueOnError
 *  (empirical) context passage: step 2's worker goal contains step 1's handoff summary block
 *
 * @see src/extension/team-tool/chain-executor.ts
 * @see src/extension/team-tool/chain-dispatch.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

// bug-023: the chain feature's writeRunFixture → loadRunManifestById roundtrip
// fails on Windows CI temp paths (O_NOFOLLOW + 8.3/junction canonicalization in
// resolveRealContainedPath, src/utils/safe-paths.ts). Pre-existing v0.9.13 bug,
// not a v0.9.14 regression; needs a Windows VM to verify a security-sensitive
// fix. See docs/bugs/bug-023-chain-windows-path-resolution.md.
const isWindows = process.platform === "win32";
const WIN32_SKIP = { skip: isWindows ? "bug-023: Windows path resolution — see docs/bugs/bug-023-chain-windows-path-resolution.md" : false } as const;

import { ChainRunner, parseChainString } from "../../src/runtime/chain-runner.ts";
import { HandoffManager, type TaskPacket } from "../../src/runtime/handoff-manager.ts";
import {
	ChainTeamRunExecutor,
	formatChainHistory,
	mapRunToTaskResult,
	readChainStepOutput,
	writeRunFixture,
	type HandleRunFn,
} from "../../src/extension/team-tool/chain-executor.ts";
import { handleChainRun } from "../../src/extension/team-tool/chain-dispatch.ts";
import { __test__clearManifestCache, loadRunManifestById } from "../../src/state/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";
import type { PiTeamsToolResult } from "../../src/extension/tool-result.ts";
import type { TeamContext } from "../../src/extension/team-tool/context.ts";

// ─── fixtures / helpers ──────────────────────────────────────────────────

function makeTempCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-exec-"));
	// git-init so useProjectState(cwd) → true (findRepoRoot finds .git). Without
	// this, scopeBaseRoot falls back to userCrewRoot() and writeRunFixture leaks
	// run records into the EXTENSION-GLOBAL state dir (~/.pi/agent/extensions/
	// pi-crew/state/runs/) — the one the crew UI reads — creating persistent
	// "zombie agent" rows after every test run. git-init keeps every fixture
	// inside <tmpdir>/.crew/, auto-cleaned by rmSync(dir) in each test.
	execSync("git init -q", { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
	return dir;
}

function makeTask(overrides: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id: "01_task",
		runId: "r",
		role: "executor",
		agent: "executor",
		title: "do thing",
		status: "completed",
		dependsOn: [],
		cwd: "/tmp",
		...overrides,
	};
}

function makeManifest(overrides: Partial<TeamRunManifest> = {}): TeamRunManifest {
	const now = new Date().toISOString();
	const start = new Date(Date.now() - 10_000).toISOString();
	return {
		schemaVersion: 1,
		runId: "r",
		team: "default",
		goal: "g",
		status: "completed",
		workspaceMode: "single",
		createdAt: start,
		updatedAt: now,
		cwd: "/tmp",
		stateRoot: "/tmp/.crew/state/runs/r",
		artifactsRoot: "/tmp/.crew/artifacts/r",
		tasksPath: "/tmp/.crew/state/runs/r/tasks.json",
		eventsPath: "/tmp/.crew/state/runs/r/events.jsonl",
		artifacts: [],
		...overrides,
	};
}

/** A mock handleRun that writes a fixture manifest and records received goals. */
function makeMockHandleRun(opts: {
	cwd: string;
	status?: TeamRunManifest["status"];
	failRunId?: boolean; // omit runId → executor maps to failure
	resultText?: string; // worker result text to write into each step's fixture
}) {
	const receivedGoals: string[] = [];
	const receivedParams: Array<Record<string, unknown>> = [];
	let counter = 0;
	const handleRun: HandleRunFn = async (params, _ctx) => {
		receivedGoals.push(params.goal ?? "");
		receivedParams.push(params as Record<string, unknown>);
		counter += 1;
		if (opts.failRunId) {
			// Return a result with no runId → executor maps to outcome failure.
			const res: PiTeamsToolResult = {
				content: [{ type: "text", text: "blocked: no runId" }],
				details: { action: "run", status: "error" },
				isError: true,
			};
			return res;
		}
		const runId = `chainstep-${counter}`;
		writeRunFixture(opts.cwd, runId, {
			status: opts.status ?? "completed",
			...(opts.resultText ? { resultText: opts.resultText } : {}),
		});
		const res: PiTeamsToolResult = {
			content: [{ type: "text", text: `run ${runId}` }],
			details: { action: "run", status: "ok", runId },
		};
		return res;
	};
	return { handleRun, receivedGoals, receivedParams };
}

// ─── (a) parseChainString → N steps ──────────────────────────────────────

test("(a) parseChainString parses inline-goal chain to 3 steps", () => {
	const spec = parseChainString('"Count to 3" -> "Add 2 to the previous number" -> "Write the result"');
	assert.equal(spec.steps.length, 3);
	assert.equal(spec.steps[0].inlineGoal, "Count to 3");
	assert.equal(spec.steps[1].inlineGoal, "Add 2 to the previous number");
	assert.equal(spec.steps[2].inlineGoal, "Write the result");
});

test("(a) parseChainString parses @team references", () => {
	const spec = parseChainString("@research -> @implement -> @review");
	assert.equal(spec.steps.length, 3);
	assert.equal(spec.steps[0].team, "research");
	assert.equal(spec.steps[1].team, "implement");
	assert.equal(spec.steps[2].team, "review");
});

// ─── (c) formatChainHistory — Fix C coupling ─────────────────────────────

test("(c) formatChainHistory returns empty string when no history", () => {
	assert.equal(formatChainHistory({}), "");
	assert.equal(formatChainHistory({ __chainHistory: [] }), "");
	assert.equal(formatChainHistory({ __chainHistory: undefined }), "");
});

test("(c) formatChainHistory emits '# Previous Steps in This Chain' header + entry fields", () => {
	const out = formatChainHistory({
		__chainHistory: [
			{
				step: "s1",
				outcome: "success",
				filesCreated: ["a.ts"],
				filesModified: ["b.ts"],
				decisions: [{ rationale: "chose X", outcome: "shipped" }],
				nextSteps: ["verify Y"],
			},
		],
	});
	assert.ok(out.startsWith("# Previous Steps in This Chain"), `got: ${out.slice(0, 60)}`);
	assert.match(out, /Step s1: success/);
	assert.match(out, /a\.ts/);
	assert.match(out, /b\.ts/);
	assert.match(out, /chose X → shipped/);
	assert.match(out, /verify Y/);
});

test("(c) formatChainHistory includes __chainHistoryNotes markers (Fix C)", () => {
	const out = formatChainHistory({
		__chainHistory: [{ step: "s1", outcome: "success" }],
		__chainHistoryNotes: ["[chain history limited to last 100 entries; 1 older entry omitted]"],
	});
	assert.match(out, /Previous Steps in This Chain/);
	assert.match(out, /limited to last 100 entries/, "Fix C marker must be visible in the formatted goal");
});

// ─── (b) mapRunToTaskResult ───────────────────────────────────────────────

test("(b) mapRunToTaskResult: completed manifest + token usage → success", () => {
	const manifest = makeManifest({ status: "completed" });
	const tasks = [
		makeTask({ status: "completed", usage: { input: 100, output: 50 } }),
		makeTask({ status: "completed", usage: { input: 200, output: 100 } }),
	];
	const res = mapRunToTaskResult(manifest, tasks);
	assert.equal(res.outcome, "success");
	assert.equal(res.usage?.totalTokens, 450);
	assert.ok((res.duration ?? 0) >= 0);
	assert.equal(res.error, undefined);
});

test("(b) mapRunToTaskResult: failed manifest → failure + error", () => {
	const manifest = makeManifest({ status: "failed", summary: "boom" });
	const res = mapRunToTaskResult(manifest, [makeTask({ status: "failed", error: "nope" })]);
	assert.equal(res.outcome, "failure");
	assert.match(res.error ?? "", /nope|boom/);
});

test("(b) mapRunToTaskResult: completed run with a failed task → partial", () => {
	const manifest = makeManifest({ status: "completed" });
	const tasks = [
		makeTask({ status: "completed" }),
		makeTask({ status: "failed", error: "one failed" }),
	];
	const res = mapRunToTaskResult(manifest, tasks);
	assert.equal(res.outcome, "partial");
});

test("(b) mapRunToTaskResult: running (non-terminal) manifest → partial", () => {
	const manifest = makeManifest({ status: "running" });
	const res = mapRunToTaskResult(manifest, [makeTask({ status: "running" })]);
	assert.equal(res.outcome, "partial");
});

// ─── (d)(empirical) ChainTeamRunExecutor end-to-end with mock handleRun ──

test("(d)(empirical) 3-step chain runs sequentially and captures 3 runIds", WIN32_SKIP, async () => {
	__test__clearManifestCache();
	const cwd = makeTempCwd();
	const mock = makeMockHandleRun({ cwd });
	const ctx: TeamContext = { cwd };
	const executor = new ChainTeamRunExecutor({ handleRun: mock.handleRun, ctx });
	const runner = new ChainRunner(executor, new HandoffManager());

	const spec = parseChainString('"Count to 3" -> "Add 2 to the previous number" -> "Write the result"');
	const chainResult = await runner.runChain(spec);

	assert.equal(chainResult.steps.length, 3);
	assert.equal(chainResult.success, true);
	assert.equal(executor.stepRunIds.length, 3, "each step should capture a runId");
	assert.equal(mock.receivedGoals.length, 3, "handleRun called once per step");

	// CRITICAL: step 2's worker goal must contain step 1's handoff summary block.
	const step2Goal = mock.receivedGoals[1];
	assert.match(step2Goal, /Previous Steps in This Chain/, "step 2 goal must carry step 1 context");
	assert.match(step2Goal, /Current Chain Step/, "step 2 goal must mark the current step");
	// Step 1 (no prior history) must NOT have the prefix.
	assert.doesNotMatch(mock.receivedGoals[0], /Previous Steps in This Chain/);
});

test("(empirical) @team reference step resolves to that team in handleRun params", WIN32_SKIP, async () => {
	__test__clearManifestCache();
	const cwd = makeTempCwd();
	const mock = makeMockHandleRun({ cwd });
	const ctx: TeamContext = { cwd };
	const executor = new ChainTeamRunExecutor({ handleRun: mock.handleRun, ctx });
	const runner = new ChainRunner(executor, new HandoffManager());

	const spec = parseChainString("@research -> @implement");
	await runner.runChain(spec);

	assert.equal(mock.receivedParams[0].team, "research", "first step should target the research team");
	assert.equal(mock.receivedParams[1].team, "implement", "second step should target the implement team");
});

test("(empirical) inline-goal step resolves to default team", async () => {
	__test__clearManifestCache();
	const cwd = makeTempCwd();
	const mock = makeMockHandleRun({ cwd });
	const ctx: TeamContext = { cwd };
	const executor = new ChainTeamRunExecutor({ handleRun: mock.handleRun, ctx });
	const runner = new ChainRunner(executor, new HandoffManager());

	const spec = parseChainString('"just a goal"');
	await runner.runChain(spec);

	assert.equal(mock.receivedParams[0].team, "default");
});

test("(empirical) override team/workflow forwarded from executor overrides", async () => {
	__test__clearManifestCache();
	const cwd = makeTempCwd();
	const mock = makeMockHandleRun({ cwd });
	const ctx: TeamContext = { cwd };
	const executor = new ChainTeamRunExecutor({
		handleRun: mock.handleRun,
		ctx,
		overrides: { team: "myteam", workflow: "research", model: "claude-x" },
	});
	const runner = new ChainRunner(executor, new HandoffManager());

	const spec = parseChainString('"do thing"'); // inline goal → no step team → falls to override
	await runner.runChain(spec);

	assert.equal(mock.receivedParams[0].team, "myteam");
	assert.equal(mock.receivedParams[0].workflow, "research");
	assert.equal(mock.receivedParams[0].model, "claude-x");
});

// ─── (e) failed step → outcome failure + continueOnError ──────────────────

test("(e) failed step (no runId) → failure; chain stops by default", async () => {
	__test__clearManifestCache();
	const cwd = makeTempCwd();
	const mock = makeMockHandleRun({ cwd, failRunId: true });
	const ctx: TeamContext = { cwd };
	const executor = new ChainTeamRunExecutor({ handleRun: mock.handleRun, ctx });
	const runner = new ChainRunner(executor, new HandoffManager());

	const spec = parseChainString('"step one" -> "step two" -> "step three"');
	const chainResult = await runner.runChain(spec);

	// Default (continueOnError falsy) → stops after first failure.
	assert.equal(chainResult.steps.length, 1, "chain should stop after the failed first step");
	assert.equal(chainResult.steps[0].outcome, "failure");
	assert.equal(chainResult.success, false);
	assert.equal(executor.stepRunIds.length, 0, "no runId captured for the failed step");
});

test("(e) continueOnError=true runs all steps despite failures", async () => {
	__test__clearManifestCache();
	const cwd = makeTempCwd();
	const mock = makeMockHandleRun({ cwd, failRunId: true });
	const ctx: TeamContext = { cwd };
	const executor = new ChainTeamRunExecutor({ handleRun: mock.handleRun, ctx });
	const runner = new ChainRunner(executor, new HandoffManager());

	const spec = parseChainString('"a" -> "b" -> "c"');
	spec.continueOnError = true;
	const chainResult = await runner.runChain(spec);

	assert.equal(chainResult.steps.length, 3, "continueOnError must run every step");
	assert.equal(chainResult.success, false);
	for (const s of chainResult.steps) assert.equal(s.outcome, "failure");
});

test("(e) a failed team-run manifest maps to outcome failure mid-chain", WIN32_SKIP, async () => {
	__test__clearManifestCache();
	const cwd = makeTempCwd();
	// Step 1 succeeds; step 2 writes a FAILED manifest; step 3 succeeds.
	let call = 0;
	const handleRun: HandleRunFn = async (params, _ctx) => {
		call += 1;
		const runId = `mixed-${call}`;
		const status = call === 2 ? "failed" : "completed";
		writeRunFixture(cwd, runId, { status, summary: call === 2 ? "mid fail" : undefined });
		void params;
		return {
			content: [{ type: "text", text: runId }],
			details: { action: "run", status: status === "failed" ? "error" : "ok", runId },
		};
	};
	const ctx: TeamContext = { cwd };
	const executor = new ChainTeamRunExecutor({ handleRun, ctx });
	const runner = new ChainRunner(executor, new HandoffManager());

	const spec = parseChainString('"one" -> "two" -> "three"');
	const chainResult = await runner.runChain(spec);

	// Without continueOnError, the chain stops after step 2's failure.
	assert.equal(chainResult.steps.length, 2);
	assert.equal(chainResult.steps[0].outcome, "success");
	assert.equal(chainResult.steps[1].outcome, "failure");
	assert.equal(chainResult.success, false);
});

// ─── dispatch: handleChainRun summary ─────────────────────────────────────

test("handleChainRun returns a structured summary with runIds in data", WIN32_SKIP, async () => {
	__test__clearManifestCache();
	const cwd = makeTempCwd();
	const mock = makeMockHandleRun({ cwd });
	const ctx: TeamContext = { cwd };

	const res = await handleChainRun(
		{ chain: '"Count to 3" -> "Write result"' },
		ctx,
		mock.handleRun,
	);

	assert.equal(res.isError, false);
	assert.equal(res.details.status, "ok");
	assert.equal(res.details.data?.chain, true);
	assert.equal(res.details.data?.steps, 2);
	assert.ok(Array.isArray(res.details.data?.runIds));
	assert.equal((res.details.data?.runIds as string[]).length, 2);
	// Summary text references both steps.
	const first = res.content?.[0];
	const text = first && "text" in first ? first.text : "";
	assert.match(text, /Step 1/);
	assert.match(text, /Step 2/);
});

test("handleChainRun errors on empty chain string", async () => {
	const cwd = makeTempCwd();
	const ctx: TeamContext = { cwd };
	const noopHandle: HandleRunFn = async () => ({ content: [], details: { action: "run", status: "ok" } });

	const res = await handleChainRun({ chain: "   " }, ctx, noopHandle);
	assert.equal(res.isError, true);
	assert.equal(res.details.status, "error");
});

// ─── output text propagation (semantic gap fix) ───────────────────────────

test("(b) readChainStepOutput reads completed task output from resultArtifact", WIN32_SKIP, () => {
	__test__clearManifestCache();
	const cwd = makeTempCwd();
	const manifest = writeRunFixture(cwd, "r-out", {
		status: "completed",
		resultText: "1, 2, 3",
	});
	const loaded = loadRunManifestById(cwd, "r-out");
	assert.ok(loaded, "fixture should load");
	const output = readChainStepOutput(loaded!.manifest, loaded!.tasks);
	assert.equal(output, "1, 2, 3");
	void manifest;
});

test("(b) readChainStepOutput returns undefined when no completed tasks have resultArtifacts", WIN32_SKIP, () => {
	__test__clearManifestCache();
	const cwd = makeTempCwd();
	writeRunFixture(cwd, "r-empty", { status: "completed" });
	const loaded = loadRunManifestById(cwd, "r-empty");
	assert.ok(loaded, "fixture should load");
	const output = readChainStepOutput(loaded!.manifest, loaded!.tasks);
	assert.equal(output, undefined);
});

test("(c) formatChainHistory renders entry.outputText in Output section", () => {
	const out = formatChainHistory({
		__chainHistory: [{
			step: "s1",
			outcome: "success",
			outputText: "1, 2, 3",
		}],
	});
	assert.match(out, /Output:/);
	assert.match(out, /1, 2, 3/);
});

test("(d)(semantic) step 1's worker output appears in step 2's goal", WIN32_SKIP, async () => {
	__test__clearManifestCache();
	const cwd = makeTempCwd();
	const mock = makeMockHandleRun({ cwd, resultText: "1, 2, 3" });
	const ctx: TeamContext = { cwd };
	const executor = new ChainTeamRunExecutor({ handleRun: mock.handleRun, ctx });
	const runner = new ChainRunner(executor, new HandoffManager());

	const spec = parseChainString('"Say the numbers 1, 2, 3" -> "What was the last number?"');
	const chainResult = await runner.runChain(spec);

	assert.equal(chainResult.steps.length, 2);
	assert.equal(chainResult.success, true);

	// CRITICAL semantic check: step 2's worker goal must contain step 1's output text.
	const step2Goal = mock.receivedGoals[1];
	assert.match(step2Goal, /Previous Steps in This Chain/);
	assert.match(step2Goal, /Output:/);
	assert.match(step2Goal, /1, 2, 3/, "step 2 must see step 1's output text");
});
