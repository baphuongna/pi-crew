/**
 * Handoff budget: est-token (chars/4) cap on the dynamic.dependencyContext
 * layer. `renderDependencyOutputContext(context, { budgetTokens })` trims
 * dependencies IN DECLARATION ORDER when the rendered body exceeds the
 * budget — earlier deps keep full output, later ones are downgraded to
 * taskId/role/status + a ≤240-char summary head + an artifact pointer
 * (`artifacts/<runId>/results/<taskId>.txt`). Resolution precedence:
 * env PI_CREW_HANDOFF_BUDGET_TOKENS > opts.budgetTokens (runtime config) >
 * default 1800. A resolved budget ≤0 or >1_000_000 is the OFF-switch
 * (untrimmed render).
 *
 * Env hygiene: the worker harness exports PI_CREW_* vars into this shell
 * (known gotcha) — the budget var is scrubbed/restored around every test so
 * default-value and precedence assertions are honest.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	applyHandoffBudget,
	DEFAULT_HANDOFF_BUDGET_TOKENS,
	type DependencyContextEntry,
	type DependencyOutputContext,
	HANDOFF_BUDGET_CEILING_TOKENS,
	HANDOFF_SUMMARY_HEAD_CHARS,
	renderDependencyOutputContext,
} from "../../../../src/runtime/task-output-context.ts";
import { estimateTokens, renderTaskPrompt } from "../../../../src/runtime/task-runner/prompt-builder.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { WorkflowStep } from "../../../../src/workflows/workflow-config.ts";

const BUDGET_ENV = "PI_CREW_HANDOFF_BUDGET_TOKENS";
const BREAKDOWN_ENV = "PI_CREW_PROMPT_BREAKDOWN";

const savedBudgetEnv = process.env[BUDGET_ENV];
beforeEach(() => {
	delete process.env[BUDGET_ENV];
});
afterEach(() => {
	if (savedBudgetEnv === undefined) delete process.env[BUDGET_ENV];
	else process.env[BUDGET_ENV] = savedBudgetEnv;
});

function dep(id: string, summaryChars: number, extra: Partial<DependencyContextEntry> = {}): DependencyContextEntry {
	return {
		taskId: id,
		role: "executor",
		status: "completed",
		resultSummary: `${id}-`.repeat(Math.ceil(summaryChars / (id.length + 1))).slice(0, summaryChars),
		structuredResults: { key: "value", taskId: id },
		usage: { inputTokens: 100, outputTokens: 200, durationMs: 300 },
		...extra,
	};
}

function context(deps: DependencyContextEntry[], runId?: string): DependencyOutputContext {
	return { dependencies: deps, sharedReads: [], ...(runId ? { runId } : {}) };
}

/** Rendered est tokens of `text` (same chars/4 heuristic as the breakdown). */
function est(text: string): number {
	return estimateTokens(text.length);
}

describe("handoff budget — budget enforcement", () => {
	test("fat 4-dep fixture: capped render fits the budget, uncapped does not", () => {
		const ctx = context([dep("dep-1", 8000), dep("dep-2", 8000), dep("dep-3", 8000), dep("dep-4", 8000)], "run-fat");
		const uncapped = renderDependencyOutputContext(ctx, { budgetTokens: 0 });
		const capped = renderDependencyOutputContext(ctx, { budgetTokens: 1800 });
		assert.ok(est(uncapped) > 1800, `uncapped render must exceed the budget (est ${est(uncapped)})`);
		assert.ok(est(capped) <= 1800, `capped render must fit the budget (est ${est(capped)} chars ${capped.length})`);
		assert.ok(capped.includes("[trimmed, 8000 chars total]"), "truncation markers present");
		assert.ok(capped.includes("full output: artifacts/run-fat/results/dep-4.txt"), "pointer line present");
		assert.ok(est(capped) < est(uncapped), "capped est strictly below uncapped est");
	});

	test("long sharedRead bodies are dropped when over budget, short ones kept", () => {
		const ctx: DependencyOutputContext = {
			dependencies: [dep("dep-1", 8000)],
			sharedReads: [
				{ name: "big.md", path: "/abs/shared/big.md", content: "y".repeat(5000) },
				{ name: "small.md", path: "/abs/shared/small.md", content: "short body" },
			],
			runId: "run-shared",
		};
		const out = renderDependencyOutputContext(ctx, { budgetTokens: 600 });
		assert.ok(out.includes("[content trimmed, 5000 chars total"), "big shared read body replaced by marker");
		assert.ok(out.includes("Path: /abs/shared/big.md"), "shared read Path pointer retained");
		assert.ok(out.includes("short body"), "short shared read kept verbatim");
	});
});

