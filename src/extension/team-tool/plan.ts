import { composeSingleAgentPrompt } from "../../runtime/single-agent-compose.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { allTeams, discoverTeams } from "../../teams/discover-teams.ts";
import { allWorkflows, discoverWorkflows } from "../../workflows/discover-workflows.ts";
import { validateWorkflowForTeam } from "../../workflows/validate-workflow.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { result, type TeamContext } from "./context.ts";
import { resolveRoutingHint } from "./routing-hint.ts";

export function handlePlan(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const teamName = params.team ?? "default";
	const team = allTeams(discoverTeams(ctx.cwd)).find((item) => item.name === teamName);
	if (!team) return result(`Team '${teamName}' not found.`, { action: "plan", status: "error" }, true);
	const workflowName = params.workflow ?? team.defaultWorkflow ?? "default";
	const workflow = allWorkflows(discoverWorkflows(ctx.cwd)).find((item) => item.name === workflowName);
	if (!workflow) return result(`Workflow '${workflowName}' not found.`, { action: "plan", status: "error" }, true);
	const errors = validateWorkflowForTeam(workflow, team);
	if (errors.length > 0)
		return result(
			[`Workflow '${workflow.name}' is not valid for team '${team.name}':`, ...errors.map((error) => `- ${error}`)].join("\n"),
			{ action: "plan", status: "error" },
			true,
		);
	const goal = params.goal ?? params.task ?? "(not provided)";
	// DP-04: small-goal routing hint (suggest-only by default; never overrides
	// an explicit team/workflow choice). See routing-hint.ts for the rationale.
	const routingHint = resolveRoutingHint({
		goal,
		explicitOverride: params.team !== undefined || params.workflow !== undefined,
	});
	// ROADMAP T2.2: single-agent composition mode (cliff hedge).
	if (params.singleAgent) {
		const composed = composeSingleAgentPrompt(workflow, goal);
		return result(
			[
				`Single-agent plan for ${team.name} / ${workflow.name} (${composed.stepCount} phases composed into one sequential prompt):`,
				"",
				composed.prompt,
				"",
				"This prompt can be handed to a single agent to execute the entire workflow sequentially — pi-crew's cliff-resilient mode (survives single-agent domination).",
			].join("\n"),
			{ action: "plan", status: "ok" },
		);
	}
	const lines = [
		`Team plan: ${team.name}`,
		`Workflow: ${workflow.name}`,
		`Goal: ${goal}`,
		"",
		"Steps:",
		...workflow.steps.map(
			(step, index) =>
				`${index + 1}. ${step.id} [${step.role}]${step.dependsOn?.length ? ` after ${step.dependsOn.join(", ")}` : ""}`,
		),
	];
	if (routingHint.suggested && routingHint.message) {
		lines.push("", routingHint.message);
	}
	return result(lines.join("\n"), { action: "plan", status: "ok" });
}
