/**
 * Fix C — honest markers for chain-history bounding (was the only silent-loss path).
 *
 * `ChainRunner.enrichContextFromHandoffs` bounds memory by dropping: (a) handoffs
 * older than the last 100, (b) any single handoff whose JSON exceeds 5000 bytes,
 * (c) array fields past their caps (50 files, 20 decisions/nextSteps). Previously
 * all of these vanished with NO marker. Now a `__chainHistoryNotes` sibling field
 * records what was elided so a reader knows context is incomplete.
 *
 * The upstream result artifacts stay intact on disk; this only makes the injected
 * `__chainHistory` context honest.
 *
 * @see src/runtime/chain-runner.ts enrichContextFromHandoffs
 * @see research-findings/output-handling-deep-dive.md §F
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type ChainRunner, type ChainTaskRunner, createChainRunner } from "../../../src/runtime/chain-runner.ts";
import { HandoffManager, type HandoffSummary } from "../../../src/runtime/handoff-manager.ts";

/** Build a HandoffSummary with sensible defaults + overrides. */
function makeHandoff(overrides: Partial<HandoffSummary> = {}): HandoffSummary {
	return {
		taskId: "step-1",
		runId: "r",
		timestamp: 0,
		task: "do something",
		outcome: "success",
		filesCreated: [],
		filesModified: [],
		filesDeleted: [],
		decisions: [],
		blockers: [],
		nextSteps: [],
		metrics: { tokensUsed: 0, duration: 0, iterations: 1, toolsUsed: [] },
		contextSnapshot: "",
		...overrides,
	};
}

function makeRunner(): ChainRunner {
	const noopRunner: ChainTaskRunner = {
		runTask: async () => ({ outcome: "success" }) as never,
	};
	return createChainRunner(noopRunner, new HandoffManager());
}

/** Direct access to the private enricher (cast). enrichContextFromHandoffs only
 *  reads `.handoff` off each ChainStepResult, so a minimal cast is sufficient. */
function enrich(runner: ChainRunner, handoffs: HandoffSummary[]): Record<string, unknown> {
	const previousResults = handoffs.map((h) => ({ handoff: h })) as never[];
	return (
		runner as unknown as {
			enrichContextFromHandoffs: (ctx: Record<string, unknown>, prev: never[]) => Record<string, unknown>;
		}
	).enrichContextFromHandoffs({}, previousResults);
}

test("no handoffs → context unchanged, no notes", () => {
	const runner = makeRunner();
	const out = enrich(runner, []);
	assert.ok(!("__chainHistory" in out));
	assert.ok(!("__chainHistoryNotes" in out));
});

test("single small handoff → history present, NO notes (nothing dropped)", () => {
	const runner = makeRunner();
	const out = enrich(runner, [makeHandoff({ taskId: "s1" })]);
	assert.ok(Array.isArray(out.__chainHistory));
	assert.equal((out.__chainHistory as unknown[]).length, 1);
	assert.ok(!("__chainHistoryNotes" in out), "no marker when nothing was elided");
});

test("oversized handoff (>5000 bytes) is dropped AND a marker is emitted", () => {
	const runner = makeRunner();
	// One normal handoff + one whose JSON clearly exceeds 5000 bytes.
	const oversized = makeHandoff({ taskId: "big", task: "B".repeat(6000) });
	const normal = makeHandoff({ taskId: "small" });
	const out = enrich(runner, [oversized, normal]);
	const history = out.__chainHistory as Array<{ step: string }>;
	assert.equal(history.length, 1, "the oversized handoff must be dropped from the history");
	assert.equal(history[0]!.step, "small", "only the normal handoff survives");
	const notes = out.__chainHistoryNotes as string[] | undefined;
	assert.ok(notes, "a __chainHistoryNotes marker must be present");
	assert.ok(
		notes!.some((n) => /omitted \(> 5000 bytes/.test(n)),
		`notes must mention the oversized drop: ${notes}`,
	);
});

test("handoff with >50 filesCreated keeps 50 in history AND records the full count", () => {
	const runner = makeRunner();
	const manyFiles = Array.from({ length: 60 }, (_, i) => `f${i}.ts`); // 60 short entries → total <5000 bytes
	const out = enrich(runner, [makeHandoff({ taskId: "s1", filesCreated: manyFiles })]);
	const history = out.__chainHistory as Array<{ filesCreated: string[] }>;
	assert.equal(history[0]!.filesCreated.length, 50, "filesCreated must be capped at 50 in history");
	const notes = out.__chainHistoryNotes as string[] | undefined;
	assert.ok(
		notes?.some((n) => /filesCreated=60/.test(n)),
		`notes must record the full filesCreated count: ${notes}`,
	);
});

test("more than 100 handoffs keeps last 100 AND emits the history-limit marker", () => {
	const runner = makeRunner();
	const handoffs = Array.from({ length: 101 }, (_, i) => makeHandoff({ taskId: `s${i}` }));
	const out = enrich(runner, handoffs);
	const history = out.__chainHistory as Array<{ step: string }>;
	assert.equal(history.length, 100, "history must be limited to the last 100 entries");
	assert.equal(history[0]!.step, "s1", "must keep the LAST 100 (s1..s100), dropping s0");
	const notes = out.__chainHistoryNotes as string[] | undefined;
	assert.ok(
		notes?.some((n) => /limited to last 100/.test(n)),
		`notes must mention the history limit: ${notes}`,
	);
});

test("decisions/nextSteps array caps are recorded in notes", () => {
	const runner = makeRunner();
	const manyDecisions = Array.from({ length: 25 }, (_, i) => ({
		rationale: `d${i}`,
	}));
	const out = enrich(runner, [makeHandoff({ taskId: "s1", decisions: manyDecisions as never[] })]);
	const history = out.__chainHistory as Array<{ decisions: unknown[] }>;
	assert.equal(history[0]!.decisions.length, 20, "decisions capped at 20");
	const notes = out.__chainHistoryNotes as string[] | undefined;
	assert.ok(
		notes?.some((n) => /decisions=25/.test(n)),
		`notes must record the full decisions count: ${notes}`,
	);
});