describe("handoff budget — declaration order + priority", () => {
	test("declaration order preserved; earlier deps keep full output, later ones trimmed", () => {
		// dep-1 fat, dep-2 fat, dep-3/4 small: budget admits dep-1 full, trims the rest.
		const ctx = context([dep("dep-1", 5000), dep("dep-2", 5000), dep("dep-3", 100), dep("dep-4", 100)], "run-order");
		const out = renderDependencyOutputContext(ctx, { budgetTokens: 1800 });
		const order = ["dep-1", "dep-2", "dep-3", "dep-4"].map((id) => out.indexOf(`## ${id} (executor)`));
		assert.deepEqual(
			[...order].sort((a, b) => a - b),
			order,
			"headers must appear in declaration order",
		);
		assert.ok(
			order.every((i) => i >= 0),
			"all four headers present",
		);
		// priority: dep-1 keeps its FULL summary (tail chunk intact + structured results)
		assert.ok(out.includes("dep-1-".repeat(50).slice(0, 100)), "dep-1 keeps full summary body");
		assert.ok(out.includes("Structured results:"), "dep-1 keeps structuredResults");
		assert.ok(!out.includes("full output: artifacts/run-order/results/dep-1.txt"), "full dep gets no pointer");
		// later deps: trimmed form
		assert.ok(out.includes("[trimmed, 5000 chars total]"), "dep-2 trimmed with marker");
		assert.ok(!out.includes("[trimmed, 100 chars total]"), "short summaries get no truncation marker");
		assert.ok(out.includes("full output: artifacts/run-order/results/dep-2.txt"), "dep-2 pointer");
		assert.ok(out.includes("full output: artifacts/run-order/results/dep-3.txt"), "dep-3 pointer");
		assert.ok(out.includes("full output: artifacts/run-order/results/dep-4.txt"), "dep-4 pointer");
	});
});

describe("handoff budget — pointer path", () => {
	test("pointer built from manifest runId + taskId (context.runId)", () => {
		const ctx = context([dep("dep-9", 4000)], "team_20261003_abcd1234");
		const out = renderDependencyOutputContext(ctx, { budgetTokens: 400 });
		assert.ok(out.includes("full output: artifacts/team_20261003_abcd1234/results/dep-9.txt"), "exact pointer format");
	});

	test("applyHandoffBudget runId param fills a context without runId", () => {
		const trimmed = applyHandoffBudget(context([dep("dep-9", 4000)]), 400, "run-param");
		const out = renderDependencyOutputContext(trimmed, { budgetTokens: 0 });
		assert.ok(out.includes("full output: artifacts/run-param/results/dep-9.txt"), "pointer from runId param");
	});

	test("no runId → compact form omits the pointer (backward-compat)", () => {
		const out = renderDependencyOutputContext(context([dep("dep-9", 4000)]), { budgetTokens: 400 });
		assert.ok(out.includes("[trimmed, 4000 chars total]"), "trim fired");
		assert.ok(!out.includes("full output: artifacts/"), "no pointer without runId");
	});
});

