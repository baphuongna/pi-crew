/**
 * T2/R4 (ADR-4 §6) — producer contract tests:
 *  1. orchestrate steps → PlanRecord (stepsToPlanRecord)
 *  2. planner tagged `<plan>` output → PlanRecord (parsePlannerPlanOutput)
 *  3. adaptive assess → per-phase cap (ADAPTIVE_MAX_TASKS_PER_PHASE)
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OrchestratedStep } from "../../../../src/extension/plan-orchestrate.ts";
import { parsePlannerPlanOutput, stepsToPlanRecord } from "../../../../src/extension/plan-orchestrate.ts";
import { parseAdaptivePlan, repairAdaptivePlan } from "../../../../src/runtime/goal-workflow/adaptive-plan.ts";

function step(id: string, tag: string, prompt: string, heading?: string): OrchestratedStep {
	return { stepId: id, tag, chain: [], prompt, heading };
}

describe("producer 1: stepsToPlanRecord (orchestrate)", () => {
	it("groups steps into one phase per tag in encounter order; item ids = stepIds; taskIds EMPTY", () => {
		const steps = [
			step("step-01-design", "design", "Design the auth system", "Auth Design"),
			step("step-02-impl", "impl", "Implement JWT", "Implementation"),
			step("step-03-impl", "impl", "Implement refresh tokens"),
			step("step-04-test", "test", "Test auth", "Tests"),
		];
		const rec = stepsToPlanRecord(steps, "run-x");
		assert.equal(rec.runId, "run-x");
		assert.equal(rec.version, 1);
		assert.equal(rec.revisionOf, undefined);
		assert.deepEqual(
			rec.phases.map((p) => [p.id, p.itemIds]),
			[
				["phase-1-design", ["step-01-design"]],
				["phase-2-impl", ["step-02-impl", "step-03-impl"]],
				["phase-3-test", ["step-04-test"]],
			],
		);
		assert.equal(rec.phases[0]?.title, "Auth Design"); // heading used when present
		assert.equal(rec.phases[1]?.title, "Implementation"); // first impl step's heading wins
		for (const item of rec.items) {
			assert.deepEqual(item.taskIds, [], "producers NEVER set taskIds (ADR-4 §3 single-writer)");
			assert.deepEqual(item.specIds, []);
			assert.equal(item.status, "pending");
		}
		assert.equal(rec.items[0]?.ref, "step-01-design");
		// Fresh lineage each call (randomUUID) but deterministic shape.
		const rec2 = stepsToPlanRecord(steps, "run-x");
		assert.notEqual(rec.id, rec2.id);
	});
});

describe("producer 3: parsePlannerPlanOutput (tagged contract)", () => {
	const valid = `<analysis>some prose</analysis>
<plan>
{
  "title": "Ship feature X",
  "phases": [
    { "title": "Core", "items": [
      { "title": "Add API", "task": "Implement POST /x", "acceptance": ["200 on happy path"] },
      { "id": "custom-id", "title": "Add UI", "task": "Build form" }
    ]},
    { "items": [ { "task": "Write docs" } ] }
  ]
}
</plan>
<trailing>noise</trailing>`;

	it("parses tagged JSON with fences tolerated; slugs missing ids; keeps acceptance; records authorTaskId", () => {
		const rec = parsePlannerPlanOutput(valid, "run-y", "task-planner-1");
		assert.ok(rec);
		assert.equal(rec.title, "Ship feature X");
		assert.equal(rec.runId, "run-y");
		assert.equal(rec.authorTaskId, "task-planner-1");
		assert.equal(rec.phases.length, 2);
		assert.equal(rec.phases[0]?.title, "Core");
		assert.equal(rec.phases[1]?.title, "Phase 2"); // default title
		assert.equal(rec.items.length, 3);
		assert.match(rec.items[0]?.id ?? "", /^pi-1-add-api$/);
		assert.equal(rec.items[1]?.id, "custom-id");
		assert.deepEqual(rec.items[0]?.acceptance, ["200 on happy path"]);
		for (const item of rec.items) assert.deepEqual(item.taskIds, []);
	});

	it("tolerates a fenced block", () => {
		const fenced = "<plan>\n```json\n" + JSON.stringify({ phases: [{ items: [{ task: "do it" }] }] }) + "\n```\n</plan>";
		assert.ok(parsePlannerPlanOutput(fenced, "run-y"));
	});

	it("returns undefined for: no block, malformed JSON, empty phases, item without title/task, duplicate ids", () => {
		assert.equal(parsePlannerPlanOutput("no plan here", "r"), undefined);
		assert.equal(parsePlannerPlanOutput("<plan>{bad json}</plan>", "r"), undefined);
		assert.equal(parsePlannerPlanOutput('<plan>{"phases":[]}</plan>', "r"), undefined);
		assert.equal(parsePlannerPlanOutput('<plan>{"phases":[{"items": [{}] }]}</plan>', "r"), undefined);
		assert.equal(
			parsePlannerPlanOutput(
				"<plan>" +
					JSON.stringify({
						phases: [
							{
								items: [
									{ id: "a", task: "x" },
									{ id: "a", task: "y" },
								],
							},
						],
					}) +
					"</plan>",
				"r",
			),
			undefined,
		);
	});
});

describe("producer 2: adaptive per-phase cap (ADR-4 §5)", () => {
	const roles = ["executor", "reviewer"];

	function phase(name: string, count: number): { name: string; tasks: unknown[] } {
		return { name, tasks: Array.from({ length: count }, (_, i) => ({ role: "executor", task: `t${i}` })) };
	}

	// extractAdaptivePlanJson requires a fence or START marker — bare JSON is
	// NOT a supported plan format (worker output contract).
	const fenced = (obj: unknown) => "```json\n" + JSON.stringify(obj) + "\n```";

	it("accepts a plan exceeding the OLD global 12 (e.g. 8+8 across 2 phases)", () => {
		const plan = parseAdaptivePlan(fenced({ phases: [phase("a", 8), phase("b", 8)] }), roles);
		assert.ok(plan, "16 tasks across 2 phases must parse (per-phase cap)");
		assert.equal(plan.phases[0]?.tasks.length, 8);
		assert.equal(plan.phases[1]?.tasks.length, 8);
	});

	it("rejects a single phase exceeding the per-phase cap (13 in one phase)", () => {
		assert.equal(parseAdaptivePlan(fenced({ phases: [phase("a", 13)] }), roles), undefined);
	});

	it("repair path truncates per phase but KEEPS later phases", () => {
		// START-marker format with ONLY the final "}" missing (both phases
		// complete) forces closeUnbalancedJson repair; phase A has 14 tasks
		// (→12), phase B has 2 (kept — the old GLOBAL cap would have dropped B).
		const full = JSON.stringify({ phases: [phase("a", 14), phase("b", 2)] });
		const repaired = repairAdaptivePlan("ADAPTIVE_PLAN_JSON_START\n" + full.slice(0, -1), roles);
		assert.ok(repaired.plan);
		assert.equal(repaired.plan.phases[0]?.tasks.length, 12, "phase A truncated to the per-phase cap");
		assert.equal(repaired.plan.phases[1]?.tasks.length, 2, "phase B kept — per-phase, not global");
	});
});
