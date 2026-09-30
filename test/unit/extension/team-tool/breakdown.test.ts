/**
 * G18 (SDD 2026-09-30 WI-3): unit tests for the `breakdown` inspect action —
 * reads per-task `metadata/<taskId>.prompt-breakdown.json` artifacts (opt-in
 * via PI_CREW_PROMPT_BREAKDOWN=1) from the manifest artifacts index and
 * aggregates per-task estTokens + top-5 sections.
 * @see src/extension/team-tool/inspect.ts handleBreakdown
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { handleBreakdown } from "../../../../src/extension/team-tool/inspect.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import type { TeamToolParamsValue } from "../../../../src/schema/team-tool-schema.ts";
import { createRunManifest, saveRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { ArtifactDescriptor, TeamRunManifest } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

function makeCtx(overrides: Partial<TeamContext> = {}): TeamContext {
	return { cwd: "/tmp/breakdown-test", ...overrides };
}

function makeParams(overrides: Partial<TeamToolParamsValue> = {}): TeamToolParamsValue {
	return { ...overrides };
}

const fixtureTeam: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "planner", agent: "planner" }],
};

const fixtureWorkflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "plan", role: "planner", task: "Plan {goal}" }],
};

/** Section map → in-memory breakdown JSON content (mirrors pre-execution's
 *  `{ [section]: { chars, estTokens } }` artifact shape). */
function breakdownContent(sections: Record<string, { chars: number; estTokens: number }>): string {
	return `${JSON.stringify(sections, null, 2)}\n`;
}

/** Create a real run in a tmp cwd and register breakdown artifacts in the
 *  manifest artifacts index (exactly what a PI_CREW_PROMPT_BREAKDOWN=1 run
 *  exposes to the handler). */
function makeRunWithBreakdowns(
	breakdowns: Record<string, Record<string, { chars: number; estTokens: number }>>,
): { cwd: string; runId: string } {
	let cwd = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-crew-breakdown-"));
	try {
		const real = fs.realpathSync.native(cwd);
		cwd = real.startsWith("\\\\?\\") ? real.slice(4) : real;
	} catch {
		/* keep as-is */
	}
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const { manifest } = createRunManifest({ cwd, team: fixtureTeam, workflow: fixtureWorkflow, goal: "breakdown surface" });
	let updated: TeamRunManifest = { ...manifest, artifacts: [...manifest.artifacts] };
	for (const [taskId, sections] of Object.entries(bdownEntries(breakdowns))) {
		const relativePath = `metadata/${taskId}.prompt-breakdown.json`;
		const filePath = path.join(manifest.artifactsRoot, relativePath);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		const content = breakdownContent(sections);
		fs.writeFileSync(filePath, content, "utf-8");
		const descriptor: ArtifactDescriptor = {
			kind: "metadata",
			path: filePath,
			createdAt: new Date().toISOString(),
			producer: "prompt-breakdown",
			sizeBytes: Buffer.byteLength(content),
			retention: "run",
		};
		updated.artifacts.push(descriptor);
	}
	saveRunManifest(updated);
	return { cwd, runId: manifest.runId };
}

// Tiny identity helper so the loop below stays type-narrow without `any`.
function bdownEntries(
	breakdowns: Record<string, Record<string, { chars: number; estTokens: number }>>,
): Record<string, Record<string, { chars: number; estTokens: number }>> {
	return breakdowns;
}

