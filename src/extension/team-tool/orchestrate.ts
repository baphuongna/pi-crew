/**
 * Handler for `team action='orchestrate' planPath='/path/to/plan.md'`
 *
 * Parses a plan document and outputs agent chain commands.
 */
import * as fs from "node:fs";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { resolveContainedPath } from "../../utils/safe-paths.ts";
import {
	buildAgentChain,
	formatPlanOverview,
	type OrchestratedStep,
	parsePlanDocument,
	parsePlanDocumentSimple,
} from "../plan-orchestrate.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { result, type TeamContext } from "./context.ts";

/**
 * Handle the orchestrate action.
 *
 * Parses a plan document (markdown with `<!-- tag: <tag> -->` comments)
 * and outputs the decomposed agent chain commands.
 *
 * Usage: `team action='orchestrate' planPath='/path/to/plan.md'`
 */
export function handleOrchestrate(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const planPath = params.planPath as string | undefined;

	if (!planPath) {
		return result(
			"orchestrate requires planPath parameter pointing to a markdown plan document.",
			{ action: "orchestrate", status: "error" },
			true,
		);
	}

	// Resolve and validate path stays within ctx.cwd (path-traversal protection)
	let resolvedPath: string;
	try {
		resolvedPath = resolveContainedPath(ctx.cwd, planPath);
	} catch {
		return result(`planPath must be within project directory: ${planPath}`, { action: "orchestrate", status: "error" }, true);
	}

	if (!fs.existsSync(resolvedPath)) {
		return result(`Plan document not found: ${resolvedPath}`, { action: "orchestrate", status: "error" }, true);
	}

	// Try primary parser
	let steps: OrchestratedStep[] = parsePlanDocument(resolvedPath);

	// Fallback to simple parser
	if (steps.length === 0) {
		steps = parsePlanDocumentSimple(resolvedPath);
	}

	if (steps.length === 0) {
		return result(
			`No tagged sections found in plan document: ${resolvedPath}\n\nExpected format: <!-- tag: <tag> --> in markdown sections`,
			{ action: "orchestrate", status: "error" },
			true,
		);
	}

	// Build overview and commands
	const overview = formatPlanOverview(resolvedPath);
	const commands = buildAgentChain(steps);

	const outputLines: string[] = [
		`Plan: ${resolvedPath}`,
		`Steps: ${steps.length}`,
		"",
		"# Agent Chain Commands",
		"",
		...commands.map((cmd, i) => `${i + 1}. ${cmd}`),
		"",
		"# Full Overview",
		overview,
	];

	return result(outputLines.join("\n"), {
		action: "orchestrate",
		status: "ok",
		data: {
			planPath: resolvedPath,
			stepCount: steps.length,
			commands,
			steps: steps.map((sqs) => ({
				stepId: sqs.stepId,
				tag: sqs.tag,
				chain: sqs.chain,
				prompt: sqs.prompt,
				heading: sqs.heading,
			})),
		},
	});
}