describe("handoff budget — off-switch + default + precedence", () => {
	test("off-switch: ≤0 and huge budgets render untrimmed", () => {
		const ctx = context([dep("dep-1", 8000), dep("dep-2", 8000)], "run-off");
		for (const off of [0, -5, HANDOFF_BUDGET_CEILING_TOKENS + 1, Number.NaN]) {
			const out = renderDependencyOutputContext(ctx, { budgetTokens: off });
			assert.ok(!out.includes("[trimmed,"), `budget ${off} must disable the trim`);
			assert.ok(!out.includes("full output: artifacts/"), `budget ${off} must not emit pointers`);
		}
	});

	test("env '0' wins over an active config budget (env-expressed off)", () => {
		process.env[BUDGET_ENV] = "0";
		const ctx = context([dep("dep-1", 8000)], "run-envoff");
		const out = renderDependencyOutputContext(ctx, { budgetTokens: 1800 });
		assert.ok(!out.includes("[trimmed,"), "env 0 = off-switch, beats config");
	});

	test("default budget is exactly DEFAULT_HANDOFF_BUDGET_TOKENS (1800)", () => {
		assert.equal(DEFAULT_HANDOFF_BUDGET_TOKENS, 1800);
		// Linear-length probe: rendered body length = overhead + summaryChars for
		// a single plain dep, so pick summary lengths hitting est == default
		// (untrimmed) and est == default + 1 (trimmed).
		const plain = (n: number): DependencyOutputContext =>
			context([{ taskId: "probe", role: "r", status: "completed", resultSummary: "x".repeat(n) }]);
		const overhead = renderDependencyOutputContext(plain(1000), { budgetTokens: 0 }).length - 1000;
		const fitsN = DEFAULT_HANDOFF_BUDGET_TOKENS * 4 - overhead; // est == default → ≤ budget → untrimmed
		const spillsN = fitsN + 4; // est == default + 1 → trimmed
		assert.ok(fitsN > 0, `probe overhead (${overhead}) must be below the default body budget`);
		assert.ok(!renderDependencyOutputContext(plain(fitsN)).includes("[trimmed,"), "est == default must render untrimmed");
		assert.ok(
			renderDependencyOutputContext(plain(spillsN)).includes(`[trimmed, ${spillsN} chars total]`),
			"est == default + 1 must trim",
		);
	});

	test("env override beats config; invalid env falls back to config", () => {
		const ctx = context([dep("dep-1", 5000), dep("dep-2", 5000), dep("dep-3", 100), dep("dep-4", 100)], "run-prec");
		// config 5000 alone would NOT trim (est ~2600 ≤ 5000); env 500 forces it.
		process.env[BUDGET_ENV] = "500";
		assert.ok(renderDependencyOutputContext(ctx, { budgetTokens: 5000 }).includes("[trimmed,"), "env beats config");
		// config 300 alone WOULD trim; env 5000 disables it.
		process.env[BUDGET_ENV] = "5000";
		assert.ok(!renderDependencyOutputContext(ctx, { budgetTokens: 300 }).includes("[trimmed,"), "env disables where config would trim");
		// invalid env strings never throw and defer to config.
		for (const bad of ["abc", "12abc", "1e3", ""]) {
			process.env[BUDGET_ENV] = bad;
			assert.ok(
				!renderDependencyOutputContext(ctx, { budgetTokens: 5000 }).includes("[trimmed,"),
				`invalid env '${bad}' defers to config`,
			);
		}
	});
});