describe("handleBreakdown", () => {
	it("returns error when runId is missing", () => {
		const res = handleBreakdown(makeParams(), makeCtx());
		assert.strictEqual(res.isError, true);
		assert.ok(textFromToolResult(res).includes("runId"));
	});

	it("lists every task that has a breakdown, with per-task totals and the run total", () => {
		const { cwd, runId } = makeRunWithBreakdowns({
			"01_plan": { "system.agentDefinition": { chars: 1000, estTokens: 250 }, "prompt.task": { chars: 400, estTokens: 100 } },
			"02_execute": { "system.agentDefinition": { chars: 2000, estTokens: 500 }, "dynamic.preStepOutput": { chars: 800, estTokens: 200 } },
		});
		try {
			const res = handleBreakdown(makeParams({ runId }), makeCtx({ cwd }));
			assert.strictEqual(res.isError, false);
			const text = textFromToolResult(res);
			assert.ok(text.includes("01_plan"), "task 01_plan listed");
			assert.ok(text.includes("02_execute"), "task 02_execute listed");
			assert.ok(text.includes("~350 tokens"), "01_plan total present");
			assert.ok(text.includes("~700 tokens"), "02_execute total present");
			assert.ok(text.includes("Run total: ~1050 tokens"), "run total is the sum of per-task totals");
			assert.strictEqual(res.details.action, "breakdown");
			assert.strictEqual(res.details.status, "ok");
			const data = res.details.data as { runTotal: number; perTask: Array<{ taskId: string }> };
			assert.equal(data.perTask.length, 2);
			assert.equal(data.runTotal, 1050);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("filters to a single task when taskId is provided", () => {
		const { cwd, runId } = makeRunWithBreakdowns({
			"01_plan": { "system.agentDefinition": { chars: 1000, estTokens: 250 } },
			"02_execute": { "system.agentDefinition": { chars: 2000, estTokens: 500 } },
		});
		try {
			const res = handleBreakdown(makeParams({ runId, taskId: "02_execute" }), makeCtx({ cwd }));
			assert.strictEqual(res.isError, false);
			const text = textFromToolResult(res);
			assert.ok(text.includes("02_execute"));
			assert.ok(!text.includes("01_plan"), "other tasks must be filtered out");
			const data = res.details.data as { runTotal: number; perTask: Array<{ taskId: string }> };
			assert.equal(data.perTask.length, 1);
			assert.equal(data.perTask[0]?.taskId, "02_execute");
			assert.equal(data.runTotal, 500);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("suggests enabling PI_CREW_PROMPT_BREAKDOWN=1 when the run has no breakdown artifacts", () => {
		const { cwd, runId } = makeRunWithBreakdowns({});
		try {
			const res = handleBreakdown(makeParams({ runId }), makeCtx({ cwd }));
			assert.strictEqual(res.isError, false, "missing breakdown is guidance, not an error");
			const text = textFromToolResult(res);
			assert.ok(text.includes("PI_CREW_PROMPT_BREAKDOWN=1"), "must point at the opt-in env gate");
			const data = res.details.data as { runTotal: number; perTask: unknown[] };
			assert.equal(data.perTask.length, 0);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("reports the top-5 sections per task in descending estTokens order", () => {
		const sections: Record<string, { chars: number; estTokens: number }> = {
			"section.a": { chars: 100, estTokens: 25 },
			"section.b": { chars: 800, estTokens: 200 },
			"section.c": { chars: 300, estTokens: 75 },
			"section.d": { chars: 1200, estTokens: 300 },
			"section.e": { chars: 200, estTokens: 50 },
			"section.f": { chars: 4000, estTokens: 1000 },
			"section.g": { chars: 1600, estTokens: 400 },
		};
		const { cwd, runId } = makeRunWithBreakdowns({ "01_plan": sections });
		try {
			const res = handleBreakdown(makeParams({ runId }), makeCtx({ cwd }));
			assert.strictEqual(res.isError, false);
			const data = res.details.data as {
				runTotal: number;
				perTask: Array<{ taskId: string; totalEstTokens: number; topSections: Array<{ section: string; estTokens: number }> }>;
			};
			const task = data.perTask[0];
			assert.equal(task?.totalEstTokens, 2050, "per-task total sums ALL sections, not just the top 5");
			assert.equal(task?.topSections.length, 5, "exactly the top-5 sections");
			assert.deepEqual(
				task?.topSections.map((s) => s.section),
				["section.f", "section.g", "section.d", "section.b", "section.c"],
				"sections sorted by descending estTokens",
			);
			assert.ok(task?.topSections.every((s, i, arr) => i === 0 || arr[i - 1].estTokens >= s.estTokens));
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
