/**
 * single-agent-compose.ts — Cliff hedge v0 (roadmap Phase 0 / T0.5).
 *
 * PURPOSE (Round 6 §5, Round 7 Pillar 3 "Cliff-Resilient Value"):
 * If by ~2027 single models with 1M+ tokens outperform multi-agent teams for
 * most coding tasks, pi-crew must still deliver value. This module composes a
 * workflow into ONE sequential prompt that a single agent can execute — proving
 * pi-crew's mission (reliable orchestration) survives even if the multi-agent
 * MECHANISM is obsoleted.
 *
 * This is the CHEAP v0 (prompt composition only, ~100 LOC). The full
 * single-agent runtime mode is Phase 2 (T2.2).
 *
 * What survives the cliff (cliff-resilient value):
 *   - Workflow-as-data (the Markdown workflow definitions)
 *   - Sequential phase structure + dependencies
 *   - Artifact naming + output contracts
 *   - The agent just executes phases in order instead of N agents in parallel.
 */
import type { WorkflowConfig, WorkflowStep } from "../workflows/workflow-config.ts";

export interface SingleAgentPrompt {
	prompt: string;
	stepCount: number;
}

/** Topologically order steps by dependsOn (stable for already-ordered input). */
function orderSteps(steps: WorkflowStep[]): WorkflowStep[] {
	const byId = new Map(steps.map((s) => [s.id, s]));
	const ordered: WorkflowStep[] = [];
	const seen = new Set<string>();
	const visit = (step: WorkflowStep): void => {
		if (seen.has(step.id)) return;
		if (step.dependsOn) {
			for (const dep of step.dependsOn) {
				const d = byId.get(dep);
				if (d) visit(d);
			}
		}
		seen.add(step.id);
		ordered.push(step);
	};
	for (const s of steps) visit(s);
	return ordered;
}

/**
 * Compose a workflow into a single sequential execution prompt.
 * The agent executes each phase in dependency order, writing outputs to the
 * named artifacts, mimicking what the multi-agent team would produce.
 */
export function composeSingleAgentPrompt(workflow: WorkflowConfig, goal: string): SingleAgentPrompt {
	const ordered = orderSteps(workflow.steps);
	const lines: string[] = [];
	lines.push(`# Single-agent workflow execution: ${workflow.name}`);
	lines.push(`Workflow: ${workflow.name} — ${workflow.description}`);
	lines.push("");
	lines.push(`## Goal`);
	lines.push(goal);
	lines.push("");
	lines.push("## Execution plan");
	lines.push(
		"Execute the following phases in order. Each phase has a role, a task, and an optional output artifact.",
		"Complete each phase fully before moving to the next. After all phases, summarize results.",
	);
	lines.push("");
	ordered.forEach((step, i) => {
		const deps = step.dependsOn?.length ? ` (after: ${step.dependsOn.join(", ")})` : "";
		lines.push(`### Phase ${i + 1}: ${step.id}${deps}`);
		lines.push(`Role: ${step.role}`);
		lines.push(`Task: ${step.task}`);
		if (step.output) {
			lines.push(`Output: write your result to \`${step.output}\``);
		}
		// biome-ignore lint/complexity/useOptionalChain: reads is `string[] | false | undefined` — optional chain doesn't narrow out `false` (no .length on boolean)
		if (step.reads && step.reads.length) {
			lines.push(`Read first: ${step.reads.join(", ")}`);
		}
		lines.push("");
	});
	lines.push("## After all phases");
	lines.push("Write a brief summary of what you accomplished, referencing each output artifact.");
	const prompt = lines.join("\n");
	return { prompt, stepCount: ordered.length };
}