describe("handoff budget — purity / L4 composition", () => {
	test("applyHandoffBudget returns the same reference when off or already fitting", () => {
		const ctx = context([dep("dep-1", 100)], "run-pure");
		assert.equal(applyHandoffBudget(ctx, 0), ctx, "off-switch returns input reference");
		assert.equal(applyHandoffBudget(ctx, 1_000_000), ctx, "fitting context returns input reference");
	});

	test("compacts after L4: path-only (empty-summary) deps still render a header + pointer", () => {
		// L4 downgrades low-priority deps to resultSummary:"" — the handoff trim
		// must still render their header/status + pointer (never drop the dep).
		const l4downgraded = dep("dep-l4", 8000, { resultSummary: "", inlineBytes: 0 });
		const out = renderDependencyOutputContext(context([dep("dep-keep", 8000), l4downgraded], "run-l4"), { budgetTokens: 500 });
		assert.ok(out.includes("## dep-l4 (executor)"), "L4-downgraded dep keeps its header");
		assert.ok(out.includes("Status: completed"), "status line kept");
		assert.ok(out.includes("full output: artifacts/run-l4/results/dep-l4.txt"), "pointer still emitted");
	});

	test("summary head is capped at HANDOFF_SUMMARY_HEAD_CHARS chars", () => {
		const out = renderDependencyOutputContext(context([dep("dep-1", 10000)], "run-head"), { budgetTokens: 400 });
		const marker = out.indexOf("[trimmed, 10000 chars total]");
		assert.ok(marker > 0, "marker present");
		// the head sits between the status line and the marker
		const headStart = out.indexOf("\n", out.indexOf("Status: completed")) + 1;
		assert.equal(marker - headStart, HANDOFF_SUMMARY_HEAD_CHARS + 1, "head is exactly 240 chars + newline before marker");
	});
});

describe("handoff budget — integration with prompt breakdown", () => {
	test("sections['dynamic.dependencyContext'] reflects the capped render", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-budget-"));
		const stateRoot = path.join(cwd, ".crew", "state", "runs", "team_handoff_int");
		const manifest = {
			runId: "team_handoff_int",
			schemaVersion: 1,
			status: "running",
			stateRoot,
			tasksPath: path.join(stateRoot, "tasks.json"),
			eventsPath: path.join(stateRoot, "events.jsonl"),
			artifactsRoot: path.join(cwd, ".crew", "artifacts", "team_handoff_int"),
			team: "default",
			workflow: "default",
			goal: "ship the handoff budget",
			cwd,
			workspaceMode: "single",
			createdAt: new Date().toISOString(),
		} as unknown as TeamRunManifest;
		fs.mkdirSync(stateRoot, { recursive: true });
		fs.writeFileSync(manifest.eventsPath, "");
		const step: WorkflowStep = { id: "execute", role: "executor", task: "Do the thing for {goal}" };
		const fatCtx = context([dep("dep-1", 8000), dep("dep-2", 8000), dep("dep-3", 8000), dep("dep-4", 8000)], manifest.runId);
		const cappedText = renderDependencyOutputContext(fatCtx, { budgetTokens: 1800 });
		const uncappedText = renderDependencyOutputContext(fatCtx, { budgetTokens: 0 });
		const task = {
			id: "02_execute",
			role: "executor",
			agent: "executor",
			status: "running",
			dependsOn: ["dep-1", "dep-2", "dep-3", "dep-4"],
			cwd,
			dependencyContextText: cappedText,
		} as unknown as TeamTaskState;
		const savedBreakdown = process.env[BREAKDOWN_ENV];
		process.env[BREAKDOWN_ENV] = "1";
		try {
			const rendered = await renderTaskPrompt(manifest, step, task, undefined, "", undefined, []);
			const layerChars = rendered.sections?.["dynamic.dependencyContext"];
			assert.ok(layerChars !== undefined, "breakdown section present");
			assert.ok(layerChars! > 0, "layer non-empty");
			assert.ok(layerChars! <= 1800 * 4, `layer chars ${layerChars} must be ≤ budget*4 (${1800 * 4})`);
			// the cap actually bound the layer versus the uncapped render
			const uncappedLayer = uncappedText.length + (layerChars! - cappedText.length);
			assert.ok(layerChars! < uncappedLayer, "capped layer smaller than uncapped layer would be");
		} finally {
			if (savedBreakdown === undefined) delete process.env[BREAKDOWN_ENV];
			else process.env[BREAKDOWN_ENV] = savedBreakdown;
		}
	});
});
